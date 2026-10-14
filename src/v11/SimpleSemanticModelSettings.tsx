import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

type Bridge={id:string;name:string;machine_name:string;status:string;last_heartbeat?:string;version?:string;enabled:boolean};
type Connection={id:string;name:string;source_type:string;status?:string;last_error?:string;last_tested_at?:string;gateway_id?:string;connection_config?:any};
type Runtime={workspace_id:string;source_manifest?:any;connections:Connection[];schedule?:any;parameters?:any[];readiness?:{refresh_ready:boolean;blockers:string[]}};
type Model={id:string;name:string;workspace_id:string};
type Source={id:string;name:string;type:string;mode:string;configuration:any;tables:any[]};

const canManage=(role:string)=>['Admin','Member','Contributor','Owner','Co-Owner'].includes(role);
const when=(value?:string)=>value?new Date(value).toLocaleString():'Never';
const normalType=(value:any)=>{const key=String(value||'').toLowerCase();if(key.includes('postgres'))return'postgresql';if(key.includes('sqlserver')||key.includes('sql_server')||key.includes('mssql'))return'sqlserver';if(key.includes('mysql'))return'mysql';if(key.includes('sheet'))return'google_sheets';return key||'unknown'};
const typeLabel=(value:string)=>({postgresql:'PostgreSQL',sqlserver:'SQL Server',mysql:'MySQL',google_sheets:'Google Sheets',rest:'REST API'} as any)[normalType(value)]||value||'Source';
const sourceKey=(source:Source)=>`${normalType(source.type)}|${source.configuration?.host||source.configuration?.server||source.configuration?.url||''}|${source.configuration?.database||''}`;

function sourcesFrom(runtime:Runtime):Source[]{
  const raw=runtime.source_manifest?.sources||[];
  const grouped=new Map<string,Source>();
  raw.forEach((item:any,index:number)=>{
    const type=normalType(item.type||item.sourceType);
    if(['managed_file','published_data','snapshot','file'].includes(type))return;
    const source:Source={id:String(item.id||`source-${index+1}`),name:String(item.name||typeLabel(type)),type,mode:String(item.storageMode||item.mode||'Import'),configuration:item.configuration||{},tables:item.tables||[]};
    const key=sourceKey(source),current=grouped.get(key);
    if(current)current.tables=[...current.tables,...source.tables];else grouped.set(key,source);
  });
  return [...grouped.values()];
}

