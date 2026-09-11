import React from 'react';
import{createRoot}from'react-dom/client';
import'./styles.css';
import'./powerbi.css';
import'@xyflow/react/dist/style.css';

const root=createRoot(document.getElementById('root')!);

if (!window.crypto) {
  (window as any).crypto = {};
}
if (!window.crypto.randomUUID) {
  (window.crypto as any).randomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
  };
}

(window as any).vtabPrompt = (msg: string, def: string = '') => new Promise<string | null>(resolve => {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:999999;font-family:Aptos,sans-serif';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:white;padding:24px;border-radius:12px;width:340px;box-shadow:0 10px 25px rgba(0,0,0,0.2)';
  const label = document.createElement('div');
  label.innerText = msg;
  label.style.cssText = 'margin-bottom:12px;font-weight:600;font-size:15px;color:#1e293b';
  const input = document.createElement('input');
  input.value = def;
  input.style.cssText = 'width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:20px;box-sizing:border-box;font-size:14px;outline:none';
  input.onfocus = () => { input.style.borderColor = '#2563eb'; input.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.1)'; };
  input.onblur = () => { input.style.borderColor = '#cbd5e1'; input.style.boxShadow = 'none'; };
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;justify-content:flex-end;gap:10px';
  const cancel = document.createElement('button');
  cancel.innerText = 'Cancel';
  cancel.style.cssText = 'padding:8px 16px;background:#f1f5f9;border:0;border-radius:8px;cursor:pointer;font-weight:600;color:#475569';
  const ok = document.createElement('button');
  ok.innerText = 'OK';
  ok.style.cssText = 'padding:8px 16px;background:#2563eb;color:white;border:0;border-radius:8px;cursor:pointer;font-weight:600';
  btns.append(cancel, ok);
  dialog.append(label, input, btns);
  overlay.append(dialog);
  document.body.append(overlay);
  input.focus();
  input.select();
  const cleanup = () => overlay.remove();
  cancel.onclick = () => { resolve(null); cleanup(); };
  ok.onclick = () => { resolve(input.value); cleanup(); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') ok.click();
    if (e.key === 'Escape') cancel.click();
  };
});

function StartupError({error}:{error:any}){
  return <div style={{minHeight:'100vh',display:'grid',placeItems:'center',background:'#eef4f8',color:'#111827',fontFamily:'Aptos, Segoe UI, sans-serif',padding:24}}>
    <div style={{maxWidth:720,width:'100%',background:'#fff',border:'1px solid #cbd5e1',borderRadius:16,padding:28,boxShadow:'0 18px 55px #0f172a22'}}>
      <div style={{fontSize:12,fontWeight:800,letterSpacing:'.12em',color:'#2563eb'}}>VTAB REPORTING STUDIO</div>
      <h2 style={{margin:'10px 0 8px',fontSize:26}}>The application could not start</h2>
      <p style={{lineHeight:1.6,color:'#334155'}}>A frontend startup error occurred before the normal workspace could render.</p>
      <pre style={{whiteSpace:'pre-wrap',background:'#0b1725',color:'#fff',padding:14,borderRadius:10,overflow:'auto'}}>{String(error?.stack||error?.message||error)}</pre>
      <button onClick={()=>location.reload()} style={{marginTop:12,border:0,borderRadius:9,padding:'10px 16px',background:'#2563eb',color:'#fff',fontWeight:700,cursor:'pointer'}}>Reload Application</button>
    </div>
  </div>
}

import('./studio').then(({default:Studio})=>{
  root.render(<React.StrictMode><Studio/></React.StrictMode>);
}).catch(error=>{
  console.error('VTAB startup error',error);
  root.render(<StartupError error={error}/>);
});
