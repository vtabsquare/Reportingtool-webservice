import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundled=await build({
  entryPoints:['src/mapEngine.ts'],
  bundle:true,
  platform:'node',
  format:'esm',
  write:false,
  loader:{'.json':'json'},
});
const moduleUrl=`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
const engine=await import(moduleUrl);
const rows=[
  {Country:'India',State:'Tamil Nadu',City:'Chennai',Latitude:13.0827,Longitude:80.2707},
  {Country:'India',State:'Tamil Nadu',City:'Coimbatore',Latitude:11.0168,Longitude:76.9558},
  {Country:'India',State:'Tamil Nadu',City:'Madurai',Latitude:9.9252,Longitude:78.1198},
];
const visual={id:'runtime-visual',type:'map',bindings:{country:['Country'],region:['State'],location:['City'],latitude:['Latitude'],longitude:['Longitude']},format:{mapMode:'filled'}};
const prepared=engine.prepareMapData(visual,rows);
assert.equal(prepared.points.length,3,'all three bound city coordinates must become map points');
assert.equal(prepared.regions.length,1,'the source geography remains one selected state before city partitioning');
const locationOnlyVisual={id:'runtime-location-only',type:'map',bindings:{country:['Country'],region:['State'],location:['City']},format:{mapMode:'filled'}};
const locationOnlyPrepared=engine.prepareMapData(locationOnlyVisual,rows.map(({Country,State,City})=>({Country,State,City})));
assert.equal(locationOnlyPrepared.points.length,3,'offline city resolution must locate all three Tamil Nadu cities without bound coordinates');
const labelledVisual={id:'runtime-labelled',type:'map',bindings:{country:['Country'],region:['State'],location:['City'],label:['Series'],latitude:['Latitude'],longitude:['Longitude']},format:{mapMode:'filled'}};
const labelledPrepared=engine.prepareMapData(labelledVisual,rows.map(row=>({...row,Series:'Sales'})));
assert.equal(new Set(labelledPrepared.points.map(point=>point.name)).size,1,'the regression fixture must reproduce a shared display label');
const indiaStates=await engine.loadAdministrativeBoundaries('India','ADM1');
const indiaDistricts=await engine.loadAdministrativeBoundaries('India','ADM2');
const officialResult=engine.buildAdministrativePartitionMap('official-runtime-test',indiaStates.geoJson,'Tamil Nadu',indiaDistricts,prepared.points,'City');
assert.ok(officialResult,'official Tamil Nadu child boundaries must be available');
assert.equal(officialResult.geoJson.features.length,38,'Tamil Nadu must contain its complete 2021 district boundary layer');
assert.deepEqual(new Set(officialResult.sites.map(site=>String(site.selectionValue))),new Set(['Chennai','Coimbatore','Madurai']),'the three dataset cities must join to their real district polygons');
assert.ok(officialResult.sites.every(site=>site.items.length>0),'every colored official district must retain its underlying data rows');
console.log(`Administrative boundary runtime test passed: ${officialResult.geoJson.features.length} Tamil Nadu districts, ${officialResult.sites.length} matched dataset cities.`);
if(process.env.VTAB_TEST_REMOTE_BOUNDARIES==='1'){
  const canadaStates=await engine.loadAdministrativeBoundaries('Canada','ADM1');
  const canadaCounties=await engine.loadAdministrativeBoundaries('Canada','ADM2');
  assert.ok(canadaStates.geoJson.features.length>10,'remote ADM1 loading must work outside India');
  assert.ok(canadaCounties.geoJson.features.length>50,'remote ADM2 loading must work outside India');
  console.log(`Remote global boundary test passed: Canada ${canadaStates.geoJson.features.length} ADM1 and ${canadaCounties.geoJson.features.length} ADM2 features.`);
}

