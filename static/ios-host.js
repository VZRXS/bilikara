/* iOS viewport and presentation facts. The shared Host owns routes and media;
   the document-bound native adapter owns system UI and edge input. */
(function (scope) {
  "use strict";
  function keyboardInset(viewport, height, editing) {
    if (!editing || !viewport || Math.abs(viewport.scale - 1) > 0.01) return 0;
    const inset = height - viewport.height - viewport.offsetTop;
    return Number.isFinite(inset) ? Math.max(0, Math.min(height, inset)) : 0;
  }
  if (typeof module === "object" && module.exports) module.exports = {keyboardInset};
  const root = scope.document?.documentElement;
  if (root?.dataset.nativeHost !== "true" || root.dataset.hostPlatform !== "ios") return;

  const viewport = scope.visualViewport;
  const dock = scope.document.getElementById?.("android-host-dock");
  const resize = dock && scope.ResizeObserver ? new scope.ResizeObserver(schedule) : null;
  const mutations = dock && scope.MutationObserver ? new scope.MutationObserver(watchDock) : null;
  const watched = new Set();
  let frame = null, attached = false, inset = 0;
  let nativeBusy = false, nativeDirty = false, nativeSignature = "", lifecycle = 0, dockSequence = 0;
  const nativeChanges = scope.MutationObserver ? new scope.MutationObserver(schedule) : null;
  function accentRGB() {
    const value = scope.getComputedStyle(root).getPropertyValue('--accent').trim();
    if (!scope.CSS.supports('color', value)) throw new Error('ios_dock_accent');
    const canvas = scope.document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) throw new Error('ios_dock_accent');
    context.fillStyle = value; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }
  async function syncNativeDock() {
    const api = scope.BilikaraIosPlatform;
    if (!api?.syncDock || !dock) return;
    if (nativeBusy) {nativeDirty = true; return;}
    const buttons = [...dock.querySelectorAll("[data-android-page]")];
    const blocked = [...scope.document.querySelectorAll('dialog[open], [aria-modal="true"]:not([hidden]):not(.hidden)')]
      .some(node => node.getClientRects().length && scope.getComputedStyle(node).visibility !== "hidden");
    const visible = !dock.hidden && root.dataset.hostLayout === "portrait"
      && !scope.document.body.classList.contains("is-tauri-fullscreen-active");
    const editing = scope.document.activeElement?.matches('input,textarea,[contenteditable="true"]');
    let backEnabled = visible && !blocked && !editing && root.dataset.hostPage === "my" && root.dataset.hostSettings === "true";
    const exclusions = [];
    if (backEnabled) for (const node of scope.document.querySelectorAll('button,a,input,select,textarea,[contenteditable],[role="slider"],.session-user-badge')) {
      if (!node.getClientRects().length || scope.getComputedStyle(node).visibility === "hidden") continue;
      const bounds = node.getBoundingClientRect();
      const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
      const right = Math.min(scope.innerWidth, bounds.right), bottom = Math.min(scope.innerHeight, bounds.bottom);
      if (left >= 24 || right <= left || bottom <= top) continue;
      exclusions.push([left, top, right-left, bottom-top]);
      if (exclusions.length > 96) { backEnabled = false; exclusions.length = 0; break; }
    }
    let accent;
    try { accent = accentRGB(); }
    catch { return; } // Keep the accessible Web dock if the token cannot resolve.
    const data = {visible, interactive: visible && !blocked, modal_covered: blocked, back_enabled: backEnabled, back_exclusions: exclusions,
      selected: Math.max(0, buttons.findIndex(button => button.hasAttribute("aria-current"))),
      labels: buttons.map(button => [...button.querySelectorAll(":scope > span")]
        .find(label => scope.getComputedStyle(label).display !== "none")?.textContent.trim().replace(/\s+/g, " ") || ""), viewport_width: scope.innerWidth, viewport_height: scope.innerHeight,
      dark: root.dataset.theme === "dark" || root.dataset.theme === "blue", accent};
    const signature = JSON.stringify(data);
    if (signature === nativeSignature) return;
    nativeBusy = true; nativeDirty = false;
    const generation = lifecycle;
    try {
      const result = await api.syncDock({...data, sequence: ++dockSequence});
      if (!attached || generation !== lifecycle) return;
      if (!Number.isFinite(result?.height) || result.height < 44 || result.height > 200) throw new Error("ios_dock_height");
      nativeSignature = signature;
      root.dataset.iosNativeDock = "true";
      if (result.native_back === true) root.dataset.iosNativeBack = "true";
      else delete root.dataset.iosNativeBack;
      const height = `${Math.ceil(result.height)}px`;
      if (root.style.getPropertyValue("--ios-native-dock-height") !== height) root.style.setProperty("--ios-native-dock-height", height);
      dock.setAttribute("aria-hidden", "true");
    } catch {
      if (generation === lifecycle) {
        delete root.dataset.iosNativeDock;
        delete root.dataset.iosNativeBack;
        root.style.removeProperty("--ios-native-dock-height");
        dock.removeAttribute("aria-hidden");
      }
    } finally {nativeBusy = false; if (nativeDirty && attached) schedule();}
  }
  function measureDock() {
    if (!dock?.getClientRects().length || root.dataset.hostLayout !== "portrait") return;
    let height = 44;
    for (const button of dock.querySelectorAll("button")) {
      const style = scope.getComputedStyle(button);
      const children = [...button.children].filter(node => node.getClientRects().length);
      const content = children.reduce((sum, node) => sum + Math.max(node.getBoundingClientRect().height,
        node.tagName === "SPAN" ? node.scrollHeight : 0), 0);
      height = Math.max(height, content + Math.max(0, children.length - 1) * (parseFloat(style.rowGap) || 0)
        + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
    }
    const value = `${Math.ceil(height)}px`;
    if (root.style.getPropertyValue("--ios-dock-button-height") !== value) root.style.setProperty("--ios-dock-button-height", value);
  }
  function watchDock() {
    if (!attached) return;
    const nodes = new Set(dock.querySelectorAll("button > span, button > svg"));
    for (const node of watched) if (!nodes.has(node)) {resize?.unobserve(node); watched.delete(node);}
    for (const node of nodes) if (!watched.has(node)) {resize?.observe(node); watched.add(node);}
    schedule();
  }
  function update() {
    frame = null;
    measureDock();
    void syncNativeDock();
    const focused = scope.document.activeElement;
    const editing = Boolean(focused?.matches("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]), textarea, [contenteditable='true']"));
    const next = Math.round(keyboardInset(viewport, scope.innerHeight, editing));
    if (next !== inset) {
      inset = next;
      root.style.setProperty("--mobile-ime-height", `${inset}px`);
    }
    // Focus and native viewport panning may change visibility without changing
    // the keyboard inset. Recheck on those events; reveal is a no-op if visible.
    if (inset > 0 && !focused.closest("[inert], [hidden]")) reveal(focused);
  }
  const FOCUS_ROOM = 4; // Reveal margin; mobile focus paints inside the field/pill.
  function pixels(value) {
    const number = parseFloat(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }
  // Client-coordinate rows the user can actually see: the visual viewport
  // (already above the keyboard/IME) minus the status-bar safe area, and minus
  // the bottom safe area, native dock or Web dock where they rise above it.
  function visibleBand() {
    const style = scope.getComputedStyle?.(root);
    const top = viewport.offsetTop + pixels(style?.getPropertyValue("--ios-safe-top"));
    let bottom = viewport.offsetTop + viewport.height;
    const nativeDock = root.dataset.iosNativeDock === "true" ? pixels(root.style.getPropertyValue?.("--ios-native-dock-height")) : 0;
    const screenBottom = pixels(style?.getPropertyValue("--ios-safe-bottom"));
    bottom = Math.min(bottom, viewport.offsetTop + scope.innerHeight - Math.max(nativeDock, screenBottom));
    // Only the portrait bottom dock occludes rows; other layouts place it aside.
    if (dock && !nativeDock && root.dataset.hostLayout === "portrait" && dock.getClientRects?.().length) {
      const dockTop = dock.getBoundingClientRect().top;
      if (Number.isFinite(dockTop) && dockTop > top) bottom = Math.min(bottom, dockTop);
    }
    return {top, bottom};
  }
  function scrollOwner(node) {
    for (let element = node.parentElement; element && element !== root && element !== scope.document.body;
      element = element.parentElement) {
      const overflow = scope.getComputedStyle?.(element).overflowY || "";
      if (/^(auto|scroll|overlay)$/.test(overflow) && element.scrollHeight > element.clientHeight + 1) return element;
    }
    return null;
  }
  // IOS-09-09: scroll only when the focused field (with its focus paint) is
  // not fully inside the visible band, and then only its nearest real scroll
  // owner by the minimum distance; WK's own visual-viewport pan is not doubled.
  function reveal(focused) {
    const rect = viewport && focused.getBoundingClientRect?.();
    if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
      focused.scrollIntoView({block: "nearest", inline: "nearest"}); // No geometry: previous behaviour.
      return;
    }
    const owner = scrollOwner(focused);
    let {top, bottom} = visibleBand();
    // The owner's own scrollport clips the field box too (focus-ring paint room
    // inside an owner is a CSS concern, IOS-09-09 item 1, not a scroll reason).
    const clip = owner?.getBoundingClientRect?.();
    if (clip && Number.isFinite(clip.top) && Number.isFinite(clip.bottom)) {
      top = Math.max(top, clip.top - FOCUS_ROOM); bottom = Math.min(bottom, clip.bottom + FOCUS_ROOM);
    }
    const needTop = rect.top - FOCUS_ROOM, needBottom = rect.bottom + FOCUS_ROOM;
    let delta = 0;
    if (needTop < top || needBottom - needTop > bottom - top) delta = needTop - top;
    else if (needBottom > bottom) delta = needBottom - bottom;
    if (Math.abs(delta) < 1) return; // Fully visible: never move the page or header.
    if (owner) owner.scrollTop += Math.round(delta);
    else focused.scrollIntoView({block: "nearest", inline: "nearest"});
  }
  function schedule() {
    if (attached && frame === null) frame = scope.requestAnimationFrame(update);
  }
  function start() {
    if (attached) return;
    attached = true; lifecycle++; nativeSignature = "";
    if (scope.BilikaraIosPlatform?.syncDock) {
      nativeChanges?.observe(root, {attributes: true, attributeFilter: ["data-theme", "data-host-layout", "data-host-page", "data-host-settings"]});
      // Observe dynamic modals too. Attribute filters exclude style writes
      // from our own geometry measurement and avoid a self-triggered loop.
      nativeChanges?.observe(scope.document.body, {subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["class", "hidden", "open", "aria-modal", "aria-current"]});
    }
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    scope.addEventListener("resize", schedule);
    scope.document.addEventListener("focusin", schedule);
    scope.document.addEventListener("focusout", schedule);
    scope.document.addEventListener("scroll", schedule, true);
    scope.document.addEventListener("bilikara:i18n", schedule);
    scope.document.fonts?.addEventListener?.("loadingdone", schedule);
    scope.document.fonts?.ready.then(schedule);
    if (dock) {
      mutations?.observe(dock, {childList: true, subtree: true, characterData: true});
      watchDock();
    }
    schedule();
  }
  function stop() {
    attached = false; lifecycle++; nativeChanges?.disconnect();
    delete root.dataset.iosNativeDock;
    delete root.dataset.iosNativeBack;
    root.style.removeProperty("--ios-native-dock-height");
    dock?.removeAttribute("aria-hidden");
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    scope.removeEventListener("resize", schedule);
    scope.document.removeEventListener("focusin", schedule);
    scope.document.removeEventListener("focusout", schedule);
    scope.document.removeEventListener("scroll", schedule, true);
    scope.document.removeEventListener("bilikara:i18n", schedule);
    scope.document.fonts?.removeEventListener?.("loadingdone", schedule);
    mutations?.disconnect(); resize?.disconnect(); watched.clear();
    if (frame !== null) scope.cancelAnimationFrame(frame);
    frame = null;
    inset = 0;
    root.style.removeProperty("--mobile-ime-height");
    root.style.removeProperty("--ios-dock-button-height");
  }
  scope.BilikaraIOSHost = Object.freeze({diagnostics: () => ({keyboard_inset: inset, visual_viewport: Boolean(viewport)})});
  scope.addEventListener("pagehide", stop);
  scope.addEventListener("pageshow", start);
  start();
})(globalThis);
