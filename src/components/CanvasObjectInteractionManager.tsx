import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent,type ReactNode} from 'react';
import type {Visual} from '../types';

export type CanvasInteractionState='IDLE'|'OBJECT_SELECTED'|'MOVING'|'RESIZING'|'TEXT_EDITING';
type Handle='nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w';
type Geometry={x:number;y:number;w:number;h:number};
type Props={
  visuals:Visual[];selectedIds:string[];primaryId:string|null;scale:number;canvasWidth:number;canvasHeight:number;snapToGrid:boolean;preventOverlap?:boolean;
  onSelect:(id:string,additive:boolean)=>void;onGeometry:(items:Record<string,Geometry>)=>void;render:(visual:Visual)=>ReactNode;
};

/** Returns true if two axis-aligned rects intersect (touching edges are NOT overlapping). */
function rectsOverlap(a:Geometry,b:Geometry):boolean{
  return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
}

const MIN_W=40,MIN_H=30,GRID=16;
const snap=(value:number,enabled:boolean)=>enabled?Math.round(value/GRID)*GRID:Math.round(value);
const interactive='input,select,textarea,a,[contenteditable="true"],.slicerList,.slicerDropdownTrigger,.slicerDropdownMenu,.slicerSearchRow,.slicerListItem,.visualHeaderActions,.richTextToolbar,button:not(.buttonVisualOnly)';