export default function SimpleSemanticModelSettings({model,runtime,role,onReload}:{model:Model;runtime:Runtime;role:string;onReload:()=>Promise<void>}){
  const sources=useMemo(()=>sourcesFrom(runtime),[runtime.source_manifest]);
  const[bridges,setBridges]=useState<Bridge[]>([]),[bridgeId,setBridgeId]=useState(''),[binding,setBinding]=useState<any>(null),[busy,setBusy]=useState(false),[refreshBusy,setRefreshBusy]=useState(false),[refreshState,setRefreshState]=useState<any>(null),[message,setMessage]=useState(''),[error,setError]=useState(''),[editing,setEditing]=useState<Source|null>(null);
  const loadBridges=async()=>{setBusy(true);setError('');try{const[list,current]=await Promise.all([api<Bridge[]>(`/service/workspaces/${model.workspace_id}/data-bridges`),api<any>(`/service/semantic-models/${model.id}/data-bridge`)]);const savedId=String(current?.bridge_id||'');const savedBridge=current?.bridge||list.find(item=>item.id===savedId)||null;setBridges(list);setBinding({...current,bridge_id:savedId||null,bridge:savedBridge});setBridgeId(savedId)}catch(e:any){setError(e?.message||String(e))}finally{setBusy(false)}};
  useEffect(()=>{void loadBridges()},[model.id,model.workspace_id]);
  const saveBridge=async()=>{setBusy(true);setError('');setMessage('');try{const result=await api<any>(`/service/semantic-models/${model.id}/data-bridge`,{method:'PUT',body:JSON.stringify({bridgeId})});setBinding(result);setMessage(bridgeId?'Desktop Data Bridge connected to this semantic model.':'Data Bridge mapping removed.');await loadBridges()}catch(e:any){setError(e?.message||String(e));setBusy(false)}};
  const runRefresh=async()=>{setRefreshBusy(true);setError('');setMessage('');try{const queued=await api<any>(`/service/semantic-models/${model.id}/bridge-refresh`,{method:'POST'});const jobId=queued.job_id;if(!jobId)throw new Error('Services did not return a refresh job.');setRefreshState({status:'queued'});for(let attempt=0;attempt<90;attempt++){await new Promise(resolve=>setTimeout(resolve,2000));const state=await api<any>(`/service/semantic-models/${model.id}/bridge-refresh/${jobId}`);setRefreshState(state);if(state.status==='succeeded'){setMessage(`Refresh completed. ${Number(state.result?.rows||0).toLocaleString()} rows loaded.`);await onReload();return}if(state.status==='failed')throw new Error(state.error_message||'Data Bridge refresh failed.')}throw new Error('Refresh is still running. You can close this window and check Refresh History later.')}catch(e:any){setError(e?.message||String(e))}finally{setRefreshBusy(false)}};
  const connectionFor=(source:Source)=>runtime.connections.find(c=>(c.name&&c.name===source.name)||normalType(c.source_type)===normalType(source.type));
  const boundBridge:Bridge|null=binding?.bridge||bridges.find(b=>b.id===binding?.bridge_id)||null;
  const bridgeOnline=boundBridge?.status==='online';
  const allCloud=sources.length>0&&sources.every(s=>['google_sheets','rest','odata','graphql','sharepoint','onedrive','google_drive','azure_blob','adls_gen2','s3','gcs'].includes(normalType(s.type)));
  const canRefresh=sources.length>0&&(allCloud||bridgeOnline);
  return <div style={{maxWidth:900}}><h2 style={{marginTop:0}}>Semantic Model Settings</h2><p style={hint}>Only data connectivity and refresh settings are shown here. Model tables and published snapshot versions remain part of the semantic model, not connection settings.</p>{error&&<Notice error>{error}</Notice>}{message&&<Notice>{message}</Notice>}
    <Section title="1. Data sources"><p style={hint}>Each original database or cloud endpoint appears once, even when it supplies multiple model tables.</p>{sources.length?<div style={sourceGrid}><b>Source</b><b>Type</b><b>Mode</b><b>Status</b><span/>{sources.map(source=>{const connection=connectionFor(source);const local=/^(localhost|127\.0\.0\.1|::1)$/i.test(String(source.configuration?.host||source.configuration?.server||''));const status=connection?.status==='connected'?'Connected':local&&bridgeOnline?'Bridge online':'Setup required';return <div key={source.id} style={{display:'contents'}}><span><b style={{display:'block'}}>{source.name}</b>{source.configuration?.database&&<small style={hint}>{source.configuration.database}</small>}</span><span>{typeLabel(source.type)}</span><span>{source.mode}</span><span style={{color:status==='Connected'||status==='Bridge online'?'#166534':'#b45309',fontWeight:700}}>{status}</span><button disabled={!canManage(role)||local} style={link} onClick={()=>setEditing(source)}>{local?'Uses Data Bridge':connection?'Edit':'Configure'}</button></div>})}</div>:<Empty text="This published model contains imported data but no source identity. It was created before PostgreSQL source metadata was retained. In Desktop, reconnect to PostgreSQL, reimport the report tables once, save, and republish. The password remains local; Services will then show one PostgreSQL source entry."/>}</Section>
    <Section title="2. Desktop Data Bridge"><p style={hint}>Use this only for localhost or private-network sources. Open Desktop Settings → Data Bridge on the database computer, select this workspace, and connect it.</p><div style={bridgeCard}><div><b>{boundBridge?.name||'No bridge selected'}</b><small>{boundBridge?`${boundBridge.machine_name} · ${boundBridge.status} · Last seen ${when(boundBridge.last_heartbeat)}`:'Select an online Desktop bridge below and save it.'}</small></div><span style={{...statusPill,background:bridgeOnline?'#dcfce7':'#f1f5f9',color:bridgeOnline?'#166534':'#64748b'}}>{bridgeOnline?'Online':boundBridge?'Offline':'Not selected'}</span></div><div style={{display:'flex',gap:9,alignItems:'end'}}><label style={{...label,flex:1}}>Available bridge<select value={bridgeId} disabled={!canManage(role)||busy} onChange={e=>setBridgeId(e.target.value)} style={control}><option value="">No bridge</option>{bridges.map(bridge=><option key={bridge.id} value={bridge.id} disabled={bridge.status!=='online'}>{bridge.name} · {bridge.machine_name} · {bridge.status}</option>)}</select></label><button disabled={!canManage(role)||busy||bridgeId===String(binding?.bridge_id||'')||(!!bridgeId&&bridges.find(b=>b.id===bridgeId)?.status!=='online')} style={primary} onClick={()=>void saveBridge()}>{busy?'Checking…':'Save bridge'}</button><button disabled={busy} style={secondary} onClick={()=>void loadBridges()}>Refresh status</button></div>{!bridges.length&&<Empty text="No Desktop Data Bridge is registered in this workspace."/>}</Section>
    <Section title="3. Refresh"><p style={hint}>{allCloud?'Cloud data sources (such as Google Sheets) are refreshed directly by Services in the cloud.':'Refresh requests are executed on the selected Desktop Data Bridge. Database credentials remain protected on that computer and are never returned to Services.'}</p>{canRefresh?<div style={ready}><span>Ready for manual refresh{refreshState?.status?` · ${refreshState.status}`:''}</span><button disabled={refreshBusy} style={primary} onClick={()=>void runRefresh()}>{refreshBusy?'Refreshing…':'Refresh now'}</button></div>:<div style={warning}><b>Refresh is not ready.</b><span>{!sources.length?'Republish from the updated Desktop so the semantic model includes its source identity.':allCloud?'Configure and connect all cloud data sources above.':!boundBridge?'Select and save a Desktop Data Bridge.':'Open VTAB Desktop and wait for the bridge to become Online.'}</span></div>}
      <div style={{marginTop:12,padding:'10px 14px',background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:8,display:'flex',alignItems:'center',gap:8}}>
        <span style={{color:'#166534',fontWeight:600,fontSize:13}}>✓ Automatic Email & In-App Alerts Active</span>
        <span style={{color:'#15803d',fontSize:12}}>— Whenever a refresh runs, an email will be automatically sent to your inbox on both success and failure.</span>
      </div>
    </Section>
    {!!runtime.parameters?.length&&<Section title="4. Parameters"><p style={hint}>{runtime.parameters.length} published parameter{runtime.parameters.length===1?' is':'s are'} available. Parameter values remain unchanged by this connectivity update.</p></Section>}
    {editing&&<DirectConnectionDialog modelId={model.id} source={editing} current={connectionFor(editing)} onClose={()=>setEditing(null)} onSaved={async()=>{setEditing(null);await onReload()}}/>}
  </div>;
}

