from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class AvDelayFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host_js = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.remote_js = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.host_html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        cls.remote_html = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        cls.host_css = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        cls.remote_css = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")

    def test_existing_panels_are_the_only_lock_entry_points(self):
        self.assertEqual(self.host_html.count("data-av-delay-lock"), 1)
        self.assertEqual(self.remote_html.count("data-av-delay-lock"), 1)
        self.assertIn('id="av-delay-lock-button"', self.host_html)
        self.assertIn('id="remote-av-delay-lock-button"', self.remote_html)

    def test_host_lock_button_is_immediately_right_of_reset_button(self):
        positive_step_position = self.host_html.index('data-step="200"')
        reset_position = self.host_html.index('id="av-offset-reset-button"')
        lock_position = self.host_html.index("data-av-delay-lock")
        self.assertLess(positive_step_position, reset_position)
        self.assertLess(reset_position, lock_position)

    def test_remote_av_delay_spinner_sits_next_to_unit(self):
        selector = "#remote-av-sync-panel .remote-input-wrap {"
        rules = self.remote_css.split(selector)
        self.assertGreaterEqual(len(rules), 3)
        for rule in rules[1:]:
            declarations = rule.split("}", 1)[0]
            self.assertIn("justify-content: flex-end;", declarations)
            self.assertIn("gap: 4px;", declarations)
        input_selector = '#remote-av-sync-panel .remote-input-wrap input[type="number"] {'
        input_rules = self.remote_css.split(input_selector)
        self.assertGreaterEqual(len(input_rules), 3)
        for rule in input_rules[1:]:
            declarations = rule.split("}", 1)[0]
            self.assertIn("padding: 0;", declarations)
            self.assertIn("margin: 0;", declarations)
        self.assertIn(
            '#remote-av-sync-panel .remote-input-wrap input[type="number"]::-webkit-inner-spin-button',
            self.remote_css,
        )

    def test_frontends_dispatch_actions_and_render_rust_snapshot_fields(self):
        for source in (self.host_js, self.remote_js):
            self.assertIn('/api/player/av-delay-action', source)
            self.assertIn('has_local_adjustment', source)
            self.assertIn('lock_button_enabled', source)
            self.assertIn('effective_delay_ms', source)
            self.assertIn('{ type: "adjust", delta_ms:', source)
            self.assertIn('{ type: "reset_local" }', source)
            self.assertIn('{ type: "toggle_lock" }', source)
            self.assertNotIn('bilikara.player.av_offset_ms', source)
            self.assertNotIn("global_delay_ms + local_delay_ms", source)
            self.assertNotIn("local_delay_ms + global_delay_ms", source)

    def test_host_and_remote_render_backend_button_decisions(self):
        fixtures = (
            (
                self.host_js,
                "function renderAvSyncControls",
                "function renderPlayer",
                "avDelayLockButton",
                "avOffsetResetButton",
                "avOffsetInput",
                "avSyncPanel",
                "avOffsetSaving",
                "function currentAvOffsetMs() { return currentSettings.av_delay.effective_delay_ms; }",
                "renderAvSyncControls('local', currentSettings);",
            ),
            (
                self.remote_js,
                "function renderRemoteAvSyncControls",
                "function renderRemoteVolumeControls",
                "remoteAvDelayLockButton",
                "remoteAvOffsetResetButton",
                "remoteAvOffsetInput",
                "remoteAvSyncPanel",
                "remoteAvDelaySaving",
                "function currentRemoteAvOffsetMs(settings) { return settings.av_delay.effective_delay_ms; }",
                "renderRemoteAvSyncControls('local', currentSettings);",
            ),
        )
        cases = (
            (False, False, False),
            (False, True, True),
            (True, False, True),
            (True, True, True),
        )
        for fixture in fixtures:
            source, start_marker, end_marker, lock_key, reset_key, input_key, panel_key, busy_key, offset_helper, call = fixture
            function_source = source[source.index(start_marker) : source.index(end_marker, source.index(start_marker))]
            for locked, has_local, enabled in cases:
                script = f"""
const currentSettings = {{ av_delay: {{ effective_delay_ms: 0, locked: {str(locked).lower()},
  has_local_adjustment: {str(has_local).lower()}, lock_button_enabled: {str(enabled).lower()} }} }};
function element() {{ return {{ disabled: false, value: '', textContent: '', title: '', dataset: {{}},
  attributes: {{}}, setAttribute(k, v) {{ this.attributes[k] = String(v); }},
  classList: {{ toggle() {{}} }}, querySelectorAll() {{ return []; }} }}; }}
const elements = {{ {lock_key}: element(), {reset_key}: element(), {input_key}: element(), {panel_key}: element() }};
const state = {{ {busy_key}: false }};
const document = {{ activeElement: null }};
function t(key) {{ return key; }}
{offset_helper}
{function_source}
{call}
console.log(JSON.stringify({{ disabled: elements.{lock_key}.disabled,
  iconCodePoints: Array.from(elements.{lock_key}.textContent, (character) => character.codePointAt(0)),
  pressed: elements.{lock_key}.attributes['aria-pressed'],
  hasLocal: elements.{lock_key}.dataset.hasLocal }}));
"""
                completed = subprocess.run(
                    ["node", "-e", script], capture_output=True, text=True, timeout=5, check=False
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                result = json.loads(completed.stdout)
                self.assertEqual(result["disabled"], not enabled)
                self.assertEqual(result["iconCodePoints"], [0x1F512 if locked else 0x1F513])
                self.assertEqual(result["pressed"], str(locked).lower())
                self.assertEqual(result["hasLocal"], str(has_local).lower())

    def test_av_delay_actions_use_lightweight_decisions_and_a_timeout(self):
        for source in (self.host_js, self.remote_js):
            self.assertIn("const avDelayRequestTimeoutMs = 8000;", source)
            self.assertIn("new AbortController()", source)
            self.assertIn("{ timeoutMs: avDelayRequestTimeoutMs }", source)
            self.assertIn("av_delay: decision", source)
            self.assertIn("av_offset_ms: Number(decision?.effective_delay_ms || 0)", source)

    def test_api_post_aborts_a_stalled_av_delay_request(self):
        fixtures = (
            (self.host_js, "function submitSongRating"),
            (self.remote_js, "function normalizedRemoteIdentity"),
        )
        for source, end_marker in fixtures:
            start = source.index("async function apiPost")
            end = source.index(end_marker, start)
            api_post_source = source[start:end]
            script = f"""
const window = globalThis;
function clientHeaders(headers) {{ return headers; }}
function localizedApiMessage(value) {{ return value; }}
function t(key) {{ return key; }}
function fetch(url, options) {{
  return new Promise((resolve, reject) => {{
    options.signal.addEventListener("abort", () => {{
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }});
  }});
}}
{api_post_source}
apiPost("/api/player/av-delay-action", {{}}, {{ timeoutMs: 10 }})
  .then(() => process.exit(2))
  .catch((error) => {{
    if (error.message !== "error.requestTimeout") process.exit(3);
    process.exit(0);
  }});
"""
            process = subprocess.run(
                ["node", "-e", script],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr or process.stdout)

    def test_all_four_visual_combinations_and_disabled_state_are_styled(self):
        for source, selector in (
            (self.host_css, ".av-sync-lock-button"),
            (self.remote_css, ".remote-lock-button"),
        ):
            self.assertIn(f'{selector}[data-has-local="true"]', source)
            self.assertIn(f'{selector}[data-locked="true"]', source)
            self.assertIn(
                f'{selector}[data-locked="true"][data-has-local="true"]', source
            )
            self.assertIn(f"{selector}:disabled", source)
            self.assertIn("background: var(--av-lock-unlocked-bg);", source)
            self.assertIn("background: var(--av-lock-disabled-bg);", source)
            for token in (
                "--av-lock-hover-filter",
                "--av-lock-focus-outline",
                "--av-lock-focus-shadow",
                "--av-lock-active-transform",
            ):
                self.assertIn(token, source)
            self.assertIn(f'{selector}[data-has-local="true"]::after', source)
            self.assertIn('content: "";', source)
            self.assertIn("position: absolute;", source)
            self.assertIn("inset-block-start: 6px;", source)
            self.assertIn("inset-inline-end: 6px;", source)
            self.assertIn(f"{selector}:focus-visible", source)
            self.assertIn(f"{selector}:not(:disabled):active", source)

            local_rule = source.split(f'{selector}[data-has-local="true"] {{', 1)[1].split("}", 1)[0]
            locked_rule = source.split(f'{selector}[data-locked="true"] {{', 1)[1].split("}", 1)[0]
            locked_local_rule = source.split(
                f'{selector}[data-locked="true"][data-has-local="true"] {{', 1
            )[1].split("}", 1)[0]
            for state_rule in (local_rule, locked_rule, locked_local_rule):
                self.assertNotIn("background:", state_rule)


if __name__ == "__main__":
    unittest.main()
