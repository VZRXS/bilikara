"""Current copy contracts: attribute binding, semantic slots and late translations."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"


class CopyBindings(HTMLParser):
    def __init__(self):
        super().__init__()
        self.keys = set()

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name == "data-i18n" or name.startswith("data-i18n-"):
                self.keys.add(value)


class CopyI18nTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.languages = json.loads((STATIC / "i18n.json").read_text())["languages"]

    def test_current_static_and_literal_runtime_bindings_resolve(self):
        keys = set()
        for path in STATIC.glob("*"):
            if path.suffix not in (".html", ".js"):
                continue
            source = path.read_text()
            parser = CopyBindings()
            parser.feed(source)
            keys.update(key for key in parser.keys if key and "${" not in key)
            keys.update(re.findall(r'\b(?:t|htmlT)\(["\']([\w.]+)["\']', source))
        for language, messages in self.languages.items():
            with self.subTest(language=language):
                self.assertEqual(keys - messages.keys(), set())
                self.assertTrue(all(messages[key] for key in keys))

    def test_locales_preserve_placeholder_names_and_semantic_slots(self):
        baseline = self.languages["zh"]
        for language, messages in self.languages.items():
            self.assertEqual(messages.keys(), baseline.keys(), language)
            for key, value in messages.items():
                self.assertEqual(
                    set(re.findall(r"\{(\w+)\}", value)),
                    set(re.findall(r"\{(\w+)\}", baseline[key])),
                    f"{language}:{key}",
                )
        english = self.languages["en"]
        for action, label in (("remote.rate", "search.detailRating"),
                              ("gatcha.draw", "gatcha.title"),
                              ("follow.countSongs", "favlist.mediaCount"),
                              ("player.controls", "controller.controls")):
            self.assertNotEqual(english[action], english[label])
        self.assertEqual(english["service.hires"], "Prefer Hi-Res")

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for copy rendering")
    def test_join_status_translates_before_and_after_language_changes(self):
        script = r'''
const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");
const languages = JSON.parse(fs.readFileSync("static/i18n.json", "utf8")).languages;
const source = fs.readFileSync("static/remote-transport-client.js", "utf8").replace(
  "})(globalThis);",
  "globalThis.copy = {state, setConnectionStatus, localize, handleDataMessage, connectionMessageKeys}; })(globalThis);",
);
const sandbox = {
  fetch: () => {}, location: {hash: "#room=synthetic", origin: "https://example.test"},
  localStorage: {getItem: () => "", setItem: () => {}}, URLSearchParams,
  addEventListener: () => {}, document: {addEventListener: () => {}, documentElement: {dataset: {}}},
};
vm.runInNewContext(source, sandbox);
const {state, localize, setConnectionStatus, handleDataMessage, connectionMessageKeys} = sandbox.copy;
for (const messages of Object.values(languages)) {
  for (const key of Object.values(connectionMessageKeys)) assert(messages[key], key);
}
function element() {
  const attributes = new Map();
  return {textContent: "", dataset: {}, disabled: false,
    classList: {toggle: () => {}},
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
    hasAttribute: key => attributes.has(key)};
}
state.status = element(); state.error = element(); state.connectButton = element();
setConnectionStatus("等待 Host…");
assert.equal(state.status.textContent, "等待 Host…"); // Meaningful before catalog initialization.
for (const language of ["en", "ja", "zh"]) {
  const messages = languages[language];
  localize(key => messages[key] || key, () => {});
  assert.equal(state.status.textContent, messages["internetRemote.waitingForHost"]);
  state.connectButton.disabled = true;
  state.connectButton.setAttribute("aria-busy", "true");
  setConnectionStatus("正在连接…");
  assert.equal(state.connectButton.textContent, messages["remote.connectionConnecting"]);
  assert.equal(state.connectButton.disabled, true);
  setConnectionStatus("正在重新连接…");
  assert.equal(state.status.textContent, messages["remote.connectionReconnecting"]);
  assert.notEqual(state.status.textContent, messages["remote.connectionConnected"]);
  handleDataMessage({type: "auth.failed", reason: "too_many_attempts"});
  assert.equal(state.error.textContent, messages["internetRemote.tooManyAttempts"]);
  assert.equal(state.connectButton.disabled, false);
  assert.equal(state.connectButton.hasAttribute("aria-busy"), false);
  assert.equal(state.connectButton.textContent, messages["internetRemote.connect"]);
  handleDataMessage({type: "auth.failed", reason: "wrong_password"});
  assert.equal(state.error.textContent, messages["internetRemote.wrongPassword"]);
  setConnectionStatus("等待 Host…");
}
setConnectionStatus("房间密码错误。", true);
localize(key => languages.en[key] || key, () => {});
assert.equal(state.error.textContent, languages.en["internetRemote.wrongPassword"]);
const unknown = '<img src=x onerror="alert(1)"> third-party detail 42';
setConnectionStatus(unknown, true);
localize(key => languages.ja[key] || key, () => {});
assert.equal(state.error.textContent, unknown); // Neither translated nor HTML-interpolated.
for (const raw of ["constructor", "toString", "__proto__"]) {
  setConnectionStatus(raw, true);
  assert.equal(state.error.textContent, raw);
}
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
