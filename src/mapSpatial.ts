import proj4 from 'proj4';
import {feature as topoFeature} from 'topojson-client';

export type GeoFeatureCollection={type:'FeatureCollection';features:any[]};

const MAX_SPATIAL_BYTES=20*1024*1024;
const asCollection=(value:any):GeoFeatureCollection=>{
  if(value?.type==='FeatureCollection'&&Array.isArray(value.features))return value;
  if(value?.type==='Feature')return{type:'FeatureCollection',features:[value]};
  if(value?.type&&value?.coordinates)return{type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:value}]};
  throw new Error('The file does not contain supported geographic features.');
};

const walkCoordinates=(coordinates:any,visit:(position:number[])=>number[]):any=>{
  if(!Array.isArray(coordinates))return coordinates;
  if(coordinates.length>=2&&typeof coordinates[0]==='number'&&typeof coordinates[1]==='number')return visit(coordinates);
  return coordinates.map(item=>walkCoordinates(item,visit));
};

export function normalizeCrs(collection:GeoFeatureCollection,sourceCrs='EPSG:4326'):GeoFeatureCollection{
  if(!sourceCrs||sourceCrs.toUpperCase()==='EPSG:4326'||sourceCrs.toUpperCase()==='WGS84')return collection;
  return{type:'FeatureCollection',features:collection.features.map(feature=>({...feature,geometry:feature.geometry?{...feature.geometry,coordinates:walkCoordinates(feature.geometry.coordinates,(position)=>{
    const [longitude,latitude]=proj4(sourceCrs,'EPSG:4326',[Number(position[0]),Number(position[1])]);
    return[longitude,latitude,...position.slice(2)];
  })}:feature.geometry}))};
}

function parseKml(text:string):GeoFeatureCollection{
  const documentNode=new DOMParser().parseFromString(text,'application/xml');
  if(documentNode.querySelector('parsererror'))throw new Error('The KML file is not valid XML.');
  const readCoordinates=(node:Element|null)=>String(node?.textContent||'').trim().split(/\s+/).filter(Boolean).map(item=>item.split(',').slice(0,2).map(Number)).filter(position=>position.length===2&&position.every(Number.isFinite));
  const features:any[]=Array.from(documentNode.querySelectorAll('Placemark')).flatMap<any>((placemark,index):any[]=>{
    const properties:{[key:string]:any}={name:placemark.querySelector(':scope > name')?.textContent?.trim()||`Feature ${index+1}`};
    placemark.querySelectorAll('ExtendedData Data').forEach(node=>{const key=node.getAttribute('name');if(key)properties[key]=node.querySelector('value')?.textContent||''});
    const point=placemark.querySelector('Point > coordinates');
    if(point){const positions=readCoordinates(point);return positions[0]?[{type:'Feature',properties,geometry:{type:'Point',coordinates:positions[0]}}]:[]}
    const line=placemark.querySelector('LineString > coordinates');
    if(line){const positions=readCoordinates(line);return positions.length>1?[{type:'Feature',properties,geometry:{type:'LineString',coordinates:positions}}]:[]}
    const polygon=placemark.querySelector('Polygon outerBoundaryIs LinearRing > coordinates');
    if(polygon){const positions=readCoordinates(polygon);return positions.length>3?[{type:'Feature',properties,geometry:{type:'Polygon',coordinates:[positions]}}]:[]}
    return[];
  });
  return{type:'FeatureCollection',features};
}

export async function parseSpatialFile(file:File,sourceCrs='EPSG:4326'):Promise<GeoFeatureCollection>{
  if(file.size>MAX_SPATIAL_BYTES)throw new Error('Spatial files are limited to 20 MB. Use a simplified boundary file or vector-tile source for larger datasets.');
  const extension=file.name.split('.').pop()?.toLowerCase();
  let collection:GeoFeatureCollection;
  if(extension==='geojson'||extension==='json'){
    const parsed=JSON.parse(await file.text());
    if(parsed?.type==='Topology'){
      const objectName=Object.keys(parsed.objects||{})[0];
      if(!objectName)throw new Error('The TopoJSON file does not contain an object.');
      collection=asCollection(topoFeature(parsed,parsed.objects[objectName]));
    }else collection=asCollection(parsed);
  }else if(extension==='topojson'){
    const parsed=JSON.parse(await file.text());
    const objectName=Object.keys(parsed.objects||{})[0];
    if(!objectName)throw new Error('The TopoJSON file does not contain an object.');
    collection=asCollection(topoFeature(parsed,parsed.objects[objectName]));
  }else if(extension==='kml')collection=parseKml(await file.text());
  else if(extension==='zip'||extension==='shp'){
    const shpModule:any=await import('shpjs');
    const parsed=await (shpModule.default||shpModule).parseZip(await file.arrayBuffer());
    collection=asCollection(Array.isArray(parsed)?{type:'FeatureCollection',features:parsed.flatMap(item=>item.features||[])}:parsed);
  }else throw new Error('Choose GeoJSON, TopoJSON, KML, or a zipped shapefile.');
  collection=normalizeCrs(collection,sourceCrs);
  const valid=collection.features.filter(feature=>feature?.geometry?.type&&feature?.geometry?.coordinates);
  if(!valid.length)throw new Error('No valid geometry was found in this file.');
  if(valid.length>50000)throw new Error('This file contains more than 50,000 features. Simplify it or use a vector-tile source.');
  return{type:'FeatureCollection',features:valid};
}

