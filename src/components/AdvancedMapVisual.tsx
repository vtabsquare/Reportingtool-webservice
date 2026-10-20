import {useEffect,useMemo,useRef,useState} from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import {LocateFixed,Minus,Plus,RotateCcw,TriangleAlert} from 'lucide-react';
import type {Visual} from '../types';
import {formatMapTooltip,mapGeometryBounds,prepareMapData,resolveWorldFeatureName} from '../mapEngine';
import {formatForField} from '../formatting';
import '../mapVisual.css';

const registeredMaps=new Set<string>();
function ensureMap(name:string,geoJson:any){
  if(registeredMaps.has(name))return;
  echarts.registerMap(name,geoJson as any);registeredMaps.add(name);
}
const escapeHtml=(value:any)=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]||char));
const tooltipHtml=(entries:[string,any][],title?:string,formatValue?:(value:any,field:string)=>string)=>{
  const body=formatMapTooltip(entries).map(item=>`<div class="vtabMapTooltipRow"><b>${escapeHtml(item.label)}</b><span>${escapeHtml(formatValue?formatValue(item.value,item.field):item.value)}</span></div>`).join('');
  return `<div class="vtabMapTooltipHtml">${title?`<strong>${escapeHtml(title)}</strong>`:''}${body}</div>`;
};

function paddedBounds(bounds:[[number,number],[number,number]]|undefined){
  if(!bounds)return undefined;
  let minX=bounds[0][0],maxY=bounds[0][1],maxX=bounds[1][0],minY=bounds[1][1];
  if(maxX-minX<4){minX-=2;maxX+=2}if(maxY-minY<4){minY-=2;maxY+=2}
  const xPad=Math.max(1,(maxX-minX)*.12),yPad=Math.max(1,(maxY-minY)*.15);
  return[[minX-xPad,maxY+yPad],[maxX+xPad,minY-yPad]] as [[number,number],[number,number]];
}
function pointBounds(points:Array<{value:[number,number,number]}>){
  if(!points.length)return undefined;
  return paddedBounds([[Math.min(...points.map(point=>point.value[0])),Math.max(...points.map(point=>point.value[1]))],[Math.max(...points.map(point=>point.value[0])),Math.min(...points.map(point=>point.value[1]))]]);
}
function mapBounds(visual:Visual,prepared:ReturnType<typeof prepareMapData>){
  const scope=visual.format.mapGeographyScope||'auto';
  if(scope==='world')return undefined;
  if(scope==='india')return paddedBounds(mapGeometryBounds(prepared.geoJson,[resolveWorldFeatureName('India')||'India']));
  if(scope==='country'){const requested=visual.format.mapDefaultCountry||'India',resolved=resolveWorldFeatureName(requested)||requested;return paddedBounds(mapGeometryBounds(prepared.geoJson,[resolved]))}
  if(visual.format.mapAutoFit===false)return undefined;
  if(prepared.points.length)return pointBounds(prepared.points);
  return paddedBounds(mapGeometryBounds(prepared.geoJson,prepared.regions.map(region=>region.name)));
}

