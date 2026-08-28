import json
import subprocess
import unittest
from pathlib import Path


class StartupStateFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.source = (cls.repo_root / "static" / "app.js").read_text(encoding="utf-8")

    @classmethod
    def source_slice(cls, start_marker: str, end_marker: str) -> str:
        start = cls.source.index(start_marker)
        end = cls.source.index(end_marker, start)
        return cls.source[start:end]

    def run_state_sequence(self, responses: list[dict]) -> dict:
        response_parser = self.source_slice(
            "async function parseApiResponse",
            "async function apiPost",
        )
        fetch_state = self.source_slice(
            "async function fetchState",
            "function renderSignatureForData",
        )
        snapshot_acceptance = self.source_slice(
            "function isSafeHostSnapshotInteger",
            "function syncCachePanelVisibility",
        )
        script = f"""
const responseSpecs = {json.dumps(responses)};
let responseIndex = 0;
let jsonCalls = 0;
let renderPlayerCalls = 0;
const messages = [];
const window = {{ location: {{ href: "http://tauri.localhost/" }} }};
const state = {{
  data: null,
  hasValidStateResponse: false,
  localPreferencesHydrated: true,
  lastPollRenderSignature: "",
  pendingHostPlaybackProgramReconciliation: null,
  hostPlaybackSession: null,
}};

function makeResponse(spec) {{
  return {{
    url: spec.url,
    status: spec.status,
    ok: spec.status >= 200 && spec.status < 300,
    headers: {{
      get(name) {{
        return String(name).toLowerCase() === "content-type" ? spec.contentType : null;
      }},
    }},
    async json() {{
      jsonCalls += 1;
      if (spec.jsonError) throw new SyntaxError(spec.jsonError);
      return spec.payload;
    }},
  }};
}}

async function fetch() {{
  return makeResponse(responseSpecs[responseIndex++]);
}}
function clientHeaders() {{ return {{}}; }}
function localizedApiMessage(message) {{ return String(message || ""); }}
function t() {{ return "State request failed"; }}
function currentAvOffsetMs() {{ return 0; }}
function frontendPlaybackMode() {{ return "local"; }}
function maybeShowIncomingRequestToast() {{}}
function maybeShowSongTransitionOverlay() {{}}
function scheduleStartupAppUpdateCheck() {{}}
function syncLocalPlayerSettingsFromSnapshot() {{}}
function rememberedVolumePercent() {{ return 100; }}
function rememberedMuted() {{ return false; }}
async function apiPost() {{ throw new Error("apiPost must not run"); }}
function scheduleFavlistBrowseReloadFromState() {{}}
function renderSignatureForData(data) {{ return JSON.stringify(data); }}
function render() {{}}
function renderPlayer() {{ renderPlayerCalls += 1; }}
function hasDownloadingItems() {{ return false; }}
function refreshRetryButtons() {{}}
function resyncMountedLocalPlayerIfOffsetChanged() {{}}
function setAppMessage(message, isError) {{
  messages.push({{ message: String(message), isError: Boolean(isError) }});
}}

{response_parser}
{snapshot_acceptance}
{fetch_state}

async function pollOnce() {{
  try {{
    await fetchState();
    return null;
  }} catch (error) {{
    if (shouldReportStateFetchError(error)) {{
      setAppMessage(error.message, true);
    }}
    return {{
      message: error.message,
      kind: error.kind,
      status: error.status,
      contentType: error.contentType,
      backendNotReady: Boolean(error.backendNotReady),
    }};
  }}
}}

(async () => {{
  const firstError = await pollOnce();
  const afterFirst = {{
    data: state.data,
    ready: state.hasValidStateResponse,
    messages: [...messages],
    jsonCalls,
  }};
  const secondError = await pollOnce();
  console.log(JSON.stringify({{
    firstError,
    secondError,
    afterFirst,
    finalData: state.data,
    finalReady: state.hasValidStateResponse,
    messages,
    jsonCalls,
    renderPlayerCalls,
  }}));
}})().catch((error) => {{
  console.error(error);
  process.exit(1);
}});
"""
        completed = subprocess.run(
            ["node", "-e", script],
            cwd=self.repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_pre_ready_tauri_html_keeps_loading_then_valid_state_initializes(self):
        result = self.run_state_sequence(
            [
                {
                    "url": "http://tauri.localhost/api/state",
                    "status": 200,
                    "contentType": "text/html; charset=utf-8",
                    "jsonError": "Unexpected token '<'",
                },
                {
                    "url": "http://127.0.0.1:43123/api/state",
                    "status": 200,
                    "contentType": "application/json; charset=utf-8",
                    "payload": {
                        "ok": True,
                        "data": {
                            "state_revision": 1,
                            "revision": 1,
                            "playback_generation": 1,
                            "playback_program": None,
                            "current_item": None,
                            "playlist": [],
                        },
                    },
                },
            ]
        )

        self.assertEqual(
            result["firstError"],
            {
                "message": "Backend returned a non-JSON response",
                "kind": "non_json_response",
                "status": 200,
                "contentType": "text/html; charset=utf-8",
                "backendNotReady": True,
            },
        )
        self.assertIsNone(result["afterFirst"]["data"])
        self.assertFalse(result["afterFirst"]["ready"])
        self.assertEqual(result["afterFirst"]["messages"], [])
        self.assertEqual(result["afterFirst"]["jsonCalls"], 0)
        self.assertIsNone(result["secondError"])
        self.assertTrue(result["finalReady"])
        self.assertEqual(result["finalData"]["state_revision"], 1)
        self.assertEqual(result["messages"], [])
        self.assertEqual(result["jsonCalls"], 1)
        self.assertEqual(result["renderPlayerCalls"], 1)

    def test_post_ready_non_json_state_response_remains_observable(self):
        result = self.run_state_sequence(
            [
                {
                    "url": "http://127.0.0.1:43123/api/state",
                    "status": 200,
                    "contentType": "application/json",
                    "payload": {
                        "ok": True,
                        "data": {
                            "state_revision": 1,
                            "revision": 1,
                            "playback_generation": 1,
                            "playback_program": None,
                            "current_item": None,
                            "playlist": [],
                        },
                    },
                },
                {
                    "url": "http://127.0.0.1:43123/api/state",
                    "status": 502,
                    "contentType": "text/html",
                    "jsonError": "Unexpected token '<' at <!DOCTYPE html>",
                },
            ]
        )

        self.assertIsNone(result["firstError"])
        self.assertTrue(result["afterFirst"]["ready"])
        self.assertEqual(result["secondError"]["kind"], "non_json_response")
        self.assertFalse(result["secondError"]["backendNotReady"])
        self.assertEqual(
            result["messages"],
            [{"message": "Backend returned a non-JSON response", "isError": True}],
        )
        self.assertNotIn("Unexpected token", result["messages"][0]["message"])
        self.assertNotIn("DOCTYPE", result["messages"][0]["message"])
        self.assertEqual(result["jsonCalls"], 1)
        self.assertEqual(result["renderPlayerCalls"], 1)


if __name__ == "__main__":
    unittest.main()
