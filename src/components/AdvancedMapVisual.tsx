import {useEffect,useMemo,useRef,useState} from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import {LocateFixed,Minus,Plus,RotateCcw,TriangleAlert} from 'lucide-react';
import type {Visual} from '../types';
import {buildAdministrativePartitionMap,formatMapTooltip,loadAdministrativeBoundaries,mapGeometryBounds,mapValue,prepareMapData,resolveWorldFeatureName} from '../mapEngine';
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
  if(prepared.geographyLevel!=='country'){
    if(visual.format.mapAutoFit===false)return undefined;
    if(prepared.points.length)return pointBounds(prepared.points);
    return paddedBounds(mapGeometryBounds(prepared.geoJson,prepared.regions.map(region=>region.name)));
  }
  if(scope==='india')return paddedBounds(mapGeometryBounds(prepared.geoJson,[resolveWorldFeatureName('India')||'India']));
  if(scope==='country'){const requested=visual.format.mapDefaultCountry||'India',resolved=resolveWorldFeatureName(requested)||requested;return paddedBounds(mapGeometryBounds(prepared.geoJson,[resolved]))}
  if(visual.format.mapAutoFit===false)return undefined;
  if(prepared.points.length)return pointBounds(prepared.points);
  return paddedBounds(mapGeometryBounds(prepared.geoJson,prepared.regions.map(region=>region.name)));
}

type MapDetailLevel='country'|'region'|'city';
const uniqueValues=(rows:any[],field?:string)=>field?Array.from(new Set(rows.map(row=>String(mapValue(row,field)??'').trim()).filter(Boolean))).sort((a,b)=>a.localeCompare(b)):[];
const valueKey=(value:any)=>String(value??'').trim().toLocaleLowerCase();
const inferredLevel=(visual:Visual):MapDetailLevel=>visual.bindings.country?.length?'country':visual.bindings.region?.length?'region':visual.bindings.location?.length?'city':'country';

