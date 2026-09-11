import {useEffect,useMemo,useState} from 'react';
import {useStudio} from '../store';

type RibbonTab={id:string;label:string;contextual?:boolean};
const standard:RibbonTab[]=[{id:'file',label:'File'},{id:'home',label:'Home'}];
const tabsByView:Record<string,RibbonTab[]>={
  data:[...standard,{id:'table-tools',label:'Table tools',contextual:true},{id:'view',label:'View'}],
  transform:[...standard,{id:'transform',label:'Transform'},{id:'add-column',label:'Add column'},{id:'view',label:'View'},{id:'tools',label:'Tools'}],
  model:[...standard,{id:'modeling',label:'Modeling'},{id:'view',label:'View'},{id:'optimize',label:'Optimize'}],
  'ai-measures':[...standard,{id:'modeling',label:'Modeling'},{id:'ai-tools',label:'AI tools',contextual:true},{id:'view',label:'View'}],
  measures:[...standard,{id:'modeling',label:'Modeling'},{id:'measure-tools',label:'Measure tools',contextual:true},{id:'view',label:'View'}],
  report:[...standard,{id:'insert',label:'Insert'},{id:'modeling',label:'Modeling'},{id:'view',label:'View'},{id:'optimize',label:'Optimize'},{id:'format',label:'Format',contextual:true},{id:'data-drill',label:'Data / Drill',contextual:true}],
};

export default function WorkflowGuide(){
  const{view}=useStudio() as any;
  const tabs=useMemo(()=>tabsByView[view]||standard,[view]);
  const[active,setActive]=useState('home');
  useEffect(()=>setActive('home'),[view]);
  const choose=(id:string)=>{
    setActive(id);
    window.dispatchEvent(new CustomEvent('vtab:ribbon-tab',{detail:{view,tab:id}}));
  };
  return <nav className="authoringFlow powerBiFlow" aria-label="Authoring ribbon tabs">
    {tabs.map(tab=><button key={tab.id} aria-current={active===tab.id?'page':undefined} className={`flowStage ${active===tab.id?'active':''} ${tab.contextual?'contextual':''}`} onClick={()=>choose(tab.id)}><span>{tab.label}</span></button>)}
  </nav>;
}