export default function AdvancedMapVisual({visual,rows,onPointClick}:{visual:Visual;rows:any[];onPointClick?:(field:string,value:any)=>void}){
  const chartRef=useRef<any>(null),[renderKey,setRenderKey]=useState(0),[dismissed,setDismissed]=useState(false),[zoom,setZoom]=useState(1);
  const visualSignature=JSON.stringify({bindings:visual.bindings,format:visual.format});
  const prepared=useMemo(()=>prepareMapData(visual,rows),[visualSignature,rows]);
  const mapFormats=Object.fromEntries(Array.from(new Set([...Object.keys(rows[0]||{}),...Object.keys(visual.format.fieldFormats||{})])).map(field=>[field,{displayUnits:visual.format.displayUnits||'auto',decimals:visual.format.displayUnitDecimals??2,...visual.format.fieldFormats?.[field]}]));
  const formatValue=(value:any,field:string)=>formatForField(value,field,mapFormats);
  ensureMap(prepared.mapName,prepared.geoJson);
  useEffect(()=>{ensureMap(prepared.mapName,prepared.geoJson)},[prepared.mapName,prepared.geoJson]);
  useEffect(()=>setDismissed(false),[prepared.unmatched.join('|')]);
  const mode=visual.format.mapMode==='filled'?'filled':'bubble';
  const showFilled=mode==='filled',showSymbols=mode==='bubble'&&prepared.hasPointPayload;
  const dark=visual.format.mapStyle==='dark',minimal=visual.format.mapStyle==='minimal',background=dark?'#111827':minimal?'#ffffff':'#dfeef7',land=dark?'#263447':minimal?'#f8fafc':'#f8fafc',border=visual.format.mapBorderColor||(dark?'#52657b':'#cbd5e1');
  const regionsByName=new Map(prepared.regions.map(region=>[region.name,region]));
  const geoRegions=prepared.featureNames.map(name=>{const item=regionsByName.get(name),areaColor=showFilled&&item?item.color:(visual.format.mapMissingColor||(dark?'#334155':'#e8eef4'));return{name,itemStyle:{areaColor,borderColor:border,borderWidth:visual.format.mapBorderWidth??.7,opacity:showFilled&&item?(visual.format.mapFillOpacity??78)/100:1},emphasis:{disabled:true,itemStyle:{areaColor,borderColor:border,shadowBlur:0},label:{show:false}}}});
  const bounds=mapBounds(visual,prepared),boundsSignature=JSON.stringify(bounds);
  useEffect(()=>setZoom(1),[prepared.mapName,boundsSignature,mode]);
  const series:any[]=[];
  const pointLabel=(point:(typeof prepared.points)[number])=>{const parts:string[]=[];if(visual.format.mapCountryLabels===true&&point.name)parts.push(point.name);if(visual.format.mapLabels!==false&&prepared.valueField)parts.push(formatValue(point.value[2],prepared.valueField));return parts.join('\n')};
  if(showSymbols)series.push({name:'Locations',type:'scatter',coordinateSystem:'geo',z:2,labelLayout:{hideOverlap:visual.format.mapAllowOverlap!==true},emphasis:{disabled:true,scale:false},data:prepared.points.map(point=>({name:point.name,value:point.value,symbolSize:point.radius*2,itemStyle:{color:point.color,opacity:(visual.format.mapMarkerOpacity??85)/100,borderColor:visual.format.mapBorderColor||'#fff',borderWidth:visual.format.mapBorderWidth??1},emphasis:{disabled:true,scale:false},label:{show:!!pointLabel(point),formatter:pointLabel(point),position:'bottom',distance:4,color:visual.format.mapLabelColor||(dark?'#f8fafc':'#1f2937'),fontSize:visual.format.mapLabelSize??11},__point:point}))});
  const tooltipFormatter=(params:any)=>{const point=params.data?.__point;if(point)return tooltipHtml(point.tooltip,point.name,formatValue);const region=regionsByName.get(params.name);return region?tooltipHtml(region.tooltip,region.name,formatValue):`<b>${escapeHtml(params.name||'')}</b>`};
  const geoLabel=(params:any)=>{const name=params?.name||'',region=regionsByName.get(name),parts:string[]=[];if(visual.format.mapCountryLabels===true)parts.push(name);if(visual.format.mapLabels!==false&&region?.value!==undefined&&prepared.valueField)parts.push(formatValue(region.value,prepared.valueField));return parts.join('\n')};
  const tooltipOptions={show:visual.format.tooltipEnabled!==false,trigger:'item',confine:true,backgroundColor:visual.format.tooltipBackground||'#ffffff',textStyle:{color:visual.format.tooltipColor||'#242424',fontSize:11},borderColor:'#cbd5e1',extraCssText:'box-shadow:0 8px 24px rgba(15,23,42,.18);border-radius:8px;',formatter:tooltipFormatter};
  const option={
    animation:true,backgroundColor:background,
    tooltip:tooltipOptions,
    geo:{map:prepared.mapName,roam:visual.format.mapNavigation!==false,zoom,silent:false,boundingCoords:bounds,tooltip:tooltipOptions,itemStyle:{areaColor:land,borderColor:border,borderWidth:visual.format.mapBorderWidth??.7},emphasis:{disabled:true,label:{show:false},itemStyle:{areaColor:land,borderColor:border,shadowBlur:0}},select:{disabled:true},selectedMode:false,regions:geoRegions,label:{show:visual.format.mapCountryLabels===true||(visual.format.mapLabels!==false&&showFilled),formatter:geoLabel,color:visual.format.mapLabelColor||(dark?'#f8fafc':'#475569'),fontSize:visual.format.mapLabelSize??11}},
    series
  };
  const events=useMemo(()=>({click:(params:any)=>{const point=params.data?.__point;if(point?.selectionField)return onPointClick?.(point.selectionField,point.selectionValue);const path=params.data?.__path;if(path?.selectionField)return onPointClick?.(path.selectionField,path.selectionValue);const region=regionsByName.get(params.name);if(region?.selectionField)onPointClick?.(region.selectionField,region.selectionValue)}}),[prepared,onPointClick]);
  const changeZoom=(factor:number)=>setZoom(current=>Math.max(.5,Math.min(12,current*factor)));
  const reset=()=>{setZoom(1);const chart=chartRef.current?.getEchartsInstance?.();chart?.clear();setRenderKey(key=>key+1)};
  const hasMappedMarks=(showFilled&&prepared.regions.length)||(showSymbols&&prepared.points.length);
  return <div className={`vtabAdvancedMap ${dark?'theme-dark':minimal?'theme-minimal':'theme-light'}`}>
    <ReactECharts ref={chartRef} key={`${prepared.mapName}-${renderKey}`} option={option} notMerge lazyUpdate={false} onEvents={events} opts={{renderer:'canvas'}} style={{width:'100%',height:'100%'}}/>
    {visual.format.mapNavigation!==false&&<div className="vtabMapActions"><button title="Fit mapped data" onClick={reset}><LocateFixed size={14}/></button><button title="Zoom in" onClick={()=>changeZoom(1.35)}><Plus size={14}/></button><button title="Zoom out" onClick={()=>changeZoom(1/1.35)}><Minus size={14}/></button><button title="Reset map view" onClick={reset}><RotateCcw size={14}/></button></div>}
    {!hasMappedMarks&&prepared.points.length&&!prepared.hasPointPayload&&<div className="vtabMapStatus coordinatesReady"><LocateFixed size={22}/><b>Coordinates ready</b><span>Add Detail, Size, Color, Label, Path, or Tooltips to display data marks.</span></div>}
    {!hasMappedMarks&&!prepared.points.length&&!prepared.regions.length&&<div className="vtabMapStatus"><LocateFixed size={22}/><b>No mapped data</b><span>Add a country/location for filled areas, or latitude and longitude for points.</span></div>}
    {!dismissed&&prepared.unmatched.length>0&&<div className="vtabMapNotice" title={prepared.unmatched.join(', ')}><TriangleAlert size={13}/><span>{prepared.unmatched.length} location{prepared.unmatched.length===1?'':'s'} did not match a local boundary. Use a country name/ISO code, coordinates, or imported GeoJSON.</span><button onClick={()=>setDismissed(true)}>×</button></div>}
    {visual.format.legendVisible!==false&&(prepared.numericDomain||prepared.categoryLegend.length>0)&&<div className={`vtabMapLegend position-${visual.format.legendPosition||'bottom'}`} style={{'--map-legend-color':visual.format.legendColor||'#242424','--map-legend-size':`${visual.format.legendFontSize||11}px`} as any}><b>{visual.format.mapLegendTitle||String(prepared.colorField||prepared.valueField||'Value').split('.').pop()}</b>{prepared.numericDomain?<><div className="vtabMapGradient" style={{background:`linear-gradient(90deg,${visual.format.mapMinColor||'#d64550'},${visual.format.mapMidColor||'#facc15'},${visual.format.mapMaxColor||'#1aab40'})`}}/><span className="vtabMapGradientLabels"><em>{formatValue(prepared.numericDomain[0],prepared.colorField||prepared.valueField||'')}</em><em>{formatValue(prepared.numericDomain[1],prepared.colorField||prepared.valueField||'')}</em></span></>:prepared.categoryLegend.map(item=><span key={item.label}><i style={{background:item.color}}/>{item.label}</span>)}</div>}
    <div className="vtabMapSummary">Local vector map · {prepared.regions.length} matched areas · {prepared.hasPointPayload?prepared.points.length:0} marks{prepared.paths.length?` · ${prepared.paths.length} paths`:''}</div>
  </div>;
}
