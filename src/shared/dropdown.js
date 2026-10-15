'use strict';
const DropdownCompat=(()=>{
  let active=null,nativeFailed=false;
  function close(restore=false){
    if(!active)return false;
    const {select,popup,observer}=active;active=null;observer.disconnect();popup.remove();select.removeAttribute('aria-expanded');select.removeAttribute('aria-controls');
    if(restore&&select.isConnected)select.focus({preventScroll:true});return true;
  }
  function open(select){
    close();
    const popup=document.createElement('div');popup.className='compatible-dropdown';popup.id='compatible-dropdown';popup.setAttribute('role','listbox');popup.setAttribute('aria-label',select.getAttribute('aria-label')||select.labels?.[0]?.textContent.trim()||'选择选项');
    const options=[];let group=null;
    for(const option of select.options){
      if(option.hidden||option.parentElement.hidden)continue;
      const parent=option.parentElement,heading=parent.tagName==='OPTGROUP'?parent:null;
      if(heading&&heading!==group){const title=document.createElement('div');title.className='compatible-dropdown-group';title.textContent=heading.label;popup.append(title);}group=heading;
      const button=document.createElement('button');button.type='button';button.textContent=option.textContent;button.setAttribute('role','option');button.setAttribute('aria-selected',String(option.selected));button.disabled=option.disabled||!!heading?.disabled;button.tabIndex=-1;
      button.addEventListener('click',event=>{event.stopPropagation();if(button.disabled)return;
        const changed=select.selectedIndex!==option.index;select.selectedIndex=option.index;close(true);
        if(changed){select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}
      });
      popup.append(button);options.push(button);
    }
    if(!options.length)return;
    const observer=new MutationObserver(()=>{if(!select.isConnected)close();});observer.observe(document.body,{childList:true,subtree:true});
    active={select,popup,observer,options,search:'',searchedAt:0};select.setAttribute('aria-expanded','true');select.setAttribute('aria-controls',popup.id);document.body.append(popup);
    const box=(select.closest('.model-picker')||select).getBoundingClientRect(),margin=8,width=Math.min(Math.max(box.width,180),innerWidth-2*margin),below=innerHeight-box.bottom-margin,above=box.top-margin;
    const down=below>=Math.min(popup.scrollHeight,200)||below>=above,height=Math.max(0,Math.min(300,down?below:above));
    Object.assign(popup.style,{width:width+'px',left:Math.max(margin,Math.min(box.left,innerWidth-width-margin))+'px',maxHeight:height+'px'});
    popup.style.top=(down?box.bottom+2:Math.max(margin,box.top-Math.min(popup.scrollHeight,height)-2))+'px';
    (options.find(b=>b.getAttribute('aria-selected')==='true'&&!b.disabled)||options.find(b=>!b.disabled))?.focus({preventScroll:true});
    document.activeElement?.scrollIntoView({block:'nearest'});
  }
  function modelPicker(input,id){
    if(input._modelPicker)return input._modelPicker;
    const element=document.createElement('div');element.className='model-picker';
    const completions=document.createElement('datalist');completions.id=id+'-completions';
    const select=document.createElement('select');select.id=id;select.hidden=true;
    select.setAttribute('aria-label','选择模型');select.title='显示全部模型';
    Object.assign(select.style,{flex:'0 0 34px',width:'34px',minWidth:'34px'});
    input.setAttribute('list',completions.id);input.setAttribute('autocomplete','off');
    if(input.parentNode)input.replaceWith(element);
    element.append(input,completions,select);
    let models=[];
    const option=(value,label=value)=>{const node=document.createElement('option');node.value=value;node.textContent=label;return node;};
    function refresh(){
      const prefix=input.value.toLocaleLowerCase(),fragment=document.createDocumentFragment();
      for(const id of models)if(id.toLocaleLowerCase().startsWith(prefix))fragment.append(option(id));
      completions.replaceChildren(fragment);
    }
    function setModels(ids){
      models=[...new Set(ids.filter(Boolean).map(String))];
      const placeholder=option('','▾');placeholder.disabled=true;placeholder.hidden=true;
      select.replaceChildren(placeholder);
      for(const id of models)select.append(option(id));
      select.value='';select.hidden=!models.length;refresh();
    }
    input.addEventListener('input',refresh);
    input.addEventListener('change',refresh);
    select.addEventListener('change',()=>{
      if(!select.value)return;
      input.value=select.value;select.value='';
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    return input._modelPicker={element,setModels};
  }
  function needsFallback(select){return nativeFailed||typeof select.showPicker!=='function';}
  function install(){
    const style=document.createElement('style');style.textContent=`
      .model-picker{display:flex;align-items:stretch;flex:1;min-width:0;overflow:hidden;border:1px solid var(--rule,var(--sep,#b5a17a55));border-radius:3px;background:var(--panel2,#fffcf3);}
      .row .model-picker{border-radius:10px;}
      .model-picker:focus-within{outline:2px solid var(--blue,var(--gold,#a48c5e));outline-offset:-1px;border-color:transparent;}
      .model-picker>input{flex:1;min-width:0;width:0;margin:0;border:0;border-radius:0;box-shadow:none;background:transparent;outline:none;}
      .model-picker>input::-webkit-calendar-picker-indicator{display:none!important;}
      .model-picker>select{margin:0;padding:0;border:0;border-left:1px solid var(--rule,var(--sep,#b5a17a55));border-radius:0;appearance:none;background:transparent;color:inherit;box-shadow:none;outline:none;text-align:center;cursor:pointer;}
      .model-picker>select:hover{background:#b79b6218;}
      .model-picker>select option{background:var(--panel2,#fffcf3);color:var(--fg,var(--ink,#403929));text-align:left;}
      .compatible-dropdown{position:fixed;z-index:2147483647;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;background:#f4ecda;color:#403929;border:1px solid #b5a077;border-radius:8px;padding:5px;box-shadow:0 5px 18px #0003;font:14px/1.5 system-ui,sans-serif;}
      .compatible-dropdown button{display:block;box-sizing:border-box;width:100%;margin:0;padding:9px 12px;min-height:44px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;font:inherit;white-space:normal;overflow-wrap:anywhere;cursor:pointer;}
      .compatible-dropdown button[aria-selected=true]{background:#e2d4b5;}
      .compatible-dropdown button:hover,.compatible-dropdown button:focus{background:#ddd0b1;outline:2px solid #a48c5e;outline-offset:-2px;}
      .compatible-dropdown button:disabled{opacity:.45;cursor:default;outline:0;}
      .compatible-dropdown-group{padding:6px 12px;color:#817255;font-size:12px;}
    `;document.head.append(style);
    document.addEventListener('pointerdown',event=>{
      if(active&&event.target!==active.select&&!active.popup.contains(event.target))close();
      const select=event.target.closest?.('select');if(!select||select.disabled||select.multiple||select.size>1||event.button!==0)return;
      event.preventDefault();select.focus({preventScroll:true});
      if(active?.select===select){close(true);return;}
      if(needsFallback(select)){open(select);return;}
      try{select.showPicker();}catch{nativeFailed=true;open(select);}
    },true);
    document.addEventListener('keydown',event=>{
      if(active){
        if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();event.stopImmediatePropagation();close(true);return;}
        const {options}=active,enabled=options.filter(b=>!b.disabled),index=enabled.indexOf(document.activeElement);
        let next;
        if(event.key==='ArrowDown')next=enabled[(index+1)%enabled.length];
        else if(event.key==='ArrowUp')next=enabled[(index+enabled.length-1)%enabled.length];
        else if(event.key==='Home')next=enabled[0];else if(event.key==='End')next=enabled.at(-1);
        else if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopImmediatePropagation();document.activeElement?.click();return;}
        else if(event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
          const now=Date.now();active.search=(now-active.searchedAt>800?'':active.search)+event.key.toLocaleLowerCase();active.searchedAt=now;next=enabled.find(b=>b.textContent.trim().toLocaleLowerCase().startsWith(active.search));
        }else return;
        event.preventDefault();event.stopImmediatePropagation();next?.focus({preventScroll:true});next?.scrollIntoView({block:'nearest'});return;
      }
      const select=event.target.closest?.('select');if(select&&!select.disabled&&!select.multiple&&select.size<=1&&needsFallback(select)&&['Enter',' ','ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();open(select);}
    },true);
    window.addEventListener('resize',()=>close());
    document.addEventListener('scroll',event=>{if(active&&!active.popup.contains(event.target))close();},true);
  }
  if(typeof document!=='undefined')install();
  return {close,modelPicker};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=DropdownCompat;
