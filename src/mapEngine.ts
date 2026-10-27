import countries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';
import {geoEquirectangular} from 'd3-geo';
import {geoProject} from 'd3-geo-projection';
import {feature as topoFeature} from 'topojson-client';
import worldTopology from 'world-atlas/countries-50m.json';
import admin1Source from './assets/maps/natural-earth-admin1.json';
import indiaAdm1Source from './assets/maps/geoboundaries-ind-adm1.json';
import indiaAdm2Source from './assets/maps/geoboundaries-ind-adm2.json';
import {resolveLocalMapLocation} from './mapGeography';
import {formatNumber} from './formatting';
import type {Visual} from './types';

countries.registerLocale(enLocale as any);

export type MapTooltipEntry=[string,any];
export type PreparedMapPoint={
  id:string;name:string;value:[number,number,number];color:string;radius:number;
  selectionField?:string;selectionValue?:any;tooltip:MapTooltipEntry[];row:any;
};
export type PreparedMapRegion={
  name:string;value?:number;category?:string;color:string;rows:any[];
  selectionField?:string;selectionValue?:any;tooltip:MapTooltipEntry[];
};
export type PreparedMapPath={name:string;coords:[number,number][];color:string;selectionField?:string;selectionValue?:any};
export type PreparedMapData={
  mapName:string;geoJson:any;points:PreparedMapPoint[];regions:PreparedMapRegion[];paths:PreparedMapPath[];
  unmatched:string[];hasPointPayload:boolean;numericDomain?:[number,number];colorField?:string;valueField?:string;
  categoryLegend:Array<{label:string;color:string}>;featureNames:string[];geographyLevel:'country'|'region'|'custom';
};

const palette=['#118dff','#12239e','#e66c37','#6b007b','#e044a7','#744ec2','#d9b300','#d64550','#197278','#1aab40'];
const normalize=(value:any)=>String(value??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();
const finite=(value:any)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined};
export const mapValue=(row:any,field?:string)=>{
  if(!row||!field)return undefined;
  if(row[field]!==undefined)return row[field];
  const short=field.replace(/^(field:|numericField:|hierarchy:|measure:)/,'').split('.').pop()||field;
  if(row[short]!==undefined)return row[short];
  const target=normalize(short),key=Object.keys(row).find(item=>normalize(item)===target||normalize(item.split('.').pop())===target);
  return key?row[key]:undefined;
};
const hashColor=(value:any)=>{const text=String(value??'');let hash=0;for(let i=0;i<text.length;i++)hash=((hash<<5)-hash+text.charCodeAt(i))|0;return palette[Math.abs(hash)%palette.length]};
const cssColor=(value:any)=>typeof value==='string'&&/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(value.trim())?value.trim():undefined;
const readHex=(value:string)=>{const clean=(value||'').replace('#','');const hex=clean.length===3?clean.split('').map(x=>x+x).join(''):clean;return[0,2,4].map(offset=>Number.parseInt(hex.slice(offset,offset+2),16)||0)};
export const mixMapColor=(from:string,to:string,ratio:number)=>{const a=readHex(from),b=readHex(to),t=Math.max(0,Math.min(1,ratio));return'#'+a.map((value,index)=>Math.round(value+(b[index]-value)*t).toString(16).padStart(2,'0')).join('')};
const parseGeometry=(value:any)=>{if(!value)return undefined;try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed?.type==='Feature'?parsed:parsed?.type&&parsed?.coordinates?{type:'Feature',properties:{},geometry:parsed}:undefined}catch{return undefined}};

// ECharts applies its own screen-space Y transform. D3's default projected Y
// axis already points down, so registering that output used to invert the map.
// Keep north positive in the registered coordinates and let ECharts perform the
// single screen-space flip.
const MAP_PROJECTION=geoEquirectangular().reflectY(true).scale(100).translate([0,0]).precision(.1);
export const projectMapCoordinate=(longitude:number,latitude:number):[number,number]=>{
  const projected=MAP_PROJECTION([longitude,latitude]);return projected?[projected[0],projected[1]]:[longitude,latitude];
};
const WORLD_SOURCE:any=topoFeature(worldTopology as any,(worldTopology as any).objects.countries);
const WORLD_NAMED:any={
  type:'FeatureCollection',
  features:(WORLD_SOURCE.features||[]).map((item:any)=>({...item,properties:{...(item.properties||{}),name:item.properties?.name||String(item.id)}}))
};
// Project through D3's geographic stream instead of mapping coordinates by hand.
// The stream clips/splits polygons at the antimeridian, which prevents Russia,
// Fiji and Antarctica from producing the full-width horizontal artifacts that
// affected the former SVG renderer.
export const WORLD_GEOJSON:any=geoProject(WORLD_NAMED,MAP_PROJECTION as any);

