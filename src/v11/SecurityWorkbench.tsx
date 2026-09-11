import {useMemo,useState} from 'react';
import {ShieldCheck,Plus,Pencil,Trash2,Play,Save,X,Users,Filter,CheckCircle2,AlertTriangle} from 'lucide-react';
import {useStudio} from '../store';
import {api} from '../api';

type Rule={id?:string;table:string;column:string;operator:string;value:any};
type Role={id:string;name:string;description?:string;rules:Rule[]};
const OPERATORS=[
 ['equals','Equals'],['not_equals','Not equals'],['contains','Contains'],['gt','Greater than'],['gte','Greater than or equal'],['lt','Less than'],['lte','Less than or equal'],['in','In list']
];
const emptyRule=(table='',column=''):Rule=>({id:crypto.randomUUID(),table,column,operator:'equals',value:''});

export default function SecurityWorkbench(){
 const{project,replaceProject}=useStudio();
 const[editing,setEditing]=useState<Role|null>(null);const[message,setMessage]=useState('');const[saving,setSaving]=useState(false);
 if(!project)return null;
 const security=project.security||{roles:[],activeRoleId:null};const roles:Role[]=security.roles||[];const tables=Object.keys(project.model?.tables||{});
 const fieldsFor=(table:string)=>Object.keys(project.model?.tables?.[table]?.columns||{});
 const newRole=()=>{const t=tables[0]||'';setEditing({id:crypto.randomUUID(),name:'New Security Role',description:'',rules:[emptyRule(t,fieldsFor(t)[0]||'')]});setMessage('')};
 const editRole=(r:Role)=>{setEditing(structuredClone(r));setMessage('')};
 const persist=async(next:any)=>{replaceProject(next);await api('/project',{method:'PUT',body:JSON.stringify(next)})};
 const saveRole=async()=>{
   if(!editing)return;if(!editing.name.trim()){setMessage('Role name is required.');return}
   const bad=editing.rules.find(r=>!r.table||!r.column||(r.value===''&&r.operator!=='in'));
   if(bad){setMessage('Complete every rule: table, column, operator and value.');return}
   setSaving(true);try{const next=structuredClone(project);next.security=next.security||{roles:[],activeRoleId:null};const i=(next.security.roles||[]).findIndex((r:any)=>r.id===editing.id);if(i>=0)next.security.roles[i]=editing;else next.security.roles=[...(next.security.roles||[]),editing];await persist(next);setEditing(null);setMessage('Security role saved.')}catch(e:any){setMessage(e.message||String(e))}finally{setSaving(false)}
 };
 const deleteRole=async(id:string)=>{if(!confirm('Delete this RLS role?'))return;const next=structuredClone(project);next.security=next.security||{roles:[],activeRoleId:null};next.security.roles=(next.security.roles||[]).filter((r:any)=>r.id!==id);if(next.security.activeRoleId===id)next.security.activeRoleId=null;await persist(next);if(editing?.id===id)setEditing(null);setMessage('Role deleted.')};
 const setActive=async(id:string)=>{const next=structuredClone(project);next.security=next.security||{roles:[],activeRoleId:null};next.security.activeRoleId=id||null;await persist(next);setMessage(id?'Role simulation enabled. Every authoring query now uses this RLS role.':'Role simulation disabled.')};
 const updateRule=(i:number,patch:Partial<Rule>)=>setEditing(r=>{if(!r)return r;const n=structuredClone(r);n.rules[i]={...n.rules[i],...patch};return n});
 const addRule=()=>setEditing(r=>{if(!r)return r;const n=structuredClone(r);const t=tables[0]||'';n.rules.push(emptyRule(t,fieldsFor(t)[0]||''));return n});
 const removeRule=(i:number)=>setEditing(r=>{if(!r)return r;const n=structuredClone(r);n.rules.splice(i,1);return n});
 const summary=useMemo(()=>({tables:tables.length,roles:roles.length,rules:roles.reduce((a,r)=>a+(r.rules?.length||0),0)}),[tables.length,roles]);
 return <div className="page securityWorkbench">
   <div className="panelHeader securityHero"><div><span className="eyebrow">SECURITY ENGINE</span><h2>Row-Level Security</h2><p>Create reusable security roles and filter model rows before measures or visuals are evaluated.</p></div><button className="primary" onClick={newRole}><Plus size={16}/>New RLS Role</button></div>
   <div className="securitySummary"><div><ShieldCheck/><span><b>{summary.roles}</b>Roles</span></div><div><Filter/><span><b>{summary.rules}</b>Rules</span></div><div><Users/><span><b>{summary.tables}</b>Model tables</span></div></div>
   {message&&<div className="securityMessage"><CheckCircle2 size={16}/>{message}</div>}
   <div className="securityAuthoringGrid">
     <section className="securityRoleList"><div className="securitySectionTitle"><div><small>RLS ROLES</small><h3>Security roles</h3></div><button onClick={newRole}><Plus size={15}/>Create Role</button></div>
       {!roles.length&&<div className="securityEmpty"><ShieldCheck size={30}/><b>No RLS roles yet</b><span>Create a role, choose a model table/column and define the allowed row values.</span><button className="primary" onClick={newRole}>Create your first role</button></div>}
       {roles.map(r=><article className={'securityRoleRow '+(security.activeRoleId===r.id?'simulating':'')} key={r.id}><div><span className="securityRoleBadge">ROLE</span><h4>{r.name}</h4><p>{r.description||'Row-level security role'}</p><div className="securityRulePreview">{r.rules?.map((x,i)=><span key={i}>{x.table}.{x.column} <b>{x.operator}</b> {Array.isArray(x.value)?x.value.join(', '):String(x.value)}</span>)}</div></div><div className="securityRoleActions"><button onClick={()=>editRole(r)}><Pencil size={14}/>Edit</button><button className="dangerGhost" onClick={()=>deleteRole(r.id)}><Trash2 size={14}/>Delete</button></div></article>)}
     </section>
     <aside className="securitySimulation"><small>TEST SECURITY</small><h3>View as role</h3><p>Apply an RLS role to every query while authoring so you can verify what the consumer will see.</p><select value={security.activeRoleId||''} onChange={e=>setActive(e.target.value)}><option value="">No simulation</option>{roles.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select>{security.activeRoleId?<div className="securitySimOn"><Play size={15}/><div><b>Simulation active</b><span>Report queries are being restricted by this role.</span></div></div>:<div className="securitySimOff"><AlertTriangle size={15}/><span>No security role is currently simulated.</span></div>}<div className="securityHow"><b>Rule evaluation</b><span>Rules inside a role are combined with AND.</span><span>RLS is applied in the semantic query layer before aggregation.</span></div></aside>
   </div>
   {editing&&<div className="modalBackdrop"><div className="securityDialog"><div className="securityDialogHead"><div><small>{roles.some(r=>r.id===editing.id)?'EDIT ROLE':'NEW ROLE'}</small><h2>RLS Role Builder</h2></div><button onClick={()=>setEditing(null)}><X/></button></div><div className="securityRoleMeta"><label>Role name<input value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} placeholder="e.g. India Sales Manager"/></label><label>Description<input value={editing.description||''} onChange={e=>setEditing({...editing,description:e.target.value})} placeholder="Who should use this role?"/></label></div><div className="securityRulesHead"><div><b>Row filters</b><span>All rules in this role must be true.</span></div><button onClick={addRule}><Plus size={15}/>Add Rule</button></div><div className="securityRulesEditor">{editing.rules.map((r,i)=><div className="securityRuleEditor" key={r.id||i}><span className="ruleNumber">{i+1}</span><label>Table<select value={r.table} onChange={e=>{const t=e.target.value;updateRule(i,{table:t,column:fieldsFor(t)[0]||''})}}>{tables.map(t=><option key={t}>{t}</option>)}</select></label><label>Column<select value={r.column} onChange={e=>updateRule(i,{column:e.target.value})}>{fieldsFor(r.table).map(c=><option key={c}>{c}</option>)}</select></label><label>Operator<select value={r.operator} onChange={e=>updateRule(i,{operator:e.target.value})}>{OPERATORS.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label>Value<input value={Array.isArray(r.value)?r.value.join(', '):String(r.value??'')} onChange={e=>updateRule(i,{value:r.operator==='in'?e.target.value.split(',').map(x=>x.trim()).filter(Boolean):e.target.value})} placeholder={r.operator==='in'?'India, UK, US':'Allowed value'}/></label><button className="ruleDelete" onClick={()=>removeRule(i)} title="Remove rule"><Trash2 size={15}/></button></div>)}</div>{!editing.rules.length&&<div className="securityNoRules">This role has no row filters. Add at least one rule.</div>}<div className="securityDialogFooter"><span>{message}</span><button onClick={()=>setEditing(null)}>Cancel</button><button className="primary" disabled={saving||!editing.rules.length} onClick={saveRole}><Save size={15}/>{saving?'Saving…':'Save Role'}</button></div></div></div>}
 </div>
}
