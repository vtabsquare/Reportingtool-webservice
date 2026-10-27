import {useEffect,useRef,useState,type InputHTMLAttributes} from 'react';

type Props=Omit<InputHTMLAttributes<HTMLInputElement>,'value'|'defaultValue'|'onChange'|'onBlur'> & {
  value:string|undefined|null;
  onCommit:(value:string)=>void;
};

/**
 * Text editor that keeps typing local and commits the complete value on blur.
 * Empty text is a valid committed value. Enter commits; Escape restores the
 * last committed value. This matches the deferred position/size editors.
 */
export function DeferredTextInput({value,onCommit,...inputProps}:Props){
  const text=value===undefined||value===null?'':String(value);
  const[draft,setDraft]=useState(text);
  const focused=useRef(false);

  useEffect(()=>{if(!focused.current)setDraft(text)},[text]);

  const restore=()=>setDraft(text);
  const commit=()=>{
    focused.current=false;
    if(draft!==text)onCommit(draft);
  };

  return <input {...inputProps} type={inputProps.type||'text'} value={draft}
    onFocus={event=>{focused.current=true;inputProps.onFocus?.(event)}}
    onChange={event=>setDraft(event.target.value)}
    onBlur={event=>{commit();inputProps.onBlur?.(event)}}
    onKeyDown={event=>{
      inputProps.onKeyDown?.(event);
      if(event.defaultPrevented)return;
      if(event.key==='Enter')event.currentTarget.blur();
      if(event.key==='Escape'){event.preventDefault();restore();event.currentTarget.blur()}
    }}/>
}

