const fs = require('node:fs');
const assert = require('node:assert/strict');

const read = path => fs.readFileSync(path, 'utf8');
const schema = read('src/visualFormattingSchema.ts');
const chart = read('src/components/Chart.tsx');
const workbench = read('src/v11/ReportWorkbench.tsx');
const publishedViewer = read('src/v11/PublishedViewer.tsx');
const canvasManager = read('src/components/CanvasObjectInteractionManager.tsx');
const styles = read('src/styles.css');
const formattingAuthority = read('src/formatting-authority.css');

const checks = [
  ['cartesian legends use unclipped top and bottom bands', schema.includes("['top','bottom']") && !schema.includes("['top','bottom','left','right']")],
  ['pie and donut legends expose only top and bottom', schema.includes("const pieLegend") && schema.includes("['top','bottom'],{key:'legendVisible'}") && schema.includes('pieLabels,pieLegend,pieShape')],
  ['axis title text controls are wired', schema.includes("text('xAxisTitle'") && schema.includes("text('yAxisTitle'")],
  ['slicer search is exposed', schema.includes("toggle('slicerSearch'")],
  ['unsupported header controls are not exposed', !schema.includes("toggle('headerFilterIcon'") && !schema.includes("toggle('headerPersonalizeIcon'") && !schema.includes("toggle('headerSpotlightIcon'")],
  ['unsupported report-page tooltip mode is not exposed', !schema.includes("select('tooltipMode'")],
  ['all formatting changes refresh ECharts', chart.includes('JSON.stringify(visual.format)')],
  ['matrix receives shared table formatting', chart.includes('style={tableCssVariables(visual)}')],
  ['pie and donut reserve a dedicated legend band', chart.includes('const legendBand=legendVisible?44:6') && chart.includes("top:autoLegend==='top'?legendBand:6") && chart.includes("bottom:autoLegend==='bottom'?legendBand:6")],
  ['legacy pie side legends migrate to bottom', chart.includes("const autoLegend=legendPosition==='top'?'top':'bottom'")],
  ['pie detail labels hide collisions', chart.includes("labelLayout:{hideOverlap:true,moveOverlap:'shiftY'}")],
  ['treemap exposes and renders only top or center labels', schema.includes("select('labelPosition','Position','top',['top','center']") && chart.includes("visual.format.labelPosition==='center'?'inside':'insideTop'") && chart.includes('params.rect.x+params.rect.width/2') && chart.includes('params.rect.y+params.rect.height/2')],
  ['slicer respects resolved title visibility', workbench.includes("displayFormat.showTitle&&<div className=\"visualTitle visualMoveZone\"")],
  ['header remains available when title is hidden', workbench.includes("!v.format.showTitle&&v.format.visualHeader!==false")],
  ['slicer search filters values', workbench.includes('allOptions.filter(option=>!slicerSearch')],
  ['categorical visuals default to a multi-color palette', schema.includes("toggle('categoricalColors','Use multiple category colors',true)") && chart.includes('categoryColor(name,i,value)')],
  ['category colors can be overridden by category name', schema.includes("id:'categoryColors'") && chart.includes('categoryOverrides[String(name)]')],
  ['combo chart requires a second value before creating its line', chart.includes("const second=visual.bindings.target?.[0];const secondData=second?rows.map(r=>r[second]):[]") && chart.includes("...(second?[{name:second,type:'line'")],
  ['combo primary axis renders selected gridlines', chart.includes("splitLine:{show:visual.format.gridLines!==false,lineStyle:{color:gridLineColor,type:gridLineStyle}}},...(second?")],
  ['stacked charts apply radius to the outer stack', chart.includes('si===seriesNames.length-1')],
  ['scatter series honor marker shapes and labels', chart.includes('symbol: marker') && chart.includes('showLabels: boolean')],
  ['special visuals expose axis-title rendering', ['waterfall','bubble','histogram','boxplot'].every(type=>chart.includes("visual.type === '"+type+"'")) && chart.includes("name:showXAxisTitle") && chart.includes("name:showYAxisTitle")],
  ['heatmap legend position and text styling are connected', chart.includes("orient:'horizontal'") && chart.includes("top:legendPosition==='top'?2:'auto'") && chart.includes('visual.format.legendFontSize')],
  ['table formatting CSS consumes the renderer variables', styles.includes('color:var(--cell-text,var(--table-text))!important') && styles.includes('background:var(--table-header-bg)!important') && styles.includes('var(--table-col-width)')],
  ['multi-row card properties override decorative defaults', styles.includes('min-height:var(--multi-min-height)!important') && styles.includes('font-size:var(--multi-value-size)!important')],
  ['single-select slicers do not display Select all', workbench.includes('v.format.slicerSelectAll&&!v.format.slicerSingleSelect')],
  ['stacked multi-measure charts share one value axis', chart.includes("if (multiValue && !horizontal && !stacked)") && chart.includes("yAxisIndex: multiValue && !horizontal && !stacked ? si : 0")],
  ['multi-series labels have collision handling', chart.includes('labelLayout:{hideOverlap:true}')],
  ['combo bar and line labels use separate placements', chart.includes("position:visual.format.labelPosition==='outside'?'top':'inside'") && chart.includes("position:'top',distance:8") && chart.includes("labelLayout:{moveOverlap:'shiftY'}")],
  ['multi-row cards expose flow direction and ordering', schema.includes("select('cardLayoutDirection','Flow direction'") && schema.includes("select('cardSortOrder','Card order'")],
  ['multi-row cards support per-card formatting', schema.includes("id:'individualCards'") && chart.includes('visual.format.cardStyles?.[field]')],
  ['explicit multi-card flow overrides responsive sizing', chart.includes("'--multi-grid-columns':columns") && styles.includes('grid-template-columns:var(--multi-grid-columns') && !styles.includes('.visualCompact .premiumMultiCardGrid{grid-template-columns:1fr!important}')],
  ['multi-series line labels never use below-axis placement', !chart.includes("si%2===0?'top':'bottom'") && !chart.includes("moveOverlap:chartType==='line'?'shiftY'")],
  ['pie labels use collision hiding inside the reserved plot region', chart.includes("labelLayout:{hideOverlap:true,moveOverlap:'shiftY'}") && chart.includes('edgeDistance:8')],
  ['bar column line and combo charts expose per-series colors', schema.includes("id:'seriesColors'") && schema.includes('bar:[dataColors,seriesColors') && schema.includes('combo:[dataColors,seriesColors')],
  ['configured series colors drive the renderer', chart.includes('visual.format.seriesColors?.[field]') && chart.includes('configuredSeriesColor(vf,si')],
  ['gauge and progress expose target color and label controls', schema.includes("title:'Target'") && schema.includes("color('targetColor','Target color'") && schema.includes("title:'Data labels'") && schema.includes("toggle('targetLabelVisible'")],
  ['gauge and progress render target and axis-label formatting', chart.includes('visual.format.targetLabelVisible!==false') && chart.includes('visual.format.gaugeAxisLabelColor') && chart.includes('visual.format.gaugeAxisLabelFontSize')],
  ['table and matrix expose explicit text and background cards', schema.includes("id:'textFormatting',title:'Text formatting'") && schema.includes("id:'backgroundFormatting',title:'Background formatting'") && schema.includes('table:[tableValues,tableBackgrounds') && schema.includes('matrix:[matrixLayout,matrixRowHeaders,matrixColumnHeaders,tableValues,tableBackgrounds')],
  ['table typography controls reach CSS variables', chart.includes("'--table-weight'") && chart.includes("'--table-style'") && chart.includes("'--table-wrap'") && styles.includes('font-weight:var(--table-weight)!important') && styles.includes('white-space:var(--table-wrap)!important')],
  ['donut callout uses true horizontal centering', chart.includes("left:'center',top:'42%'") && chart.includes("left:'center',top:'52%'")],
  ['gauge actual pointer and overlaid target notch remain distinct', chart.includes("length:'68%',width:5,itemStyle:{color:accent}") && chart.includes("z: 10") && chart.includes("pointer: {show:false}") && chart.includes("width: thickness + 8")],
  ['table and matrix expose field-level min/max color rules', schema.includes("id:'conditionalFormatting'") && chart.includes('visual.format.tableConditionalRules?.[field]') && chart.includes("style['--cell-bg']=color") && styles.includes('var(--cell-bg,var(--table-alt))')],
  ['shapes render as standalone drawing objects', workbench.includes("if(v.type==='shape')return <div role=\"img\"") && workbench.includes("className={'shapeObject '") && !workbench.includes("className={'visualCard mediaVisual shapeVisual")],
  ['shape artwork occupies its full object bounds', workbench.includes('x1="0" y1="50" x2="100" y2="50"') && workbench.includes('points="50,0 100,100 0,100"') && !workbench.includes('<rect x="4" y="4" width="92" height="92"')],
  ['shape formatting supports no fill no outline and corner radius', schema.includes("toggle('shapeFillVisible','Fill',true)") && schema.includes("toggle('shapeStrokeVisible','Outline',false)") && schema.includes("number('shapeCornerRadius','Corner radius'")],
  ['shape general formatting excludes chart container cards', schema.includes('SHAPE_GENERAL_FORMATTING_CARDS') && schema.includes("type==='shape'?SHAPE_GENERAL_FORMATTING_CARDS:GENERAL_FORMATTING_CARDS")],
  ['new shapes use predictable 320 by 160 geometry', workbench.includes("w:type==='shape'?320:") && workbench.includes("h:type==='shape'?160:")],
  ['selection geometry remains in its own overlay layer', canvasManager.includes('className="canvasObjectLayer"') && canvasManager.includes('className="canvasInteractionLayer"') && canvasManager.includes("className={'canvasSelectionFrame")],
  ['published shapes use the same standalone renderer', publishedViewer.includes('className="viewerShapeObject"') && !publishedViewer.includes('viewerVisual viewerVisual-shape')],
  ['shape CSS has no internal padding', styles.includes('.shapeObject,.viewerShapeObject') && styles.includes('.viewerShapeVisual{width:100%;height:100%;padding:0')],
  ['slicer typography reaches every slicer presentation', schema.includes("select('tableFontFamily','Font family'") && workbench.includes("'--slicer-font':displayFormat.tableFontFamily") && publishedViewer.includes("'--slicer-font':f.tableFontFamily") && formattingAuthority.includes("font-family:var(--slicer-font")],
  ['slicer bold italic wrap alignment and row spacing are wired', formattingAuthority.includes("font-weight:var(--slicer-weight") && formattingAuthority.includes("font-style:var(--slicer-style") && formattingAuthority.includes("white-space:var(--slicer-wrap") && formattingAuthority.includes("text-align:var(--slicer-align") && formattingAuthority.includes("padding-top:var(--slicer-row-padding")],
  ['title exposes Power BI style typography controls', schema.includes("select('titleFontFamily','Font family'") && schema.includes("toggle('titleBold','Bold'") && schema.includes("toggle('subtitleBold','Subtitle bold'")],
  ['authoring title and subtitle consume all typography properties', workbench.includes("'--visual-title-font':displayFormat.titleFontFamily") && workbench.includes("fontWeight:displayFormat.titleBold===false") && workbench.includes("fontFamily:displayFormat.subtitleFontFamily") && formattingAuthority.includes("--visual-subtitle-font")],
  ['published titles use the same typography contract', publishedViewer.includes("fontFamily:f.titleFontFamily") && publishedViewer.includes("fontWeight:f.titleBold===false") && publishedViewer.includes("fontFamily:f.subtitleFontFamily")],
  ['all four general paddings are authoritative', workbench.includes("'--visual-padding-top'") && workbench.includes("'--visual-padding-right'") && workbench.includes("'--visual-padding-bottom'") && workbench.includes("'--visual-padding-left'") && formattingAuthority.includes("padding-top:var(--visual-padding-top")],
  ['general radius background border and shadow override decorative themes', formattingAuthority.includes("border-radius:var(--visual-radius") && formattingAuthority.includes("background:var(--visual-background") && formattingAuthority.includes("box-shadow:var(--visual-shadow")],
  ['published visuals preserve general container formatting', publishedViewer.includes("const cardStyle:any=") && publishedViewer.includes("'--viewer-radius':radius") && publishedViewer.includes("'--viewer-background':background") && publishedViewer.includes("'--viewer-shadow':shadow") && formattingAuthority.includes("border-radius:var(--viewer-radius") && formattingAuthority.includes("background:var(--viewer-background") && formattingAuthority.includes("box-shadow:var(--viewer-shadow")],
  ['heatmaps use vertical category scrolling and wheel synchronization', chart.includes("categories={yCategories} horizontal={true}") && chart.includes("dataZoom:categoryZoom(yCategories,true)") && chart.includes("moveOnMouseWheel:true") && chart.includes("datazoom:handleDataZoom") && styles.includes('.chartNativeScrollerVertical')],
  ['matrix content starts directly with the table', !chart.includes('<b>Matrix hierarchy</b>') && chart.includes("premiumDataTable matrixMode")],
  ['treemap removes root name banner and fills its visual bounds', chart.includes("type:'treemap',roam:false,nodeClick:false,breadcrumb:{show:false},left:6,right:6,top:6,bottom:6") && chart.includes("upperLabel:{show:false}") && !schema.includes("toggle('treemapGroupLabels'")],
  ['gauge target field wins over manual fallback and participates in auto scale', chart.includes('const boundTarget=resolveBoundNumber(rows?.[0],targetField)') && chart.includes('const rawTarget=boundTarget!==undefined?boundTarget') && chart.includes('autoMaxCandidates.push(Math.abs(rawTarget!)*1.15)')],
  ['gauge target label is placed outside the arc', chart.includes('const labelRadius = 110') && chart.includes('fontWeight: 600') && chart.includes("radius: '91%'")],
  ['heatmap plot and color scale use compact margins', chart.includes("top:legendVisible&&legendPosition==='top'?42:8") && chart.includes("bottom:legendVisible&&legendPosition==='bottom'?44:8") && chart.includes("left:'center',right:'auto'")],
  ['charts resize with their visual container', chart.includes('new ResizeObserver(resize)') && chart.includes("window.addEventListener('resize',resize)" )],
  ['slicer dropdowns use searchable Power BI style popovers', workbench.includes('slicerDropdownTrigger') && workbench.includes('slicerDropdownMenu') && publishedViewer.includes('slicerDropdownOptions')],
  ['visual menus render through a viewport-safe portal', workbench.includes('visualContextMenuPortal') && workbench.includes('spaceBelow<280&&spaceAbove>spaceBelow') && workbench.includes('position.bottom=') && workbench.includes('document.body')],
  ['Top N is offered only on visual-level categorical filter cards', workbench.includes('allowTopN filters=') && workbench.includes('const topNEligible=allowTopN&&!isDate&&!isNumeric') && workbench.includes("(topNEligible||f.operator==='top_n')")],
  ['Top N exposes supported field aggregations and validates its configuration', workbench.includes("['sum','Sum'],['avg','Average'],['min','Minimum'],['max','Maximum'],['count','Count'],['distinct_count','Distinct count']") && workbench.includes('Enter a whole number from 1 to 5000.') && workbench.includes('Select a ranking measure.')],
  ['Top N provides apply and clear actions without changing chart sorting', workbench.includes('Clear filter</button>') && workbench.includes('Math.trunc(topNValue)') && workbench.includes('Ranking is calculated after report, page, slicer, cross-filter, and other visual filters.')],
  ['bound dimension fields automatically appear as visual filter cards', workbench.includes('function visualDimensionFilterFields') && workbench.includes("filter(w=>w.accept==='field')") && workbench.includes('implicitVisualFilters=visualDimensionFilterFields')],
  ['basic-filter members are requested and defensively deduplicated', workbench.includes('distinct: true') && workbench.includes('new Set((res.rows||[]).map') && workbench.includes('limit: 5000')],
  ['filter member queries honor surrounding report page and visual context', workbench.includes('const visualContext=[...reportFilters,...(page.filters||[]),...explicitVisualFilters]') && workbench.includes('filters: distinctContextFilters')],
  ['filter-pane search preserves original card indexes', workbench.includes('filters.map((f,index)=>({f,index})).filter') && workbench.includes('onRemove(index)') && workbench.includes('onUpdate(index,nx)')],
];

const failures=[];
for (const [name, pass] of checks) {
  if(pass) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`); failures.push(name); }
}
assert.deepEqual(failures,[],`${failures.length} visual-formatting contract check(s) failed`);

console.log(`${checks.length}/${checks.length} visual-formatting contract checks passed`);
