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

const daxFunctions = ['VAR','RETURN','CALCULATE','SUM','AVERAGE','MIN','MAX','COUNT','COUNTROWS','DISTINCTCOUNT','MEDIAN','SUMX','AVERAGEX','MINX','MAXX','DIVIDE','SELECTEDVALUE','COALESCE','ABS','ROUND','INT','FLOOR','CEILING','LEN','EDATE','EOMONTH','DATESBETWEEN','DATESINPERIOD','SAMEPERIODLASTYEAR','TOTALYTD','TOTALMTD','TOTALQTD','REMOVEFILTERS','ALL','KEEPFILTERS','FILTER','SWITCH','IF','ISBLANK','BLANK','AND','OR','NOT','IN','DATE','YEAR','MONTH','DAY','POWER','SQRT'];

function tokenAtCursor(text:string,cursor:number){
  // Only the current identifier fragment is used. "Number of Ke" => "Ke".
  const left=text.slice(0,cursor);
  const bracket=left.match(/\[([^\]]*)$/);
  if(bracket)return bracket[1].trim();
  const m=left.match(/([A-Za-z0-9_]+)$/);
  return m?.[1]||'';
}

export default function MeasuresWorkbench(){
 const{project,replaceProject}=useStudio();
 const names=Object.keys(project?.model?.measures||{});
 const[selected,setSelected]=useState(names[0]||'');
 const[name,setName]=useState(selected||'New_Measure');
 const[expression,setExpression]=useState(selected?(project?.model.measures[selected]||''):'');
 const[validation,setValidation]=useState<any>(null);
 const[prompt,setPrompt]=useState('Last 3 months using Order date and derive sales using SalesAmount referring from selected dates excluding country like India');
 const[ai,setAi]=useState<any>(null);
 const[busy,setBusy]=useState(false);const[fieldsVisible,setFieldsVisible]=useState(true);const[aiVisible,setAiVisible]=useState(true);const[aiMode,setAiMode]=useState<'new'|'edit'>(selected?'edit':'new');
 const[fieldSearch,setFieldSearch]=useState('');
 const[promptCursor,setPromptCursor]=useState(0);
 const[promptFocus,setPromptFocus]=useState(false);const[suggestionIndex,setSuggestionIndex]=useState(0);
 const[daxCursor,setDaxCursor]=useState(0);
 const[daxFocus,setDaxFocus]=useState(false);
 const[daxSuggestionIndex,setDaxSuggestionIndex]=useState(0);
 const promptRef=useRef<HTMLTextAreaElement|null>(null);
 const daxRef=useRef<HTMLTextAreaElement|null>(null);

 useEffect(()=>{
   if(selected){
     setName(selected);
     setExpression(project?.model.measures[selected]||'');
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
   return out;
 },[project]);

 const promptToken=tokenAtCursor(prompt,promptCursor).toLowerCase();
 const promptSuggestions=useMemo(()=>{
   if(!promptFocus||promptToken.length<1)return [];
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
  const daxEntries=useMemo<Suggestion[]>(()=>{
    return [...semanticEntries, ...daxFunctions.map(f=>({kind:'function',label:f,insert:`${f} ( )`,detail:'DAX Function'} as Suggestion))];
  },[semanticEntries]);
  const daxSuggestions=useMemo(()=>{
    const left=expression.slice(0,daxCursor);
    const isBracket = left.match(/\[([^\]]*)$/);
    const isTrigger = /[([,]\s*$/.test(left) || isBracket;
    if(!daxFocus||(daxToken.length<1 && !isTrigger))return [];
    
    const scored=daxEntries.map(x=>{
      if(isBracket && x.kind==='function') return {x, score: 0};
      
      const label=x.label.toLowerCase(),insert=x.insert.toLowerCase(),detail=x.detail.toLowerCase();
      let score=0;
      if(daxToken.length===0){
         if(isBracket){
            if(x.kind==='field'||x.kind==='measure') score+=100;
         }else{
            if(x.kind==='function') score+=50;
            if(x.kind==='table') score+=40;
            if(x.kind==='field'||x.kind==='measure') score+=30;
         }
      }else{
         if(label===daxToken)score+=100;
         else if(label.startsWith(daxToken))score+=70;
         else if(label.includes(daxToken))score+=45;
         else if(insert.includes(daxToken))score+=25;
         else if(detail.includes(daxToken))score+=10;
         
         if(x.kind==='field')score+=8;
         if(x.kind==='function')score+=15;
      }
      return {x,score};
    }).filter(z=>z.score>0).sort((a,b)=>b.score-a.score||a.x.label.localeCompare(b.x.label));
    return scored.slice(0,15).map(z=>z.x);
  },[daxFocus,daxToken,daxEntries,expression,daxCursor]);
  useEffect(()=>setDaxSuggestionIndex(0),[daxToken]);

 const filteredTables=Object.entries<any>(project.model.tables||{}).filter(([t,x])=>{
   if(!fieldSearch)return true;
   const s=fieldSearch.toLowerCase();
   return t.toLowerCase().includes(s)||Object.keys(x.columns||{}).some(c=>c.toLowerCase().includes(s));
 });

 const insertIntoDax=(value:string)=>{
   const el=daxRef.current;
   const pos=el?.selectionStart ?? daxCursor ?? expression.length;
   const before=expression.slice(0,pos),after=expression.slice(pos);
   const padBefore=before && !/[\s(,=+\-*/]$/.test(before)?' ':'';
   const padAfter=after && !/^[\s),+\-*/]/.test(after)?' ':'';
   const next=before+padBefore+value+padAfter+after;
   setExpression(next);setValidation(null);
   requestAnimationFrame(()=>{
     if(!daxRef.current)return;
     const p=before.length+padBefore.length+value.length;
     daxRef.current.focus();daxRef.current.setSelectionRange(p,p);setDaxCursor(p);
   });
 };

  const insertSuggestionIntoDax=(s:Suggestion)=>{
    const el=daxRef.current;
    const cursor=el?.selectionStart ?? daxCursor ?? expression.length;
    const left=expression.slice(0,cursor);
    const token=tokenAtCursor(expression,cursor);
    let tokenStart=cursor-token.length;
    const bracket=left.match(/\[([^\]]*)$/);
    if(bracket) {
      const tableMatch = left.match(/([A-Za-z0-9_]+)?\s*\[([^\]]*)$/);
      if (tableMatch) {
         tokenStart = cursor - tableMatch[0].length;
      } else {
         tokenStart = cursor - bracket[0].length;
      }
    } else {
      const m=left.match(/([A-Za-z0-9_]+)$/);
      if(m) tokenStart = cursor - m[0].length;
    }
    const next=expression.slice(0,tokenStart)+s.insert+expression.slice(cursor);
    setExpression(next);
    setDaxFocus(false);
    requestAnimationFrame(()=>{
      if(!daxRef.current)return;
      let p=tokenStart+s.insert.length;
      if (s.kind === 'function') p -= 2;
      daxRef.current.focus();daxRef.current.setSelectionRange(p,p);setDaxCursor(p);
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

 const newMeasure=()=>{
   setSelected('');
   setName('New_Measure');
   setExpression('');
   setValidation(null);
   setAi(null);
   setAiMode('new');
 };

 const validate=async()=>{
   setBusy(true);
   try{
     setValidation(await api('/measures/validate',{method:'POST',body:JSON.stringify({name,expression})}));
   }catch(e:any){setValidation({valid:false,error:e.message})}
   finally{setBusy(false)}
 };

 const save=async()=>{
   if(!name.trim()){setValidation({valid:false,error:'Enter a measure name before saving.'});return}
   if(!expression.trim()){setValidation({valid:false,error:'Enter a DAX expression before saving.'});return}
   setBusy(true);
   try{
     const r=await api<any>('/measures/save',{method:'POST',body:JSON.stringify({name,expression,originalName:aiMode==='new'?null:(selected||null)})});
     replaceProject(r.project);
     setSelected(name);
     setValidation({valid:true,compiled:r.compiled,engine:'VTAB DAX',message:r.renamed?`Measure renamed and dependent references updated from ${r.originalName} to ${r.name}.`:`Measure saved successfully. ${Object.keys(r.project?.model?.measures||{}).length} measures are retained in this semantic model.`});
   }catch(e:any){setValidation({valid:false,error:e.message})}
   finally{setBusy(false)}
 };

 const generate=async(mode:'new'|'edit'='new')=>{
   setBusy(true);
   try{
     const r=await api<any>('/measures/ai-generate',{method:'POST',body:JSON.stringify({prompt})});
     // AI generation is CREATE by default. Previously the selected measure remained active,
     // so saving a newly generated measure renamed/replaced the selected measure.
     if(mode==='new')setSelected('');
     setAiMode(mode);setAi(r);setName(mode==='edit'&&selected?selected:r.name);setExpression(r.expression);
     setValidation(r.valid?{valid:true,compiled:r.compiled,engine:'VTAB DAX',message:mode==='new'?'AI generated a new measure. Existing measures will be preserved.':'AI generated a replacement expression for the selected measure.'}:{valid:false,error:r.validationError});
   }catch(e:any){setAi({error:e.message})}
   finally{setBusy(false)}
 };

 const remove=async()=>{
   if(!selected||!confirm(`Delete measure ${selected}?`))return;
   const p=structuredClone(project);
   delete p.model.measures[selected];
   replaceProject(p);
   await api('/project',{method:'PUT',body:JSON.stringify(p)});
   newMeasure();
 };

 return <div className={'measuresWorkspace modelAwareMeasures professionalMeasures '+(!fieldsVisible?'measureFieldsHidden ':'')+(!aiVisible?'measureAiHidden':'')}>
   {fieldsVisible&&<aside className="measureModelPane">
     <div className="measureListHead">
       <div><small>SEMANTIC MODEL</small><b>Fields & Measures</b></div>
       <div className="paneHeaderActions"><button onClick={newMeasure}><Plus size={15}/>New</button><button className="icon" onClick={()=>setFieldsVisible(false)} title="Hide fields pane"><PanelLeftClose size={15}/></button></div>
     </div>
     <div className="modelFieldSearch"><Search size={13}/><input placeholder="Search tables or columns" value={fieldSearch} onChange={e=>setFieldSearch(e.target.value)}/></div>

     <div className="semanticTree">
       {filteredTables.map(([table,t])=><details key={table} open>
         <summary><Table2 size={13}/><b>{table}</b><small>{Object.keys(t.columns||{}).length}</small></summary>
         {(project.model.hierarchies||[]).filter((h:any)=>h.table===table).map((h:any)=>
           <button key={h.id} className="treeHierarchy" title="Hierarchy"><GitBranch size={12}/><span>{h.name}</span><small>{h.levels?.length||0} levels</small></button>
         )}
         {Object.keys(t.columns||{}).map((col:string)=>{
           const dtype=project.model.columnTypes?.[`${table}.${col}`]||'';
           return <button key={col} className="treeField" onClick={()=>insertIntoDax(`${table}[${col}]`)} title={`Insert ${table}[${col}] into DAX`}>
             <span className="dtypeGlyph">{dtype==='date'||dtype==='datetime'?'📅':/(int|decimal|currency|number)/i.test(dtype)?'#':'Ab'}</span>
             <span>{col}</span><small>{dtype||'column'}</small>
           </button>
         })}
       </details>)}
       {!filteredTables.length&&<div className="semanticEmpty"><Table2/><b>No model tables</b><span>Close & Apply transformed data into Model first.</span></div>}

       <details open>
         <summary><Calculator size={13}/><b>Measures</b><small>{names.length}</small></summary>
         {names.map(measure=><button key={measure} title="Click to edit · Double-click to insert reference" className={'treeMeasure '+(selected===measure?'active':'')} onClick={()=>{setSelected(measure);setAiMode('edit')}} onDoubleClick={()=>insertIntoDax(`[${measure}]`)}>
           <FunctionSquare size={12}/><span>{measure}</span><Pencil size={11}/>
         </button>)}
       </details>
     </div>
   </aside>}

   <section className="measureEditorPro">
     <div className="measureTopbar">
       <div><span className="eyebrow">VTAB DAX MEASURE ENGINE</span><h2>{selected?'Edit Measure':'Create Measure'}</h2><p>Click a semantic field on the left to insert its exact DAX reference.</p></div>
       <div className="measureActions">
         {!fieldsVisible&&<button onClick={()=>setFieldsVisible(true)}><PanelLeftOpen size={15}/>Fields</button>}{!aiVisible&&<button onClick={()=>setAiVisible(true)}><PanelRightOpen size={15}/>AI Builder</button>}
         <button disabled={busy||!expression.trim()} onClick={validate}><CheckCircle2 size={15}/>Validate</button>
         <button disabled={busy||!expression.trim()} className="primary" onClick={save}><Save size={15}/>{selected?'Save Changes':'Save Measure'}</button>
         {selected&&<button title="Cancel editing" onClick={newMeasure}><X size={15}/>Cancel Edit</button>}
         {selected&&<button className="dangerBtn" title="Delete measure" onClick={remove}><Trash2 size={15}/></button>}
       </div>
     </div>

     <div className="daxNameRow">
       <label>Measure name<input value={name} onChange={e=>setName(e.target.value.replace(/\s+/g,'_'))}/></label>
       <div className="enginePill"><Braces size={14}/>VTAB DAX</div>
     </div>

     {selected&&<div className="editingObjectBanner measureEditingBanner"><Pencil size={14}/><div><b>Editing existing measure: {selected}</b><span>{name!==selected?`Renaming to ${name}. Dependent measure and report visual references will be updated on Save Changes.`:'Changes will update this measure in place.'}</span></div></div>}

      <div style={{position:'relative'}}>
        <div className="daxEditorShell">
          <div className="daxLineNumbers">{Array.from({length:Math.max(14,expression.split('\n').length)},(_,i)=><span key={i}>{i+1}</span>)}</div>
          <textarea ref={daxRef} value={expression}
            onFocus={e=>{setDaxFocus(true);setDaxCursor(e.currentTarget.selectionStart)}}
            onBlur={()=>setTimeout(()=>setDaxFocus(false),160)}
            onSelect={e=>setDaxCursor((e.target as HTMLTextAreaElement).selectionStart)}
            onChange={e=>{setExpression(e.target.value);setDaxCursor(e.target.selectionStart);setDaxFocus(true);setValidation(null)}}
            onKeyDown={e=>{
              if(!daxSuggestions.length)return;
              if(e.key==='ArrowDown'){e.preventDefault();setDaxSuggestionIndex(i=>(i+1)%daxSuggestions.length)}
              else if(e.key==='ArrowUp'){e.preventDefault();setDaxSuggestionIndex(i=>(i-1+daxSuggestions.length)%daxSuggestions.length)}
              else if(e.key==='Enter'&&daxFocus){e.preventDefault();insertSuggestionIntoDax(daxSuggestions[daxSuggestionIndex]||daxSuggestions[0])}
              else if(e.key==='Escape'){setDaxFocus(false)}
            }}
            spellCheck={false} placeholder={'Revenue =\nSUM ( Sales[Revenue] )'}/>
        </div>
        {!!daxSuggestions.length&&<div className="promptSuggestions">
          {daxSuggestions.map((s,i)=><button className={i===daxSuggestionIndex?'active':''} key={`${s.kind}-${s.insert}-${i}`} onMouseEnter={()=>setDaxSuggestionIndex(i)} onMouseDown={e=>{e.preventDefault();insertSuggestionIntoDax(s)}}>
            <span className={'suggestIcon '+s.kind}>{s.kind==='field'?'ƒ':s.kind==='measure'?'∑':s.kind==='hierarchy'?'⑂':s.kind==='function'?'𝑓':'▦'}</span>
            <div><b>{s.label}</b><small>{s.detail}</small></div>
            <code>{s.insert}</code>
          </button>)}
        </div>}
      </div>

     {validation&&<div role="status" aria-live="polite" className={'daxValidation '+(validation.valid?'ok':'bad')}>
       {validation.valid?<><CheckCircle2/><div><b>{validation.message||'Measure is valid'}</b><code>{validation.compiled}</code></div></>:<><AlertTriangle/><div><b>Validation failed</b><span>{validation.error}</span></div></>}
     </div>}

     <div className="daxFunctionBar expandedFunctions"><span>Supported:</span><b>VAR</b><b>RETURN</b><b>CALCULATE</b><b>SUM</b><b>AVERAGE</b><b>MIN</b><b>MAX</b><b>COUNT</b><b>COUNTROWS</b><b>DISTINCTCOUNT</b><b>MEDIAN</b><b>SUMX</b><b>AVERAGEX</b><b>MINX</b><b>MAXX</b><b>DIVIDE</b><b>SELECTEDVALUE</b><b>COALESCE</b><b>ABS</b><b>ROUND</b><b>INT</b><b>FLOOR</b><b>CEILING</b><b>LEN</b><b>EDATE</b><b>EOMONTH</b><b>DATESBETWEEN</b><b>DATESINPERIOD</b><b>SAMEPERIODLASTYEAR</b><b>TOTALYTD</b><b>TOTALMTD</b><b>TOTALQTD</b><b>REMOVEFILTERS</b><b>ALL</b><b>KEEPFILTERS</b><b>FILTER</b><b>SWITCH</b><b>IF</b><b>ISBLANK</b><b>BLANK</b><b>AND / OR / NOT</b><b>IN</b><b>DATE</b><b>YEAR</b><b>MONTH</b><b>DAY</b><b>POWER</b><b>SQRT</b></div>
   </section>

   {aiVisible&&<aside className="aiMeasurePane">
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
   </aside>}
 </div>;
}
