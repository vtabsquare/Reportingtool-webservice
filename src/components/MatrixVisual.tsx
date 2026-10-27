import {useEffect,useMemo,useRef,useState} from 'react';
import {ChevronDown,ChevronRight,ChevronsDown,ChevronsUp} from 'lucide-react';
import {formatForField} from '../formatting';
import type {TableConditionalRule,Visual} from '../types';
import {resolveTableFieldValueColor} from '../conditionalFormatting';
import {compareFieldValues,modelSortDefinitions} from '../sortingEngine';
import './matrixVisual.css';

type Node={id:string;label:string;field:string;value:any;level:number;path:Array<{field:string;value:any;label:string}>;rows:any[];children:Node[]};
type VisibleRow={id:string;node:Node;kind:'group'|'leaf'|'subtotal';depth:number};
const text=(value:any)=>value===null||value===undefined||String(value).trim()===''?'(Blank)':String(value);
const fieldLabel=(field:string,visual:Visual)=>visual.format.fieldDisplayNames?.[field]||field.replace(/^.*\./,'').replace(/::.*$/,'').replace(/_/g,' ');
const pathId=(parts:Array<{field:string;value:any}>)=>parts.map(part=>`${part.field}:${String(part.value??'')}`).join('\u001f');

export function buildMatrixHierarchy(rows:any[],fields:string[],level=0,path:Array<{field:string;value:any;label:string}>=[],model:any={}):Node[]{
  if(level>=fields.length)return[];
  const field=fields[level],groups=new Map<string,{value:any;rows:any[]}>();
  rows.forEach(row=>{const value=row[field],key=JSON.stringify(value??null),group=groups.get(key)||{value,rows:[]};group.rows.push(row);groups.set(key,group)});
  const definition=modelSortDefinitions(model)[field.split('::')[0]];
  const compareGroups=(a:any,b:any)=>{const sortField=definition?.sortByField;const av=sortField?a.rows[0]?.[sortField]:a.value;const bv=sortField?b.rows[0]?.[sortField]:b.value;const result=compareFieldValues(sortField||field,av,bv,model);return definition?.defaultDirection==='desc'?-result:result};
  return Array.from(groups.values()).sort(compareGroups).map(group=>{const next=[...path,{field,value:group.value,label:text(group.value)}];return{id:pathId(next),label:text(group.value),field,value:group.value,level,path:next,rows:group.rows,children:buildMatrixHierarchy(group.rows,fields,level+1,next,model)}});
}

export function aggregateMatrixRows(rows:any[],field:string){
  if(!rows.length)return undefined;
  const operation=(field.split('::')[1]||'').toLowerCase(),values=rows.map(row=>row[field]).filter(value=>value!==undefined&&value!==null&&value!=='');
  if(!values.length)return undefined;
  if(operation==='count_distinct')return new Set(values.map(value=>JSON.stringify(value))).size;
  if(operation==='count')return values.reduce((sum,value)=>sum+(Number.isFinite(Number(value))?Number(value):1),0);
  const numeric=values.map(Number).filter(Number.isFinite);if(!numeric.length)return values[0];
  if(operation==='average')return numeric.reduce((sum,value)=>sum+value,0)/numeric.length;
  if(operation==='min')return Math.min(...numeric);
  if(operation==='max')return Math.max(...numeric);
  return numeric.reduce((sum,value)=>sum+value,0);
}

const matchesPath=(row:any,path:Node['path'])=>path.every(part=>String(row[part.field]??'')===String(part.value??''));
function collectIds(nodes:Node[]){const ids:string[]=[];const visit=(node:Node)=>{if(node.children.length)ids.push(node.id);node.children.forEach(visit)};nodes.forEach(visit);return ids}
export function flattenMatrixRows(nodes:Node[],expanded:Set<string>,subtotals:boolean,position:'top'|'bottom'){
  const result:VisibleRow[]=[];
  const visit=(node:Node)=>{
    const group=node.children.length>0,isOpen=expanded.has(node.id);
    if(!group){result.push({id:node.id,node,kind:'leaf',depth:node.level});return}
    if(position==='top'||!isOpen)result.push({id:`${node.id}:group`,node,kind:'group',depth:node.level});
    if(isOpen)node.children.forEach(visit);
    if(position==='bottom'&&isOpen&&subtotals)result.push({id:`${node.id}:subtotal`,node,kind:'subtotal',depth:node.level});
  };
  nodes.forEach(visit);return result;
}
export function matrixColumnLeaves(nodes:Node[],expanded:Set<string>,includeSubtotals=false):Node[]{const result:Node[]=[];const visit=(node:Node)=>{if(node.children.length&&expanded.has(node.id)){node.children.forEach(visit);if(includeSubtotals)result.push({...node,id:`${node.id}:subtotal`,label:`${node.label} Total`})}else result.push(node)};nodes.forEach(visit);return result}

