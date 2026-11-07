"""Parse the actual packaged iOS overrides, independently of YAML/source checks."""
import plistlib
import unittest
from pathlib import Path


class IosManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = plistlib.loads(
            (Path(__file__).resolve().parents[1] / "src-tauri/Info.ios.plist").read_bytes()
        )

    def test_phone_declares_fullscreen_landscape_while_ipad_retains_multitasking_orientations(self):
        self.assertEqual(self.manifest["UISupportedInterfaceOrientations"], [
            "UIInterfaceOrientationPortrait",
            "UIInterfaceOrientationLandscapeLeft",
            "UIInterfaceOrientationLandscapeRight",
        ])
        tablet = self.manifest["UISupportedInterfaceOrientations~ipad"]
        self.assertEqual(len(tablet), 4)
        self.assertEqual(set(tablet), {
            "UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown",
            "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight",
        })
        self.assertFalse(self.manifest.get("UIRequiresFullScreen", False))

    def test_single_host_and_external_scenes_have_explicit_native_delegates(self):
        manifest = self.manifest["UIApplicationSceneManifest"]
        self.assertIs(manifest["UIApplicationSupportsMultipleScenes"], False)
        configs = manifest["UISceneConfigurations"]
        expected = {
            "UIWindowSceneSessionRoleApplication": "Host",
            "UIWindowSceneSessionRoleExternalDisplayNonInteractive": "Audience",
            "UIWindowSceneSessionRoleExternalDisplay": "Audience",
        }
        self.assertEqual(set(configs), set(expected))
        for role, name in expected.items():
            self.assertEqual(configs[role], [{
                "UISceneConfigurationName": name,
                "UISceneDelegateClassName": "TaoSceneDelegate",
            }])

    def test_scanning_requests_camera_without_recording_or_background_privileges(self):
        self.assertTrue(self.manifest["NSCameraUsageDescription"].strip())
        self.assertNotIn("NSMicrophoneUsageDescription", self.manifest)
        self.assertNotIn("UIBackgroundModes", self.manifest)
        self.assertEqual(self.manifest["CFBundleDisplayName"], "bilikara")


if __name__ == "__main__":
    unittest.main()
