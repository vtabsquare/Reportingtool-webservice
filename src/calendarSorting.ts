const MONTHS:Record<string,number>={
  jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,
  jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12
};

const fieldPart=(field:string)=>{
  const hierarchy=field.split('::').slice(-1)[0];
  return hierarchy.split('.').slice(-1)[0].replace(/[\s_-]+/g,'').toLowerCase();
};

export function isCalendarField(field:string){
  const name=fieldPart(field);
  return /^(date|datetime|year|yearmonth|monthyear|quarter|quarterno|month|monthname|monthno|monthnumber|day|dayofmonth|dayname|weekday|week|weekno|weeknumber)$/.test(name)
    || /(?:^|[^a-z])(date|year|quarter|month|day)(?:$|[^a-z])/.test(field.toLowerCase());
}

function calendarRank(field:string,value:any,weekStartsOn:'monday'|'sunday'='monday'):number|string{
  const name=fieldPart(field),raw=String(value??'').trim(),lower=raw.toLowerCase();
  if(!raw)return Number.POSITIVE_INFINITY;
  if(name.includes('month')&&!name.includes('year')){
    const month=MONTHS[lower.replace(/\./g,'')]||Number(raw.replace(/\D/g,''));
    if(Number.isFinite(month)&&month>=1&&month<=12)return month;
  }
  if(name.includes('quarter')){
    const match=/([1-4])/.exec(raw),year=/((?:19|20)\d{2})/.exec(raw);if(match)return year?Number(year[1])*4+Number(match[1]):Number(match[1]);
  }
  if(name==='dayname'||name==='weekday'){
    const days=weekStartsOn==='sunday'?['sunday','monday','tuesday','wednesday','thursday','friday','saturday']:['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const index=days.findIndex(day=>lower===day||lower===day.slice(0,3));if(index>=0)return index+1;
  }
  if(name==='yearmonth'||name==='monthyear'){
    const year=/((?:19|20)\d{2})/.exec(raw),monthName=Object.entries(MONTHS).find(([label])=>new RegExp(`\\b${label}\\b`,'i').test(raw))?.[1],numericMonth=/((?:19|20)\d{2})[-/](\d{1,2})/.exec(raw)?.[2]||/(\d{1,2})[-/]((?:19|20)\d{2})/.exec(raw)?.[1];
    const month=monthName||Number(numericMonth);if(year&&month>=1&&month<=12)return Number(year[1])*12+month;
  }
  if(['year','monthno','monthnumber','day','dayofmonth','week','weekno','weeknumber'].includes(name)){
    const numeric=Number(raw.replace(/[^0-9.-]/g,''));if(Number.isFinite(numeric))return numeric;
  }
  if(name.includes('date')||/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(raw)){
    const timestamp=Date.parse(raw);if(Number.isFinite(timestamp))return timestamp;
  }
  const numeric=Number(raw);if(Number.isFinite(numeric))return numeric;
  return lower;
}

export function compareCalendarValues(field:string,a:any,b:any,weekStartsOn:'monday'|'sunday'='monday'){
  const left=calendarRank(field,a,weekStartsOn),right=calendarRank(field,b,weekStartsOn);
  if(typeof left==='number'&&typeof right==='number')return left-right;
  return String(left).localeCompare(String(right),undefined,{numeric:true,sensitivity:'base'});
}

export function sortCalendarRows<T extends Record<string,any>>(rows:T[],fields:string[]){
  const calendarFields=fields.filter(isCalendarField);if(!calendarFields.length)return rows;
  return [...rows].sort((a,b)=>{for(const field of calendarFields){const result=compareCalendarValues(field,a[field],b[field]);if(result)return result}return 0});
}

