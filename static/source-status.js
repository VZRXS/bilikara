/* One presentation of native source-refresh state for Host and Remote. */
(function (root) {
  "use strict";
  const reloads = new Map();
  let observedTask;
  let observedSources;
  let observedQueue;
  function takeSourceChanges(task = {}) {
    const completed = task.source_queue?.completed;
    const queuedChanges = ["uids", "favorites"].filter(key => Number(completed?.[key]) > 0
      && completed[key] !== observedQueue?.[key]);
    observedQueue = completed && {...completed};
    const sources = task.last_result?.rebuild?.sources;
    if (!sources) { observedSources = undefined; return queuedChanges; }
    const previous = observedSources;
    observedSources = {...sources};
    return ["uids", "favorites"].filter(key => queuedChanges.includes(key) || (Number(sources[key]) > 0
      && (!previous || sources.generation !== previous.generation || sources[key] !== previous[key])));
  }
  function takeCompletion(task = {}, saving = false) {
    const signature = JSON.stringify([task.busy, task.background_busy, task.last_status,
      task.last_updated_at, task.last_message, task.last_error]);
    // The initial server snapshot is a baseline, not a new completion. Compare
    // server observations, never the phone's clock with the Host's clock.
    if (observedTask === undefined) { observedTask = signature; return false; }
    if (saving) return false; // Consume a fast completion after the request settles.
    const changed = signature !== observedTask;
    observedTask = signature;
    return changed && !task.busy && !task.background_busy
      && ["success", "partial", "failed"].includes(task.last_status);
  }
  function setBusy(button, busy) {
    button.classList.add("source-action-button");
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }
  function flush(key) {
    const pending = reloads.get(key);
    if (pending && pending.ready()) {
      reloads.delete(key);
      void pending.reload();
    }
  }
  function queueReload(key, ready, reload) {
    reloads.set(key, {ready, reload});
    flush(key);
  }
  function sourceState(task = {}, {uid, folderId} = {}) {
    const progress = task.last_result?.rebuild;
    const busy = Boolean(task.busy || task.background_busy || task.last_status === "running");
    const [owner, folder] = String(folderId || "").includes(":")
      ? String(folderId).split(":") : ["", String(folderId || "")];
    const matches = job => job && (uid ? !job.folder_ids && job.uid === uid
      : (!owner || job.uid === owner) && job.folder_ids?.includes(folder));
    if (matches(task.source_queue?.active)) return "running";
    if (task.source_queue?.pending?.some(matches)) return "queued";
    if (busy && progress && (uid ? progress.phase === "uid" && uid === String(progress.current_uid || "")
      : progress.phase === "favlist" && folder === String(progress.current_folder_id || ""))) return "running";
    if (task.source_queue?.failed?.some(matches) || (uid
      ? progress?.failed_uids?.includes(uid) || task.last_result?.errors?.some(v => String(v.uid) === uid)
      : task.last_result?.favlist_errors?.some(v => String(v.folder_id) === folder))) return "failed";
    if (busy && uid && progress?.pending_uids?.includes(uid)) return "queued";
    return "";
  }
  const sourceTitles = new Map();
  // Browse folders are "uid:folder"; queued jobs carry the plain folder id.
  const plainFolderId = value => String(value ?? "").split(":").pop();
  // A queued source has no library entry yet; keep the name the user confirmed.
  function rememberSource({uid, folderId, title} = {}) {
    const key = folderId ? `favorites:${plainFolderId(folderId)}` : `uids:${uid || ""}`;
    const text = String(title || "").trim().slice(0, 200);
    if (!text || key.endsWith(":")) return;
    sourceTitles.delete(key);
    sourceTitles.set(key, text);
    while (sourceTitles.size > 200) sourceTitles.delete(sourceTitles.keys().next().value);
  }
  // Waiting and running jobs precede their library entries. They are shown as
  // placeholder cards until a refreshed list contains the same source.
  function queuedSources(task = {}, kind, present = []) {
    const favorites = kind === "favorites";
    const queue = task.source_queue || {};
    const known = new Set(present.map(value => favorites ? plainFolderId(value) : String(value ?? "")));
    const entries = [];
    for (const job of [queue.active, ...(Array.isArray(queue.pending) ? queue.pending : [])]) {
      const uid = String(job?.uid || "");
      const ids = favorites
        ? (Array.isArray(job?.folder_ids) ? job.folder_ids.map(String) : [])
        : job && !job.folder_ids ? [uid] : [];
      for (const id of ids) {
        if (!uid || !id || known.has(id)) continue;
        known.add(id);
        entries.push(favorites
          ? {placeholder: true, uid, id: `${uid}:${id}`, folder_id: id, title: String(job.folder_titles?.[id] || sourceTitles.get(`favorites:${id}`) || "")}
          : {placeholder: true, uid, name: sourceTitles.get(`uids:${uid}`) || ""});
      }
    }
    return entries;
  }
  function emptyText(task, source, translate, fallback) {
    const status = sourceState(task, source);
    return status ? translate(status === "queued" ? "gatcha.sourceWaiting" : `gatcha.source${status[0].toUpperCase()}${status.slice(1)}`) : fallback;
  }
  function syncCard(card, task = {}, translate) {
    const status = sourceState(task, card.dataset);
    const active = status === "running";
    card.classList.toggle('source-card-loading', Boolean(active));
    card.classList.toggle('source-card-failed', status === "failed");
    let label = card.querySelector('.source-card-status');
    if (status && status !== "running") {
      if (!label) {
        label = document.createElement('span'); label.className = 'source-card-status';
        (card.querySelector('.follow-up-count') || card).append(label);
      }
      label.textContent = translate(status === "queued" ? "gatcha.sourceWaiting" : "gatcha.sourceFailedShort");
    } else label?.remove();
    if (active) card.setAttribute('aria-busy', 'true');
    else card.removeAttribute('aria-busy');
    let spinner = card.querySelector('.source-card-spinner');
    if (!active) { spinner?.remove(); return; }
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'source-card-spinner';
      spinner.setAttribute('role', 'status');
      (card.querySelector('.follow-up-count') || card).append(spinner);
    }
    spinner.setAttribute('aria-label', translate('gatcha.pullingSources'));
    spinner.title = translate('gatcha.pullingSources');
  }
  function sync(containers, {task = {}, translate}) {
    for (const container of containers.filter(Boolean)) {
      container.querySelector(':scope > .source-task-status')?.remove();
      for (const card of container.querySelectorAll('.follow-up-button')) syncCard(card, task, translate);
    }
  }
  root.BilikaraSourceStatus = {sync, syncCard, sourceState, emptyText, setBusy, queueReload, flush, takeCompletion, takeSourceChanges,
    queuedSources, rememberSource};
})(window);
