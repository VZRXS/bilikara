(function installInternetRemoteHost() {
  "use strict";

  const SIGNAL_ORIGIN = "https://rtc.kevinx96.icu";
  const transport = window.BilikaraInternetTransport;
  if (!transport) return;

  const diagnosticEvents = [];
  const DIAGNOSTIC_EVENT_LIMIT = 64;

  const peers = new Map();
  const state = {
    mode: "local",
    available: typeof RTCPeerConnection !== "undefined",
    busy: false,
    roomId: "",
    hostToken: "",
    joinToken: "",
    hostPeerId: "",
    expiresAt: 0,
    expired: false,
    password: "",
    remoteUrl: "",
    qrImage: "",
    socket: null,
    reconnectTimer: null,
    expiryTimer: null,
    stopped: true,
    stateRevision: 0,
    authFailures: [],
    catalogRequests: [],
    gatchaNetworkRequests: [],
    messages: {},
  };

  let elements = null;

  function diagnosticError(error) {
    const name = String(error?.name || "Error").slice(0, 64);
    const errorCode = name === "AbortError"
      ? "timeout"
      : name === "TypeError"
        ? "network_error"
        : name.replace(/[^A-Za-z0-9_.-]/gu, "_").toLowerCase() || "error";
    const errorMessage = String(error?.message || error || "unknown error")
      .replace(/https?:\/\/[^\s]+/giu, "[REDACTED_URL]")
      .replace(/[A-Za-z0-9_-]{20,}/gu, "[REDACTED_VALUE]")
      .replace(/[\r\n]+/gu, " ")
      .slice(0, 256);
    return { errorCode, errorMessage };
  }

  function pageOriginClass() {
    const protocol = String(window.location.protocol || "").toLowerCase();
    const hostname = String(window.location.hostname || "").toLowerCase();
    if (protocol === "tauri:" || hostname === "tauri.localhost") return "tauri";
    if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) return "loopback";
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(hostname)) return "lan";
    return "other";
  }

  function recordDiagnostic(stage, status, details = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      stage: String(stage || "unknown").slice(0, 64),
      status: String(status || "unknown").slice(0, 32),
      httpStatus: Number.isInteger(details.httpStatus) ? details.httpStatus : null,
      elapsedMs: Number.isFinite(details.elapsedMs) ? Math.max(0, Math.round(details.elapsedMs)) : null,
      peerCount: peers.size,
      originClass: pageOriginClass(),
      errorCode: details.errorCode ? String(details.errorCode).slice(0, 64) : null,
      errorMessage: details.errorMessage ? String(details.errorMessage).slice(0, 256) : null,
      operation: details.operation
        ? String(details.operation).replace(/[^a-z0-9._-]/giu, "_").slice(0, 64)
        : null,
      accepted: typeof details.accepted === "boolean" ? details.accepted : null,
      stale: typeof details.stale === "boolean" ? details.stale : null,
    };
    diagnosticEvents.push(event);
    if (diagnosticEvents.length > DIAGNOSTIC_EVENT_LIMIT) diagnosticEvents.shift();
  }

  window.BilikaraInternetRemoteDiagnostics = Object.freeze({
    getSnapshot() {
      return diagnosticEvents.map((event) => ({ ...event }));
    },
  });

  function tr(key, fallback, values = {}) {
    let message = state.messages[key] || fallback;
    for (const [name, value] of Object.entries(values)) {
      message = message.split(`{${name}}`).join(String(value));
    }
    return message;
  }

  function setStatus(message, tone = "") {
    elements.status.textContent = message;
    elements.dot.classList.toggle("is-active", tone === "good");
    elements.dot.classList.toggle("is-error", tone === "bad");
  }

  function publishInternetRemoteDisplay() {
    const online = state.mode === "internet";
    const active = Boolean(
      online
      && state.roomId
      && state.remoteUrl
      && state.qrImage
      && !state.expired,
    );
    const hint = !online
      ? tr("internetRemote.localHint", "同一局域网内直接扫码")
      : state.busy
        ? tr("internetRemote.creating", "创建中…")
        : state.expired
          ? tr("internetRemote.expired", "公网房间已过期，请重建房间")
          : active
            ? tr("internetRemote.expiry", "房间有效至 {time}", {
                time: new Date(state.expiresAt).toLocaleString(),
              })
            : tr("internetRemote.notCreated", "尚未创建房间");
    document.dispatchEvent(new CustomEvent("bilikara:internet-remote-display", {
      detail: {
        mode: online ? "internet" : "local",
        active,
        url: active ? state.remoteUrl : "",
        qr_image: active ? state.qrImage : "",
        password: active ? state.password : "",
        hint,
      },
    }));
  }

  function render() {
    const online = state.mode === "internet";
    elements.local.classList.toggle("is-active", !online);
    elements.internet.classList.toggle("is-active", online);
    elements.local.setAttribute("aria-pressed", String(!online));
    elements.internet.setAttribute("aria-pressed", String(online));
    elements.settings.classList.toggle("is-internet-mode", online);
    elements.localContent.classList.toggle("hidden", online);
    elements.internetContent.classList.toggle("hidden", !online);
    elements.summary.textContent = online
      ? tr("internetRemote.internet", "公网模式")
      : tr("internetRemote.local", "本地模式");
    elements.meta.textContent = online
      ? state.roomId
        ? tr("internetRemote.remoteCount", "{count} 台 Remote", { count: peers.size })
        : tr("internetRemote.notCreated", "尚未创建房间")
      : tr("internetRemote.localHint", "同一局域网内直接扫码");
    elements.restart.disabled = state.busy || !online || !state.available;
    elements.local.disabled = state.busy;
    elements.internet.disabled = state.busy || !state.available;
    elements.internet.toggleAttribute("aria-busy", state.busy);
    elements.password.disabled = state.busy || !online;
    elements.regenerate.disabled = state.busy || !online;
    elements.restart.toggleAttribute("aria-busy", state.busy);
    elements.restart.textContent = state.busy
      ? tr("internetRemote.creating", "创建中…")
      : state.roomId
        ? tr("internetRemote.rebuild", "重建公网房间")
        : tr("internetRemote.create", "创建公网房间");
    elements.room.classList.toggle("hidden", !online || !state.roomId);
    publishInternetRemoteDisplay();
  }

  async function localPost(path, body, timeoutMs = 15_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        const error = new Error(payload.error || `HTTP ${response.status}`);
        error.code = String(payload.code || `http_${response.status}`);
        error.httpStatus = response.status;
        error.payload = payload;
        throw error;
      }
      return payload.data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function signalUrl() {
    return `${SIGNAL_ORIGIN.replace(/^http/u, "ws")}/v1/rooms/${state.roomId}/socket`;
  }

  function releaseRoom(roomId, hostToken) {
    if (!/^[A-Za-z0-9_-]{27}$/u.test(roomId) || !/^[A-Za-z0-9_-]{43}$/u.test(hostToken)) {
      return Promise.resolve();
    }
    return fetch(`${SIGNAL_ORIGIN}/v1/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${hostToken}` },
      keepalive: true,
    }).then(() => undefined).catch(() => undefined);
  }

  function sanitizedManualBinding(value) {
    if (!value || typeof value !== "object" || !Array.isArray(value.pages)) return null;
    const pages = value.pages.slice(0, 256).flatMap((entry) => {
      const page = Number(entry?.page);
      const cid = Number(entry?.cid);
      const duration = Number(entry?.duration);
      if (!Number.isSafeInteger(page) || page <= 0
          || !Number.isSafeInteger(cid) || cid <= 0
          || !Number.isFinite(duration) || duration < 0) {
        return [];
      }
      return [{
        page,
        cid,
        duration,
        part: String(entry?.part || "").slice(0, 512),
      }];
    });
    if (!pages.length) return null;
    const requestedPreferredPage = Number(value.preferred_page);
    const preferredPage = pages.some((entry) => entry.page === requestedPreferredPage)
      ? requestedPreferredPage
      : pages[0].page;
    return {
      title: String(value.title || "").slice(0, 512),
      preferred_page: preferredPage,
      pages,
    };
  }

  function sendSignal(to, type, payload) {
    if (state.socket?.readyState !== WebSocket.OPEN) throw new Error("信令连接未就绪");
    state.socket.send(JSON.stringify({ to, type, payload }));
  }

  async function createPeer(peerId) {
    closePeer(peerId, false);
    const pc = new RTCPeerConnection(transport.iceConfiguration);
    const peer = {
      id: peerId,
      pc,
      control: null,
      bulk: null,
      decoders: { control: new transport.Decoder(), bulk: new transport.Decoder() },
      authorized: false,
      epoch: "",
      authFailures: [],
      messageTimes: [],
      requestTimes: [],
      catalogRequests: [],
      addRequests: [],
      gatchaNetworkRequests: [],
      queuedMessages: 0,
      deadlineTimer: null,
      queues: { control: Promise.resolve(), bulk: Promise.resolve() },
      outbound: { control: Promise.resolve(), bulk: Promise.resolve() },
      pendingState: null,
      stateSending: false,
    };
    peers.set(peerId, peer);
    peer.deadlineTimer = setTimeout(() => {
      if (!peer.authorized) {
        setStatus(tr("internetRemote.authTimeout", "Remote 连接或认证超时"), "bad");
        closePeer(peerId);
      }
    }, 20_000);
    wireChannel(peer, pc.createDataChannel("bilikara-control", { ordered: true }), "control");
    wireChannel(peer, pc.createDataChannel("bilikara-bulk", { ordered: true }), "bulk");
    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(pc.connectionState)) closePeer(peerId, true, peer);
      render();
    });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await transport.waitForIceGathering(pc);
      if (peers.get(peerId) !== peer) return;
      sendSignal(peerId, "offer", pc.localDescription);
      render();
    } catch (error) {
      if (peers.get(peerId) !== peer) return;
      closePeer(peerId, true, peer);
      throw error;
    }
  }

  function wireChannel(peer, channel, lane) {
    peer[lane] = channel;
    channel.addEventListener("message", (event) => {
      const now = Date.now();
      peer.messageTimes = recentFailures(peer.messageTimes, now);
      let messages;
      try { messages = peer.decoders[lane].consume(event.data); }
      catch (error) {
        setStatus(`Remote 消息被拒绝：${error.message}`, "bad");
        closePeer(peer.id, true, peer);
        return;
      }
      if (peer.messageTimes.length + messages.length > 180 || peer.queuedMessages + messages.length > 64) {
        setStatus("Remote 消息频率过高", "bad");
        closePeer(peer.id, true, peer);
        return;
      }
      peer.messageTimes.push(...messages.map(() => now));
      const queued = [];
      try {
        for (const message of messages) {
          if (lane === "control" && message?.type === "ping") {
            transport.send(peer.control, { type: "pong", at: message.at });
          } else {
            queued.push(message);
          }
        }
      } catch (error) {
        setStatus(`Remote 消息被拒绝：${error.message}`, "bad");
        closePeer(peer.id, true, peer);
        return;
      }
      if (!queued.length) return;
      peer.queuedMessages += queued.length;
      peer.queues[lane] = peer.queues[lane].then(async () => {
        try {
          for (const message of queued) await handlePeerMessage(peer, lane, message);
        } finally {
          peer.queuedMessages -= queued.length;
        }
      }).catch((error) => {
        setStatus(`Remote 消息被拒绝：${error.message}`, "bad");
        closePeer(peer.id);
      });
    });
    channel.addEventListener("open", () => {
      if (peer.control?.readyState === "open" && peer.bulk?.readyState === "open") {
        transport.send(peer.control, { type: "auth.required" });
      }
      render();
    });
    channel.addEventListener("close", () => {
      if (peers.get(peer.id) === peer && peer.pc.connectionState !== "connected") closePeer(peer.id);
    });
  }

  function recentFailures(values, now = Date.now()) {
    return values.filter((value) => now - value < 60_000);
  }

  function sendPeer(peer, lane, message) {
    const operation = peer.outbound[lane].then(async () => {
      if (peers.get(peer.id) !== peer || peer[lane]?.readyState !== "open") return;
      await transport.waitForBufferedAmount(peer[lane]);
      if (peers.get(peer.id) === peer && peer[lane]?.readyState === "open") {
        transport.send(peer[lane], message);
      }
    });
    peer.outbound[lane] = operation.catch(() => {});
    return operation;
  }

  function admitRequest(peer, kind, now = Date.now()) {
    peer.requestTimes = recentFailures(peer.requestTimes, now);
    if (peer.requestTimes.length >= 120) throw new Error("Remote 请求频率过高");
    peer.requestTimes.push(now);
    if ([
      "catalog.search",
      "catalog.browse",
      "catalog.category_browse",
      "catalog.song_detail",
      "gatcha.search",
      "gatcha.browse",
      "gatcha.favlist_browse",
      "gatcha.pool_config_get",
      "gatcha.candidate",
    ].includes(kind)) {
      peer.catalogRequests = recentFailures(peer.catalogRequests, now);
      state.catalogRequests = recentFailures(state.catalogRequests, now);
      if (peer.catalogRequests.length >= 12 || state.catalogRequests.length >= 60) {
        throw new Error("搜索过于频繁，请稍后再试");
      }
      peer.catalogRequests.push(now);
      state.catalogRequests.push(now);
    }
    if (kind === "playlist.add") {
      peer.addRequests = recentFailures(peer.addRequests, now);
      if (peer.addRequests.length >= 20) throw new Error("点歌过于频繁，请稍后再试");
      peer.addRequests.push(now);
    }
    if ([
      "gatcha.uid_preview",
      "gatcha.uid_add",
      "gatcha.refresh",
      "gatcha.favlist_preview",
      "gatcha.favlist_refresh",
    ].includes(kind)) {
      peer.gatchaNetworkRequests = peer.gatchaNetworkRequests.filter((value) => now - value < 600_000);
      state.gatchaNetworkRequests = state.gatchaNetworkRequests.filter((value) => now - value < 600_000);
      if (peer.gatchaNetworkRequests.length >= 6 || state.gatchaNetworkRequests.length >= 20) {
        throw new Error("Gatcha 请求过于频繁，请十分钟后再试");
      }
      peer.gatchaNetworkRequests.push(now);
      state.gatchaNetworkRequests.push(now);
    }
  }

  function queueState(peer, remoteState) {
    peer.pendingState = remoteState;
    if (peer.stateSending) return;
    peer.stateSending = true;
    void (async () => {
      try {
        while (peer.pendingState && peers.get(peer.id) === peer && peer.authorized) {
          const next = peer.pendingState;
          peer.pendingState = null;
          await sendPeer(peer, "bulk", { type: "state", data: next });
        }
      } catch (error) {
        setStatus(`Remote 发送失败：${error.message}`, "bad");
        closePeer(peer.id, true, peer);
      } finally {
        peer.stateSending = false;
      }
    })();
  }

  async function handlePeerMessage(peer, lane, message) {
    if (peers.get(peer.id) !== peer) return;
    if (!message || typeof message !== "object") throw new Error("消息格式无效");
    if (message.type === "ping") {
      transport.send(peer.control, { type: "pong", at: message.at });
      return;
    }
    if (message.type === "auth") {
      if (lane !== "control" || peer.authorized) throw new Error("认证状态无效");
      const now = Date.now();
      peer.authFailures = recentFailures(peer.authFailures, now);
      state.authFailures = recentFailures(state.authFailures, now);
      if (peer.authFailures.length >= 5 || state.authFailures.length >= 20) {
        transport.send(peer.control, { type: "auth.failed", reason: "too_many_attempts" });
        closePeer(peer.id);
        return;
      }
      const password = String(message.password || "");
      const epoch = String(message.epoch || "");
      if (!/^[A-Za-z0-9_-]{22}$/u.test(epoch) || !transport.constantTimeTextEqual(password, state.password)) {
        peer.authFailures.push(now);
        state.authFailures.push(now);
        transport.send(peer.control, { type: "auth.failed", reason: "wrong_password" });
        return;
      }
      await localPost("/api/internet-remote/peer/open", {
        peer_id: peer.id,
        epoch,
        profile: "controller",
      });
      peer.epoch = epoch;
      peer.authorized = true;
      clearTimeout(peer.deadlineTimer);
      peer.deadlineTimer = null;
      await sendPeer(peer, "control", { type: "auth.ok" });
      await publishState(peer);
      setStatus(tr("internetRemote.running", "公网房间运行中"), "good");
      return;
    }
    if (!peer.authorized || message.type !== "request" || message.lane !== lane) {
      throw new Error("Remote 尚未认证或通道不匹配");
    }
    const operation = String(message.envelope?.kind || "unknown");
    const dispatchStartedAt = performance.now();
    recordDiagnostic("request.dispatch", "started", { operation });
    try {
      admitRequest(peer, operation);
    } catch (error) {
      recordDiagnostic("request.dispatch", "completed", {
        operation,
        accepted: false,
        stale: false,
        errorCode: "internet_remote_rate_limited",
        elapsedMs: performance.now() - dispatchStartedAt,
      });
      await sendPeer(peer, lane, {
        type: "response",
        request_id: String(message.envelope?.id || ""),
        sequence: Number(message.envelope?.seq || 0),
        accepted: false,
        stale: false,
        code: "internet_remote_rate_limited",
        error: error.message,
      });
      return;
    }
    let result;
    try {
      result = await localPost("/api/internet-remote/dispatch", {
        peer_id: peer.id,
        lane,
        message: JSON.stringify(message.envelope),
      }, 300_000);
    } catch (error) {
      if (isFatalProtocolError(error.code)) {
        recordDiagnostic("request.dispatch", "completed", {
          operation,
          accepted: false,
          stale: false,
          errorCode: String(error.code),
          elapsedMs: performance.now() - dispatchStartedAt,
        });
        throw error;
      }
      recordDiagnostic("request.dispatch", "completed", {
        operation,
        accepted: false,
        stale: false,
        errorCode: String(error.code || "internet_remote_request_failed"),
        elapsedMs: performance.now() - dispatchStartedAt,
      });
      await sendPeer(peer, lane, {
        type: "response",
        request_id: String(message.envelope?.id || ""),
        sequence: Number(message.envelope?.seq || 0),
        accepted: false,
        stale: false,
        code: String(error.code || "internet_remote_request_failed"),
        error: String(error.message || "请求失败").slice(0, 256),
        binding: sanitizedManualBinding(error.payload?.binding),
      });
      return;
    }
    recordDiagnostic("request.dispatch", "completed", {
      operation,
      accepted: result?.accepted !== false,
      stale: Boolean(result?.stale),
      elapsedMs: performance.now() - dispatchStartedAt,
    });
    await sendPeer(peer, lane, { type: "response", ...result });
    if (result?.data?.revision || result?.data?.state?.revision) void publishState();
  }

  async function publishState(target = null) {
    const response = await fetch("/api/internet-remote/state", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) return;
    const remoteState = payload.data;
    const nextRevision = Number(remoteState.state_revision || 0);
    if (!target && nextRevision <= state.stateRevision) return;
    state.stateRevision = Math.max(state.stateRevision, nextRevision);
    const targets = target ? [target] : [...peers.values()];
    for (const peer of targets) {
      if (peer.authorized && peer.bulk?.readyState === "open") {
        queueState(peer, remoteState);
      }
    }
  }

  function closePeer(peerId, evictSignal = true, expectedPeer = null) {
    const peer = peers.get(peerId);
    if (!peer || (expectedPeer && peer !== expectedPeer)) return;
    peers.delete(peerId);
    clearTimeout(peer.deadlineTimer);
    if (evictSignal && state.socket?.readyState === WebSocket.OPEN) {
      try { sendSignal(peerId, "leave", {}); } catch { /* signaling is best effort */ }
    }
    peer.control?.close();
    peer.bulk?.close();
    peer.pc.close();
    if (peer.authorized) {
      localPost("/api/internet-remote/peer/close", { peer_id: peerId }).catch(() => {});
    }
    render();
  }

  function connectSignaling() {
    if (state.stopped || !state.roomId) return;
    recordDiagnostic("signaling.connect", "started");
    const socket = new WebSocket(signalUrl(), [
      "bilikara-v1",
      `host.${state.hostToken}.${state.hostPeerId}`,
    ]);
    state.socket = socket;
    socket.addEventListener("open", () => {
      recordDiagnostic("signaling.connect", "connected");
      setStatus(tr("internetRemote.waiting", "等待 Remote 加入"), "good");
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "peer.join" && typeof message.peer_id === "string") {
        createPeer(message.peer_id).catch((error) => setStatus(error.message, "bad"));
      } else if (message.type === "answer" && typeof message.from === "string") {
        const peer = peers.get(message.from);
        if (peer) peer.pc.setRemoteDescription(message.payload).catch(() => closePeer(message.from));
      }
    });
    socket.addEventListener("close", (event) => {
      recordDiagnostic("signaling.connect", "closed", {
        errorCode: event.code === 1000 ? null : `websocket_${event.code}`,
      });
      if (state.socket === socket) state.socket = null;
      if (!state.stopped && event.code !== 4003) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(connectSignaling, 1500);
      } else if (!state.stopped) {
        expireRoom();
      }
    });
    socket.addEventListener("error", () => {
      recordDiagnostic("signaling.connect", "error", { errorCode: "websocket_error" });
      setStatus(tr("internetRemote.signalingRetry", "信令暂时不可用，正在重连"), "bad");
    });
  }

  function isFatalProtocolError(code) {
    return [
      "invalid_internet_remote_peer_id",
      "invalid_internet_remote_epoch",
      "unknown_internet_remote_peer",
      "internet_remote_message_too_large",
      "malformed_internet_remote_envelope",
      "unsupported_internet_remote_version",
      "invalid_internet_remote_lane",
      "stale_internet_remote_epoch",
      "invalid_internet_remote_sequence",
      "replayed_internet_remote_sequence",
      "invalid_internet_remote_request_id",
      "unknown_internet_remote_request",
      "invalid_internet_remote_request",
      "internet_remote_capability_denied",
    ].includes(String(code || ""));
  }

  async function startRoom() {
    if (state.busy || !state.available) return;
    const password = elements.password.value.trim();
    if (password.length < 4 || password.length > 32) {
      setStatus(tr("internetRemote.passwordInvalid", "房间密码需为 4–32 个字符"), "bad");
      return;
    }
    state.busy = true;
    render();
    await stopRoom(false);
    state.mode = "internet";
    state.password = password;
    state.hostToken = transport.randomBase64Url(32);
    state.joinToken = transport.randomBase64Url(32);
    state.hostPeerId = transport.randomBase64Url(16);
    const startedAt = performance.now();
    recordDiagnostic("room.create", "started");
    try {
      const response = await fetch(`${SIGNAL_ORIGIN}/v1/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host_token_hash: await transport.sha256(state.hostToken),
          join_token_hash: await transport.sha256(state.joinToken),
        }),
      });
      recordDiagnostic("room.create", "response", {
        httpStatus: response.status,
        elapsedMs: performance.now() - startedAt,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error === "room_capacity_reached"
          ? tr("internetRemote.capacityReached", "公网房间已达临时上限（10 间），请稍后再试。")
          : payload.error || `HTTP ${response.status}`);
      }
      const createdAt = Number(payload.created_at);
      const expiresAt = Number(payload.expires_at);
      const workerLifetime = expiresAt - createdAt;
      if (
        !/^[A-Za-z0-9_-]{27}$/u.test(String(payload.room_id || ""))
        || !Number.isSafeInteger(createdAt)
        || !Number.isSafeInteger(expiresAt)
        || workerLifetime < 60_000
        || workerLifetime > (8 * 60 * 60 * 1000) + 5_000
      ) throw new Error("invalid signaling response");
      state.roomId = payload.room_id;
      state.expiresAt = expiresAt;
      state.expired = false;
      state.stopped = false;
      const remoteUrl = `${SIGNAL_ORIGIN}/remote.html#room=${encodeURIComponent(state.roomId)}&join=${encodeURIComponent(state.joinToken)}&expires=${encodeURIComponent(state.expiresAt)}`;
      elements.url.href = remoteUrl;
      elements.url.textContent = remoteUrl;
      const qr = await localPost("/api/internet-remote/qr", { url: remoteUrl });
      state.remoteUrl = remoteUrl;
      state.qrImage = String(qr.image || "");
      elements.qr.src = qr.image;
      elements.expiry.textContent = tr("internetRemote.expiry", "房间有效至 {time}", {
        time: new Date(state.expiresAt).toLocaleString(),
      });
      state.expiryTimer = setTimeout(expireRoom, workerLifetime + 1_000);
      recordDiagnostic("room.create", "created", {
        httpStatus: response.status,
        elapsedMs: performance.now() - startedAt,
      });
      connectSignaling();
    } catch (error) {
      const failure = diagnosticError(error);
      recordDiagnostic("room.create", "failed", {
        ...failure,
        elapsedMs: performance.now() - startedAt,
      });
      void stopRoom(false);
      setStatus(tr("internetRemote.createFailed", "创建失败：{error}", {
        error: failure.errorMessage,
      }), "bad");
    } finally {
      state.busy = false;
      render();
    }
  }

  function expireRoom() {
    if (!state.roomId || state.expired) return;
    state.expired = true;
    state.stopped = true;
    clearTimeout(state.reconnectTimer);
    state.socket?.close(1000, "room expired");
    state.socket = null;
    for (const peerId of [...peers.keys()]) closePeer(peerId);
    setStatus(tr("internetRemote.expired", "公网房间已过期，请重建房间"), "bad");
    render();
  }

  function stopRoom(resetMode = true) {
    const roomId = state.roomId;
    const hostToken = state.hostToken;
    state.stopped = true;
    clearTimeout(state.reconnectTimer);
    clearTimeout(state.expiryTimer);
    state.reconnectTimer = null;
    state.expiryTimer = null;
    state.socket?.close(1000, "Host stopped Internet Remote");
    state.socket = null;
    for (const peerId of [...peers.keys()]) closePeer(peerId);
    state.roomId = "";
    state.hostToken = "";
    state.joinToken = "";
    state.hostPeerId = "";
    state.expiresAt = 0;
    state.expired = false;
    state.password = "";
    state.remoteUrl = "";
    state.qrImage = "";
    if (resetMode) state.mode = "local";
    setStatus(state.mode === "local"
      ? tr("internetRemote.localStatus", "本地 Remote 保持可用")
      : tr("internetRemote.notCreated", "尚未创建公网房间"));
    render();
    return releaseRoom(roomId, hostToken);
  }

  function initialize() {
    elements = {
      settings: document.getElementById("remote-mini-control"),
      toggle: document.getElementById("remote-mini-trigger"),
      panel: document.getElementById("remote-mini-popover"),
      local: document.getElementById("internet-remote-local-mode"),
      internet: document.getElementById("internet-remote-internet-mode"),
      localContent: document.getElementById("internet-remote-local-content"),
      internetContent: document.getElementById("internet-remote-internet-content"),
      summary: document.getElementById("internet-remote-summary"),
      meta: document.getElementById("internet-remote-meta"),
      dot: document.getElementById("internet-remote-state-dot"),
      password: document.getElementById("internet-remote-password"),
      regenerate: document.getElementById("internet-remote-regenerate"),
      restart: document.getElementById("internet-remote-restart"),
      room: document.getElementById("internet-remote-room"),
      qr: document.getElementById("internet-remote-qr"),
      url: document.getElementById("internet-remote-url"),
      expiry: document.getElementById("internet-remote-expiry"),
      status: document.getElementById("internet-remote-status"),
    };
    if (Object.values(elements).some((element) => !element)) return;
    elements.password.value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    elements.local.addEventListener("click", () => void stopRoom(true));
    elements.internet.addEventListener("click", () => {
      state.mode = "internet";
      render();
      if (!state.roomId) void startRoom();
    });
    elements.restart.addEventListener("click", () => void startRoom());
    elements.regenerate.addEventListener("click", () => {
      elements.password.value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    });
    const events = new EventSource("/api/events");
    events.addEventListener("state", () => {
      if (state.mode === "internet") void publishState();
    });
    window.addEventListener("beforeunload", () => void stopRoom(false));
    setStatus(state.available
      ? tr("internetRemote.localStatus", "本地 Remote 保持可用")
      : tr("internetRemote.unavailable", "当前浏览器不支持 WebRTC"), state.available ? "" : "bad");
    render();
  }

  document.addEventListener("bilikara:i18n", (event) => {
    if (event.detail?.messages && typeof event.detail.messages === "object") {
      state.messages = event.detail.messages;
      if (elements) {
        setStatus(state.available
          ? state.mode === "local"
            ? tr("internetRemote.localStatus", "本地 Remote 保持可用")
            : state.expired
              ? tr("internetRemote.expired", "公网房间已过期，请重建房间")
              : state.roomId
              ? tr("internetRemote.running", "公网房间运行中")
              : tr("internetRemote.notCreated", "尚未创建公网房间")
          : tr("internetRemote.unavailable", "当前浏览器不支持 WebRTC"), state.available ? "" : "bad");
        render();
      }
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
})();
