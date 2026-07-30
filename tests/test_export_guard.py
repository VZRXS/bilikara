import json
import shutil
import subprocess
import unittest
from pathlib import Path


class ExportGuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("node is unavailable")
        cls.repo_root = Path(__file__).resolve().parents[1]
        cls.helper = cls.repo_root / "static" / "export-guard.js"

    def run_node(self, script: str) -> dict:
        process = subprocess.run(
            [self.node, "-e", script, str(self.helper)],
            capture_output=True,
            text=True,
            check=True,
        )
        return json.loads(process.stdout)

    def test_disables_both_buttons_and_suppresses_concurrent_export(self):
        result = self.run_node(
            """
            const {createExportGuard} = require(process.argv[1]);
            const button = () => ({
              disabled: false,
              attributes: {},
              setAttribute(name, value) { this.attributes[name] = value; },
              removeAttribute(name) { delete this.attributes[name]; },
            });
            const buttons = [button(), button()];
            const guard = createExportGuard(buttons);
            let finish;
            let calls = 0;
            const first = guard.run(() => {
              calls += 1;
              return new Promise((resolve) => { finish = resolve; });
            });
            const busySnapshot = buttons.map((item) => ({
              disabled: item.disabled,
              ariaBusy: item.attributes["aria-busy"],
            }));
            const second = guard.run(() => { calls += 1; });
            Promise.resolve(second).then((secondResult) => {
              finish();
              return first.then((firstResult) => {
                process.stdout.write(JSON.stringify({
                  calls,
                  firstResult,
                  secondResult,
                  busySnapshot,
                  finalBusy: guard.isBusy(),
                  finalButtons: buttons.map((item) => ({
                    disabled: item.disabled,
                    ariaBusy: item.attributes["aria-busy"] || null,
                  })),
                }));
              });
            });
            """
        )
        self.assertEqual(result["calls"], 1)
        self.assertTrue(result["firstResult"])
        self.assertFalse(result["secondResult"])
        self.assertEqual(
            result["busySnapshot"],
            [
                {"disabled": True, "ariaBusy": "true"},
                {"disabled": True, "ariaBusy": "true"},
            ],
        )
        self.assertFalse(result["finalBusy"])
        self.assertEqual(
            result["finalButtons"],
            [
                {"disabled": False, "ariaBusy": None},
                {"disabled": False, "ariaBusy": None},
            ],
        )

    def test_restores_buttons_after_failure(self):
        result = self.run_node(
            """
            const {createExportGuard} = require(process.argv[1]);
            const button = {
              disabled: false,
              setAttribute() {},
              removeAttribute() {},
            };
            const guard = createExportGuard([button]);
            guard.run(async () => { throw new Error("failed"); })
              .catch((error) => process.stdout.write(JSON.stringify({
                message: error.message,
                busy: guard.isBusy(),
                disabled: button.disabled,
              })));
            """
        )
        self.assertEqual(result, {"message": "failed", "busy": False, "disabled": False})

    def test_preserves_preexisting_disabled_state(self):
        result = self.run_node(
            """
            const {createExportGuard} = require(process.argv[1]);
            const button = {
              disabled: true,
              attributes: {},
              setAttribute(name, value) { this.attributes[name] = value; },
              removeAttribute(name) { delete this.attributes[name]; },
            };
            const guard = createExportGuard([button]);
            guard.run(async () => {}).then(() => process.stdout.write(JSON.stringify({
              busy: guard.isBusy(),
              disabled: button.disabled,
              ariaBusy: button.attributes["aria-busy"] || null,
            })));
            """
        )
        self.assertEqual(
            result, {"busy": False, "disabled": True, "ariaBusy": None}
        )

    def test_pages_load_guard_before_export_consumers(self):
        for page_name, consumer_name in (("index.html", "app.js"), ("remote.html", "remote.js")):
            source = (self.repo_root / "static" / page_name).read_text(encoding="utf-8")
            self.assertLess(source.index("/export-guard.js"), source.index(f"/{consumer_name}"))
            self.assertLess(source.index("/export-download.js"), source.index(f"/{consumer_name}"))


if __name__ == "__main__":
    unittest.main()
