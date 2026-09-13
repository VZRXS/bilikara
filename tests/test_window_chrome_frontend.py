import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WindowChromeTest(unittest.TestCase):
    def test_caption_labels_follow_all_application_locales_without_replacing_svgs(self):
        translations = json.loads((ROOT / "static/i18n.json").read_text())["languages"]
        markup = (ROOT / "static/index.html").read_text()
        script = (ROOT / "static/app.js").read_text()
        for language in ("zh", "en", "ja"):
            for key in ("controls", "minimize", "maximize", "restore", "close"):
                self.assertTrue(translations[language][f"window.{key}"])
        for action in ("minimize", "maximize", "close"):
            self.assertIn(f'data-i18n-title="window.{action}"', markup)
            self.assertIn(f'data-i18n-aria-label="window.{action}"', markup)
        render = script[script.index("function renderWindowMaximizeState"):script.index("function initializeNativeMaximizeRegion")]
        self.assertIn('"window.restore" : "window.maximize"', render)
        self.assertIn('.window-restore-icon', render)
        self.assertIn('toggleAttribute("hidden"', render)
        self.assertNotIn("textContent", render)
        self.assertIn("request === frameStateRequest", script)

    def test_native_region_is_local_authorized_and_keeps_pointer_actions_native(self):
        native = (ROOT / "src-tauri/src/window_chrome.rs").read_text()
        script = (ROOT / "static/app.js").read_text()
        self.assertIn('authorize_window(&window, &backend, &["main"])', native)
        self.assertIn("region.is_some_and", native)
        self.assertIn("WM_NCHITTEST => return HTMAXBUTTON", native)
        self.assertIn("SC_RESTORE", native)
        self.assertIn("SC_MAXIMIZE", native)
        self.assertIn("WM_NCDESTROY", native)
        self.assertIn("Box::from_raw", native)
        self.assertIn("WM_DPICHANGED", native)
        self.assertIn("PostMessageW", native)
        self.assertNotIn('eval(', native)
        self.assertIn("window.devicePixelRatio", script)
        region = script[script.index("function initializeNativeMaximizeRegion"):script.index("function initializeWindowChrome")]
        self.assertIn("if (pending)", region)
        self.assertIn("sent === signature", region)
        self.assertIn("!isPlayerPanelFullscreen()", region)
        self.assertIn("!presentationCompositionActive()", region)
        self.assertNotIn("setInterval", region)
        self.assertNotIn("toggleMaximize", region)

    def test_linux_and_macos_keep_native_caption_controls_and_shared_theme_colors(self):
        platform = (ROOT / "src-tauri/src/platform.rs").read_text()
        self.assertIn("gtk::HeaderBar::new()", platform)
        self.assertIn("header.set_show_close_button(true)", platform)
        self.assertIn("gtk_window.is_realized()", platform)
        macos = json.loads((ROOT / "src-tauri/tauri.macos.conf.json").read_text())["app"]["windows"][0]
        self.assertTrue(macos["decorations"])
        self.assertEqual(macos["titleBarStyle"], "Overlay")
        script = (ROOT / "static/app.js").read_text()
        self.assertIn('getPropertyValue("--bg-middle")', script)
        self.assertIn('getPropertyValue("--ink")', script)


if __name__ == "__main__":
    unittest.main()