const ADMIN1_NAMED:any={
  type:'FeatureCollection',
  features:(admin1Source as any).features.map((item:any,index:number)=>{
    const properties=item.properties||{},region=String(properties.name_en||properties.name||`Region ${index+1}`),country=String(properties.admin||properties.adm0_a3||'');
    return{...item,properties:{...properties,name:`${region}, ${country}`,displayName:region,country}};
  })
};
export const ADMIN1_GEOJSON:any=geoProject(ADMIN1_NAMED,MAP_PROJECTION as any);
const admin1FeatureByAlias=new Map<string,string>();
const admin1AliasesByPlainName=new Map<string,Set<string>>();
for(const feature of ADMIN1_GEOJSON.features){
  const properties=feature.properties||{},key=String(properties.name),plain=String(properties.displayName||''),country=String(properties.country||''),iso=String(properties.iso_3166_2||''),countryCode=String(properties.adm0_a3||'');
  const aliases=[plain,properties.name,properties.name_en,...String(properties.name_alt||'').split('|'),iso];
  for(const alias of aliases.filter(Boolean)){
    const normalized=normalize(alias);if(!normalized)continue;
    const matches=admin1AliasesByPlainName.get(normalized)||new Set<string>();matches.add(key);admin1AliasesByPlainName.set(normalized,matches);
    if(country)admin1FeatureByAlias.set(`${normalized}|${normalize(country)}`,key);
    if(countryCode)admin1FeatureByAlias.set(`${normalized}|${normalize(countryCode)}`,key);
  }
}
export function resolveAdmin1FeatureName(value:any,country?:any):string|undefined{
  const normalized=normalize(value);if(!normalized)return undefined;
  const countryKey=normalize(country);
  if(countryKey){const contextual=admin1FeatureByAlias.get(`${normalized}|${countryKey}`);if(contextual)return contextual}
  const matches=admin1AliasesByPlainName.get(normalized);return matches?.size===1?Array.from(matches)[0]:undefined;
}

export function mapGeometryBounds(geoJson:any,featureNames?:string[]):[[number,number],[number,number]]|undefined{
  const wanted=featureNames?.length?new Set(featureNames):undefined;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,count=0;
  const visit=(coordinates:any)=>{if(!Array.isArray(coordinates))return;if(coordinates.length>=2&&typeof coordinates[0]==='number'&&typeof coordinates[1]==='number'){const x=Number(coordinates[0]),y=Number(coordinates[1]);if(Number.isFinite(x)&&Number.isFinite(y)){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);count++}}else coordinates.forEach(visit)};
  for(const feature of geoJson?.features||[]){const name=String(feature?.properties?.name??feature?.id??'');if(!wanted||wanted.has(name))visit(feature?.geometry?.coordinates)}
  if(!count)return undefined;
  // ECharts boundingCoords are top-left then bottom-right.
  return[[minX,maxY],[maxX,minY]];
}

const worldFeatureByAlias=new Map<string,string>();
const worldFeatureByName=new Map<string,any>();
for(const item of WORLD_GEOJSON.features){
  const featureName=String(item.properties.name);worldFeatureByName.set(featureName,item);
  const numeric=String(item.id||'').padStart(3,'0');
  const alpha2=countries.numericToAlpha2(numeric),alpha3=alpha2?countries.alpha2ToAlpha3(alpha2):undefined;
  [featureName,numeric,alpha2,alpha3,alpha2?countries.getName(alpha2,'en'):undefined].filter(Boolean).forEach(value=>worldFeatureByAlias.set(normalize(value),featureName));
}
const COUNTRY_ALIASES:Record<string,string>={
  us:'United States of America',usa:'United States of America','united states':'United States of America','u s a':'United States of America',
  uk:'United Kingdom',gb:'United Kingdom',gbr:'United Kingdom','great britain':'United Kingdom',
  ru:'Russia',rus:'Russia','russian federation':'Russia',kr:'South Korea',kor:'South Korea','republic of korea':'South Korea',
  kp:'North Korea',prk:'North Korea','democratic peoples republic of korea':'North Korea',
  vn:'Vietnam',vnm:'Vietnam','viet nam':'Vietnam',la:'Laos',lao:'Laos',ir:'Iran',irn:'Iran',
  sy:'Syria',syr:'Syria',bo:'Bolivia',bol:'Bolivia',tz:'Tanzania',tza:'Tanzania',
  ci:"Côte d'Ivoire",civ:"Côte d'Ivoire",'ivory coast':"Côte d'Ivoire",cd:'Dem. Rep. Congo',cod:'Dem. Rep. Congo',
  cg:'Congo',cog:'Congo',cz:'Czechia',cze:'Czechia','czech republic':'Czechia',
  tw:'Taiwan',twn:'Taiwan',ps:'Palestine',pse:'Palestine',sz:'eSwatini',swz:'eSwatini','eswatini':'eSwatini',
  mm:'Myanmar',mmr:'Myanmar','burma':'Myanmar',mk:'North Macedonia',mkd:'North Macedonia',
  va:'Vatican',vat:'Vatican',xk:'Kosovo',kos:'Kosovo'
};
for(const [alias,name] of Object.entries(COUNTRY_ALIASES)){const actual=worldFeatureByAlias.get(normalize(name))||name;worldFeatureByAlias.set(normalize(alias),actual)}

