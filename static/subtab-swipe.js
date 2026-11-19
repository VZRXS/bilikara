/* One resolver for genuine sub-tabs inside ONE selected primary section.
   This module has no primary-navigation or media APIs. */
(() => {
  "use strict";
  function flatten(tree, ancestors = []) {
    return (tree || []).flatMap(node => {
      if (!node || node.hidden || node.disabled || typeof node.id !== "string" || !node.id) return [];
      const path = [...ancestors, node.id];
      return Array.isArray(node.children) ? flatten(node.children, path) : [{key: path.join("."), path}];
    });
  }
  function neighbor(tree, current, direction) {
    const leaves = flatten(tree), index = leaves.findIndex(leaf => leaf.key === current);
    return index < 0 || ![-1, 1].includes(direction) ? null : leaves[index + direction] || null;
  }
  function descendant(tree, parent, remembered = "") {
    const leaves = flatten(tree).filter(leaf => leaf.key === parent || leaf.key.startsWith(`${parent}.`));
    return leaves.find(leaf => leaf.key === remembered) || leaves[0] || null;
  }
  function intent(dx, dy, locked = "") {
    if (locked) return locked;
    if (Math.abs(dy) >= 10 && Math.abs(dy) > 1.15 * Math.abs(dx)) return "y";
    if (Math.abs(dx) >= 12 && Math.abs(dx) >= 1.5 * Math.abs(dy)) return "x";
    return "";
  }
  function completed(dx, width, elapsed, locked) {
    return locked === "x" && (Math.abs(dx) >= Math.max(64, Math.min(96, width * .22))
      || (Math.abs(dx) >= 32 && Math.abs(dx) / Math.max(1, elapsed) >= .55));
  }
  const owners = 'button,input,textarea,select,a,summary,audio,video,[role="button"],[role="tab"],[role="tablist"],'
    + '[contenteditable="true"],[draggable="true"],[role="slider"],[role="combobox"],[role="textbox"],'
    + '[hidden],[inert],.result-page-viewport,.result-pager,.source-editor-tools,'
    + '.android-host-dock,.work-rail,[data-subtab-swipe-owner]';
  // Result viewports own swipes over their cards, but the blank space below a
  // partly filled page is not result content (result-pagination.js leaves it
  // too). Decided once from the start point.
  function freeResultSpace(owner, y) {
    if (!owner.matches('.result-page-viewport') || owner.parentElement?.closest(owners)) return false;
    const results = owner.querySelector(':scope > .has-result-pages');
    return Boolean(results && results.childNodes.length) && y > results.getBoundingClientRect().bottom;
  }
  function owned(target, root, y) {
    if (!(target instanceof Element)) return true;
    const owner = target.closest(owners);
    if (owner && !freeResultSpace(owner, y)) return true;
    for (let node = target; node && node !== root; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(style.overflowX)) return true;
    }
    return false;
  }
  function blocked(root) {
    return Boolean(document.fullscreenElement || document.querySelector('.is-tauri-fullscreen'))
      || document.hidden
      || [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(node =>
        !node.contains(root) && node.getClientRects().length && !node.closest('[hidden],[inert]') && getComputedStyle(node).visibility !== 'hidden')
      || Boolean(document.querySelector('[data-source-editing="true"],.source-editor.is-editing'));
  }
  function bind(root, {scope, tree, current, commit, panel = () => root, fixedZones = () => [], motion = () => null, allowed = () => true}) {
    if (!root) return {cancel() {}, destroy() {}};
    let gesture = null, animation = null, animationSignature = '', ticket = 0, suppressUntil = 0, suppressTarget = null, finishMotion = null, composing = false;
    const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const signature = () => JSON.stringify([scope(), current(), flatten(tree()).map(leaf => leaf.key)]);
    function stopAnimation() { animation?.cancel(); animation = null; finishMotion?.(); finishMotion = null; }
    function cancel() {
      ticket++;
      if (gesture?.node) gesture.node.style.transform = gesture.transform;
      gesture?.release?.();
      gesture = null; stopAnimation(); suppressUntil = 0; suppressTarget = null;
    }
    function valid() { return gesture && !blocked(root) && allowed() && gesture.signature === signature(); }
    function start(x, y, target, id) {
      cancel();
      // Fixed chrome is an exclusion, never an alternate content origin.
      // Reject it before creating a candidate, preview or click guard.
      if (fixedZones().some(node => node?.contains(target)) || composing || x < 24 || x > innerWidth - 24
        || blocked(root) || !allowed() || owned(target, root, y)) return;
      const leaves = flatten(tree()), key = current();
      if (leaves.length < 2 || !leaves.some(leaf => leaf.key === key)) return;
      const node = panel();
      if (!node || !node.contains(target)) return;
      gesture = {x, y, id, lastX: x, lastY: y, started: performance.now(), axis: "", node,
        clickTarget: target.closest('button,input,textarea,a') || target,
        transform: node.style.transform, signature: signature(), width: node.getBoundingClientRect().width};
    }
    function move(x, y, event) {
      if (!gesture) return;
      if (!valid()) { cancel(); return; }
      const dx = x - gesture.x, dy = y - gesture.y;
      gesture.lastX = x; gesture.lastY = y;
      gesture.axis = intent(dx, dy, gesture.axis);
      if (gesture.axis === "y") { cancel(); return; }
      if (gesture.axis !== "x") return;
      event.preventDefault();
      if (!gesture.motionStarted) {gesture.motionStarted = true;gesture.release = motion(gesture.node);}
      const next = neighbor(tree(), current(), dx < 0 ? 1 : -1);
      // Only present the current panel. No cloned media/cards, background
      // requests, route changes or selected-pill changes during preview.
      if (!reduced()) gesture.node.style.transform = `translateX(${Math.max(-28, Math.min(28, dx * (next ? .12 : .035)))}px)`;
    }
    function finish() {
      if (!gesture) return;
      if (!valid()) { cancel(); return; }
      const active = gesture, dx = active.lastX - active.x;
      const next = completed(dx, active.width, performance.now() - active.started, active.axis)
        ? neighbor(tree(), current(), dx < 0 ? 1 : -1) : null;
      active.node.style.transform = active.transform;
      active.release?.();
      gesture = null;
      // A content drag must not also activate its original target, even at
      // a leaf boundary or below the navigation distance. Fixed chrome and
      // controls never create this guard; new taps and keyboard input work.
      if (active.axis === 'x') {suppressUntil = performance.now()+400;suppressTarget = active.clickTarget;}
      if (!next) return;
      const focused = active.node.contains(document.activeElement) ? document.activeElement : null;
      const unchanged = signature(), pending = ++ticket;
      // The entire canonical route commits in one synchronous turn. No first
      // frame of an intermediate remembered parent/child is presented.
      if (blocked(root) || !allowed() || unchanged !== active.signature) { cancel(); return; }
      commit(next.path);
      if (focused && !focused.getClientRects().length) {
        const heading = panel()?.querySelector('h2,h3,[role="heading"]') || panel();
        if (heading) {
          const old = heading.getAttribute('tabindex');heading.tabIndex = -1;heading.focus({preventScroll:true});
          if (old === null) heading.removeAttribute('tabindex'); else heading.setAttribute('tabindex', old);
        }
      }
      const incoming = panel();
      if (incoming?.animate && !reduced()) {
        animationSignature = signature();
        finishMotion = motion(incoming);
        animation = incoming.animate([{transform: `translateX(${dx < 0 ? 12 : -12}px)`}, {transform: 'none'}],
          {duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)'});
        animation.finished.catch(() => {}).finally(() => {if (ticket === pending) {animation = null;finishMotion?.();finishMotion = null;}});
      }
    }
    const listeners = [];
    const on = (node, type, handler, options) => {node.addEventListener(type, handler, options);listeners.push(() => node.removeEventListener(type, handler, options));};
    on(root,'compositionstart',()=>{composing=true;cancel();});
    on(root,'compositionend',()=>{composing=false;});
    // Pick one input family. Never process both Touch and Pointer for a drag.
    if ('ontouchstart' in window) {
      on(root, 'touchstart', event => {
        if (event.touches.length !== 1) { cancel(); return; }
        const touch = event.touches[0];start(touch.clientX, touch.clientY, event.target, touch.identifier);
      }, {passive: true});
      on(root, 'touchmove', event => {
        if (event.touches.length !== 1) {cancel();return;}
        const touch = event.touches[0];if(gesture?.id === touch.identifier) move(touch.clientX, touch.clientY, event);
      }, {passive: false});
      on(root, 'touchend', finish);on(root, 'touchcancel', cancel);
      on(document, 'touchstart', event => {if(event.touches.length > 1) cancel();}, {passive:true});
    } else {
      on(root, 'pointerdown', event => {
        if (!event.isPrimary || event.button !== 0 || !['touch', 'pen'].includes(event.pointerType)) { cancel(); return; }
        start(event.clientX, event.clientY, event.target, event.pointerId);
      });
      on(window, 'pointermove', event => {if(gesture?.id === event.pointerId) move(event.clientX,event.clientY,event);}, {passive:false});
      on(window, 'pointerup', event => {if(gesture?.id === event.pointerId) finish();});
      on(window, 'pointercancel', cancel);
    }
    on(root, 'click', event => {
      if(event.detail && performance.now() < suppressUntil && suppressTarget?.contains(event.target)) {
        suppressUntil=0;suppressTarget=null;event.preventDefault();event.stopImmediatePropagation();
      }
    }, true);
    for(const event of ['resize','orientationchange','blur','pagehide','popstate','bilikara:ios-edge-back','bilikara:ime']) on(window,event,cancel);
    on(document,'visibilitychange',cancel);
    on(document,'bilikara:subtab-route',cancel);
    const observer = new MutationObserver(() => {
      if ((gesture && !valid()) || (animation && (blocked(root) || animationSignature !== signature()))) cancel();
    });
    observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','hidden','inert','open','disabled','aria-disabled','aria-hidden','aria-selected','aria-modal']});
    return {cancel, destroy() {cancel();observer.disconnect();listeners.forEach(remove=>remove());}};
  }
  const api = {flatten, neighbor, descendant, intent, completed, bind};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.BilikaraSubTabSwipe = api;
})();
