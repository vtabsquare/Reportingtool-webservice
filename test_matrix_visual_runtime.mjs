import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';

const bundled=await build({entryPoints:['src/components/MatrixVisual.tsx'],bundle:true,platform:'node',format:'esm',write:false,loader:{'.css':'empty'}});
const moduleUrl=`data:text/javascript;base64,${Buffer.from(bundled.outputFiles.find(file=>file.path.endsWith('.js'))?.text||bundled.outputFiles[0].text).toString('base64')}`;
const matrix=await import(moduleUrl);
const rows=[
  {Region:'North',Country:'A',Year:2025,Quarter:'Q1','Sales::sum':10,'Margin::average':.2,'Customer::count_distinct':'X'},
  {Region:'North',Country:'A',Year:2025,Quarter:'Q2','Sales::sum':20,'Margin::average':.4,'Customer::count_distinct':'X'},
  {Region:'North',Country:'B',Year:2026,Quarter:'Q1','Sales::sum':30,'Margin::average':.6,'Customer::count_distinct':'Y'},
  {Region:'South',Country:'C',Year:2025,Quarter:'Q1','Sales::sum':40,'Margin::average':.8,'Customer::count_distinct':'Z'},
];
const rowTree=matrix.buildMatrixHierarchy(rows,['Region','Country']);
assert.equal(rowTree.length,2,'top-level row groups must be dynamic');
assert.equal(rowTree.find(node=>node.label==='North').children.length,2,'row hierarchy must retain children');
const north=rowTree.find(node=>node.label==='North');
assert.equal(matrix.flattenMatrixRows(rowTree,new Set([north.id]),true,'top').length,4,'expanding one branch must reveal only that branch children');
const columnTree=matrix.buildMatrixHierarchy(rows,['Year','Quarter']);
assert.equal(matrix.matrixColumnLeaves(columnTree,new Set(columnTree.map(node=>node.id))).length,3,'expanded column hierarchy must expose its Year/Quarter leaves');
assert.equal(matrix.aggregateMatrixRows(rows,'Sales::sum'),100,'sum aggregation must use the full cell context');
assert.equal(matrix.aggregateMatrixRows(rows,'Margin::average'),.5,'average must be recalculated instead of summing visible values');
assert.equal(matrix.aggregateMatrixRows(rows,'Customer::count_distinct'),3,'distinct count must not double count repeated labels');
const monthTree=matrix.buildMatrixHierarchy([{Month:'December'},{Month:'February'},{Month:'January'}],['Month']);
assert.deepEqual(monthTree.map(node=>node.label),['January','February','December'],'calendar month groups must be chronological, not alphabetical');

const viewer=fs.readFileSync('src/v11/PublishedViewer.tsx','utf8'),chart=fs.readFileSync('src/components/Chart.tsx','utf8'),schema=fs.readFileSync('src/visualFormattingSchema.ts','utf8');
assert.match(viewer,/model=\{project\.model\}/,'published matrices must receive the complete Unified Data Model for model-aware sorting');
assert.match(viewer,/sortVisualRows/,'published matrix rows must pass through the universal sorting engine');
assert.match(chart,/MatrixVisual rows=\{rows\}/,'matrix must use the dedicated hierarchy renderer');
assert.match(chart,/conditionalValues=\{conditionalValues\}/,'matrix must receive field-value conditional formatting results');
assert.match(fs.readFileSync('src/components/MatrixVisual.tsx','utf8'),/columnFields\.length>0&&visual\.format\.matrixColumnGrandTotal/,'matrix must not duplicate values as a total column when Columns is empty');
assert.match(schema,/matrixRowSubtotals/,'matrix format pane must expose independent subtotal controls');
assert.match(schema,/matrixColumnGrandTotal/,'matrix format pane must expose an independent total column');
console.log('Matrix runtime test passed: row/column hierarchies, branch expansion, aggregation semantics, and dedicated formatting are active.');

