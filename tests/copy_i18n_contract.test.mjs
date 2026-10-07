import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globSync } from 'node:fs';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, iterableValues, concatenate, markupSummary, subtract } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const STATIC = path.join(ROOT, "static");
const CopyI18nTest = {
async setUpClass() {
this.languages = JSON.parse(readFileSync(path.join(STATIC, "i18n.json"), "utf8"))["languages"];
},
async test_current_static_and_literal_runtime_bindings_resolve() {
let entryPath, key, keys, language, messages, parser, source;
keys = new Set();
for (const entryPath of iterableValues(globSync(path.join(STATIC, "*")))) {
if ((!contains(path.extname(entryPath), [".html", ".js"]))) {
continue;
}
source = readFileSync(entryPath, "utf8");
parser = markupSummary();
Object.assign(parser, markupSummary(source));
Array.from(Array.from(iterableValues(parser.keys)) .filter((key) => (key && (!contains("${", key))))).map((key) => key).forEach(value => keys.add(value));
Array.from(source.matchAll(new RegExp("\\b(?:t|htmlT)\\([\"\\']([\\w.]+)[\"\\']","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).forEach(value => keys.add(value));
}
for (const [language, messages] of iterableValues(Object.entries(this.languages))) {
{
assert.deepEqual(subtract(keys, Object.keys(messages)), new Set());
assert.ok(hasContent(Array.from(Array.from(iterableValues(keys))).map((key) => messages[key]).every(Boolean)));
}
}
},
async test_locales_preserve_placeholder_names_and_semantic_slots() {
let action, baseline, english, key, label, language, messages, value;
baseline = this.languages["zh"];
for (const [language, messages] of iterableValues(Object.entries(this.languages))) {
assert.deepEqual(new Set(Object.keys(messages)), new Set(Object.keys(baseline)), language);
for (const [key, value] of iterableValues(Object.entries(messages))) {
assert.deepEqual(new Set((Symbol.iterator in Object(Array.from(value.matchAll(new RegExp("\\{(\\w+)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1))) ? Array.from(value.matchAll(new RegExp("\\{(\\w+)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)) : Object.keys(Array.from(value.matchAll(new RegExp("\\{(\\w+)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1))))), new Set((Symbol.iterator in Object(Array.from(baseline[key].matchAll(new RegExp("\\{(\\w+)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1))) ? Array.from(baseline[key].matchAll(new RegExp("\\{(\\w+)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)) : Object.keys(Array.from(baseline[key].matchAll(new RegExp("\\{(\\w+)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1))))), (String(language) + ":" + String(key)));
}
}
english = this.languages["en"];
for (const [action, label] of iterableValues([["remote.rate", "search.detailRating"], ["gatcha.draw", "gatcha.title"], ["follow.countSongs", "favlist.mediaCount"], ["player.controls", "controller.controls"]])) {
assert.notDeepEqual(english[action], english[label]);
}
assert.deepEqual(english["service.hires"], "Prefer Hi-Res");
},
async test_requester_labels_use_localized_usernames() {
let key, label, language, languages, value;
languages = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"))["languages"];
for (const [language, label] of iterableValues([["zh", "用户名"], ["en", "Username"], ["ja", "ユーザー名"]])) {
{
assert.deepEqual(languages[language]["remoteIdentity.inputLabel"], label);
assert.ok(hasContent(languages[language]["internetRemote.passwordPlaceholder"]));
for (const [key, value] of iterableValues(Object.entries(languages[language]))) {
if (key.startsWith("remoteIdentity.")) {
assert.ok(!contains("ID", value));
}
}
}
}
},
async test_join_status_translates_before_and_after_language_changes() {
let result, script;
script = `
const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");
const languages = JSON.parse(fs.readFileSync("static/i18n.json", "utf8")).languages;
const source = fs.readFileSync("static/remote-transport-client.js", "utf8").replace(
  "})(globalThis);",
  "globalThis.copy = {state, setConnectionStatus, localize, handleDataMessage, connectionMessageKeys}; })(globalThis);",
);
const notices = [];
const sandbox = {
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
  dispatchEvent: event => notices.push(event.detail),
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
state.connectButton = element();
setConnectionStatus("等待 Host…");
assert.equal(notices.at(-1).message, "等待 Host…"); // Meaningful before catalog initialization.
for (const language of ["en", "ja", "zh"]) {
  const messages = languages[language];
  localize(key => messages[key] || key, () => {});
  assert.equal(notices.at(-1).message, messages["internetRemote.waitingForHost"]);
  for (const legacy of ["等待 Host...", "等待 Host···"]) {
    setConnectionStatus(legacy);
    assert.equal(notices.at(-1).message, messages["internetRemote.waitingForHost"]);
  }
  state.connectButton.disabled = true;
  state.connectButton.setAttribute("aria-busy", "true");
  setConnectionStatus("正在连接…");
  assert.equal(state.connectButton.textContent, messages["remote.connectionConnecting"]);
  assert.equal(state.connectButton.disabled, true);
  setConnectionStatus("正在重新连接…");
  assert.equal(notices.at(-1).message, messages["remote.connectionReconnecting"]);
  assert.notEqual(notices.at(-1).message, messages["remote.connectionConnected"]);
  handleDataMessage({type: "auth.failed", reason: "too_many_attempts"});
  assert.equal(notices.at(-1).message, messages["internetRemote.tooManyAttempts"]);
  assert.equal(state.connectButton.disabled, false);
  assert.equal(state.connectButton.hasAttribute("aria-busy"), false);
  assert.equal(state.connectButton.textContent, messages["internetRemote.connect"]);
  handleDataMessage({type: "auth.failed", reason: "wrong_password"});
  assert.equal(notices.at(-1).message, messages["internetRemote.wrongPassword"]);
  setConnectionStatus("等待 Host…");
}
setConnectionStatus("房间密码错误。", true);
localize(key => languages.en[key] || key, () => {});
assert.equal(notices.at(-1).message, languages.en["internetRemote.wrongPassword"]);
const unknown = '<img src=x onerror="alert(1)"> third-party detail 42';
setConnectionStatus(unknown, true);
localize(key => languages.ja[key] || key, () => {});
assert.equal(notices.at(-1).message, unknown); // Neither translated nor HTML-interpolated.
for (const raw of ["constructor", "toString", "__proto__"]) {
  setConnectionStatus(raw, true);
  assert.equal(notices.at(-1).message, raw);
}
`;
result = (await runNative("node", ["-e", script], process.env, 120000, ROOT));
assert.deepEqual(result.status, 0, concatenate(result.stdout, result.stderr));
}
};
test("CopyI18nTest.test_current_static_and_literal_runtime_bindings_resolve", async () => { const instance = Object.create(CopyI18nTest); await instance.setUpClass(); await instance.test_current_static_and_literal_runtime_bindings_resolve(); });
test("CopyI18nTest.test_locales_preserve_placeholder_names_and_semantic_slots", async () => { const instance = Object.create(CopyI18nTest); await instance.setUpClass(); await instance.test_locales_preserve_placeholder_names_and_semantic_slots(); });
test("CopyI18nTest.test_requester_labels_use_localized_usernames", async () => { const instance = Object.create(CopyI18nTest); await instance.setUpClass(); await instance.test_requester_labels_use_localized_usernames(); });
test("CopyI18nTest.test_join_status_translates_before_and_after_language_changes", async () => { const instance = Object.create(CopyI18nTest); await instance.setUpClass(); await instance.test_join_status_translates_before_and_after_language_changes(); });
