from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


class HostStateSnapshotFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.source = (cls.repo_root / "static" / "app.js").read_text(
            encoding="utf-8"
        )

    @classmethod
    def source_slice(cls, start: str, end: str) -> str:
        start_index = cls.source.index(start)
        return cls.source[start_index : cls.source.index(end, start_index)]

    def test_full_snapshot_guard_rejects_stale_host_state(self):
        functions = self.source_slice(
            "function hostStateRevision",
            "function syncCachePanelVisibility",
        )
        script = f"""
const state = {{ data: {{ state_revision: 42, marker: "current" }} }};
{functions}
const original = state.data;
const rejected = applyFreshStateSnapshot({{ state_revision: 41, marker: "stale" }});
const sameAfterStale = state.data === original;
const accepted = applyFreshStateSnapshot({{ state_revision: 43, marker: "new" }});
process.stdout.write(JSON.stringify({{
  rejected,
  sameAfterStale,
  accepted,
  revision: state.data.state_revision,
  marker: state.data.marker,
}}));
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
            json.loads(completed.stdout),
            {
                "rejected": False,
                "sameAfterStale": True,
                "accepted": True,
                "revision": 43,
                "marker": "new",
            },
        )

    def test_polling_executes_the_same_guard_before_side_effects(self):
        guard = self.source_slice(
            "function hostStateRevision",
            "function syncCachePanelVisibility",
        )
        fetch_state = self.source_slice(
            "async function fetchState",
            "function renderSignatureForData",
        )
        script = f"""
(async () => {{
  const state = {{
    data: {{ state_revision: 42, marker: "current" }},
    hasValidStateResponse: false,
    localPreferencesHydrated: true,
    lastPollRenderSignature: "",
  }};
  let candidate = {{ state_revision: 41, marker: "stale" }};
  let sideEffects = 0;
  async function fetch() {{ return {{ ok: true }}; }}
  function clientHeaders() {{ return {{}}; }}
  async function parseApiResponse() {{ return {{ ok: true, data: candidate }}; }}
  function currentAvOffsetMs() {{ return 0; }}
  function localizedApiMessage(value) {{ return value; }}
  function t(key) {{ return key; }}
  function maybeShowIncomingRequestToast() {{ sideEffects += 1; }}
  function maybeShowSongTransitionOverlay() {{ sideEffects += 1; }}
  function syncLocalPlayerSettingsFromSnapshot() {{ sideEffects += 1; }}
  function scheduleFavlistBrowseReloadFromState() {{ sideEffects += 1; }}
  function renderSignatureForData(data) {{ return JSON.stringify(data); }}
  function render() {{ sideEffects += 1; }}
  function hasDownloadingItems() {{ return false; }}
  function refreshRetryButtons() {{ sideEffects += 1; }}
  function resyncMountedLocalPlayerIfOffsetChanged() {{ sideEffects += 1; }}
  function rememberedVolumePercent() {{ return 100; }}
  function rememberedMuted() {{ return false; }}
  async function apiPost() {{ throw new Error("not used"); }}
  {guard}
  {fetch_state}

  await fetchState();
  const stale = {{
    marker: state.data.marker,
    valid: state.hasValidStateResponse,
    sideEffects,
  }};
  candidate = {{ state_revision: 43, marker: "new" }};
  await fetchState();
  const fresh = {{
    marker: state.data.marker,
    valid: state.hasValidStateResponse,
    sideEffects,
  }};
  process.stdout.write(JSON.stringify({{ stale, fresh }}));
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
            result["stale"],
            {"marker": "current", "valid": False, "sideEffects": 0},
        )
        self.assertEqual(result["fresh"]["marker"], "new")
        self.assertTrue(result["fresh"]["valid"])
        self.assertGreater(result["fresh"]["sideEffects"], 0)

    def test_processing_backend_control_and_translations_are_absent(self):
        sources = {
            name: (self.repo_root / name).read_text(encoding="utf-8")
            for name in (
                "static/app.js",
                "static/index.html",
                "static/styles.css",
                "static/i18n.json",
            )
        }
        forbidden = (
            "playback" + "Selector",
            "playback-" + "selector",
            "playback_" + "selector",
        )
        for name, source in sources.items():
            for token in forbidden:
                with self.subTest(file=name, token=token):
                    self.assertNotIn(token, source)


if __name__ == "__main__":
    unittest.main()
