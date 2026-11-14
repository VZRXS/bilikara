/* Canonical Host adapters for the shared, section-local leaf resolver. */
(() => {
  "use strict";
  const api = window.BilikaraSubTabSwipe;
  if (!api || !elements.hostWorkspaceRegion) return;
  const modes = (buttons, key) => [...(buttons || [])].map(button => ({
    id: button.dataset[key], hidden: button.hidden || button.classList.contains('hidden') || button.getAttribute('aria-hidden') === 'true',
    disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
  }));
  function requestTree() {
    const children = {
      search: modes(elements.searchModeButtons, 'searchMode'),
      discover: modes(elements.discoverModeButtons, 'discoverMode'),
      sources: modes(elements.sourcesModeButtons, 'sourcesMode'),
    };
    const nodes = modes(elements.requestSubviewButtons, 'requestView').map(node =>
      children[node.id] ? {...node, children:children[node.id]} : node);
    const random = hostWorkspaceButton('random');
    if (random && !random.disabled) nodes.push({id:'random'});
    return [{id:'request',children:nodes}];
  }
  function scope() {
    if (window.BilikaraHostLayout?.isPortrait()) return window.BilikaraHostLayout.primarySection();
    return hostWorkspaceButton(state.activeHostWorkspace)?.dataset.compactPage || '';
  }
  function tree() {
    return scope() === 'request' ? requestTree() : scope() === 'queue'
      ? [{id:'queue',children:['queue','history'].map(id => ({id,disabled:hostWorkspaceButton(id)?.disabled !== false}))}]
      : [];
  }
  function current() {
    if (scope() === 'queue') return `queue.${state.activeHostWorkspace}`;
    if (scope() !== 'request') return '';
    if (state.activeHostWorkspace === 'random') return 'request.random';
    const view = state.requestSubview;
    const child = {search:state.searchMode, discover:state.discoverMode, sources:state.sourcesMode}[view];
    return `request.${view}${child ? `.${child}` : ''}`;
  }
  function panel() {
    if (window.BilikaraHostLayout?.isPortrait()) return elements.hostWorkspaceRegion;
    if (state.activeHostWorkspace === 'request') {
      const view = state.requestSubview, child = {search:state.searchMode,discover:state.discoverMode,sources:state.sourcesMode}[view];
      return elements.requestWorkspace?.querySelector(child ? `[data-${view === 'sources' ? 'sources' : view}-panel="${child}"]` : `[data-request-panel="${view}"]`);
    }
    return [...elements.hostWorkspacePanels].find(node => node.dataset.hostWorkspacePanel === state.activeHostWorkspace);
  }
  function commit(path) {
    if (path[0] !== scope() || !api.flatten(tree()).some(leaf => leaf.key === path.join('.'))) return false;
    if (path[0] === 'queue') activateHostWorkspace(path[1], {inputOrigin:'host-navigation'});
    else if (path[1] === 'random') activateHostWorkspace('random', {inputOrigin:'host-navigation'});
    else {
      if (state.activeHostWorkspace === 'request') rememberRequestScrollPosition();
      const view = path[1], child = path[2];
      if (view === 'search') {state.searchMode = child;state.focusedSearchMode = child;}
      if (view === 'discover') {state.discoverMode = child;state.focusedDiscoverMode = child;state.catalogAdvancedTool = '';}
      if (view === 'sources') {state.sourcesMode = child;state.focusedSourcesMode = child;}
      if (state.activeHostWorkspace !== 'request') {
        state.requestSubview = view;state.focusedRequestSubview = view;
        activateHostWorkspace('request', {inputOrigin:'host-navigation'});
      }
      activateRequestSubview(view, {rememberScroll:false});
    }
    window.BilikaraHostLayout?.rememberSubTabs?.();
    return true;
  }
  function restore(route) {
    if (!route || typeof route !== 'object') return;
    state.requestSubview = normalizeRequestSubview(route.view);
    state.searchMode = normalizeSearchMode(route.search);
    state.discoverMode = normalizeDiscoverMode(route.discover);
    state.sourcesMode = normalizeSourcesMode(route.sources);
    state.focusedRequestSubview = state.requestSubview;
    state.focusedSearchMode = state.searchMode;state.focusedDiscoverMode = state.discoverMode;state.focusedSourcesMode = state.sourcesMode;
    state.catalogAdvancedTool = '';
    if (state.activeHostWorkspace === 'request') syncRequestSubviewSelection();
  }
  // Fixed headings, navigation and tool rows exclude every descendant,
  // including blank space. Only the active content panel can start a swipe.
  const fixedZones = () => [...document.querySelectorAll(
    '#android-page-heading,#android-page-tools,.request-workspace-head,.request-mode-head,.queue-card-head,.gatcha-head,.gatcha-actions,.browse-search-bar,.request-query-form,#add-form,.source-action-row,.follow-search-form,[role="tablist"]')];
  function motion(node) {
    if (!window.BilikaraHostLayout?.isPortrait()) return null;
    const frame = document.querySelector('.shell-body').getBoundingClientRect(), bounds = node.getBoundingClientRect();
    const properties = ['position','top','left','width','height','padding-left','padding-right','box-sizing'];
    const saved = properties.map(key=>[key,node.style.getPropertyValue(key)]);
    const root = document.documentElement;
    root.dataset.hostSubtabMotion = 'true';
    node.style.position = 'absolute';
    const parent = node.offsetParent, parentBounds = parent.getBoundingClientRect();
    Object.assign(node.style,{boxSizing:'border-box',top:`${bounds.top-parentBounds.top-parent.clientTop+parent.scrollTop}px`,
      left:`${frame.left-parentBounds.left-parent.clientLeft+parent.scrollLeft}px`,width:`${frame.width}px`,height:`${bounds.height}px`,
      paddingLeft:`${bounds.left-frame.left}px`,paddingRight:`${frame.right-bounds.right}px`});
    return () => {
      saved.forEach(([key,value])=>value?node.style.setProperty(key,value):node.style.removeProperty(key));
      delete root.dataset.hostSubtabMotion;
    };
  }
  const binding = api.bind(elements.appShell,{scope,tree,current,commit,panel,fixedZones,motion,
    allowed:() => ['queue','request'].includes(scope()) && !state.catalogAdvancedTool
      && ![...sourceRemovalEditors.values()].some(editor => editor.interacting || editor.editing || editor.pending)});
  window.BilikaraHostSubTabs = {tree,current,restore,cancel:binding.cancel};
})();