function DirectConnectionDialog({modelId,source,current,onClose,onSaved}:{modelId:string;source:Source;current?:Connection;onClose:()=>void;onSaved:()=>Promise<void>}){
  const isGoogleSheets = normalType(source.type) === 'google_sheets';
  const initial = {
    host: source.configuration?.host || source.configuration?.server || current?.connection_config?.host || '',
    port: source.configuration?.port || current?.connection_config?.port || (source.type === 'postgresql' ? 5432 : 1433),
    database: source.configuration?.database || current?.connection_config?.database || '',
    username: '',
    password: '',
    sslmode: current?.connection_config?.sslmode || 'require',
    url: source.configuration?.url || current?.connection_config?.url || '',
    sheet: source.configuration?.sheet || source.configuration?.sheetName || current?.connection_config?.sheet || source.name || 'Sheet1',
  };
  const [form, setForm] = useState<any>(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');

  const payload = () => {
    if (isGoogleSheets) {
      const cleanUrl = String(form.url || '').trim();
      const cleanSheet = String(form.sheet || '').trim();
      const tables = (source.tables && source.tables.length > 0) ? source.tables : [{ table: source.name }];
      return {
        id: current?.id,
        name: source.name,
        source_type: 'google_sheets',
        connection_config: {
          url: cleanUrl,
          sheet: cleanSheet,
        },
        credentials: {
          sheet_url: cleanUrl,
        },
        authentication_method: 'anonymous',
        privacy_level: 'organizational',
        encrypted_transport: true,
        table_mappings: tables.map((item: any) => ({
          table: item.modelTable || item.table || item.name,
          query: item.query || '',
          url: cleanUrl || item.url || source.configuration?.url || '',
          sheet: cleanSheet || item.sheet || item.name || '',
          storage_path: item.managedStoragePath || '',
        })).filter((item: any) => item.table),
      };
    }

    return {
      id: current?.id,
      name: source.name,
      source_type: source.type,
      connection_config: {
        host: form.host,
        port: Number(form.port),
        database: form.database,
        sslmode: form.sslmode,
      },
      credentials: {
        username: form.username,
        password: form.password,
      },
      authentication_method: 'username_password',
      privacy_level: 'organizational',
      encrypted_transport: form.sslmode === 'require',
      table_mappings: source.tables.map((item: any) => ({
        table: item.modelTable || item.table || item.name,
        query: item.query || '',
        url: item.url || '',
        storage_path: item.managedStoragePath || '',
      })).filter((item: any) => item.table),
    };
  };

  const testAndSave = async () => {
    setBusy(true);
    setError('');
    try {
      const body = payload();
      const test = await api<any>(`/service/semantic-models/${modelId}/connections/test`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!test.ok) throw new Error(test.message || 'Connection test failed.');
      await api(`/service/semantic-models/${modelId}/connections`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      await onSaved();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave = isGoogleSheets
    ? Boolean(String(form.url || '').trim())
    : Boolean(form.host && form.database && form.username && (current || form.password));

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <section style={dialog} onMouseDown={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>
          {current ? 'Edit' : 'Configure'} {source.name}
        </h3>
        <p style={hint}>
          {isGoogleSheets
            ? 'Connect directly to Google Sheets for automated data refresh. Ensure sharing access is set to "Anyone with the link can view".'
            : 'This direct connection is tested by Services. Use Desktop Data Bridge instead when the host is localhost or private.'}
        </p>
        {error && <Notice error>{error}</Notice>}
        {isGoogleSheets ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <Field
              label="Google Sheets URL"
              value={form.url}
              onChange={value => setForm({ ...form, url: value })}
            />
            <Field
              label="Worksheet name"
              value={form.sheet}
              onChange={value => setForm({ ...form, sheet: value })}
            />
            <div
              style={{
                padding: '10px 12px',
                background: '#f0fdf4',
                border: '1px solid #bbf7d0',
                borderRadius: 7,
                fontSize: 12,
                color: '#166534',
                lineHeight: 1.5,
              }}
            >
              💡 <b>Google Sheets Access:</b> In Google Sheets, click <b>Share</b> → set General access to <b>&ldquo;Anyone with the link&rdquo;</b> (Role: <b>Viewer</b>). Services will securely pull the latest sheet data during refresh.
            </div>
          </div>
        ) : (
          <div style={formGrid}>
            <Field label="Host / server" value={form.host} onChange={value => setForm({ ...form, host: value })} />
            <Field label="Port" value={form.port} onChange={value => setForm({ ...form, port: value })} />
            <Field label="Database" value={form.database} onChange={value => setForm({ ...form, database: value })} />
            <Field label="Username" value={form.username} onChange={value => setForm({ ...form, username: value })} />
            <Field label="Password" type="password" value={form.password} onChange={value => setForm({ ...form, password: value })} />
            <label style={label}>
              Encryption
              <select value={form.sslmode} onChange={e => setForm({ ...form, sslmode: e.target.value })} style={control}>
                <option value="require">Required</option>
                <option value="prefer">Preferred</option>
                <option value="disable">Disabled</option>
              </select>
            </label>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button onClick={onClose} style={secondary}>
            Cancel
          </button>
          <button
            disabled={busy || !canSave}
            onClick={() => void testAndSave()}
            style={primary}
          >
            {busy ? 'Testing…' : 'Test and save'}
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({label:caption,value,type='text',onChange}:{label:string;value:any;type?:string;onChange:(value:string)=>void}){return <label style={label}>{caption}<input type={type} value={value} onChange={e=>onChange(e.target.value)} style={control}/></label>}
function Section({title,children}:{title:string;children:any}){return <details open style={section}><summary style={summary}>{title}</summary><div style={{padding:'2px 16px 17px'}}>{children}</div></details>}
function Notice({children,error=false}:{children:any;error?:boolean}){return <div style={{padding:11,marginBottom:11,border:`1px solid ${error?'#fecaca':'#bbf7d0'}`,background:error?'#fef2f2':'#f0fdf4',color:error?'#991b1b':'#166534',borderRadius:7,fontSize:12}}>{children}</div>}
function Empty({text}:{text:string}){return <div style={{padding:14,border:'1px dashed #cbd5e1',borderRadius:7,color:'#64748b',fontSize:12,marginTop:10}}>{text}</div>}

const hint:React.CSSProperties={fontSize:12,color:'#64748b',lineHeight:1.55,marginTop:0};
const section:React.CSSProperties={border:'1px solid #e2e8f0',borderRadius:9,marginBottom:12,background:'#fff'};
const summary:React.CSSProperties={padding:'14px 16px',fontWeight:800,fontSize:14,cursor:'pointer'};
const sourceGrid:React.CSSProperties={display:'grid',gridTemplateColumns:'minmax(190px,1fr) 120px 80px 120px 100px',gap:0,alignItems:'center',border:'1px solid #e5e7eb',borderRadius:7,overflow:'hidden',fontSize:12};
const bridgeCard:React.CSSProperties={display:'flex',alignItems:'center',gap:12,padding:13,border:'1px solid #e5e7eb',borderRadius:7,marginBottom:12};
const statusPill:React.CSSProperties={marginLeft:'auto',padding:'5px 9px',borderRadius:12,fontSize:11,fontWeight:800};
const label:React.CSSProperties={display:'grid',gap:5,fontSize:12,fontWeight:700};
const control:React.CSSProperties={height:38,border:'1px solid #cbd5e1',borderRadius:6,padding:'7px 9px',background:'#fff'};
const secondary:React.CSSProperties={height:38,border:'1px solid #cbd5e1',borderRadius:6,padding:'7px 12px',background:'#fff',fontWeight:700,cursor:'pointer'};
const primary:React.CSSProperties={...secondary,background:'#6d28d9',borderColor:'#6d28d9',color:'#fff'};
const link:React.CSSProperties={border:0,background:'transparent',color:'#5b21b6',fontWeight:700,cursor:'pointer',textAlign:'left'};
const ready:React.CSSProperties={display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,padding:12,border:'1px solid #bbf7d0',background:'#f0fdf4',color:'#166534',borderRadius:7,fontSize:12,fontWeight:800};
const warning:React.CSSProperties={display:'grid',gap:4,padding:12,border:'1px solid #fde68a',background:'#fffbeb',color:'#92400e',borderRadius:7,fontSize:12};
const backdrop:React.CSSProperties={position:'fixed',inset:0,zIndex:1500,background:'rgba(15,23,42,.45)',display:'grid',placeItems:'center',padding:20};
const dialog:React.CSSProperties={width:'min(650px,95vw)',background:'#fff',borderRadius:10,padding:22,boxShadow:'0 24px 60px rgba(15,23,42,.3)'};
const formGrid:React.CSSProperties={display:'grid',gridTemplateColumns:'1fr 1fr',gap:12};