export function resolveWorldFeatureName(value:any):string|undefined{
  const raw=String(value??'').trim();if(!raw)return undefined;
  const direct=worldFeatureByAlias.get(normalize(raw));if(direct)return direct;
  const alpha2=raw.length===2?raw.toUpperCase():countries.getAlpha2Code(raw,'en');
  const alpha3=raw.length===3?raw.toUpperCase():undefined;
  return worldFeatureByAlias.get(normalize(alpha2))||worldFeatureByAlias.get(normalize(alpha3));
}

export function resolveCountryIso3(value:any):string|undefined{
  const raw=String(value??'').trim();if(!raw)return undefined;
  if(/^[a-z]{3}$/i.test(raw))return raw.toUpperCase();
  const alpha2=/^[a-z]{2}$/i.test(raw)?raw.toUpperCase():countries.getAlpha2Code(raw,'en');
  return alpha2?countries.alpha2ToAlpha3(alpha2):undefined;
}

function centroid(geometry:any):[number,number]|undefined{
  let sx=0,sy=0,count=0;
  const walk=(coordinates:any)=>{if(!Array.isArray(coordinates))return;if(coordinates.length>=2&&typeof coordinates[0]==='number'&&typeof coordinates[1]==='number'){const lon=Number(coordinates[0]),lat=Number(coordinates[1]);if(Number.isFinite(lon)&&Number.isFinite(lat)){sx+=lon;sy+=lat;count++}}else coordinates.forEach(walk)};
  walk(geometry?.coordinates);return count?[sx/count,sy/count]:undefined;
}
const worldCentroids=new Map<string,[number,number]>(WORLD_GEOJSON.features.map((item:any)=>[String(item.properties.name),centroid(item.geometry)||[0,0]]));
const admin1Centroids=new Map<string,[number,number]>(ADMIN1_GEOJSON.features.map((item:any)=>[String(item.properties.name),centroid(item.geometry)||[0,0]]));

function customGeography(visual:Visual,rows:any[],geometryField?:string,joinField?:string){
  const imported=visual.format.mapCustomGeometry?.type==='FeatureCollection'?visual.format.mapCustomGeometry:undefined;
  const rowFeatures=geometryField?rows.map((row,index)=>{const parsed=parseGeometry(mapValue(row,geometryField));return parsed?{...parsed,properties:{...(parsed.properties||{}),__rowIndex:index}}:undefined}).filter(Boolean):[];
  const source=imported||rowFeatures.length?{type:'FeatureCollection',features:imported?.features||rowFeatures}:undefined;
  if(!source)return undefined;
  const joinProperty=visual.format.mapGeometryJoinProperty;
  const aliases=new Map<string,string>();
  const features=source.features.map((item:any,index:number)=>{
    const rawName=item.properties?.[joinProperty||'']??item.properties?.name??item.properties?.NAME??item.properties?.Name??item.id??`Area ${index+1}`;
    const name=String(rawName);aliases.set(normalize(rawName),name);
    return{...item,properties:{...(item.properties||{}),name}};
  });
  const projected=geoProject({type:'FeatureCollection',features} as any,MAP_PROJECTION as any) as any;
  return{mapName:`vtab-custom-${visual.id}`,geoJson:projected,resolve:(value:any)=>aliases.get(normalize(value)),featureNames:features.map((item:any)=>String(item.properties.name)),joinField};
}

