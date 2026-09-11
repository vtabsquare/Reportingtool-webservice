import{Home,Database,Workflow,Network,ChartNoAxesCombined,ShieldCheck,Sparkles,Calculator,BrainCircuit,PackageOpen,Settings}from'lucide-react';
import{useStudio}from'../store';

const buildItems=[
  ['home','Home',Home,'#2563eb'],
  ['data','Get Data',Database,'#16a34a'],
  ['transform','Transform',Workflow,'#0ea5e9'],
  ['model','Model',Network,'#3b82f6'],
  ['ai-measures','AI Measures',BrainCircuit,'#7c3aed'],
  ['measures','Measures',Calculator,'#8b5cf6'],
  ['report','Report',ChartNoAxesCombined,'#0284c7'],
] as const;
const manageItems=[
  ['security','Security',ShieldCheck,'#22c55e'],
  ['packages','Packages',PackageOpen,'#7c3aed'],
] as const;

export default function Sidebar(){
  const{view,setView}=useStudio() as any;
  const isHome=view==='home';
  const go=(id:string)=>setView(id);
  return (
    <aside className={`sidebar powerBiRail ${isHome?'railHome':''}`} aria-label="Application views">
      <div className="brand" title="VTAB Reporting Studio">
        <div className="brandMark" aria-hidden="true">V</div>
        <div className="brandName"><b>VTAB</b></div>
      </div>
      <nav className="navDock">
        {buildItems.map(([id,label,Icon,color])=>{
          if(isHome&&id!=='home')return null;
          return <button key={id} aria-label={label} aria-current={view===id?'page':undefined} className={`navItem ${view===id?'active':''}`} onClick={()=>go(id)} style={{'--nav-accent':color} as any} title={label}>
            <span className="navIcon"><Icon size={19} strokeWidth={2}/></span><span className="navLabel">{label}</span>
          </button>
        })}
        {!isHome&&<div className="railSeparator"/>}
        {!isHome&&manageItems.map(([id,label,Icon,color])=><button key={id} aria-label={label} aria-current={view===id?'page':undefined} className={`navItem ${view===id?'active':''}`} onClick={()=>go(id)} style={{'--nav-accent':color} as any} title={label}>
          <span className="navIcon"><Icon size={19} strokeWidth={2}/></span><span className="navLabel">{label}</span>
        </button>)}
      </nav>

      {!isHome&&<div className="railBottomActions">
        <button aria-label="Assist" aria-current={view==='copilot'?'page':undefined} className={`navItem copilotItem ${view==='copilot'?'active':''}`} onClick={()=>go('copilot')} title="Assist">
          <span className="navIcon"><Sparkles size={19}/></span><span className="navLabel">Assist</span>
        </button>
        <button aria-label="Settings" className="navItem settingsItem" onClick={()=>window.dispatchEvent(new CustomEvent('vtab:open-settings'))} title="Settings">
          <span className="navIcon"><Settings size={19}/></span><span className="navLabel">Settings</span>
        </button>
      </div>}
    </aside>
  );
}
