import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundled=await build({entryPoints:['src/sortingEngine.ts'],bundle:true,platform:'node',format:'esm',write:false});
const moduleUrl=`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
const sorting=await import(moduleUrl);

const naturalModel={columnTypes:{'Sales.MonthName':'text','Sales.Amount':'double','Sales.DayName':'text'},sortingSettings:{weekStartsOn:'monday'}};
const months=['April','August','December','February','January','July','June','March','May','November','October','September'].map(MonthName=>({'Sales.MonthName':MonthName}));
assert.deepEqual(sorting.sortVisualRows(months,{},naturalModel,['Sales.MonthName']).map(row=>row['Sales.MonthName']),['January','February','March','April','May','June','July','August','September','October','November','December']);

const model={...naturalModel,sortByColumns:{'Sales.Stage':{sortByField:'Sales.StageOrder',defaultDirection:'asc'}}};
const stages=[{'Sales.Stage':'Won','Sales.StageOrder':3},{'Sales.Stage':'Lead','Sales.StageOrder':1},{'Sales.Stage':'Qualified','Sales.StageOrder':2}];
assert.deepEqual(sorting.sortVisualRows(stages,{},model,['Sales.Stage']).map(row=>row['Sales.Stage']),['Lead','Qualified','Won']);
assert.deepEqual(sorting.sortVisualRows(stages,{sort:[{field:'Sales.Stage',direction:'desc'}]},model,['Sales.Stage']).map(row=>row['Sales.Stage']),['Won','Qualified','Lead']);

const amounts=[{'Sales.Amount':10},{'Sales.Amount':2},{'Sales.Amount':20},{'Sales.Amount':1}];
assert.deepEqual(sorting.sortVisualRows(amounts,{},naturalModel,['Sales.Amount']).map(row=>row['Sales.Amount']),[1,2,10,20]);
assert.equal(sorting.validateSortDefinition({tables:{A:{columns:{Label:'Label',Order:'Order'}},B:{columns:{Order:'Order'}}}},'A.Label','B.Order').valid,false);
assert.equal(sorting.validateSortDefinition({tables:{A:{columns:{Label:'Label',Order:'Order'}}},sortByColumns:{'A.Order':{sortByField:'A.Label'}}},'A.Label','A.Order').valid,false);

console.log('Universal sorting runtime test passed: calendar, numeric, model keys, overrides, and validation are active.');

