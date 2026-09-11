import { create } from 'zustand';
import type { Project } from './types';
import { api } from './api';

type SaveStatus='idle'|'pending'|'saving'|'saved'|'error';

type S = {
  project: Project | null;
  view: string;
  selectedVisualId: string | null;
  loading: boolean;
  error: string | null;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSavedAt: string | null;
  history: Project[];
  future: Project[];
  canUndo: boolean;
  canRedo: boolean;
  navCollapsed: boolean;
  load: () => Promise<void>;
  setView: (v: string) => void;
  selectVisual: (id: string | null) => void;
  update: (fn: (p: Project) => Project) => void;
  replaceProject: (project: Project, recordHistory?: boolean) => void;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;
  toggleNavCollapsed: () => void;
  setNavCollapsed: (v: boolean) => void;
};

const MAX_HISTORY=50;
const AUTOSAVE_DELAY_MS=650;
const clone=(p:Project)=>structuredClone(p);
let pendingProject:Project|null=null;
let saveTimer:ReturnType<typeof setTimeout>|null=null;
let saveChain:Promise<void>=Promise.resolve();
let latestRevision=0;

const persistProject=async(p:Project)=>{
  const reportId=p.report?.id;
  const path=reportId?`/reports/${encodeURIComponent(reportId)}/project`:'/project';
  await api(path,{method:'PUT',body:JSON.stringify(p)});
};

const enqueuePersist=(project?:Project)=>{
  if(project)pendingProject=clone(project);
  if(!pendingProject)return saveChain;
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null}
  const snapshot=pendingProject;pendingProject=null;
  const revision=latestRevision;
  saveChain=saveChain.catch(()=>{}).then(async()=>{
    useStudio.setState({saveStatus:'saving',saveError:null});
    try{
      await persistProject(snapshot);
      if(revision===latestRevision&&!pendingProject){
        useStudio.setState({saveStatus:'saved',saveError:null,lastSavedAt:new Date().toISOString()});
      }
    }catch(e:any){
      if(revision===latestRevision)useStudio.setState({saveStatus:'error',saveError:e?.message||String(e)});
      throw e;
    }
  });
  return saveChain;
};

const schedulePersist=(project:Project)=>{
  latestRevision+=1;
  pendingProject=clone(project);
  useStudio.setState({saveStatus:'pending',saveError:null});
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;void enqueuePersist().catch(()=>{})},AUTOSAVE_DELAY_MS);
};

const markDirtyWithoutAutosave=()=>{
  latestRevision+=1;
  pendingProject=null;
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null}
  useStudio.setState({saveStatus:'pending',saveError:null});
};

export const useStudio = create<S>((set,get)=>({
  project:null,view:'home',selectedVisualId:null,loading:false,error:null,
  saveStatus:'idle',saveError:null,lastSavedAt:null,history:[],future:[],canUndo:false,canRedo:false,navCollapsed:false,

  load:async()=>{
    set({loading:true,error:null});
    try{
      const project=await api<Project>('/project');
      if(!project)throw new Error('Backend returned no project.');
      const remembered=project.appPreferences?.rememberWorkspace!==false?localStorage.getItem('vtab.lastWorkspace'):null;
      set({project,view:remembered||get().view,loading:false,history:[],future:[],canUndo:false,canRedo:false,saveStatus:'idle',saveError:null});
    }catch(e:any){set({loading:false,error:e?.message||String(e)})}
  },

  setView:(view)=>{const project=get().project;if(project?.appPreferences?.rememberWorkspace!==false)localStorage.setItem('vtab.lastWorkspace',view);else localStorage.removeItem('vtab.lastWorkspace');set({view})},
  toggleNavCollapsed:()=>set(s=>({navCollapsed:!s.navCollapsed})),
  setNavCollapsed:(navCollapsed)=>set({navCollapsed}),
  selectVisual:(selectedVisualId)=>set({selectedVisualId}),

  update:(fn)=>set(s=>{
    if(!s.project)return{} as any;
    const before=clone(s.project);const after=fn(clone(s.project));
    const history=[...s.history.slice(-(MAX_HISTORY-1)),before];
    const preferenceChanged=JSON.stringify(before.appPreferences||{})!==JSON.stringify(after.appPreferences||{});
    if(after.appPreferences?.rememberWorkspace===false)localStorage.removeItem('vtab.lastWorkspace');
    if(after.appPreferences?.autosave!==false||preferenceChanged)schedulePersist(after);else markDirtyWithoutAutosave();
    return{project:after,history,future:[],canUndo:true,canRedo:false};
  }),

  replaceProject:(project,recordHistory=true)=>set(s=>{
    if(!recordHistory||!s.project)return{project,selectedVisualId:null,lastSavedAt:null,saveStatus:'idle',saveError:null};
    const history=[...s.history.slice(-(MAX_HISTORY-1)),clone(s.project)];
    if(project.appPreferences?.autosave!==false)schedulePersist(project);else markDirtyWithoutAutosave();
    return{project,selectedVisualId:null,history,future:[],canUndo:true,canRedo:false};
  }),

  undo:()=>{
    const s=get();if(!s.project||!s.history.length)return;
    const previous=s.history[s.history.length-1];
    const history=s.history.slice(0,-1);const future=[clone(s.project),...s.future].slice(0,MAX_HISTORY);
    const next=clone(previous);set({project:next,history,future,canUndo:history.length>0,canRedo:true,selectedVisualId:null});if(next.appPreferences?.autosave!==false)schedulePersist(next);else markDirtyWithoutAutosave();
  },
  redo:()=>{
    const s=get();if(!s.project||!s.future.length)return;
    const next=s.future[0];const future=s.future.slice(1);const history=[...s.history,clone(s.project)].slice(-MAX_HISTORY);
    const project=clone(next);set({project,history,future,canUndo:true,canRedo:future.length>0,selectedVisualId:null});if(project.appPreferences?.autosave!==false)schedulePersist(project);else markDirtyWithoutAutosave();
  },

  save:async()=>{
    const current=get().project;if(!current)return;
    const project=clone(current);
    if(!project.report.name||project.report.name.trim()==='Untitled Report'){
      const name=await (window as any).vtabPrompt('Report name',project.report.name||'Untitled Report');if(!name?.trim())return;
      project.report.name=name.trim();project.name=name.trim();set({project});
    }
    latestRevision+=1;pendingProject=clone(project);
    await enqueuePersist();
  }
}));
