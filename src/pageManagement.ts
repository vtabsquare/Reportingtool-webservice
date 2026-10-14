import type {Page} from './types';

type ReportPages={activePageId:string;pages:Page[]};
export type PageRemovalResult={deleted:boolean;activePageId:string;removedIndex:number};

export function removeReportPage(report:ReportPages,pageId:string):PageRemovalResult{
  const removedIndex=report.pages.findIndex(page=>page.id===pageId);
  if(removedIndex<0||report.pages.length<=1)return{deleted:false,activePageId:report.activePageId,removedIndex};

  const remaining=report.pages.filter(page=>page.id!==pageId);
  const activeStillExists=remaining.some(page=>page.id===report.activePageId);
  const activePageId=activeStillExists
    ?report.activePageId
    :remaining[Math.min(removedIndex,remaining.length-1)].id;

  // Local page-navigation buttons must not retain a target that no longer exists.
  for(const page of remaining){
    for(const visual of page.visuals||[]){
      if(visual.action?.type==='navigate'&&!visual.action.targetReportId&&visual.action.targetPageId===pageId){
        visual.action.targetPageId=undefined;
      }
    }
  }

  report.pages=remaining;
  report.activePageId=activePageId;
  return{deleted:true,activePageId,removedIndex};
}