export default function AdvancedMapVisual({visual,rows,onPointClick}:{visual:Visual;rows:any[];onPointClick?:(field:string,value:any)=>void}){
  const initialLevel=visual.format.mapDetailLevel&&visual.format.mapDetailLevel!=='auto'?visual.format.mapDetailLevel:inferredLevel(visual);
  const chartRef=useRef<any>(null),pointDataRef=useRef<any[]>([]),pointerDownRef=useRef(false),roamingRef=useRef(false),roamTimerRef=useRef<number|undefined>(undefined),autoCountryRef=useRef(false),autoRegionRef=useRef(false),[renderKey,setRenderKey]=useState(0),[dismissed,setDismissed]=useState(false),[zoom,setZoom]=useState(1),[detailLevel,setDetailLevel]=useState<MapDetailLevel>(initialLevel),[selectedCountry,setSelectedCountry]=useState(''),[selectedRegion,setSelectedRegion]=useState(''),[cityPartition,setCityPartition]=useState<any>(),[boundaryLoading,setBoundaryLoading]=useState(false),[boundaryError,setBoundaryError]=useState('');
  const countryField=visual.bindings.country?.[0],regionField=visual.bindings.region?.[0],locationField=visual.bindings.location?.[0];
  const automaticDetail=!visual.format.mapDetailLevel||visual.format.mapDetailLevel==='auto';
  const availableLevels=useMemo(()=>['country',...(regionField?['region']:[]),...(locationField?['city']:[])] as MapDetailLevel[],[regionField,locationField]);
  const countryOptions=useMemo(()=>uniqueValues(rows,countryField),[rows,countryField]);
  const countryRows=useMemo(()=>selectedCountry&&countryField?rows.filter(row=>valueKey(mapValue(row,countryField))===valueKey(selectedCountry)):rows,[rows,countryField,selectedCountry]);
  const regionOptions=useMemo(()=>uniqueValues(countryRows,regionField),[countryRows,regionField]);
  useEffect(()=>{const configured=visual.format.mapDetailLevel&&visual.format.mapDetailLevel!=='auto'?visual.format.mapDetailLevel:inferredLevel(visual);setDetailLevel(availableLevels.includes(configured)?configured:availableLevels[availableLevels.length-1]||'country')},[visual.format.mapDetailLevel,locationField,regionField]);
  useEffect(()=>{
    if(selectedCountry&&!countryOptions.some(option=>valueKey(option)===valueKey(selectedCountry))){setSelectedCountry('');setSelectedRegion('');autoCountryRef.current=false;autoRegionRef.current=false}
    else if(!selectedCountry&&countryOptions.length===1){autoCountryRef.current=true;setSelectedCountry(countryOptions[0]);if(automaticDetail&&regionField)setDetailLevel('region')}
    else if(autoCountryRef.current&&countryOptions.length>1){autoCountryRef.current=false;autoRegionRef.current=false;setSelectedCountry('');setSelectedRegion('');setDetailLevel('country')}
  },[countryOptions.join('|'),selectedCountry,automaticDetail,regionField]);
  useEffect(()=>{
    if(selectedRegion&&!regionOptions.some(option=>valueKey(option)===valueKey(selectedRegion))){setSelectedRegion('');autoRegionRef.current=false}
    else if(!selectedRegion&&regionOptions.length===1&&!!regionField){autoRegionRef.current=true;setSelectedRegion(regionOptions[0]);if(automaticDetail&&locationField)setDetailLevel('city')}
    else if(autoRegionRef.current&&regionOptions.length>1){autoRegionRef.current=false;setSelectedRegion('');setDetailLevel(selectedCountry?'region':'country')}
  },[regionOptions.join('|'),selectedRegion,selectedCountry,regionField,locationField,automaticDetail]);
  const scopedRows=useMemo(()=>countryRows.filter(row=>!selectedRegion||!regionField||valueKey(mapValue(row,regionField))===valueKey(selectedRegion)),[countryRows,regionField,selectedRegion]);
  const viewVisual=useMemo(()=>{
    const bindings={...visual.bindings};
    if(detailLevel==='country'){bindings.region=[];bindings.location=[];bindings.postalCode=[];bindings.latitude=[];bindings.longitude=[]}
    else if(detailLevel==='region'){bindings.location=[];bindings.postalCode=[];bindings.latitude=[];bindings.longitude=[]}
    return{...visual,bindings,format:{...visual.format}} as Visual;
  },[visual,detailLevel]);
  const visualSignature=JSON.stringify({bindings:viewVisual.bindings,format:viewVisual.format});
  const prepared=useMemo(()=>prepareMapData(viewVisual,scopedRows),[visualSignature,scopedRows]);
  useEffect(()=>{let cancelled=false;if(detailLevel!=='city'||!selectedCountry||!selectedRegion||!locationField){setCityPartition(undefined);setBoundaryLoading(false);setBoundaryError('');return()=>{cancelled=true}}setBoundaryLoading(true);setBoundaryError('');setCityPartition(undefined);Promise.all([loadAdministrativeBoundaries(selectedCountry,'ADM1'),loadAdministrativeBoundaries(selectedCountry,'ADM2')]).then(([parents,children])=>{if(cancelled)return;const partition=buildAdministrativePartitionMap(`${visual.id}-${selectedCountry}-${selectedRegion}`,parents.geoJson,selectedRegion,children,prepared.points,locationField);if(!partition)throw new Error(`No administrative child boundaries matched ${selectedRegion}`);setCityPartition(partition)}).catch(error=>{if(!cancelled)setBoundaryError(error?.message||String(error))}).finally(()=>{if(!cancelled)setBoundaryLoading(false)});return()=>{cancelled=true}},[detailLevel,selectedCountry,selectedRegion,locationField,prepared.mapName,prepared.points]);
  const mapFormats=Object.fromEntries(Array.from(new Set([...Object.keys(rows[0]||{}),...Object.keys(visual.format.fieldFormats||{})])).map(field=>[field,{displayUnits:visual.format.displayUnits||'auto',decimals:visual.format.displayUnitDecimals??2,...visual.format.fieldFormats?.[field]}]));
  const formatValue=(value:any,field:string)=>formatForField(value,field,mapFormats);
  const renderMapName=cityPartition?.mapName||prepared.mapName,renderGeoJson=cityPartition?.geoJson||prepared.geoJson,renderFeatureNames=cityPartition?.featureNames||prepared.featureNames;
  ensureMap(renderMapName,renderGeoJson);
  useEffect(()=>{ensureMap(renderMapName,renderGeoJson)},[renderMapName,renderGeoJson]);
  useEffect(()=>setDismissed(false),[prepared.unmatched.join('|')]);
  // The selected map type is authoritative at every hierarchy level. A city
  // drill can still scope a filled map to its parent state without silently
  // switching the user's Filled choice back to bubbles.
  const mode=visual.format.mapMode==='filled'?'filled':'bubble';
  const showFilled=mode==='filled'&&(detailLevel!=='city'||!!cityPartition),showSymbols=(mode==='bubble'||(detailLevel==='city'&&!!boundaryError))&&prepared.hasPointPayload;
  const dark=visual.format.mapStyle==='dark',minimal=visual.format.mapStyle==='minimal',background=dark?'#111827':minimal?'#ffffff':'#dfeef7',land=dark?'#263447':minimal?'#f8fafc':'#f8fafc',border=visual.format.mapBorderColor||(dark?'#52657b':'#cbd5e1');
  const cityPalette=['#118dff','#3b9fe8','#63b1d1','#87c2ba','#4e8fd5','#77a9e6'];
  const displayRegions:any[]=cityPartition?cityPartition.sites.map((site:any,index:number)=>{const numeric=site.items.map((point:any)=>point.value[2]).filter((value:any)=>Number.isFinite(value)),value=prepared.valueField&&numeric.length?numeric.reduce((sum:number,item:number)=>sum+item,0):undefined,first=site.items[0],tooltip=first.tooltip.map(([field,item]:[string,any])=>field===prepared.valueField&&value!==undefined?[field,value] as [string,any]:[field,item] as [string,any]);return{name:site.name,value,color:prepared.colorField||prepared.valueField?first.color:cityPalette[index%cityPalette.length],rows:site.items.map((point:any)=>point.row),selectionField:locationField||first.selectionField,selectionValue:site.selectionValue,tooltip}}):prepared.regions;
  const regionsByName=new Map<string,any>(displayRegions.map((region:any)=>[region.name,region]));
  const geoRegions=renderFeatureNames.map((name:string)=>{const item=regionsByName.get(name),areaColor=showFilled&&item?item.color:(visual.format.mapMissingColor||(dark?'#334155':'#e8eef4'));return{name,itemStyle:{areaColor,borderColor:cityPartition?'#ffffff':border,borderWidth:cityPartition?Math.max(1,visual.format.mapBorderWidth??1):visual.format.mapBorderWidth??.7,opacity:showFilled&&item?(visual.format.mapFillOpacity??78)/100:1},emphasis:{disabled:true,itemStyle:{areaColor,borderColor:cityPartition?'#ffffff':border,shadowBlur:0},label:{show:false}}}});
  const bounds=cityPartition?paddedBounds(mapGeometryBounds(renderGeoJson,renderFeatureNames)):mapBounds(visual,prepared),boundsSignature=JSON.stringify(bounds);
  useEffect(()=>setZoom(1),[prepared.mapName,boundsSignature,mode]);
  const series:any[]=[];
  const pointLabel=(point:(typeof prepared.points)[number])=>{const parts:string[]=[];if(visual.format.mapCountryLabels===true&&point.name)parts.push(point.name);if(visual.format.mapLabels!==false&&prepared.valueField)parts.push(formatValue(point.value[2],prepared.valueField));return parts.join('\n')};
  const pointSeriesData=showSymbols?prepared.points.map(point=>({name:point.name,value:point.value,symbolSize:point.radius*2,itemStyle:{color:point.color,opacity:(visual.format.mapMarkerOpacity??85)/100,borderColor:visual.format.mapBorderColor||'#fff',borderWidth:visual.format.mapBorderWidth??1},emphasis:{disabled:true,scale:false},label:{show:!!pointLabel(point),formatter:pointLabel(point),position:'bottom',distance:4,color:visual.format.mapLabelColor||(dark?'#f8fafc':'#1f2937'),fontSize:visual.format.mapLabelSize??11},__point:point})):[];
  pointDataRef.current=pointSeriesData;
  if(showSymbols)series.push({id:'vtab-map-points',name:'Locations',type:'scatter',coordinateSystem:'geo',z:2,labelLayout:{hideOverlap:visual.format.mapAllowOverlap!==true},emphasis:{disabled:true,scale:false},data:pointSeriesData});
  const tooltipFormatter=(params:any)=>{const point=params.data?.__point;if(point)return tooltipHtml(point.tooltip,point.name,formatValue);const region=regionsByName.get(params.name);return region?tooltipHtml(region.tooltip,region.name,formatValue):`<b>${escapeHtml(params.name||'')}</b>`};
  const geoLabel=(params:any)=>{const name=params?.name||'',region=regionsByName.get(name),parts:string[]=[];if(visual.format.mapCountryLabels===true)parts.push(prepared.geographyLevel==='region'?name.split(',')[0]:name);if(visual.format.mapLabels!==false&&region?.value!==undefined&&prepared.valueField)parts.push(formatValue(region.value,prepared.valueField));return parts.join('\n')};
  const tooltipOptions={show:visual.format.tooltipEnabled!==false,trigger:'item',confine:true,backgroundColor:visual.format.tooltipBackground||'#ffffff',textStyle:{color:visual.format.tooltipColor||'#242424',fontSize:11},borderColor:'#cbd5e1',extraCssText:'box-shadow:0 8px 24px rgba(15,23,42,.18);border-radius:8px;',formatter:tooltipFormatter};
  const option={
    animation:true,backgroundColor:background,
    tooltip:tooltipOptions,
    geo:{map:renderMapName,roam:visual.format.mapNavigation!==false,zoom,silent:false,boundingCoords:bounds,tooltip:tooltipOptions,itemStyle:{areaColor:land,borderColor:border,borderWidth:visual.format.mapBorderWidth??.7},emphasis:{disabled:true,label:{show:false},itemStyle:{areaColor:land,borderColor:border,shadowBlur:0}},select:{disabled:true},selectedMode:false,regions:geoRegions,label:{show:visual.format.mapCountryLabels===true||(visual.format.mapLabels!==false&&showFilled),formatter:geoLabel,color:visual.format.mapLabelColor||(dark?'#f8fafc':'#475569'),fontSize:visual.format.mapLabelSize??11}},
    series
  };
  const restorePoints=()=>{if(roamTimerRef.current!==undefined){window.clearTimeout(roamTimerRef.current);roamTimerRef.current=undefined}if(!roamingRef.current)return;roamingRef.current=false;chartRef.current?.getEchartsInstance?.()?.setOption({series:[{id:'vtab-map-points',data:pointDataRef.current}]},{notMerge:false,lazyUpdate:false})};
  const hidePointsWhileRoaming=()=>{if(!showSymbols)return;const chart=chartRef.current?.getEchartsInstance?.();if(!chart)return;if(!roamingRef.current){roamingRef.current=true;chart.setOption({series:[{id:'vtab-map-points',data:[]}]},{notMerge:false,lazyUpdate:true})}if(!pointerDownRef.current){if(roamTimerRef.current!==undefined)window.clearTimeout(roamTimerRef.current);roamTimerRef.current=window.setTimeout(restorePoints,140)}};
  const events=useMemo(()=>({click:(params:any)=>{const point=params.data?.__point;if(point?.selectionField)return onPointClick?.(point.selectionField,point.selectionValue);const path=params.data?.__path;if(path?.selectionField)return onPointClick?.(path.selectionField,path.selectionValue);const region=regionsByName.get(params.name);if(region?.selectionField)onPointClick?.(region.selectionField,region.selectionValue)},georoam:hidePointsWhileRoaming}),[prepared,onPointClick,showSymbols]);
  useEffect(()=>{const chart=chartRef.current?.getEchartsInstance?.(),zr=chart?.getZr?.();if(!zr)return;const down=()=>{pointerDownRef.current=true};const up=()=>{pointerDownRef.current=false;restorePoints()};zr.on('mousedown',down);zr.on('mouseup',up);zr.on('globalout',up);return()=>{zr.off('mousedown',down);zr.off('mouseup',up);zr.off('globalout',up);if(roamTimerRef.current!==undefined)window.clearTimeout(roamTimerRef.current)}},[renderMapName,renderKey,showSymbols]);
  const changeZoom=(factor:number)=>setZoom(current=>Math.max(.5,Math.min(12,current*factor)));
  const reset=()=>{setZoom(1);const chart=chartRef.current?.getEchartsInstance?.();chart?.clear();setRenderKey(key=>key+1)};
  const hasMappedMarks=(showFilled&&prepared.regions.length)||(showSymbols&&prepared.points.length);
  return <div className={`vtabAdvancedMap detail-${detailLevel} ${dark?'theme-dark':minimal?'theme-minimal':'theme-light'}`}>
    <ReactECharts ref={chartRef} key={`${renderMapName}-${renderKey}`} option={option} notMerge lazyUpdate={false} onEvents={events} opts={{renderer:'canvas'}} style={{width:'100%',height:'100%'}}/>
    <div className="vtabMapContextControls" aria-label="Map geographic view" onPointerDown={event=>event.stopPropagation()}>
      {countryField&&countryOptions.length>0&&<label><span>Country</span><select value={selectedCountry} onChange={event=>{const next=event.target.value;autoCountryRef.current=false;autoRegionRef.current=false;setSelectedCountry(next);setSelectedRegion('');setDetailLevel(next&&regionField?'region':'country');onPointClick?.(countryField,next||null)}}><option value="">All countries</option>{countryOptions.map(country=><option key={country} value={country}>{country}</option>)}</select></label>}
      {selectedCountry&&regionField&&regionOptions.length>0&&<label><span>State / province</span><select value={selectedRegion} onChange={event=>{const next=event.target.value;autoRegionRef.current=false;setSelectedRegion(next);setDetailLevel(next&&locationField?'city':'region');if(next)onPointClick?.(regionField,next);else if(countryField)onPointClick?.(countryField,selectedCountry)}}><option value="">All states / provinces</option>{regionOptions.map(region=><option key={region} value={region}>{region}</option>)}</select></label>}
      <label><span>View</span><select value={detailLevel} onChange={event=>setDetailLevel(event.target.value as MapDetailLevel)}><option value="country">Countries</option>{selectedCountry&&regionField&&<option value="region">States / provinces</option>}{selectedCountry&&selectedRegion&&locationField&&<option value="city">Cities / locations</option>}</select></label>
    </div>
    {visual.format.mapNavigation!==false&&<div className="vtabMapActions"><button title="Fit mapped data" onClick={reset}><LocateFixed size={14}/></button><button title="Zoom in" onClick={()=>changeZoom(1.35)}><Plus size={14}/></button><button title="Zoom out" onClick={()=>changeZoom(1/1.35)}><Minus size={14}/></button><button title="Reset map view" onClick={reset}><RotateCcw size={14}/></button></div>}
    {!hasMappedMarks&&prepared.points.length&&!prepared.hasPointPayload&&<div className="vtabMapStatus coordinatesReady"><LocateFixed size={22}/><b>Coordinates ready</b><span>Add Detail, Size, Color, Label, Path, or Tooltips to display data marks.</span></div>}
    {!hasMappedMarks&&!prepared.points.length&&!prepared.regions.length&&<div className="vtabMapStatus"><LocateFixed size={22}/><b>No mapped data</b><span>Add Country, State / Province, or City / Location. Coordinates and imported boundaries remain supported.</span></div>}
    {detailLevel==='city'&&boundaryLoading&&<div className="vtabMapBoundaryStatus">Loading administrative district boundaries…</div>}
    {detailLevel==='city'&&!!boundaryError&&<div className="vtabMapNotice"><TriangleAlert size={13}/><span>Exact administrative boundaries are unavailable: {boundaryError}. Location points are shown instead of invented partitions.</span></div>}
    {!dismissed&&prepared.unmatched.length>0&&<div className="vtabMapNotice" title={prepared.unmatched.join(', ')}><TriangleAlert size={13}/><span>{prepared.unmatched.length} location{prepared.unmatched.length===1?'':'s'} did not match the offline country, state/province, or city index. Add geographic context, coordinates, a local correction, or imported GeoJSON.</span><button onClick={()=>setDismissed(true)}>×</button></div>}
    <div className="vtabMapSummary">{selectedCountry?`${selectedCountry}${selectedRegion?` › ${selectedRegion}`:''} · `:''}{detailLevel==='city'?'District / city boundary':detailLevel==='region'?'State / province':'Country'} view · {displayRegions.length} matched areas · {showSymbols?prepared.points.length:0} marks{prepared.paths.length?` · ${prepared.paths.length} paths`:''}{cityPartition?' · geoBoundaries ADM2':''}</div>
  </div>;
}
