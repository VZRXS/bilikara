import json
import shutil
import subprocess
import unittest
from pathlib import Path


class PlayerHealthLogicTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.helper = Path(__file__).resolve().parents[1] / "static" / "player-health.js"

    def call(self, function_name: str, payload=None):
        script = (
            "const h=require(process.argv[1]);"
            "const p=JSON.parse(process.argv[2]);"
            f"process.stdout.write(JSON.stringify(h.{function_name}(p)));"
        )
        process = subprocess.run(
            [self.node, "-e", script, str(self.helper), json.dumps(payload)],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(process.stdout)

    def test_audio_and_video_end_within_tolerance(self):
        result = self.call("classifyAudioEnded", {
            "videoDuration": 240,
            "videoCurrentTime": 238,
            "audioDuration": 239,
            "audioCurrentTime": 239,
            "expectedDuration": 240,
        })
        self.assertFalse(result["fault"])

    def test_audio_ending_early_is_fault(self):
        result = self.call("classifyAudioEnded", {
            "videoDuration": 240,
            "videoCurrentTime": 87,
            "audioDuration": 87,
            "audioCurrentTime": 87,
            "expectedDuration": 240,
        })
        self.assertTrue(result["fault"])
        self.assertEqual(result["classification"], "audio-ended-early")

    def test_video_ending_early_is_fault(self):
        result = self.call("classifyVideoEnded", {
            "videoDuration": 87,
            "videoCurrentTime": 87,
            "audioDuration": 240,
            "audioCurrentTime": 87,
            "expectedDuration": 240,
        })
        self.assertTrue(result["fault"])
        self.assertEqual(result["classification"], "video-ended-early")

    def test_video_ending_normally_is_not_fault(self):
        result = self.call("classifyVideoEnded", {
            "videoDuration": 240,
            "videoCurrentTime": 240,
            "audioDuration": 239.5,
            "audioCurrentTime": 239.5,
            "expectedDuration": 240,
        })
        self.assertFalse(result["fault"])

    def test_media_decode_errors_are_faults(self):
        script = (
            "const h=require(process.argv[1]);"
            "process.stdout.write(JSON.stringify([h.classifyMediaError('audio',3),h.classifyMediaError('video',3)]));"
        )
        process = subprocess.run([self.node, "-e", script, str(self.helper)], capture_output=True, text=True, check=True)
        results = json.loads(process.stdout)
        self.assertTrue(results[0]["fault"])
        self.assertTrue(results[1]["fault"])

    def test_audio_duration_unavailable_still_uses_video_remaining(self):
        result = self.call("classifyAudioEnded", {
            "videoDuration": 240,
            "videoCurrentTime": 80,
            "audioDuration": None,
            "audioCurrentTime": 80,
            "expectedDuration": 240,
        })
        self.assertTrue(result["fault"])

    def test_expected_duration_unavailable_uses_media_durations(self):
        result = self.call("classifyVideoEnded", {
            "videoDuration": 120,
            "videoCurrentTime": 120,
            "audioDuration": 120,
            "audioCurrentTime": 119,
            "expectedDuration": None,
        })
        self.assertFalse(result["fault"])

    def test_av_offset_near_end_is_tolerated(self):
        result = self.call("classifyAudioEnded", {
            "videoDuration": 240,
            "videoCurrentTime": 234,
            "audioDuration": 234,
            "audioCurrentTime": 234,
            "expectedDuration": 240,
            "avOffsetSeconds": 3,
        })
        self.assertFalse(result["fault"])

    def test_manual_seek_near_end_is_normal_when_durations_agree(self):
        result = self.call("classifyVideoEnded", {
            "videoDuration": 240,
            "videoCurrentTime": 239,
            "audioDuration": 240,
            "audioCurrentTime": 238.5,
            "expectedDuration": 240,
            "manualSeekNearEnd": True,
        })
        self.assertFalse(result["fault"])

    def test_manual_next_is_not_guarded_by_media_ended_policy(self):
        script = (
            "const h=require(process.argv[1]);"
            "process.stdout.write(JSON.stringify([h.shouldGuardAdvance('media-ended'),h.shouldGuardAdvance('manual-next')]));"
        )
        process = subprocess.run([self.node, "-e", script, str(self.helper)], capture_output=True, text=True, check=True)
        guarded, manual = json.loads(process.stdout)
        self.assertTrue(guarded)
        self.assertFalse(manual)


if __name__ == "__main__":
    unittest.main()
