(function installBilikaraRemoteTransport(global) {
  "use strict";

  const nativeFetch = global.fetch.bind(global);
  const fragment = new URLSearchParams(global.location.hash.slice(1));
  const roomId = fragment.get("room") || "";
  const joinToken = fragment.get("join") || "";
  const internetMode = Boolean(roomId || joinToken);
  const lowLevel = global.BilikaraInternetTransport;
  const identityStorageKey = "bilikara.internetRemote.identity.v1";
  const endpointStorageKey = "bilikara.internetRemote.endpoint.v1";

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
    control: null,
    bulk: null,
    decoders: null,
    epoch: "",
    sequences: { control: 0, bulk: 0 },
    pending: new Map(),
    remoteState: null,
    identity: localStorage.getItem(identityStorageKey) || "",
    password: "",
    authorized: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    disconnectedTimer: null,
    heartbeatTimer: null,
    lastPongAt: 0,
    readyPromise: null,
    readyResolve: null,
    overlay: null,
    status: null,
    error: null,
    identityInput: null,
    passwordInput: null,
    connectButton: null,
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

  function setConnectionStatus(message, isError = false) {
    if (state.status) state.status.textContent = message || "";
    if (state.error) {
      state.error.textContent = isError ? message || "" : "";
      state.error.classList.toggle("hidden", !isError);
    }
  }

  function ensureJoinOverlay() {
    if (state.overlay) return;
    const overlay = document.createElement("div");
    overlay.className = "internet-remote-join-overlay";
    overlay.innerHTML = `
      <form class="internet-remote-join-card">
        <p class="panel-tag">INTERNET REMOTE</p>
        <h1>连接 bilikara 房间</h1>
        <p class="internet-remote-join-copy">使用 Host 显示的房间密码连接。连接后将使用与本地 Remote 相同的界面。</p>
        <label>我的 ID<input name="identity" type="text" maxlength="24" autocomplete="nickname" required></label>
        <label>房间密码<input name="password" type="password" minlength="4" maxlength="32" autocomplete="current-password" required></label>
        <p class="internet-remote-join-status" role="status"></p>
        <p class="internet-remote-join-error hidden" role="alert"></p>
        <button type="submit" class="primary-button">连接</button>
      </form>`;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.status = overlay.querySelector(".internet-remote-join-status");
    state.error = overlay.querySelector(".internet-remote-join-error");
    state.identityInput = overlay.querySelector('input[name="identity"]');
    state.passwordInput = overlay.querySelector('input[name="password"]');
    state.connectButton = overlay.querySelector('button[type="submit"]');
    state.identityInput.value = state.identity;
    overlay.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const identity = String(state.identityInput.value || "").trim();
      const password = String(state.passwordInput.value || "");
      if (!identity || password.length < 4 || password.length > 32) {
        setConnectionStatus("请输入 ID 和 4–32 位房间密码。", true);
        return;
      }
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
    state.authorized = false;
    if (wasAuthorized) {
      state.readyPromise = null;
      state.readyResolve = null;
    }
    state.control?.close();
    state.bulk?.close();
    state.peer?.close();
    state.peer = null;
    state.control = null;
    state.bulk = null;
    state.epoch = lowLevel.randomBase64Url(16);
    state.sequences = { control: 0, bulk: 0 };
    state.decoders = { control: new lowLevel.Decoder(), bulk: new lowLevel.Decoder() };
    for (const pending of state.pending.values()) pending.reject(new Error("连接已重置"));
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
    setConnectionStatus("正在连接…");
    const socket = new WebSocket(signalingUrl(), ["bilikara-v1", `remote.${joinToken}.${peerId}`]);
    state.socket = socket;
    socket.addEventListener("open", () => setConnectionStatus("等待 Host…"));
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "offer" && message.from) acceptOffer(message.payload).catch(fail);
      else if (message.type === "host.leave" && !state.authorized) setConnectionStatus("Host 不在线。", true);
    });
    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      state.socket = null;
      if (!state.authorized && state.password) scheduleReconnect();
    });
    socket.addEventListener("error", () => setConnectionStatus("信令暂时不可用。", true));
  }

  async function acceptOffer(description) {
    resetPeer();
    const peer = new RTCPeerConnection(lowLevel.iceConfiguration);
    state.peer = peer;
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
    await peer.setRemoteDescription(description);
    await peer.setLocalDescription(await peer.createAnswer());
    await lowLevel.waitForIceGathering(peer);
    if (state.peer === peer) sendSignal("answer", peer.localDescription);
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
      state.lastPongAt = Date.now();
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
      state.reconnectAttempts = 0;
      state.lastPongAt = Date.now();
      request("session.set_identity", { name: state.identity }).then((response) => {
        const next = response?.data?.state;
        if (next) publishState(next);
        state.overlay.classList.add("hidden");
        document.documentElement.dataset.remoteTransport = "internet";
        state.connectButton.disabled = false;
        state.connectButton.removeAttribute("aria-busy");
        state.readyResolve?.();
      }).catch(fail);
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = setInterval(() => {
        if (Date.now() - state.lastPongAt > 8_000) {
          scheduleReconnect();
          return;
        }
        if (state.control?.readyState === "open") {
          lowLevel.send(state.control, { type: "ping", at: Date.now() });
        }
      }, 2_000);
      setTimeout(() => state.socket?.close(1000, "WebRTC connected"), 1_000);
      return;
    }
    if (message.type === "state") {
      publishState(message.data);
      return;
    }
    if (message.type === "response") {
      const pending = state.pending.get(message.request_id);
      if (pending) {
        state.pending.delete(message.request_id);
        clearTimeout(pending.timeout);
        pending.resolve(message);
      }
      if (message.stale && message.data) publishState(message.data);
    }
  }

  function request(kind, body, lane = "control") {
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
    lowLevel.send(state[lane], { type: "request", lane, envelope });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error("Host 响应超时"));
      }, 15_000);
      state.pending.set(id, { resolve, reject, timeout });
    });
  }

  function expectedRevision() {
    return Number(state.remoteState?.revision || 0);
  }

  function itemUrl(item) {
    const page = Number(item?.page || 1);
    return item?.bvid ? `https://www.bilibili.com/video/${item.bvid}${page > 1 ? `?p=${page}` : ""}` : "";
  }

  function localItem(item) {
    if (!item || typeof item !== "object") return null;
    const projectedVariants = Array.isArray(item.audio_variants) ? item.audio_variants : [];
    const variants = projectedVariants.length ? projectedVariants : [{
      id: String(item.selected_audio_variant_id || "main"),
      label: "Main",
    }];
    const pages = variants.map((variant, index) => Number(String(variant.id || "").match(/^p(\d+)/u)?.[1] || index + 1));
    return {
      ...item,
      original_url: itemUrl(item),
      resolved_url: itemUrl(item),
      item_incarnation_id: item.id,
      video_media_url: "internet-remote://video",
      selected_pages: pages.length ? pages : [Number(item.page || 1)],
      available_pages: pages.length ? pages : [Number(item.page || 1)],
      selected_parts: variants.map((variant) => variant.label),
      available_parts: variants.map((variant) => variant.label),
      audio_variants: variants.map((variant) => ({
        ...variant,
        audio_url: `internet-remote://audio/${encodeURIComponent(variant.id || "main")}`,
      })),
    };
  }

  function localState(remoteState) {
    if (!remoteState || typeof remoteState !== "object") return remoteState;
    const status = remoteState.player_status;
    const current = localItem(remoteState.current_item);
    return {
      schema_version: 1,
      state_revision: Number(remoteState.revision || 0),
      session_generation: Number(remoteState.session_generation || 0),
      playback_generation: Number(remoteState.playback_generation || 0),
      playback_mode: remoteState.playback_mode || "local",
      current_item: current,
      playlist: (remoteState.playlist || []).map(localItem).filter(Boolean),
      history: [],
      session_history: [],
      session_played: [],
      session_users: Array.isArray(remoteState.session_users) ? remoteState.session_users : [],
      remote_session_id: `internet-${roomId}`,
      player_settings: {
        av_offset_ms: Number(remoteState.player_settings?.effective_av_delay_ms || 0),
        av_delay: {
          effective_delay_ms: Number(remoteState.player_settings?.effective_av_delay_ms || 0),
          locked: Boolean(remoteState.player_settings?.av_delay_locked),
          lock_button_enabled: true,
          has_local_adjustment: true,
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
      gatcha: { busy: false },
    };
  }

  function publishState(next) {
    if (!next || typeof next !== "object") return;
    state.remoteState = next;
    const data = JSON.stringify(localState(next));
    for (const listener of listeners) listener({ type: "state", data });
  }

  function catalogId(value, selectedPage) {
    const text = String(value || "").trim();
    const match = text.match(/(BV[0-9A-Za-z]{10})/u);
    if (!match) throw new Error("公网 Remote 仅接受 BV 号或 Bilibili 视频链接");
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
    try {
      let response;
      if (method === "GET" && url.pathname === "/api/remote-identity") {
        return jsonResponse({ ok: true, data: { registered: state.authorized, name: state.identity, session_id: `internet-${roomId}` } });
      }
      if (method === "GET" && url.pathname === "/api/state") {
        response = await request("state.get", { since_revision: null }, "bulk");
        return jsonResponse({ ok: true, data: localState(response.data) });
      }
      if (method === "GET" && ["/api/lark/search", "/api/gatcha/search"].includes(url.pathname)) {
        response = await request("catalog.search", { query: url.searchParams.get("q") || "", limit: Math.min(80, Number(url.searchParams.get("limit") || 80)) }, "bulk");
        return jsonResponse({ ok: true, data: { items: (response.data?.items || []).map(publicSearchItem) } });
      }
      if (method === "POST" && ["/api/remote-identity/register", "/api/remote-identity/rename"].includes(url.pathname)) {
        response = await request("session.set_identity", { name: String(body.name || "").trim() });
        state.identity = String(response.data?.name || body.name || "").trim();
        localStorage.setItem(identityStorageKey, state.identity);
        if (response.data?.state) publishState(response.data.state);
        return jsonResponse({ ok: true, data: { registered: true, name: state.identity, session_id: `internet-${roomId}` } });
      }
      if (method === "POST" && url.pathname === "/api/playlist/add") {
        response = await request("playlist.add", {
          catalog_item_id: catalogId(body.url, body.selected_video_page),
          position: body.position === "next" ? "next" : "tail",
          allow_repeat: Boolean(body.allow_repeat),
          expected_revision: expectedRevision(),
        });
      } else if (method === "POST" && url.pathname === "/api/playlist/reorder") {
        response = await request("playlist.move", { item_id: String(body.item_id || ""), target_index: Number(body.index || 0), expected_revision: expectedRevision() });
      } else if (method === "POST" && url.pathname === "/api/playlist/resort") {
        response = await request("playlist.resort", { expected_revision: expectedRevision() });
      } else if (method === "POST" && ["/api/playlist/remove", "/api/playlist/move-next", "/api/playlist/play-now", "/api/cache/retry"].includes(url.pathname)) {
        const kinds = {
          "/api/playlist/remove": "playlist.remove",
          "/api/playlist/move-next": "playlist.move_next",
          "/api/playlist/play-now": "playlist.play_now",
          "/api/cache/retry": "cache.retry",
        };
        response = await request(kinds[url.pathname], { item_id: String(body.item_id || ""), expected_revision: expectedRevision() });
      } else if (method === "POST" && url.pathname === "/api/player/control") {
        const action = String(body.action || "");
        response = await request(action === "seek-relative" ? "playback.seek_relative" : "playback.toggle", action === "seek-relative" ? { delta_seconds: Number(body.delta_seconds || 0) } : {});
      } else if (method === "POST" && url.pathname === "/api/player/next") {
        response = await request("playback.next", {});
      } else if (method === "POST" && url.pathname === "/api/player/key-shift") {
        response = await request("player.set_key_shift", { key_shift: Number(body.key_shift || 0) });
      } else if (method === "POST" && url.pathname === "/api/player/volume") {
        if (body.volume_percent !== undefined) await request("player.set_volume", { volume_percent: Number(body.volume_percent) });
        if (body.is_muted !== undefined) response = await request("player.set_muted", { is_muted: Boolean(body.is_muted) });
        else response = await request("state.get", { since_revision: null }, "bulk");
      } else if (method === "POST" && url.pathname === "/api/player/av-delay-action") {
        const current = Number(state.remoteState?.player_settings?.effective_av_delay_ms || 0);
        const effective = body.type === "adjust" ? current + Number(body.delta_ms || 0) : body.type === "reset_local" ? 0 : Number(body.effective_delay_ms ?? current);
        response = await request("player.set_av_delay", { effective_delay_ms: Math.max(-5000, Math.min(5000, Math.round(effective))) });
        return jsonResponse({ ok: true, data: localState(response.data).player_settings.av_delay });
      } else if (method === "POST" && url.pathname === "/api/player/audio-variant") {
        response = await request("player.set_audio_variant", { item_id: String(body.item_id || ""), variant_id: String(body.variant_id || ""), expected_revision: expectedRevision() });
      } else if (method === "POST" && url.pathname === "/api/rating/submit") {
        response = await request("rating.submit", { play_id: String(body.play_id || ""), score: Number(body.score || 0) });
        return jsonResponse({ ok: true, data: response.data });
      } else if (method === "POST" && ["/api/rating/log", "/api/client/disconnect"].includes(url.pathname)) {
        return jsonResponse({ ok: true, data: {} });
      } else {
        return jsonResponse({ ok: false, code: "internet_remote_unavailable", error: "此功能暂不通过公网 Remote 开放" }, 501);
      }
      const next = response?.data?.state || response?.data;
      if (next?.revision !== undefined) publishState(next);
      return jsonResponse({ ok: true, stale: Boolean(response?.stale), data: localState(next) });
    } catch (error) {
      return jsonResponse({ ok: false, code: "internet_remote_request_failed", error: String(error?.message || error || "请求失败") }, 502);
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
    if (state.remoteState) queueMicrotask(() => dispatch({ type: "state", data: JSON.stringify(localState(state.remoteState)) }));
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
    if (!state.password || !navigator.onLine || state.reconnectTimer) return;
    if (state.authorized) {
      state.authorized = false;
      state.readyPromise = null;
      state.readyResolve = null;
    }
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
    clearInterval(state.heartbeatTimer);
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
  document.documentElement.dataset.remoteTransport = "internet-pending";
  global.fetch = fetchInternet;
  global.EventSource = InternetStateSource;
  global.BilikaraRemoteTransport = Object.freeze({
    mode: "internet",
    ready,
    fetch: fetchInternet,
    createStateSource,
    disconnect,
    isSupported: () => Boolean(lowLevel && typeof RTCPeerConnection === "function"),
  });
})(globalThis);
