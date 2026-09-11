// Detect Tauri desktop context across all platforms:
//  - tauri://localhost  → Linux / macOS (Tauri v2)
//  - http://tauri.localhost → Windows (Tauri v2, WebView2)
//  - window.__TAURI__ global → injected by Tauri in all versions
// In any of these cases we MUST use the absolute backend URL because
// there is no dev-server proxy available in the packaged app.
const _envBaseRaw=(import.meta as any).env?.VITE_API_URL;
let _envBase: string | undefined = undefined;
if (typeof _envBaseRaw === 'string' && !/\.supabase\.co/i.test(_envBaseRaw)) {
  _envBase = _envBaseRaw.replace(/\/+$/, ''); // strip trailing slash
  if (!_envBase.endsWith('/api/v1')) {
    _envBase += '/api/v1'; // auto-append path if user forgot it
  }
}
const _isDesktop=typeof window!=='undefined'&&(
  window.location.protocol==='tauri:'||
  window.location.hostname==='tauri.localhost'||
  !!(window as any).__TAURI__||
  !!(window as any).__VTAB_DESKTOP__
);
const _isTauri=typeof window!=='undefined'&&!!(window as any).__TAURI__;
const _desktopBase=typeof window!=='undefined'&&(window as any).__VTAB_DESKTOP__?.apiBase;
const FALLBACK_BASE=_envBase||(typeof _desktopBase==='string'&&_desktopBase?_desktopBase:(_isDesktop?'http://127.0.0.1:8820/api/v1':'/api/v1'));
let runtimeBase:string|undefined;
async function apiBase():Promise<string>{
  if(runtimeBase)return runtimeBase;
  if(_isTauri){
    const invoke=(window as any).__TAURI__?.core?.invoke||(window as any).__TAURI__?.invoke;
    if(invoke){
      try{const value=await invoke('api_base');if(typeof value==='string'&&value){runtimeBase=value;return value;}}catch{}
    }
  }
  return FALLBACK_BASE;
}
async function jsonResponse<T>(response:Response,base:string,path:string):Promise<T>{
  const text=await response.text();
  if(!response.ok)throw new Error(`API ${response.status}: ${text||response.statusText}`);
  const contentType=response.headers.get('content-type')||'';
  if(!contentType.toLowerCase().includes('application/json')){
    throw new Error(`VTAB local API routing failed at ${base+path}. Restart VTAB Reporting Studio and try again.`);
  }
  try{return JSON.parse(text) as T}catch{
    throw new Error(`VTAB local API returned an invalid response at ${base+path}. Restart VTAB Reporting Studio and try again.`);
  }
}
// Supabase is authoritative for Reporting Service calls. A legacy local
// workspace token may remain after upgrading an existing Desktop install, so
// never let it shadow the current Supabase session.
export function authHeaders():Record<string,string>{const token=localStorage.getItem('vtab_supabase_token')||localStorage.getItem('vtab_workspace_token');return token?{'Authorization':`Bearer ${token}`}:{}}
function mergeHeaders(base:Record<string,string>,extra?:HeadersInit){const h=new Headers(extra||{});Object.entries(base).forEach(([k,v])=>h.set(k,v));return h}
async function refreshSupabaseToken():Promise<string>{
  try{
    const{supabase}=await import('./supabase');
    if(!supabase)throw new Error('Supabase is not configured.');
    const{data,error}=await supabase.auth.refreshSession();
    if(error||!data.session?.access_token)throw error||new Error('No refreshed session was returned.');
    localStorage.setItem('vtab_supabase_token',data.session.access_token);
    localStorage.removeItem('vtab_workspace_token');
    return data.session.access_token;
  }catch(error){
    localStorage.removeItem('vtab_supabase_token');
    window.dispatchEvent(new CustomEvent('vtab:session-expired'));
    throw new Error('Your Reporting Service session expired. Sign in again, then retry Publish.');
  }
}
async function fetchWithSessionRetry(url:string,init:RequestInit):Promise<Response>{
  let response=await fetch(url,init);
  if((response.status===401||response.status===403)&&localStorage.getItem('vtab_supabase_token')){
    const detail=await response.clone().text();
    if(/session|expired|invalid.*token|jwt/i.test(detail)){
      const token=await refreshSupabaseToken();
      const headers=new Headers(init.headers||{});headers.set('Authorization',`Bearer ${token}`);
      response=await fetch(url,{...init,headers});
    }
  }
  return response;
}
export async function api<T>(path:string,init?:RequestInit):Promise<T>{
  const base=await apiBase();
  let r:Response;
  try{r=await fetchWithSessionRetry(base+path,{...init,headers:mergeHeaders({'Content-Type':'application/json',...authHeaders()},init?.headers)});}
  catch(e:any){if(String(e?.message||e).includes('session expired'))throw e;throw new Error(`Cannot reach VTAB API at ${base}. ${e?.message||e}`)}
  return jsonResponse<T>(r,base,path);
}
export async function apiForm<T>(path:string,form:FormData,init?:RequestInit):Promise<T>{
  const base=await apiBase();
  let r:Response;
  try{r=await fetchWithSessionRetry(base+path,{...init,method:init?.method||'POST',headers:mergeHeaders(authHeaders(),init?.headers),body:form});}
  catch(e:any){if(String(e?.message||e).includes('session expired'))throw e;throw new Error(`Cannot reach VTAB API at ${base}. ${e?.message||e}`)}
  return jsonResponse<T>(r,base,path);
}
export async function apiDownload(path:string,filename:string){
  const base=await apiBase();
  const r=await fetch(base+path,{headers:mergeHeaders(authHeaders())});
  if(!r.ok) throw new Error(`Export failed (${r.status}): ${await r.text()}`);
  const blob=await r.blob();

  // In Tauri desktop, blob-URL clicks are blocked by WebView2.
  // Use the native save_file_dialog Tauri command instead.
  if(_isTauri){
    const invoke=(window as any).__TAURI__?.core?.invoke||(window as any).__TAURI__?.invoke;
    if(invoke){
      try{
        const arrayBuffer=await blob.arrayBuffer();
        const bytes=Array.from(new Uint8Array(arrayBuffer));
        const saved=await invoke('save_file_dialog',{bytes,filename});
        if(!saved) return; // user cancelled
        return;
      }catch(e:any){
        // Fall through to browser method if tauri command fails
        console.warn('save_file_dialog failed, falling back to browser download:',e);
      }
    }
  }

  // Browser fallback
  const u=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=u;a.download=filename;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),2000);
}

export const API_BASE=FALLBACK_BASE;
