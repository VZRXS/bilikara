/* Domain-level execution seam. AppState and the existing player own all state. */
(() => {
  "use strict";
  const fields = ["playback_generation", "item_id", "item_incarnation_id",
    "selected_audio_variant_id", "artifact_set_id"];
  function identity(value) {
    if (!value || !Number.isSafeInteger(value.playback_generation) || value.playback_generation < 1
      || !["item_id", "item_incarnation_id"].every(key => typeof value[key] === "string" && value[key])
      || typeof value.selected_audio_variant_id !== "string"
      || !(value.artifact_set_id === null || typeof value.artifact_set_id === "string" && value.artifact_set_id)) {
      throw new TypeError("Invalid playback program identity");
    }
    return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
  }
  function same(left, right) { return Boolean(left && right && fields.every(key => left[key] === right[key])); }
  function failure(code) { return Object.assign(new Error(code), { name: "PlaybackBackendError", code }); }

  /**
   * A facade over ONE existing execution owner; never mounts media, starts a
   * timer, claims artifacts, changes AppState, acknowledges EOS or chooses Next.
   * Every command supplies the full immutable program identity. A stale command
   * throws synchronously BEFORE touching the port. A delegated Promise (if any)
   * is returned unchanged; its owner must also check identity after each await.
   * Events are observations, not authorization to advance or write history.
   * `ready` means resources prepared; only `playing` confirms actual output.
   * `eos` is a drain observation; existing generation-checked Host ACK is separate.
   * Dispose revokes this facade/listeners exactly once; the port retains sole
   * responsibility for media, DSP, lease release and outstanding async teardown.
   */
  function createLegacyPlaybackAdapter({ program, current, ports, capabilities = {} }) {
    const bound = identity(program), listeners = new Set();
    let disposed = false;
    const valid = value => !disposed && same(bound, value) && same(bound, current());
    const invoke = (name, value, ...args) => {
      if (!valid(value)) throw failure(disposed ? "disposed" : "stale-program");
      if (typeof ports[name] !== "function") throw failure("unsupported-" + name);
      return ports[name](...args);
    };
    const adapter = {
      program: bound,
      capabilities: Object.freeze({ backend: "legacy-webview", ...capabilities }),
      load: value => invoke("load", value),
      play: (value, options) => invoke("play", value, options),
      pause: value => invoke("pause", value),
      seek: (value, seconds) => invoke("seek", value, seconds),
      setVolume: (value, volume, muted, options) => invoke("setVolume", value, volume, muted, options),
      setKeyShift: (value, semitones) => invoke("setKeyShift", value, semitones),
      setAvDelay: (value, milliseconds) => invoke("setAvDelay", value, milliseconds),
      selectAudioVariant: (value, variantId) => invoke("selectAudioVariant", value, variantId),
      snapshot: value => invoke("snapshot", value),
      stop: value => invoke("stop", value),
      subscribe(callback) {
        if (disposed) throw failure("disposed");
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      observe(value, event) {
        if (!valid(value)) return false;
        // Port supplies only domain observations, never media nodes/URLs/errors
        // with private locators. Observer failure must not break playback.
        if (!listeners.size) return true;
        const observation = Object.freeze({ ...event, program: bound });
        const recipients = [...listeners];
        // Observers run after the owner's synchronous commit, so a listener
        // cannot stop/rebind media halfway through that commit. Commands and
        // their return values are still delegated synchronously without a queue.
        queueMicrotask(() => {
          if (!valid(value)) return;
          for (const callback of recipients) {
            if (!valid(value)) break;
            if (!listeners.has(callback)) continue;
            try { callback(observation); } catch { /* Observer owns its error. */ }
          }
        });
        return true;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        listeners.clear();
        return ports.dispose?.();
      },
    };
    return Object.freeze(adapter);
  }
  globalThis.BilikaraMediaBackend = { identity, same, createLegacyPlaybackAdapter };
})();
