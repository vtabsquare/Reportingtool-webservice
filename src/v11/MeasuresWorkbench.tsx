import {useEffect,useMemo,useRef,useState} from 'react';
import {
  Calculator,Plus,Sparkles,CheckCircle2,AlertTriangle,Save,Trash2,Braces,
  WandSparkles,Table2,ChevronRight,Search,GitBranch,FunctionSquare,PanelLeftClose,PanelLeftOpen,PanelRightClose,PanelRightOpen,Pencil,X
} from 'lucide-react';
import {api} from '../api';
import {useStudio} from '../store';

type Suggestion={
  kind:'table'|'field'|'measure'|'hierarchy'|'function',
  label:string,
  insert:string,
  detail:string
};

const DAX_TEMPLATES=[
 {name:'SWITCH',category:'Logical',description:'Match one expression or use SWITCH(TRUE()) for ordered conditions.',template:'SWITCH (\n    TRUE (),\n    «condition_1», «result_1»,\n    «condition_2», «result_2»,\n    «else_result»\n)'},
 {name:'VAR / RETURN',category:'Variables',description:'Define reusable intermediate values before returning the result.',template:'VAR «variable_name» =\n    «expression»\nRETURN\n    «result_expression»'},
 {name:'CALCULATE',category:'Filter context',description:'Evaluate an expression in a modified filter context.',template:'CALCULATE (\n    «expression»,\n    «Table[Column]» = «value»\n)'},
 {name:'FILTER + ALL',category:'Filter context',description:'Apply a row condition after removing filters from a table.',template:'CALCULATE (\n    «expression»,\n    FILTER (\n        ALL ( «Table» ),\n        «Table[Column]» «operator» «value»\n    )\n)'},
 {name:'IF',category:'Logical',description:'Return one result when a condition is true and another when false.',template:'IF (\n    «condition»,\n    «true_result»,\n    «false_result»\n)'},
 {name:'DIVIDE',category:'Math',description:'Divide safely with an alternate result for zero denominators.',template:'DIVIDE ( «numerator», «denominator», «alternate_result» )'},
 {name:'SELECTEDVALUE',category:'Filter context',description:'Read the single selected value with an optional fallback.',template:'SELECTEDVALUE ( «Table[Column]», «alternate_result» )'},
 {name:'Rolling period',category:'Time intelligence',description:'Evaluate an expression over a rolling date window.',template:'VAR MaxSelectedDate =\n    MAX ( «DateTable[Date]» )\nVAR StartDate =\n    EDATE ( MaxSelectedDate, -«months» ) + 1\nRETURN\n    CALCULATE (\n        «expression»,\n        DATESBETWEEN ( «DateTable[Date]», StartDate, MaxSelectedDate )\n    )'},
 {name:'Year to date',category:'Time intelligence',description:'Evaluate an expression from the start of the year.',template:'TOTALYTD ( «expression», «DateTable[Date]» )'},
 {name:'Previous year',category:'Time intelligence',description:'Shift the current date context back one year.',template:'CALCULATE (\n    «expression»,\n    SAMEPERIODLASTYEAR ( «DateTable[Date]» )\n)'},
 {name:'Date range',category:'Time intelligence',description:'Evaluate an expression between two date variables.',template:'VAR StartDate = «start_date_expression»\nVAR EndDate = «end_date_expression»\nRETURN\n    CALCULATE (\n        «expression»,\n        DATESBETWEEN ( «DateTable[Date]», StartDate, EndDate )\n    )'},
 {name:'Percent of total',category:'Patterns',description:'Divide the current value by the value with a column filter removed.',template:'DIVIDE (\n    «expression»,\n    CALCULATE ( «expression», REMOVEFILTERS ( «Table[Column]» ) ),\n    0\n)'}
];