export default function CanvasObjectInteractionManager({visuals,selectedIds,primaryId,scale,canvasWidth,canvasHeight,snapToGrid,preventOverlap,onSelect,onGeometry,render}:Props){
  const[state,setState]=useState<CanvasInteractionState>(primaryId?'OBJECT_SELECTED':'IDLE');
  const[draft,setDraft]=useState<Record<string,Geometry>>({});
  const operation=useRef<{kind:'move'|'resize';handle?:Handle;startX:number;startY:number;items:Record<string,Geometry>;primary:Geometry;ratio:number;moved:boolean}|null>(null);
  const suppressClick=useRef<{id:string;until:number}|null>(null);
  useEffect(()=>setState(primaryId?'OBJECT_SELECTED':'IDLE'),[primaryId]);
  useEffect(()=>()=>{window.onpointermove=null;window.onpointerup=null},[]);
  const geometry=(visual:Visual):Geometry=>draft[visual.id]||{x:visual.x,y:visual.y,w:visual.w,h:visual.h};
  const finish=()=>{const op=operation.current;if(op?.kind==='move'&&op.moved){const movedId=primaryId&&op.items[primaryId]?primaryId:Object.keys(op.items)[0];suppressClick.current={id:movedId,until:Date.now()+250}}operation.current=null;setDraft({});setState(primaryId?'OBJECT_SELECTED':'IDLE');window.onpointermove=null;window.onpointerup=null};
  const begin=(event:ReactPointerEvent,id:string,kind:'move'|'resize',handle?:Handle)=>{
    if(event.button!==0)return;const visual=visuals.find(item=>item.id===id);if(!visual||visual.locked)return;
    if(kind==='move'&&(event.target as HTMLElement).closest(interactive))return;
    if(!(event.target as HTMLElement).closest('.buttonVisualOnly'))event.preventDefault();event.stopPropagation();const additive=event.ctrlKey||event.metaKey||event.shiftKey;
    if(!selectedIds.includes(id)||additive)onSelect(id,additive);
    const active=(selectedIds.includes(id)?visuals.filter(item=>selectedIds.includes(item.id)&&!item.locked):[visual]).reduce<Record<string,Geometry>>((all,item)=>(all[item.id]={x:item.x,y:item.y,w:item.w,h:item.h},all),{});
    const primary=active[id]||{x:visual.x,y:visual.y,w:visual.w,h:visual.h};operation.current={kind,handle,startX:event.clientX,startY:event.clientY,items:active,primary,ratio:primary.w/primary.h,moved:false};setState(kind==='move'?'MOVING':'RESIZING');
    window.onpointermove=move;window.onpointerup=finish;
  };
  const move=(event:PointerEvent)=>{
    const op=operation.current;if(!op)return;const dx=(event.clientX-op.startX)/Math.max(.1,scale),dy=(event.clientY-op.startY)/Math.max(.1,scale);if(Math.abs(event.clientX-op.startX)>3||Math.abs(event.clientY-op.startY)>3)op.moved=true;const next:Record<string,Geometry>={};
    if(op.kind==='move'){
      const items=Object.values(op.items),minX=Math.min(...items.map(item=>item.x)),minY=Math.min(...items.map(item=>item.y));
      const maxRight=Math.max(...items.map(item=>item.x+item.w)),maxBottom=Math.max(...items.map(item=>item.y+item.h));
      const snappedDx=snap(op.primary.x+dx,snapToGrid)-op.primary.x,snappedDy=snap(op.primary.y+dy,snapToGrid)-op.primary.y;
      let boundedDx=Math.max(-minX,Math.min(canvasWidth-maxRight,snappedDx)),boundedDy=Math.max(-minY,Math.min(canvasHeight-maxBottom,snappedDy));

      // --- Prevent overlap: slide up to the nearest obstacle edge, don't snap back ---
      if(preventOverlap){
        const movingIds=new Set(Object.keys(op.items));
        const statics=visuals.filter(v=>!movingIds.has(v.id)&&v.visible!==false&&!v.hidden&&!v.locked);
        // Test each axis independently (so diagonal movement works correctly)
        const testX=(tryDx:number)=>Object.values(op.items).some(g=>
          statics.some(s=>rectsOverlap({x:g.x+tryDx,y:g.y,w:g.w,h:g.h},{x:s.x,y:s.y,w:s.w,h:s.h}))
        );
        const testY=(tryDy:number)=>Object.values(op.items).some(g=>
          statics.some(s=>rectsOverlap({x:g.x,y:g.y+tryDy,w:g.w,h:g.h},{x:s.x,y:s.y,w:s.w,h:s.h}))
        );
        // Binary-search for the maximum safe delta — visual slides up to the wall and stops
        if(testX(boundedDx)){
          let lo=0,hi=boundedDx;
          if(boundedDx<0){lo=boundedDx;hi=0;}
          for(let i=0;i<10;i++){const mid=(lo+hi)/2;if(testX(mid)){if(boundedDx>=0)hi=mid;else lo=mid;}else{if(boundedDx>=0)lo=mid;else hi=mid;}}
          boundedDx=Math.round(boundedDx>=0?lo:hi);
          if(testX(boundedDx))boundedDx=0; // final safety check
        }
        if(testY(boundedDy)){
          let lo=0,hi=boundedDy;
          if(boundedDy<0){lo=boundedDy;hi=0;}
          for(let i=0;i<10;i++){const mid=(lo+hi)/2;if(testY(mid)){if(boundedDy>=0)hi=mid;else lo=mid;}else{if(boundedDy>=0)lo=mid;else hi=mid;}}
          boundedDy=Math.round(boundedDy>=0?lo:hi);
          if(testY(boundedDy))boundedDy=0; // final safety check
        }
      }

      for(const[id,start]of Object.entries(op.items))next[id]={...start,x:start.x+boundedDx,y:start.y+boundedDy};
    }
    else{
      const h=op.handle!,start=op.primary,right=start.x+start.w,bottom=start.y+start.h;let x=start.x,y=start.y,w=start.w,hgt=start.h;
      if(h.includes('e'))w=Math.max(MIN_W,Math.min(canvasWidth-start.x,start.w+dx));if(h.includes('s'))hgt=Math.max(MIN_H,Math.min(canvasHeight-start.y,start.h+dy));
      if(h.includes('w')){x=Math.max(0,Math.min(right-MIN_W,start.x+dx));w=right-x}if(h.includes('n')){y=Math.max(0,Math.min(bottom-MIN_H,start.y+dy));hgt=bottom-y}
      if(event.shiftKey&&h.length===2){if(Math.abs(dx)>=Math.abs(dy)){hgt=w/op.ratio;if(h.includes('n'))y=bottom-hgt}else{w=hgt*op.ratio;if(h.includes('w'))x=right-w}}
      x=Math.max(0,Math.min(canvasWidth-MIN_W,snap(x,snapToGrid)));y=Math.max(0,Math.min(canvasHeight-MIN_H,snap(y,snapToGrid)));
      w=Math.max(MIN_W,Math.min(canvasWidth-x,Math.round(w)));hgt=Math.max(MIN_H,Math.min(canvasHeight-y,Math.round(hgt)));
      next[primaryId||Object.keys(op.items)[0]]={x,y,w,h:hgt};
    }
    setDraft(next);onGeometry(next);
  };
  return <div className={'canvasObjectInteractionManager state-'+state.toLowerCase()} data-interaction-state={state}>
    <div className="canvasObjectLayer">{visuals.map((visual,index)=>{const g=geometry(visual);return <div key={visual.id} className="canvasObject" data-object-id={visual.id} style={{left:g.x,top:g.y,width:g.w,height:g.h,zIndex:visual.zIndex??index,transform:`rotate(${visual.rotation||0}deg)`,display:visual.visible===false||visual.hidden?'none':'block'}} onClickCapture={event=>{const blocked=suppressClick.current;if(blocked?.id===visual.id&&blocked.until>Date.now()){event.preventDefault();event.stopPropagation();suppressClick.current=null}}} onPointerDown={event=>begin(event,visual.id,'move')}>{render(visual)}</div>})}</div>
    <div className="canvasInteractionLayer">{visuals.filter(v=>selectedIds.includes(v.id)&&v.visible!==false&&!v.hidden).map(visual=>{const g=geometry(visual);return <div key={visual.id} className={'canvasSelectionFrame '+(visual.locked?'locked':'')} style={{left:g.x,top:g.y,width:g.w,height:g.h,zIndex:10000+(visual.zIndex||0),transform:`rotate(${visual.rotation||0}deg)`}}>{visual.id===primaryId&&!visual.locked&&(['nw','n','ne','e','se','s','sw','w'] as Handle[]).map(handle=><span key={handle} className={'canvasResizeHandle handle-'+handle} onMouseDown={event=>event.stopPropagation()} onPointerDown={event=>begin(event,visual.id,'resize',handle)}/>)}</div>})}</div>
  </div>;
}
