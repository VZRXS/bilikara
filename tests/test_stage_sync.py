import json
import shutil
import subprocess
import unittest
from pathlib import Path


class StageSyncLogicTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.helper = cls.repo_root / "static" / "stage-sync.js"

    def call(self, expression: str) -> dict:
        process = subprocess.run(
            [
                self.node,
                "-e",
                (
                    "const sync=require(process.argv[1]);"
                    f"process.stdout.write(JSON.stringify({expression}));"
                ),
                str(self.helper),
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(process.stdout)

    def test_running_master_clock_is_projected_to_receive_time(self):
        target = self.call(
            "sync.predictedMediaTime({mediaTime:12,sampledAt:1000,paused:false,playbackRate:1},2500)"
        )
        self.assertEqual(target, 13.5)

    def test_paused_master_clock_is_not_projected(self):
        target = self.call(
            "sync.predictedMediaTime({mediaTime:12,sampledAt:1000,paused:true,playbackRate:1},9000)"
        )
        self.assertEqual(target, 12)

    def test_large_drift_uses_hard_seek(self):
        result = self.call(
            "sync.planClockCorrection({mediaTime:20,sampledAt:1000,paused:false,playbackRate:1},"
            "{currentTime:18,paused:false},1000)"
        )
        self.assertEqual(result["action"], "seek")
        self.assertEqual(result["targetTime"], 20)
        self.assertTrue(result["shouldPlay"])

    def test_medium_drift_uses_soft_rate_correction(self):
        ahead = self.call(
            "sync.planClockCorrection({mediaTime:20,sampledAt:1000,paused:false,playbackRate:1},"
            "{currentTime:19.8,paused:false},1000)"
        )
        behind = self.call(
            "sync.planClockCorrection({mediaTime:20,sampledAt:1000,paused:false,playbackRate:1},"
            "{currentTime:20.2,paused:false},1000)"
        )
        self.assertGreater(ahead["playbackRate"], 1)
        self.assertLess(behind["playbackRate"], 1)

    def test_small_drift_restores_master_rate(self):
        result = self.call(
            "sync.planClockCorrection({mediaTime:20,sampledAt:1000,paused:false,playbackRate:1.25},"
            "{currentTime:19.98,paused:false},1000)"
        )
        self.assertEqual(result["action"], "rate")
        self.assertEqual(result["playbackRate"], 1.25)

    def test_soft_correction_is_relative_to_non_default_master_rate(self):
        result = self.call(
            "sync.planClockCorrection({mediaTime:20,sampledAt:1000,paused:false,playbackRate:1.5},"
            "{currentTime:19.8,paused:false},1000)"
        )
        self.assertAlmostEqual(result["playbackRate"], 1.54)

    def test_pause_and_resume_follow_master_semantics(self):
        pause = self.call(
            "sync.planClockCorrection({mediaTime:20,sampledAt:1000,paused:true,playbackRate:1},"
            "{currentTime:20,paused:false},1000)"
        )
        play = self.call(
            "sync.planClockCorrection({mediaTime:20,sampledAt:1000,paused:false,playbackRate:1},"
            "{currentTime:20,paused:true},1000)"
        )
        self.assertEqual(pause["action"], "pause")
        self.assertEqual(play["action"], "play")

    def test_rejects_old_messages_from_the_same_master(self):
        result = self.call(
            "sync.acceptsEnvelope({protocol:1,senderId:'master',sequence:8},"
            "{protocol:1,senderId:'master',sequence:7})"
        )
        self.assertFalse(result)

    def test_accepts_lower_sequence_from_a_different_master(self):
        result = self.call(
            "sync.acceptsEnvelope({protocol:1,senderId:'master',sequence:8},"
            "{protocol:1,senderId:'new-master',sequence:7})"
        )
        self.assertTrue(result)

    def test_rejects_messages_with_a_different_protocol(self):
        result = self.call(
            "sync.acceptsEnvelope({protocol:1,senderId:'master',sequence:8},"
            "{protocol:2,senderId:'master',sequence:9})"
        )
        self.assertFalse(result)

    def test_scene_normalization_bounds_overlay_rows(self):
        result = self.call(
            "sync.normalizeScene({revision:2,itemId:'song',videoUrl:'/media.mp4',"
            "overlay:{visible:true,rows:Array.from({length:8},(_,i)=>({title:String(i)}))}})"
        )
        self.assertEqual(result["revision"], 2)
        self.assertEqual(len(result["overlay"]["rows"]), 5)

    def test_stage_page_loads_shared_modules_without_host_business_logic(self):
        source = (self.repo_root / "static" / "stage.html").read_text(encoding="utf-8")
        self.assertIn('/stage-sync.js', source)
        self.assertIn('/stage-renderer.js', source)
        self.assertIn('/stage.js', source)
        self.assertNotIn('/app.js', source)
        self.assertLess(source.index('/stage-sync.js'), source.index('/stage.js'))
        self.assertLess(source.index('/stage-renderer.js'), source.index('/stage.js'))

    def test_stage_cursor_reappears_on_pointer_activity(self):
        script = (self.repo_root / "static" / "stage.js").read_text(encoding="utf-8")
        styles = (self.repo_root / "static" / "stage.css").read_text(encoding="utf-8")
        self.assertIn('document.addEventListener("pointermove"', script)
        self.assertIn("revealStageCursor();", script)
        self.assertIn('classList.remove("is-cursor-hidden")', script)
        self.assertIn('classList.add("is-cursor-hidden")', script)
        self.assertIn("body.stage-body.is-cursor-hidden", styles)

    def test_host_uses_shared_renderer_and_tauri_lifecycle_is_main_only(self):
        app_source = (self.repo_root / "static" / "app.js").read_text(encoding="utf-8")
        tauri_source = (self.repo_root / "src-tauri" / "src" / "main.rs").read_text(
            encoding="utf-8"
        )
        self.assertIn("stageRendererApi()?.mountMedia", app_source)
        self.assertIn('sendStageEnvelope("master-state"', app_source)
        self.assertIn('window.label() == "main"', tauri_source)
        self.assertIn('get_webview_window("stage")', tauri_source)
        self.assertIn("window.app_handle().exit(0)", tauri_source)
        self.assertIn("open_stage_window", tauri_source)
        self.assertIn("get_stage_display_info", tauri_source)
        self.assertIn('invoke("get_stage_display_info")', app_source)
        self.assertNotIn("relayoutOnChange", app_source)
        self.assertIn('invoke("open_stage_window", { displayId: null })', app_source)
        self.assertIn("stageSelectedDisplayId", app_source)
        self.assertIn("monitorFriendlyDeviceName", tauri_source)
        self.assertIn("monitorDevicePath", tauri_source)
        self.assertIn("StageSessionState", tauri_source)

        host_source = (self.repo_root / "static" / "index.html").read_text(
            encoding="utf-8"
        )
        self.assertIn('id="stage-settings"', host_source)
        self.assertIn('id="stage-display-list"', host_source)
        self.assertIn('role="switch"', host_source)

        stage_source = (self.repo_root / "static" / "stage.js").read_text(
            encoding="utf-8"
        )
        stage_capability = (
            self.repo_root / "src-tauri" / "capabilities" / "stage.json"
        ).read_text(encoding="utf-8")
        self.assertIn('tauriInvoke("set_window_fullscreen"', stage_source)
        self.assertIn('"windows": [\n    "stage"', stage_capability)
        self.assertIn('"allow-set-window-fullscreen"', stage_capability)

    def test_host_registers_storage_fallback_listener_only_once(self):
        app_source = (self.repo_root / "static" / "app.js").read_text(encoding="utf-8")
        self.assertIn("stageStorageListenerAttached: false", app_source)
        self.assertIn("if (!state.stageStorageListenerAttached)", app_source)
        self.assertIn(
            'window.addEventListener("storage", handleStageStorageEvent)', app_source
        )


if __name__ == "__main__":
    unittest.main()
