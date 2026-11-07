/* iOS runtime settings share one ordinary CSS picker. The retained <select>
   remains the value/event authority; no native menu material heuristics. */
(() => {
  'use strict';
  const instances = new WeakMap();
  let opened = null;
  function close(focus = false) {
    if (!opened) return;
    const {button,menu} = opened;opened = null;
    menu.hidePopover();menu.remove();button.setAttribute('aria-expanded','false');button.removeAttribute('aria-controls');
    if (focus && !button.disabled && button.getClientRects().length) button.focus({preventScroll:true});
  }
  function create(select) {
    const button = document.createElement('button');button.type = 'button';button.className = 'runtime-select-trigger';
    button.id = select.id+'-trigger';button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');
    button.setAttribute('aria-expanded','false');
    const heading = select.labels?.[0]?.querySelector('.cache-panel-label');
    if (heading) {heading.id ||= select.id+'-label';button.setAttribute('aria-labelledby',heading.id+' '+button.id);}
    else button.setAttribute('aria-label',select.getAttribute('aria-label')||select.title||select.id);
    select.parentElement.classList.add('has-runtime-select');
    select.hidden = true;select.after(button);
    function show(last = false) {
      if (button.disabled) return;
      if (opened?.button === button) {close(true);return;}
      close();
      const menu = document.createElement('div');menu.id = select.id+'-listbox';menu.className = 'runtime-select-menu';
      menu.setAttribute('popover','manual');menu.setAttribute('role','listbox');
      if (heading) menu.setAttribute('aria-labelledby',heading.id);
      const choices = [...select.options].map(option=>{
        const node = document.createElement('button');node.type='button';node.className='runtime-select-option';
        node.setAttribute('role','option');node.textContent=option.textContent;node.disabled=option.disabled;
        node.setAttribute('aria-selected',String(option.value===select.value));
        node.addEventListener('click',()=>{
          if (select.disabled || option.disabled) return;
          const changed=select.value!==option.value;select.value=option.value;
          close(true);sync(select);
          if (changed) select.dispatchEvent(new Event('change',{bubbles:true}));
        });
        menu.append(node);return node;
      });
      document.body.append(menu);button.setAttribute('aria-controls',menu.id);button.setAttribute('aria-expanded','true');
      opened={button,menu,choices};menu.showPopover();
      const rect=button.getBoundingClientRect(),gap=6,edge=14;
      const viewport=window.visualViewport,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
      const top=viewport?.offsetTop||0,left=viewport?.offsetLeft||0;
      const spaceBelow=top+height-rect.bottom-edge,spaceAbove=rect.top-top-edge;
      const above=spaceAbove>spaceBelow && spaceBelow<Math.min(menu.scrollHeight,220);
      const available=Math.max(44,(above?spaceAbove:spaceBelow)-gap);
      menu.style.width=`${Math.min(width-edge*2,Math.max(rect.width,220))}px`;
      menu.style.maxHeight=`${available}px`;
      const bounds=menu.getBoundingClientRect();
      menu.style.left=`${Math.max(left+edge,Math.min(rect.left,left+width-edge-bounds.width))}px`;
      menu.style.top=`${above?rect.top-gap-bounds.height:rect.bottom+gap}px`;
      const enabled=choices.filter(n=>!n.disabled),selected=choices.find(n=>n.getAttribute('aria-selected')==='true');
      (last?enabled.at(-1):selected&&!selected.disabled?selected:enabled[0])?.focus({preventScroll:true});
      menu.addEventListener('keydown',event=>{
        if (event.key==='Escape'||event.key==='Tab') {if(event.key==='Escape')event.preventDefault();close(event.key==='Escape');return;}
        const index=enabled.indexOf(document.activeElement);
        const next={ArrowDown:Math.min(enabled.length-1,index+1),ArrowUp:Math.max(0,index-1),Home:0,End:enabled.length-1}[event.key];
        if (next!==undefined) {event.preventDefault();enabled[next]?.focus({preventScroll:true});enabled[next]?.scrollIntoView({block:'nearest'});}
      });
    }
    button.addEventListener('click',()=>show());
    button.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();show(event.key==='ArrowUp');}});
    return {button};
  }
  function sync(select) {
    if (!select || document.documentElement.dataset.hostPlatform!=='ios' || typeof HTMLElement.prototype.showPopover!=='function') return;
    let instance=instances.get(select);if(!instance){instance=create(select);instances.set(select,instance);}
    const {button}=instance;button.textContent=select.selectedOptions[0]?.textContent||'';button.disabled=select.disabled;
    if (opened?.button===button) {
      if(button.disabled||!button.getClientRects().length){close();return;}
      opened.choices.forEach((node,index)=>{
        const option=select.options[index];if(!option)return;
        node.textContent=option.textContent;node.disabled=option.disabled;
        node.setAttribute('aria-selected',String(option.value===select.value));
      });
    }
  }
  document.addEventListener('pointerdown',event=>{if(opened&&!opened.menu.contains(event.target)&&!opened.button.contains(event.target))close();},true);
  document.addEventListener('scroll',event=>{if(opened&&!opened.menu.contains(event.target))close();},true);
  for(const name of ['resize','pagehide','bilikara:subtab-route','bilikara:ime'])window.addEventListener(name,()=>close());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)close();});
  window.visualViewport?.addEventListener('resize',()=>close());
  window.BilikaraRuntimeSelect=Object.freeze({sync,close});
})();
