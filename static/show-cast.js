(() => {
  "use strict";

  const busyPhases = new Set(["connecting", "stopping"]);
  const deviceRows = new Map();
  let adapter = null;
  let enabled = false;
  let pending = null;
  let hudSent = "";
  let hudInFlight = false;
  let hudSession = 0;

  const view = () => adapter?.snapshot()?.show_cast || {};
  const busy = () => pending !== null || busyPhases.has(view().phase);
  const element = (name) => document.getElementById(name);
  const say = (key, args) => adapter.translate("cast." + key, args);

  function setBusy(button, value) {
    if (value) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }

  function failureLabel(code) {
    if (code === "CAST_NO_MEDIA_REQUEST") return say("noMediaRequest");
    return say(["DLL_NOT_FOUND", "DLL_LOAD_FAILED", "SYMBOL_NOT_FOUND", "BACKEND_UNAVAILABLE"].includes(code)
      ? "componentMissing" : "failed");
  }

  function render() {
    const section = element("show-cast-section");
    if (!section || !adapter) return;
    const cast = view();
    section.hidden = !cast.supported;
    if (section.hidden) return;
    const connected = cast.owns_playback === true;
    const discovering = cast.phase === "discovering";
    const expanded = enabled || connected || discovering || cast.phase === "connecting";
    const blocked = busy() || adapter.physicalBusy();
    const toggle = element("show-cast-switch");
    const refresh = element("show-cast-refresh");
    const status = element("show-cast-status");
    const targets = element("show-cast-targets");
    const devices = Array.isArray(cast.renderers) ? cast.renderers : [];
    const selected = devices.find((device) => device.id === cast.selected_renderer_id);
    const statusText = !cast.available ? say("componentMissing")
      : cast.phase === "error" ? failureLabel(cast.error_code)
      : discovering ? say("discovering")
      : cast.phase === "connecting" ? say("connecting")
      : cast.phase === "stopping" ? say("disconnecting")
      : connected ? say("connectedTo", { name: selected?.name || say("title") })
      : expanded ? say(devices.length ? "choose" : "none") : say("off");
    if (status.textContent !== statusText) status.textContent = statusText;
    toggle.disabled = !cast.available || blocked;
    toggle.setAttribute("aria-checked", String(expanded));
    setBusy(toggle, pending === toggle || busyPhases.has(cast.phase));
    targets.hidden = !expanded || !cast.available;
    refresh.disabled = blocked || connected || discovering;
    refresh.classList.toggle("is-loading", discovering);
    setBusy(refresh, discovering || pending === refresh);

    const list = element("show-cast-devices");
    const ids = new Set(devices.map((device) => device.id));
    for (const [id, row] of deviceRows) {
      if (!ids.has(id)) {
        row.remove();
        deviceRows.delete(id);
      }
    }
    let next = list.firstElementChild;
    for (const device of devices) {
      let row = deviceRows.get(device.id);
      if (!row) {
        row = document.createElement("button");
        row.type = "button";
        row.className = "presentation-display-option show-cast-device";
        row.dataset.castDeviceId = device.id;
        const copy = document.createElement("span");
        copy.className = "presentation-display-copy";
        const name = document.createElement("span");
        name.className = "presentation-display-name";
        copy.append(name);
        const label = document.createElement("span");
        label.className = "presentation-display-state";
        row.append(adapter.deviceIcon(), copy, label);
        deviceRows.set(device.id, row);
      }
      if (row === next) next = next.nextElementSibling;
      else list.insertBefore(row, next);
      const name = row.querySelector(".presentation-display-name");
      if (name.textContent !== device.name) name.textContent = device.name;
      const selected = device.id === cast.selected_renderer_id;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-pressed", String(selected));
      row.disabled = blocked;
      setBusy(row, pending === row || (selected && busyPhases.has(cast.phase)));
      const label = row.querySelector(".presentation-display-state");
      const labelText = selected ? say(connected ? "disconnect" : "connecting") : "";
      if (label.textContent !== labelText) label.textContent = labelText;
    }
  }

  async function post(operation, payload = {}) {
    return adapter.post("/api/show-cast/" + operation, payload);
  }

  async function disconnect() {
    const cast = view();
    const stopping = () => view().owns_playback || view().phase === "discovering" || busyPhases.has(view().phase);
    if (!stopping()) return;
    if (cast.phase !== "stopping") await post("disconnect");
    const deadline = Date.now() + 45_000;
    let refreshAt = Date.now() + 1_200;
    while (stopping()) {
      if (Date.now() >= deadline) throw new Error(say("stopTimeout"));
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (Date.now() >= refreshAt) {
        refreshAt = Date.now() + 1_200;
        await adapter.refresh().catch(() => {});
      }
    }
  }

  async function stopForPresentation() {
    await disconnect();
    enabled = false;
    render();
  }

  async function perform(button, action) {
    if (button.disabled || busy() || adapter.physicalBusy() || !view().available) return;
    pending = button;
    adapter.update();
    try {
      await action();
    } catch (error) {
      adapter.error(error?.message || say("failed"));
    } finally {
      pending = null;
      adapter.update();
    }
  }

  function install(options) {
    adapter = options;
    element("show-cast-switch")?.addEventListener("click", (event) => perform(event.currentTarget, async () => {
      if (enabled || view().owns_playback || view().phase === "discovering") {
        await disconnect();
        enabled = false;
      } else {
        await adapter.closePhysical();
        enabled = true;
        await post("discover");
      }
    }));
    element("show-cast-refresh")?.addEventListener("click", (event) =>
      perform(event.currentTarget, () => post("discover")));
    element("show-cast-devices")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cast-device-id]");
      if (!button) return;
      const id = button.dataset.castDeviceId;
      void perform(button, async () => {
        const previous = view();
        if (previous.owns_playback) {
          await disconnect();
          if (previous.selected_renderer_id === id) return;
        }
        await adapter.closePhysical();
        await post("connect", { renderer_id: id });
      });
    });
  }

  function syncHud(snapshot, title) {
    if (!adapter || snapshot?.show_cast?.phase !== "active") {
      if (hudSent) hudSession += 1;
      hudSent = "";
      return;
    }
    const caption = (item) => Array.from(title(item)).slice(0, 512).join("");
    const payload = {
      playback_generation: snapshot.playback_generation,
      queue_version: snapshot.queue_version,
      current: snapshot.current_item ? caption(snapshot.current_item) : null,
      upcoming: (snapshot.playlist || []).slice(0, 4).map(caption),
    };
    const signature = JSON.stringify(payload);
    if (signature === hudSent || hudInFlight) return;
    const session = hudSession;
    hudSent = signature;
    hudInFlight = true;
    void post("hud", payload).catch(() => {
      // Rust still supplies its canonical labels when the view is absent.
    }).finally(() => {
      hudInFlight = false;
      if (session === hudSession || view().phase === "active") {
        syncHud(adapter.snapshot(), title);
      }
    });
  }

  globalThis.BilikaraShowCast = { install, render, busy, stopForPresentation, syncHud };
})();
