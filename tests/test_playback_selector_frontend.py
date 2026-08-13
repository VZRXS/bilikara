from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


class PlaybackSelectorFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        cls.source = (
            repo_root / "static" / "app.js"
        ).read_text(encoding="utf-8")
        cls.index_source = (repo_root / "static" / "index.html").read_text(
            encoding="utf-8"
        )

    @classmethod
    def source_slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def test_selector_change_only_mutates_selector_and_preserves_player(self):
        functions = self.source_slice(
            "function hostStateRevision",
            "async function setAvOffset",
        )
        script = f"""
(async () => {{
  const attributes = new Set();
  const rustOption = {{ disabled: false }};
  const select = {{
    value: "python", disabled: false,
    querySelector() {{ return rustOption; }},
    removeAttribute(name) {{ attributes.delete(name); }},
    toggleAttribute(name, enabled) {{
      if (enabled) attributes.add(name); else attributes.delete(name);
    }},
  }};
  const hint = {{
    textContent: "", classList: {{ toggle() {{}} }},
  }};
  const mountedPlayer = {{ token: "same-player" }};
  const currentItem = {{ id: "song" }};
  const state = {{
    playbackSelectorSaving: false,
    playbackSelectorAuthorized: true,
    playbackSelectorCapability: {{ mode: "python", rust_available: true, warning: "" }},
    playbackSelectorCapabilityRevision: 0,
    playbackSelectorCapabilityRequestId: 0,
    mountedPlayer,
    data: {{
      current_item: currentItem,
      playback_selector: {{ mode: "python", rust_available: true, warning: "" }},
    }},
  }};
  const elements = {{
    playbackSelectorContainer: {{ hidden: false }},
    playbackSelectorSelect: select,
    playbackSelectorHint: hint,
  }};
  const calls = [];
  async function apiPost(path, body) {{
    calls.push({{ path, body }});
    return {{
      current_item: currentItem,
      playback_selector: {{ mode: body.mode, rust_available: true, warning: "" }},
    }};
  }}
  function t(key, values) {{ return values?.mode || key; }}
  function setAppMessage() {{}}
  function render() {{}}
  {functions}
  await setPlaybackSelectorMode("rust");
  console.log(JSON.stringify({{
    calls,
    samePlayer: state.mountedPlayer === mountedPlayer,
    sameItem: state.data.current_item === currentItem,
    saving: state.playbackSelectorSaving,
    disabled: select.disabled,
    busy: attributes.has("aria-busy"),
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            ["node", "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(
            result["calls"],
            [
                {
                    "path": "/api/player/playback-selector",
                    "body": {"mode": "rust"},
                }
            ],
        )
        self.assertTrue(result["samePlayer"])
        self.assertTrue(result["sameItem"])
        self.assertFalse(result["saving"])
        self.assertFalse(result["disabled"])
        self.assertFalse(result["busy"])

    def test_stale_selector_response_cannot_replace_newer_snapshot(self):
        functions = self.source_slice(
            "function hostStateRevision",
            "async function setAvOffset",
        )
        script = f"""