function conditionalStyle(rule:TableConditionalRule|undefined,value:any,conditionalValues:Record<string,any>){
  if(!rule?.enabled)return{};
  if(rule.formatBy==='fieldValue'){
    const color=resolveTableFieldValueColor(rule,conditionalValues);if(!color)return{};
    if(rule.applyTo==='text')return{color};
    return rule.applyTo==='both'?{backgroundColor:color,color:'#0f172a'}:{backgroundColor:color};
  }
  const numeric=Number(value);if(!Number.isFinite(numeric))return{};
  const min=rule.min??0,max=rule.max??100,ratio=Math.max(0,Math.min(1,max===min?.5:(numeric-min)/(max-min)));
  const parse=(color:string)=>{const clean=color.replace('#','');const full=clean.length===3?clean.split('').map(char=>char+char).join(''):clean;return[0,2,4].map(index=>parseInt(full.slice(index,index+2),16)||0)};
  const mix=(a:string,b:string,t:number)=>{const x=parse(a),y=parse(b);return`rgb(${x.map((value,index)=>Math.round(value+(y[index]-value)*t)).join(',')})`};
  const color=rule.midColor?(ratio<=.5?mix(rule.minColor||'#ffffff',rule.midColor,ratio*2):mix(rule.midColor,rule.maxColor||'#118dff',(ratio-.5)*2)):mix(rule.minColor||'#ffffff',rule.maxColor||'#118dff',ratio);
  return rule.applyTo==='text'?{color}:rule.applyTo==='both'?{backgroundColor:color,color:ratio>.55?'#ffffff':'#0f172a'}:{backgroundColor:color};
}

