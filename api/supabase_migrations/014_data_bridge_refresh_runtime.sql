-- VTAB Desktop Data Bridge refresh runtime.
-- Apply after 013_desktop_data_bridge.sql.

create table if not exists public.vtab_bridge_refresh_jobs (
  id uuid primary key default gen_random_uuid(),
  bridge_id uuid not null references public.vtab_data_bridges(id) on delete cascade,
  semantic_model_id uuid not null references public.semantic_models(id) on delete cascade,
  report_id text not null references public.published_reports(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  trigger_type text not null default 'manual' check (trigger_type in ('manual','scheduled')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed')),
  claimed_at timestamptz,
  completed_at timestamptz,
  error_message text,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vtab_bridge_refresh_jobs_bridge_queue_idx
  on public.vtab_bridge_refresh_jobs(bridge_id, status, created_at);
create index if not exists vtab_bridge_refresh_jobs_model_time_idx
  on public.vtab_bridge_refresh_jobs(semantic_model_id, created_at desc);

alter table public.vtab_bridge_refresh_jobs enable row level security;

drop policy if exists "workspace members view bridge refresh jobs" on public.vtab_bridge_refresh_jobs;
create policy "workspace members view bridge refresh jobs"
on public.vtab_bridge_refresh_jobs for select to authenticated
using (exists (
  select 1 from public.semantic_models sm
  join public.workspace_members wm on wm.workspace_id = sm.workspace_id
  where sm.id = vtab_bridge_refresh_jobs.semantic_model_id and wm.user_id = auth.uid()
));

create or replace function public.request_vtab_bridge_refresh(p_semantic_model_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_report_id text;
  v_bridge_id uuid;
  v_job_id uuid;
begin
  if v_uid is null then return jsonb_build_object('error','Authentication required.'); end if;
  select wm.role, sm.report_id into v_role, v_report_id
  from semantic_models sm join workspace_members wm on wm.workspace_id = sm.workspace_id
  where sm.id = p_semantic_model_id and wm.user_id = v_uid;
  if v_role not in ('Admin','Member','Contributor','Owner','Co-Owner') then
    return jsonb_build_object('error','Edit permission is required to refresh this semantic model.');
  end if;
  select b.id into v_bridge_id
  from semantic_model_bridge_bindings bind
  join vtab_data_bridges b on b.id = bind.bridge_id
  where bind.semantic_model_id = p_semantic_model_id
    and b.enabled = true and b.last_heartbeat >= now() - interval '3 minutes';
  if v_bridge_id is null then return jsonb_build_object('error','The selected Desktop Data Bridge is offline or unavailable.'); end if;
  select id into v_job_id from vtab_bridge_refresh_jobs
  where semantic_model_id = p_semantic_model_id and status in ('queued','running')
  order by created_at desc limit 1;
  if v_job_id is null then
    insert into vtab_bridge_refresh_jobs(bridge_id,semantic_model_id,report_id,requested_by)
    values(v_bridge_id,p_semantic_model_id,v_report_id,v_uid) returning id into v_job_id;
  end if;
  return jsonb_build_object('ok',true,'job_id',v_job_id,'status','queued');
end $$;

create or replace function public.claim_vtab_bridge_refresh(p_bridge_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_uid uuid := auth.uid();
  v_job vtab_bridge_refresh_jobs%rowtype;
  v_project jsonb;
begin
  if not exists(select 1 from vtab_data_bridges where id=p_bridge_id and owner_id=v_uid and enabled=true) then
    return jsonb_build_object('error','This account does not own the active Data Bridge.');
  end if;
  update vtab_bridge_refresh_jobs set status='queued',claimed_at=null,updated_at=now()
  where bridge_id=p_bridge_id and status='running' and claimed_at < now() - interval '30 minutes';
  select * into v_job from vtab_bridge_refresh_jobs
  where bridge_id=p_bridge_id and status='queued'
  order by created_at for update skip locked limit 1;
  if v_job.id is null then return jsonb_build_object('job',null); end if;
  update vtab_bridge_refresh_jobs set status='running',claimed_at=now(),updated_at=now()
  where id=v_job.id;
  select project_json::jsonb into v_project from published_reports where id=v_job.report_id;
  return jsonb_build_object('job',jsonb_build_object(
    'id',v_job.id,'bridge_id',v_job.bridge_id,'semantic_model_id',v_job.semantic_model_id,
    'report_id',v_job.report_id,'requested_by',v_job.requested_by,'project',v_project
  ));
end $$;

create or replace function public.complete_vtab_bridge_refresh(p_job_id uuid,p_project_json jsonb,p_result jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare v_job vtab_bridge_refresh_jobs%rowtype;
begin
  select j.* into v_job from vtab_bridge_refresh_jobs j
  join vtab_data_bridges b on b.id=j.bridge_id
  where j.id=p_job_id and j.status='running' and b.owner_id=auth.uid();
  if v_job.id is null then return jsonb_build_object('error','Running bridge refresh job not found.'); end if;
  if p_project_json is null or jsonb_typeof(p_project_json)<>'object' then return jsonb_build_object('error','Invalid refreshed project.'); end if;
  update published_reports set project_json=p_project_json::text,updated_at=now() where id=v_job.report_id;
  update semantic_models set definition=coalesce(p_project_json->'model','{}'::jsonb),updated_at=now() where id=v_job.semantic_model_id;
  update vtab_bridge_refresh_jobs set status='succeeded',completed_at=now(),result=coalesce(p_result,'{}'::jsonb),error_message=null,updated_at=now()
  where id=p_job_id;
  return jsonb_build_object('ok',true,'job_id',p_job_id,'status','succeeded');
end $$;

create or replace function public.fail_vtab_bridge_refresh(p_job_id uuid,p_error text)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
begin
  if not exists(select 1 from vtab_bridge_refresh_jobs j join vtab_data_bridges b on b.id=j.bridge_id where j.id=p_job_id and b.owner_id=auth.uid()) then
    return jsonb_build_object('error','Bridge refresh job not found.');
  end if;
  update vtab_bridge_refresh_jobs set status='failed',completed_at=now(),error_message=left(coalesce(p_error,'Refresh failed.'),2000),updated_at=now()
  where id=p_job_id;
  return jsonb_build_object('ok',true,'job_id',p_job_id,'status','failed');
end $$;

revoke all on function public.request_vtab_bridge_refresh(uuid) from public,anon;
revoke all on function public.claim_vtab_bridge_refresh(uuid) from public,anon;
revoke all on function public.complete_vtab_bridge_refresh(uuid,jsonb,jsonb) from public,anon;
revoke all on function public.fail_vtab_bridge_refresh(uuid,text) from public,anon;
grant execute on function public.request_vtab_bridge_refresh(uuid) to authenticated;
grant execute on function public.claim_vtab_bridge_refresh(uuid) to authenticated;
grant execute on function public.complete_vtab_bridge_refresh(uuid,jsonb,jsonb) to authenticated;
grant execute on function public.fail_vtab_bridge_refresh(uuid,text) to authenticated;
grant select on public.vtab_bridge_refresh_jobs to authenticated;
