import{useEffect,useState}from'react';
import SupabaseAuthGate from'./v11/SupabaseAuthGate';
import CloudWorkspace from'./v11/CloudWorkspace';

/** Lightweight production entry for Reporting Services.
 *
 * Keeping this separate from studio.tsx means public viewers do not download
 * the Desktop authoring, transform, model and report-designer code.
 */
export default function Services(){
 const[session,setSession]=useState<any>(null),[ready,setReady]=useState(false);
 useEffect(()=>{document.documentElement.dataset.theme='vtab';document.documentElement.dataset.colorMode='light';document.documentElement.style.colorScheme='light';document.documentElement.dataset.density='comfortable'},[]);
 useEffect(()=>{
  let unsubscribe=()=>{};
  import('./supabase').then(({supabase})=>{
   if(!supabase){setReady(true);return}
   supabase.auth.getSession().then(({data})=>{if(data.session){localStorage.setItem('vtab_supabase_token',data.session.access_token);setSession(data.session)}setReady(true)});
   const{data:{subscription}}=supabase.auth.onAuthStateChange((event,next)=>{
    if(next){localStorage.setItem('vtab_supabase_token',next.access_token);setSession(next)}
    else if(event==='SIGNED_OUT'){localStorage.removeItem('vtab_supabase_token');setSession(null)}
   });
   unsubscribe=()=>subscription.unsubscribe();
  }).catch(()=>setReady(true));
  return()=>unsubscribe();
 },[]);
 if(!ready)return <div className="loading"><div className="brandMark">V</div><span>Loading workspace…</span></div>;
 if(!session)return <SupabaseAuthGate onSignedIn={setSession}/>;
 return <CloudWorkspace session={session}/>;
}
