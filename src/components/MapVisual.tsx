import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import * as maplibregl from 'maplibre-gl';
import type {Map as MapLibreMap,StyleSpecification} from 'maplibre-gl';
import {Protocol} from 'pmtiles';
import {LocateFixed,RotateCcw,TriangleAlert} from 'lucide-react';
import {api} from '../api';
import type {Visual} from '../types';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../mapVisual.css';

type FeatureCollection={type:'FeatureCollection';features:any[]};
type GeocodeResult={query:string;status:'resolved'|'ambiguous'|'unmatched';latitude?:number;longitude?:number;displayName?:string;candidates?:any[]};

const EMPTY:FeatureCollection={type:'FeatureCollection',features:[]};
const palette=['#118dff','#12239e','#e66c37','#6b007b','#e044a7','#744ec2','#d9b300','#d64550','#197278','#1aab40'];
let protocolReady=false;
const ensurePmtiles=()=>{if(protocolReady)return;const protocol=new Protocol();maplibregl.addProtocol('pmtiles',protocol.tile);protocolReady=true};
const finite=(value:any)=>{const numberValue=Number(value);return Number.isFinite(numberValue)?numberValue:undefined};
const hashColor=(value:any)=>{const text=String(value??'');let hash=0;for(let index=0;index<text.length;index++)hash=((hash<<5)-hash+text.charCodeAt(index))|0;return palette[Math.abs(hash)%palette.length]};
const mixColor=(from:string,to:string,ratio:number)=>{const hex=(value:string)=>{const clean=value.replace('#','');const normalized=clean.length===3?clean.split('').map(char=>char+char).join(''):clean;return [0,2,4].map(offset=>parseInt(normalized.slice(offset,offset+2),16))};const a=hex(from),b=hex(to),t=Math.max(0,Math.min(1,ratio));return '#'+a.map((value,index)=>Math.round(value+(b[index]-value)*t).toString(16).padStart(2,'0')).join('')};
const parseGeometry=(value:any)=>{if(!value)return undefined;try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed?.type==='Feature'?parsed.geometry:parsed?.type&&parsed?.coordinates?parsed:undefined}catch{return undefined}};
const escapeText=(value:any)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]||char));

const buildBasemapStyle = (styleName: string = 'light'): StyleSpecification => {
  const isDark = styleName === 'dark';
  const tileUrl = isDark
    ? 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
    : styleName === 'streets'
    ? 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png'
    : 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png';

  return {
    version: 8,
    sources: {
      'carto-basemap': {
        type: 'raster',
        tiles: [
          tileUrl,
          tileUrl.replace('//a.', '//b.'),
          tileUrl.replace('//a.', '//c.'),
          tileUrl.replace('//a.', '//d.')
        ],
        tileSize: 256,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxzoom: 19
      }
    },
    layers: [
      {
        id: 'carto-basemap-layer',
        type: 'raster',
        source: 'carto-basemap',
        minzoom: 0,
        maxzoom: 19
      }
    ]
  };
};

const blankStyle=(dark=false):StyleSpecification=>({
  version:8,
  sources:{},
  layers:[{id:'background',type:'background',paint:{'background-color':dark?'#0f172a':'#eef3f8'}}]
});

const getRowVal=(row:any,field?:string)=>{
  if(!field||!row)return undefined;
  if(row[field]!==undefined)return row[field];
  const short=field.split('.').slice(-1)[0];
  if(row[short]!==undefined)return row[short];
  const lk=short.toLowerCase();
  const k=Object.keys(row).find(x=>x.toLowerCase()===lk||x.split('.').slice(-1)[0].toLowerCase()===lk);
  return k?row[k]:undefined;
};

