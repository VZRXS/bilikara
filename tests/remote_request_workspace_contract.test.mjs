import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, sourceIndex, countValues, iterableValues, concatenate, markupSummary, countOccurrences, paired, words } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const RemoteRequestWorkspaceTest = {
async setUpClass() {
let attrs, parser, tag;
this.node = process.execPath;
if ((!this.node)) {
throw (() => { throw new Error("node is unavailable"); })();
}
this.markup = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
this.host_markup = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.styles = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
this.request_styles = readFileSync(path.join(ROOT, "static", "request-tabs.css"), "utf8");
this.detail_styles = readFileSync(path.join(path.join(ROOT, "static"), "song-detail.css"), "utf8");
this.script = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.i18n_text = readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8");
this.translations = JSON.parse(this.i18n_text)["languages"];
parser = markupSummary();
Object.assign(parser, markupSummary(this.markup));
this.elements = parser.elements;
this.by_id = Object.fromEntries(Array.from(Array.from(iterableValues(this.elements)).filter(([tag, attrs]) => (Object.hasOwn(attrs, "id") ? attrs["id"] : null))).map(([tag, attrs]) => [attrs["id"], [tag, attrs]]));
},
async elements_with(attribute) {
let _, attrs;
return Array.from(Array.from(iterableValues(this.elements)) .filter(([_, attrs]) => (contains(attribute, attrs)))).map(([_, attrs]) => attrs);
},
async test_one_request_card_has_four_stable_top_level_tabs_and_panels() {
let _, attrs, index, panel, panels, request_cards, tab, tabs, top_rails, value, values;
request_cards = Array.from(Array.from(iterableValues(this.elements)) .filter(([_, attrs]) => Array.from(new Set(["panel", "request-panel"])).every(value => contains(value, new Set((Symbol.iterator in Object(words(((Object.hasOwn(attrs, "class") ? attrs["class"] : null) || ""))) ? words(((Object.hasOwn(attrs, "class") ? attrs["class"] : null) || "")) : Object.keys(words(((Object.hasOwn(attrs, "class") ? attrs["class"] : null) || ""))))))))).map(([_, attrs]) => attrs);
assert.deepEqual(request_cards.length, 1);
assert.deepEqual((Object.hasOwn(request_cards[0], "data-request-size") ? request_cards[0]["data-request-size"] : null), "compact");
tabs = (await this.elements_with("data-remote-request-view"));
panels = (await this.elements_with("data-remote-request-panel"));
values = ["quick", "search", "discover", "sources"];
assert.deepEqual(Array.from(Array.from(iterableValues(tabs))).map((tab) => tab["data-remote-request-view"]), values);
assert.deepEqual(Array.from(Array.from(iterableValues(panels))).map((panel) => panel["data-remote-request-panel"]), values);
assert.deepEqual(Array.from(Array.from(iterableValues(tabs))).map((tab) => tab["aria-controls"]), Array.from(Array.from(iterableValues(values))).map((value) => ("remote-request-" + String(value) + "-panel")));
for (const [index, [tab, panel]] of iterableValues(Array.from(paired(tabs, panels)).entries())) {
assert.deepEqual(tab["role"], "tab");
assert.deepEqual(panel["role"], "tabpanel");
assert.deepEqual(tab["aria-selected"], (((index === 0)) ? "true" : "false"));
assert.deepEqual(tab["tabindex"], (((index === 0)) ? "0" : "-1"));
assert.deepEqual((contains("hidden", panel)), ((index !== 0)));
assert.deepEqual((contains("inert", panel)), ((index !== 0)));
}
top_rails = Array.from(Array.from(iterableValues(this.elements)) .filter(([_, attrs]) => (contains("remote-request-tabs", words(((Object.hasOwn(attrs, "class") ? attrs["class"] : null) || "")))))).map(([_, attrs]) => attrs);
assert.deepEqual(top_rails.length, 1);
assert.deepEqual(top_rails[0]["role"], "tablist");
},
async test_top_level_rail_is_full_width_below_the_heading() {
let element_id, heading_rule;
assert.notEqual(this.markup.match(new RegExp("<div class=\"panel-head remote-request-head\">\\s*<div>.*?</div>\\s*</div>\\s*<div class=\"remote-request-tabs-viewport\">\\s*<div id=\"remote-request-primary-tabs\" class=\"remote-request-tabs\" role=\"tablist\"","s")), null);
heading_rule = this.styles.match(new RegExp("\\.remote-request-head\\s*\\{([^}]*)\\}",""));
assert.notEqual(heading_rule, null);
assert.ok(contains("display: block", heading_rule[1]));
assert.ok(!contains("grid-template-columns", heading_rule[1]));
for (const element_id of iterableValues(["remote-request-secondary-nav", "remote-request-secondary-back", "remote-request-secondary-slot"])) {
assert.deepEqual(countOccurrences(this.markup, ("id=\"" + String(element_id) + "\"")), 1);
}
assert.ok(contains("function syncRemoteRequestTabPresentation()", this.script));
assert.ok(contains("elements.remoteRequestSecondarySlot.append(activeTablist)", this.script));
assert.ok(contains("restoreRemoteRequestSecondaryTablists(activeView)", this.script));
},
async test_back_controls_use_centered_svg_and_category_card_geometry() {
let category_template, secondary_back;
secondary_back = this.markup.match(new RegExp("<button type=\"button\" id=\"remote-request-secondary-back\".*?</button>","s"));
assert.notEqual(secondary_back, null);
assert.ok(contains("remote-request-secondary-back-icon", secondary_back[0]));
assert.ok(contains("data-i18n=\"common.back\"", secondary_back[0]));
assert.ok(!contains("content: \"‹\"", this.styles));
assert.ok(contains("display: inline-flex", this.styles));
assert.ok(contains("function createCategoryBrowseBackCard()", this.script));
assert.ok(contains("button.className = \"secondary-button tag-browser-back\"", this.script));
assert.ok(contains("button.textContent = t(\"common.back\")", this.script));
assert.ok(!contains("category-browser-back-tab-icon", this.script));
assert.ok(contains("tabs.appendChild(backButton)", this.script));
category_template = this.script.slice(sourceIndex(this.script, "function ensureCategoryBrowseView()"), sourceIndex(this.script, "function createCategoryBrowseCard"));
assert.ok(!contains("class=\"tag-browser-nav\"", category_template));
},
async test_request_tabs_share_queue_transition_without_layout_measurement() {
let reduced_motion;
assert.ok(contains("transition: background 0.18s ease, color 0.18s ease", this.styles));
assert.ok(!contains("remote-tab-slide", this.styles));
assert.ok(!contains("prepareRemoteTabSlide", this.script));
assert.ok(!contains("remote-tab-label-offset", this.styles));
reduced_motion = this.styles.match(new RegExp("@media \\(prefers-reduced-motion: reduce\\)\\s*\\{(.*?)\\n\\}\\n\\n\\.remote-menu-panel","s"));
assert.notEqual(reduced_motion, null);
assert.ok(contains(".remote-request-tab[aria-selected=\"true\"]", reduced_motion[1]));
assert.ok(contains("animation: none", reduced_motion[1]));
},
async test_quick_is_single_line_and_view_memory_is_session_only() {
let field;
field = this.markup.match(new RegExp("<input\\s+id=\"url-input\".*?/>","s"));
assert.notEqual(field, null);
assert.ok(contains("type=\"text\"", field[0]));
assert.ok(contains("sessionStorage?.setItem(\"bilikara.remote.requestView\", nextView)", this.script));
assert.ok(contains("sessionStorage?.getItem(\"bilikara.remote.requestView\")", this.script));
assert.ok(!contains("localStorage?.setItem(\"bilikara.remote.requestView\"", this.script));
},
async test_history_export_uses_modal_and_preserves_download_authority() {
let download;
assert.ok(contains("<dialog id=\"history-export-dialog\"", this.markup));
assert.ok(contains("aria-labelledby=\"history-export-title\"", this.markup));
assert.ok(contains("dialog.showModal()", this.script));
assert.ok(contains("elements.resortPlaylistButton?.classList.toggle(\"hidden\", isHistoryView)", this.script));
assert.ok(contains("elements.historyExportButton?.classList.toggle(\"hidden\", !isHistoryView)", this.script));
assert.ok(contains("historyExportGuard.run", this.script));
download = this.script.slice(sourceIndex(this.script, "async function downloadHistoryExport"), sourceIndex(this.script, "elements.openRatingButton?.addEventListener"));
assert.ok(sourceIndex(download, "mode === \"internet\"") < sourceIndex(download, "downloadBrowserFile"));
assert.ok(contains("history.exportLanOnly", download));
assert.ok(contains("headers: clientHeaders()", download));
},
async test_empty_queue_uses_host_text_keys() {
let empty, key;
empty = this.script.slice(sourceIndex(this.script, "function createQueueEmptyNode"), sourceIndex(this.script, "function renderQueue("));
for (const key of iterableValues(["list.emptyTitle", "list.emptyHint", "list.emptyWithCurrentTitle", "list.emptyWithCurrentHint"])) {
assert.ok(contains(key, empty));
}
assert.ok(!contains("remote.queueEmpty", empty));
},
async test_quick_request_actions_match_host_primary_secondary_layout() {
let action_row, next_button, primary, rule;
action_row = this.markup.match(new RegExp("<div class=\"action-row request-action-row\">\\s*<button type=\"submit\" class=\"primary-button\".*?</button>\\s*<button type=\"button\" id=\"add-next-button\" class=\"secondary-button\".*?</button>\\s*</div>","s"));
assert.notEqual(action_row, null);
rule = this.styles.match(new RegExp("\\.action-row\\.request-action-row\\s*\\{([^}]*)\\}",""));
assert.notEqual(rule, null);
assert.ok(contains("grid-template-columns: minmax(0, 1fr) max-content", rule[1]));
primary = this.styles.match(new RegExp("\\.request-action-row > \\.primary-button\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: 100%", primary));
assert.ok(contains("min-width: 0", primary));
next_button = this.styles.match(new RegExp("\\.request-action-row > #add-next-button\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: auto", next_button));
assert.ok(contains("white-space: nowrap", next_button));
},
async test_each_secondary_tablist_has_stable_direct_ownership() {
let expected, index, panel, panel_suffix, panels, tab, tab_suffix, tabs, values;
expected = [["remote-search-mode", "remote-search-panel", ["shared", "local"]], ["remote-discover-mode", "remote-discover-panel", ["categories", "name", "artist"]], ["remote-sources-mode", "remote-sources-panel", ["uids", "favorites"]]];
for (const [tab_suffix, panel_suffix, values] of iterableValues(expected)) {
tabs = (await this.elements_with(("data-" + String(tab_suffix))));
panels = (await this.elements_with(("data-" + String(panel_suffix))));
assert.deepEqual(Array.from(Array.from(iterableValues(tabs))).map((tab) => tab[("data-" + String(tab_suffix))]), values);
assert.deepEqual(Array.from(Array.from(iterableValues(panels))).map((panel) => panel[("data-" + String(panel_suffix))]), values);
for (const [index, [tab, panel]] of iterableValues(Array.from(paired(tabs, panels)).entries())) {
assert.deepEqual(tab["role"], "tab");
assert.deepEqual(panel["role"], "tabpanel");
assert.deepEqual(tab["tabindex"], (((index === 0)) ? "0" : "-1"));
assert.deepEqual(tab["aria-selected"], (((index === 0)) ? "true" : "false"));
assert.deepEqual((contains("hidden", panel)), ((index !== 0)));
assert.deepEqual((contains("inert", panel)), ((index !== 0)));
}
}
},
async test_every_live_form_and_result_surface_has_one_owner() {
let _, attrs, count, duplicates, element_id, ids, unique_ids;
unique_ids = ["request-form", "lark-search-form", "lark-search-results", "search-form", "search-results", "remote-discover-categories-panel", "remote-discover-name-panel", "remote-discover-artist-panel", "sources-follow-uid-form", "sources-follow-grid", "sources-follow-results", "sources-favlist-pull-form", "favlist-grid", "favlist-song-results"];
for (const element_id of iterableValues(unique_ids)) {
assert.deepEqual(countOccurrences(this.markup, ("id=\"" + String(element_id) + "\"")), 1, element_id);
}
ids = Array.from(Array.from(iterableValues(this.elements)) .filter(([_, attrs]) => (Object.hasOwn(attrs, "id") ? attrs["id"] : null))).map(([_, attrs]) => attrs["id"]);
duplicates = Array.from(Array.from(Array.from(iterableValues(Object.entries(countValues(ids)))) .filter(([element_id, count]) => ((count > 1)))).map(([element_id, count]) => element_id)).sort((a, b) => typeof a === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0);
assert.deepEqual(duplicates, []);
},
async test_advanced_modal_more_button_and_modal_state_are_retired() {
let combined, obsolete;
combined = concatenate(concatenate(concatenate(concatenate(this.markup, this.styles), this.detail_styles), this.script), this.i18n_text);
for (const obsolete of iterableValues(["search-library-open", "search.moreBrowse", "search-modal", "remote-search-modal", "searchModalOpen", "searchModalView", "searchModalCloseTimer", "modalFollow", "modalFavlist", "modalBrowse", "search-modal-other-view", "remote-search-modal-open"])) {
assert.ok(!contains(obsolete, combined));
}
},
async test_stage_one_and_surrounding_remote_cards_remain_direct() {
let form_id, retired_gatcha_source_control, sources_panel, stable_id;
for (const form_id of iterableValues(["request-form", "lark-search-form", "search-form"])) {
assert.deepEqual(countOccurrences(this.markup, ("id=\"" + String(form_id) + "\"")), 1);
}
assert.ok(!contains("id=\"form-message\"", this.markup));
assert.ok(!contains("class=\"panel now-playing-panel\"", this.markup));
assert.deepEqual(countOccurrences(this.markup, "id=\"playback-dock\""), 1);
assert.deepEqual(countOccurrences(this.markup, "id=\"playback-sheet\""), 1);
assert.deepEqual(countOccurrences(this.markup, "class=\"panel queue-panel\""), 1);
assert.deepEqual(countOccurrences(this.markup, "class=\"panel gatcha-panel\""), 1);
for (const stable_id of iterableValues(["remote-header", "current-title", "queue-view-button", "history-view-button", "queue-list", "history-list", "gatcha-button", "refresh-gatcha-cache-button"])) {
assert.deepEqual(countOccurrences(this.markup, ("id=\"" + String(stable_id) + "\"")), 1);
}
assert.deepEqual(countOccurrences(this.markup, "id=\"sources-follow-uid-form\""), 1);
for (const retired_gatcha_source_control of iterableValues(["gatcha-uid-toggle", "gatcha-uid-view", "gatcha-uid-form", "gatcha-uid-input", "add-gatcha-uid-button", "pull-gatcha-favlist-button"])) {
assert.ok(!contains(retired_gatcha_source_control, this.markup));
}
sources_panel = this.markup.slice(sourceIndex(this.markup, "id=\"remote-request-sources-panel\""), sourceIndex(this.markup, "class=\"panel queue-panel\""));
assert.ok(contains("id=\"refresh-gatcha-cache-button\"", sources_panel));
assert.ok(!contains("setupRemoteFlipStages", this.script));
assert.ok(!contains(".gatcha-stage", this.styles));
},
async test_shared_i18n_keys_drive_all_tabs_in_three_languages() {
let aria_only, attribute, key, keys, language;
keys = ["request.quickTab", "request.searchTab", "request.discoverTab", "request.sourcesTab", "search.sharedCatalog", "search.localLibrary", "discover.categories", "discover.name", "discover.artist", "discover.modeSelector", "sources.ownerList", "sources.favorites", "sources.modeSelector"];
for (const language of iterableValues(["zh", "en", "ja"])) {
for (const key of iterableValues(keys)) {
assert.ok(hasContent(this.translations[language][key]), [language, key]);
}
}
aria_only = new Set(["discover.modeSelector", "sources.modeSelector"]);
for (const key of iterableValues(keys)) {
attribute = ((contains(key, aria_only)) ? "data-i18n-aria-label" : "data-i18n");
assert.ok(contains((String(attribute) + "=\"" + String(key) + "\""), this.markup));
}
for (const key of iterableValues(["request.quickTab", "request.searchTab", "request.discoverTab", "request.sourcesTab"])) {
assert.ok(contains(("data-i18n=\"" + String(key) + "\""), this.host_markup));
}
},
async test_scrollable_rail_and_bounded_request_card_contract() {
let declaration, document_layout_styles, height, quick_rule, request_card_rule, request_view_rule, result_rule, secondary_nav_rule, source_form_rule, strip_rule, tab_rule, tier, tier_rule, viewport_rule;
viewport_rule = this.styles.match(new RegExp("\\.remote-request-tabs-viewport\\s*\\{([^}]*)\\}",""));
strip_rule = this.styles.match(new RegExp("\\.remote-request-tabs\\s*\\{([^}]*)\\}",""));
tab_rule = this.styles.match(new RegExp("\\.remote-request-tab\\s*\\{([^}]*)\\}",""));
assert.notEqual(viewport_rule, null);
assert.notEqual(strip_rule, null);
assert.notEqual(tab_rule, null);
for (const declaration of iterableValues(["width: 100%", "overflow-x: auto", "overflow-y: hidden", "overscroll-behavior-inline: contain", "scrollbar-width: none", "touch-action: pan-x pan-y"])) {
assert.ok(contains(declaration, viewport_rule[1]));
}
for (const declaration of iterableValues(["width: max-content", "min-width: 100%", "display: flex", "flex-wrap: nowrap"])) {
assert.ok(contains(declaration, strip_rule[1]));
}
assert.ok(contains("flex: 1 0 auto", tab_rule[1]));
assert.ok(contains("white-space: nowrap", tab_rule[1]));
assert.ok(contains("min-height: 48px", this.styles));
assert.ok(contains(".remote-request-tabs-viewport::-webkit-scrollbar", this.styles));
secondary_nav_rule = this.styles.match(new RegExp("\\.remote-request-secondary-nav\\s*\\{([^}]*)\\}",""));
assert.notEqual(secondary_nav_rule, null);
assert.ok(contains("grid-template-columns: max-content minmax(max-content, 1fr)", secondary_nav_rule[1]));
result_rule = this.styles.match(new RegExp("\\.remote-search-mode-panel > \\.search-results,.*?\\{([^}]*)\\}","s"));
assert.notEqual(result_rule, null);
assert.ok(contains("max-height: none", result_rule[1]));
assert.ok(contains("overflow-y: auto", result_rule[1]));
assert.ok(contains("scrollbar-width: thin", result_rule[1]));
request_card_rule = this.styles.match(new RegExp("\\.request-panel\\s*\\{([^}]*)\\}",""));
assert.notEqual(request_card_rule, null);
for (const declaration of iterableValues(["grid-template-rows: auto auto minmax(0, 1fr)", "height: clamp(390px, 48dvh, 430px)", "overflow: hidden"])) {
assert.ok(contains(declaration, request_card_rule[1]));
}
for (const [tier, height] of iterableValues([["compact", "height: auto"], ["browse", "height: clamp(430px, 53dvh, 460px)"], ["browse-deep", "height: clamp(700px, 86dvh, 740px)"]])) {
tier_rule = this.styles.match(new RegExp(("\\.request-panel\\[data-request-size=\"" + String(tier) + "\"\\]\\s*\\{([^}]*)\\}"),""));
assert.notEqual(tier_rule, null);
assert.ok(contains(height, tier_rule[1]));
}
request_view_rule = this.styles.match(new RegExp("\\.request-panel > \\.remote-request-view\\s*\\{([^}]*)\\}",""));
assert.notEqual(request_view_rule, null);
assert.ok(contains("overflow-y: hidden", request_view_rule[1]));
assert.ok(contains("overscroll-behavior-y: contain", request_view_rule[1]));
quick_rule = this.styles.match(new RegExp("\\.request-panel > #remote-request-quick-panel\\s*\\{([^}]*)\\}",""));
assert.notEqual(quick_rule, null);
assert.ok(contains("overflow: clip", quick_rule[1]));
assert.ok(contains("overscroll-behavior-y: auto", quick_rule[1]));
assert.notEqual(this.markup.match(new RegExp("id=\"sources-follow-uid-form\".*?id=\"sources-add-follow-uid-button\".*?id=\"refresh-gatcha-cache-button\".*?</form>","s")), null);
source_form_rule = this.request_styles.match(/:root \.source-uid-form:has\(> \.source-refresh-button\)\s*\{([^}]*)\}/u);
assert.notEqual(source_form_rule, null);
assert.ok(contains("grid-template-columns: minmax(0, 1fr) auto auto", source_form_rule[1]));
document_layout_styles = this.styles.slice(0, sourceIndex(this.styles, "/* Remote playback dock and responsive bottom sheet */"));
assert.ok(!contains("height: 100dvh", document_layout_styles));
assert.ok(!contains("--remote-search-stage-height", this.styles));
assert.ok(!contains("remote-search-stage", concatenate(this.styles, this.script)));
},
async test_remote_controls_share_mobile_geometry_with_distinct_tab_selection() {
let blue_rules, dark_rules, declaration, declarations, markup, root_rule, selector, shared_root, shared_tabs, source_refresh_rule, source_refresh_start, start, tabs_rule;
shared_tabs = readFileSync(path.join(path.join(ROOT, "static"), "request-tabs.css"), "utf8");
for (const markup of iterableValues([this.markup, this.host_markup])) {
assert.ok(contains("/request-tabs.css", markup));
}
shared_root = shared_tabs.match(new RegExp(":root\\s*\\{([^}]*)\\}",""))[1];
root_rule = this.styles.match(new RegExp(":root\\s*\\{([^}]*)\\}",""));
tabs_rule = this.styles.match(new RegExp("\\.remote-request-tab,\\s*\\.remote-search-mode-tab,\\s*\\.remote-discover-mode-tab,\\s*\\.remote-sources-mode-tab,\\s*\\.toggle-button\\s*\\{([^}]*)\\}",""));
assert.notEqual(root_rule, null);
assert.notEqual(tabs_rule, null);
for (const declaration of iterableValues(["--remote-segmented-control-font-size: 16px", "--remote-form-control-height: var(--remote-peer-action-height)", "--remote-form-control-radius: var(--remote-peer-action-radius)", "--remote-peer-action-height: 44px", "--remote-peer-action-font-size: 16px", "--remote-peer-action-radius: 14px", "--remote-segmented-control-active-bg: rgba(255, 255, 255, 0.95)", "--remote-segmented-control-active-color: var(--accent-deep)"])) {
assert.ok(contains(declaration, ((contains("segmented-control", declaration)) ? shared_root : root_rule[1])));
}
assert.ok(!contains(":root[lang=\"en\"]", this.styles));
assert.ok(contains("font-size: var(--remote-segmented-control-font-size)", tabs_rule[1]));
assert.ok(contains("border-radius: var(--remote-form-control-radius)", tabs_rule[1]));
for (const selector of iterableValues([".request-form :is(.primary-button, .secondary-button, .ghost-button)", ".history-export-row :is(.primary-button, .secondary-button, .ghost-button)", ".tag-browser-search input", ".tag-browser-search .primary-button"])) {
start = sourceIndex(this.styles, selector);
declarations = this.styles.slice(start, sourceIndex(this.styles, "}", start));
assert.ok(contains("var(--remote-form-control-", declarations));
}
for (const selector of iterableValues([".queue-header-action", ".gatcha-pool-config-toggle"])) {
start = sourceIndex(this.styles, selector);
declarations = this.styles.slice(start, sourceIndex(this.styles, "}", start));
assert.ok(contains("var(--remote-peer-action-height)", declarations));
assert.ok(contains("var(--remote-peer-action-radius)", declarations));
}
source_refresh_start = sourceIndex(this.request_styles, ":root .source-uid-form > button");
source_refresh_rule = this.request_styles.slice(source_refresh_start, sourceIndex(this.request_styles, "}", source_refresh_start));
assert.ok(contains("height: 44px", source_refresh_rule));
assert.ok(contains("min-width: 44px", source_refresh_rule));
assert.ok(contains("white-space: nowrap", source_refresh_rule));
dark_rules = Array.from(shared_tabs.matchAll(new RegExp(":root\\[data-theme=\"dark\"\\]\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(dark_rules.length, 1);
assert.ok(contains("--remote-segmented-control-active-bg: rgba(246, 241, 235, 0.15)", dark_rules[0]));
assert.ok(contains("--remote-segmented-control-active-color: var(--accent)", dark_rules[0]));
blue_rules = Array.from(shared_tabs.matchAll(new RegExp(":root\\[data-theme=\"blue\"\\]\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(blue_rules.length, 1);
assert.ok(contains("--remote-segmented-control-active-bg: rgba(0, 210, 255, 0.18)", blue_rules[0]));
for (const declarations of iterableValues(blue_rules)) {
assert.ok(contains("--remote-segmented-control-active-color: var(--ink)", declarations));
assert.ok(!contains("--remote-segmented-control-active-bg: var(--remote-primary-button", declarations));
assert.ok(!contains("--remote-segmented-control-active-color: var(--remote-primary-button", declarations));
}
},
async test_no_request_content_swipe_or_generic_router_was_added() {
let controller, forbidden;
controller = this.script.slice(sourceIndex(this.script, "function normalizeRemoteRequestView"), sourceIndex(this.script, "function hydrateLocalPreferences"));
for (const forbidden of iterableValues(["touchstart", "touchmove", "touchend", "pointerdown", "pointermove", "translateX", "swipe", "carousel"])) {
assert.ok(!contains(forbidden, controller));
}
assert.doesNotMatch(this.script, new RegExp("(?:requestPanel|remoteRequestDiscoverPanel).*addEventListener\\(\\\"touch",""));
assert.ok(!contains("class RemoteRouter", this.script));
assert.ok(!contains("localStorage", controller));
},
async test_data_views_keep_independent_state_and_stale_response_guards() {
let guard, owner, retired;
assert.ok(contains("remoteDiscoverMode: \"categories\"", this.script));
assert.ok(contains("remoteSourcesMode: \"uids\"", this.script));
assert.ok(contains("d1BrowseModes: {", this.script));
assert.ok(contains("name: { letter: \"\", tag: \"\"", this.script));
assert.ok(contains("artist: { letter: \"\", tag: \"\"", this.script));
for (const retired of iterableValues(["d1BrowseKind:", "d1BrowseLetter:", "d1BrowseTag:", "d1BrowseData:"])) {
assert.ok(!contains(retired, this.script));
}
for (const guard of iterableValues(["if (mode.seq !== searchSeq)", "if (state.categoryBrowseSeq !== searchSeq)", "if (state.followBrowseSeq !== seq)", "if (state.favlistBrowseSeq !== seq)"])) {
assert.ok(contains(guard, this.script));
}
for (const owner of iterableValues(["shared", "local", "categories", "name", "artist", "uids", "favorites"])) {
assert.match(this.script, new RegExp(("\\b" + String(owner) + ": \\{ selectedKey: \\\"\\\", focusElement: null \\}"),""));
}
assert.ok(contains("container: elements.remoteShell", this.script));
assert.ok(contains("resolveReturnFocus: resolveRequestDetailReturnFocus", this.script));
},
async test_browse_uses_document_scroll_and_explicit_result_pages() {
let card_rule, markup, pagination_styles, script;
assert.ok(contains("function syncRemoteRequestPanelSizeTier()", this.script));
assert.ok(contains("[\"discover\", \"sources\"].includes(state.remoteRequestView)", this.script));
assert.ok(contains("tier = \"browse-deep\";", this.script));
assert.ok(!contains("shouldAutoLoadNextBrowsePage", this.script));
assert.ok(!contains("sourcesFollowResults?.addEventListener(\"scroll\"", this.script));
assert.ok(!contains("favlistSongResults?.addEventListener(\"scroll\"", this.script));
assert.ok(contains("window.BilikaraResultPager.create(container", this.script));
markup = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
assert.ok(contains("src=\"/result-pagination.js\"", markup));
assert.ok(contains("href=\"/result-pagination.css\"", markup));
pagination_styles = readFileSync(path.join(path.join(ROOT, "static"), "result-pagination.css"), "utf8");
card_rule = pagination_styles.match(new RegExp("\\.request-panel\\[data-request-size\\]\\s*\\{([^}]*)\\}",""));
assert.notEqual(card_rule, null);
assert.ok(contains("height: auto", card_rule[1]));
assert.ok(contains("overflow: visible", card_rule[1]));
assert.ok(contains("touch-action: pan-y pinch-zoom", pagination_styles));
assert.ok(!contains("t(\"search.categoryLoadedMore\"", this.script));
assert.ok(!contains("t(\"search.categoryLoadedAll\"", this.script));
assert.ok(!contains("\"search.categoryLoadedMore\"", this.i18n_text));
assert.ok(!contains("\"search.categoryLoadedAll\"", this.i18n_text));
for (const script of iterableValues([this.script, readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8")])) {
assert.ok(contains("items.length ? \"\" : t(\"search.localNotFound\")", script));
assert.ok(!contains("items.length ? t(\"search.localFound\", { count: items.length })", script));
}
},
async test_only_loading_and_empty_browse_messages_remain_inline() {
let host_markup, host_script, script;
host_script = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
host_markup = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
assert.ok(!contains("request-mode-contract", host_markup));
assert.ok(contains("id=\"request-session-user-notice\"", host_markup));
assert.ok(!contains("searchModeContract", host_script));
assert.ok(contains("syncRequestSessionUserNoticePlacement", host_script));
assert.ok(contains("function setSourceManagementLoadingMessage", this.script));
assert.match(this.script, new RegExp("function setSourceManagementMessage\\(target, message, isError = false\\) \\{\\s*setSourceManagementInlineMessage\\(target, \"\"\\);\\s*setAppMessage\\(message, isError\\);",""));
assert.ok(contains("function setGatchaUidFlowLoadingMessage", host_script));
assert.match(host_script, new RegExp("function setGatchaUidFlowMessage\\(target, message, isError = false\\).*?setFollowBrowseMessage\\(\"\"\\);.*?setAppMessage\\(message, isError\\);","gs"));
for (const script of iterableValues([this.script, host_script])) {
assert.ok(!contains("message.textContent = state.categoryBrowseError", script));
assert.ok(!contains("message.textContent = mode.error", script));
}
},
async test_remote_song_detail_is_viewport_scoped_outside_filtered_request_card() {
let declaration, detail_rule, edge;
assert.ok(contains("container: elements.remoteShell", this.script));
assert.ok(!contains("container: elements.requestPanel", this.script));
detail_rule = this.styles.match(new RegExp("\\.remote-shell > \\.song-detail-view\\s*\\{([^}]*)\\}",""));
assert.notEqual(detail_rule, null);
for (const declaration of iterableValues(["position: fixed", "inset: 0", "z-index: var(--remote-layer-modal)", "var(--remote-modal-inset-top)", "var(--remote-modal-inset-bottom)"])) {
assert.ok(contains(declaration, detail_rule[1]));
}
for (const edge of iterableValues(["top", "bottom"])) {
assert.ok(contains(("--remote-modal-inset-" + String(edge) + ": calc(14px + var(--remote-safe-area-" + String(edge) + "));"), this.styles));
assert.ok(contains(("--remote-safe-area-" + String(edge) + ": env(safe-area-inset-" + String(edge) + ", 0px);"), this.styles));
}
assert.ok(!contains(".request-panel > .song-detail-view", this.styles));
},
async test_tab_controller_keeps_nodes_state_focus_and_networks_independent() {
let completed, controller, harness, result;
controller = this.script.slice(sourceIndex(this.script, "function normalizeRemoteRequestView"), sourceIndex(this.script, "function hydrateLocalPreferences"));
harness = (`
let fetchCalls = 0;
let sourceLoads = [];
let activeElement = "sentinel";
const window = { matchMedia() { return { matches: false }; } };
let searchDetailController = null;
function fetch() { fetchCalls += 1; }
function renderCategoryBrowseView() {}
function renderD1BrowseView() {}
function renderSourcesFollowBrowse() {}
function renderFavlistBrowse() {}
function loadFollowBrowse() { sourceLoads.push("uids"); }
function loadFavlistBrowse() { sourceLoads.push("favorites"); }
function mockNode(id, dataset = {}) {
  return {
    id, dataset, hidden: false, inert: false, tabIndex: 0, attributes: {},
    isConnected: true, scrollCalls: [],
    setAttribute(name, value) { this.attributes[name] = String(value); },
    focus() { activeElement = id; },
    scrollIntoView(options) { this.scrollCalls.push(options); },
    closest() { return null; },
  };
}
const topValues = ["quick", "search", "discover", "sources"];
const searchValues = ["shared", "local"];
const discoverValues = ["categories", "name", "artist"];
const sourcesValues = ["uids", "favorites"];
const topTabs = topValues.map((value) => mockNode(\`\${value}-tab\`, { remoteRequestView: value }));
const topPanels = topValues.map((value) => mockNode(\`\${value}-panel\`, { remoteRequestPanel: value }));
const searchTabs = searchValues.map((value) => mockNode(\`\${value}-tab\`, { remoteSearchMode: value }));
const searchPanels = searchValues.map((value) => mockNode(\`\${value}-panel\`, { remoteSearchPanel: value }));
const discoverTabs = discoverValues.map((value) => mockNode(\`\${value}-tab\`, { remoteDiscoverMode: value }));
const discoverPanels = discoverValues.map((value) => mockNode(\`\${value}-panel\`, { remoteDiscoverPanel: value }));
const sourcesTabs = sourcesValues.map((value) => mockNode(\`\${value}-tab\`, { remoteSourcesMode: value }));
const sourcesPanels = sourcesValues.map((value) => mockNode(\`\${value}-panel\`, { remoteSourcesPanel: value }));
const requestForm = { value: "quick-value" };
const sharedInput = { value: "shared-value" };
const localInput = { value: "local-value" };
const sharedRow = { id: "shared-row" };
const localRow = { id: "local-row" };
const remoteShell = mockNode("remote-shell");
const elements = {
  remoteShell,
  remoteRequestViewButtons: topTabs,
  remoteRequestViewPanels: topPanels,
  remoteSearchModeButtons: searchTabs,
  remoteSearchModePanels: searchPanels,
  remoteDiscoverModeButtons: discoverTabs,
  remoteDiscoverModePanels: discoverPanels,
  remoteSourcesModeButtons: sourcesTabs,
  remoteSourcesModePanels: sourcesPanels,
};
const state = {
  remoteRequestView: "quick",
  remoteSearchMode: "shared",
  remoteDiscoverMode: "categories",
  remoteSourcesMode: "uids",
  followBrowseData: { owners: [] }, followBrowseLoading: false,
  favlistBrowseData: { folders: [] }, favlistBrowseLoading: false,
};
` + String(controller) + `
function selectedState(tabs, panels) {
  return {
    selected: tabs.map((tab) => tab.attributes["aria-selected"]),
    tabIndexes: tabs.map((tab) => tab.tabIndex),
    hidden: panels.map((panel) => panel.hidden),
    inert: panels.map((panel) => panel.inert),
  };
}
function key(handler, keyName, currentTarget) {
  handler({ key: keyName, currentTarget, preventDefault() {} });
}
syncRemoteRequestViewSelection();
const initial = selectedState(topTabs, topPanels);
activateRemoteRequestView("search");
const clickFocus = activeElement;
const searchState = selectedState(topTabs, topPanels);
const searchTrace = [];
key(handleRemoteSearchModeTabKeydown, "ArrowLeft", searchTabs[0]); searchTrace.push(state.remoteSearchMode);
key(handleRemoteSearchModeTabKeydown, "Home", searchTabs[1]); searchTrace.push(state.remoteSearchMode);
const discoverTrace = [];
for (const [keyName, tab] of [["ArrowLeft", discoverTabs[0]], ["Home", discoverTabs[2]], ["End", discoverTabs[0]], ["ArrowRight", discoverTabs[2]]]) {
  key(handleRemoteDiscoverModeTabKeydown, keyName, tab); discoverTrace.push(state.remoteDiscoverMode);
}
const sourcesTrace = [];
key(handleRemoteSourcesModeTabKeydown, "ArrowLeft", sourcesTabs[0]); sourcesTrace.push(state.remoteSourcesMode);
key(handleRemoteSourcesModeTabKeydown, "ArrowRight", sourcesTabs[1]); sourcesTrace.push(state.remoteSourcesMode);
const topTrace = [];
for (const [keyName, tab] of [["ArrowRight", topTabs[0]], ["ArrowLeft", topTabs[0]], ["Home", topTabs[3]], ["End", topTabs[0]]]) {
  key(handleRemoteRequestTabKeydown, keyName, tab); topTrace.push(state.remoteRequestView);
}
const beforeRestoration = [state.remoteRequestView, state.remoteSearchMode, state.remoteDiscoverMode, state.remoteSourcesMode];
syncRemoteRequestViewSelection();
const afterRestoration = [state.remoteRequestView, state.remoteSearchMode, state.remoteDiscoverMode, state.remoteSourcesMode];
state.favlistBrowseData = null;
activateRemoteSourcesMode("favorites");
console.log(JSON.stringify({
  initial, searchState, clickFocus, searchTrace, discoverTrace, sourcesTrace, topTrace,
  beforeRestoration, afterRestoration, sourceLoads, fetchCalls,
  stableNodes: requestForm.value === "quick-value" && sharedInput.value === "shared-value"
    && localInput.value === "local-value" && sharedRow.id === "shared-row" && localRow.id === "local-row",
  revealed: topTabs.map((tab) => tab.scrollCalls.length),
  finalTop: selectedState(topTabs, topPanels),
  finalDiscover: selectedState(discoverTabs, discoverPanels),
  finalSources: selectedState(sourcesTabs, sourcesPanels),
}));
`);
completed = (await runNative(this.node, ["-e", harness], process.env, 10 * 1000, ROOT));
assert.deepEqual(completed.status, 0, completed.stderr);
result = JSON.parse(completed.stdout);
assert.deepEqual(result["initial"]["selected"], ["true", "false", "false", "false"]);
assert.deepEqual(result["initial"]["tabIndexes"], [0, (-1), (-1), (-1)]);
assert.deepEqual(result["initial"]["hidden"], [false, true, true, true]);
assert.deepEqual(result["initial"]["inert"], [false, true, true, true]);
assert.deepEqual(result["clickFocus"], "sentinel");
assert.deepEqual(result["searchState"]["hidden"], [true, false, true, true]);
assert.deepEqual(result["searchTrace"], ["local", "shared"]);
assert.deepEqual(result["discoverTrace"], ["artist", "categories", "artist", "categories"]);
assert.deepEqual(result["sourcesTrace"], ["favorites", "uids"]);
assert.deepEqual(result["topTrace"], ["search", "sources", "quick", "sources"]);
assert.deepEqual(result["beforeRestoration"], result["afterRestoration"]);
assert.deepEqual(result["sourceLoads"], ["favorites"]);
assert.deepEqual(result["fetchCalls"], 0);
assert.ok(hasContent(result["stableNodes"]));
assert.ok(result["revealed"][3] > 0);
assert.deepEqual(result["finalTop"]["tabIndexes"], [(-1), (-1), (-1), 0]);
assert.deepEqual(result["finalDiscover"]["tabIndexes"], [0, (-1), (-1)]);
assert.deepEqual(result["finalSources"]["tabIndexes"], [(-1), 0]);
assert.ok(!contains("fetch(", controller));
},
async test_async_forms_have_one_owner_and_busy_guards() {
let control, element_name, matches;
for (const element_name of iterableValues(["requestForm", "searchForm", "larkSearchForm", "sourcesFollowUidForm", "sourcesFollowSearchForm", "sourcesFavlistPullForm", "favlistSearchForm"])) {
matches = Array.from(this.script.matchAll(new RegExp(("elements\\." + String(element_name) + "\\??\\.addEventListener\\(\"submit\""),"g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(matches.length, 1, element_name);
}
assert.deepEqual(countOccurrences(this.script, "elements.remoteRequestDiscoverPanel?.addEventListener(\"click\""), 1);
for (const control of iterableValues(["larkSearchButton", "searchButton", "sourcesFollowSearchButton", "favlistSearchButton"])) {
assert.match(this.script, new RegExp(("" + String(control) + ".{0,220}aria-busy"),"s"), control);
}
},
async test_remote_has_one_layout_and_no_retired_preference_path() {
let combined, obsolete;
combined = concatenate(concatenate(this.markup, this.styles), this.script);
for (const obsolete of iterableValues(["layout-mode-switch", "data-layout-mode", "layout-mode-basic", "layout-mode-full", "bilikara.remote.layout.mode", "normalizeLayoutMode", "renderLayoutMode", "setLayoutMode"])) {
assert.ok(!contains(obsolete, combined));
}
}
};
test("RemoteRequestWorkspaceTest.test_one_request_card_has_four_stable_top_level_tabs_and_panels", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_one_request_card_has_four_stable_top_level_tabs_and_panels(); });
test("RemoteRequestWorkspaceTest.test_top_level_rail_is_full_width_below_the_heading", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_top_level_rail_is_full_width_below_the_heading(); });
test("RemoteRequestWorkspaceTest.test_back_controls_use_centered_svg_and_category_card_geometry", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_back_controls_use_centered_svg_and_category_card_geometry(); });
test("RemoteRequestWorkspaceTest.test_request_tabs_share_queue_transition_without_layout_measurement", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_request_tabs_share_queue_transition_without_layout_measurement(); });
test("RemoteRequestWorkspaceTest.test_quick_is_single_line_and_view_memory_is_session_only", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_quick_is_single_line_and_view_memory_is_session_only(); });
test("RemoteRequestWorkspaceTest.test_history_export_uses_modal_and_preserves_download_authority", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_history_export_uses_modal_and_preserves_download_authority(); });
test("RemoteRequestWorkspaceTest.test_empty_queue_uses_host_text_keys", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_empty_queue_uses_host_text_keys(); });
test("RemoteRequestWorkspaceTest.test_quick_request_actions_match_host_primary_secondary_layout", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_quick_request_actions_match_host_primary_secondary_layout(); });
test("RemoteRequestWorkspaceTest.test_each_secondary_tablist_has_stable_direct_ownership", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_each_secondary_tablist_has_stable_direct_ownership(); });
test("RemoteRequestWorkspaceTest.test_every_live_form_and_result_surface_has_one_owner", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_every_live_form_and_result_surface_has_one_owner(); });
test("RemoteRequestWorkspaceTest.test_advanced_modal_more_button_and_modal_state_are_retired", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_advanced_modal_more_button_and_modal_state_are_retired(); });
test("RemoteRequestWorkspaceTest.test_stage_one_and_surrounding_remote_cards_remain_direct", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_stage_one_and_surrounding_remote_cards_remain_direct(); });
test("RemoteRequestWorkspaceTest.test_shared_i18n_keys_drive_all_tabs_in_three_languages", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_shared_i18n_keys_drive_all_tabs_in_three_languages(); });
test("RemoteRequestWorkspaceTest.test_scrollable_rail_and_bounded_request_card_contract", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_scrollable_rail_and_bounded_request_card_contract(); });
test("RemoteRequestWorkspaceTest.test_remote_controls_share_mobile_geometry_with_distinct_tab_selection", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_remote_controls_share_mobile_geometry_with_distinct_tab_selection(); });
test("RemoteRequestWorkspaceTest.test_no_request_content_swipe_or_generic_router_was_added", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_no_request_content_swipe_or_generic_router_was_added(); });
test("RemoteRequestWorkspaceTest.test_data_views_keep_independent_state_and_stale_response_guards", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_data_views_keep_independent_state_and_stale_response_guards(); });
test("RemoteRequestWorkspaceTest.test_browse_uses_document_scroll_and_explicit_result_pages", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_browse_uses_document_scroll_and_explicit_result_pages(); });
test("RemoteRequestWorkspaceTest.test_only_loading_and_empty_browse_messages_remain_inline", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_only_loading_and_empty_browse_messages_remain_inline(); });
test("RemoteRequestWorkspaceTest.test_remote_song_detail_is_viewport_scoped_outside_filtered_request_card", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_remote_song_detail_is_viewport_scoped_outside_filtered_request_card(); });
test("RemoteRequestWorkspaceTest.test_tab_controller_keeps_nodes_state_focus_and_networks_independent", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_tab_controller_keeps_nodes_state_focus_and_networks_independent(); });
test("RemoteRequestWorkspaceTest.test_async_forms_have_one_owner_and_busy_guards", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_async_forms_have_one_owner_and_busy_guards(); });
test("RemoteRequestWorkspaceTest.test_remote_has_one_layout_and_no_retired_preference_path", async () => { const instance = Object.create(RemoteRequestWorkspaceTest); await instance.setUpClass(); await instance.test_remote_has_one_layout_and_no_retired_preference_path(); });
