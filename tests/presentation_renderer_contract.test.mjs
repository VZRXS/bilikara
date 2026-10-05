import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, iterableValues } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const PresentationRendererTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.module = path.join(path.join(ROOT, "static"), "presentation-renderer.js");
this.source = readFileSync(this.module, "utf8");
},
async run_renderer() {
let completed, script;
script = (`
class ClassList {
  constructor(node) { this.node = node; this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); this.sync(); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); this.sync(); }
  toggle(name, force) {
    if (force === true) this.values.add(name);
    else if (force === false) this.values.delete(name);
    else if (this.values.has(name)) this.values.delete(name);
    else this.values.add(name);
    this.sync();
    return this.values.has(name);
  }
  contains(name) { return this.values.has(name); }
  sync() { this.node._className = [...this.values].join(" "); }
}
class Node {
  constructor(tagName, text = "") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.textContent = text;
    this._className = "";
    this.classList = new ClassList(this);
    this.style = { values: {}, setProperty: (key, value) => { this.style.values[key] = value; } };
  }
  set className(value) {
    this._className = String(value);
    this.classList.values = new Set(this._className.split(/\\s+/).filter(Boolean));
  }
  get className() { return this._className; }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes) {
    this.children.forEach((node) => { node.parentNode = null; });
    this.children = [];
    this.append(...nodes);
  }
  querySelector(selector) {
    const match = (node) => {
      if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
      const data = selector.match(/^\\[data-([^\\]]+)\\]$/);
      return data ? Object.hasOwn(node.attributes, \`data-\${data[1]}\`) : false;
    };
    const visit = (node) => {
      for (const child of node.children) {
        if (match(child)) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this);
  }
}
global.document = {
  createElement: (tag) => new Node(tag),
  createElementNS: (_namespace, tag) => new Node(tag),
  createTextNode: (value) => new Node("#text", String(value)),
};
const renderer = require(` + String(JSON.stringify(String(this.module))) + `);
const root = new Node("div");
const video = new Node("video");
video.src = "media/video.mp4";
const audio = new Node("audio");
audio.src = "media/audio.m4a";
root.append(video, audio);
const scene = {
  generation: 3,
  revision: 8,
  currentItemIdentity: "item-1",
  title: "<img src=x onerror=alert(1)>",
  displayMetadata: { cacheStatus: "failed" },
  overlay: {
    visible: true,
    heading: "Next",
    deadline: 2000,
    durationMs: 2000,
    title: "<script>bad()</script>",
    requester: "Alice & Bob",
    duration: "3:00",
    cacheStatus: "queued",
    queueHeading: "Queue",
    rows: [
      { title: "Song", requester: "Carol", duration: "2:00", cacheStatus: "failed" },
      { title: "Ready song", requester: "Dave", duration: "1:00", cacheStatus: "ready" },
    ],
    totalText: "2 songs",
  },
};
const first = renderer.renderScene(root, scene, { now: 1000 });
const primaryCard = first.querySelector(".player-delay-now-row");
const queueCards = [...first.querySelector("[data-delay-list]").children];
const initialCacheStates = [primaryCard, ...queueCards].map(node => node.dataset.cacheState);
const badge = primaryCard.querySelector(".queue-order");
const play = badge.querySelector(".queue-badge-play");
const playGlyph = { viewBox: play.attributes.viewBox, path: play.children[0].attributes.d, hidden: Object.hasOwn(play.attributes, "hidden") };
const errorGlyph = badge.querySelector(".queue-badge-error").children[0].attributes.d;
const second = renderer.renderScene(root, { ...scene, revision: 9, overlay: { ...scene.overlay,
  cacheStatus: "failed", rows: scene.overlay.rows.map((row, index) => ({ ...row, cacheStatus: index ? "ready" : "downloading" })),
} }, { now: 1500 });
const updatedCacheStates = [primaryCard, ...second.querySelector("[data-delay-list]").children].map(node => node.dataset.cacheState);
const cardsPreserved = primaryCard === second.querySelector(".player-delay-now-row")
  && second.querySelector("[data-delay-list]").children.every((node, index) => node === queueCards[index]);
renderer.renderOverlay(second, { ...scene.overlay, cacheStatus: "unknown", rows: scene.overlay.rows.map(row => ({ ...row, cacheStatus: "unknown" })) });
const clearedCacheStates = [primaryCard, ...queueCards].map(node => node.dataset.cacheState);
const badgeCacheStates = [primaryCard, ...queueCards].map(node => node.querySelector(".queue-order").dataset.cacheState);
renderer.renderOverlay(second, { ...scene.overlay, queueHeading: "" }, { primaryIndex: 1 });
const consoleNumbers = [primaryCard, ...queueCards].map(node => node.querySelector(".queue-badge-label").textContent);
const consolePlayHidden = Object.hasOwn(play.attributes, "hidden");
const subtitleHidden = second.querySelector("[data-delay-queue-heading]").hidden;
renderer.renderOverlay(second, { ...scene.overlay, rows: [] }, { primaryIndex: null });
const emptyBadgeHidden = badge.classList.contains("is-empty");
renderer.renderOverlay(second, scene.overlay);
const audienceNumbers = [...second.querySelector("[data-delay-list]").children].map(node => node.querySelector(".queue-badge-label").textContent);
process.stdout.write(JSON.stringify({
  videoPreserved: root.children[0] === video && video.src === "media/video.mp4",
  audioPreserved: root.children[1] === audio && audio.src === "media/audio.m4a",
  overlayReused: first === second,
  overlayCount: root.children.filter((node) => node.classList.contains("player-delay-overlay")).length,
  titleText: second.querySelector("[data-delay-next-title]").textContent,
  childTags: root.children.map((node) => node.tagName),
  generation: root.dataset.presentationGeneration,
  revision: root.dataset.presentationRevision,
  frameHasCacheState: Object.hasOwn(root.dataset, "cacheState"),
  initialCacheStates,
  updatedCacheStates,
  cardsPreserved,
  clearedCacheStates, badgeCacheStates, consoleNumbers, consolePlayHidden, subtitleHidden, emptyBadgeHidden,
  playGlyph, errorGlyph, audienceNumbers, audiencePlayRestored: !Object.hasOwn(play.attributes, "hidden") && !badge.classList.contains("is-empty"),
}));
`);
completed = (await runNative(this.node, ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_rendering_reuses_overlay_and_preserves_host_media_identity() {
let result;
result = (await this.run_renderer());
assert.ok(hasContent(result["videoPreserved"]));
assert.ok(hasContent(result["audioPreserved"]));
assert.ok(hasContent(result["overlayReused"]));
assert.deepEqual(result["overlayCount"], 1);
assert.deepEqual(result["childTags"].slice(0, 2), ["VIDEO", "AUDIO"]);
assert.deepEqual(result["generation"], "3");
assert.deepEqual(result["revision"], "9");
},
async test_song_cache_states_are_independent_and_preserve_card_nodes() {
const result = await this.run_renderer();
assert.equal(result.frameHasCacheState, false);
assert.deepEqual(result.initialCacheStates, ["pending", "failed", "ready"]);
assert.deepEqual(result.updatedCacheStates, ["failed", "downloading", "ready"]);
assert.equal(result.cardsPreserved, true);
assert.deepEqual(result.clearedCacheStates, ["", "", ""]);
assert.deepEqual(result.badgeCacheStates, ["", "", ""]);
},
async test_shared_badges_preserve_play_glyph_and_console_queue_numbering() {
const result = await this.run_renderer();
assert.deepEqual(result.playGlyph, { viewBox: "0 0 24 24", path: "M8 5v14l11-7z", hidden: false });
assert.equal(result.errorGlyph, "M18 6L6 18M6 6l12 12");
assert.deepEqual(result.consoleNumbers, ["1", "2", "3"]);
assert.equal(result.consolePlayHidden, true);
assert.equal(result.subtitleHidden, true);
assert.equal(result.emptyBadgeHidden, true);
assert.deepEqual(result.audienceNumbers, ["1", "2"]);
assert.equal(result.audiencePlayRestored, true);
},
async test_user_content_is_assigned_as_text() {
let result;
result = (await this.run_renderer());
assert.deepEqual(result["titleText"], "<script>bad()</script>");
assert.ok(!contains("innerHTML", this.source));
},
async test_renderer_never_constructs_or_synchronizes_media() {
let forbidden;
for (const forbidden of iterableValues(["createElement(\"video\")", "createElement(\"audio\")", "BroadcastChannel", "localStorage", "playbackRate", "drift", "currentTime", "mountMedia"])) {
assert.ok(!contains(forbidden, this.source));
}
}
};
test("PresentationRendererTest.test_rendering_reuses_overlay_and_preserves_host_media_identity", async () => { const instance = Object.create(PresentationRendererTest); await instance.setUpClass(); await instance.test_rendering_reuses_overlay_and_preserves_host_media_identity(); });
test("PresentationRendererTest.test_song_cache_states_are_independent_and_preserve_card_nodes", async () => { const instance = Object.create(PresentationRendererTest); await instance.setUpClass(); await instance.test_song_cache_states_are_independent_and_preserve_card_nodes(); });
test("PresentationRendererTest.test_shared_badges_preserve_play_glyph_and_console_queue_numbering", async () => { const instance = Object.create(PresentationRendererTest); await instance.setUpClass(); await instance.test_shared_badges_preserve_play_glyph_and_console_queue_numbering(); });
test("PresentationRendererTest.test_user_content_is_assigned_as_text", async () => { const instance = Object.create(PresentationRendererTest); await instance.setUpClass(); await instance.test_user_content_is_assigned_as_text(); });
test("PresentationRendererTest.test_renderer_never_constructs_or_synchronizes_media", async () => { const instance = Object.create(PresentationRendererTest); await instance.setUpClass(); await instance.test_renderer_never_constructs_or_synchronizes_media(); });
