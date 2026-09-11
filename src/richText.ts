const ALLOWED_TAGS=new Set(['B','STRONG','I','EM','U','BR','P','DIV','SPAN','UL','OL','LI']);
const ALLOWED_STYLES=new Set(['color','font-family','font-size','font-weight','font-style','text-decoration','text-align']);

export function sanitizeRichText(value:string):string{
 if(!value)return'';
 if(typeof DOMParser==='undefined')return escapeHtml(value);
 const documentNode=new DOMParser().parseFromString(`<div>${value}</div>`,'text/html');
 const clean=(node:Node):string=>{
  if(node.nodeType===Node.TEXT_NODE)return escapeHtml(node.textContent||'');
  if(node.nodeType!==Node.ELEMENT_NODE)return'';
  const element=node as HTMLElement;
  const children=Array.from(element.childNodes).map(clean).join('');
  if(!ALLOWED_TAGS.has(element.tagName))return children;
  const styles=Array.from(element.style).filter(name=>ALLOWED_STYLES.has(name)).map(name=>`${name}:${element.style.getPropertyValue(name)}`).join(';');
  const styleAttribute=styles?` style="${escapeAttribute(styles)}"`:'';
  const tag=element.tagName.toLowerCase();
  return tag==='br'?'<br>':`<${tag}${styleAttribute}>${children}</${tag}>`;
 };
 return Array.from(documentNode.body.firstElementChild?.childNodes||[]).map(clean).join('');
}

export function richTextHtml(richText?:string,text?:string):string{
 return richText?sanitizeRichText(richText):escapeHtml(text||'').replace(/\n/g,'<br>');
}

function escapeHtml(value:string):string{return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]||char))}
function escapeAttribute(value:string):string{return value.replace(/[&"<>]/g,char=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[char]||char))}
