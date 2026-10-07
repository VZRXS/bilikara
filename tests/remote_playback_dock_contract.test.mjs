import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, splitOnce, sourceIndex, countValues, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const RemotePlaybackDockTest = {
async setUpClass() {
this.node = process.execPath;
this.markup = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
this.styles = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
this.script = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.translations = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"));
},
async run_node(source) {
let completed;
if ((!this.node)) {
(() => { throw new Error("node is unavailable"); })();
}
completed = (await runNative(this.node, ["-e", source], process.env, 10 * 1000, root));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_dom_has_one_read_only_dock_one_sheet_and_one_control_owner() {
let count, dock, ids, interactive, item;
ids = Array.from(this.markup.matchAll(new RegExp("\\bid=\"([^\"]+)\"","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(Array.from(Array.from(iterableValues(Object.entries(countValues(ids)))) .filter(([item, count]) => ((count > 1)))).map(([item, count]) => item), []);
assert.deepEqual(countOccurrences(ids, "playback-dock"), 1);
assert.deepEqual(countOccurrences(ids, "playback-sheet"), 1);
assert.deepEqual(countOccurrences(ids, "player-control-panel"), 1);
assert.ok(!contains("now-playing-panel", this.markup));
assert.ok(!contains("floating-control-trigger", this.markup));
assert.ok(!contains("floating-player-control-panel", this.markup));
dock = this.markup.match(new RegExp("<button\\s+type=\"button\"\\s+id=\"playback-dock\".*?</button>","s"))[0];
assert.ok(contains("aria-haspopup=\"dialog\"", dock));
assert.ok(contains("aria-controls=\"playback-sheet\"", dock));
assert.ok(contains("aria-expanded=\"false\"", dock));
assert.deepEqual(countOccurrences(dock, "<button"), 1);
for (const interactive of iterableValues(["<a ", "<input", "<select", "<textarea"])) {
assert.ok(!contains(interactive, dock));
}
assert.ok(!contains("data-control-action", dock));
assert.ok(!contains("chevron", dock.toLowerCase()));
assert.ok(!contains("grabber", dock.toLowerCase()));
assert.deepEqual(countOccurrences(dock, "class=\"playback-dock-marquee-text\""), 2);
},
async test_sheet_header_and_content_order_match_the_product_contract() {
let collapse, header, marker, panel, panel_id, panel_start, positions, sequence, settings, sheet;
sheet = this.markup.slice(sourceIndex(this.markup, "id=\"playback-sheet\""), sourceIndex(this.markup, "id=\"remote-identity-modal\""));
header = sheet.slice(0, sourceIndex(sheet, "id=\"playback-sheet-body\""));
assert.ok(sourceIndex(header, "id=\"playback-sheet-title\"") < sourceIndex(header, "id=\"playback-sheet-collapse\""));
assert.ok(sourceIndex(header, "id=\"playback-sheet-collapse\"") < sourceIndex(header, "id=\"open-rating-button\""));
assert.ok(sourceIndex(header, "id=\"open-rating-button\"") < sourceIndex(header, "id=\"refresh-button\""));
collapse = header.match(new RegExp("<button[^>]+id=\"playback-sheet-collapse\".*?</button>","s"))[0];
assert.ok(contains("type=\"button\"", collapse));
assert.ok(contains("data-i18n-aria-label=\"remote.collapsePlaybackControls\"", collapse));
assert.ok(contains("<svg", collapse));
assert.ok(contains("d=\"m5 9 7 7 7-7\"", collapse));
sequence = ["class=\"playback-sheet-summary\"", "id=\"audio-variant-bar\"", "id=\"player-control-panel\"", "class=\"playback-sheet-secondary\""];
positions = Array.from(Array.from(iterableValues(sequence))).map((marker) => sourceIndex(sheet, marker));
assert.deepEqual(positions, Array.from(positions).sort((a, b) => typeof a === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0));
panel_start = sourceIndex(sheet, "id=\"player-control-panel\"");
panel = sheet.slice(panel_start, sourceIndex(sheet, "</section>", panel_start));
assert.deepEqual(Array.from(panel.matchAll(new RegExp("data-control-action=\"([^\"]+)\"","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)), ["seek-relative", "toggle-play", "seek-relative", "seek-absolute", "next-track"]);
assert.deepEqual(Array.from(panel.matchAll(new RegExp("data-delta=\"([^\"]+)\"","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)), ["-15", "15"]);
assert.ok(contains("id=\"playback-sheet-seek\"", panel));
assert.ok(contains("type=\"range\"", panel));
assert.ok(contains("id=\"playback-sheet-current-time\"", panel));
assert.ok(contains("id=\"playback-sheet-duration\"", panel));
assert.ok(!contains("playback-sheet-progress-block", sheet));
settings = sheet.match(new RegExp("<div class=\"playback-sheet-settings-card\">.*?</div>\\s*</section>\\s*</div>","s"))[0];
assert.ok(contains("class=\"playback-sheet-secondary\" aria-label=\"设置\" data-i18n-aria-label=\"settings.title\"", sheet));
assert.ok(!contains("playback-sheet-settings-title", sheet));
assert.deepEqual(countOccurrences(settings, "class=\"remote-setting-panel\""), 3);
for (const panel_id of iterableValues(["remote-av-sync-panel", "remote-volume-panel", "remote-key-shift-panel"])) {
assert.ok(contains(("id=\"" + String(panel_id) + "\""), settings));
}
},
async test_cover_contract_reuses_normalizer_and_has_fixed_fallbacks() {
let image, image_id;
assert.ok(contains("window.BilikaraSongDetail?.normalizeBilibiliImageUrl?.(rawCoverUrl)", this.script));
assert.ok(contains("return safeHttpUrl(normalizedCoverUrl);", this.script));
assert.deepEqual(countOccurrences(this.markup, "class=\"playback-cover-fallback\" src=\"/pic/icon.png\""), 2);
assert.deepEqual(countOccurrences(this.markup, "class=\"playback-cover-image hidden\""), 2);
for (const image_id of iterableValues(["playback-dock-cover-image", "playback-sheet-cover-image"])) {
image = this.markup.match(new RegExp(("<img[^>]+id=\"" + String(image_id) + "\"[^>]+>"),"s"))[0];
assert.ok(contains("referrerpolicy=\"no-referrer\"", image));
assert.ok(contains("decoding=\"async\"", image));
assert.ok(contains("alt=\"\"", image));
}
assert.ok(!contains("/api/cover", this.script));
assert.ok(!contains("/api/metadata", this.script));
},
async test_cover_sync_avoids_duplicate_requests_and_rejects_late_errors() {
let cover_source, result;
cover_source = this.script.slice(sourceIndex(this.script, "function safeHttpUrl"), sourceIndex(this.script, "function ratingOwnerUid"));
result = (await this.run_node((`
class ClassList {
  constructor() { this.values = new Set(["hidden"]); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  toggle(name, force) { if (force) this.add(name); else this.remove(name); return Boolean(force); }
  contains(name) { return this.values.has(name); }
}
class Image {
  constructor() { this.dataset = {}; this.classList = new ClassList(); this.assignments = 0; this.attributes = new Set(); }
  set src(value) { this._src = value; this.assignments += 1; this.attributes.add("src"); }
  get src() { return this._src || ""; }
  removeAttribute(name) { this.attributes.delete(name); if (name === "src") this._src = ""; }
}
const window = {
  location: { href: "https://remote.test/remote" },
  BilikaraSongDetail: {
    normalizeBilibiliImageUrl(value) {
      if (value.startsWith("//")) return \`https:\${value}\`;
      if (value.startsWith("http://") && value.includes("hdslb.com")) return \`https://\${value.slice(7)}\`;
      return value;
    },
  },
};
` + String(cover_source) + `
const image = new Image();
const protocolRelative = normalizedPlaybackCoverUrl({ cover_url: "//i0.hdslb.com/a.jpg" });
const normalizedHttp = normalizedPlaybackCoverUrl({ cover_url: "http://i1.hdslb.com/b.jpg" });
const unsafe = normalizedPlaybackCoverUrl({ cover_url: "javascript:alert(1)" });
syncPlaybackCoverImage(image, protocolRelative, "g1|i1");
const oldError = image.onerror;
syncPlaybackCoverImage(image, protocolRelative, "g1|i1");
const assignmentsAfterRepeat = image.assignments;
syncPlaybackCoverImage(image, protocolRelative, "g2|same-cover");
const sameCoverLoad = image.onload;
sameCoverLoad();
oldError();
const visibleAfterSameCoverLateError = !image.classList.contains("hidden");
const assignmentsAfterIdentityChange = image.assignments;
syncPlaybackCoverImage(image, normalizedHttp, "g3|i2");
const newLoad = image.onload;
newLoad();
oldError();
const visibleAfterLateError = !image.classList.contains("hidden");
image.onerror();
const hiddenAfterCurrentError = image.classList.contains("hidden");
syncPlaybackCoverImage(image, normalizedHttp, "g2|i2");
const assignmentsAfterFailedRepeat = image.assignments;
syncPlaybackCoverImage(image, "", "empty");
console.log(JSON.stringify({
  protocolRelative,
  normalizedHttp,
  unsafe,
  assignmentsAfterRepeat,
  visibleAfterSameCoverLateError,
  assignmentsAfterIdentityChange,
  visibleAfterLateError,
  hiddenAfterCurrentError,
  assignmentsAfterFailedRepeat,
  srcRemoved: !image.attributes.has("src"),
}));
`)));
assert.deepEqual(result["protocolRelative"], "https://i0.hdslb.com/a.jpg");
assert.deepEqual(result["normalizedHttp"], "https://i1.hdslb.com/b.jpg");
assert.deepEqual(result["unsafe"], "");
assert.deepEqual(result["assignmentsAfterRepeat"], 1);
assert.ok(hasContent(result["visibleAfterSameCoverLateError"]));
assert.deepEqual(result["assignmentsAfterIdentityChange"], 1);
assert.ok(hasContent(result["visibleAfterLateError"]));
assert.ok(hasContent(result["hiddenAfterCurrentError"]));
assert.deepEqual(result["assignmentsAfterFailedRepeat"], 2);
assert.ok(hasContent(result["srcRemoved"]));
},
async test_clock_progress_uses_one_paint_path_and_one_timer() {
let clock_source, progress_rule;
assert.deepEqual(countOccurrences(this.script, "window.setInterval(paintCurrentPlaybackClock, 1000)"), 1);
clock_source = this.script.slice(sourceIndex(this.script, "function formatPlaybackClockSeconds"), sourceIndex(this.script, "function formatBytes"));
assert.ok(contains("paintPlaybackClockSurfaces();", clock_source));
assert.ok(contains("playbackDockClock", clock_source));
assert.ok(contains("playbackSheetClock", clock_source));
assert.ok(contains("playbackSheetCurrentTime", clock_source));
assert.ok(contains("playbackSheetDuration", clock_source));
assert.ok(contains("playbackSheetSeek", clock_source));
assert.ok(contains("setRangeFillPercent(elements.playbackSheetSeek, ratio * 100)", clock_source));
assert.ok(contains("style.transform = `scaleX(${ratio})`", clock_source));
progress_rule = this.styles.match(new RegExp("\\.playback-dock-progress\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("background: var(--accent-soft)", progress_rule));
assert.ok(contains("transform: scaleX(0)", progress_rule));
assert.ok(contains("transform-origin: left center", progress_rule));
assert.ok(!contains("width:", progress_rule));
assert.ok(!contains("transition:", progress_rule));
assert.ok(!contains("border-radius:", progress_rule));
assert.ok(!contains("--playback-progress-fill", this.styles));
},
async test_ratio_is_finite_clamped_and_unknown_duration_is_hidden() {
let ratio_source, result;
ratio_source = this.script.slice(sourceIndex(this.script, "function playbackProgressRatio"), sourceIndex(this.script, "function paintPlaybackClockSurfaces"));
result = (await this.run_node((`
` + String(ratio_source) + `
console.log(JSON.stringify({
  zero: playbackProgressRatio(1, 0),
  nan: playbackProgressRatio(Number.NaN, 20),
  low: playbackProgressRatio(-5, 20),
  middle: playbackProgressRatio(5, 20),
  high: playbackProgressRatio(25, 20),
}));
`)));
assert.deepEqual(result, {["zero"]: 0, ["nan"]: 0, ["low"]: 0, ["middle"]: 0.25, ["high"]: 1});
assert.ok(contains("classList.toggle(\"is-unknown-duration\", !hasKnownDuration)", this.script));
assert.ok(contains("classList.toggle(\"has-progress\", hasKnownDuration)", this.script));
},
async test_safe_area_cover_progress_and_ready_state_match_review_delta() {
let dock_cover_rule, dock_rule, sheet_cover_rule;
dock_rule = this.styles.match(new RegExp("\\.playback-dock\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("bottom: max(12px, env(safe-area-inset-bottom, 0px))", dock_rule));
assert.ok(contains("left: calc(12px + env(safe-area-inset-left, 0px))", dock_rule));
assert.ok(contains("right: calc(12px + env(safe-area-inset-right, 0px))", dock_rule));
assert.ok(contains("viewport-fit=cover", this.markup));
dock_cover_rule = this.styles.match(new RegExp("\\.playback-dock-cover\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: 82px", dock_cover_rule));
assert.ok(contains("height: 46px", dock_cover_rule));
assert.ok(contains("z-index: 1", dock_cover_rule));
assert.ok(contains("background: var(--playback-dock-bg)", dock_cover_rule));
sheet_cover_rule = this.styles.match(new RegExp("\\.playback-sheet-cover\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("aspect-ratio: 16 / 9", sheet_cover_rule));
assert.deepEqual(countOccurrences(this.markup, "class=\"playback-sheet-settings-card\""), 1);
assert.ok(contains(".player-progress-times", this.styles));
assert.ok(contains(".player-progress-range::-webkit-slider-thumb", this.styles));
assert.ok(!contains("playback-sheet-progress-block", this.markup));
assert.ok(contains("function mountRemoteContextualTooltip(wrap)", this.script));
assert.ok(contains("playbackPanel.append(tooltip)", this.script));
assert.ok(contains("const widthLimit = Math.min(320,", this.script));
assert.ok(contains("tooltip.style.width = \"max-content\"", this.script));
assert.ok(contains("tooltip.style.maxWidth", this.script));
},
async test_toast_is_above_every_remote_playback_and_access_overlay() {
let layer, layer_names, layers, name, rule, selector, selector_layers;
layer_names = ["dock", "modal", "gate", "toast"];
layers = Object.fromEntries(Array.from(Array.from(iterableValues(layer_names))).map((name) => [name, Number(this.styles.match(new RegExp(("--remote-layer-" + String(name) + ":\\s*(\\d+)"),""))[1])]));
assert.deepEqual(Array.from(Array.from(iterableValues(layer_names))).map((name) => layers[name]), Array.from(Object.values(layers)).sort((a, b) => typeof a === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0));
selector_layers = {[".playback-dock"]: "dock", [".remote-shell > .song-detail-view"]: "modal", [".playback-sheet"]: "modal", [".binding-sheet"]: "modal", [".rating-modal"]: "modal", [".remote-identity-modal"]: "gate", [".internet-remote-join-overlay"]: "gate", [".app-toast"]: "toast"};
for (const [selector, layer] of iterableValues(Object.entries(selector_layers))) {
rule = this.styles.match(new RegExp((String(RegExp.escape(selector)) + "\\s*\\{([^}]*)\\}"),""))[1];
assert.ok(contains(("z-index: var(--remote-layer-" + String(layer) + ")"), rule), selector);
}
},
async test_overflowing_dock_copy_uses_one_shot_measurement_and_reduced_motion_fallback() {
let cache_label_source, cache_sync_source, marquee_source, reduced_motion, result, tooltip_owner_rule, tooltip_rule, volume_panel;
marquee_source = this.script.slice(sourceIndex(this.script, "function setPlaybackDockMarqueeText"), sourceIndex(this.script, "function ratingOwnerUid"));
assert.ok(contains("textNode.scrollWidth", marquee_source));
assert.ok(contains("container.clientWidth", marquee_source));
assert.ok(contains("container.classList.add(\"is-scrolling\")", marquee_source));
assert.ok(contains("window.requestAnimationFrame", marquee_source));
assert.ok(!contains("setInterval", marquee_source));
assert.ok(!contains("requestAnimationFrame(() => requestAnimationFrame", marquee_source));
assert.ok(contains("@keyframes playback-dock-marquee", this.styles));
reduced_motion = this.styles.slice(sourceIndex(this.styles, "@media (prefers-reduced-motion: reduce)"), undefined);
assert.ok(contains(".playback-dock-title.is-scrolling", reduced_motion));
assert.ok(contains("animation: none", reduced_motion));
tooltip_rule = this.styles.match(new RegExp("\\.remote-tooltip-bubble\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: max-content", tooltip_rule));
assert.ok(contains("max-width: min(320px, calc(100vw - 48px))", tooltip_rule));
assert.ok(contains("let direction = \"up\";", this.script));
assert.ok(contains("spaceAbove < height && spaceBelow >= height", this.script));
tooltip_owner_rule = this.styles.match(new RegExp("\\.playback-sheet-panel > \\.remote-tooltip-bubble\\.is-portaled\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("z-index: 30", tooltip_owner_rule));
volume_panel = this.markup.slice(sourceIndex(this.markup, "id=\"remote-volume-panel\""), sourceIndex(this.markup, "id=\"remote-key-shift-panel\""));
assert.ok(contains("remote-info-button", volume_panel));
assert.ok(contains("aria-describedby=\"remote-volume-info\"", volume_panel));
assert.ok(contains("data-i18n=\"player.volumeBoostHelp\"", volume_panel));
cache_label_source = this.script.slice(sourceIndex(this.script, "function currentCacheStateLabel"), sourceIndex(this.script, "function cacheProgressPercentForItem"));
result = (await this.run_node((`
` + String(cache_label_source) + `
console.log(JSON.stringify({ ready: currentCacheStateLabel({ cache_status: "ready" }) }));
`)));
assert.deepEqual(result["ready"], "");
cache_sync_source = this.script.slice(sourceIndex(this.script, "function syncCurrentCacheState"), sourceIndex(this.script, "function currentCacheStateLabel"));
assert.ok(contains("classList.toggle(\"hidden\", ready || (!label && !showRetry))", cache_sync_source));
assert.ok(contains("setAttribute(\"aria-hidden\", String(ready))", cache_sync_source));
},
async test_audio_variant_bar_is_one_row_with_one_scrollable_popover_owner() {
let bar_rule, button_label_rule, listener_source, popover_rule, render_source, scrollable_rule, toggle_icon_rule;
render_source = this.script.slice(sourceIndex(this.script, "function audioVariantPopover"), sourceIndex(this.script, "function boundedRemoteVolumePercent"));
assert.deepEqual(countOccurrences(this.markup, "id=\"audio-variant-popover\""), 1);
assert.ok(sourceIndex(this.markup, "id=\"audio-variant-popover\"") > sourceIndex(this.markup, "id=\"playback-sheet-body\""));
assert.ok(contains("audioVariantPopover: document.getElementById(\"audio-variant-popover\")", this.script));
assert.ok(contains("return elements.audioVariantPopover", render_source));
assert.ok(!contains("\"audio-variant-summary\"", render_source));
assert.ok(contains("label.className = \"audio-variant-button-label\"", render_source));
assert.ok(contains("toggleButton.setAttribute(\"aria-controls\", \"audio-variant-popover\")", render_source));
assert.ok(contains("toggleButton.setAttribute(\"aria-haspopup\", \"true\")", render_source));
assert.ok(contains("popover.hidden = !nextOpen", render_source));
assert.ok(contains("window.requestAnimationFrame(positionAudioVariantPopover)", render_source));
assert.ok(contains("const direction = spaceAbove >= minimumUsefulHeight ? \"up\" : \"down\"", render_source));
assert.ok(contains("elements.audioVariantPopover?.replaceChildren(list.cloneNode(true))", render_source));
assert.ok(contains("document.createElementNS(\"http://www.w3.org/2000/svg\", \"svg\")", render_source));
assert.ok(contains("togglePath.setAttribute(\"d\", \"m6 9 6 6 6-6\")", render_source));
assert.ok(!contains("toggleIcon.textContent", render_source));
assert.deepEqual(countOccurrences(render_source, "button.className = \"audio-variant-button\""), 1);
assert.deepEqual(countOccurrences(render_source, "list.appendChild(button)"), 1);
bar_rule = this.styles.match(new RegExp("\\.audio-variant-bar\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("display: flex", bar_rule));
assert.ok(contains("min-height: 44px", bar_rule));
assert.ok(contains("elements.audioVariantBar.append(list, toggleButton)", render_source));
assert.ok(contains("button.classList.toggle(\"hidden\", !show)", render_source));
assert.ok(contains("const fits = list.scrollWidth <= list.clientWidth + 1", render_source));
popover_rule = this.styles.match(new RegExp("\\.audio-variant-popover\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("position: absolute", popover_rule));
assert.ok(contains("z-index: 40", popover_rule));
assert.ok(contains("overflow-y: hidden", popover_rule));
assert.ok(contains("max-height: 240px", popover_rule));
assert.ok(contains("touch-action: manipulation", popover_rule));
assert.ok(contains("background: var(--audio-variant-popover-bg)", popover_rule));
scrollable_rule = this.styles.match(new RegExp("\\.audio-variant-popover\\.is-scrollable\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("overflow-y: auto", scrollable_rule));
assert.ok(contains("touch-action: pan-y", scrollable_rule));
assert.ok(contains("scrollbar-width: thin", scrollable_rule));
assert.ok(contains("popover.classList.toggle(\"is-scrollable\", scrollable)", render_source));
assert.ok(contains("popover.scrollHeight || 0", render_source));
assert.ok(contains("visibleHeight - borderHeight + 1", render_source));
button_label_rule = this.styles.match(new RegExp("\\.audio-variant-button-label\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("overflow: hidden", button_label_rule));
assert.ok(contains("white-space: nowrap", button_label_rule));
assert.ok(contains("text-overflow: ellipsis", button_label_rule));
toggle_icon_rule = this.styles.match(new RegExp("\\.audio-variant-toggle svg\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: 18px", toggle_icon_rule));
assert.ok(contains("height: 18px", toggle_icon_rule));
listener_source = this.script.slice(sourceIndex(this.script, "elements.audioVariantBar.addEventListener(\"click\""), sourceIndex(this.script, "elements.playerControlPanel.addEventListener(\"click\""));
assert.ok(contains("setAudioVariantPopoverOpen(!state.audioVariantBarExpanded)", listener_source));
assert.ok(contains("elements.audioVariantPopover?.addEventListener(\"click\"", listener_source));
assert.ok(contains("setAudioVariantPopoverOpen(false)", listener_source));
assert.ok(!contains("fetch(", listener_source));
},
async test_modal_contract_has_no_gestures_and_restores_dock_focus() {
let forbidden, sheet_source;
sheet_source = this.script.slice(sourceIndex(this.script, "function playbackSheetIsOpen"), sourceIndex(this.script, "async function startRemoteSession"));
for (const forbidden of iterableValues(["touchstart", "touchmove", "touchend", "pointermove", "mousedown", "mousemove", "requestAnimationFrame"])) {
assert.ok(!contains(forbidden, sheet_source));
}
assert.ok(contains("elements.playbackDock?.addEventListener(\"click\", openPlaybackSheet)", sheet_source));
assert.ok(contains("elements.playbackSheetCollapse?.addEventListener(\"click\"", sheet_source));
assert.ok(contains("elements.playbackSheetBackdrop?.addEventListener(\"click\"", sheet_source));
assert.ok(contains("elements.playbackDock.focus({ preventScroll: true })", sheet_source));
assert.ok(contains("elements.playbackSheetCollapse?.focus?.({ preventScroll: true })", sheet_source));
assert.ok(contains("document.body.classList.add(\"playback-sheet-scroll-locked\")", sheet_source));
assert.ok(!contains("window.scrollTo(", sheet_source));
assert.ok(!contains("document.body.style.top", sheet_source));
assert.ok(contains("if (immediate || prefersReducedMotion())", sheet_source));
},
async test_scroll_lock_waits_for_the_last_modal_owner() {
let script, source;
source = this.script.slice(sourceIndex(this.script, "function unlockPlaybackSheetDocumentScroll()"), sourceIndex(this.script, "function trapFocusWithin("));
script = concatenate(concatenate(`
const assert = require('node:assert/strict');
const state = {};
const elements = { historyExportDialog: { open: false } };
let scrolls = 0;
const window = { scrollTo() { scrolls++; } };
const document = { body: { style: {}, classList: { remove() {} } } };
`, source), `
for (const owner of ['sheet', 'rating', 'export']) {
  const lock = { scrollY: 12 };
  state.playbackSheetScrollLock = lock;
  state.playbackSheetOpen = owner === 'sheet';
  state.ratingPromptElement = owner === 'rating' ? {} : null;
  elements.historyExportDialog.open = owner === 'export';
  const previousScrolls = scrolls;
  unlockPlaybackSheetDocumentScroll();
  assert.equal(state.playbackSheetScrollLock, lock);
  assert.equal(scrolls, previousScrolls);
  state.playbackSheetOpen = false;
  state.ratingPromptElement = null;
  elements.historyExportDialog.open = false;
  unlockPlaybackSheetDocumentScroll();
  assert.equal(state.playbackSheetScrollLock, null);
  assert.equal(scrolls, previousScrolls, "Unlock must not change the document scroll position");
}
`);
(await checked("node", ["-e", script], root));
},
async test_other_true_modals_retire_playback_ownership_first() {
let end_marker, escape_owner, identity_render, modal_openers, rating_open, source, start_marker;
modal_openers = [["function openBindingSheet", "function closeBindingSheet"], ["function openGatchaFavlistSheet", "function closeGatchaFavlistSheet"], ["async function openPoolConfigSheet", "function closePoolConfigSheet"], ["function openReorderConfirmSheet", "function closeReorderConfirmSheet"]];
for (const [start_marker, end_marker] of iterableValues(modal_openers)) {
source = this.script.slice(sourceIndex(this.script, start_marker), sourceIndex(this.script, end_marker));
assert.ok(contains("retireTransientPlaybackModalForModal();", source));
}
identity_render = this.script.slice(sourceIndex(this.script, "function renderRemoteIdentity"), sourceIndex(this.script, "function applyRemoteIdentity"));
assert.ok(contains("retireTransientPlaybackModalForModal();", identity_render));
rating_open = this.script.slice(sourceIndex(this.script, "function openRatingPrompt"), sourceIndex(this.script, "function currentPlaybackClockSeconds"));
assert.ok(!contains("retirePlaybackSheetForModal()", rating_open));
assert.ok(contains("if (!playbackSheetIsOpen()) unlockPlaybackSheetDocumentScroll();", this.script));
assert.ok(contains("elements.playbackSheet.inert = Boolean(state.ratingPromptElement", this.script));
escape_owner = this.script.slice(sourceIndex(this.script, "document.addEventListener(\"keydown\", (event) => {"), sourceIndex(this.script, "document.addEventListener(\"visibilitychange\""));
assert.ok(sourceIndex(escape_owner, "if (state.ratingPromptElement)") < sourceIndex(escape_owner, "else if (state.audioVariantBarExpanded)"));
assert.ok(sourceIndex(escape_owner, "else if (state.audioVariantBarExpanded)") < sourceIndex(escape_owner, "else if (playbackSheetIsOpen())"));
},
async test_sheet_css_uses_measured_two_column_threshold_and_one_scroller() {
let body_rule, column, header_rule, portrait_rule, rule, sheet_rule;
header_rule = this.styles.match(new RegExp("\\.playback-sheet-status-header\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr)", header_rule));
body_rule = this.styles.match(new RegExp("\\.playback-sheet-body\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("overflow-y: auto", body_rule));
assert.ok(contains("overflow-x: hidden", body_rule));
for (const column of iterableValues([".playback-sheet-primary", ".playback-sheet-secondary"])) {
rule = splitOnce(this.styles.slice(sourceIndex(this.styles, column), undefined), "}")[0];
assert.ok(!contains("overflow-y", rule));
}
assert.ok(contains("@media (min-width: 700px)", this.styles));
assert.ok(contains("@media (min-width: 700px) and (max-height: 520px)", this.styles));
portrait_rule = this.styles.slice(sourceIndex(this.styles, "@media (max-width: 699px) and (min-height: 521px)"), sourceIndex(this.styles, "@media (max-width: 360px)"));
assert.ok(contains("max-height: calc(100dvh - max(12px, var(--remote-safe-area-top)))", portrait_rule));
sheet_rule = this.styles.match(new RegExp("\\.playback-sheet\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("padding: max(12px, var(--remote-safe-area-top))", sheet_rule));
assert.ok(contains("var(--remote-safe-area-left)", sheet_rule));
assert.ok(contains("width: min(880px, 100%)", this.styles));
assert.ok(!contains("repeat(3", this.styles.slice(sourceIndex(this.styles, "/* Remote playback dock"), undefined)));
},
async test_new_accessible_labels_exist_in_all_languages() {
let key, language, messages;
for (const messages of iterableValues(Object.values(this.translations["languages"]))) {
for (const key of iterableValues(["remote.openPlaybackControls", "remote.collapsePlaybackControls", "remote.playbackControlsTitle", "remote.playbackGroupLabel", "remote.transportControlsLabel", "remote.fullMetadataText", "remote.showFullTitle", "remote.showFullRequester", "remote.showFullOwner"])) {
assert.ok(hasContent((Object.hasOwn(messages, key) ? messages[key] : null)), key);
}
assert.ok(hasContent((Object.hasOwn(messages, "remote.controlSentSeek") ? messages["remote.controlSentSeek"] : null)));
}
assert.deepEqual(Object.fromEntries(Array.from(Array.from(iterableValues(Object.entries(this.translations["languages"])))).map(([language, messages]) => [language, messages["player.tag"]])), {["zh"]: "正在播放", ["en"]: "Now Playing", ["ja"]: "再生中"});
},
async test_transport_strip_uses_one_stable_svg_control_tree() {
let button, buttons, emoji, next_icon_rule, panel, panel_start, play_icon_rule, render_source, render_start, seek_icon_rule, sheet;
sheet = this.markup.slice(sourceIndex(this.markup, "id=\"playback-sheet\""), sourceIndex(this.markup, "id=\"remote-identity-modal\""));
panel_start = sourceIndex(sheet, "id=\"player-control-panel\"");
panel = sheet.slice(panel_start, sourceIndex(sheet, "</section>", panel_start));
buttons = Array.from(panel.matchAll(new RegExp("<button\\b.*?</button>","gs")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(buttons.length, 4);
assert.ok(hasContent(Array.from(Array.from(iterableValues(buttons))).map((button) => (contains("<svg", button))).every(Boolean)));
assert.deepEqual(countOccurrences(panel, "data-player-icon=\"play\""), 1);
assert.deepEqual(countOccurrences(panel, "data-player-icon=\"pause\""), 1);
assert.deepEqual(countOccurrences(panel, "<svg"), 5);
for (const emoji of iterableValues(["⏪", "⏩", "⏯", "⏭", "▶️", "⏸️", "🔁"])) {
assert.ok(!contains(emoji, panel));
}
assert.deepEqual(countOccurrences(panel, "dominant-baseline=\"central\""), 2);
assert.deepEqual(countOccurrences(panel, "transform=\"translate(0 2)\""), 2);
play_icon_rule = this.styles.match(new RegExp("\\.player-control-row \\.player-play-toggle svg\\s*\\{([^}]*)\\}",""))[1];
next_icon_rule = this.styles.match(new RegExp("\\.player-control-row \\.player-next-button svg\\s*\\{([^}]*)\\}",""))[1];
seek_icon_rule = this.styles.match(new RegExp("\\.player-control-row \\.player-seek-button svg\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: 30px", play_icon_rule));
assert.ok(contains("height: 30px", play_icon_rule));
assert.ok(contains("width: 28px", next_icon_rule));
assert.ok(contains("height: 28px", next_icon_rule));
assert.ok(contains("place-self: center", seek_icon_rule));
render_start = sourceIndex(this.script, "function renderPlayerControls");
render_source = this.script.slice(render_start, sourceIndex(this.script, "function renderListHeader", render_start));
assert.ok(!contains("btn.textContent", render_source));
assert.ok(!contains("innerHTML", render_source));
assert.ok(contains("querySelector('[data-player-icon=\"play\"]')", render_source));
assert.ok(contains("querySelector('[data-player-icon=\"pause\"]')", render_source));
assert.ok(contains("setAttribute(\"aria-pressed\", String(!isPaused))", render_source));
},
async test_transport_grid_keeps_one_row_at_375_and_320_widths() {
let declaration, phone_rules, progress_rule, range_rule, row_rule, transport_button_rule;
row_rule = this.styles.match(new RegExp("\\.player-control-row\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("grid-template-columns: 44px 48px 44px minmax(88px, 1fr) 44px", row_rule));
assert.ok(contains("gap: clamp(4px, 1.2vw, 6px)", row_rule));
assert.ok(contains("max-width: none", row_rule));
progress_rule = this.styles.match(new RegExp("\\.player-progress-unit\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("min-width: 88px", progress_rule));
assert.ok(contains("height: 48px", progress_rule));
range_rule = this.styles.match(new RegExp("\\.player-progress-range\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("height: 44px", range_rule));
transport_button_rule = this.styles.match(new RegExp("\\.player-control-row \\.player-transport-button\\s*\\{([^}]*)\\}",""))[1];
for (const declaration of iterableValues(["width: 44px", "min-width: 44px", "height: 44px"])) {
assert.ok(contains(declaration, transport_button_rule));
}
phone_rules = this.styles.slice(sourceIndex(this.styles, "@media (max-width: 520px)"), sourceIndex(this.styles, ".rating-modal {"));
assert.ok(!contains(".player-control-row", phone_rules));
},
async test_metadata_allocation_is_priority_driven_and_tick_independent() {
let adaptive, clock, field_rule, owner_rule;
assert.deepEqual(countOccurrences(this.markup, "data-playback-metadata-field=\"title\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-playback-metadata-field=\"requester\""), 1);
assert.deepEqual(countOccurrences(this.markup, "data-playback-metadata-field=\"owner\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"playback-metadata-popover\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"playback-metadata-popover-text\""), 1);
adaptive = this.script.slice(sourceIndex(this.script, "function playbackMetadataEntries"), sourceIndex(this.script, "function renderCurrentItem"));
assert.ok(contains("for (const key of [\"title\", \"requester\", \"owner\"])", adaptive));
assert.ok(contains("if (fittingExtraLines < availableExtraLines)", adaptive));
assert.ok(contains("break;", adaptive));
assert.ok(contains("naturalLines", adaptive));
assert.ok(contains("visibleLines", adaptive));
assert.ok(contains("availableSummaryHeight", adaptive));
assert.ok(contains("playbackSheetMaximumPanelHeight()", adaptive));
assert.ok(contains("window.visualViewport?.height", adaptive));
assert.ok(!contains("currentPlaybackClockSeconds", adaptive));
assert.ok(!contains("setInterval", adaptive));
assert.ok(!contains("EventSource", adaptive));
assert.ok(!contains("ResizeObserver", adaptive));
assert.deepEqual(countOccurrences(adaptive, "window.requestAnimationFrame"), 1);
clock = this.script.slice(sourceIndex(this.script, "function paintPlaybackClockSurfaces"), sourceIndex(this.script, "function clearCurrentPlaybackClock"));
assert.ok(!contains("schedulePlaybackSheetAdaptiveLayout", clock));
field_rule = this.styles.match(new RegExp("\\.playback-metadata-field\\.is-clamped \\.playback-metadata-text\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("-webkit-line-clamp: var(--playback-metadata-lines, 1)", field_rule));
assert.ok(contains("overflow: hidden", field_rule));
owner_rule = this.styles.match(new RegExp("\\.playback-metadata-field\\[data-playback-metadata-field=\"owner\"\\] \\.owner-badge-name\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("white-space: normal", owner_rule));
assert.ok(contains("overflow-wrap: anywhere", owner_rule));
},
async test_full_text_popover_is_one_non_modal_text_only_owner() {
let declaration, escape_source, event_source, popover, popover_rule, source;
popover = this.markup.match(new RegExp("<div\\s+id=\"playback-metadata-popover\".*?</div>","s"))[0];
assert.ok(contains("role=\"tooltip\"", popover));
assert.ok(!contains("aria-modal=\"true\"", popover));
assert.ok(contains("data-i18n-aria-label=\"remote.fullMetadataText\"", popover));
assert.ok(!contains("tabindex=\"0\"", popover));
source = this.script.slice(sourceIndex(this.script, "function clearPlaybackMetadataPopoverPosition"), sourceIndex(this.script, "function playbackCssPixels"));
assert.ok(contains("elements.playbackMetadataPopoverText.textContent = fullText", source));
assert.ok(!contains("innerHTML", source));
assert.ok(contains("field === \"owner\"", source));
assert.ok(contains(".querySelector(\".owner-badge-name\")", source));
assert.ok(contains("closePlaybackMetadataPopover()", source));
assert.ok(contains("positionPlaybackMetadataPopover()", source));
assert.ok(contains("setAudioVariantPopoverOpen(false)", source));
assert.ok(contains("closeRemoteContextualInfo()", source));
assert.ok(!contains("playbackMetadataPopover.focus", source));
assert.ok(contains("Math.min(320, boundaryRight - boundaryLeft)", source));
event_source = this.script.slice(sourceIndex(this.script, "elements.playbackSheetSummaryCopy?.addEventListener(\"click\""), sourceIndex(this.script, "elements.refreshButton.addEventListener(\"click\""));
assert.ok(contains("event.key !== \"Enter\" && event.key !== \" \"", event_source));
assert.ok(contains("!event.target.closest(\"#playback-metadata-popover\")", event_source));
assert.ok(contains("closePlaybackMetadataPopover({ restoreFocus: true })", event_source));
escape_source = this.script.slice(sourceIndex(this.script, "document.addEventListener(\"keydown\"", sourceIndex(this.script, "elements.playbackSheetSummaryCopy?.addEventListener(\"click\"")), sourceIndex(this.script, "window.addEventListener(\"resize\", scheduleRemoteContextualTooltipPositionSync)"));
assert.ok(sourceIndex(escape_source, "closePlaybackMetadataPopover({ restoreFocus: true })") < sourceIndex(escape_source, "closeRemoteContextualInfo()"));
popover_rule = this.styles.match(new RegExp("\\.playback-metadata-popover\\s*\\{([^}]*)\\}",""))[1];
for (const declaration of iterableValues(["z-index: 45", "overflow: visible", "user-select: text", "overscroll-behavior: contain"])) {
assert.ok(contains(declaration, popover_rule));
}
const text_rule = this.styles.match(new RegExp("\\.playback-metadata-popover p\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("overflow: auto", text_rule));
assert.ok(contains("overscroll-behavior: contain", text_rule));
assert.ok(contains("playbackMetadataPopoverText.style.maxHeight", source));
assert.ok(contains("popover.showPopover()", source));
assert.ok(contains("popover.hidePopover()", source));
assert.ok(contains("popover.__bilikaraCloseSequence !== closing", source));
assert.ok(!contains("color:", popover_rule));
assert.ok(!contains("max-width:", popover_rule));
},
async test_remote_setting_state_icons_are_stable_inline_svg_nodes() {
let attribute, button, button_id, icon_source, state_name, states, wide;
for (const [button_id, attribute, states] of iterableValues([["remote-av-delay-lock-button", "data-av-lock-icon", ["unlocked", "locked"]], ["remote-volume-mute-button", "data-volume-icon", ["unmuted", "muted"]]])) {
button = this.markup.match(new RegExp(("<button[^>]+id=\"" + String(button_id) + "\".*?</button>"),"s"))[0];
assert.deepEqual(countOccurrences(button, "<svg"), 2);
assert.doesNotMatch(button, new RegExp("[\ud83d\udd0a\ud83d\udd07\ud83d\udd13\ud83d\udd12]",""));
for (const state_name of iterableValues(states)) {
assert.deepEqual(countOccurrences(button, (String(attribute) + "=\"" + String(state_name) + "\"")), 1);
}
assert.deepEqual(countOccurrences(button, "aria-hidden=\"true\""), 2);
assert.deepEqual(countOccurrences(button, "focusable=\"false\""), 2);
}
icon_source = this.script.slice(sourceIndex(this.script, "function setRemoteIconVisibility"), sourceIndex(this.script, "function renderRemoteKeyShiftControls"));
assert.ok(contains("icon.classList.toggle(\"hidden\"", icon_source));
assert.ok(contains("\"data-av-lock-icon\"", icon_source));
assert.ok(contains("\"data-volume-icon\"", icon_source));
assert.ok(!contains("remoteAvDelayLockButton.textContent", icon_source));
assert.ok(!contains("remoteVolumeMuteButton.textContent", icon_source));
wide = this.styles.slice(sourceIndex(this.styles, "@media (min-width: 700px)"), undefined);
assert.ok(contains("scrollbar-gutter: auto", wide));
assert.ok(!contains("scrollbar-gutter: stable", wide));
},
async test_sheet_is_content_sized_and_transport_reuses_one_dom_in_two_modes() {
let adaptive, body_rule, declaration, panel_rule, primary_rule, sheet_play, sheet_row, spacious, wide;
body_rule = this.styles.match(new RegExp("\\.playback-sheet-body\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("flex: 0 1 auto", body_rule));
assert.ok(contains("padding: 8px 16px 10px", body_rule));
panel_rule = this.styles.match(new RegExp("\\.playback-sheet-panel\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("padding-bottom: var(--remote-safe-area-bottom)", panel_rule));
primary_rule = this.styles.match(new RegExp("\\.playback-sheet-primary\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("display: flex", primary_rule));
assert.ok(contains("flex-direction: column", primary_rule));
wide = this.styles.slice(sourceIndex(this.styles, "@media (min-width: 700px)"), undefined);
assert.ok(contains(".playback-sheet-primary .playback-sheet-playback-group", wide));
assert.match(wide, new RegExp("\\.playback-sheet-primary \\.playback-sheet-playback-group\\s*\\{\\s*margin-top: 0;",""));
assert.deepEqual(countOccurrences(this.markup, "class=\"player-control-row\""), 1);
assert.deepEqual(countOccurrences(this.markup, "class=\"player-control-row\" role=\"group\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"playback-sheet-seek\""), 1);
spacious = this.styles.match(new RegExp("\\.playback-sheet-panel\\.is-spacious-transport \\.player-control-row\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("\"progress progress progress progress progress\"", spacious));
assert.ok(contains("\"back play forward . next\"", spacious));
assert.ok(contains("grid-template-rows: 48px 48px", spacious));
sheet_row = this.styles.match(new RegExp("\\.playback-sheet \\.player-control-row\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("grid-template-columns: 44px 48px 44px minmax(88px, 1fr) 44px", sheet_row));
sheet_play = this.styles.match(new RegExp("\\.playback-sheet \\.player-control-row \\.player-play-toggle\\s*\\{([^}]*)\\}",""))[1];
for (const declaration of iterableValues(["width: 48px", "min-width: 48px", "max-width: 48px", "height: 48px", "min-height: 48px"])) {
assert.ok(contains(declaration, sheet_play));
}
assert.ok(!contains("--playback-primary-control-size", this.styles));
assert.ok(contains("row-gap: 8px", spacious));
adaptive = this.script.slice(sourceIndex(this.script, "function applyPlaybackSheetAdaptiveLayout"), sourceIndex(this.script, "function renderCurrentItem"));
assert.ok(contains("rangeGain >= 96", adaptive));
assert.ok(contains("const clearance = 10", adaptive));
assert.ok(contains("secondaryNaturalHeight <= maximumBodyContentHeight + 0.5", adaptive));
assert.ok(contains("panel.dataset.transportLayout", adaptive));
assert.ok(!contains("cloneNode", adaptive));
assert.ok(!contains("replaceChildren", adaptive));
},
async test_header_actions_keep_refresh_last_and_use_measured_large_text_fallback() {
let sheet, source, stacked;
sheet = this.markup.slice(sourceIndex(this.markup, "id=\"playback-sheet\""), sourceIndex(this.markup, "id=\"playback-sheet-body\""));
assert.ok(sourceIndex(sheet, "id=\"open-rating-button\"") < sourceIndex(sheet, "id=\"refresh-button\""));
source = this.script.slice(sourceIndex(this.script, "function syncPlaybackSheetHeaderActionLayout"), sourceIndex(this.script, "function applyPlaybackSheetAdaptiveLayout"));
assert.ok(contains("requiredWidth > actions.getBoundingClientRect().width + 0.5", source));
assert.ok(contains("header.classList.toggle(\"is-stacked-actions\", stacked)", source));
stacked = this.styles.match(new RegExp("\\.playback-sheet-status-header\\.is-stacked-actions \\.playback-sheet-status-actions\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("grid-column: 1 / -1", stacked));
assert.ok(contains("flex-wrap: nowrap", stacked));
},
async test_absolute_seek_uses_existing_clock_and_exact_command_path() {
let clock_source, control_source;
clock_source = this.script.slice(sourceIndex(this.script, "function formatPlaybackClockSeconds"), sourceIndex(this.script, "function formatBytes"));
assert.ok(contains("function paintPlaybackSheetSeekPreview", clock_source));
assert.ok(!contains("setInterval", clock_source.replaceAll("window.setInterval(paintCurrentPlaybackClock, 1000)", "")));
control_source = this.script.slice(sourceIndex(this.script, "async function sendPlayerControl"), sourceIndex(this.script, "async function sendPlayerNext"));
assert.ok(contains("action === \"seek-absolute\"", control_source));
assert.ok(contains("payload.target_seconds = Math.round(numericControlValue)", control_source));
assert.deepEqual(countOccurrences(control_source, "apiPostExactStateCommand"), 1);
assert.ok(!contains("fetch(", control_source));
assert.ok(contains("elements.playerControlPanel.addEventListener(\"input\"", this.script));
assert.ok(contains("elements.playerControlPanel.addEventListener(\"change\"", this.script));
}
};
test("RemotePlaybackDockTest.test_dom_has_one_read_only_dock_one_sheet_and_one_control_owner", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_dom_has_one_read_only_dock_one_sheet_and_one_control_owner(); });
test("RemotePlaybackDockTest.test_sheet_header_and_content_order_match_the_product_contract", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_sheet_header_and_content_order_match_the_product_contract(); });
test("RemotePlaybackDockTest.test_cover_contract_reuses_normalizer_and_has_fixed_fallbacks", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_cover_contract_reuses_normalizer_and_has_fixed_fallbacks(); });
test("RemotePlaybackDockTest.test_cover_sync_avoids_duplicate_requests_and_rejects_late_errors", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_cover_sync_avoids_duplicate_requests_and_rejects_late_errors(); });
test("RemotePlaybackDockTest.test_clock_progress_uses_one_paint_path_and_one_timer", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_clock_progress_uses_one_paint_path_and_one_timer(); });
test("RemotePlaybackDockTest.test_ratio_is_finite_clamped_and_unknown_duration_is_hidden", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_ratio_is_finite_clamped_and_unknown_duration_is_hidden(); });
test("RemotePlaybackDockTest.test_safe_area_cover_progress_and_ready_state_match_review_delta", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_safe_area_cover_progress_and_ready_state_match_review_delta(); });
test("RemotePlaybackDockTest.test_toast_is_above_every_remote_playback_and_access_overlay", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_toast_is_above_every_remote_playback_and_access_overlay(); });
test("RemotePlaybackDockTest.test_overflowing_dock_copy_uses_one_shot_measurement_and_reduced_motion_fallback", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_overflowing_dock_copy_uses_one_shot_measurement_and_reduced_motion_fallback(); });
test("RemotePlaybackDockTest.test_audio_variant_bar_is_one_row_with_one_scrollable_popover_owner", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_audio_variant_bar_is_one_row_with_one_scrollable_popover_owner(); });
test("RemotePlaybackDockTest.test_modal_contract_has_no_gestures_and_restores_dock_focus", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_modal_contract_has_no_gestures_and_restores_dock_focus(); });
test("RemotePlaybackDockTest.test_scroll_lock_waits_for_the_last_modal_owner", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_scroll_lock_waits_for_the_last_modal_owner(); });
test("RemotePlaybackDockTest.test_other_true_modals_retire_playback_ownership_first", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_other_true_modals_retire_playback_ownership_first(); });
test("RemotePlaybackDockTest.test_sheet_css_uses_measured_two_column_threshold_and_one_scroller", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_sheet_css_uses_measured_two_column_threshold_and_one_scroller(); });
test("RemotePlaybackDockTest.test_new_accessible_labels_exist_in_all_languages", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_new_accessible_labels_exist_in_all_languages(); });
test("RemotePlaybackDockTest.test_transport_strip_uses_one_stable_svg_control_tree", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_transport_strip_uses_one_stable_svg_control_tree(); });
test("RemotePlaybackDockTest.test_transport_grid_keeps_one_row_at_375_and_320_widths", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_transport_grid_keeps_one_row_at_375_and_320_widths(); });
test("RemotePlaybackDockTest.test_metadata_allocation_is_priority_driven_and_tick_independent", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_metadata_allocation_is_priority_driven_and_tick_independent(); });
test("RemotePlaybackDockTest.test_full_text_popover_is_one_non_modal_text_only_owner", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_full_text_popover_is_one_non_modal_text_only_owner(); });
test("RemotePlaybackDockTest.test_remote_setting_state_icons_are_stable_inline_svg_nodes", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_remote_setting_state_icons_are_stable_inline_svg_nodes(); });
test("RemotePlaybackDockTest.test_sheet_is_content_sized_and_transport_reuses_one_dom_in_two_modes", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_sheet_is_content_sized_and_transport_reuses_one_dom_in_two_modes(); });
test("RemotePlaybackDockTest.test_header_actions_keep_refresh_last_and_use_measured_large_text_fallback", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_header_actions_keep_refresh_last_and_use_measured_large_text_fallback(); });
test("RemotePlaybackDockTest.test_absolute_seek_uses_existing_clock_and_exact_command_path", async () => { const instance = Object.create(RemotePlaybackDockTest); await instance.setUpClass(); await instance.test_absolute_seek_uses_existing_clock_and_exact_command_path(); });
