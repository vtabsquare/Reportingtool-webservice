import type {Visual,VisualSort} from './types';
import {compareCalendarValues,isCalendarField} from './calendarSorting';

export type ModelSortDefinition={sortByField?:string;defaultDirection?:'asc'|'desc';validationStatus?:'valid'|'invalid';validationMessage?:string};
export type SortCriterion={field:string;keyField:string;direction:'asc'|'desc';source:'visual'|'model'|'semantic'};

const coreField=(field:string)=>field.split('::')[0];
const tableOf=(field:string)=>coreField(field).split('.').slice(0,-1).join('.');
const numericType=/^(u?int\d*|integer|bigint|smallint|tinyint|float\d*|double|double precision|decimal|numeric|number|real|money|currency)$/i;
const dateType=/^(date|datetime|timestamp|timestamp with time zone|timestamp without time zone)$/i;

export function modelSortDefinitions(model:any):Record<string,ModelSortDefinition>{return model?.sortByColumns||{}}

export function validateSortDefinition(model:any,field:string,sortByField:string){
  if(!field||!sortByField)return{valid:true,message:''};
  if(field===sortByField)return{valid:false,message:'A field cannot sort by itself.'};
  if(tableOf(field)!==tableOf(sortByField))return{valid:false,message:'Sort by Column must use a field from the same table.'};
  const columns=model?.tables?.[tableOf(field)]?.columns||{};
  if(!Object.prototype.hasOwnProperty.call(columns,coreField(sortByField).slice(tableOf(sortByField).length+1)))return{valid:false,message:'The selected sort field is no longer available.'};
  const definitions=modelSortDefinitions(model);let cursor=sortByField;const seen=new Set([field]);
  while(cursor){if(seen.has(cursor))return{valid:false,message:'Circular Sort by Column definitions are not allowed.'};seen.add(cursor);cursor=definitions[cursor]?.sortByField||''}
  return{valid:true,message:'Valid model-level sort definition.'};
}

export function collectModelSortKeyFields(fields:string[],model:any){
  const definitions=modelSortDefinitions(model),result:string[]=[];
  for(const field of fields){const definition=definitions[coreField(field)]||definitions[field];if(definition?.validationStatus!=='invalid'&&definition?.sortByField&&!result.includes(definition.sortByField))result.push(definition.sortByField)}
  return result;
}

export function resolveSortCriteria(visual:Pick<Visual,'sort'>,model:any,categoryFields:string[]):SortCriterion[]{
  const definitions=modelSortDefinitions(model);
  if(visual.sort?.length)return visual.sort.map(item=>{const definition=definitions[coreField(item.field)]||definitions[item.field];return{field:item.field,keyField:definition?.validationStatus!=='invalid'&&definition?.sortByField?definition.sortByField:item.field,direction:item.direction,source:'visual' as const}});
  return categoryFields.filter(Boolean).map(field=>{const definition=definitions[coreField(field)]||definitions[field];return{field,keyField:definition?.validationStatus!=='invalid'&&definition?.sortByField?definition.sortByField:field,direction:definition?.defaultDirection||'asc',source:definition?.sortByField?'model' as const:'semantic' as const}});
}

function compareBlank(a:any,b:any){const aBlank=a===null||a===undefined||a==='',bBlank=b===null||b===undefined||b==='';return aBlank===bBlank?0:aBlank?1:-1}

export function compareFieldValues(field:string,a:any,b:any,model:any){
  const blank=compareBlank(a,b);if(blank)return blank;
  const type=String(model?.columnTypes?.[coreField(field)]||'').toLowerCase();
  if(isCalendarField(field)||dateType.test(type))return compareCalendarValues(field,a,b,model?.sortingSettings?.weekStartsOn||'monday');
  if(numericType.test(type)||((typeof a==='number'||typeof b==='number')&&Number.isFinite(Number(a))&&Number.isFinite(Number(b))))return Number(a)-Number(b);
  if(type==='boolean'||typeof a==='boolean'||typeof b==='boolean')return Number(Boolean(a))-Number(Boolean(b));
  return String(a).localeCompare(String(b),model?.sortingSettings?.locale||undefined,{numeric:true,sensitivity:model?.sortingSettings?.caseSensitive?'case':'base'});
}

export function sortRows<T extends Record<string,any>>(rows:T[],criteria:SortCriterion[],model:any){
  if(!criteria.length)return rows;
  return rows.map((row,index)=>({row,index})).sort((left,right)=>{
    for(const criterion of criteria){
      let result=compareFieldValues(criterion.keyField,left.row[criterion.keyField],right.row[criterion.keyField],model);
      if(result===0&&criterion.keyField!==criterion.field)result=compareFieldValues(criterion.field,left.row[criterion.field],right.row[criterion.field],model);
      if(result)return criterion.direction==='desc'?-result:result;
    }
    return left.index-right.index;
  }).map(item=>item.row);
}

export function effectiveBackendSort(criteria:SortCriterion[]):VisualSort[]{return criteria.map(item=>({field:item.keyField,direction:item.direction}))}

export function sortVisualRows<T extends Record<string,any>>(rows:T[],visual:Pick<Visual,'sort'>,model:any,categoryFields:string[]){return sortRows(rows,resolveSortCriteria(visual,model,categoryFields),model)}

