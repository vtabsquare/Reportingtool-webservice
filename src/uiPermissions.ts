export type ReportUiPermissions={all_commands:boolean;can_file:boolean;can_home:boolean;can_view:boolean;can_share:boolean;can_pdf:boolean;can_ppt:boolean;can_refresh:boolean;can_subscribe:boolean;can_alert:boolean;can_download:boolean};
export const DEFAULT_REPORT_UI_PERMISSIONS:ReportUiPermissions={all_commands:true,can_file:true,can_home:true,can_view:true,can_share:true,can_pdf:true,can_ppt:true,can_refresh:true,can_subscribe:true,can_alert:true,can_download:true};
const PERMISSION_ALIASES:Record<keyof ReportUiPermissions,string[]>={
  all_commands:['all_report_commands'],can_file:['file_menu','file_ribbon'],can_home:['home_ribbon'],can_view:['view_ribbon'],can_share:['share'],can_pdf:['pdf'],can_ppt:['ppt','powerpoint'],can_refresh:['refresh'],can_subscribe:['subscribe'],can_alert:['alerts','alert'],can_download:['download_project','download']
};
function findConfiguredPermission(map:any,userId?:string,userEmail?:string):Record<string,unknown>{
  if(!map||typeof map!=='object')return{};
  if(userId&&map[userId]&&typeof map[userId]==='object')return map[userId];
  const wanted=(userEmail||'').trim().toLowerCase();
  if(!wanted)return{};
  const direct=map[wanted];
  if(direct&&typeof direct==='object')return direct;
  const matchedKey=Object.keys(map).find(key=>key.trim().toLowerCase()===wanted);
  return matchedKey&&map[matchedKey]&&typeof map[matchedKey]==='object'?map[matchedKey]:{};
}
export function resolveReportUiPermissions(description:unknown,userId?:string,userEmail?:string):ReportUiPermissions{
  if(!userId && !userEmail)return{...DEFAULT_REPORT_UI_PERMISSIONS};
  try{
    const parsed=typeof description==='string'?JSON.parse(description):description;
    const map=(parsed as any)?.member_ui_permissions||{};
    const configured=findConfiguredPermission(map,userId,userEmail);
    const resolved={...DEFAULT_REPORT_UI_PERMISSIONS};
    (Object.keys(DEFAULT_REPORT_UI_PERMISSIONS) as (keyof ReportUiPermissions)[]).forEach(key=>{
      const candidates=[key,...PERMISSION_ALIASES[key]];
      const configuredKey=candidates.find(candidate=>Object.prototype.hasOwnProperty.call(configured,candidate));
      if(configuredKey)resolved[key]=Boolean((configured as any)[configuredKey]);
    });
    // `all_commands` is the Admin UI master/summary switch.  A partially enabled
    // profile intentionally stores it as false, so it must never mask individual
    // command flags at runtime.
    resolved.all_commands=(Object.keys(resolved) as (keyof ReportUiPermissions)[])
      .filter(key=>key!=='all_commands').every(key=>resolved[key]);
    return resolved;
  }catch{
    return{...DEFAULT_REPORT_UI_PERMISSIONS};
  }
}