export default function MatrixVisual({rows,visual,formats,model={},conditionalValues={},onPointClick}:{rows:any[];visual:Visual;formats:any;model?:any;conditionalValues?:Record<string,any>;onPointClick?:(field:string,value:any)=>void}){
  const rowFields=visual.bindings.axis||[],columnFields=visual.bindings.legend||[],values=visual.bindings.values||[],signature=`${rowFields.join('|')}::${columnFields.join('|')}`;
  const rowTree=useMemo(()=>buildMatrixHierarchy(rows,rowFields,0,[],model),[rows,signature,model?.sortByColumns,model?.sortingSettings]),columnTree=useMemo(()=>buildMatrixHierarchy(rows,columnFields,0,[],model),[rows,signature,model?.sortByColumns,model?.sortingSettings]);
  const defaultExpanded=visual.format.matrixDefaultExpanded!==false;
  const[rowExpanded,setRowExpanded]=useState<Set<string>>(()=>new Set()),[columnExpanded,setColumnExpanded]=useState<Set<string>>(()=>new Set()),[scrollTop,setScrollTop]=useState(0);
  useEffect(()=>{setRowExpanded(new Set(defaultExpanded?collectIds(rowTree):[]));setColumnExpanded(new Set(defaultExpanded?collectIds(columnTree):[]))},[signature,rows,defaultExpanded]);
  const subtotalPosition=visual.format.matrixSubtotalPosition||'top',allRows=useMemo(()=>flattenMatrixRows(rowTree,rowExpanded,visual.format.matrixRowSubtotals!==false,subtotalPosition),[rowTree,rowExpanded,visual.format.matrixRowSubtotals,subtotalPosition]);
  const columns=useMemo(()=>columnFields.length?matrixColumnLeaves(columnTree,columnExpanded,visual.format.matrixColumnSubtotals!==false):[{id:'__all__',label:'',field:'',value:undefined,level:0,path:[],rows,children:[]} as Node],[columnTree,columnExpanded,columnFields.length,rows,visual.format.matrixColumnSubtotals]);
  const showTotalColumn=columnFields.length>0&&visual.format.matrixColumnGrandTotal!==false;
  const layout=visual.format.matrixLayout||'compact',rowHeaderCount=layout==='compact'?1:Math.max(1,rowFields.length),rowHeight=Math.max(24,(visual.format.matrixRowPadding??6)*2+(visual.format.tableFontSize||11)+4),viewport=420,start=Math.max(0,Math.floor(scrollTop/rowHeight)-10),end=Math.min(allRows.length,start+Math.ceil(viewport/rowHeight)+20),renderRows=allRows.slice(start,end);
  const toggle=(setter:React.Dispatch<React.SetStateAction<Set<string>>>,id:string)=>setter(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next});
  const css:any={'--mx-font':visual.format.tableFontFamily||'Segoe UI','--mx-size':`${visual.format.tableFontSize||11}px`,'--mx-text':visual.format.tableTextColor||'#242424','--mx-bg':visual.format.tableBackground||'#fff','--mx-alt':visual.format.tableAlternateColor||'#f8fafc','--mx-head-bg':visual.format.tableHeaderBackground||'#f1f5f9','--mx-head-text':visual.format.tableHeaderColor||'#0f172a','--mx-grid':visual.format.tableGridColor||'#e2e8f0','--mx-grid-width':`${visual.format.tableGridWidth??1}px`,'--mx-total-bg':visual.format.matrixGrandTotalBackground||visual.format.tableTotalBackground||'#e8eef7','--mx-total-text':visual.format.matrixGrandTotalTextColor||visual.format.tableTotalTextColor||'#0f172a','--mx-subtotal-bg':visual.format.matrixSubtotalBackground||'#f8fafc','--mx-indent':`${visual.format.matrixIndentSize??16}px`,'--mx-column-width':`${visual.format.tableColumnWidth||110}px`};
  const renderValue=(source:any[],field:string,column:Node)=>{const cellRows=column.path.length?source.filter(row=>matchesPath(row,column.path)):source,value=aggregateMatrixRows(cellRows,field),title=[...column.path.map(part=>`${fieldLabel(part.field,visual)}: ${part.label}`),`${fieldLabel(field,visual)}: ${value===undefined?'Blank':formatForField(value,field,formats)}`].join('\n');return{value,content:value===undefined?(visual.format.matrixBlankAsZero?formatForField(0,field,formats):''):formatForField(value,field,formats),title}};
  const headerGroups=(level:number)=>{const groups:Array<{key:string;label:string;node?:Node;span:number}>=[];columns.forEach(column=>{const part=column.path[level],key=part?pathId(column.path.slice(0,level+1)):`${column.id}:blank:${level}`,last=groups[groups.length-1];if(last&&last.key===key)last.span+=values.length||1;else groups.push({key,label:part?.label||'',node:part?column.path.length>level?column:undefined:undefined,span:values.length||1})});return groups};
  const headerNode=(column:Node,level:number)=>{let nodes=columnTree;for(let index=0;index<=level;index++){const part=column.path[index],found=nodes.find(node=>node.field===part?.field&&String(node.value??'')===String(part?.value??''));if(!found)return undefined;if(index===level)return found;nodes=found.children}return undefined};
  return <div className={`powerMatrix layout-${layout}${visual.format.matrixFreezeRowHeaders!==false?' freeze-rows':''}`} style={css}>
    <div className="powerMatrixToolbar"><button onClick={()=>setRowExpanded(new Set(collectIds(rowTree)))} title="Expand all rows"><ChevronsDown size={13}/>Expand rows</button><button onClick={()=>setRowExpanded(new Set())} title="Collapse all rows"><ChevronsUp size={13}/>Collapse rows</button>{columnFields.length>1&&<><button onClick={()=>setColumnExpanded(new Set(collectIds(columnTree)))} title="Expand all columns">Expand columns</button><button onClick={()=>setColumnExpanded(new Set())} title="Collapse all columns">Collapse columns</button></>}</div>
    <div className="powerMatrixScroll" onScroll={event=>setScrollTop(event.currentTarget.scrollTop)}>
      <table>{visual.format.tableHeaderVisible!==false&&<thead>
        {columnFields.map((_,level)=><tr key={`column-level-${level}`}><th className="matrixCorner" colSpan={rowHeaderCount} rowSpan={columnFields.length+1}>{layout==='compact'?'Rows':rowFields.map(field=>fieldLabel(field,visual)).join(' / ')}</th>{headerGroups(level).map(group=>{const node=columns.map(column=>headerNode(column,level)).find(item=>item?.id===group.key);return <th key={group.key} colSpan={group.span}>{node?.children.length&&visual.format.matrixColumnExpandIcons!==false?<button className="matrixExpand" onClick={()=>toggle(setColumnExpanded,node.id)}>{columnExpanded.has(node.id)?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button>:null}{group.label}</th>})}{showTotalColumn&&level===0&&<th rowSpan={columnFields.length+1} colSpan={Math.max(1,values.length)}>{visual.format.matrixColumnGrandTotalLabel||'Total'}</th>}</tr>)}
        <tr>{!columnFields.length&&<th className="matrixCorner" colSpan={rowHeaderCount}>{layout==='compact'?'Rows':rowFields.map(field=>fieldLabel(field,visual)).join(' / ')}</th>}{columns.flatMap(column=>values.map(field=><th key={`${column.id}:${field}`}>{fieldLabel(field,visual)}</th>))}{showTotalColumn&&values.map(field=><th key={`total:${field}`}>{fieldLabel(field,visual)}</th>)}</tr>
      </thead>}<tbody>
        {start>0&&<tr className="matrixSpacer"><td colSpan={rowHeaderCount+columns.length*Math.max(1,values.length)+(showTotalColumn?Math.max(1,values.length):0)} style={{height:start*rowHeight}}/></tr>}
        {renderRows.map((item,rowIndex)=>{const group=item.node.children.length>0,isOpen=rowExpanded.has(item.node.id),subtotal=item.kind==='subtotal'||(item.kind==='group'&&group),rowClass=`${subtotal?' matrixSubtotal':''}${(start+rowIndex)%2?' alternate':''}`;return <tr key={item.id} className={rowClass} style={{height:rowHeight}}>
          {layout==='compact'?<th className="matrixRowHeader" onClick={()=>onPointClick?.(item.node.field,item.node.value)}><span style={{paddingLeft:`calc(${item.depth} * var(--mx-indent))`}}>{group&&visual.format.matrixExpandIcons!==false?<button className="matrixExpand" onClick={event=>{event.stopPropagation();toggle(setRowExpanded,item.node.id)}}>{isOpen?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button>:<i className="matrixLeafIndent"/>}{item.kind==='subtotal'?`${item.node.label} ${visual.format.matrixSubtotalLabel||'Total'}`:item.node.label}</span></th>:rowFields.map((field,index)=>{const part=item.node.path[index];return <th key={field} className="matrixRowHeader" onClick={()=>part&&onPointClick?.(part.field,part.value)}>{part?(index===item.node.level&&group&&visual.format.matrixExpandIcons!==false?<><button className="matrixExpand" onClick={event=>{event.stopPropagation();toggle(setRowExpanded,item.node.id)}}>{isOpen?<ChevronDown size={12}/>:<ChevronRight size={12}/>}</button>{part.label}</>:part.label):''}</th>})}
          {columns.flatMap(column=>values.map(field=>{const cell=renderValue(item.node.rows,field,column);return <td key={`${column.id}:${field}`} title={cell.title} style={conditionalStyle(visual.format.tableConditionalRules?.[field],cell.value,conditionalValues)} onClick={()=>onPointClick?.(item.node.field,item.node.value)}>{cell.content}</td>}))}
          {showTotalColumn&&values.map(field=>{const cell=renderValue(item.node.rows,field,{...columns[0],path:[]});return <td key={`total:${field}`} className="matrixTotalColumn" title={cell.title} style={conditionalStyle(visual.format.tableConditionalRules?.[field],cell.value,conditionalValues)}>{cell.content}</td>})}
        </tr>})}
        {end<allRows.length&&<tr className="matrixSpacer"><td colSpan={rowHeaderCount+columns.length*Math.max(1,values.length)+(showTotalColumn?Math.max(1,values.length):0)} style={{height:(allRows.length-end)*rowHeight}}/></tr>}
      </tbody>{visual.format.matrixRowGrandTotal!==false&&<tfoot><tr><th colSpan={rowHeaderCount}>{visual.format.matrixRowGrandTotalLabel||'Grand total'}</th>{columns.flatMap(column=>values.map(field=>{const cell=renderValue(rows,field,column);return <th key={`${column.id}:${field}`} style={conditionalStyle(visual.format.tableConditionalRules?.[field],cell.value,conditionalValues)}>{cell.content}</th>}))}{showTotalColumn&&values.map(field=>{const cell=renderValue(rows,field,{...columns[0],path:[]});return <th key={`grand:${field}`} style={conditionalStyle(visual.format.tableConditionalRules?.[field],cell.value,conditionalValues)}>{cell.content}</th>})}</tr></tfoot>}</table>
    </div>
  </div>;
}

