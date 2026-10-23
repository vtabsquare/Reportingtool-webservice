import {useEffect,useRef,useState,type InputHTMLAttributes} from 'react';

type Props=Omit<InputHTMLAttributes<HTMLInputElement>,'type'|'value'|'defaultValue'|'onChange'|'onBlur'> & {
  value:number|undefined|null;
  onCommit:(value:number|undefined)=>void;
  allowEmpty?:boolean;
};

/**
 * Numeric editor that keeps keystrokes local and commits only on blur.
 *
 * This allows users to select, clear and replace a complete number without
 * resizing/moving the canvas object after every digit. Enter commits by
 * blurring; Escape restores the last committed value.
 */
export function DeferredNumberInput({value,onCommit,allowEmpty=false,min,max,...inputProps}:Props){
  const text=value===undefined||value===null?'':String(value);
  const[draft,setDraft]=useState(text);
  const focused=useRef(false);

  useEffect(()=>{if(!focused.current)setDraft(text)},[text]);

  const restore=()=>setDraft(text);
  const commit=()=>{
    focused.current=false;
    const trimmed=draft.trim();
    if(trimmed===''){
      if(allowEmpty)onCommit(undefined);
      else restore();
      return;
    }
    let parsed=Number(trimmed);
    if(!Number.isFinite(parsed)){restore();return}
    if(min!==undefined&&min!==null&&min!=='')parsed=Math.max(Number(min),parsed);
    if(max!==undefined&&max!==null&&max!=='')parsed=Math.min(Number(max),parsed);
    setDraft(String(parsed));
    if(parsed!==value)onCommit(parsed);
  };

  return <input {...inputProps} type="number" min={min} max={max} value={draft}
    onFocus={()=>{focused.current=true}}
    onChange={event=>setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={event=>{
      inputProps.onKeyDown?.(event);
      if(event.defaultPrevented)return;
      if(event.key==='Enter')event.currentTarget.blur();
      if(event.key==='Escape'){event.preventDefault();restore();event.currentTarget.blur()}
    }}/>
}