function tokenAtCursor(text:string,cursor:number){
  const left=text.slice(0,cursor);
  if(/[\(\[,]\s*$/.test(left))return '@@TRIGGER@@';
  const bracket=left.match(/\[([^\]]*)$/);
  if(bracket)return '['+bracket[1];
  const m=left.match(/([A-Za-z0-9_]+)$/);
  return m?.[1]||'';
}

function parseMeasureDefinition(source:string){
  // Only a top-level = on the first line separates the display name from DAX.
  // An equals sign inside CALCULATE/FILTER parentheses remains an expression.
  const text=source.trim();
  const lineEnd=text.search(/[\r\n]/);
  const firstLine=lineEnd<0?text:text.slice(0,lineEnd);
  let depth=0,quote='',separator=-1;
  for(let index=0;index<firstLine.length;index++){
    const character=firstLine[index];
    if(quote){if(character===quote&&firstLine[index-1]!=='\\')quote='';continue}
    if(character==='"'||character==="'"){quote=character;continue}
    if(character==='('||character==='['){depth++;continue}
    if(character===')'||character===']'){depth=Math.max(0,depth-1);continue}
    if(character==='='&&depth===0){separator=index;break}
  }
  if(separator<0)return null;
  const name=firstLine.slice(0,separator).trim();
  const body=(firstLine.slice(separator+1)+(lineEnd<0?'':text.slice(lineEnd))).trim();
  return name&&body?{name,body}:null;
}

function definitionForEditor(name:string,source:string){
  const parsed=parseMeasureDefinition(source);
  const body=parsed?.body||source.trim();
  return body?`${name} =\n${body}`:`${name} =\n`;
}

export default function MeasuresWorkbench(){
 const{project,replaceProject}=useStudio();
 const names=Object.keys(project?.model?.measures||{});
 const[selected,setSelected]=useState('');
 const[expression,setExpression]=useState(selected?(project?.model.measures[selected]||''):'');
 const[validation,setValidation]=useState<any>(null);
 const[prompt,setPrompt]=useState('Last 3 months using Order date and derive sales using SalesAmount referring from selected dates excluding country like India');
 const[ai,setAi]=useState<any>(null);
 const[busy,setBusy]=useState(false);const[aiVisible,setAiVisible]=useState(true);const[aiMode,setAiMode]=useState<'new'|'edit'>(selected?'edit':'new');
 const[fieldSearch,setFieldSearch]=useState('');
 const[promptCursor,setPromptCursor]=useState(0);
 const[promptFocus,setPromptFocus]=useState(false);const[suggestionIndex,setSuggestionIndex]=useState(0);
 const[daxCursor,setDaxCursor]=useState(0);
 const[daxFocus,setDaxFocus]=useState(false);const[daxSuggestionIndex,setDaxSuggestionIndex]=useState(0);
 const[templateQuery,setTemplateQuery]=useState('');
 const[templateOpen,setTemplateOpen]=useState(false);
 const promptRef=useRef<HTMLTextAreaElement|null>(null);
 const daxRef=useRef<HTMLTextAreaElement|null>(null);
 const[viewMode,setViewMode]=useState<'grid'|'editor'>('grid');
 const[engineHealth,setEngineHealth]=useState<any>(null);

 const checkEngineHealth=async()=>{
   setEngineHealth({checking:true});
   try{setEngineHealth(await api<any>('/measures/health'))}
   catch(e:any){setEngineHealth({healthy:false,error:e.message||String(e)})}
 };
 useEffect(()=>{void checkEngineHealth()},[]);

 const DAX_FUNCTIONS = ['CALCULATE','SUM','AVERAGE','MIN','MAX','COUNT','COUNTROWS','DISTINCTCOUNT','MEDIAN','SUMX','AVERAGEX','MINX','MAXX','DIVIDE','IF','SWITCH','FILTER','ALL','ADDCOLUMNS','SUMMARIZE','TOPN','CONCATENATEX','REMOVEFILTERS','KEEPFILTERS','SELECTEDVALUE','COALESCE','ABS','ROUND','INT','FLOOR','CEILING','LEN','LOWER','UPPER','TRIM','LEFT','RIGHT','MID','CONCATENATE','SUBSTITUTE','VALUE','CONTAINSSTRING','CONTAINSSTRINGEXACT','ISBLANK','BLANK','DATE','DATEDIFF','EDATE','EOMONTH','STARTOFMONTH','ENDOFMONTH','DATEADD','DATESBETWEEN','DATESINPERIOD','DATESYTD','DATESMTD','DATESQTD','SAMEPERIODLASTYEAR','TOTALYTD','TOTALMTD','TOTALQTD','TODAY','NOW','YEAR','MONTH','DAY','POWER','SQRT','VAR','RETURN'];

 useEffect(()=>{
   if(selected){
     setExpression(definitionForEditor(selected,project?.model.measures[selected]||''));
     setValidation(null);
   }
 },[selected,project]);

 if(!project)return null;

 const semanticEntries=useMemo<Suggestion[]>(()=>{
   const out:Suggestion[]=[];
   for(const [table,t] of Object.entries<any>(project.model.tables||{})){
     out.push({kind:'table',label:table,insert:table,detail:`${Object.keys(t.columns||{}).length} columns`});
     for(const col of Object.keys(t.columns||{})){
       const field=`${table}[${col}]`;
       const dtype=project.model.columnTypes?.[`${table}.${col}`]||'column';
       out.push({kind:'field',label:col,insert:field,detail:`${table} · ${dtype}`});
     }
   }
   for(const h of project.model.hierarchies||[]){
     out.push({kind:'hierarchy',label:h.name,insert:h.name,detail:`${h.table} · ${h.levels?.map((x:any)=>x.name).join(' › ')||''}`});
   }
   for(const measure of Object.keys(project.model.measures||{})){
     out.push({kind:'measure',label:measure,insert:`[${measure}]`,detail:'Measure'});
   }
   for(const fn of (engineHealth?.supportedFunctions?[...engineHealth.supportedFunctions,'VAR','RETURN']:DAX_FUNCTIONS)){
     const template=DAX_TEMPLATES.find(item=>item.name.toUpperCase()===fn||(fn==='VAR'&&item.name==='VAR / RETURN'));
     out.push({kind:'function',label:fn,insert:template?.template||`${fn} ( «expression» )`,detail:template?.description||'DAX function'});
   }
   return out;
 },[project,engineHealth]);

 const promptToken=tokenAtCursor(prompt,promptCursor).toLowerCase();
 const promptSuggestions=useMemo(()=>{
   if(!promptFocus||promptToken.length<1||promptToken==='@@trigger@@')return [];
   const scored=semanticEntries.map(x=>{
     const label=x.label.toLowerCase(),insert=x.insert.toLowerCase(),detail=x.detail.toLowerCase();
     let score=0;
     if(label===promptToken)score+=100;
     if(label.startsWith(promptToken))score+=70;
     if(label.includes(promptToken))score+=45;
     if(insert.includes(promptToken))score+=25;
     if(detail.includes(promptToken))score+=10;
     if(x.kind==='field')score+=8;
     return {x,score};
   }).filter(z=>z.score>0).sort((a,b)=>b.score-a.score||a.x.label.localeCompare(b.x.label));
   return scored.slice(0,10).map(z=>z.x);
 },[promptFocus,promptToken,semanticEntries]);

 useEffect(()=>setSuggestionIndex(0),[promptToken]);

 const daxToken=tokenAtCursor(expression,daxCursor).toLowerCase();
 const daxSuggestions=useMemo(()=>{
   if(!daxFocus||(daxToken.length<1&&daxToken!=='@@trigger@@'))return [];
   const t=daxToken==='@@trigger@@'?'':daxToken;
   const scored=semanticEntries.map(x=>{
     const label=x.label.toLowerCase(),insert=x.insert.toLowerCase(),detail=x.detail.toLowerCase();
     let score=0;
     if(!t)score=x.kind==='function'?1:5;
     else{
       if(label===t)score+=100;
       if(label.startsWith(t))score+=70;
       if(label.includes(t))score+=45;
       if(insert.includes(t))score+=25;
       if(detail.includes(t))score+=10;
       if(x.kind==='field')score+=8;
     }
     return {x,score};
   }).filter(z=>z.score>0).sort((a,b)=>b.score-a.score||a.x.label.localeCompare(b.x.label));
   return scored.slice(0,10).map(z=>z.x);
 },[daxFocus,daxToken,semanticEntries]);

 useEffect(()=>setDaxSuggestionIndex(0),[daxToken]);

 const filteredTables=Object.entries<any>(project.model.tables||{}).filter(([t,x])=>{
   if(!fieldSearch)return true;
   const s=fieldSearch.toLowerCase();
   return t.toLowerCase().includes(s)||Object.keys(x.columns||{}).some(c=>c.toLowerCase().includes(s));
 });

 const insertIntoDax=(value:string,start?:number,end?:number)=>{
   const el=daxRef.current;
   const from=start??el?.selectionStart??daxCursor??expression.length;
   const to=end??el?.selectionEnd??from;
   const before=expression.slice(0,from),after=expression.slice(to);
   const padBefore=before && !/[\s(,=+\-*/]$/.test(before)?' ':'';
   const padAfter=after && !/^[\s),+\-*/]/.test(after)?' ':'';
   const next=before+padBefore+value+padAfter+after;
   setExpression(next);setValidation(null);
   requestAnimationFrame(()=>{
     if(!daxRef.current)return;
     const insertionStart=before.length+padBefore.length;
     const placeholder=value.match(/«[^»]+»/);
     const a=placeholder?insertionStart+(placeholder.index||0):insertionStart+value.length;
     const b=placeholder?a+placeholder[0].length:a;
     daxRef.current.focus();daxRef.current.setSelectionRange(a,b);setDaxCursor(b);setDaxFocus(false);
   });
 };

 const insertIntoPrompt=(s:Suggestion)=>{
    const el=promptRef.current;
    const cursor=el?.selectionStart ?? promptCursor;
    const left=prompt.slice(0,cursor);
    const token=tokenAtCursor(prompt,cursor);
    const tokenStart=cursor-token.length;
    const next=prompt.slice(0,tokenStart)+s.insert+prompt.slice(cursor);
    setPrompt(next);
    setPromptFocus(false);
    requestAnimationFrame(()=>{
      if(!promptRef.current)return;
      const p=tokenStart+s.insert.length;
      promptRef.current.focus();promptRef.current.setSelectionRange(p,p);setPromptCursor(p);
    });
  };

  const insertSuggestionIntoDax=(s:Suggestion)=>{
    const el=daxRef.current;
    const cursor=el?.selectionStart ?? daxCursor;
    const token=tokenAtCursor(expression,cursor);
    const tokenStart=token==='@@TRIGGER@@'?cursor:cursor-token.length;
    insertIntoDax(s.insert,tokenStart,cursor);
  };

 const visibleTemplates=DAX_TEMPLATES.filter(item=>!templateQuery||`${item.name} ${item.category} ${item.description}`.toLowerCase().includes(templateQuery.toLowerCase()));
 const parsedDefinition=useMemo(()=>parseMeasureDefinition(expression),[expression]);
 const name=parsedDefinition?.name||'';

 const newMeasure=()=>{
   setSelected('');
   setExpression('');
   setValidation(null);
   setAi(null);
   setAiMode('new');
   setViewMode('editor');
 };

 const validate=async()=>{
   if(!parsedDefinition){
     setValidation({valid:false,error:'Start the formula with a measure name followed by =, for example: Total Sales = SUM ( Sales[Amount] ).'});
     daxRef.current?.focus();
     return;
   }
   setBusy(true);
   setAi(null);
   try{
     const result=await api<any>('/measures/validate',{method:'POST',body:JSON.stringify({expression,project})});
     if(result.autoRepaired&&result.expression)setExpression(result.expression);
     setValidation(result);
   }catch(e:any){setValidation({valid:false,error:e.message})}
   finally{setBusy(false)}
 };

 const save=async()=>{
   if(!expression.trim()){setValidation({valid:false,error:'Enter a DAX expression before saving.'});return}
   if(!parsedDefinition){setValidation({valid:false,error:'Start the formula with a measure name followed by =, for example: Total Sales = SUM ( Sales[Amount] ).'});daxRef.current?.focus();return}
   setBusy(true);
   setAi(null);
   try{
     const r=await api<any>('/measures/save',{method:'POST',body:JSON.stringify({expression,originalName:aiMode==='new'?null:(selected||null),project})});
     replaceProject(r.project);
     setSelected('');
     setExpression('');
     setValidation(null);
     setAiMode('new');
     setViewMode('grid');
   }catch(e:any){setValidation({valid:false,error:e.message})}
   finally{setBusy(false)}
 };

 const generate=async(mode:'new'|'edit'='new')=>{
   setBusy(true);
   try{
     const r=await api<any>('/measures/ai-generate',{method:'POST',body:JSON.stringify({prompt,project})});
     if(mode==='new')setSelected('');
     const generatedName=mode==='edit'&&selected?selected:r.name;
     setAiMode(mode);setAi(r);setExpression(definitionForEditor(generatedName,r.expression));
     setValidation(r.valid?{valid:true,compiled:r.compiled,engine:'VTAB DAX',message:mode==='new'?'AI generated a new measure. Existing measures will be preserved.':'AI generated a replacement expression for the selected measure.'}:{valid:false,error:r.validationError});
   }catch(e:any){
     const msg:string = e.message||String(e);
     let friendly = msg;
     if(msg.includes('429')||msg.toLowerCase().includes('too many requests')||msg.toLowerCase().includes('quota')){
       friendly = 'The AI service is temporarily busy (rate limit reached). Please wait 30 seconds and try again.';
     } else if(msg.toLowerCase().includes('gemini_api_key')||msg.toLowerCase().includes('not configured')||msg.toLowerCase().includes('api key')){
       friendly = 'AI generation is not configured. Please set VTAB_GEMINI_API_KEY in your desktop.env file.';
     } else if(msg.toLowerCase().includes('timeout')||msg.toLowerCase().includes('timed out')){
       friendly = 'The AI service took too long to respond. Please try again.';
     }
     setAi({error:friendly});
   }
   finally{setBusy(false)}
 };

 const remove=async()=>{
   if(!selected||!confirm(`Delete measure ${selected}?`))return;
   const p=structuredClone(project);
   delete p.model.measures[selected];
   replaceProject(p);
   await api('/project',{method:'PUT',body:JSON.stringify(p)});
   newMeasure();
   setViewMode('grid');
 };
  const daxTextBefore = expression.substring(0, daxCursor);
  const daxLinesBefore = daxTextBefore.split('\n');
  const daxPopupTop = 15 + ((daxLinesBefore.length - 1) * 23) + 25 - (daxRef.current?.scrollTop || 0); 
  const daxPopupLeft = Math.min(63 + (daxLinesBefore[daxLinesBefore.length - 1].length * 8.4) - (daxRef.current?.scrollLeft || 0), 600);

  return <div id="vtab-measures-workspace" className="measuresWorkspace modelAwareMeasures professionalMeasures measureFieldsHidden">
   <style>{`
     #vtab-measures-workspace { display: flex !important; flex-direction: row !important; width: 100% !important; height: 100% !important; }
     #vtab-measures-workspace > .measureEditorPro, #vtab-measures-workspace > .measureGridLanding { flex: 1 !important; min-width: 0 !important; }
     #vtab-measures-workspace > .aiMeasurePane { width: 300px !important; min-width: 300px !important; flex-shrink: 0 !important; }
     .daxEditorShell { grid-template-rows: minmax(0, 1fr) !important; }
     .daxEditorShell textarea, .daxEditorShell .daxLineNumbers { min-height: 0 !important; height: 100% !important; overflow-y: auto !important; }
     .daxEditorShell .daxLineNumbers { overflow-y: hidden !important; }
   `}</style>

   {viewMode==='grid'?<section className="measureGridLanding" style={{padding:'32px 40px',overflowY:'auto',background:'#f8fafc',flex:1,display:'flex',flexDirection:'column'}}>
      <div style={{marginBottom:'32px'}}>
         <span className="eyebrow" style={{fontSize:'12px',fontWeight:700,color:'#64748b',letterSpacing:'0.05em'}}>VTAB MEASURE CATALOG</span>
         <h2 style={{fontSize:'28px',margin:'6px 0',color:'#0f172a'}}>Semantic Measures</h2>
         <p style={{color:'#64748b',fontSize:'14px'}}>{names.length} custom measures available in the semantic model.</p>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))',gap:'20px'}}>
         <button onClick={newMeasure} style={{background:'#fff',border:'2px dashed #cbd5e1',borderRadius:'12px',padding:'24px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'14px',color:'#2563eb',cursor:'pointer',minHeight:'180px',transition:'all 0.2s'}}>
            <div style={{width:'48px',height:'48px',borderRadius:'50%',background:'#eff6ff',display:'flex',alignItems:'center',justifyContent:'center'}}><Plus size={24}/></div>
            <b style={{fontSize:'15px'}}>Create New Measure</b>
         </button>
         {names.map(measure=>(
            <div key={measure} style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:'12px',padding:'20px',display:'flex',flexDirection:'column',cursor:'pointer',boxShadow:'0 2px 4px rgba(0,0,0,0.02)',transition:'all 0.2s',minHeight:'180px'}} onClick={()=>{setSelected(measure);setAiMode('edit');setViewMode('editor');}}>
               <div style={{display:'flex',alignItems:'flex-start',gap:'10px',marginBottom:'14px'}}>
                 <FunctionSquare size={18} color="#6366f1" style={{marginTop:'2px',flexShrink:0}}/>
                 <b style={{fontSize:'15px',color:'#0f172a',wordBreak:'break-word'}}>{measure}</b>
               </div>
               <code style={{fontSize:'12px',color:'#475569',background:'#f8fafc',padding:'10px 12px',borderRadius:'8px',flex:1,whiteSpace:'pre-wrap',overflow:'hidden',display:'-webkit-box',WebkitLineClamp:3,WebkitBoxOrient:'vertical',border:'1px solid #f1f5f9'}}>
                 {project.model.measures[measure]}
               </code>
               <div style={{marginTop:'16px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                 <span style={{fontSize:'11px',fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.05em'}}>VTAB DAX</span>
                 <div style={{display:'flex',gap:'6px'}}>
                   <button style={{background:'#fee2e2',border:'none',borderRadius:'6px',padding:'6px 12px',fontSize:'12px',fontWeight:600,color:'#dc2626',cursor:'pointer',display:'flex',alignItems:'center',gap:'6px'}} onClick={async (e)=>{e.stopPropagation();if(!confirm(`Delete measure ${measure}?`))return;const p=structuredClone(project);delete p.model.measures[measure];replaceProject(p);await api('/project',{method:'PUT',body:JSON.stringify(p)});if(selected===measure)newMeasure();}}><Trash2 size={12}/> Delete</button>
                   <button style={{background:'#f1f5f9',border:'none',borderRadius:'6px',padding:'6px 12px',fontSize:'12px',fontWeight:600,color:'#334155',cursor:'pointer',display:'flex',alignItems:'center',gap:'6px'}}><Pencil size={12}/> Edit</button>
                 </div>
               </div>
            </div>
         ))}
      </div>
   </section>:<>
   <section className="measureEditorPro">
      <div className="measureTopbar">
       <div><span className="eyebrow">VTAB DAX MEASURE ENGINE</span><h2>{selected?'Edit Measure':'Create Measure'}</h2><p>Write DAX manually or use the AI builder for assistance.</p></div>
       <div className="measureActions">
         <button onClick={()=>setViewMode('grid')} style={{marginRight:'auto'}}><Table2 size={15}/>Catalog</button>
         {!aiVisible&&<button onClick={()=>setAiVisible(true)}><PanelRightOpen size={15}/>AI Builder</button>}
         <button disabled={busy||!expression.trim()} onClick={validate}><CheckCircle2 size={15}/>Validate</button>
         <button disabled={busy||!expression.trim()} className="primary" onClick={save}><Save size={15}/>{selected?'Save Changes':'Save Measure'}</button>
         {selected&&<button title="Cancel editing" onClick={newMeasure}><X size={15}/>Cancel Edit</button>}
         {selected&&<button className="dangerBtn" title="Delete measure" onClick={remove}><Trash2 size={15}/></button>}
       </div>
     </div>

     {selected&&<div className="editingObjectBanner measureEditingBanner"><Pencil size={14}/><div><b>Editing existing measure: {selected}</b><span>{name!==selected?`Renaming to ${name}. Dependent measure and report visual references will be updated on Save Changes.`:'Changes will update this measure in place.'}</span></div></div>}

      <div className="daxQuickInsert">
        <button type="button" className="daxQuickInsertButton" onClick={()=>setTemplateOpen(open=>!open)}><FunctionSquare size={15}/><span>Quick formula</span><ChevronRight size={13} className={templateOpen?'open':''}/></button>
        {templateOpen&&<div className="daxTemplateMenu">
          <label><Search size={13}/><input autoFocus value={templateQuery} onChange={e=>setTemplateQuery(e.target.value)} placeholder="Search SWITCH, dates, CALCULATE…"/></label>
          <div>{visibleTemplates.map(item=><button type="button" key={item.name} onClick={()=>{insertIntoDax(item.template);setTemplateOpen(false);setTemplateQuery('')}}><FunctionSquare size={14}/><span><b>{item.name}</b><small>{item.category} · {item.description}</small></span></button>)}{!visibleTemplates.length&&<div className="daxTemplateEmpty">No matching formula templates.</div>}</div>
        </div>}
        <span>{parsedDefinition?<>Measure: <b>{parsedDefinition.name}</b></>:'Type the measure name before =, then enter the DAX expression.'}</span>
        <button type="button" className="enginePill" onClick={checkEngineHealth}
          title={engineHealth?.healthy?`${engineHealth.engineVersion} · ${engineHealth.checks} engine checks passed across ${engineHealth.supportedFunctionCount} supported functions. Click to run again.`:engineHealth?.checking?'Checking the DAX engine…':engineHealth?.error||engineHealth?.failures?.[0]?.error||'Run DAX engine health check'}
          style={{cursor:'pointer',borderColor:engineHealth?.healthy?'#86efac':engineHealth?.checking?'#bfdbfe':'#fca5a5',color:engineHealth?.healthy?'#166534':engineHealth?.checking?'#1d4ed8':'#b91c1c'}}>
          <Braces size={14}/>{engineHealth?.checking?'Checking DAX…':engineHealth?.healthy?`DAX healthy · ${engineHealth.checks} checks`:'DAX needs attention'}
        </button>
      </div>

      <div style={{position:'relative'}}>
        <div className="daxEditorShell">
          <div className="daxLineNumbers">{Array.from({length:Math.max(14,expression.split('\n').length)},(_,i)=><span key={i}>{i+1}</span>)}</div>
          <textarea ref={daxRef} value={expression}
            onScroll={e => {
              if (e.currentTarget.previousElementSibling) {
                e.currentTarget.previousElementSibling.scrollTop = e.currentTarget.scrollTop;
              }
            }}
            onSelect={e=>setDaxCursor((e.target as HTMLTextAreaElement).selectionStart)}
            onChange={e=>{setExpression(e.target.value);setDaxCursor(e.target.selectionStart);setValidation(null);setAi(null);setDaxFocus(true)}}
            onFocus={e=>{setDaxFocus(true);setDaxCursor(e.currentTarget.selectionStart)}}
            onBlur={()=>setTimeout(()=>setDaxFocus(false),200)}
            onKeyDown={e=>{
              if(daxSuggestions.length>0){
                if(e.key==='ArrowDown'){e.preventDefault();setDaxSuggestionIndex(i=>Math.min(i+1,daxSuggestions.length-1))}
                else if(e.key==='ArrowUp'){e.preventDefault();setDaxSuggestionIndex(i=>Math.max(i-1,0))}
                else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();insertSuggestionIntoDax(daxSuggestions[daxSuggestionIndex])}
                else if(e.key==='Escape'){setDaxFocus(false)}
              }
            }}
            spellCheck={false} placeholder={'Revenue =\nSUM ( Sales[Revenue] )'}/>
        </div>
        {daxFocus&&daxSuggestions.length>0&&<div className="promptSuggestions" style={{left:daxPopupLeft,top:daxPopupTop,right:'auto',width:350}}>{daxSuggestions.map((s,i)=><button type="button" key={i} className={i===daxSuggestionIndex?'active':''} onMouseDown={e=>{e.preventDefault();insertSuggestionIntoDax(s)}} onMouseEnter={()=>setDaxSuggestionIndex(i)}><span className={'suggestIcon '+s.kind}>{s.kind==='field'?'#':s.kind==='measure'?'∑':s.kind==='function'?'ƒ':'='}</span><div><b>{s.label}</b><small>{s.detail}</small></div></button>)}</div>}
      </div>

     {validation&&<div role="status" aria-live="polite" className={'daxValidation '+(validation.valid?'ok':'bad')}>
       {validation.valid?<><CheckCircle2/><div><b>{validation.autoRepaired?'Measure is valid · safe repair applied':validation.message||'Measure is valid'}</b>{validation.repairs?.map((repair:string)=><span key={repair}>{repair}</span>)}<code>{validation.compiled}</code></div></>:<><AlertTriangle/><div><b>Validation failed</b><span>{validation.error}</span>{validation.repairs?.map((repair:string)=><span key={repair}>Recovered: {repair}</span>)}</div></>}
     </div>}

     <div className="daxFunctionBar expandedFunctions"><span>Supported:</span>{(engineHealth?.supportedFunctions?[...engineHealth.supportedFunctions,'VAR','RETURN']:DAX_FUNCTIONS).map((fn:string)=><b key={fn}>{fn}</b>)}</div>
   </section>

    {aiVisible?<aside className="aiMeasurePane">
     <div className="aiMeasureHead"><WandSparkles size={18}/><div><small>AI MEASURE BUILDER</small><b>Describe the business logic</b></div><button className="icon aiPaneCollapse" onClick={()=>setAiVisible(false)} title="Hide AI builder"><PanelRightClose size={15}/></button></div>

     <div className="promptAutoWrap">
       <textarea ref={promptRef} value={prompt}
         onFocus={e=>{setPromptFocus(true);setPromptCursor(e.currentTarget.selectionStart)}}
         onBlur={()=>setTimeout(()=>setPromptFocus(false),160)}
         onSelect={e=>setPromptCursor((e.target as HTMLTextAreaElement).selectionStart)}
         onChange={e=>{setPrompt(e.target.value);setPromptCursor(e.target.selectionStart);setPromptFocus(true)}}
         onKeyDown={e=>{
           if(!promptSuggestions.length)return;
           if(e.key==='ArrowDown'){e.preventDefault();setSuggestionIndex(i=>(i+1)%promptSuggestions.length)}
           else if(e.key==='ArrowUp'){e.preventDefault();setSuggestionIndex(i=>(i-1+promptSuggestions.length)%promptSuggestions.length)}
           else if(e.key==='Enter'&&promptFocus){e.preventDefault();insertIntoPrompt(promptSuggestions[suggestionIndex]||promptSuggestions[0])}
           else if(e.key==='Escape'){setPromptFocus(false)}
         }}
         spellCheck={false}
         placeholder="Type business logic. Example: Number of Ke… then choose Key from the dropdown."/>
       {!!promptSuggestions.length&&<div className="promptSuggestions">
         {promptSuggestions.map((s,i)=><button className={i===suggestionIndex?'active':''} key={`${s.kind}-${s.insert}-${i}`} onMouseEnter={()=>setSuggestionIndex(i)} onMouseDown={e=>{e.preventDefault();insertIntoPrompt(s)}}>
           <span className={'suggestIcon '+s.kind}>{s.kind==='field'?'ƒ':s.kind==='measure'?'∑':s.kind==='hierarchy'?'⑂':'▦'}</span>
           <div><b>{s.label}</b><small>{s.detail}</small></div>
           <code>{s.insert}</code>
         </button>)}
       </div>}
     </div>

     <div className="promptHelp">Type a field fragment such as <b>Ke</b>, <b>Upd</b> or <b>Story</b>. Use ↑/↓ and Enter, or click a suggestion. Example: <b>Number of Ke</b> will suggest <b>Key</b>.</div>

     <div className="aiMeasureButtons"><button className="aiGenerateBtn" disabled={busy||!prompt.trim()} onClick={()=>generate('new')}><Sparkles size={16}/>{busy?'Working…':'Generate New Measure'}</button>{selected&&<button className="aiEditMeasureBtn" disabled={busy||!prompt.trim()} onClick={()=>generate('edit')}><Pencil size={15}/>Improve Selected Measure</button>}</div>

     <div className="aiGrounding"><b>AI is grounded to this model</b><span>{Object.keys(project.model.tables).length} tables · {Object.values<any>(project.model.tables).reduce((n,t)=>n+Object.keys(t.columns).length,0)} fields · {names.length} measures</span></div>

     {ai&&!ai.error&&<div className="aiMeasureResult verifiedAiResult">
       <div className="resultTitle"><CheckCircle2/><b>{ai.name}</b></div>
       <div className="verifiedIntent"><CheckCircle2 size={13}/><div><b>Semantic verification passed</b><span>{ai.intent?`Intent: ${String(ai.intent).replaceAll('_',' ')}`:'Grounded measure'}{ai.semanticChecks?.explicitFieldLock?' · exact field locked':''}</span></div></div>
       <p>{ai.explanation}</p><div className="aiPersistenceNote">{aiMode==='new'?'Creates a new measure. Existing measures remain unchanged.':'Updates only the selected measure when you click Save Changes.'}</div>
       {ai.grounding&&<div className="groundTags">{Object.entries(ai.grounding).filter(([,v])=>v).map(([k,v])=><span key={k}>{String(v)}</span>)}</div>}
       {ai.warnings?.map((w:string)=><div className="aiWarn" key={w}><AlertTriangle size={12}/>{w}</div>)}
     </div>}
     {ai?.error&&<div className="aiWarn"><AlertTriangle size={13}/>{ai.error}</div>}
   </aside>:<div 
       style={{ 
         flexShrink: 0,
         width: "35px", 
         minWidth: "35px", 
         height: "100%", 
         padding: "12px 0", 
         border: "none",
         borderLeft: "1px solid #d1d1d1",
         borderRadius: "0",
         background: "#fafafa",
         color: "#242424",
         display: "flex",
         flexDirection: "column",
         alignItems: "center",
         gap: "12px",
         cursor: "pointer",
         boxShadow: "none",
         zIndex: 2,
         transition: "background 0.1s"
       }} 
       onClick={() => setAiVisible(true)}
       onMouseEnter={(e) => { e.currentTarget.style.background = "#ededed"; e.currentTarget.style.color = "#0f6cbd"; }}
       onMouseLeave={(e) => { e.currentTarget.style.background = "#fafafa"; e.currentTarget.style.color = "#242424"; }}
     >
       <PanelRightOpen size={16} />
       <span style={{
         writingMode: "vertical-rl",
         transform: "rotate(180deg)",
         fontSize: "11px",
         fontWeight: "600",
         letterSpacing: "0.02em"
       }}>AI Measure Builder</span>
     </div>}
   </>}
 </div>;
}