function buildCollections(visual:Visual,rows:any[],geocoded:Record<string,GeocodeResult>){
  const bindings=visual.bindings;
  const locationField=bindings.location?.[0]||bindings.axis?.[0];
  const latitudeField=bindings.latitude?.[0];
  const longitudeField=bindings.longitude?.[0];
  const geometryField=bindings.geometry?.[0];
  const detailField=bindings.detail?.[0];
  const colorField=bindings.color?.[0]||bindings.legend?.[0];
  const sizeField=bindings.size?.[0]||bindings.values?.[0];
  const labelField=bindings.label?.[0];
  const pathField=bindings.path?.[0];
  const tooltipFields=bindings.tooltips||[];
  const sizes=rows.map(row=>finite(sizeField?getRowVal(row,sizeField):undefined)).filter((value):value is number=>value!==undefined);
  const colorNumbers=rows.map(row=>finite(colorField?getRowVal(row,colorField):undefined)).filter((value):value is number=>value!==undefined);
  const sizeMin=Math.min(...sizes,0),sizeMax=Math.max(...sizes,1);
  const colorMin=Math.min(...colorNumbers,0),colorMax=Math.max(...colorNumbers,1);
  const markerMin=visual.format.mapMarkerMinSize??5,markerMax=Math.max(markerMin,visual.format.mapMarkerMaxSize??24);
  const pointFeatures:any[]=[],geometryFeatures:any[]=[];
  rows.forEach((row,index)=>{
    const rawGeometry=geometryField?getRowVal(row,geometryField):undefined;
    const geometry=parseGeometry(rawGeometry);
    // Reports created by older builds offered a generic "Geometry" bucket and
    // often saved Region/State/City text there. Preserve those reports by using
    // non-GeoJSON geometry values as named locations for geocoding.
    const legacyNamedLocation=!geometry&&rawGeometry!==undefined?String(rawGeometry??'').trim():'';
    const location=locationField?String(getRowVal(row,locationField)??'').trim():legacyNamedLocation;
    const query=[location,bindings.region?.[0]?getRowVal(row,bindings.region[0]):'',bindings.country?.[0]?getRowVal(row,bindings.country[0]):'',bindings.postalCode?.[0]?getRowVal(row,bindings.postalCode[0]):''].filter(Boolean).join(', ');
    const match=query?geocoded[query]:undefined;
    const autoLat=finite(latitudeField?getRowVal(row,latitudeField):(getRowVal(row,'latitude')??getRowVal(row,'lat')));
    const autoLon=finite(longitudeField?getRowVal(row,longitudeField):(getRowVal(row,'longitude')??getRowVal(row,'lon')??getRowVal(row,'lng')));
    const latitude=autoLat??match?.latitude;
    const longitude=autoLon??match?.longitude;
    const rawSize=finite(sizeField?getRowVal(row,sizeField):undefined);
    const markerSize=rawSize===undefined?(visual.format.mapMarkerSize??9):markerMin+((rawSize-sizeMin)/Math.max(1e-9,sizeMax-sizeMin))*(markerMax-markerMin);
    const colorValue=colorField?getRowVal(row,colorField):undefined;
    const numericColor=finite(colorValue);
    const markerColor=typeof colorValue==='string'&&/^(#|rgb|hsl)/i.test(colorValue)?colorValue:numericColor!==undefined?mixColor(visual.format.negativeColor||'#d64550',visual.format.positiveColor||'#1aab40',(numericColor-colorMin)/Math.max(1e-9,colorMax-colorMin)):colorField?hashColor(colorValue):(visual.format.mapMarkerColor||visual.format.accent||'#118dff');
    const label=String((labelField?getRowVal(row,labelField):undefined)??(detailField?getRowVal(row,detailField):undefined)??location??'');
    const selectionField=detailField||locationField||colorField||'';
    const tooltipEntries=[locationField,detailField,colorField,sizeField,...tooltipFields].filter((field,index,array):field is string=>!!field&&array.indexOf(field)===index).map(field=>[field,getRowVal(row,field)??row[field]]);
    const properties={...row,__rowIndex:index,__location:location,__query:query,__label:label,__markerColor:markerColor,__markerSize:markerSize,__selectionField:selectionField,__selectionValue:selectionField?(getRowVal(row,selectionField)??row[selectionField]):undefined,__tooltip:tooltipEntries};
    if(geometry)geometryFeatures.push({type:'Feature',properties,geometry});
    if(latitude!==undefined&&longitude!==undefined&&latitude>=-90&&latitude<=90&&longitude>=-180&&longitude<=180)pointFeatures.push({type:'Feature',properties,geometry:{type:'Point',coordinates:[longitude,latitude]}});
  });
  const custom=visual.format.mapCustomGeometry;
  if(custom?.type==='FeatureCollection'){
    const joinProperty=visual.format.mapGeometryJoinProperty;
    custom.features?.forEach((feature:any,index:number)=>{
      let properties={...(feature.properties||{}),__rowIndex:index,__markerColor:visual.format.mapFillColor||visual.format.accent||'#118dff'};
      if(joinProperty&&locationField){const row=rows.find(item=>String(getRowVal(item,locationField)??item[locationField]??'')===String(feature.properties?.[joinProperty]??''));if(row)properties={...properties,...row,__selectionField:locationField,__selectionValue:getRowVal(row,locationField)??row[locationField],__label:String(getRowVal(row,labelField||locationField)??row[labelField||locationField]??'')}}
      geometryFeatures.push({...feature,properties});
    });
  }
  const pathGroups=new Map<string,any[]>();
  pointFeatures.forEach(feature=>{const group=String(pathField?feature.properties[pathField]??'Default':'Default');pathGroups.set(group,[...(pathGroups.get(group)||[]),feature])});
  const pathFeatures=Array.from(pathGroups.entries()).filter(([,features])=>features.length>1).map(([name,features])=>({type:'Feature',properties:{__label:name,__selectionField:pathField||locationField,__selectionValue:name},geometry:{type:'LineString',coordinates:features.map(feature=>feature.geometry.coordinates)}}));
  return{points:{type:'FeatureCollection',features:pointFeatures} as FeatureCollection,geometry:{type:'FeatureCollection',features:geometryFeatures} as FeatureCollection,paths:{type:'FeatureCollection',features:pathFeatures} as FeatureCollection};
}

function addVisualLayers(map:MapLibreMap,visual:Visual,data:{points:FeatureCollection;geometry:FeatureCollection;paths:FeatureCollection}){
  const f=visual.format,mode=f.mapMode||'symbol';
  const has=(type:string)=>mode==='layered'||mode===type||((mode==='filled')&&type==='symbol');
  const configured=f.mapLayers||[];
  const layerFor=(type:'symbol'|'filled'|'density'|'path')=>configured.find(item=>item.type===type);
  const enabled=(type:'symbol'|'filled'|'density'|'path')=>{if(mode!=='layered')return has(type);const layer=layerFor(type);return layer?layer.visible!==false:true};

  const safeAddSource=(id:string,def:any)=>{
    try{
      if(!map.getSource(id)) map.addSource(id,def);
    }catch(e){console.warn(`Could not add source ${id}:`,e)}
  };
  const safeAddLayer=(layerDef:any)=>{
    try{
      if(!map.getLayer(layerDef.id)) map.addLayer(layerDef);
    }catch(e){console.warn(`Could not add layer ${layerDef.id}:`,e)}
  };

  safeAddSource('vtab-points',{type:'geojson',data:data.points as any,cluster:f.mapClustering!==false,clusterRadius:f.mapClusterRadius??45,clusterMaxZoom:14});
  safeAddSource('vtab-geometry',{type:'geojson',data:data.geometry as any});
  safeAddSource('vtab-paths',{type:'geojson',data:data.paths as any});

  if(enabled('filled')) safeAddLayer({id:'vtab-fill',type:'fill',source:'vtab-geometry',filter:['==',['geometry-type'],'Polygon'],paint:{'fill-color':['coalesce',['get','__markerColor'],layerFor('filled')?.color||f.mapFillColor||f.accent||'#118dff'],'fill-opacity':(layerFor('filled')?.opacity??f.mapFillOpacity??65)/100,'fill-outline-color':f.mapBorderColor||'#ffffff'}} as any);
  if(enabled('path')){
    safeAddLayer({id:'vtab-geometry-line',type:'line',source:'vtab-geometry',filter:['in',['geometry-type'],['literal',['LineString','MultiLineString']]],paint:{'line-color':layerFor('path')?.color||f.mapLineColor||f.accent||'#118dff','line-width':layerFor('path')?.size??f.mapLineWidth??3,'line-opacity':(layerFor('path')?.opacity??f.mapLineOpacity??90)/100}} as any);
    safeAddLayer({id:'vtab-path',type:'line',source:'vtab-paths',paint:{'line-color':layerFor('path')?.color||f.mapLineColor||f.accent||'#118dff','line-width':layerFor('path')?.size??f.mapLineWidth??3,'line-opacity':(layerFor('path')?.opacity??f.mapLineOpacity??90)/100}} as any);
  }
  if(enabled('density')) safeAddLayer({id:'vtab-heat',type:'heatmap',source:'vtab-points',maxzoom:17,paint:{'heatmap-weight':['interpolate',['linear'],['coalesce',['get','__markerSize'],1],1,0,40,1],'heatmap-intensity':f.mapHeatIntensity??1,'heatmap-radius':f.mapHeatRadius??24,'heatmap-opacity':(layerFor('density')?.opacity??f.mapHeatOpacity??80)/100,'heatmap-color':['interpolate',['linear'],['heatmap-density'],0,'rgba(0,0,255,0)',.2,'royalblue',.4,'cyan',.6,'lime',.8,'yellow',1,layerFor('density')?.color||'red']}} as any);
  if(enabled('symbol')){
    safeAddLayer({id:'vtab-clusters',type:'circle',source:'vtab-points',filter:['has','point_count'],paint:{'circle-color':layerFor('symbol')?.color||f.mapMarkerColor||f.accent||'#118dff','circle-opacity':(layerFor('symbol')?.opacity??f.mapMarkerOpacity??85)/100,'circle-radius':['step',['get','point_count'],14,25,20,100,27],'circle-stroke-color':f.mapBorderColor||'#ffffff','circle-stroke-width':f.mapBorderWidth??1}} as any);
    safeAddLayer({id:'vtab-cluster-count',type:'symbol',source:'vtab-points',filter:['has','point_count'],layout:{'text-field':['get','point_count_abbreviated'],'text-size':11},paint:{'text-color':'#ffffff'}} as any);
    safeAddLayer({id:'vtab-points',type:'circle',source:'vtab-points',filter:['!', ['has','point_count']],paint:{'circle-color':['coalesce',['get','__markerColor'],layerFor('symbol')?.color||f.mapMarkerColor||f.accent||'#118dff'],'circle-radius':['coalesce',['get','__markerSize'],layerFor('symbol')?.size??f.mapMarkerSize??9],'circle-opacity':(layerFor('symbol')?.opacity??f.mapMarkerOpacity??85)/100,'circle-stroke-color':f.mapBorderColor||'#ffffff','circle-stroke-width':f.mapBorderWidth??1}} as any);
  }
  if(f.mapLabels!==false) safeAddLayer({id:'vtab-labels',type:'symbol',source:'vtab-points',filter:['!', ['has','point_count']],layout:{'text-field':['get','__label'],'text-size':f.mapLabelSize??11,'text-offset':[0,1.4],'text-anchor':'top','text-allow-overlap':f.mapAllowOverlap===true},paint:{'text-color':f.mapLabelColor||'#1f2937','text-halo-color':'#ffffff','text-halo-width':1.2}} as any);
}

export default function MapVisual({visual,rows,onPointClick}:{visual:Visual;rows:any[];onPointClick?:(field:string,value:any)=>void}){
  const hostRef=useRef<HTMLDivElement|null>(null),mapRef=useRef<MapLibreMap|null>(null),dataRef=useRef<any>(null),visualRef=useRef(visual),onPointClickRef=useRef(onPointClick);
  const[geocoded,setGeocoded]=useState<Record<string,GeocodeResult>>({});
  const[styleUrl,setStyleUrl]=useState<any>(()=>buildBasemapStyle(visual.format.mapStyle||'light'));
  const[notice,setNotice]=useState('');
  const[ready,setReady]=useState(false);
  visualRef.current=visual;onPointClickRef.current=onPointClick;
  const bindings=visual.bindings;
  const locationField=bindings.location?.[0]||bindings.axis?.[0];
  const geometryField=bindings.geometry?.[0];
  const latitudeField=bindings.latitude?.[0];
  const longitudeField=bindings.longitude?.[0];
  const geocodeField=locationField||geometryField;
  const queries=useMemo(()=>geocodeField?Array.from(new Set(rows.map(row=>{
    const lat=finite(latitudeField?getRowVal(row,latitudeField):(getRowVal(row,'latitude')??getRowVal(row,'lat')));
    const lon=finite(longitudeField?getRowVal(row,longitudeField):(getRowVal(row,'longitude')??getRowVal(row,'lon')??getRowVal(row,'lng')));
    if(lat!==undefined&&lon!==undefined)return '';
    const candidate=getRowVal(row,geocodeField)||row[geocodeField];
    if(geometryField===geocodeField&&parseGeometry(candidate))return '';
    return[candidate,bindings.region?.[0]?getRowVal(row,bindings.region[0]):'',bindings.country?.[0]?getRowVal(row,bindings.country[0]):'',bindings.postalCode?.[0]?getRowVal(row,bindings.postalCode[0]):''].filter(Boolean).join(', ');
  }).filter(Boolean))):[],[rows,geocodeField,geometryField,latitudeField,longitudeField,bindings.region?.[0],bindings.country?.[0],bindings.postalCode?.[0]]);

  useEffect(()=>{const refresh=()=>setGeocoded({});window.addEventListener('vtab-map-geocode-updated',refresh);return()=>window.removeEventListener('vtab-map-geocode-updated',refresh)},[]);
  useEffect(()=>{let active=true;const requested=queries.filter(query=>!geocoded[query]).slice(0,250);if(!requested.length)return;api<any>('/map/geocode',{method:'POST',body:JSON.stringify({queries:requested})}).then(response=>{if(!active)return;const next:Record<string,GeocodeResult>={};(response.results||[]).forEach((result:GeocodeResult)=>{next[result.query]=result});setGeocoded(current=>({...current,...next}));const unmatched=(response.results||[]).filter((result:GeocodeResult)=>result.status!=='resolved').length;if(unmatched)setNotice(`${unmatched} location${unmatched===1?'':'s'} could not be matched automatically.`)}).catch(error=>{if(active)setNotice(error?.message||'Named locations could not be geocoded automatically.')});return()=>{active=false}},[queries.join('|'),latitudeField,longitudeField,rows.length]);
  const data=useMemo(()=>buildCollections(visual,rows,geocoded),[visual,rows,geocoded]);dataRef.current=data;

  useEffect(()=>{
    let active=true;
    api<any>('/map/config').then(config=>{
      if(!active)return;
      const selected=visual.format.mapStyle||'light';
      const customUrl=visual.format.mapStyleUrl||config?.styles?.[selected];
      if(customUrl)setStyleUrl(customUrl);
      else if(selected==='minimal')setStyleUrl(blankStyle(false));
      else setStyleUrl(buildBasemapStyle(selected));
    }).catch(()=>{
      if(!active)return;
      const selected=visual.format.mapStyle||'light';
      if(selected==='minimal')setStyleUrl(blankStyle(false));
      else setStyleUrl(buildBasemapStyle(selected));
    });
    return()=>{active=false};
  },[visual.format.mapStyle,visual.format.mapStyleUrl]);

  const fit=useCallback(()=>{
    const map=mapRef.current,current=dataRef.current;
    if(!map||!current)return;
    const bounds=new maplibregl.LngLatBounds();
    const include=(coordinates:any)=>{if(!Array.isArray(coordinates))return;if(coordinates.length>=2&&typeof coordinates[0]==='number'&&typeof coordinates[1]==='number')bounds.extend([coordinates[0],coordinates[1]]);else coordinates.forEach(include)};
    [...current.points.features,...current.geometry.features,...current.paths.features].forEach((feature:any)=>include(feature.geometry?.coordinates));
    if(!bounds.isEmpty())map.fitBounds(bounds,{padding:28,maxZoom:14,duration:350});
  },[]);

  useEffect(()=>{
    if(!hostRef.current)return;
    ensurePmtiles();
    setReady(false);
    let cancelled=false;
    let layersAdded=false;
    const map=new maplibregl.Map({
      container:hostRef.current,
      style:styleUrl,
      center:[visual.format.mapCenterLongitude??0,visual.format.mapCenterLatitude??20],
      zoom:visual.format.mapZoom??1.2,
      minZoom:visual.format.mapMinZoom??0,
      maxZoom:visual.format.mapMaxZoom??20,
      attributionControl:{compact:true}
    });
    mapRef.current=map;
    if(visual.format.mapNavigation!==false)map.addControl(new maplibregl.NavigationControl({showCompass:true}),'top-right');

    const initLayers=()=>{
      if(layersAdded||cancelled||!map.isStyleLoaded())return;
      layersAdded=true;
      try{
        addVisualLayers(map,visualRef.current,dataRef.current||{points:EMPTY,geometry:EMPTY,paths:EMPTY});
        setReady(true);
        if(visualRef.current.format.mapAutoFit!==false)fit();
      }catch(error:any){
        setNotice(error?.message||'Map layers could not be created.');
        setReady(true);
      }
    };

    map.on('load',initLayers);
    map.on('styledata',()=>{if(map.isStyleLoaded())initLayers()});

    const fallbackTimer=setTimeout(()=>{
      if(!layersAdded&&!cancelled){
        try{
          map.setStyle(buildBasemapStyle(visualRef.current.format.mapStyle||'light'));
        }catch{
          setReady(true);
        }
      }
    },2500);

    map.on('error',(e:any)=>{
      if(!layersAdded&&!cancelled&&(e?.error?.status===403||e?.error?.status===404||!navigator.onLine)){
        try{
          map.setStyle(buildBasemapStyle(visualRef.current.format.mapStyle||'light'));
        }catch{
          setReady(true);
        }
      }
    });

    map.on('click',event=>{
      const features=map.queryRenderedFeatures(event.point,{layers:['vtab-points','vtab-fill','vtab-path','vtab-geometry-line'].filter(id=>!!map.getLayer(id))});
      const feature:any=features[0];
      if(!feature)return;
      const field=feature.properties?.__selectionField,value=feature.properties?.__selectionValue;
      if(field&&value!==undefined)onPointClickRef.current?.(field,value);
      const entries=feature.properties?.__tooltip?(typeof feature.properties.__tooltip==='string'?JSON.parse(feature.properties.__tooltip):feature.properties.__tooltip):[];
      if(entries.length)new maplibregl.Popup({closeButton:true,maxWidth:'320px'}).setLngLat(event.lngLat).setHTML(`<div class="vtabMapTooltip">${entries.map((entry:any)=>`<div><b>${escapeText(String(entry[0]).replace(/^.*\./,''))}</b><span>${escapeText(entry[1])}</span></div>`).join('')}</div>`).addTo(map);
    });

    map.on('mouseenter','vtab-points',()=>{map.getCanvas().style.cursor='pointer'});
    map.on('mouseleave','vtab-points',()=>{map.getCanvas().style.cursor=''});
    const resizeObserver=new ResizeObserver(()=>map.resize());
    resizeObserver.observe(hostRef.current);

    return()=>{
      cancelled=true;
      clearTimeout(fallbackTimer);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current=null;
    };
  },[styleUrl]);

  useEffect(()=>{
    const map=mapRef.current;
    if(!map||!map.isStyleLoaded())return;
    ['vtab-labels','vtab-points','vtab-cluster-count','vtab-clusters','vtab-heat','vtab-path','vtab-geometry-line','vtab-fill'].forEach(id=>{if(map.getLayer(id))map.removeLayer(id)});
    ['vtab-paths','vtab-geometry','vtab-points'].forEach(id=>{if(map.getSource(id))map.removeSource(id)});
    try{
      addVisualLayers(map,visual,data);
      if(visual.format.mapAutoFit!==false)fit();
    }catch(error:any){
      setNotice(error?.message||'Map data could not be rendered.');
    }
  },[data,visual.format.mapMode,visual.format.mapLayers,visual.format.mapClustering,visual.format.mapClusterRadius,visual.format.mapMarkerColor,visual.format.mapMarkerOpacity,visual.format.mapMarkerSize,visual.format.mapMarkerMinSize,visual.format.mapMarkerMaxSize,visual.format.mapFillColor,visual.format.mapFillOpacity,visual.format.mapLineColor,visual.format.mapLineWidth,visual.format.mapLineOpacity,visual.format.mapLabels,visual.format.mapLabelColor,visual.format.mapLabelSize,visual.format.mapAllowOverlap,fit]);

  const pointCount=data.points.features.length,shapeCount=data.geometry.features.length,pathCount=data.paths.features.length;
  const colorField=visual.bindings.color?.[0]||visual.bindings.legend?.[0];
  const legendItems=colorField?Array.from(new Set(rows.map(row=>String(getRowVal(row,colorField)??'')).filter(Boolean))).slice(0,20):[];

  return <div className="vtabMapVisual">
    <div ref={hostRef} className="vtabMapCanvas"/>
    {!ready&&<div className="vtabMapStatus">Loading map…</div>}
    {ready&&!pointCount&&!shapeCount&&!pathCount&&<div className="vtabMapStatus"><LocateFixed size={22}/><b>No mapped locations</b><span>Add latitude and longitude, a location, or geometry.</span></div>}
    <div className="vtabMapActions">
      <button title="Fit all mapped data" onClick={fit}><LocateFixed size={14}/></button>
      <button title="Reset map view" onClick={()=>{const map=mapRef.current;if(map)map.easeTo({center:[visual.format.mapCenterLongitude??0,visual.format.mapCenterLatitude??20],zoom:visual.format.mapZoom??1.2})}}><RotateCcw size={14}/></button>
    </div>
    {visual.format.legendVisible!==false&&legendItems.length>0&&<div className={`vtabMapLegend position-${visual.format.legendPosition||'bottom'}`}><b>{visual.format.mapLegendTitle||String(colorField).replace(/^.*\./,'')}</b>{legendItems.map(item=><span key={item}><i style={{background:hashColor(item)}}/>{item}</span>)}</div>}
    {notice&&<div className="vtabMapNotice" title={notice}><TriangleAlert size={13}/><span>{notice}</span><button onClick={()=>setNotice('')}>×</button></div>}
    <div className="vtabMapSummary">{pointCount} points{shapeCount?` · ${shapeCount} shapes`:''}{pathCount?` · ${pathCount} paths`:''}</div>
  </div>;
}
