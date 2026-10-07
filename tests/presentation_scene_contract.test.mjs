import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, iterableValues } from './frontend_contract_support.mjs';
import { createRequire } from 'node:module';
const { normalizePresentationScene } = createRequire(import.meta.url)('../static/presentation-scene.js');

test('Audience progress metadata is bounded and does not change scene identity', () => {
  for (const [raw, expected] of [[42, 42], [-1, 0], [120, 100], [null, null], [undefined, null], ['bad', null], [Infinity, null]]) {
    const scene = normalizePresentationScene({ revision: 8, currentItemIdentity: 'song-1', displayMetadata: {
      cacheStatus: 'downloading', cacheDetail: '<b>plain text</b>', cacheProgress: raw,
    } });
    assert.equal(scene.revision, 8);
    assert.equal(scene.currentItemIdentity, 'song-1');
    assert.equal(scene.displayMetadata.cacheProgress, expected);
    assert.equal(scene.displayMetadata.cacheDetail, '<b>plain text</b>');
    assert.equal(scene.displayMetadata.cacheStatus, 'downloading');
  }
  assert.equal(normalizePresentationScene({ displayMetadata: { cacheStatus: 'unknown' } }).displayMetadata.cacheStatus, '');
  assert.equal(normalizePresentationScene({ displayMetadata: { cacheStatus: 'queued' } }).displayMetadata.cacheStatus, 'pending');
  assert.equal(normalizePresentationScene({}).displayMetadata.cacheProgress, null);
});

test('Transition song cards carry only their own bounded cache state', () => {
  const statuses = ['queued', 'downloading', 'failed', 'ready', 'unknown'];
  const scene = normalizePresentationScene({ displayMetadata: { cacheStatus: 'failed' }, overlay: {
    visible: true, cacheStatus: 'queued', rows: statuses.map(cacheStatus => ({
      title: 'Song', requester: 'Alice', duration: '2:00', cacheStatus, mediaUrl: 'forbidden', cacheProgress: 50,
    })),
  } });
  assert.equal(scene.displayMetadata.cacheStatus, 'failed');
  assert.equal(scene.overlay.cacheStatus, 'pending');
  assert.deepEqual(scene.overlay.rows.map(row => row.cacheStatus), ['pending', 'downloading', 'failed', 'ready', '']);
  assert.deepEqual(Object.keys(scene.overlay.rows[0]).sort(), ['cacheStatus', 'duration', 'requester', 'title']);
  assert.equal(normalizePresentationScene({ overlay: { cacheStatus: 'unknown' } }).overlay.cacheStatus, '');
  assert.equal(normalizePresentationScene({ overlay: {} }).overlay.cacheStatus, '');
});
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const PresentationSceneTest = {
async setUpClass() {
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.module = path.join(path.join(ROOT, "static"), "presentation-scene.js");
this.source = readFileSync(this.module, "utf8");
},
async call(expression) {
let completed, script;
script = (`
const scene = require(` + String(JSON.stringify(String(this.module))) + `);
const result = ` + String(expression) + `;
process.stdout.write(JSON.stringify(result));
`);
completed = (await runNative(this.node, ["-e", script], process.env, 5 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_scene_normalizes_audience_visual_state_and_selected_video_url() {
let forbidden, result;
result = (await this.call(`
scene.normalizePresentationScene({
  generation: 7.8,
  revision: -4,
  currentItemIdentity: 123,
  title: "<b>Audience title</b>",
  displayMetadata: { requester: "Alice", duration: 90, detail: "UP" },
  theme: "unknown",
  videoUrl: "https://forbidden.invalid/video.mp4",
  currentTime: 21,
  playbackRate: 1.2,
  drift: 500,
  transport: "broadcast",
  overlay: { visible: true, rows: [] },
})
`));
assert.deepEqual(new Set((Symbol.iterator in Object(result) ? result : Object.keys(result))), new Set(["generation", "revision", "currentItemIdentity", "title", "videoUrl", "displayMetadata", "theme", "language", "overlay"]));
assert.deepEqual(result["generation"], 7);
assert.deepEqual(result["revision"], 0);
assert.deepEqual(result["currentItemIdentity"], "123");
assert.deepEqual(result["title"], "<b>Audience title</b>");
assert.deepEqual(result["videoUrl"], "https://forbidden.invalid/video.mp4");
assert.deepEqual(result["theme"], "light");
assert.deepEqual(result["language"], "zh");
for (const forbidden of iterableValues(["audioUrl", "currentTime", "predictedTime", "playbackRate", "drift", "seek", "transport"])) {
assert.ok(!contains(forbidden, result));
}
},
async test_overlay_is_bounded_to_five_safe_rows() {
let result;
result = (await this.call(`
scene.normalizeOverlay({
  visible: 1,
  heading: 55,
  deadline: -10,
  durationMs: "2500",
  rows: Array.from({ length: 8 }, (_, index) => ({
    title: \`Song \${index}\`,
    requester: index,
    duration: null,
    mediaUrl: "forbidden",
  })),
})
`));
assert.ok(hasContent(result["visible"]));
assert.deepEqual(result["heading"], "55");
assert.deepEqual(result["deadline"], 0);
assert.deepEqual(result["durationMs"], 2500);
assert.deepEqual(result["rows"].length, 5);
assert.deepEqual(result["rows"][4]["title"], "Song 4");
assert.deepEqual(new Set((Symbol.iterator in Object(result["rows"][0]) ? result["rows"][0] : Object.keys(result["rows"][0]))), new Set(["title", "requester", "duration", "cacheStatus"]));
},
async test_module_contains_no_playback_transport_or_follower_clock() {
let forbidden;
for (const forbidden of iterableValues(["BroadcastChannel", "localStorage", "playbackRate", "predictedTime", "driftMs", "audioUrl"])) {
assert.ok(!contains(forbidden, this.source));
}
}
};
test("PresentationSceneTest.test_scene_normalizes_audience_visual_state_and_selected_video_url", async () => { const instance = Object.create(PresentationSceneTest); await instance.setUpClass(); await instance.test_scene_normalizes_audience_visual_state_and_selected_video_url(); });
test("PresentationSceneTest.test_overlay_is_bounded_to_five_safe_rows", async () => { const instance = Object.create(PresentationSceneTest); await instance.setUpClass(); await instance.test_overlay_is_bounded_to_five_safe_rows(); });
test("PresentationSceneTest.test_module_contains_no_playback_transport_or_follower_clock", async () => { const instance = Object.create(PresentationSceneTest); await instance.setUpClass(); await instance.test_module_contains_no_playback_transport_or_follower_clock(); });
