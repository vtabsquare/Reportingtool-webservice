import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {RefreshCw,ShieldCheck,WifiOff} from 'lucide-react';

const RETRY_SECONDS=5;

export default function NetworkStatusGuard({children}:{children:ReactNode}){
  const[isOffline,setIsOffline]=useState(()=>typeof navigator!=='undefined'&&!navigator.onLine);
  const[isChecking,setIsChecking]=useState(false);
  const[reconnected,setReconnected]=useState(false);
  const[countdown,setCountdown]=useState(RETRY_SECONDS);
  const[lastCheckError,setLastCheckError]=useState('');
  const mounted=useRef(true);

  const markOffline=useCallback(()=>{setIsOffline(true);setReconnected(false);setCountdown(RETRY_SECONDS)},[]);
  const checkConnection=useCallback(async()=>{
    if(typeof navigator!=='undefined'&&!navigator.onLine){setLastCheckError('Network adapter reports offline.');setIsChecking(false);return false}
    setIsChecking(true);setLastCheckError('');
    const controller=new AbortController(),timeoutId=window.setTimeout(()=>controller.abort(),3500);
    try{
      const response=await fetch(`/api/v1/health?_t=${Date.now()}`,{method:'GET',cache:'no-store',signal:controller.signal});
      if(!response.ok&&response.status>=500)throw new Error(`Health endpoint returned ${response.status}`);
      if(!mounted.current)return true;
      setReconnected(true);setLastCheckError('');
      window.setTimeout(()=>{if(mounted.current){setIsOffline(false);setReconnected(false);setIsChecking(false);setCountdown(RETRY_SECONDS)}},650);
      return true;
    }catch{
      if(mounted.current){setLastCheckError('Cannot establish a verified connection to the service.');setIsChecking(false)}
      return false;
    }finally{window.clearTimeout(timeoutId)}
  },[]);

  useEffect(()=>{
    mounted.current=true;
    const online=()=>{if(isOffline)void checkConnection()};
    const key=(event:KeyboardEvent)=>{if(event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='o'){event.preventDefault();isOffline?void checkConnection():markOffline()}};
    window.addEventListener('offline',markOffline);window.addEventListener('online',online);window.addEventListener('vtab:network-offline',markOffline as EventListener);window.addEventListener('keydown',key);
    (window as any).vtabToggleOffline=()=>isOffline?void checkConnection():markOffline();
    return()=>{mounted.current=false;window.removeEventListener('offline',markOffline);window.removeEventListener('online',online);window.removeEventListener('vtab:network-offline',markOffline as EventListener);window.removeEventListener('keydown',key);delete (window as any).vtabToggleOffline};
  },[isOffline,checkConnection,markOffline]);

  useEffect(()=>{
    if(!isOffline)return;
    const timer=window.setInterval(()=>setCountdown(value=>{if(value<=1){void checkConnection();return RETRY_SECONDS}return value-1}),1000);
    return()=>window.clearInterval(timer);
  },[isOffline,checkConnection]);

  return <>
    <div id="vtab-app-viewport" style={isOffline?{display:'none'}:{display:'contents'}} aria-hidden={isOffline}>{children}</div>
    {isOffline&&<div className="networkGuard" role="alertdialog" aria-modal="true" aria-labelledby="networkGuardTitle">
      <style>{`@keyframes vtabRadarPulse{0%{transform:scale(.55);opacity:.7}100%{transform:scale(1.35);opacity:0}}@keyframes vtabFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}@keyframes vtabSpin{to{transform:rotate(360deg)}}.networkGuard{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;overflow:hidden;background:radial-gradient(circle at 18% 12%,#2563eb2e,transparent 38%),radial-gradient(circle at 82% 80%,#e11d4824,transparent 36%),#080c14;color:#eef6ff;font-family:Aptos,"Segoe UI",sans-serif}.networkGuard:before{content:"";position:absolute;inset:-20%;background-image:linear-gradient(#60a5fa12 1px,transparent 1px),linear-gradient(90deg,#60a5fa12 1px,transparent 1px);background-size:38px 38px;transform:perspective(500px) rotateX(58deg);opacity:.55}.networkCard{position:relative;width:min(620px,calc(100vw - 36px));padding:42px;border:1px solid #93c5fd35;border-radius:24px;background:#0f172ae8;box-shadow:0 32px 100px #000a;text-align:center;backdrop-filter:blur(20px)}.networkRadar{position:relative;width:124px;height:124px;margin:0 auto 24px;display:grid;place-items:center}.networkRadar i{position:absolute;inset:0;border:1px solid #fb718577;border-radius:50%;animation:vtabRadarPulse 2.1s ease-out infinite}.networkRadar i:nth-child(2){animation-delay:.7s}.networkRadar i:nth-child(3){animation-delay:1.4s}.networkCore{position:relative;z-index:1;width:76px;height:76px;display:grid;place-items:center;border-radius:22px;background:linear-gradient(145deg,#fb7185,#be123c);box-shadow:0 0 42px #fb718566;animation:vtabFloat 3s ease-in-out infinite}.networkBeacon{display:inline-flex;gap:8px;align-items:center;padding:6px 11px;border-radius:999px;background:#88133766;color:#fda4af;font-size:11px;font-weight:800;letter-spacing:.12em}.networkBeacon:before{content:"";width:7px;height:7px;border-radius:50%;background:#fb7185;box-shadow:0 0 12px #fb7185}.networkCard h1{font-size:34px;margin:14px 0 10px}.networkCard>p{max-width:500px;margin:0 auto;color:#b7c5d8;line-height:1.65}.networkDiagnostics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:28px 0 20px}.networkDiagnostics div{padding:13px;border:1px solid #94a3b829;border-radius:12px;background:#02061766}.networkDiagnostics small{display:block;color:#8292a8;font-size:10px;text-transform:uppercase;letter-spacing:.1em}.networkDiagnostics b{display:block;margin-top:5px;font-size:13px}.networkAction{display:inline-flex;align-items:center;gap:9px;padding:11px 18px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:750;cursor:pointer}.networkAction:disabled{opacity:.7;cursor:wait}.networkAction svg.spin{animation:vtabSpin .8s linear infinite}.networkError{min-height:20px;margin-top:14px;color:#fda4af;font-size:12px}@media(max-width:560px){.networkCard{padding:30px 20px}.networkDiagnostics{grid-template-columns:1fr}.networkCard h1{font-size:27px}}`}</style>
      <section className="networkCard">
        <div className="networkBeacon">LOST INTERNET CONNECTION</div>
        <div className="networkRadar"><i/><i/><i/><div className="networkCore"><WifiOff size={34}/></div></div>
        <h1 id="networkGuardTitle">{reconnected?'Connection Restored!':"You're Currently Offline"}</h1>
        <p>Your workspace and unsaved items are safely preserved. The application will restore this exact view after a verified connection returns.</p>
        <div className="networkDiagnostics"><div><small>Network</small><b>{reconnected?'Online':'Offline'}</b></div><div><small>Session data</small><b><ShieldCheck size={14}/> Protected</b></div><div><small>Auto-reconnect</small><b>{isChecking?'Checking…':`In ${countdown}s`}</b></div></div>
        <button className="networkAction" disabled={isChecking||reconnected} onClick={()=>void checkConnection()}><RefreshCw className={isChecking?'spin':''} size={17}/>{isChecking?'Checking connection…':'Try Reconnecting Now'}</button>
        <div className="networkError">{lastCheckError}</div>
      </section>
    </div>}
  </>;
}