function thresholdStops(visual:Visual){
  return String(visual.format.mapThresholds||'').split(',').map(item=>{const separator=item.indexOf(':');if(separator<0)return undefined;const value=Number(item.slice(0,separator).trim()),color=item.slice(separator+1).trim();return Number.isFinite(value)&&/^#[0-9a-f]{3,8}$/i.test(color)?{value,color}:undefined}).filter((item):item is {value:number;color:string}=>!!item).sort((a,b)=>a.value-b.value);
}
function colorForValue(visual:Visual,value:number,min:number,max:number){
  const low=visual.format.mapMinColor||visual.format.negativeColor||'#d64550';
  const high=visual.format.mapMaxColor||visual.format.positiveColor||'#1aab40';
  const mid=visual.format.mapMidColor||'#facc15';
  if(visual.format.mapColorScale==='rules'){
    const lowLimit=visual.format.mapRuleLow??min+(max-min)/3,highLimit=visual.format.mapRuleHigh??min+(max-min)*2/3;
    return value<=lowLimit?(visual.format.mapRuleLowColor||'#d64550'):value>=highLimit?(visual.format.mapRuleHighColor||'#1aab40'):(visual.format.mapRuleMidColor||'#facc15');
  }
  if(visual.format.mapColorScale==='threshold'){const stops=thresholdStops(visual);return(stops.filter(stop=>value>=stop.value).pop()||stops[0])?.color||high}
  const ratio=max===min?.5:(value-min)/(max-min);
  return['measure','diverging'].includes(visual.format.mapColorScale||'measure')?(ratio<=.5?mixMapColor(low,mid,ratio*2):mixMapColor(mid,high,(ratio-.5)*2)):mixMapColor(low,high,ratio);
}

type ProjectedPoint=[number,number];
function outerPolygonRings(geometry:any):ProjectedPoint[][]{
  if(geometry?.type==='Polygon')return geometry.coordinates?.[0]?[geometry.coordinates[0] as ProjectedPoint[]]:[];
  if(geometry?.type==='MultiPolygon')return(geometry.coordinates||[]).map((polygon:any)=>polygon?.[0] as ProjectedPoint[]).filter((ring:any)=>Array.isArray(ring));
  return[];
}

type AdministrativeBoundaryLayer={mapName:string;geoJson:any;featureNames:string[];source:'geoBoundaries';level:string;countryIso3:string};
const administrativeBoundaryCache=new Map<string,Promise<AdministrativeBoundaryLayer>>();
const boundaryName=(feature:any,index:number)=>String(feature?.properties?.shapeName??feature?.properties?.name??feature?.id??`Area ${index+1}`);
const signedRingArea=(ring:any[])=>ring.reduce((area,point,index)=>{const previous=ring[(index+ring.length-1)%ring.length];return area+Number(previous?.[0]||0)*Number(point?.[1]||0)-Number(point?.[0]||0)*Number(previous?.[1]||0)},0)/2;
const rewindPolygon=(polygon:any[])=>polygon.map((ring,index)=>{const shouldBeClockwise=index===0,isClockwise=signedRingArea(ring)<0;return shouldBeClockwise===isClockwise?ring:[...ring].reverse()});
function rewindBoundaryGeometry(geometry:any){if(geometry?.type==='Polygon')return{...geometry,coordinates:rewindPolygon(geometry.coordinates||[])};if(geometry?.type==='MultiPolygon')return{...geometry,coordinates:(geometry.coordinates||[]).map(rewindPolygon)};return geometry}
function projectAdministrativeBoundaries(source:any,countryIso3:string,level:string):AdministrativeBoundaryLayer{
  // geoBoundaries follows RFC 7946's counter-clockwise exterior convention;
  // d3's spherical projector expects clockwise exterior rings. Rewind before
  // projection or each district is interpreted as the entire world minus itself.
  const named={type:'FeatureCollection',features:(source?.features||[]).map((feature:any,index:number)=>({...feature,properties:{...(feature.properties||{}),name:boundaryName(feature,index)},geometry:rewindBoundaryGeometry(feature.geometry)}))};
  const geoJson=geoProject(named as any,MAP_PROJECTION as any) as any;
  return{mapName:`vtab-geoboundaries-${countryIso3}-${level}`,geoJson,featureNames:geoJson.features.map((feature:any)=>String(feature.properties.name)),source:'geoBoundaries',level,countryIso3};
}
export function loadAdministrativeBoundaries(country:any,level='ADM2'):Promise<AdministrativeBoundaryLayer>{
  const countryIso3=resolveCountryIso3(country);if(!countryIso3)return Promise.reject(new Error(`Unknown country: ${country}`));
  const key=`${countryIso3}-${level.toUpperCase()}`,existing=administrativeBoundaryCache.get(key);if(existing)return existing;
  const request=(async()=>{
    if(countryIso3==='IND'&&level.toUpperCase()==='ADM1')return projectAdministrativeBoundaries(indiaAdm1Source,countryIso3,'ADM1');
    if(countryIso3==='IND'&&level.toUpperCase()==='ADM2')return projectAdministrativeBoundaries(indiaAdm2Source,countryIso3,'ADM2');
    const metadataResponse=await fetch(`https://www.geoboundaries.org/api/current/gbOpen/${countryIso3}/${level.toUpperCase()}/`,{cache:'force-cache'});
    if(!metadataResponse.ok)throw new Error(`Administrative boundary metadata returned ${metadataResponse.status}`);
    const metadata=await metadataResponse.json(),url=metadata.simplifiedGeometryGeoJSON||metadata.gjDownloadURL;
    if(!url)throw new Error(`No ${level.toUpperCase()} boundary geometry is published for ${countryIso3}`);
    const geometryResponse=await fetch(url,{cache:'force-cache'});if(!geometryResponse.ok)throw new Error(`Administrative boundary geometry returned ${geometryResponse.status}`);
    return projectAdministrativeBoundaries(await geometryResponse.json(),countryIso3,level.toUpperCase());
  })();
  administrativeBoundaryCache.set(key,request);request.catch(()=>administrativeBoundaryCache.delete(key));return request;
}
function ringContains(point:ProjectedPoint,ring:ProjectedPoint[]){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j],cross=(a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1]||Number.EPSILON)+a[0];if(cross)inside=!inside}return inside}
function geometryContains(point:ProjectedPoint,geometry:any){
  const polygonContains=(polygon:any[])=>Array.isArray(polygon?.[0])&&ringContains(point,polygon[0])&&!polygon.slice(1).some(ring=>ringContains(point,ring));
  if(geometry?.type==='Polygon')return polygonContains(geometry.coordinates||[]);
  if(geometry?.type==='MultiPolygon')return(geometry.coordinates||[]).some(polygonContains);
  return false;
}
function geometrySamples(geometry:any):ProjectedPoint[]{
  const rings=outerPolygonRings(geometry),points=rings.flatMap(ring=>ring.filter((_,index)=>index%Math.max(1,Math.floor(ring.length/12))===0));
  const centroids=rings.map(ring=>{let area=0,x=0,y=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const cross=ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];area+=cross;x+=(ring[j][0]+ring[i][0])*cross;y+=(ring[j][1]+ring[i][1])*cross}const factor=area?1/(3*area):0;return{area:Math.abs(area/2),point:(area?[x*factor,y*factor]:ring[0]) as ProjectedPoint}}).filter(item=>item.point);
  const center=centroids.sort((a,b)=>b.area-a.area)[0]?.point;
  return center?[center,...points]:points;
}
const canonicalAdministrativeName=(value:any)=>normalize(value).replace(/\b(city|district|county|municipality|municipal corporation|metro|metropolitan|division|province|prefecture|department|parish|borough)\b/g,' ').replace(/\s+/g,' ').trim();
export function buildAdministrativePartitionMap(seed:string,parentGeoJson:any,parentFeatureName:string|undefined,childLayer:AdministrativeBoundaryLayer,points:PreparedMapPoint[],locationField?:string){
  if(!parentFeatureName||!locationField)return undefined;
  const requestedParent=canonicalAdministrativeName(parentFeatureName),parent=parentGeoJson?.features?.find((feature:any)=>canonicalAdministrativeName(feature.properties?.name)===requestedParent);if(!parent)return undefined;
  // Assign each ADM2 feature to the ADM1 feature containing the largest share
  // of its sampled outline. This is stable at shared borders and avoids both
  // dropping edge districts and admitting a neighbouring state's districts.
  const parents=parentGeoJson?.features||[],children=(childLayer.geoJson?.features||[]).filter((feature:any)=>{const samples=geometrySamples(feature.geometry).slice(1);if(!samples.length)return false;let best:any,bestHits=0;for(const candidate of parents){const hits=samples.filter(sample=>geometryContains(sample,candidate.geometry)).length;if(hits>bestHits){best=candidate;bestHits=hits}}return!!best&&canonicalAdministrativeName(best.properties?.name)===requestedParent});
  if(!children.length)return undefined;
  const aliases=new Map<string,any>();children.forEach((feature:any)=>{const name=String(feature.properties?.name||''),key=canonicalAdministrativeName(name);if(key)aliases.set(key,feature)});
  const grouped=new Map<string,PreparedMapPoint[]>();points.forEach(point=>{const raw=mapValue(point.row,locationField),key=canonicalAdministrativeName(raw);if(key)grouped.set(key,[...(grouped.get(key)||[]),point])});
  const sites=Array.from(grouped.entries()).map(([key,items])=>{const exact=aliases.get(key),feature=exact||children.find((candidate:any)=>{const candidateKey=canonicalAdministrativeName(candidate.properties?.name);return candidateKey.includes(key)||key.includes(candidateKey)});if(!feature)return undefined;return{key,name:String(feature.properties.name),selectionValue:mapValue(items[0].row,locationField),items,coordinate:[items.reduce((sum,item)=>sum+item.value[0],0)/items.length,items.reduce((sum,item)=>sum+item.value[1],0)/items.length] as ProjectedPoint}}).filter(Boolean) as Array<{key:string;name:string;selectionValue:any;items:PreparedMapPoint[];coordinate:ProjectedPoint}>;
  const hash=Array.from(`${childLayer.mapName}|${parentFeatureName}`).reduce((value,char)=>((value*31+char.charCodeAt(0))>>>0),2166136261).toString(36);
  return{mapName:`vtab-admin-child-${String(seed).replace(/[^a-z0-9_-]/gi,'-')}-${hash}`,geoJson:{type:'FeatureCollection',features:children},featureNames:children.map((feature:any)=>String(feature.properties.name)),sites,source:childLayer.source,level:childLayer.level,unmatched:Array.from(grouped.keys()).filter(key=>!sites.some(site=>site.key===key))};
}

