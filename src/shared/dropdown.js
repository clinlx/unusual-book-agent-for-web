'use strict';
const DropdownCompat=(()=>{
  const KEY='awl:compatible-dropdown';
  let active=null,nativeFailed=false;
  function forced(){try{return localStorage.getItem(KEY)==='1';}catch{return false;}}
  function setForced(value){try{localStorage.setItem(KEY,value?'1':'0');}catch{}close();}
  function settingHTML(){return `<label class="check-label stream-setting"><input name="compatibleDropdown" type="checkbox" ${forced()?'checked':''} aria-label="兼容下拉菜单"><span>兼容下拉菜单<small>下拉菜单显示异常时开启，改用页面内菜单。</small></span></label>`;}
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
    const box=select.getBoundingClientRect(),margin=8,width=Math.min(Math.max(box.width,180),innerWidth-2*margin),below=innerHeight-box.bottom-margin,above=box.top-margin;
    const down=below>=Math.min(popup.scrollHeight,200)||below>=above,height=Math.max(0,Math.min(300,down?below:above));
    Object.assign(popup.style,{width:width+'px',left:Math.max(margin,Math.min(box.left,innerWidth-width-margin))+'px',maxHeight:height+'px'});
    popup.style.top=(down?box.bottom+2:Math.max(margin,box.top-Math.min(popup.scrollHeight,height)-2))+'px';
    (options.find(b=>b.getAttribute('aria-selected')==='true'&&!b.disabled)||options.find(b=>!b.disabled))?.focus({preventScroll:true});
    document.activeElement?.scrollIntoView({block:'nearest'});
  }
  function needsFallback(select){return forced()||nativeFailed||typeof select.showPicker!=='function';}
  function install(){
    const style=document.createElement('style');style.textContent=`
      .compatible-dropdown{position:fixed;z-index:2147483647;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;background:#f4ecda;color:#403929;border:1px solid #b5a077;border-radius:8px;padding:5px;box-shadow:0 5px 18px #0003;font:14px/1.5 system-ui,sans-serif;}
      .compatible-dropdown button{display:block;box-sizing:border-box;width:100%;margin:0;padding:9px 12px;min-height:38px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;font:inherit;white-space:normal;overflow-wrap:anywhere;cursor:pointer;}
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
  return {forced,setForced,settingHTML,close};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=DropdownCompat;
