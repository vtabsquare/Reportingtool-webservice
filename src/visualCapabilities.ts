import type {VisualType} from './types';

export type VisualFamily='cartesian'|'partToWhole'|'statistical'|'indicator'|'tabular'|'filter'|'geographic'|'content';

export type VisualCapability={
  type:VisualType;
  displayName:string;
  family:VisualFamily;
  iconKey:string;
  supports:{
    legend?:boolean;
    axes?:boolean;
    dataLabels?:boolean;
    categoryColors?:boolean;
    conditionalFormatting?:boolean;
    interactions?:boolean;
    analytics?:boolean;
    virtualization?:boolean;
    hierarchy?:boolean;
    drillDown?:boolean;
    drillThrough?:boolean;
  };
  performance:{renderer:'canvas'|'html'|'map';pointBudget?:number;lazy?:boolean};
};

export type VisualSupport=VisualCapability['supports'];

const capability=(type:VisualType,displayName:string,family:VisualFamily,iconKey:string,supports:VisualCapability['supports'],performance:VisualCapability['performance']):VisualCapability=>({type,displayName,family,iconKey,supports,performance});

export const VISUAL_CAPABILITIES:Record<VisualType,VisualCapability>={
  bar:capability('bar','Bar chart','cartesian','bar-chart-horizontal',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true,hierarchy:true,drillDown:true,drillThrough:true},{renderer:'canvas',pointBudget:5000,lazy:true}),
  column:capability('column','Column chart','cartesian','bar-chart-3',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true,hierarchy:true,drillDown:true,drillThrough:true},{renderer:'canvas',pointBudget:5000,lazy:true}),
  stackedbar:capability('stackedbar','Stacked bar','cartesian','chart-no-axes-column-increasing',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true},{renderer:'canvas',pointBudget:5000,lazy:true}),
  stackedcolumn:capability('stackedcolumn','Stacked column','cartesian','chart-column-stacked',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true},{renderer:'canvas',pointBudget:5000,lazy:true}),
  line:capability('line','Line chart','cartesian','chart-line',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true,hierarchy:true,drillDown:true,drillThrough:true},{renderer:'canvas',pointBudget:10000,lazy:true}),
  area:capability('area','Area chart','cartesian','chart-area',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true,hierarchy:true,drillDown:true,drillThrough:true},{renderer:'canvas',pointBudget:10000,lazy:true}),
  combo:capability('combo','Line and column chart','cartesian','chart-no-axes-combined',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true},{renderer:'canvas',pointBudget:8000,lazy:true}),
  scatter:capability('scatter','Scatter chart','cartesian','scatter-chart',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true},{renderer:'canvas',pointBudget:20000,lazy:true}),
  bubble:capability('bubble','Bubble chart','cartesian','circle-dot',{legend:true,axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true},{renderer:'canvas',pointBudget:10000,lazy:true}),
  pie:capability('pie','Pie chart','partToWhole','chart-pie',{legend:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:1000,lazy:true}),
  donut:capability('donut','Donut chart','partToWhole','circle-gauge',{legend:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:1000,lazy:true}),
  treemap:capability('treemap','Treemap','partToWhole','layout-dashboard',{dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:4000,lazy:true}),
  funnel:capability('funnel','Funnel','partToWhole','funnel',{dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:500,lazy:true}),
  waterfall:capability('waterfall','Waterfall','cartesian','chart-no-axes-waterfall',{axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true,analytics:true},{renderer:'canvas',pointBudget:5000,lazy:true}),
  radar:capability('radar','Radar chart','statistical','radar',{legend:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:2000,lazy:true}),
  heatmap:capability('heatmap','Heat map','statistical','grid-3x3',{legend:true,axes:true,dataLabels:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:20000,lazy:true}),
  histogram:capability('histogram','Histogram','statistical','chart-bar-big',{axes:true,dataLabels:true,conditionalFormatting:true,interactions:true,analytics:true},{renderer:'canvas',pointBudget:5000,lazy:true}),
  boxplot:capability('boxplot','Box plot','statistical','chart-candlestick',{axes:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:10000,lazy:true}),
  gauge:capability('gauge','Gauge','indicator','gauge',{dataLabels:true,conditionalFormatting:true,interactions:true},{renderer:'canvas',pointBudget:50,lazy:true}),
  progress:capability('progress','Progress','indicator','loader-circle',{dataLabels:true,conditionalFormatting:true,interactions:true},{renderer:'html',pointBudget:50}),
  kpi:capability('kpi','Advanced KPI','indicator','badge-indian-rupee',{dataLabels:true,conditionalFormatting:true,interactions:true},{renderer:'html',pointBudget:100}),
  card:capability('card','Card','indicator','square-stack',{dataLabels:true,conditionalFormatting:true,interactions:true},{renderer:'html',pointBudget:100}),
  multirowcard:capability('multirowcard','Multi-row card','indicator','panels-top-left',{dataLabels:true,conditionalFormatting:true,interactions:true},{renderer:'html',pointBudget:1000}),
  table:capability('table','Table','tabular','table',{dataLabels:true,conditionalFormatting:true,interactions:true,virtualization:true,drillThrough:true},{renderer:'html',pointBudget:50000,lazy:true}),
  matrix:capability('matrix','Matrix','tabular','table-properties',{dataLabels:true,conditionalFormatting:true,interactions:true,virtualization:true,hierarchy:true,drillThrough:true},{renderer:'html',pointBudget:50000,lazy:true}),
  slicer:capability('slicer','Slicer','filter','list-filter',{interactions:true,virtualization:true},{renderer:'html',pointBudget:10000}),
  map:capability('map','Map','geographic','map',{legend:true,dataLabels:true,categoryColors:true,conditionalFormatting:true,interactions:true},{renderer:'map',pointBudget:50000,lazy:true}),
  textbox:capability('textbox','Text box','content','text-cursor-input',{}, {renderer:'html'}),
  button:capability('button','Button','content','mouse-pointer-click',{interactions:true,conditionalFormatting:true},{renderer:'html'}),
  image:capability('image','Image','content','image',{}, {renderer:'html'}),
  shape:capability('shape','Shape','content','shapes',{conditionalFormatting:true}, {renderer:'html'}),
};

// Guard against an incomplete registry during development. This intentionally
// runs in every build: a new visual type must declare its behavior before it can
// silently appear with unrelated formatting controls.
export function assertVisualCapabilityRegistry(types:readonly VisualType[]){
  const missing=types.filter(type=>!VISUAL_CAPABILITIES[type]);
  if(missing.length)throw new Error(`Visual capability registry is missing: ${missing.join(', ')}`);
}