export function prepareMapData(visual:Visual,rows:any[]):PreparedMapData{
  const b=visual.bindings;
  const countryField=b.country?.[0],regionField=b.region?.[0],postalCodeField=b.postalCode?.[0];
  const locationField=b.location?.[0]||postalCodeField||regionField||countryField||b.axis?.[0];
  const geographyField=regionField||countryField||locationField,latitudeField=b.latitude?.[0],longitudeField=b.longitude?.[0],geometryField=b.geometry?.[0];
  const detailField=b.detail?.[0],labelField=b.label?.[0],explicitColorField=b.color?.[0]||b.legend?.[0],pathField=b.path?.[0],tooltipFields=b.tooltips||[];
  const detailValues=detailField?rows.map(row=>mapValue(row,detailField)).filter(value=>value!==undefined&&value!==null&&String(value).trim()!==''):[];
  const detailIsNumeric=!!detailField&&detailValues.length>0&&detailValues.every(value=>finite(value)!==undefined);
  // A numeric Detail is the primary color measure and also the bubble-size
  // fallback. An explicit Bubble size field can independently override size.
  const valueField=b.size?.[0]||b.values?.[0]||(detailIsNumeric?detailField:undefined);
  // Map coloring has one exclusive workflow:
  // - Measure: an explicit color-returning measure in bindings.color.
  // - Rules: a numeric measure (normally Detail) evaluated against low/mid/high.
  const colorField=explicitColorField||(visual.format.mapColorScale==='rules'?(detailIsNumeric?detailField:valueField):undefined);
  const custom=customGeography(visual,rows,geometryField,locationField);
  const useAdmin1=!custom&&!!regionField;
  const mapName=custom?.mapName||(useAdmin1?'vtab-admin1-50m':'vtab-world-50m'),geoJson=custom?.geoJson||(useAdmin1?ADMIN1_GEOJSON:WORLD_GEOJSON),featureNames=custom?.featureNames||(useAdmin1?ADMIN1_GEOJSON.features.map((feature:any)=>String(feature.properties.name)):Array.from(worldFeatureByName.keys()));
  const geographyLevel:PreparedMapData['geographyLevel']=custom?'custom':useAdmin1?'region':'country';
  const resolveFeature=(value:any,row?:any)=>custom?custom.resolve(value):(useAdmin1?resolveAdmin1FeatureName(value,countryField?mapValue(row,countryField):undefined):resolveWorldFeatureName(value));
  // A bound city/location is itself a meaningful point payload. Previously a
  // location without an extra Detail/Size field was resolved but then hidden.
  const hasPointPayload=!!(locationField||latitudeField||longitudeField||detailField||valueField||colorField||labelField||tooltipFields.length||pathField);
  const valueNumbers=rows.map(row=>finite(valueField?mapValue(row,valueField):undefined)).filter((value):value is number=>value!==undefined);
  const colorNumbers=rows.map(row=>finite(colorField?mapValue(row,colorField):undefined)).filter((value):value is number=>value!==undefined);
  const numericDomainValues=colorNumbers.length===rows.length&&rows.length?colorNumbers:valueNumbers;
  const min=numericDomainValues.length?Math.min(...numericDomainValues):0,max=numericDomainValues.length?Math.max(...numericDomainValues):1;
  const sizes=valueNumbers,sizeMin=sizes.length?Math.min(...sizes):0,sizeMax=sizes.length?Math.max(...sizes):1;
  const regionGroups=new Map<string,any[]>(),unmatched=new Set<string>();
  rows.forEach(row=>{
    const raw=mapValue(row,geographyField),name=resolveFeature(raw,row);
    if(name)regionGroups.set(name,[...(regionGroups.get(name)||[]),row]);else if(raw!==undefined&&String(raw).trim())unmatched.add(String(raw));
  });
  const regionMetricValues=Array.from(regionGroups.values()).map(groupRows=>{
    const metricField=colorNumbers.length===rows.length&&colorField?colorField:valueField;
    const values=groupRows.map(row=>finite(metricField?mapValue(row,metricField):undefined)).filter((value):value is number=>value!==undefined);
    return values.length?values.reduce((sum,item)=>sum+item,0):undefined;
  }).filter((value):value is number=>value!==undefined);
  const regionMin=regionMetricValues.length?Math.min(...regionMetricValues):min,regionMax=regionMetricValues.length?Math.max(...regionMetricValues):max;
  const regions:PreparedMapRegion[]=Array.from(regionGroups.entries()).map(([name,groupRows])=>{
    const numeric=groupRows.map(row=>finite(valueField?mapValue(row,valueField):undefined)).filter((value):value is number=>value!==undefined);
    const value=numeric.length?numeric.reduce((sum,item)=>sum+item,0):undefined;
    const rawCategory=colorField?mapValue(groupRows[0],colorField):undefined,customColor=cssColor(rawCategory),category=!customColor&&rawCategory!==undefined&&(visual.format.mapColorScale==='categorical'||!Number.isFinite(Number(rawCategory)))?String(rawCategory):undefined;
    const metric=colorNumbers.length===rows.length&&colorField?groupRows.map(row=>finite(mapValue(row,colorField))||0).reduce((sum,item)=>sum+item,0):value;
    const color=customColor||((category?hashColor(category):visual.format.mapColorScale==='rules'&&metric!==undefined?colorForValue(visual,metric,regionMin,regionMax):(visual.format.mapFillColor||visual.format.accent||'#118dff')));
    const fields=[geographyField,countryField,regionField,colorField,valueField,...tooltipFields].filter((field,index,array):field is string=>!!field&&array.indexOf(field)===index);
    const tooltip=fields.map(field=>{const values=groupRows.map(row=>mapValue(row,field)).filter(item=>item!==undefined&&item!==null&&String(item).trim()!=='');const numbers=values.map(finite).filter((item):item is number=>item!==undefined);const aggregate=field!==geographyField&&numbers.length===values.length&&numbers.length?numbers.reduce((sum,item)=>sum+item,0):values[0];return[field,aggregate] as MapTooltipEntry});
    return{name,value,category,color,rows:groupRows,selectionField:geographyField,selectionValue:mapValue(groupRows[0],geographyField),tooltip};
  });
  const points:PreparedMapPoint[]=[];
  rows.forEach((row,index)=>{
    let latitude=finite(latitudeField?mapValue(row,latitudeField):(mapValue(row,'latitude')??mapValue(row,'lat')));
    let longitude=finite(longitudeField?mapValue(row,longitudeField):(mapValue(row,'longitude')??mapValue(row,'lon')??mapValue(row,'lng')));
    const place=mapValue(row,locationField||regionField||countryField),countryValue=countryField?mapValue(row,countryField):undefined,regionValue=regionField?mapValue(row,regionField):undefined,postalCodeValue=postalCodeField?mapValue(row,postalCodeField):undefined,hasDirectCoordinates=latitude!==undefined&&longitude!==undefined;
    if(hasDirectCoordinates&&(latitude! < -90||latitude! > 90||longitude! < -180||longitude! > 180))return;
    let coordinatesProjected=false;
    if(latitude===undefined||longitude===undefined){
      const adminFeature=resolveAdmin1FeatureName(regionValue??place,countryValue),worldFeature=resolveWorldFeatureName(countryValue??place),featureCenter=adminFeature?admin1Centroids.get(adminFeature):worldFeature?worldCentroids.get(worldFeature):undefined;
      const correction=visual.format.mapLocationCorrections?.[normalize(place)],local=resolveLocalMapLocation(String(place??''),{country:countryValue,region:regionValue,postalCode:postalCodeValue});
      if(correction){const projected=projectMapCoordinate(correction.longitude,correction.latitude);longitude=projected[0];latitude=projected[1];coordinatesProjected=true}
      else{const projectedLocal=local?projectMapCoordinate(local.longitude,local.latitude):undefined;longitude=featureCenter?.[0]??projectedLocal?.[0];latitude=featureCenter?.[1]??projectedLocal?.[1];coordinatesProjected=!!featureCenter||!!projectedLocal}
    }
    if(latitude===undefined||longitude===undefined)return;
    if(place!==undefined&&String(place).trim())unmatched.delete(String(place));
    const rawSize=finite(valueField?mapValue(row,valueField):undefined),ratio=rawSize===undefined?.5:sizeMax===sizeMin?.5:Math.sqrt(Math.max(0,(rawSize-sizeMin)/(sizeMax-sizeMin)));
    const minRadius=visual.format.mapMarkerMinSize??5,maxRadius=Math.max(minRadius,visual.format.mapMarkerMaxSize??24),radius=rawSize===undefined?(visual.format.mapMarkerSize??9):minRadius+ratio*(maxRadius-minRadius);
    const rawColor=colorField?mapValue(row,colorField):undefined,numericColor=finite(rawColor),color=cssColor(rawColor)|| (visual.format.mapColorScale==='rules'&&numericColor!==undefined?colorForValue(visual,numericColor,min,max):rawColor!==undefined?hashColor(rawColor):(visual.format.mapMarkerColor||visual.format.accent||'#118dff'));
    const label=String((labelField?mapValue(row,labelField):undefined)??(!detailIsNumeric&&detailField?mapValue(row,detailField):undefined)??place??'');
    const selectionField=detailField||locationField||regionField||countryField||colorField;
    const fields=[locationField,regionField,countryField,postalCodeField,detailField,colorField,valueField,...tooltipFields].filter((field,fieldIndex,array):field is string=>!!field&&array.indexOf(field)===fieldIndex);
    const projected=coordinatesProjected?[longitude,latitude] as [number,number]:projectMapCoordinate(longitude,latitude);
    points.push({id:`point-${index}`,name:label,value:[projected[0],projected[1],rawSize??1],color,radius,row,selectionField,selectionValue:selectionField?mapValue(row,selectionField):undefined,tooltip:fields.map(field=>[field,mapValue(row,field)])});
  });
  const pathGroups=new Map<string,PreparedMapPoint[]>();
  if(pathField)points.forEach(point=>{const key=String(mapValue(point.row,pathField)??'Route');pathGroups.set(key,[...(pathGroups.get(key)||[]),point])});
  const paths:Array<PreparedMapPath>=Array.from(pathGroups.entries()).filter(([,items])=>items.length>1).map(([name,items])=>({name,coords:items.map(item=>[item.value[0],item.value[1]]),color:visual.format.mapLineColor||'#118dff',selectionField:pathField,selectionValue:name}));
  const compact=(value:number)=>formatNumber(value,{displayUnits:visual.format.displayUnits||'auto',decimals:visual.format.displayUnitDecimals??2});
  const categories=Array.from(new Set(regions.map(item=>item.category).filter((value):value is string=>!!value))),thresholdLegend=visual.format.mapColorScale==='threshold'?thresholdStops(visual).map(stop=>({label:`≥ ${compact(stop.value)}`,color:stop.color})):[],rulesLegend=visual.format.mapColorScale==='rules'?[{label:`≤ ${compact(visual.format.mapRuleLow??0)}`,color:visual.format.mapRuleLowColor||'#d64550'},{label:`${compact(visual.format.mapRuleLow??0)} – ${compact(visual.format.mapRuleHigh??100)}`,color:visual.format.mapRuleMidColor||'#facc15'},{label:`≥ ${compact(visual.format.mapRuleHigh??100)}`,color:visual.format.mapRuleHighColor||'#1aab40'}]:[];
  const filledDomain=visual.format.mapColorScale==='rules'?((visual.format.mapMode==='filled'&&regionMetricValues.length)?[regionMin,regionMax] as [number,number]:numericDomainValues.length?[min,max] as [number,number]:undefined):undefined;
  const discreteLegend=rulesLegend.length?rulesLegend:thresholdLegend;
  return{mapName,geoJson,points,regions,paths,unmatched:Array.from(unmatched),hasPointPayload,numericDomain:discreteLegend.length?undefined:filledDomain,colorField,valueField,categoryLegend:discreteLegend.length?discreteLegend:categories.map(label=>({label,color:hashColor(label)})),featureNames,geographyLevel};
}

export function formatMapTooltip(entries:MapTooltipEntry[]){return entries.map(([field,value])=>({field:String(field),label:String(field).replace(/^(field:|numericField:|hierarchy:|measure:)/,'').split('.').pop()||String(field),value:value??'—'}))}
