import type {VisualFormat} from './types';

const PRESETS:Record<string,Partial<VisualFormat>>={
  filled:{buttonBackground:'#2563eb',buttonBackground2:'#2563eb',buttonTextColor:'#ffffff',buttonIconColor:'#ffffff',buttonHoverBackground:'#1d4ed8',buttonHoverTextColor:'#ffffff',buttonHoverIconColor:'#ffffff',buttonPressedBackground:'#1e40af',buttonPressedTextColor:'#ffffff',buttonBorderVisible:false,buttonShadow:false},
  soft:{buttonBackground:'#dbeafe',buttonBackground2:'#dbeafe',buttonTextColor:'#1d4ed8',buttonIconColor:'#2563eb',buttonHoverBackground:'#bfdbfe',buttonHoverTextColor:'#1e40af',buttonHoverIconColor:'#1d4ed8',buttonPressedBackground:'#93c5fd',buttonPressedTextColor:'#1e3a8a',buttonBorderVisible:false,buttonShadow:false},
  outline:{buttonBackground:'#ffffff',buttonBackground2:'#ffffff',buttonTextColor:'#1d4ed8',buttonIconColor:'#2563eb',buttonHoverBackground:'#eff6ff',buttonHoverTextColor:'#1d4ed8',buttonHoverIconColor:'#2563eb',buttonPressedBackground:'#dbeafe',buttonPressedTextColor:'#1e40af',buttonBorderVisible:true,buttonBorderColor:'#93c5fd',buttonShadow:false},
  ghost:{buttonBackground:'transparent',buttonBackground2:'transparent',buttonTextColor:'#1d4ed8',buttonIconColor:'#2563eb',buttonHoverBackground:'#eff6ff',buttonHoverTextColor:'#1d4ed8',buttonHoverIconColor:'#2563eb',buttonPressedBackground:'#dbeafe',buttonPressedTextColor:'#1e40af',buttonBorderVisible:false,buttonShadow:false},
  elevated:{buttonBackground:'#ffffff',buttonBackground2:'#ffffff',buttonTextColor:'#111827',buttonIconColor:'#2563eb',buttonHoverBackground:'#f8fafc',buttonHoverTextColor:'#0f172a',buttonHoverIconColor:'#1d4ed8',buttonPressedBackground:'#f1f5f9',buttonPressedTextColor:'#0f172a',buttonBorderVisible:true,buttonBorderColor:'#e5e7eb',buttonShadow:true},
  gradient:{buttonBackground:'#2563eb',buttonBackground2:'#7c3aed',buttonTextColor:'#ffffff',buttonIconColor:'#ffffff',buttonHoverBackground:'#4338ca',buttonHoverTextColor:'#ffffff',buttonHoverIconColor:'#ffffff',buttonPressedBackground:'#3730a3',buttonPressedTextColor:'#ffffff',buttonBorderVisible:false,buttonShadow:true},
  glass:{buttonBackground:'rgba(255,255,255,.22)',buttonBackground2:'rgba(255,255,255,.10)',buttonTextColor:'#0f172a',buttonIconColor:'#2563eb',buttonHoverBackground:'rgba(255,255,255,.42)',buttonHoverTextColor:'#0f172a',buttonHoverIconColor:'#1d4ed8',buttonPressedBackground:'rgba(255,255,255,.58)',buttonPressedTextColor:'#0f172a',buttonBorderVisible:true,buttonBorderColor:'rgba(255,255,255,.55)',buttonShadow:true}
};

export function applyButtonPreset(format:VisualFormat,preset:string){
  // Presets describe the visible button surface. Disable the optional
  // persistent selection highlight so an old selected color cannot mask it.
  Object.assign(format,{buttonVersion:2,buttonPreset:preset,buttonSelectionEnabled:false},PRESETS[preset]||PRESETS.filled);
}

export function buttonVisualCss(format:VisualFormat,selected=false){
  const shape=format.buttonShape||'rounded';
  const radius=shape==='square'?0:shape==='pill'||shape==='circle'?999:(format.buttonCornerRadius??10);
  const background=selected?(format.buttonSelectedBackground||'#16a34a'):(format.buttonPreset==='gradient'
    ?`linear-gradient(${format.buttonGradientDirection==='down'?'180deg':format.buttonGradientDirection==='diagonal'?'135deg':'90deg'},${format.buttonBackground||'#2563eb'},${format.buttonBackground2||'#7c3aed'})`
    :(format.buttonPreset==='glass'?`linear-gradient(135deg,${format.buttonBackground||'rgba(255,255,255,.22)'},${format.buttonBackground2||'rgba(255,255,255,.10)'})`:(format.buttonBackground||'#2563eb')));
  return {
    '--button-bg':background,'--button-text':selected?(format.buttonSelectedTextColor||'#ffffff'):(format.buttonTextColor||'#ffffff'),
    '--button-icon':selected?(format.buttonSelectedTextColor||'#ffffff'):(format.buttonIconColor||format.buttonTextColor||'#ffffff'),
    '--button-hover-bg':format.buttonHoverBackground||format.buttonBackground||'#1d4ed8','--button-hover-text':format.buttonHoverTextColor||format.buttonTextColor||'#ffffff','--button-hover-icon':format.buttonHoverIconColor||format.buttonIconColor||format.buttonTextColor||'#ffffff',
    '--button-pressed-bg':format.buttonPressedBackground||'#1e40af','--button-pressed-text':format.buttonPressedTextColor||'#ffffff','--button-focus':format.buttonFocusColor||'#60a5fa',
    '--button-disabled-bg':format.buttonDisabledBackground||'#e5e7eb','--button-disabled-text':format.buttonDisabledTextColor||'#9ca3af','--button-font-size':`${format.buttonFontSize||13}px`,
    background,color:selected?(format.buttonSelectedTextColor||'#ffffff'):(format.buttonTextColor||'#ffffff'),fontSize:format.buttonFontSize||13,fontWeight:format.buttonBold===false?400:700,fontStyle:format.buttonItalic?'italic':'normal',
    borderRadius:radius,border:format.buttonBorderVisible?`${format.buttonBorderWidth??1}px solid ${selected?(format.buttonSelectedBorderColor||'#15803d'):(format.buttonBorderColor||'#1d4ed8')}`:'none',
    padding:`${format.buttonPaddingY??10}px ${format.buttonPaddingX??18}px`,boxShadow:format.buttonShadow?'0 10px 24px rgba(15,23,42,.16)':'none'
  } as any;
}
