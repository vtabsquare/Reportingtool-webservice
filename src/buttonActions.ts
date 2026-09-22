import type {Page,Visual,VisualAction,VisualActionStep} from './types';

export type ResolvedActionCommand={operation:'show'|'hide'|'toggle';targets:Visual[]};
export function resolveActionCommands(action:VisualAction,page:Page):ResolvedActionCommand[]{
  const resolve=(step:VisualActionStep):ResolvedActionCommand=>({operation:step.operation,targets:step.targetType==='group'?page.visuals.filter(item=>item.groupId===step.targetId):page.visuals.filter(item=>item.id===step.targetId)});
  if(action.type==='custom')return(action.steps||[]).filter(step=>step.targetId).map(resolve);
  if(action.targetVisualId&&['showVisual','hideVisual','toggleVisual'].includes(action.type||''))return[resolve({operation:action.type==='showVisual'?'show':action.type==='hideVisual'?'hide':'toggle',targetType:'visual',targetId:action.targetVisualId})];
  if(action.targetGroupId&&['showGroup','hideGroup','toggleGroup'].includes(action.type||''))return[resolve({operation:action.type==='showGroup'?'show':action.type==='hideGroup'?'hide':'toggle',targetType:'group',targetId:action.targetGroupId})];
  return[];
}

export const visualIsHidden=(visual:Visual,overrides:Record<string,boolean>={})=>
  Object.prototype.hasOwnProperty.call(overrides,visual.id)?!!overrides[visual.id]:!!visual.hidden;

const targetName=(visual:Visual|undefined,fallback:string)=>visual?.title?.trim()||fallback;

export function resolveActionButtonLabel(button:Visual,page:Page,pages:Page[],overrides:Record<string,boolean>={}){
  const action=button.action;
  if(!action||action.type==='none'||action.dynamicLabel===false)return button.buttonLabel||'Action Button';
  const target=page.visuals.find(item=>item.id===action.targetVisualId);
  const visualName=targetName(target,'visual');
  const groupName=action.targetGroupId?.trim()||'group';
  const groupMembers=page.visuals.filter(item=>item.groupId===action.targetGroupId);
  const groupHidden=groupMembers.length>0&&groupMembers.every(item=>visualIsHidden(item,overrides));
  if(action.type==='navigate'){
    const targetPage=pages.find(item=>item.id===action.targetPageId);
    return targetPage?`Go to ${targetPage.name}`:action.targetReportId?'Open report':'Go to page';
  }
  if(action.type==='showVisual')return `Show ${visualName}`;
  if(action.type==='hideVisual')return `Hide ${visualName}`;
  if(action.type==='toggleVisual')return visualIsHidden(target||({id:''} as Visual),overrides)?`Show ${visualName}`:`Hide ${visualName}`;
  if(action.type==='showGroup')return `Show ${groupName}`;
  if(action.type==='hideGroup')return `Hide ${groupName}`;
  if(action.type==='toggleGroup')return groupHidden?`Show ${groupName}`:`Hide ${groupName}`;
  if(action.type==='custom')return button.buttonLabel&&button.buttonLabel!=='Action Button'?button.buttonLabel:'Run action';
  if(action.type==='back')return 'Back';
  if(action.type==='resetState')return 'Reset page';
  if(action.type==='clearFilters')return 'Clear filters';
  return button.buttonLabel||'Action Button';
}
