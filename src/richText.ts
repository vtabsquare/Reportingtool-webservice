const ALLOWED_TAGS=new Set(['B','STRONG','I','EM','U','S','STRIKE','DIV','P','BR','UL','OL','LI','A','SPAN','FONT','SUP','SUB']);
const ALLOWED_STYLES=new Set(['color','background-color','font-family','font-size','font-weight','font-style','text-decoration','text-align']);

export const escapeRichText=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)).replace(/\r?\n/g,'<br>');

export function sanitizeRichText(value:string){
  if(typeof document==='undefined')return value;
  const template=document.createElement('template');
  template.innerHTML=value;
  const clean=(parent:ParentNode)=>{
    for(const node of Array.from(parent.childNodes)){
      if(node.nodeType===Node.COMMENT_NODE){node.remove();continue}
      if(!(node instanceof HTMLElement))continue;
      if(!ALLOWED_TAGS.has(node.tagName)){
        if(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED'].includes(node.tagName)){node.remove();continue}
        clean(node);node.replaceWith(...Array.from(node.childNodes));continue;
      }
      for(const attribute of Array.from(node.attributes)){
        const name=attribute.name.toLowerCase();
        if(name==='style'){
          const safe=Array.from(node.style).filter(key=>ALLOWED_STYLES.has(key)).map(key=>`${key}:${node.style.getPropertyValue(key)}`).join(';');
          safe?node.setAttribute('style',safe):node.removeAttribute('style');continue;
        }
        const allowed=name==='color'||name==='face'||name==='size'||(node.tagName==='A'&&(name==='href'||name==='target'||name==='rel'));
        if(!allowed)node.removeAttribute(attribute.name);
      }
      if(node.tagName==='A'){
        const href=node.getAttribute('href')||'';
        if(!/^(https?:|mailto:|#)/i.test(href))node.removeAttribute('href');
        node.setAttribute('rel','noopener noreferrer');node.setAttribute('target','_blank');
      }
      clean(node);
    }
  };
  clean(template.content);
  return template.innerHTML;
}

export const richTextHtml=(richText:string|undefined,text:string|undefined)=>sanitizeRichText(richText||escapeRichText(text||''));

export function extractRichTextRuns(root:HTMLElement){
  const runs:Array<{text:string;bold?:boolean;italic?:boolean;underline?:boolean;fontFamily?:string;fontSize?:number;color?:string;align?:'left'|'center'|'right'|'justify';list?:'bullet'|'number'}>=[];
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node:Node|null;
  while(node=walker.nextNode()){
    if(!node.textContent)continue;const parent=node.parentElement;if(!parent)continue;const style=getComputedStyle(parent),list=parent.closest('ul')?'bullet':parent.closest('ol')?'number':undefined,align=(style.textAlign||'left') as any;
    runs.push({text:node.textContent,bold:Number(style.fontWeight)>=600,italic:style.fontStyle==='italic',underline:style.textDecorationLine.includes('underline'),fontFamily:style.fontFamily,fontSize:parseFloat(style.fontSize)||undefined,color:style.color,align,list});
  }
  return runs;
}
