import type {NumberFormat} from './types';

export const CURRENCIES=[
  {code:'USD',label:'US Dollar',symbol:'$'},
  {code:'INR',label:'Indian Rupee',symbol:'₹'},
  {code:'EUR',label:'Euro',symbol:'€'},
  {code:'GBP',label:'British Pound',symbol:'£'},
  {code:'JPY',label:'Japanese Yen',symbol:'¥'},
  {code:'AUD',label:'Australian Dollar',symbol:'A$'},
  {code:'CAD',label:'Canadian Dollar',symbol:'C$'},
  {code:'SGD',label:'Singapore Dollar',symbol:'S$'},
  {code:'AED',label:'UAE Dirham',symbol:'د.إ'},
];

export const DEFAULT_NUMBER_FORMAT:NumberFormat={
  style:'number',currency:'USD',decimals:2,displayUnits:'auto',thousandsSeparator:true,negativeStyle:'minus',prefix:'',suffix:''
};

function resolveUnit(n:number,unit:NumberFormat['displayUnits']){
  const a=Math.abs(n);
  if(unit==='thousand')return {div:1e3,suffix:'K'};
  if(unit==='million')return {div:1e6,suffix:'M'};
  if(unit==='billion')return {div:1e9,suffix:'B'};
  if(unit==='trillion')return {div:1e12,suffix:'T'};
  if(unit==='auto'){
    if(a>=1e12)return {div:1e12,suffix:'T'};
    if(a>=1e9)return {div:1e9,suffix:'B'};
    if(a>=1e6)return {div:1e6,suffix:'M'};
    if(a>=1e3)return {div:1e3,suffix:'K'};
  }
  return {div:1,suffix:''};
}

export function formatNumber(value:any,raw?:NumberFormat){
  if(value===null||value===undefined||value==='')return '—';
  const num=Number(value);if(!Number.isFinite(num))return String(value);
  const f={...DEFAULT_NUMBER_FORMAT,...(raw||{})};
  let n=num;
  if(f.style==='percentage')n=num*100;
  const u=resolveUnit(n,f.displayUnits);
  const scaled=Math.abs(n/u.div);
  const decimals=Math.max(0,Math.min(8,Number(f.decimals??2)));
  const rendered=scaled.toLocaleString(undefined,{minimumFractionDigits:decimals,maximumFractionDigits:decimals,useGrouping:f.thousandsSeparator!==false});
  const currency=f.style==='currency'?(CURRENCIES.find(c=>c.code===f.currency)?.symbol||f.currency||'$'):'';
  const pct=f.style==='percentage'?'%':'';
  const text=`${f.prefix||''}${currency}${rendered}${u.suffix}${pct}${f.suffix||''}`;
  return n<0?(f.negativeStyle==='parentheses'?`(${text})`:`-${text}`):text;
}

export function formatForField(value:any,field:string|undefined,formats?:Record<string,NumberFormat>){
  const dateFormat=field?formats?.[field]?.dateFormat:undefined;
  if(dateFormat&&dateFormat!=='default'&&value!==null&&value!==undefined&&value!==''){
    const parsed=value instanceof Date?value:new Date(value);
    if(!Number.isNaN(parsed.getTime())){
      const dd=String(parsed.getDate()).padStart(2,'0'),mm=String(parsed.getMonth()+1).padStart(2,'0'),yyyy=String(parsed.getFullYear());
      if(dateFormat==='dd/MM/yyyy')return `${dd}/${mm}/${yyyy}`;
      if(dateFormat==='MM/dd/yyyy')return `${mm}/${dd}/${yyyy}`;
      if(dateFormat==='yyyy-MM-dd')return `${yyyy}-${mm}-${dd}`;
      if(dateFormat==='dd MMM yyyy')return parsed.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'});
    }
  }
  return formatNumber(value,field?formats?.[field]:undefined);
}