(async () => {{
  const select = {{
    value: "python", disabled: false,
    querySelector() {{ return {{ disabled: false }}; }},
    toggleAttribute() {{}},
    removeAttribute() {{}},
  }};
  const state = {{
    playbackSelectorSaving: false,
    playbackSelectorAuthorized: true,
    playbackSelectorCapability: {{ mode: "python", rust_available: true, warning: "" }},
    playbackSelectorCapabilityRevision: 42,
    playbackSelectorCapabilityRequestId: 0,
    data: {{
      state_revision: 42,
      playback_selector: {{ mode: "python", rust_available: true, warning: "" }},
    }},
  }};
  const elements = {{
    playbackSelectorContainer: {{ hidden: false }},
    playbackSelectorSelect: select,
    playbackSelectorHint: {{ textContent: "", classList: {{ toggle() {{}} }} }},
  }};
  async function apiPost() {{
    return {{
      state_revision: 41,
      playback_selector: {{ mode: "rust", rust_available: true, warning: "" }},
    }};
  }}
  function t(key, values) {{ return values?.mode || key; }}
  function setAppMessage() {{}}
  function render() {{}}
  {functions}
  await setPlaybackSelectorMode("rust");
  console.log(JSON.stringify({{
    revision: state.data.state_revision,
    mode: state.data.playback_selector.mode,
  }}));
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        completed = subprocess.run(
            ["node", "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            json.loads(completed.stdout.strip().splitlines()[-1]),
            {"revision": 42, "mode": "python"},
        )

    def test_selector_is_hidden_and_disabled_in_initial_html(self):
        self.assertRegex(
            self.index_source,
            r'id="playback-selector-container" hidden',
        )
        self.assertRegex(
            self.index_source,
            r'id="playback-selector-select" class="cache-quality-select" disabled',
        )

    def test_selector_layout_keeps_rust_first_and_hint_with_label(self):
        container_start = self.index_source.index(
            'class="cache-panel-row cache-panel-selector-row"'
        )
        container_end = self.index_source.index("</select>", container_start)
        container = self.index_source[container_start:container_end]

        self.assertLess(
            container.index('data-i18n="service.playbackSelector"'),
            container.index('id="playback-selector-select"'),
        )
        self.assertLess(
            container.index('data-i18n="service.playbackSelectorRust"'),
            container.index('data-i18n="service.playbackSelectorPython"'),
        )

    def test_capability_read_fails_closed_and_rejects_stale_responses(self):
        functions = self.source_slice(
            "function hostStateRevision",
            "async function setAvOffset",
        )
        script = f"""
(async () => {{
  const rustOption = {{ disabled: false }};
  const select = {{
    value: "python",
    disabled: true,
    querySelector() {{ return rustOption; }},
    toggleAttribute() {{}},
    removeAttribute() {{}},
  }};
  const container = {{ hidden: true }};
  const mountedPlayer = {{ token: "same-player" }};
  const state = {{}};
  const elements = {{
    playbackSelectorContainer: container,
    playbackSelectorSelect: select,
    playbackSelectorHint: {{ textContent: "", classList: {{ toggle() {{}} }} }},
  }};
  let apiGetImpl = async () => {{ throw new Error("not configured"); }};
  let renderCalls = 0;
  async function apiGet() {{ return apiGetImpl(); }}
  async function apiPost() {{ throw new Error("not used"); }}
  function t(key) {{ return key; }}
  function setAppMessage() {{}}
  function render() {{ renderCalls += 1; }}
  {functions}

  function reset() {{
    Object.assign(state, {{
      playbackSelectorSaving: false,
      playbackSelectorAuthorized: false,
      playbackSelectorCapability: null,
      playbackSelectorCapabilityRevision: -1,
      playbackSelectorCapabilityRequestId: 0,
      mountedPlayer,
      data: {{
        state_revision: 40,
        playback_selector: {{ mode: "python", rust_available: true, warning: "" }},
      }},
    }});
    container.hidden = true;
    select.disabled = true;
    select.value = "python";
    renderCalls = 0;
  }}

  async function runFailure(factory) {{
    reset();
    apiGetImpl = factory;
    const result = await loadPlaybackSelectorCapability();
    return {{ result, hidden: container.hidden, disabled: select.disabled }};
  }}

  reset();
  apiGetImpl = async () => ({{
    state_revision: 41,
    playback_selector: {{
      mode: "rust", modes: ["python", "rust"], rust_available: true, warning: "",
    }},
  }});
  const localResult = await loadPlaybackSelectorCapability();
  const local = {{
    result: localResult,
    hidden: container.hidden,
    disabled: select.disabled,
    mode: select.value,
    samePlayer: state.mountedPlayer === mountedPlayer,
    renderCalls,
  }};

  const forbidden = await runFailure(async () => {{
    const error = new Error("forbidden");
    error.status = 403;
    throw error;
  }});
  const network = await runFailure(async () => {{ throw new Error("offline"); }});
  const malformed = await runFailure(async () => ({{
    state_revision: 42,
    playback_selector: {{
      mode: "python", modes: ["python", "hybrid"], rust_available: true, warning: "",
    }},
  }}));

  reset();
  let resolveOlder;
  let resolveNewer;
  let callCount = 0;
  apiGetImpl = () => new Promise((resolve) => {{
    callCount += 1;
    if (callCount === 1) resolveOlder = resolve;
    else resolveNewer = resolve;
  }});
  const older = loadPlaybackSelectorCapability();
  const newer = loadPlaybackSelectorCapability();
  resolveNewer({{
    state_revision: 42,
    playback_selector: {{
      mode: "rust", modes: ["python", "rust"], rust_available: true, warning: "",
    }},
  }});
  await newer;
  resolveOlder({{
    state_revision: 41,
    playback_selector: {{
      mode: "python", modes: ["python", "rust"], rust_available: true, warning: "",
    }},
  }});
  await older;
  const stale = {{ hidden: container.hidden, mode: select.value }};

  process.stdout.write(JSON.stringify({{ local, forbidden, network, malformed, stale }}));
}})().catch((error) => {{ process.stderr.write(String(error)); process.exit(1); }});
"""
        completed = subprocess.run(
            ["node", "-"],
            input=script,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(
            result["local"],
            {
                "result": True,
                "hidden": False,
                "disabled": False,
                "mode": "rust",
                "samePlayer": True,
                "renderCalls": 0,
            },
        )
        for failure in ("forbidden", "network", "malformed"):
            with self.subTest(failure=failure):
                self.assertEqual(
                    result[failure],
                    {"result": False, "hidden": True, "disabled": True},
                )
        self.assertEqual(result["stale"], {"hidden": False, "mode": "rust"})

    def test_polling_uses_the_same_stale_snapshot_guard(self):
        fetch_state = self.source_slice(
            "async function fetchState",
            "function renderSignatureForData",
        )
        self.assertIn("if (!applyFreshStateSnapshot(payload.data))", fetch_state)


if __name__ == "__main__":
    unittest.main()
