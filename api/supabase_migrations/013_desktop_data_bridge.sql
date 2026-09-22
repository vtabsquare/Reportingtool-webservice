-- VTAB Desktop Data Bridge registration and semantic-model binding.
-- The bridge contains no database password, table list, or published snapshot.

create table if not exists public.vtab_data_bridges (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  machine_name text not null,
  status text not null default 'offline' check (status in ('online','offline')),
  version text,
  last_heartbeat timestamptz,
  enabled boolean not null default false,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vtab_data_bridges_workspace_idx
  on public.vtab_data_bridges(workspace_id, updated_at desc);

create table if not exists public.semantic_model_bridge_bindings (
  semantic_model_id uuid primary key references public.semantic_models(id) on delete cascade,
  bridge_id uuid not null references public.vtab_data_bridges(id) on delete cascade,
  updated_at timestamptz not null default now()
);

alter table public.vtab_data_bridges enable row level security;
alter table public.semantic_model_bridge_bindings enable row level security;

drop policy if exists "workspace members can view data bridges" on public.vtab_data_bridges;
create policy "workspace members can view data bridges"
on public.vtab_data_bridges for select to authenticated
using (exists (
  select 1 from public.workspace_members wm
  where wm.workspace_id = vtab_data_bridges.workspace_id and wm.user_id = auth.uid()
));

drop policy if exists "bridge owners can register data bridges" on public.vtab_data_bridges;
create policy "bridge owners can register data bridges"
on public.vtab_data_bridges for insert to authenticated
with check (
  owner_id = auth.uid() and exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = vtab_data_bridges.workspace_id
      and wm.user_id = auth.uid()
      and wm.role in ('Admin','Member','Contributor','Owner','Co-Owner')
  )
);

drop policy if exists "bridge owners can update data bridges" on public.vtab_data_bridges;
create policy "bridge owners can update data bridges"
on public.vtab_data_bridges for update to authenticated
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "workspace members can view bridge bindings" on public.semantic_model_bridge_bindings;
create policy "workspace members can view bridge bindings"
on public.semantic_model_bridge_bindings for select to authenticated
using (exists (
  select 1 from public.semantic_models sm
  join public.workspace_members wm on wm.workspace_id = sm.workspace_id
  where sm.id = semantic_model_bridge_bindings.semantic_model_id and wm.user_id = auth.uid()
));

drop policy if exists "workspace editors can create bridge bindings" on public.semantic_model_bridge_bindings;
create policy "workspace editors can create bridge bindings"
on public.semantic_model_bridge_bindings for insert to authenticated
with check (exists (
  select 1 from public.semantic_models sm
  join public.workspace_members wm on wm.workspace_id = sm.workspace_id
  join public.vtab_data_bridges b on b.id = semantic_model_bridge_bindings.bridge_id and b.workspace_id = sm.workspace_id
  where sm.id = semantic_model_bridge_bindings.semantic_model_id
    and wm.user_id = auth.uid()
    and wm.role in ('Admin','Member','Contributor','Owner','Co-Owner')
));

drop policy if exists "workspace editors can update bridge bindings" on public.semantic_model_bridge_bindings;
create policy "workspace editors can update bridge bindings"
on public.semantic_model_bridge_bindings for update to authenticated
using (exists (
  select 1 from public.semantic_models sm
  join public.workspace_members wm on wm.workspace_id = sm.workspace_id
  where sm.id = semantic_model_bridge_bindings.semantic_model_id
    and wm.user_id = auth.uid()
    and wm.role in ('Admin','Member','Contributor','Owner','Co-Owner')
)) with check (exists (
  select 1 from public.semantic_models sm
  join public.vtab_data_bridges b on b.id = semantic_model_bridge_bindings.bridge_id and b.workspace_id = sm.workspace_id
  where sm.id = semantic_model_bridge_bindings.semantic_model_id
));

drop policy if exists "workspace editors can delete bridge bindings" on public.semantic_model_bridge_bindings;
create policy "workspace editors can delete bridge bindings"
on public.semantic_model_bridge_bindings for delete to authenticated
using (exists (
  select 1 from public.semantic_models sm
  join public.workspace_members wm on wm.workspace_id = sm.workspace_id
  where sm.id = semantic_model_bridge_bindings.semantic_model_id
    and wm.user_id = auth.uid()
    and wm.role in ('Admin','Member','Contributor','Owner','Co-Owner')
));

grant select, insert, update on public.vtab_data_bridges to authenticated;
grant select, insert, update, delete on public.semantic_model_bridge_bindings to authenticated;
