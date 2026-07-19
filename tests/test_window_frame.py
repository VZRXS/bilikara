import json
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path


class _FrameMarkupParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.stack: list[tuple[str, str]] = []
        self.elements: dict[str, dict[str, object]] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        element_id = attributes.get("id") or ""
        ancestors = [ancestor_id for _, ancestor_id in self.stack if ancestor_id]
        if element_id:
            self.elements[element_id] = {
                "tag": tag,
                "attributes": attributes,
                "ancestors": ancestors,
            }
        self.stack.append((tag, element_id))

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                return


class WindowFrameTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        v20_node = Path("/tmp/node-v20.18.0-linux-x64/bin/node")
        cls.node = str(v20_node) if v20_node.is_file() else shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.frame_js = cls.repo_root / "static" / "window-frame.js"
        cls.index_html = cls.repo_root / "static" / "index.html"

    def run_node_test(self) -> dict:
        script = r"""
        const api = require(process.argv[1]);
        let unhandledRejections = 0;
        process.on("unhandledRejection", () => { unhandledRejections += 1; });

        function classList(initial) {
          const values = new Set(initial || []);
          return {
            add(...names) { names.forEach(name => values.add(name)); },
            remove(...names) { names.forEach(name => values.delete(name)); },
            toggle(name, force) {
              if (force === true) { values.add(name); return true; }
              if (force === false) { values.delete(name); return false; }
              if (values.has(name)) { values.delete(name); return false; }
              values.add(name); return true;
            },
            contains(name) { return values.has(name); },
          };
        }

        function element(id, initialClasses) {
          const listeners = {};
          return {
            id,
            disabled: false,
            attributes: {},
            classList: classList(initialClasses),
            setAttribute(name, value) { this.attributes[name] = String(value); },
            removeAttribute(name) { delete this.attributes[name]; },
            addEventListener(name, listener) { listeners[name] = listener; },
            emit(name, event) { if (listeners[name]) { listeners[name](event || {}); } },
          };
        }

        function documentFixture() {
          const elements = {
            "tauri-titlebar": element("tauri-titlebar", ["hidden"]),
            "tauri-titlebar-drag-region": element("tauri-titlebar-drag-region"),
            "tauri-window-minimize": element("tauri-window-minimize"),
            "tauri-window-maximize": element("tauri-window-maximize"),
            "tauri-window-close": element("tauri-window-close"),
          };
          return {
            elements,
            documentElement: { classList: classList() },
            getElementById(id) { return elements[id] || null; },
          };
        }

        async function main() {
          const browserDoc = documentFixture();
          const browserRoot = { document: browserDoc, addEventListener() {} };
          const browserController = api.createController({ root: browserRoot, document: browserDoc });
          const browserEnabled = browserController.initialize();

          const detectedWebview = {};
          const detectedWindow = {};
          const detection = {
            browser: api.detectTauriWindow({}) === null,
            webview: api.detectTauriWindow({ __TAURI__: { webviewWindow: {
              getCurrentWebviewWindow() { return detectedWebview; },
            } } }) === detectedWebview,
            window: api.detectTauriWindow({ __TAURI__: { window: {
              getCurrentWindow() { return detectedWindow; },
            } } }) === detectedWindow,
            failure: api.detectTauriWindow({ __TAURI__: {
              webviewWindow: { getCurrentWebviewWindow() { throw new Error("not ready"); } },
              window: { getCurrentWindow() { throw new Error("not ready"); } },
            } }) === null,
          };

          const doc = documentFixture();
          const rootListeners = {};
          const root = {
            document: doc,
            console: { warn() {} },
            addEventListener(name, listener) { rootListeners[name] = listener; },
            setTimeout(callback) { rootListeners.resizeTimeout = callback; return 1; },
            clearTimeout() { delete rootListeners.resizeTimeout; },
          };
          const calls = { minimize: 0, toggleMaximize: 0, close: 0, isMaximized: 0 };
          let maximized = false;
          let resolveMinimize;
          const appWindow = {
            minimize() {
              calls.minimize += 1;
              return new Promise(resolve => { resolveMinimize = resolve; });
            },
            async toggleMaximize() { calls.toggleMaximize += 1; maximized = !maximized; },
            async isMaximized() { calls.isMaximized += 1; return maximized; },
            async close() { calls.close += 1; },
          };
          const labels = {
            "window.minimize": "Minimize",
            "window.maximize": "Maximize",
            "window.restore": "Restore",
            "window.close": "Close",
          };
          const controller = api.createController({
            root,
            document: doc,
            appWindow,
            translate(key) { return labels[key]; },
          });
          const tauriEnabled = controller.initialize();
          await new Promise(resolve => setImmediate(resolve));

          doc.elements["tauri-window-minimize"].emit("click");
          doc.elements["tauri-window-minimize"].emit("click");
          const minimizeDuring = {
            calls: calls.minimize,
            disabled: doc.elements["tauri-window-minimize"].disabled,
            busy: doc.elements["tauri-window-minimize"].attributes["aria-busy"],
          };
          resolveMinimize();
          await new Promise(resolve => setImmediate(resolve));

          doc.elements["tauri-window-maximize"].emit("click");
          await new Promise(resolve => setImmediate(resolve));
          const maximizedState = {
            label: doc.elements["tauri-window-maximize"].attributes["aria-label"],
            pressed: doc.elements["tauri-window-maximize"].attributes["aria-pressed"],
            classActive: doc.elements["tauri-window-maximize"].classList.contains("is-maximized"),
          };

          doc.elements["tauri-window-maximize"].emit("click");
          await new Promise(resolve => setImmediate(resolve));
          const restoredState = {
            label: doc.elements["tauri-window-maximize"].attributes["aria-label"],
            pressed: doc.elements["tauri-window-maximize"].attributes["aria-pressed"],
          };

          maximized = true;
          rootListeners.resize();
          rootListeners.resize();
          const resizeCallsBeforeTimeout = calls.isMaximized;
          rootListeners.resizeTimeout();
          await new Promise(resolve => setImmediate(resolve));
          const externallyMaximizedState = {
            label: doc.elements["tauri-window-maximize"].attributes["aria-label"],
            pressed: doc.elements["tauri-window-maximize"].attributes["aria-pressed"],
            classActive: doc.elements["tauri-window-maximize"].classList.contains("is-maximized"),
          };

          doc.elements["tauri-window-close"].emit("click");
          await new Promise(resolve => setImmediate(resolve));

          controller.setFullscreen(true);
          const fullscreenClass = doc.documentElement.classList.contains("tauri-window-fullscreen");
          controller.setFullscreen(false);

          const raceDoc = documentFixture();
          let resolveFirstSync;
          let resolveSecondSync;
          let syncQueryCount = 0;
          const raceWindow = {
            async minimize() {},
            async toggleMaximize() {},
            isMaximized() {
              syncQueryCount += 1;
              return new Promise(resolve => {
                if (syncQueryCount === 1) { resolveFirstSync = resolve; }
                else { resolveSecondSync = resolve; }
              });
            },
            async close() {},
          };
          const raceController = api.createController({
            root: {
              document: raceDoc,
              addEventListener() {},
              setTimeout,
              clearTimeout,
            },
            document: raceDoc,
            appWindow: raceWindow,
            translate(key) { return labels[key]; },
          });
          raceController.initialize();
          const latestSync = raceController.syncMaximized();
          resolveSecondSync(true);
          await latestSync;
          resolveFirstSync(false);
          await new Promise(resolve => setImmediate(resolve));
          const raceState = {
            label: raceDoc.elements["tauri-window-maximize"].attributes["aria-label"],
            pressed: raceDoc.elements["tauri-window-maximize"].attributes["aria-pressed"],
          };

          process.stdout.write(JSON.stringify({
            browserEnabled,
            browserHidden: browserDoc.elements["tauri-titlebar"].classList.contains("hidden"),
            browserClass: browserDoc.documentElement.classList.contains("tauri-window-frame"),
            detection,
            tauriEnabled,
            tauriVisible: !doc.elements["tauri-titlebar"].classList.contains("hidden"),
            tauriClass: doc.documentElement.classList.contains("tauri-window-frame"),
            minimizeDuring,
            minimizeAfter: {
              disabled: doc.elements["tauri-window-minimize"].disabled,
              busy: doc.elements["tauri-window-minimize"].attributes["aria-busy"] || null,
            },
            maximizedState,
            restoredState,
            externallyMaximizedState,
            resizeDebounce: {
              beforeTimeout: resizeCallsBeforeTimeout,
              afterTimeout: calls.isMaximized,
            },
            calls,
            fullscreenClass,
            raceState,
            labels: {
              minimize: doc.elements["tauri-window-minimize"].attributes["aria-label"],
              close: doc.elements["tauri-window-close"].attributes["aria-label"],
            },
            unhandledRejections,
          }));
        }
        main();
        """
        process = subprocess.run(
            [self.node, "-e", script, str(self.frame_js)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return json.loads(process.stdout)

    def test_window_frame_browser_fallback_and_tauri_actions(self):
        result = self.run_node_test()
        self.assertFalse(result["browserEnabled"])
        self.assertTrue(result["browserHidden"])
        self.assertFalse(result["browserClass"])
        self.assertEqual(
            result["detection"],
            {"browser": True, "webview": True, "window": True, "failure": True},
        )
        self.assertTrue(result["tauriEnabled"])
        self.assertTrue(result["tauriVisible"])
        self.assertTrue(result["tauriClass"])
        self.assertEqual(result["minimizeDuring"], {"calls": 1, "disabled": True, "busy": "true"})
        self.assertEqual(result["minimizeAfter"], {"disabled": False, "busy": None})
        self.assertEqual(
            result["maximizedState"],
            {"label": "Restore", "pressed": "true", "classActive": True},
        )
        self.assertEqual(result["restoredState"], {"label": "Maximize", "pressed": "false"})
        self.assertEqual(
            result["externallyMaximizedState"],
            {"label": "Restore", "pressed": "true", "classActive": True},
        )
        self.assertEqual(result["resizeDebounce"], {"beforeTimeout": 3, "afterTimeout": 4})
        self.assertEqual(result["calls"]["toggleMaximize"], 2)
        self.assertEqual(result["calls"]["close"], 1)
        self.assertTrue(result["fullscreenClass"])
        self.assertEqual(result["raceState"], {"label": "Restore", "pressed": "true"})
        self.assertEqual(result["labels"], {"minimize": "Minimize", "close": "Close"})
        self.assertEqual(result["unhandledRejections"], 0)

    def test_markup_accessibility_drag_boundary_and_script_order(self):
        source = self.index_html.read_text(encoding="utf-8")
        parser = _FrameMarkupParser()
        parser.feed(source)
        titlebar = parser.elements["tauri-titlebar"]
        self.assertIn("hidden", str(titlebar["attributes"]["class"]).split())
        self.assertEqual(titlebar["attributes"]["aria-hidden"], "true")
        drag_region = parser.elements["tauri-titlebar-drag-region"]
        self.assertEqual(drag_region["attributes"]["data-tauri-drag-region"], "deep")
        for button_id, label_key in (
            ("tauri-window-minimize", "window.minimize"),
            ("tauri-window-maximize", "window.maximize"),
            ("tauri-window-close", "window.close"),
        ):
            button = parser.elements[button_id]
            self.assertEqual(button["tag"], "button")
            self.assertEqual(button["attributes"]["type"], "button")
            self.assertEqual(button["attributes"]["data-i18n-aria-label"], label_key)
            self.assertIn("tauri-window-controls", button["ancestors"])
            self.assertNotIn("tauri-titlebar-drag-region", button["ancestors"])
        self.assertLess(source.index("/window-frame.js"), source.index("/app.js"))

    def test_tauri_config_and_permissions_are_narrow(self):
        config = json.loads(
            (self.repo_root / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        window = config["app"]["windows"][0]
        self.assertFalse(window["decorations"])
        self.assertTrue(window["resizable"])
        self.assertNotEqual(window.get("transparent"), True)

        capability = json.loads(
            (self.repo_root / "src-tauri" / "capabilities" / "main.json").read_text(
                encoding="utf-8"
            )
        )
        permissions = set(capability["permissions"])
        self.assertTrue(
            {
                "core:window:allow-minimize",
                "core:window:allow-toggle-maximize",
                "core:window:allow-close",
                "core:window:allow-start-dragging",
                "core:window:allow-is-maximized",
            }.issubset(permissions)
        )
        self.assertFalse(any("shell" in permission or "fs:" in permission for permission in permissions))

    def test_window_control_translations_cover_all_languages(self):
        languages = json.loads(
            (self.repo_root / "static" / "i18n.json").read_text(encoding="utf-8")
        )["languages"]
        for language in ("zh", "en", "ja"):
            for key in ("window.minimize", "window.maximize", "window.restore", "window.close"):
                self.assertTrue(languages[language][key])


if __name__ == "__main__":
    unittest.main()
