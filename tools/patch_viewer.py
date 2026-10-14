import sys

def patch():
    path = "src/v11/PublishedViewer.tsx"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    target_start = " const shadow=f.shadow?`0 ${f.shadowOffset??12}px 32px color-mix(in srgb, ${f.shadowColor||'#0f172a'} 16%, transparent)`:'none';"
    target_end = "document.body)}</>\n}"

    pos1 = content.find(target_start)
    pos2 = content.find(target_end)
    if pos2 == -1:
        target_end = "document.body)}</>\r\n}"
        pos2 = content.find(target_end)

    if pos1 == -1 or pos2 == -1:
        print(f"Error: pos1={pos1}, pos2={pos2}")
        return False

    pos2 += len(target_end)

    replacement = """  const shadow=f.shadow?`0 ${f.shadowOffset??12}px 32px color-mix(in srgb, ${f.shadowColor||'#0f172a'} 16%, transparent)`:'none';
  const responsiveSizeClass=f.responsive===false?' visualFixed':(v.w<=260||v.h<=130?' visualCompact':(v.w>=540?' visualWide':' visualStandard'));
  const titleTextStyle:any={fontFamily:f.titleFontFamily||f.fontFamily||'Segoe UI',fontSize:f.titleFontSize||12,color:f.titleColor||(dark?'#fff':'#242424'),fontWeight:f.titleBold===false?400:(f.titleFontWeight||700),fontStyle:f.titleFontStyle||'normal',textDecoration:f.titleUnderline?'underline':'none',whiteSpace:f.titleWrap===false?'nowrap':'normal',textAlign:f.titleAlignment||'left'};
  const subtitleTextStyle:any={fontFamily:f.subtitleFontFamily||f.titleFontFamily||f.fontFamily||'Segoe UI',fontSize:f.subtitleFontSize||10,color:f.subtitleColor||'#616161',fontWeight:f.subtitleBold?(f.subtitleFontWeight||700):400,fontStyle:f.subtitleFontStyle||'normal',textDecoration:f.subtitleUnderline?'underline':'none',whiteSpace:f.subtitleWrap===false?'nowrap':'normal',textAlign:f.subtitleAlignment||f.titleAlignment||'left'};
  if(v.type==='shape')return <div role="img" aria-label={f.altText||`${f.shapeType||'rectangle'} shape`} className="viewerShapeObject" data-export-state="ready" data-visual-title={v.title||v.type}><ViewerShape format={f}/></div>;
  if(v.type==='image'){const media=<img className="viewerImageVisual" src={v.imageSrc||''} alt={f.altText||v.imageName||''} style={{objectFit:f.imageFit||'contain',opacity:(f.imageOpacity??100)/100}}/>;return <div className={`viewerVisual viewerVisual-image visualCard ${responsiveSizeClass}`} data-export-state="ready" data-visual-title={v.title||v.type} style={{background,border:'0',borderTop:edges.top?border:'0',borderRight:edges.right?border:'0',borderBottom:edges.bottom?border:'0',borderLeft:edges.left?border:'0',borderRadius:radius,boxShadow:shadow,'--viewer-title-background':titleBackground} as any}>{f.showTitle!==false&&<div className="viewerVisualTitle visualTitle" style={{background:titleBackground,...titleTextStyle}}><div className="viewerVisualTitleLabel visualTitleText" style={{textAlign:f.titleAlignment||'left'}}><span style={titleTextStyle}>{v.title}</span></div></div>}<div className="viewerVisualBody">{media}</div></div>}
  const content=v.type==='textbox'?(
    <div className="viewerTextBox" style={{fontSize:f.fontSize||18,color:f.labelColor||'#111827',fontFamily:f.fontFamily||'inherit',fontWeight:f.textFontWeight||400,fontStyle:f.textItalic?'italic':'normal',textDecoration:f.textUnderline?'underline':'none',textAlign:f.textAlign||'left',lineHeight:f.textLineHeight||1.45,whiteSpace:f.textWrap===false?'nowrap':'pre-wrap',overflowWrap:f.textWrap===false?'normal':'anywhere',display:'flex',flexDirection:'column',justifyContent:f.textVerticalAlign==='bottom'?'flex-end':f.textVerticalAlign==='middle'?'center':'flex-start',width:'100%',height:'100%',boxSizing:'border-box'}} dangerouslySetInnerHTML={{__html:richTextHtml(v.richText,v.text)}}/>
  ):v.type==='button'?(
    <div className="viewerActionButtonWrap" style={{width:'100%',height:'100%',display:'flex'}}>
      <button aria-pressed={f.buttonSelectionEnabled!==false?selected:undefined} className={'viewerActionButton buttonVisualOnly'+(selected?' actionSelected':'')} style={{flex:1,width:'100%',height:'100%',minHeight:0,margin:0,background:selected?(f.buttonSelectedBackground||'#16a34a'):(f.buttonBackground||'#6b7280'),color:selected?(f.buttonSelectedTextColor||'#fff'):(f.buttonTextColor||'#fff'),fontSize:f.buttonFontSize||12,borderRadius:f.buttonCornerRadius??6,border:f.buttonBorderVisible?`1px solid ${selected?(f.buttonSelectedBorderColor||'#15803d'):(f.buttonBorderColor||'#4b5563')}`:'none',boxSizing:'border-box'}} onClick={()=>onAction(v)}>
        <MousePointerClick size={16}/>{v.buttonLabel||'Action'}
      </button>
    </div>
  ):v.type==='slicer'?(()=>{
    const field=v.bindings.axis?.[0]||'',mode=v.slicerStyle||'list';
    const allOptions=rows.map(r=>String(r[field]??'')).filter((x,i,a)=>x&&a.indexOf(x)===i);
    const options=allOptions.filter(x=>!slicerSearch||x.toLowerCase().includes(slicerSearch.toLowerCase()));
    const allSelected=allOptions.length>0&&allOptions.every(option=>slicerSelected.includes(option));
    const apply=(next:string[],isSelectAll?:boolean)=>{setSlicerSelected(next);if(isSelectAll||!next.length){onCrossFilter(null)}else{onCrossFilter({field,operator:next.length===1?'equals':'in',value:next.length===1?next[0]:next})}};
    const choose=(value:string)=>apply(f.slicerSingleSelect?[value]:slicerSelected.includes(value)?slicerSelected.filter(x=>x!==value):[...slicerSelected,value]);
    const tilesPerRow=f.tilesPerRow||3;
    const tilesPerColumn=f.tilesPerColumn||0;
    const gridStyle:any={gridTemplateColumns:`repeat(${tilesPerRow}, 1fr)`};
    if(tilesPerColumn>0)gridStyle.gridTemplateRows=`repeat(${tilesPerColumn}, 1fr)`;
    return (
      <div className="viewerSlicerContents" style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'center',width:'100%',boxSizing:'border-box',minHeight:0,padding:'2px 8px'}}>
        {mode!=='dropdown'&&f.slicerSearch&&<input className="slicerDropdown viewerSlicerSearch" aria-label="Search slicer values" placeholder="Search" value={slicerSearch} onChange={e=>setSlicerSearch(e.target.value)}/>}
        {mode==='dropdown'?(
          f.slicerMultiSelect?(
            <div className="slicerDropdownMulti" style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'#242424',fontSize:f.tableFontSize||11,textAlign:(f.tableTextAlign as any)||'left',width:'100%',margin:0,boxSizing:'border-box'}}>
              {f.slicerSelectAll&&<label className="slicerListItem" style={{borderBottom:'1px solid #e2e8f0',marginBottom:4,paddingBottom:4}}><input type="checkbox" checked={allSelected} onChange={e=>{e.stopPropagation();apply(allSelected?[]:allOptions,!allSelected)}}/><span>Select all</span></label>}
              {options.map(value=><label key={value} className="slicerListItem"><input type="checkbox" checked={slicerSelected.includes(value)} onChange={e=>{e.stopPropagation();choose(value)}}/><span>{value}</span></label>)}
            </div>
          ):(
            <select aria-label={v.title||field||'Report filter'} className="slicerDropdown viewerSlicerDropdown" style={{width:'100%',margin:0,height:28,minHeight:28,color:f.tableTextColor,fontSize:f.tableFontSize||11,background:f.tableBackground||'#fff',textAlign:f.tableTextAlign,boxSizing:'border-box'}} value={allSelected?'__all__':slicerSelected[0]||''} onChange={e=>{if(e.target.value==='__all__'){apply(allOptions,true)}else if(e.target.value){apply([e.target.value])}else{apply([])}}}>
              <option value="" style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'inherit'}}>Select…</option>
              {f.slicerSelectAll&&<option value="__all__" style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'inherit'}}>Select all</option>}
              {options.map(value=><option key={value} value={value} style={{background:f.tableBackground||'#ffffff',color:f.tableTextColor||'inherit'}}>{value}</option>)}
            </select>
          )
        ):mode==='list'?(
          <div className={'slicerList slicer-list orientation-'+(f.slicerOrientation||'vertical')} style={{flex:1,overflow:'auto','--slicer-text':f.tableTextColor||'#242424','--slicer-size':`${f.tableFontSize||11}px`,'--slicer-bg':f.tableBackground||'#ffffff','--slicer-alt':f.tableAlternatingRows===false?(f.tableBackground||'#ffffff'):(f.tableAlternateColor||'#f8fafc'),textAlign:f.tableTextAlign} as any}>
            {f.slicerSelectAll&&!f.slicerSingleSelect&&<label className="slicerListItem"><input type="checkbox" checked={allSelected} onChange={e=>{e.stopPropagation();apply(allSelected?[]:allOptions,!allSelected)}}/><span>Select all</span></label>}
            {options.map(value=><label key={value} className="slicerListItem"><input type={(f.slicerSingleSelect||!f.slicerMultiSelect)?'radio':'checkbox'} checked={slicerSelected.includes(value)} onChange={e=>{e.stopPropagation();choose(value)}}/><span>{value}</span></label>)}
          </div>
        ):(
          <div className={'slicerList slicer-'+mode+' orientation-'+(f.slicerOrientation||'vertical')} style={{...(mode==='button'?gridStyle:{}),flex:1,overflow:'auto','--slicer-text':f.tableTextColor||'#242424','--slicer-size':`${f.tableFontSize||11}px`,'--slicer-bg':f.tableBackground||'#ffffff','--slicer-alt':f.tableAlternateColor||'#f8fafc',textAlign:f.tableTextAlign} as any}>
            {f.slicerSelectAll&&!f.slicerSingleSelect&&<button className={allSelected?'active':''} style={{borderRadius:f.slicerCornerRadius??6}} onClick={e=>{e.stopPropagation();apply(allSelected?[]:allOptions,!allSelected)}}>Select all</button>}
            {options.map(value=><button key={value} className={slicerSelected.includes(value)?'active':''} style={{borderRadius:f.slicerCornerRadius??6,color:f.tableTextColor,fontSize:f.tableFontSize}} onClick={e=>{e.stopPropagation();choose(value)}}>{value}</button>)}
          </div>
        )}
      </div>
    );
  })():<Chart visual={displayVisual} rows={rows} conditionalValues={conditionalValues} onPointClick={(field,value)=>onCrossFilter({field,operator:'equals',value})}/>;
  const narrative=visualExportNarrative(v,rows);
  const cardStyle:any={
    background,
    border:'0',
    borderTop:edges.top?border:'0',
    borderRight:edges.right?border:'0',
    borderBottom:edges.bottom?border:'0',
    borderLeft:edges.left?border:'0',
    borderRadius:radius,
    boxShadow:shadow,
    fontFamily:`${f.fontFamily||'Aptos'}, 'Segoe UI Variable', 'Segoe UI', sans-serif`,
    '--viewer-accent':accent,
    '--viewer-background':background,
    '--viewer-border-top':edges.top?border:'none',
    '--viewer-border-right':edges.right?border:'none',
    '--viewer-border-bottom':edges.bottom?border:'none',
    '--viewer-border-left':edges.left?border:'none',
    '--viewer-radius':radius,
    '--viewer-shadow':shadow,
    '--viewer-title-background':titleBackground,
    '--viewer-title-color':f.titleColor||(dark?'#fff':'#111827'),
    '--viewer-title-size':`${f.titleFontSize||12}px`,
    '--viewer-title-weight':f.titleBold===false?400:(f.titleFontWeight||700),
    '--viewer-padding-top':`${f.paddingTop??f.padding??8}px`,
    '--viewer-padding-right':`${f.paddingRight??f.padding??8}px`,
    '--viewer-padding-bottom':`${f.paddingBottom??f.padding??8}px`,
    '--viewer-padding-left':`${f.paddingLeft??f.padding??8}px`,
    '--visual-background':background,
    '--visual-title-background':titleBackground,
    '--visual-border-top':edges.top?border:'none',
    '--visual-border-right':edges.right?border:'none',
    '--visual-border-bottom':edges.bottom?border:'none',
    '--visual-border-left':edges.left?border:'none',
    '--visual-radius':radius,
    '--visual-shadow':shadow,
    '--visual-title-color':f.titleColor||(dark?'#fff':'#0f172a'),
    '--visual-padding-top':`${f.paddingTop??f.padding??8}px`,
    '--visual-padding-right':`${f.paddingRight??f.padding??8}px`,
    '--visual-padding-bottom':`${f.paddingBottom??f.padding??8}px`,
    '--visual-padding-left':`${f.paddingLeft??f.padding??8}px`,
    '--published-background':background,
    '--published-border-top':edges.top?border:'0',
    '--published-border-right':edges.right?border:'0',
    '--published-border-bottom':edges.bottom?border:'0',
    '--published-border-left':edges.left?border:'0',
    '--published-radius':radius,
    '--published-shadow':shadow,
    '--published-title-color':f.titleColor||(dark?'#fff':'#111827'),
    '--published-title-size':`${f.titleFontSize||12}px`,
    '--published-title-weight':f.titleBold===false?400:(f.titleFontWeight||700),
    '--published-callout-size':`${f.fontSize||28}px`,
    '--published-pad-top':`${f.paddingTop??f.padding??8}px`,
    '--published-pad-right':`${f.paddingRight??f.padding??8}px`,
    '--published-pad-bottom':`${f.paddingBottom??f.padding??8}px`,
    '--published-pad-left':`${f.paddingLeft??f.padding??8}px`,
    '--slicer-font':f.tableFontFamily||f.fontFamily||'Segoe UI',
    '--slicer-text':f.tableTextColor||'#242424',
    '--slicer-size':`${f.tableFontSize||11}px`,
    '--slicer-weight':f.tableTextBold?700:400,
    '--slicer-style':f.tableTextItalic?'italic':'normal',
    '--slicer-wrap':f.tableTextWrap?'normal':'nowrap',
    '--slicer-align':f.tableTextAlign||'left',
    '--slicer-bg':f.tableBackground||'#ffffff',
    '--slicer-alt':f.tableAlternatingRows===false?(f.tableBackground||'#ffffff'):(f.tableAlternateColor||'#f8fafc'),
    '--slicer-row-padding':`${f.tableRowPadding??8}px`
  };
  const card=<div className={`viewerVisual viewerVisual-${v.type} visualCard ${v.type==='slicer'?'slicerVisual':''} ${responsiveSizeClass}`} data-export-state={loading?'loading':err?'error':'ready'} data-visual-title={v.title||v.type} data-export-narrative={JSON.stringify(narrative)} data-export-insights={JSON.stringify(narrative.points)} style={cardStyle}>
    {f.showTitle!==false&&<div className="viewerVisualTitle visualTitle" style={{background:titleBackground,...titleTextStyle}}><div className="viewerVisualTitleLabel visualTitleText" style={{flex:1,minWidth:0,textAlign:f.titleAlignment||'left'}}><span style={titleTextStyle}>{v.title}</span>{f.subtitleVisible&&f.subtitle&&<small style={subtitleTextStyle}>{f.subtitle}</small>}</div>{f.visualHeader!==false&&<button className="viewerVisualFocus" onClick={()=>setFocus(true)} title="Focus visual"><Maximize2 size={13}/></button>}</div>}
    <div className="viewerVisualBody" style={{paddingTop:f.paddingTop??f.padding??8,paddingRight:f.paddingRight??f.padding??8,paddingBottom:f.paddingBottom??f.padding??8,paddingLeft:f.paddingLeft??f.padding??8}}>{loading?<div className="viewerVisualLoading" role="status"><span className="viewerSpinner"/><b>Loading visual data…</b></div>:err?<div className="viewerError">{err}</div>:content}</div>
  </div>;
  return <>{card}{focus&&createPortal(<div className="visualFocusBackdrop" onMouseDown={()=>setFocus(false)}><div className="visualFocusPanel viewerFocusPanel" onMouseDown={e=>e.stopPropagation()}><div className="visualFocusHeader"><div><small>FOCUS MODE</small><b>{v.title}</b></div><button onClick={()=>setFocus(false)}>Close</button></div><div className="visualFocusBody">{content}</div></div></div>,document.body)}</>"""

    new_content = content[:pos1] + replacement + content[pos2:]
    with open(path, "w", encoding="utf-8") as f:
        f.write(new_content)
    print("Successfully patched PublishedViewer.tsx")
    return True

if __name__ == "__main__":
    patch()
