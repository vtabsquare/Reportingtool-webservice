export type PaginatedPageSize='A4'|'A3'|'Letter'|'Legal'|'Custom';
export type PaginatedOrientation='portrait'|'landscape';
export type PaginatedParameterType='text'|'number'|'date'|'boolean'|'single'|'multi';
export type PaginatedElementType='text'|'image'|'line'|'shape';

export type PaginatedBandItem={
  id:string;
  type:PaginatedElementType;
  value:string;
  align:'left'|'center'|'right';
  fontSize:number;
  bold?:boolean;
  color?:string;
  background?:string;
  widthPercent?:number;
  /** Free-form position inside its own report section. */
  xMm?:number;
  yMm?:number;
  widthMm?:number;
  heightMm?:number;
  contentKind?:'static'|'dynamic'|'mixed';
  dynamicToken?:string;
  fontFamily?:string;
  italic?:boolean;
  underline?:boolean;
  borderColor?:string;
  borderWidth?:number;
  borderRadius?:number;
  padding?:number;
  opacity?:number;
  imageFit?:'contain'|'cover'|'fill'|'none'|'scale-down';
  imagePosition?:'center'|'top'|'bottom'|'left'|'right';
  lineStyle?:'solid'|'dashed'|'dotted';
};

export type PaginatedColumn={
  id:string;
  field:string;
  label:string;
  widthMm:number;
  align:'left'|'center'|'right';
  format?:string;
  aggregate?:'none'|'sum'|'count'|'min'|'max'|'avg';
  headerFontFamily?:string;
  headerFontSize?:number;
  headerBold?:boolean;
  headerItalic?:boolean;
  headerColor?:string;
  headerBackground?:string;
  headerAlign?:'left'|'center'|'right';
  valueFontFamily?:string;
  valueFontSize?:number;
  valueBold?:boolean;
  valueItalic?:boolean;
  valueColor?:string;
  valueBackground?:string;
  valueAlign?:'left'|'center'|'right';
};

export type PaginatedParameter={
  id:string;
  name:string;
  label:string;
  type:PaginatedParameterType;
  required?:boolean;
  defaultValue?:any;
  values?:string[];
};

export type PaginatedReportDefinition={
  id:string;
  name:string;
  description?:string;
  page:{
    size:PaginatedPageSize;
    orientation:PaginatedOrientation;
    widthMm:number;
    heightMm:number;
    margins:{top:number;right:number;bottom:number;left:number};
    headerHeightMm:number;
    footerHeightMm:number;
  };
  header:{visible:boolean;repeat:boolean;items:PaginatedBandItem[]};
  footer:{visible:boolean;repeat:boolean;items:PaginatedBandItem[]};
  /** Objects placed directly on the centre/content canvas. */
  bodyItems?:PaginatedBandItem[];
  /** Position of the detail table inside the centre/content canvas. */
  contentLayout?:{tableXmm:number;tableYmm:number};
  table:{
    name:string;
    columns:PaginatedColumn[];
    repeatHeader:boolean;
    headerHeightMm:number;
    rowHeightMm:number;
    wrapText:boolean;
    headerBackground:string;
    headerColor:string;
    headerFontFamily?:string;
    headerFontSize?:number;
    headerBold?:boolean;
    headerItalic?:boolean;
    bodyColor:string;
    bodyFontFamily?:string;
    bodyBold?:boolean;
    bodyItalic?:boolean;
    alternateRows:boolean;
    alternateBackground:string;
    borderColor:string;
    fontSize:number;
    sort?:Array<{field:string;direction:'asc'|'desc'}>;
    groupBy?:string;
    groupPageBreak?:'none'|'before'|'after'|'between';
    repeatGroupHeader?:boolean;
    keepGroupTogether?:boolean;
    showTotals?:boolean;
  };
  filters:Array<{field:string;operator:string;value:any}>;
  parameters:PaginatedParameter[];
  pagination:{mode:'automatic'|'rows'|'group';rowsPerPage:number;resetPageNumberByGroup?:boolean};
  rendering:{fileNameTemplate:string;showEmptyReport:boolean};
  updatedAt:string;
};

const pageDimensions:Record<Exclude<PaginatedPageSize,'Custom'>,[number,number]>={
  A4:[210,297],A3:[297,420],Letter:[215.9,279.4],Legal:[215.9,355.6],
};

export function paginatedPageDimensions(size:PaginatedPageSize,orientation:PaginatedOrientation,current?:[number,number]):[number,number]{
  const base=size==='Custom'?(current||[210,297]):pageDimensions[size];
  const short=Math.min(base[0],base[1]),long=Math.max(base[0],base[1]);
  return orientation==='landscape'?[long,short]:[short,long];
}

export function createPaginatedReport(name='Paginated Report'):PaginatedReportDefinition{
  return{
    id:crypto.randomUUID(),name,
    page:{size:'A4',orientation:'portrait',widthMm:210,heightMm:297,margins:{top:12,right:12,bottom:12,left:12},headerHeightMm:24,footerHeightMm:16},
    header:{visible:true,repeat:true,items:[{id:crypto.randomUUID(),type:'text',value:'{{Report.Name}}',align:'left',fontSize:16,bold:true,color:'#111827',widthPercent:100}]},
    footer:{visible:true,repeat:true,items:[{id:crypto.randomUUID(),type:'text',value:'Page {{Report.PageNumber}} of {{Report.TotalPages}}',align:'right',fontSize:9,color:'#475569',widthPercent:100}]},
    bodyItems:[],contentLayout:{tableXmm:0,tableYmm:0},
    table:{name:'Detail table',columns:[],repeatHeader:true,headerHeightMm:9,rowHeightMm:8,wrapText:true,headerBackground:'#e8eef7',headerColor:'#111827',headerFontFamily:'Segoe UI',headerFontSize:9,headerBold:true,headerItalic:false,bodyColor:'#1f2937',bodyFontFamily:'Segoe UI',bodyBold:false,bodyItalic:false,alternateRows:true,alternateBackground:'#f8fafc',borderColor:'#cbd5e1',fontSize:9,sort:[],groupPageBreak:'none',repeatGroupHeader:false,keepGroupTogether:true,showTotals:false},
    filters:[],parameters:[],pagination:{mode:'automatic',rowsPerPage:25},rendering:{fileNameTemplate:'{{Report.Name}}_{{Report.ExecutionDate}}.pdf',showEmptyReport:true},updatedAt:new Date().toISOString(),
  };
}

export function ensurePaginatedReports(project:any):PaginatedReportDefinition[]{
  if(!Array.isArray(project.paginatedReports))project.paginatedReports=[];
  return project.paginatedReports;
}
