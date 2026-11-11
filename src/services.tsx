import{useEffect,useState}from'react';
import SupabaseAuthGate from'./v11/SupabaseAuthGate';
import CloudWorkspace from'./v11/CloudWorkspace';
import PublishedViewer from'./v11/PublishedViewer';

/** Lightweight production entry for Reporting Services.
 *
 * Keeping this separate from studio.tsx means public viewers do not download
 * the Desktop authoring, transform, model and report-designer code.
 */
export default function Services(){
 const[session,setSession]=useState<any>(null),[ready,setReady]=useState(false);
 const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
 const isEmbed = params?.get('embed') === '1' || params?.get('public') === '1';
 const embedReportId = params?.get('report');
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
 // ── Embed / iframe check runs BEFORE the session gate ───────────────────────
 // Always uses vtabpublicuser@gmail.com so the Admin Console UI-permission
 // settings for that account are enforced in every embedded report view.
 // Non-embed (direct portal) flow is completely unaffected.
 if(isEmbed && embedReportId){
   const EMBED_VIEWER_EMAIL = 'vtabpublicuser@gmail.com';
   return (
    <div className="pbi-app-shell" style={{width:'100vw',height:'100vh',overflow:'hidden',display:'flex',flexDirection:'column'}}>
     <PublishedViewer
       reportId={embedReportId}
       embedded={true}
       cloudMode={true}
       userRole="Viewer"
       currentUserEmail={EMBED_VIEWER_EMAIL}
     />
    </div>
   );
  }

 if(!session)return <SupabaseAuthGate onSignedIn={setSession}/>;
 return <CloudWorkspace session={session}/>;
}
