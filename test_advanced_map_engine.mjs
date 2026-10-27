import fs from 'node:fs';
import * as echarts from 'echarts';
import {createServer} from 'vite';

const csvPath=process.argv[2]||'D:/Codex/2026-10-09/files-mentioned-by-the-user-reporting/delivery/global-sales-data/global_sales_map_test_data.csv';
const lines=fs.readFileSync(csvPath,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/);
const headers=lines[0].split(','),rows=lines.slice(1).map(line=>Object.fromEntries(line.split(',').map((value,index)=>[headers[index],value])));
const clone=value=>structuredClone(value);
const base={id:'advanced-map-regression',type:'map',title:'Global sales',x:0,y:0,w:960,h:540,bindings:{latitude:['Latitude'],longitude:['Longitude']},format:{accent:'#118dff',fontSize:11,mapMode:'bubble',mapStyle:'light',mapAutoFit:true,mapNavigation:true,mapMarkerColor:'#118dff',mapMarkerSize:9,mapMarkerMinSize:5,mapMarkerMaxSize:28,mapMarkerOpacity:85,mapBorderColor:'#ffffff',mapBorderWidth:1,mapFillOpacity:78,mapMissingColor:'#e8eef4',mapColorScale:'measure',mapMinColor:'#d64550',mapMidColor:'#facc15',mapMaxColor:'#1aab40',mapLabels:true,mapCountryLabels:true,legendVisible:true}};
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
const server=await createServer({server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true}});
try{
  const engine=await server.ssrLoadModule('/src/mapEngine.ts');
  const formatting=await server.ssrLoadModule('/src/formatting.ts');
  test('global vector boundary set is bundled locally',()=>assert(engine.WORLD_GEOJSON.features.length>200,'Expected the bundled 50m country boundaries.'));
  test('projected north remains above projected south',()=>{
    const north=engine.projectMapCoordinate(0,60),south=engine.projectMapCoordinate(0,-60);
    assert(north[1]>south[1],`Map Y axis is inverted: north=${north[1]}, south=${south[1]}.`);
  });
  test('ECharts bounds use top-left then bottom-right order',()=>{
    const bounds=engine.mapGeometryBounds(engine.WORLD_GEOJSON,['India']);
    assert(bounds&&bounds[0][0]<bounds[1][0]&&bounds[0][1]>bounds[1][1],'Map bounds have invalid ECharts orientation.');
  });
  test('automatic display units respond to the current filtered magnitude',()=>{
    const auto={displayUnits:'auto',decimals:0};
    assert(formatting.formatNumber(14000000000,auto)==='14B','Auto did not format billions.');
    assert(formatting.formatNumber(14000,auto)==='14K','Auto did not re-evaluate thousands.');
    assert(formatting.formatNumber(400,auto)==='400','Auto compressed a value below one thousand.');
    assert(formatting.formatNumber(14000000,{displayUnits:'million',decimals:0})==='14M','Manual millions did not apply.');
    assert(formatting.formatNumber(14000,{displayUnits:'none',decimals:0})==='14,000','None did not preserve the complete value.');
  });
  test('country names and ISO standards resolve to one boundary',()=>{
    assert(engine.resolveWorldFeatureName('United States')==='United States of America','Country-name alias failed.');
    assert(engine.resolveWorldFeatureName('US')==='United States of America','ISO-2 matching failed.');
    assert(engine.resolveWorldFeatureName('USA')==='United States of America','ISO-3 matching failed.');
    assert(engine.resolveWorldFeatureName('356')==='India','Numeric M49 matching failed.');
  });
  test('antimeridian geometry is split before rendering',()=>{
    let maximumSegment=0;
    const walk=coordinates=>{if(!Array.isArray(coordinates))return;if(coordinates.length&&typeof coordinates[0]?.[0]==='number'){for(let index=1;index<coordinates.length;index++)maximumSegment=Math.max(maximumSegment,Math.abs(coordinates[index][0]-coordinates[index-1][0]))}else coordinates.forEach(walk)};
    engine.WORLD_GEOJSON.features.forEach(feature=>walk(feature.geometry.coordinates));
    assert(maximumSegment<20,`Detected an unsafe full-width boundary segment (${maximumSegment}).`);
  });
  test('latitude and longitude alone create geographic marks',()=>{
    const data=engine.prepareMapData(base,rows);assert(data.points.length===448,'All valid coordinates should be prepared.');assert(data.hasPointPayload===true,'Published coordinate fields must remain visible without an additional detail field.');
  });
  test('detail enables bubbles and preserves all coordinates',()=>{
    const visual=clone(base);visual.bindings.detail=['City'];const data=engine.prepareMapData(visual,rows);assert(data.hasPointPayload&&data.points.length===448,'Detail did not enable all bubbles.');assert(new Set(data.points.map(point=>point.radius)).size===1,'Unweighted bubbles should use one configured size.');
  });
  test('a measure controls bubble size',()=>{
    const visual=clone(base);visual.bindings.detail=['City'];visual.bindings.size=['Net_Sales_USD'];const data=engine.prepareMapData(visual,rows),radii=data.points.map(point=>point.radius);assert(Math.max(...radii)-Math.min(...radii)>10,'Measure-based bubble sizing did not vary.');
  });
  test('numeric Detail drives bubble size without inventing measure colors',()=>{
    const visual=clone(base);visual.bindings.detail=['Net_Sales_USD'];const data=engine.prepareMapData(visual,rows),radii=data.points.map(point=>point.radius);
    assert(Math.max(...radii)>Math.min(...radii),'Numeric Detail did not scale bubble size.');
    assert(new Set(data.points.map(point=>point.color)).size===1,'Measure mode applied colors without a color-returning measure.');
    assert(!data.numericDomain,'Measure mode created a numeric gradient legend without a color measure.');
  });
  test('country names produce a filled map with aggregated measures',()=>{
    const visual=clone(base);visual.format.mapMode='filled';visual.bindings={country:['Country'],size:['Net_Sales_USD'],tooltips:['Profit_USD']};const data=engine.prepareMapData(visual,rows);assert(data.regions.length===40,`Expected 40 countries, received ${data.regions.length}.`);assert(data.unmatched.length===0,`Unexpected unmatched countries: ${data.unmatched.join(', ')}`);assert(data.regions.every(region=>region.value!==undefined),'Filled values did not aggregate.');
  });
  test('ISO-3 values produce the same filled boundaries',()=>{
    const visual=clone(base);visual.format.mapMode='filled';visual.bindings={country:['Country_ISO3'],size:['Net_Sales_USD']};const data=engine.prepareMapData(visual,rows);assert(data.regions.length===40&&data.unmatched.length===0,'ISO-3 values did not resolve completely.');
  });
  test('categorical color creates a deterministic legend',()=>{
    const visual=clone(base);visual.format.mapMode='filled';visual.bindings={country:['Country'],color:['Continent'],size:['Net_Sales_USD']};const data=engine.prepareMapData(visual,rows);assert(data.categoryLegend.length===6,'Expected six continent legend items.');
  });
  test('measure coloring uses only an explicit color-returning field',()=>{
    const visual=clone(base);visual.format.mapMode='filled';visual.bindings={country:['Country'],detail:['Net_Sales_USD']};const plain=engine.prepareMapData(visual,rows);assert(new Set(plain.regions.map(region=>region.color)).size===1,'Measure mode created an implicit gradient.');
    visual.bindings.color=['Map_Color'];const colored=engine.prepareMapData(visual,[{Country:'India',Net_Sales_USD:10,Map_Color:'#dc2626'},{Country:'Japan',Net_Sales_USD:20,Map_Color:'#16a34a'}]);assert(new Set(colored.regions.map(region=>region.color)).size===2,'Explicit measure colors were not applied.');
  });
  test('low middle high rules apply to map measures',()=>{
    const visual=clone(base);visual.format.mapMode='filled';visual.format.mapColorScale='rules';visual.format.mapRuleLow=2000000;visual.format.mapRuleHigh=4000000;visual.format.mapRuleLowColor='#ff0000';visual.format.mapRuleMidColor='#ffff00';visual.format.mapRuleHighColor='#00ff00';visual.bindings={country:['Country'],detail:['Net_Sales_USD']};const data=engine.prepareMapData(visual,rows);
    assert(data.regions.length===40,'Rule-based filled map did not aggregate locations.');
    assert(data.categoryLegend.length===3&&!data.numericDomain,'Rule formatting did not create three discrete legend bands.');
    assert(data.regions.every(region=>['#ff0000','#ffff00','#00ff00'].includes(region.color)),'A region escaped low/middle/high conditional formatting.');
    const bubble=clone(visual);bubble.format.mapMode='bubble';bubble.bindings={latitude:['Latitude'],longitude:['Longitude'],detail:['Net_Sales_USD']};const bubbleData=engine.prepareMapData(bubble,rows);
    assert(bubbleData.points.every(point=>['#ff0000','#ffff00','#00ff00'].includes(point.color)),'Bubbles ignored the same low/middle/high map rules.');
  });
  test('custom color measures are used directly for filled areas and bubbles',()=>{
    const filled=clone(base);filled.format.mapMode='filled';filled.bindings={country:['Country'],detail:['Net_Sales_USD'],color:['Map_Color'],tooltips:['Profit_USD','Units_Sold']};
    const filledData=engine.prepareMapData(filled,[{Country:'India',Net_Sales_USD:100,Map_Color:'#16a34a',Profit_USD:20,Units_Sold:3},{Country:'India',Net_Sales_USD:200,Map_Color:'#16a34a',Profit_USD:30,Units_Sold:4}]);
    assert(filledData.regions[0]?.color==='#16a34a','Filled map hashed the custom color instead of using it.');
    assert(filledData.regions[0]?.tooltip.some(([field,value])=>field==='Profit_USD'&&value===50),'Multiple numeric tooltip values were not aggregated.');
    assert(filledData.regions[0]?.tooltip.some(([field,value])=>field==='Units_Sold'&&value===7),'The second tooltip value is missing.');
    const bubble=clone(base);bubble.bindings={latitude:['Latitude'],longitude:['Longitude'],detail:['Net_Sales_USD'],color:['Map_Color']};const bubbleData=engine.prepareMapData(bubble,[{Latitude:20,Longitude:78,Net_Sales_USD:100,Map_Color:'#dc2626'}]);
    assert(bubbleData.points[0]?.color==='#dc2626','Bubble map ignored the custom color measure.');
  });
  test('custom GeoJSON joins remain supported',()=>{
    const visual=clone(base);visual.format.mapMode='filled';visual.format.mapGeometryJoinProperty='code';visual.format.mapCustomGeometry={type:'FeatureCollection',features:[{type:'Feature',properties:{code:'A'},geometry:{type:'Polygon',coordinates:[[[70,10],[75,10],[75,15],[70,15],[70,10]]]}}]};visual.bindings={location:['Area'],size:['Sales']};const data=engine.prepareMapData(visual,[{Area:'A',Sales:25}]);assert(data.mapName.startsWith('vtab-custom-')&&data.regions.length===1,'Custom boundary join failed.');
  });
  test('saved local corrections resolve unmatched places without a geocoder',()=>{
    const visual=clone(base);visual.bindings={location:['Place'],detail:['Place']};visual.format.mapLocationCorrections={'test city':{latitude:12.5,longitude:77.6,displayName:'Test City'}};const data=engine.prepareMapData(visual,[{Place:'Test City'}]);assert(data.points.length===1&&data.hasPointPayload,'Saved local correction was not used.');
  });
  test('all exposed map properties are connected to the renderer',()=>{
    const source=fs.readFileSync('src/components/AdvancedMapVisual.tsx','utf8');
    ['mapGeographyScope','mapDefaultCountry','mapDetailLevel','mapAutoFit','mapNavigation','mapMarkerOpacity','mapBorderColor','mapBorderWidth','mapFillOpacity','mapMissingColor','mapLabels','mapCountryLabels','mapLabelColor','mapLabelSize','mapAllowOverlap'].forEach(property=>assert(source.includes(property),`${property} is not wired to the map renderer.`));
    assert(source.includes('setZoom')&&source.includes('zoom,silent:false'),'Zoom buttons are not connected to controlled ECharts zoom.');
    assert(!source.includes("formatter:'{b}'")&&source.includes('const geoLabel='),'Country labels can render the literal {b} token.');
    assert(source.includes('tooltip:tooltipOptions')&&source.includes('const tooltipFormatter'),'Geo tooltip is not explicitly wired.');
    assert(source.includes('const geoLabel=')&&source.includes('region?.value'),'Filled-map value labels are not independent from country names.');
    assert(source.includes('emphasis:{disabled:true'),'Hover highlighting is still enabled.');
    const schema=fs.readFileSync('src/visualFormattingSchema.ts','utf8');
    assert(/select\('mapMode','Map type','bubble',\['bubble','filled'\]\)/.test(schema),'Map type is not limited to Bubble and Filled.');
    assert(/id:'mapLabels',title:'Labels'/.test(schema)&&! /id:'mapLegend',title:'Legend'/.test(schema),'Map labels must remain while the unused map legend card stays removed.');
    assert(/id:'displayUnits',title:'Display units'/.test(schema),'General display-units formatting is missing.');
    assert(/id:'mapAreas',title:'Color grading'/.test(schema)&&schema.includes("['table','matrix','map'].includes(type)"),'Map still exposes the generic conditional-formatting card.');
    const workspace=fs.readFileSync('src/components/FormattingWorkspace.tsx','utf8');
    assert(workspace.includes('function MapColorGrading')&&workspace.includes('Select color measure'),'Measure mode does not provide the color-measure dropdown.');
    assert(!workspace.includes('Select numeric measure')&&workspace.includes('Rules use the numeric field or measure already placed in Detail / value.'),'Rules mode still exposes a measure selector.');
    assert(workspace.includes('<option value="measure">Measure</option>')&&workspace.includes('<option value="rules">Rules</option>')&&workspace.includes("mode==='measure'?<>"),'Measure and Rules are not rendered as separate workflows.');
    const workbench=fs.readFileSync('src/v11/ReportWorkbench.tsx','utf8'),published=fs.readFileSync('src/v11/PublishedViewer.tsx','utf8');
    assert(workbench.includes("v.type==='map'?{}:resolveConditionalFormat")&&published.includes("v.type==='map'?{}:resolveConditionalFormat"),'A generic conditional-formatting path can still override map colors.');
  });
  test('ECharts renders the local map without a URL or external tile request',()=>{
    echarts.registerMap('vtab-regression-map',engine.WORLD_GEOJSON);const chart=echarts.init(null,null,{renderer:'svg',ssr:true,width:960,height:540});chart.setOption({geo:{map:'vtab-regression-map',roam:true,itemStyle:{areaColor:'#f8fafc',borderColor:'#cbd5e1'}},series:[]});const svg=chart.renderToSVGString();chart.dispose();assert(svg.length>100000&&svg.includes('<path'),'The vector map did not render.');assert(!/(?:href|src)=["']https?:\/\//i.test(svg),'Rendered output contains an external network resource.');
  });
  for(const[name,fn]of tests){await fn();console.log('PASS',name)}
  console.log(`PASS ${tests.length}/${tests.length} advanced map regression checks`);
}finally{await server.close()}
