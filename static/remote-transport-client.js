(function installBilikaraRemoteTransport(global) {
  "use strict";

  const nativeFetch = global.fetch.bind(global);
  const fragment = new URLSearchParams(global.location.hash.slice(1));
  const roomId = fragment.get("room") || "";
  const joinToken = fragment.get("join") || "";
  const internetMode = Boolean(roomId || joinToken);
  const lowLevel = global.BilikaraInternetTransport;
  const identityStorageKey = "bilikara.internetRemote.identity.v1";
  const identityUserStorageKey = `${identityStorageKey}.${roomId}.userId`;
  const endpointStorageKey = "bilikara.internetRemote.endpoint.v1";
  const heartbeatIntervalMs = 2_000;
  const heartbeatTimeoutMs = 8_000;
  const playlistAddRequestTimeoutMs = 60_000;

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  function localApi() {
    return Object.freeze({
      mode: "local",
      ready: () => Promise.resolve(),
      fetch: nativeFetch,
      createStateSource: (url) => new global.EventSource(url),
      disconnect: () => {},
      isSupported: () => true,
    });
  }

  if (!internetMode) {
    global.BilikaraRemoteTransport = localApi();
    return;
  }

  const listeners = new Set();
  const peerId = loadPeerId();
  const state = {
    socket: null,
    peer: null,
    ice: null,
    control: null,
    bulk: null,
    decoders: null,
    epoch: "",
    sequences: { control: 0, bulk: 0 },
    pending: new Map(),
    limitedNotices: new Map(),
    revisionMutationTail: Promise.resolve(),
    remoteState: null,
    identity: localStorage.getItem(identityStorageKey) || "",
    identityUserId: localStorage.getItem(identityUserStorageKey) || "",
    password: "",
    authorized: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    disconnectedTimer: null,
    heartbeatTimer: null,
    lastPongAt: 0,
    heartbeatProbeAt: 0,
    heartbeatLastTickAt: 0,
    readyPromise: null,
    readyResolve: null,
    overlay: null,
    identityInput: null,
    passwordInput: null,
    connectButton: null,
    translate: null,
    translateRoot: null,
    connectionMessage: "",
    connectionIsError: false,
  };

  function loadPeerId() {
    const existing = localStorage.getItem(endpointStorageKey) || "";
    if (/^[A-Za-z0-9_-]{22}$/u.test(existing)) return existing;
    const created = lowLevel?.randomBase64Url(16) || "";
    if (created) localStorage.setItem(endpointStorageKey, created);
    return created;
  }

  function ensureReadyPromise() {
    if (!state.readyPromise) {
      state.readyPromise = new Promise((resolve) => {
        state.readyResolve = resolve;
      });
    }
    return state.readyPromise;
  }

  // Exact messages owned by this adapter; unknown server/native details remain verbatim.
  const connectionMessageKeys = Object.freeze({
    "请输入用户名和 4–32 位房间密码。": "internetRemote.joinRequired",
    "当前浏览器不支持此公网连接。": "internetRemote.unavailable",
    "房间链接无效，请重新扫描 Host 二维码。": "internetRemote.invalidLink",
    "正在连接…": "remote.connectionConnecting",
    "正在重新连接…": "remote.connectionReconnecting",
    "等待 Host…": "internetRemote.waitingForHost",
    "Host 不在线。": "internetRemote.hostOffline",
    "信令暂时不可用。": "internetRemote.signalingUnavailable",
    "正在认证…": "internetRemote.authenticating",
    "尝试过多，请一分钟后再试。": "internetRemote.tooManyAttempts",
    "房间密码错误。": "internetRemote.wrongPassword",
    "连接失败": "internetRemote.connectionFailed",
    "无法自动恢复连接，请重新连接。": "internetRemote.reconnectFailed",
    "Host 响应超时": "internetRemote.hostTimeout",
    "连接已重置": "internetRemote.connectionReset",
    "尚未连接 Host": "internetRemote.notConnected",
    "信令未连接": "internetRemote.signalingNotConnected",
  });

  function translatedCopy(key, fallback) {
    const translated = state.translate?.(key);
    return translated && translated !== key ? translated : fallback;
  }

  function operationFailure(code, { completed = false, limitBytes = lowLevel.maxMessageBytes } = {}) {
    const key = code === "internet_remote_unavailable" ? "internetRemote.operationUnavailable"
      : code === "internet_remote_source_list_incomplete"
        ? completed ? "internetRemote.sourceResultIncomplete" : "internetRemote.sourceListIncomplete"
      : completed ? "internetRemote.resultTooLarge" : "internetRemote.messageTooLarge";
    const fallback = code === "internet_remote_unavailable" ? "公网版不支持此功能，请在 Host 或本地 Remote 操作。"
      : code === "internet_remote_source_list_incomplete"
        ? completed ? "操作已执行，但公网版无法完整显示来源配置。请在 Host 或本地 Remote 确认，不要重复提交。"
          : "来源目录过长，公网版无法完整编辑。请在 Host 或本地 Remote 操作。"
      : completed ? "操作已执行，但返回数据超过公网版 {limit}KiB 上限。请在 Host 或本地 Remote 确认结果，不要重复提交。"
        : "公网版不支持传输超过 {limit}KiB 的数据，请在 Host 或本地 Remote 操作。";
    return translatedCopy(key, fallback).replaceAll("{limit}", String(limitBytes / 1024));
  }

  function notifyOperation(message, isError = true) {
    global.dispatchEvent(new CustomEvent("remote-operation-message", {
      detail: { message, isError },
    }));
  }

  function notifyListLimits(data, scope, context = "") {
    const labels = {playlist:["internetRemote.queueList", "待播列表"], history:["internetRemote.historyList", "播放历史"],
      items:["internetRemote.resultsList", "浏览结果"]};
    const known = new Set([...Object.keys(labels), "owners", "folders", "uid_options", "favlist_folder_options",
      "tags", "tag45s", "excluded_uids", "excluded_favlist_folders", "selected_folder_ids", "uids"]);
    const rows = Object.entries(data?.public_list_limits || {}).filter(([key, value]) => known.has(key)
      && Number.isSafeInteger(value?.total) && Number.isSafeInteger(value?.shown)
      && value.shown >= 0 && value.shown < value.total && Array.isArray(data[key])
      && data[key].length === value.shown);
    const signature = rows.map(([key]) => key).sort().join(",");
    // Counts/progress change often; notify once for the same incomplete view.
    // Read scopes are bounded by RPC kind, and offsets do not create new toasts.
    const previous = state.limitedNotices.get(scope);
    if (!signature) { state.limitedNotices.delete(scope); return; }
    if (previous?.signature === signature && previous.context === context) return;
    state.limitedNotices.set(scope, {signature,context});
    const page = rows.length === 1 && rows[0][0] === "items" && rows[0][1].paged === true;
    const key = page ? "internetRemote.pageLimited" : "internetRemote.listsLimited";
    const fallback = page ? "本页内容较多，公网版显示 {shown}/{total} 条，可继续翻页。"
      : "公网长列表仅显示部分内容（{lists}）。完整列表请在 Host 或本地 Remote 查看。";
    const lists = rows.map(([name, value]) => {
      const [label, text] = labels[name] || ["internetRemote.sourceList", "来源目录"];
      return `${translatedCopy(label, text)} ${value.shown}/${value.total}`;
    }).join("、");
    notifyOperation(translatedCopy(key, fallback).replaceAll("{lists}", lists)
      .replaceAll("{shown}", String(rows[0][1].shown)).replaceAll("{total}", String(rows[0][1].total)), false);
  }

  function renderConnectionCopy() {
    const raw = state.connectionMessage;
    const key = Object.hasOwn(connectionMessageKeys, raw) ? connectionMessageKeys[raw] : null;
    const message = key ? translatedCopy(key, raw) : raw;
    if (message) global.dispatchEvent(new CustomEvent("remote-connection-message", {
      detail: { message, isError: state.connectionIsError },
    }));
    if (state.connectButton) {
      const busy = state.connectButton.hasAttribute("aria-busy") && !state.connectionIsError;
      state.connectButton.dataset.i18n = busy ? "remote.connectionConnecting" : "internetRemote.connect";
      state.connectButton.textContent = translatedCopy(state.connectButton.dataset.i18n, busy ? "正在连接" : "连接");
    }
  }

  function localize(translate, translateRoot) {
    state.translate = translate;
    state.translateRoot = translateRoot;
    renderConnectionCopy();
  }

  function setConnectionStatus(message, isError = false) {
    state.connectionMessage = String(message || "").replace(/(?:\.{3}|·{3})$/u, "…");
    state.connectionIsError = isError;
    renderConnectionCopy();
  }

  function ensureJoinOverlay() {
    if (state.overlay) return;
    const overlay = document.createElement("div");
    overlay.className = "internet-remote-join-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "internet-join-title");
    overlay.innerHTML = `
      <div class="remote-identity-backdrop"></div>
      <div class="remote-identity-card internet-remote-join-card">
        <h2 id="internet-join-title" data-i18n="internetRemote.joinTitle">连接 bilikara 房间</h2>
        <p class="remote-identity-description" data-i18n="remoteIdentity.registerDescription">首次使用须填写用户名，登记后本设备将始终使用该身份点歌。</p>
        <form class="remote-identity-form">
          <input id="internet-join-identity" name="identity" type="text" maxlength="24" autocomplete="nickname" aria-label="用户名" data-i18n-aria-label="remoteIdentity.inputLabel" data-i18n-placeholder="remoteIdentity.inputPlaceholder" placeholder="输入用户名" required>
          <input id="internet-join-password" name="password" type="password" minlength="4" maxlength="32" autocomplete="current-password" aria-label="房间密码" data-i18n-aria-label="internetRemote.password" data-i18n-placeholder="internetRemote.passwordPlaceholder" placeholder="输入房间密码" required>
          <div class="remote-identity-actions"><button type="submit" class="primary-button" data-i18n="internetRemote.connect">连接</button></div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.identityInput = overlay.querySelector('input[name="identity"]');
    state.passwordInput = overlay.querySelector('input[name="password"]');
    state.connectButton = overlay.querySelector('button[type="submit"]');
    state.identityInput.value = state.identity;
    state.translateRoot?.(overlay);
    overlay.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.connectButton.disabled) return;
      const identity = String(state.identityInput.value || "").trim();
      const password = String(state.passwordInput.value || "");
      if (!identity || password.length < 4 || password.length > 32) {
        setConnectionStatus("请输入用户名和 4–32 位房间密码。", true);
        return;
      }
      if (identity !== state.identity) { state.identityUserId = ""; localStorage.removeItem(identityUserStorageKey); }
      state.identity = identity;
      state.password = password;
      localStorage.setItem(identityStorageKey, identity);
      state.reconnectAttempts = 0;
      state.connectButton.disabled = true;
      state.connectButton.setAttribute("aria-busy", "true");
      connectSignaling();
    });
  }

  function signalingUrl() {
    return `${global.location.origin.replace(/^http/u, "ws")}/v1/rooms/${roomId}/socket`;
  }

  function sendSignal(type, payload) {
    if (state.socket?.readyState !== WebSocket.OPEN) throw new Error("信令未连接");
    state.socket.send(JSON.stringify({ to: "host", type, payload }));
  }

  function resetPeer() {
    const wasAuthorized = state.authorized;
    clearTimeout(state.disconnectedTimer);
    state.disconnectedTimer = null;
    stopHeartbeat();
    state.authorized = false;
    global.dispatchEvent(new Event("remote-invitation-changed"));
    // A first join can fail while fetching an oversized initial snapshot. Keep
    // its unresolved page-startup waiter across retries; retire only fulfilled
    // readiness so ordinary reconnects can wait for their replacement peer.
    if (wasAuthorized && !state.readyResolve) {
      state.readyPromise = null;
    }
    if (wasAuthorized) {
      for (const listener of [...listeners]) listener({ type: "error" });
    }
    state.control?.close();
    state.bulk?.close();
    state.peer?.close();
    state.peer = null;
    state.ice = null;
    state.control = null;
    state.bulk = null;
    state.epoch = lowLevel.randomBase64Url(16);
    state.sequences = { control: 0, bulk: 0 };
    state.decoders = { control: new lowLevel.Decoder(), bulk: new lowLevel.Decoder() };
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("连接已重置"));
    }
    state.pending.clear();
  }

  function connectSignaling() {
    if (!lowLevel || typeof RTCPeerConnection !== "function") {
      setConnectionStatus("当前浏览器不支持此公网连接。", true);
      state.connectButton.disabled = true;
      return;
    }
    if (!/^[A-Za-z0-9_-]{27}$/u.test(roomId) || !/^[A-Za-z0-9_-]{43}$/u.test(joinToken)) {
      setConnectionStatus("房间链接无效，请重新扫描 Host 二维码。", true);
      state.connectButton.disabled = true;
      return;
    }
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const previousSocket = state.socket;
    state.socket = null;
    previousSocket?.close(1000, "reconnecting");
    resetPeer();
    setConnectionStatus(state.reconnectAttempts ? "正在重新连接…" : "正在连接…");
    const socket = new WebSocket(signalingUrl(), ["bilikara-v1", `remote.${joinToken}.${peerId}`]);
    state.socket = socket;
    socket.addEventListener("open", () => {
      if (state.socket === socket) setConnectionStatus("等待 Host…");
    });
    socket.addEventListener("message", (event) => {
      if (state.socket !== socket) return;
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "offer" && message.from) acceptOffer(message.payload).catch(fail);
      else if (message.type === "candidate" && message.from && state.ice) {
        const ice = state.ice;
        ice.addCandidate(message.payload).catch((error) => { if (state.ice === ice) fail(error); });
      }
      else if (message.type === "host.leave" && !state.authorized) setConnectionStatus("Host 不在线。", true);
    });
    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      state.socket = null;
      if (!state.authorized && state.password) scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (state.socket === socket) setConnectionStatus("信令暂时不可用。", true);
    });
  }

  async function acceptOffer(description) {
    resetPeer();
    const peer = new RTCPeerConnection(lowLevel.iceConfiguration);
    state.peer = peer;
    const ice = lowLevel.createIceCandidateExchange(peer, {
      isCurrent: () => state.peer === peer,
      sendCandidate: (candidate) => { if (!state.authorized) sendSignal("candidate", candidate); },
      onError: fail,
    });
    state.ice = ice;
    peer.addEventListener("datachannel", (event) => wireChannel(event.channel));
    peer.addEventListener("connectionstatechange", () => {
      if (state.peer !== peer) return;
      if (peer.connectionState === "connected") setConnectionStatus("正在认证…");
      if (["failed", "closed"].includes(peer.connectionState)) scheduleReconnect();
    });
    peer.addEventListener("iceconnectionstatechange", () => {
      if (state.peer !== peer) return;
      clearTimeout(state.disconnectedTimer);
      if (peer.iceConnectionState === "disconnected") {
        state.disconnectedTimer = setTimeout(scheduleReconnect, 5_000);
      }
    });
    await ice.setRemoteDescription(description);
    if (state.peer !== peer) return;
    await peer.setLocalDescription(await peer.createAnswer());
    await lowLevel.waitForIceGathering(peer);
    if (state.peer === peer) {
      sendSignal("answer", peer.localDescription);
      ice.descriptionSent();
    }
  }

  function wireChannel(channel) {
    const lane = channel.label === "bilikara-bulk"
      ? "bulk"
      : channel.label === "bilikara-control"
        ? "control"
        : "";
    if (!lane) {
      channel.close();
      return;
    }
    state[lane] = channel;
    channel.addEventListener("message", (event) => {
      if (state[lane] !== channel) return;
      try {
        for (const message of state.decoders[lane].consume(event.data)) handleDataMessage(message);
      } catch (error) {
        fail(error);
      }
    });
    channel.addEventListener("open", authenticateIfReady);
    channel.addEventListener("close", () => {
      if (state[lane] === channel && state.authorized) scheduleReconnect();
    });
  }

  function authenticateIfReady() {
    if (state.control?.readyState !== "open" || state.bulk?.readyState !== "open") return;
    lowLevel.send(state.control, { type: "auth", password: state.password, epoch: state.epoch });
  }

  function handleDataMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "pong") {
      const acknowledgedAt = Number(message.at || 0);
      if (Number.isFinite(acknowledgedAt) && acknowledgedAt >= state.heartbeatProbeAt) {
        state.lastPongAt = acknowledgedAt;
      }
      return;
    }
    if (message.type === "auth.failed") {
      state.connectButton.disabled = false;
      state.connectButton.removeAttribute("aria-busy");
      setConnectionStatus(
        message.reason === "too_many_attempts" ? "尝试过多，请一分钟后再试。" : "房间密码错误。",
        true,
      );
      return;
    }
    if (message.type === "auth.ok") {
      state.authorized = true;
      global.dispatchEvent(new Event("remote-invitation-changed"));
      state.reconnectAttempts = 0;
      (async () => {
        const resumeUserId = state.identityUserId;
        const initial = await request("state.get", {}, "bulk");
        if (initial?.data) publishState(initial.data.state || initial.data);
        const response = await request(state.remoteState?.session_user_edit_version >= 1 && resumeUserId ? "session.resume" : "session.set_identity",
          state.remoteState?.session_user_edit_version >= 1 && resumeUserId ? { user_id: resumeUserId } : { name: state.identity });
        state.identity = String(response.data?.name || state.identity);
        if (response?.data?.state) publishState(response.data.state);
        rememberIdentity();
        state.overlay.classList.add("hidden");
        document.documentElement.dataset.remoteTransport = "internet";
        state.connectButton.disabled = false;
        state.connectButton.removeAttribute("aria-busy");
        state.connectionMessage = "";
        renderConnectionCopy();
        state.readyResolve?.();
        state.readyResolve = null;
      })().catch(fail);
      startHeartbeat();
      setTimeout(() => state.socket?.close(1000, "WebRTC connected"), 1_000);
      return;
    }
    if (message.type === "state") {
      publishState(message.data);
      return;
    }
    if (message.type === "response") {
      if (!state.authorized) return;
      const sizeError = ["internet_remote_message_too_large", "internet_remote_source_list_incomplete"].includes(message.code);
      const errorMessage = sizeError ? operationFailure(message.code, {
        completed: message.completed === true,
        limitBytes: lowLevel.maxMessageBytes,
      }) : String(message.error || message.message || message.code || "Host 拒绝了请求");
      if (sizeError) notifyOperation(errorMessage);
      const pending = state.pending.get(message.request_id);
      if (pending) {
        state.pending.delete(message.request_id);
        clearTimeout(pending.timeout);
        if (message.accepted === false) {
          const error = new Error(errorMessage);
          error.code = String(message.code || "internet_remote_request_rejected");
          if (sizeError) error.completed = message.completed === true;
          if (message.binding) error.payload = { binding: message.binding };
          pending.reject(error);
        } else {
          // Record limits after snapshot-order validation. The HTTP/auth owner
          // still publishes to UI listeners, without an extra paint per reply.
          if (message.data?.state) publishState(message.data.state, false);
          else if (Array.isArray(message.data?.playlist)) publishState(message.data, false);
          else {
            notifyListLimits(message.data, pending.kind, pending.listContext);
            if (message.data?.cache) notifyListLimits(message.data.cache, `${pending.kind}.cache`, pending.listContext);
          }
          pending.resolve(message);
        }
      }
      if (message.stale && message.data) publishState(message.data.state || message.data);
    }
  }

  function stopHeartbeat() {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
    state.lastPongAt = 0;
    state.heartbeatProbeAt = 0;
    state.heartbeatLastTickAt = 0;
  }

  function probeHeartbeat({ freshGrace = false } = {}) {
    const now = Date.now();
    const tickGap = state.heartbeatLastTickAt ? now - state.heartbeatLastTickAt : 0;
    state.heartbeatLastTickAt = now;
    if (!state.authorized || state.control?.readyState !== "open") {
      if (state.authorized) scheduleReconnect();
      return;
    }

    const awaitingPong = state.heartbeatProbeAt > state.lastPongAt;
    const timerWasSuspended = tickGap > heartbeatTimeoutMs;
    if (awaitingPong && !freshGrace && !timerWasSuspended) {
      if (now - state.heartbeatProbeAt > heartbeatTimeoutMs) scheduleReconnect();
      return;
    }

    const probeAt = Math.max(now, state.heartbeatProbeAt + 1);
    state.heartbeatProbeAt = probeAt;
    lowLevel.send(state.control, { type: "ping", at: probeAt });
  }

  function startHeartbeat() {
    stopHeartbeat();
    probeHeartbeat({ freshGrace: true });
    state.heartbeatTimer = setInterval(probeHeartbeat, heartbeatIntervalMs);
  }

  function refreshHeartbeatAfterForeground() {
    if (document.visibilityState === "hidden") return;
    if (state.authorized && state.control?.readyState === "open") {
      probeHeartbeat({ freshGrace: true });
    } else if (state.password) {
      scheduleReconnect();
    }
  }

  function request(kind, body, lane = "control", timeoutMs = 15_000) {
    if (!state.authorized || state[lane]?.readyState !== "open") {
      return Promise.reject(new Error("尚未连接 Host"));
    }
    const id = crypto.randomUUID();
    const envelope = {
      v: 1,
      lane,
      epoch: state.epoch,
      seq: ++state.sequences[lane],
      id,
      kind,
      body,
    };
    try { lowLevel.checkMessageSize(envelope, lowLevel.maxRequestBytes); }
    catch (error) {
      error.message = operationFailure(error.code, { limitBytes: error.limitBytes });
      notifyOperation(error.message);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error("Host 响应超时"));
      }, timeoutMs);
      const {offset, ...listContext} = body || {};
      state.pending.set(id, { resolve, reject, timeout, kind, listContext: JSON.stringify(listContext) });
      try {
        lowLevel.send(state[lane], { type: "request", lane, envelope });
      } catch (error) {
        clearTimeout(timeout);
        state.pending.delete(id);
        reject(error);
      }
    });
  }

  const revisionBoundMutationPaths = new Set([
    "/api/playlist/add",
    "/api/playlist/reorder",
    "/api/playlist/resort",
    "/api/playlist/remove",
    "/api/playlist/move-next",
    "/api/playlist/play-now",
    "/api/cache/retry",
    "/api/player/audio-variant",
  ]);

  function isRevisionBoundMutation(method, pathname) {
    return method === "POST" && revisionBoundMutationPaths.has(pathname);
  }

  async function acquireRevisionMutationTurn() {
    const previous = state.revisionMutationTail;
    let release;
    state.revisionMutationTail = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    return release;
  }

  function expectedRevision() {
    return Number(state.remoteState?.revision || 0);
  }

  function itemUrl(item) {
    const youtubeId = item?.media_source?.provider === "youtube" ? item.media_source.video_id : "";
    if (/^[A-Za-z0-9_-]{11}$/u.test(youtubeId)) return `https://www.youtube.com/watch?v=${youtubeId}`;
    const page = Number(item?.page || 1);
    return item?.bvid ? `https://www.bilibili.com/video/${item.bvid}${page > 1 ? `?p=${page}` : ""}` : "";
  }

  function localItem(item) {
    if (!item || typeof item !== "object") return null;
    const projectedVariants = Array.isArray(item.audio_variants) ? item.audio_variants : [];
    const variants = projectedVariants.length ? projectedVariants : [{
      id: String(item.selected_audio_variant_id || "main"),
      label: "Main",
      page: Number(item.page || 1),
    }];
    const fallbackPages = variants.map((variant, index) => Number(
      variant.page || String(variant.id || "").match(/^p(\d+)/u)?.[1] || index + 1,
    ));
    const selectedPages = Array.isArray(item.selected_pages) && item.selected_pages.length
      ? item.selected_pages.map(Number)
      : fallbackPages;
    const availablePages = Array.isArray(item.available_pages) && item.available_pages.length
      ? item.available_pages.map(Number)
      : fallbackPages;
    const selectedParts = Array.isArray(item.selected_parts) && item.selected_parts.length
      ? item.selected_parts.map(String)
      : variants.map((variant) => variant.label);
    const availableParts = Array.isArray(item.available_parts) && item.available_parts.length
      ? item.available_parts.map(String)
      : variants.map((variant) => variant.label);
    return {
      ...item,
      original_url: itemUrl(item),
      resolved_url: itemUrl(item),
      item_incarnation_id: String(item.item_incarnation_id || ""),
      video_media_url: item.cache_status === "ready" ? "internet-remote://video" : "",
      selected_pages: selectedPages.length ? selectedPages : [Number(item.page || 1)],
      selected_durations: Array.isArray(item.selected_durations) ? item.selected_durations.map(Number) : [],
      selected_parts: selectedParts,
      available_pages: availablePages.length ? availablePages : [Number(item.page || 1)],
      available_durations: Array.isArray(item.available_durations) ? item.available_durations.map(Number) : [],
      available_parts: availableParts,
      audio_variants: variants.map((variant) => ({
        ...variant,
        audio_url: item.cache_status === "ready"
          ? `internet-remote://audio/${encodeURIComponent(variant.id || "main")}` : "",
      })),
    };
  }

  function localHistoryItem(entry) {
    if (!entry || typeof entry !== "object") return null;
    const url = itemUrl(entry);
    return {
      ...entry,
      original_url: url,
      resolved_url: url,
    };
  }

  function localState(remoteState) {
    if (!remoteState || typeof remoteState !== "object") return remoteState;
    const status = remoteState.player_status;
    const current = localItem(remoteState.current_item);
    return {
      schema_version: 1,
      state_epoch: typeof remoteState.state_epoch === "string" ? remoteState.state_epoch : "",
      state_revision: Number(remoteState.state_revision ?? remoteState.revision ?? 0),
      queue_version: String(remoteState.queue_version || ""),
      session_generation: Number(remoteState.session_generation || 0),
      playback_generation: Number(remoteState.playback_generation || 0),
      playback_mode: remoteState.playback_mode || "local",
      // This capability describes the Host, not the SSE transport. Do not
      // forward local-only transport capabilities such as event_heartbeat.
      capabilities: {
        source_queue: remoteState.capabilities?.source_queue === true,
        source_queue_titles: remoteState.capabilities?.source_queue_titles === true,
      },
      current_item: current,
      playlist: (remoteState.playlist || []).map(localItem).filter(Boolean),
      history: (remoteState.history || []).map(localHistoryItem).filter(Boolean),
      public_list_limits: remoteState.public_list_limits || {},
      session_history: [],
      session_played: (remoteState.session_played || []).map(localHistoryItem).filter(Boolean),
      song_ratings: remoteState.song_ratings || [],
      session_users: Array.isArray(remoteState.session_users) ? remoteState.session_users : [],
      session_user_entries: remoteState.session_user_entries || [],
      session_user_edit_version: Number(remoteState.session_user_edit_version || 0),
      session_users_version: String(remoteState.session_users_version || ""),
      remote_session_id: identitySessionId(),
      automatic_volume: remoteState.automatic_volume || null,
      player_settings: {
        av_offset_ms: Number(remoteState.player_settings?.effective_av_delay_ms || 0),
        av_delay: {
          effective_delay_ms: Number(remoteState.player_settings?.effective_av_delay_ms || 0),
          locked: Boolean(remoteState.player_settings?.av_delay_locked),
          lock_button_enabled: Boolean(remoteState.player_settings?.av_delay_lock_button_enabled),
          has_local_adjustment: Boolean(remoteState.player_settings?.av_delay_has_local_adjustment),
        },
        volume_percent: Number(remoteState.player_settings?.volume_percent ?? 100),
        is_muted: Boolean(remoteState.player_settings?.is_muted),
        key_shift: Number(remoteState.player_settings?.key_shift || 0),
      },
      player_status: status && current ? {
        item_id: current.id,
        playback_generation: Number(remoteState.playback_generation || 0),
        is_paused: !status.playing,
        current_time: Number(status.position_seconds || 0),
        duration: Number(status.duration_seconds || 0),
        updated_at: Date.now() / 1000,
      } : null,
      bbdown: { logged_in: Boolean(remoteState.bilibili_logged_in) },
      gatcha: remoteState.gatcha || state.remoteState?.gatcha || { busy: false },
      gatcha_pool_config: remoteState.gatcha_pool_config || state.remoteState?.gatcha_pool_config || {},
    };
  }

  function identitySessionId() {
    return `internet-${roomId}-${state.remoteState?.state_epoch || ""}-${state.remoteState?.session_generation || 0}`;
  }

  function rememberIdentity() {
    const user = state.remoteState?.session_user_entries?.find(user => user.name === state.identity);
    if (user) state.identityUserId = user.id;
    localStorage.setItem(identityStorageKey, state.identity);
    if (state.identityUserId) localStorage.setItem(identityUserStorageKey, state.identityUserId);
    else localStorage.removeItem(identityUserStorageKey);
  }

  function publishState(next, notifyListeners = true) {
    if (!state.authorized || !next || typeof next !== "object") return;
    const nextEpoch = typeof next.state_epoch === "string" ? next.state_epoch : "";
    const currentEpoch = state.remoteState?.state_epoch || "";
    if (state.retiredStateEpochs?.has(nextEpoch) || (currentEpoch && !nextEpoch)) return;
    const restarted = Boolean(nextEpoch && nextEpoch !== currentEpoch);
    const currentRevision = Number(
      state.remoteState?.state_revision ?? state.remoteState?.revision ?? -1,
    );
    const nextRevision = Number(next.state_revision ?? next.revision ?? -1);
    if (
      state.remoteState
      && !restarted
      && Number.isFinite(currentRevision)
      && Number.isFinite(nextRevision)
      && nextRevision < currentRevision
    ) return;
    if (restarted) {
      state.retiredStateEpochs ||= new Set();
      if (currentEpoch) state.retiredStateEpochs.add(currentEpoch);
      state.remoteState = null;
      state.limitedNotices.clear();
    }
    notifyListLimits(next, "state");
    state.remoteState = {
      ...state.remoteState,
      ...next,
      public_list_limits: next.public_list_limits || {},
      gatcha: next.gatcha || state.remoteState?.gatcha,
      gatcha_pool_config: next.gatcha_pool_config || state.remoteState?.gatcha_pool_config,
    };
    if (state.identityUserId && state.remoteState.session_user_edit_version >= 1) {
      const user = state.remoteState.session_user_entries?.find(user => user.id === state.identityUserId);
      if (user) state.identity = user.name;
      else {
        state.identity = ""; state.identityUserId = "";
        localStorage.removeItem(identityUserStorageKey);
      }
      localStorage.setItem(identityStorageKey, state.identity);
    }
    if (!notifyListeners) return;
    const data = JSON.stringify(localState(state.remoteState));
    for (const listener of listeners) listener({ type: "state", data });
  }

  // Public transport sends a validated catalog identity; Rust remains the
  // authority for source admission. Shared fixtures cover both input parsers.
  function youtubeVideoId(text) {
    const links = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/)[A-Za-z0-9:/?&=#.%_+~@!$*\\-]+/giu;
    let selected = null;
    let invalidYoutube = false;
    for (const candidate of text.matchAll(links)) {
      if (candidate.index && /[a-z0-9_\-.@/=?&#%]/iu.test(text[candidate.index - 1])) continue;
      const link = candidate[0].replace(/[.,!;)\]}>"']+$/u, "").split(/[<>"']/u)[0];
      const schemeEnd = link.indexOf("://");
      const scheme = schemeEnd < 0 ? "https" : link.slice(0, schemeEnd).toLowerCase();
      const rest = schemeEnd < 0 ? link : link.slice(schemeEnd + 3);
      const slash = rest.indexOf("/");
      const authority = slash < 0 ? rest : rest.slice(0, slash);
      const tail = slash < 0 ? "" : rest.slice(slash + 1).split("#")[0];
      const host = authority.split("@").at(-1).split(":")[0].toLowerCase();
      if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) continue;
      const queryStart = tail.indexOf("?");
      const path = queryStart < 0 ? tail : tail.slice(0, queryStart);
      const query = queryStart < 0 ? "" : tail.slice(queryStart + 1);
      let id = null;
      if (["http", "https"].includes(scheme) && authority.toLowerCase() === host && !link.includes("\\")) {
        if (["youtu.be", "www.youtu.be"].includes(host)) id = path;
        else if (path === "watch" && !host.endsWith("youtube-nocookie.com")) {
          const ids = query.split("&").filter(pair => pair.startsWith("v=")).map(pair => pair.slice(2));
          if (ids.length === 1) [id] = ids;
        } else {
          const parts = path.split("/");
          if (parts.length === 2 && ["shorts", "live", "embed", "v"].includes(parts[0])
              && (!host.endsWith("youtube-nocookie.com") || parts[0] === "embed")) id = parts[1];
        }
      }
      if (!id || !/^[A-Za-z0-9_-]{11}$/u.test(id)) { invalidYoutube = true; continue; }
      if (selected && selected !== id) throw new Error("Multiple YouTube videos found; paste one video link");
      selected = id;
    }
    if (!selected && invalidYoutube) throw new Error("Invalid YouTube video link");
    return selected;
  }

  function catalogId(value, selectedPage) {
    const text = String(value || "").trim();
    const youtubeId = youtubeVideoId(text);
    if (youtubeId) {
      if (selectedPage && Number(selectedPage) !== 1) throw new Error("Invalid YouTube video link");
      return `youtube:${youtubeId}`;
    }
    const match = text.match(/(BV[0-9A-Za-z]{10})/u);
    if (!match) throw new Error("请输入 BV 号、Bilibili 视频链接或 YouTube 链接");
    let page = Number(selectedPage || 0);
    if (!page) {
      try { page = Number(new URL(text).searchParams.get("p") || 1); } catch { page = 1; }
    }
    return page > 1 ? `${match[1]}_p${Math.trunc(page)}` : match[1];
  }

  function publicSearchItem(item) {
    const url = itemUrl(item);
    return { ...item, url, original_url: url, resolved_url: url };
  }

  function publicCatalogPayload(payload) {
    const data = payload && typeof payload === "object" ? payload : {};
    return {
      ...data,
      items: (Array.isArray(data.items) ? data.items : []).map(publicSearchItem),
    };
  }

  async function fetchInternet(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url, global.location.href);
    if (url.origin !== global.location.origin || !url.pathname.startsWith("/api/")) {
      return nativeFetch(input, init);
    }
    if (!state.authorized) await ready();
    const method = String(init.method || "GET").toUpperCase();
    let body = {};
    if (init.body) {
      try { body = JSON.parse(String(init.body)); } catch { return jsonResponse({ ok: false, error: "请求格式无效" }, 400); }
    }
    const releaseRevisionMutation = isRevisionBoundMutation(method, url.pathname)
      ? await acquireRevisionMutationTurn()
      : null;
    try {
      let response;
      if (method === "GET" && url.pathname === "/api/remote-identity") {
        return jsonResponse({ ok: true, data: { registered: state.authorized && Boolean(state.identity), name: state.identity, user_id: state.identityUserId, session_id: identitySessionId() } });
      }
      if (method === "GET" && url.pathname === "/api/state") {
        response = await request("state.get", { since_revision: null }, "bulk");
        return jsonResponse({ ok: true, data: localState(response.data) });
      }
      if (method === "GET" && (url.pathname === "/api/catalog/search" || url.pathname === "/api/lark/search")) {
        if (url.searchParams.has("table")) {
          return jsonResponse({ ok: false, code: "catalog_table_retired", error: "Feishu table selection has been retired" }, 410);
        }
        response = await request("catalog.search", { query: url.searchParams.get("q") || "", limit: Math.min(80, Number(url.searchParams.get("limit") || 80)), offset: Number(url.searchParams.get("offset") || 0) }, "bulk");
        return jsonResponse({ ok: true, data: publicCatalogPayload(response.data) });
      }
      if (method === "GET" && url.pathname === "/api/gatcha/search") {
        response = await request("gatcha.search", { query: url.searchParams.get("q") || "", limit: Math.min(80, Number(url.searchParams.get("limit") || 80)), offset: Number(url.searchParams.get("offset") || 0) }, "bulk");
        return jsonResponse({ ok: true, data: publicCatalogPayload(response.data) });
      }
      if (method === "GET" && url.pathname === "/api/d1/browse") {
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        response = await request("catalog.browse", {
          ...(offset ? {offset} : {}),
          kind: url.searchParams.get("kind") === "artist" ? "artist" : "name",
          letter: url.searchParams.get("letter") || "",
          query: url.searchParams.get("q") || "",
          tag: url.searchParams.get("tag") || "",
          locale: url.searchParams.get("locale") || "",
          limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100))),
        }, "bulk");
        return jsonResponse({ ok: true, data: publicCatalogPayload(response.data) });
      }
      if (method === "GET" && url.pathname === "/api/d1/category-browse") {
        response = await request("catalog.category_browse", {
          tags: url.searchParams.getAll("tag"),
          tag45s: url.searchParams.getAll("tag45"),
          query: url.searchParams.get("q") || "",
          offset: Math.max(0, Number(url.searchParams.get("offset") || 0)),
          limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100))),
        }, "bulk");
        return jsonResponse({ ok: true, data: publicCatalogPayload(response.data) });
      }
      if (method === "GET" && url.pathname === "/api/gatcha/browse") {
        response = await request("gatcha.browse", {
          uid: url.searchParams.get("uid") || "",
          query: url.searchParams.get("q") || "",
          offset: Math.max(0, Number(url.searchParams.get("offset") || 0)),
          limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100))),
        }, "bulk");
        return jsonResponse({ ok: true, data: publicCatalogPayload(response.data) });
      }
      if (method === "GET" && url.pathname === "/api/gatcha/favlist/browse") {
        response = await request("gatcha.favlist_browse", {
          folder_id: url.searchParams.get("folder_id") || "",
          query: url.searchParams.get("q") || "",
          offset: Math.max(0, Number(url.searchParams.get("offset") || 0)),
          limit: Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 100))),
        }, "bulk");
        return jsonResponse({ ok: true, data: publicCatalogPayload(response.data) });
      }
      if (method === "GET" && url.pathname === "/api/gatcha/pool-config") {
        response = await request("gatcha.pool_config_get", {}, "bulk");
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "GET" && url.pathname === "/api/gatcha/candidate") {
        response = await request("gatcha.candidate", {}, "bulk");
        return jsonResponse({ ok: true, data: publicSearchItem(response.data || {}) });
      }
      if (method === "POST" && ["/api/remote-identity/register", "/api/remote-identity/rename"].includes(url.pathname)) {
        const requestedName = String(body.name || "").trim();
        const rename = url.pathname.endsWith("/rename");
        if (rename && !(state.remoteState?.session_user_edit_version >= 1)) {
          return jsonResponse({ ok: false, code: "session_user_edit_unavailable", error: "此 Host 尚不支持保留点歌记录的改名，请先更新 Host。" }, 409);
        }
        response = await request(rename ? "session.rename" : "session.set_identity", rename ? {
          name: requestedName, user_id: body.user_id || state.identityUserId,
          expected_name: body.expected_name || state.identity,
        } : { name: requestedName });
        if (response.data?.state) publishState(response.data.state);
        // The state response may have lost to a newer broadcast. Resolve the
        // ID in the latest accepted roster rather than restoring an old name.
        const userId = rename ? body.user_id || state.identityUserId : "";
        const user = state.remoteState?.session_user_entries?.find(user => userId ? user.id === userId : user.name === String(response.data?.name || requestedName));
        state.identity = user?.name || String(response.data?.name || requestedName).trim();
        state.identityUserId = user?.id || userId;
        if (state.remoteState?.session_user_edit_version >= 1 && !user) { state.identity = ""; state.identityUserId = ""; }
        rememberIdentity();
        return jsonResponse({ ok: true, data: { registered: Boolean(state.identity), name: state.identity, user_id: state.identityUserId, session_id: identitySessionId() } });
      }
      if (method === "POST" && url.pathname === "/api/gatcha/pool-config") {
        response = await request("gatcha.pool_config_set", {
          uid_weight: Number(body.uid_weight ?? 50),
          favlist_weight: Number(body.favlist_weight ?? 50),
          excluded_uids: Array.isArray(body.excluded_uids) ? body.excluded_uids.map(String) : [],
          excluded_favlist_folders: Array.isArray(body.excluded_favlist_folders) ? body.excluded_favlist_folders.map(String) : [],
        });
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "POST" && url.pathname === "/api/gatcha/uids/preview") {
        response = await request("gatcha.uid_preview", { uid: String(body.uid || "") }, "bulk", 120_000);
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "POST" && url.pathname === "/api/gatcha/uids/add") {
        response = await request("gatcha.uid_add", { uid: String(body.uid || "") }, "bulk", 300_000);
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "POST" && url.pathname === "/api/gatcha/source/remove") {
        response = await request("gatcha.source_remove", {
          source: String(body.source || ""), id: String(body.id || ""),
        });
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "POST" && url.pathname === "/api/gatcha/refresh") {
        response = await request("gatcha.refresh", {}, "bulk", 30_000);
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "POST" && url.pathname === "/api/gatcha/favlist/preview") {
        response = await request("gatcha.favlist_preview", { uid: String(body.uid || "") }, "bulk", 120_000);
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "POST" && url.pathname === "/api/gatcha/favlist") {
        response = await request("gatcha.favlist_refresh", {
          uid: String(body.uid || ""),
          folder_ids: Array.isArray(body.folder_ids) ? body.folder_ids.map(String) : [],
          ...(body.folder_titles ? {folder_titles: body.folder_titles} : {}),
        }, "bulk", 300_000);
        return jsonResponse({ ok: true, data: response.data || {} });
      }
      if (method === "POST" && url.pathname === "/api/playlist/add") {
        response = await request("playlist.add", {
          catalog_item_id: catalogId(body.url, body.selected_video_page),
          position: body.position === "next" ? "next" : "tail",
          allow_repeat: Boolean(body.allow_repeat),
          selected_video_page: body.selected_video_page,
          selected_audio_pages: body.selected_audio_pages,
          expected_revision: expectedRevision(),
        }, "control", playlistAddRequestTimeoutMs);
      } else if (method === "POST" && url.pathname === "/api/playlist/reorder") {
        response = await request("playlist.move", { item_id: String(body.item_id || ""), target_index: Number(body.index || 0), expected_queue_version: body.expected_queue_version, expected_revision: expectedRevision() });
      } else if (method === "POST" && url.pathname === "/api/playlist/resort") {
        response = await request("playlist.resort", { expected_revision: expectedRevision() });
      } else if (method === "POST" && ["/api/playlist/remove", "/api/playlist/move-next", "/api/playlist/play-now"].includes(url.pathname)) {
        const kinds = {
          "/api/playlist/remove": "playlist.remove",
          "/api/playlist/move-next": "playlist.move_next",
          "/api/playlist/play-now": "playlist.play_now",
        };
        response = await request(kinds[url.pathname], { item_id: String(body.item_id || ""), expected_revision: expectedRevision() });
      } else if (method === "POST" && url.pathname === "/api/cache/retry") {
        response = await request("cache.retry", {
          force: Boolean(body.force),
          item_id: String(body.item_id || ""),
          expected_item_incarnation_id: String(body.expected_item_incarnation_id || ""),
          expected_revision: expectedRevision(),
        });
      } else if (method === "POST" && url.pathname === "/api/player/control") {
        const action = String(body.action || "");
        const kinds = {
          play: "playback.play",
          pause: "playback.pause",
          "toggle-play": "playback.toggle",
          "seek-relative": "playback.seek_relative",
          "seek-absolute": "playback.seek_absolute",
        };
        const payload = {
          item_id: String(body.item_id || ""),
          playback_generation: Number(body.playback_generation),
        };
        if (action === "seek-relative") payload.delta_seconds = Number(body.delta_seconds || 0);
        if (action === "seek-absolute") payload.target_seconds = Math.max(0, Math.round(Number(body.target_seconds || 0)));
        response = await request(kinds[action] || "playback.toggle", payload);
      } else if (method === "POST" && url.pathname === "/api/player/next") {
        response = await request("playback.next", {
          playback_generation: Number(body.playback_generation),
        });
      } else if (method === "POST" && url.pathname === "/api/player/key-shift") {
        response = await request("player.set_key_shift", { key_shift: Number(body.key_shift || 0) });
      } else if (method === "POST" && url.pathname === "/api/player/volume") {
        if (body.volume_percent !== undefined) await request("player.set_volume", {
          volume_percent: Number(body.volume_percent),
          ...(body.expected_item_incarnation_id === undefined ? {} : { expected_item_incarnation_id: body.expected_item_incarnation_id }),
        });
        if (body.is_muted !== undefined) response = await request("player.set_muted", { is_muted: Boolean(body.is_muted) });
        else response = await request("state.get", { since_revision: null }, "bulk");
      } else if (method === "POST" && url.pathname === "/api/player/av-delay-action") {
        response = await request("player.av_delay_action", body);
        return jsonResponse({ ok: true, data: localState(response.data).player_settings.av_delay });
      } else if (method === "POST" && url.pathname === "/api/player/audio-variant") {
        response = await request("player.set_audio_variant", {
          item_id: String(body.item_id || ""),
          variant_id: String(body.variant_id || ""),
          expected_item_incarnation_id: String(body.expected_item_incarnation_id || ""),
          expected_revision: expectedRevision(),
        });
      } else if (method === "POST" && url.pathname === "/api/rating/submit") {
        response = await request("rating.submit", { play_id: String(body.play_id || ""), score: Number(body.score || 0) });
        return jsonResponse({ ok: true, data: response.data });
      } else if (method === "POST" && ["/api/rating/log", "/api/client/disconnect"].includes(url.pathname)) {
        return jsonResponse({ ok: true, data: {} });
      } else {
        const error = operationFailure("internet_remote_unavailable");
        notifyOperation(error);
        return jsonResponse({ ok: false, code: "internet_remote_unavailable", error }, 501);
      }
      const next = response?.data?.state || response?.data;
      if (next?.revision !== undefined) publishState(next);
      return jsonResponse({ ok: true, stale: Boolean(response?.stale), data: localState(next) });
    } catch (error) {
      const code = String(error?.code || "internet_remote_request_failed");
      const status = code === "internet_remote_rate_limited" ? 429
        : code === "internet_remote_message_too_large" ? 413
          : code === "internet_remote_source_list_incomplete" ? 409 : 502;
      const failure = { ok: false, code, error: String(error?.message || error || "请求失败") };
      if (error?.completed === true) failure.completed = true;
      if (code === "manual_binding_required" && error?.payload?.binding) {
        failure.binding = error.payload.binding;
      }
      return jsonResponse(failure, status);
    } finally {
      releaseRevisionMutation?.();
    }
  }

  function createStateSource() {
    const handlers = new Map();
    const source = {
      addEventListener(type, callback) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(callback);
      },
      removeEventListener(type, callback) {
        handlers.get(type)?.delete(callback);
      },
      close() {
        listeners.delete(dispatch);
        handlers.clear();
      },
    };
    function dispatch(event) {
      for (const callback of handlers.get(event.type) || []) callback(event);
    }
    listeners.add(dispatch);
    queueMicrotask(() => {
      if (state.authorized && state.remoteState) dispatch({ type: "state", data: JSON.stringify(localState(state.remoteState)) });
      else dispatch({ type: "error" });
    });
    return source;
  }

  class InternetStateSource {
    constructor() {
      this.source = createStateSource();
    }

    addEventListener(type, callback) {
      this.source.addEventListener(type, callback);
    }

    removeEventListener(type, callback) {
      this.source.removeEventListener(type, callback);
    }

    close() {
      this.source.close();
    }
  }

  function fail(error) {
    state.connectButton && (state.connectButton.disabled = false);
    state.connectButton?.removeAttribute("aria-busy");
    setConnectionStatus(String(error?.message || error || "连接失败"), true);
  }

  function scheduleReconnect() {
    const wasAuthorized = state.authorized;
    stopHeartbeat();
    if (state.authorized) {
      state.authorized = false;
      global.dispatchEvent(new Event("remote-invitation-changed"));
      if (!state.readyResolve) state.readyPromise = null;
    }
    if (wasAuthorized) {
      for (const listener of [...listeners]) listener({ type: "error" });
    }
    if (!state.password || !navigator.onLine || state.reconnectTimer) return;
    ensureReadyPromise();
    if (state.reconnectAttempts >= 8) {
      state.overlay?.classList.remove("hidden");
      setConnectionStatus("无法自动恢复连接，请重新连接。", true);
      return;
    }
    const delay = Math.min(30_000, 800 * (2 ** state.reconnectAttempts));
    state.reconnectAttempts += 1;
    state.reconnectTimer = setTimeout(connectSignaling, delay);
  }

  function disconnect() {
    clearTimeout(state.reconnectTimer);
    stopHeartbeat();
    state.password = "";
    state.readyPromise = null;
    state.readyResolve = null;
    state.socket?.close(1000, "Remote closed");
    resetPeer();
  }

  async function ready() {
    ensureJoinOverlay();
    ensureReadyPromise();
    if (state.authorized) return;
    return state.readyPromise;
  }

  global.addEventListener("online", scheduleReconnect);
  global.addEventListener("offline", scheduleReconnect);
  global.addEventListener("pageshow", refreshHeartbeatAfterForeground);
  document.addEventListener("visibilitychange", refreshHeartbeatAfterForeground);
  document.documentElement.dataset.remoteTransport = "internet-pending";
  global.fetch = fetchInternet;
  global.EventSource = InternetStateSource;
  // Read-only sharing of the invitation already supplied to this client.
  // Never include the password in the URL or send invitation data to a QR service.
  function invitation() {
    const expires = Number(fragment.get("expires"));
    if (!state.authorized || !state.password || !Number.isFinite(expires)
      || expires <= Date.now()) return null;
    const url = new URL("/remote.html", global.location.origin);
    url.hash = new URLSearchParams({ room: roomId, join: joinToken, expires: String(expires) }).toString();
    return { url: url.href, password: state.password };
  }
  const invitationRemainingMs = Number(fragment.get("expires")) - Date.now();
  if (invitationRemainingMs > 0 && invitationRemainingMs <= 2_147_483_647) {
    setTimeout(() => global.dispatchEvent(new Event("remote-invitation-changed")), invitationRemainingMs);
  }
  global.BilikaraRemoteTransport = Object.freeze({
    mode: "internet",
    invitation,
    ready,
    localize,
    fetch: fetchInternet,
    createStateSource,
    disconnect,
    isSupported: () => Boolean(lowLevel && typeof RTCPeerConnection === "function"),
  });
})(globalThis);
