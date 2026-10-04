import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, splitOnce, sourceIndex, lastSourceIndex, firstMatch, iterableValues, concatenate, countOccurrences } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const HostBuildReviewRepairTest = {
async test_progress_revisions_do_not_invalidate_workspace_rendering() {
(await checked("node", ["tests/render_signatures.cjs"], ROOT));
},
async test_runtime_settings_account_and_media_status_presentation() {
(await checked("node", ["tests/runtime_settings_status.cjs"], ROOT));
},
async setUpClass() {
this.markup = readFileSync(path.join(path.join(ROOT, "static"), "index.html"), "utf8");
this.remote_markup = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
this.styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
this.remote_styles = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
this.script = readFileSync(path.join(path.join(ROOT, "static"), "app.js"), "utf8");
this.remote_script = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.translations = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"));
this.design = readFileSync(path.join(ROOT, "docs", "shared-host-ui.md"), "utf8");
},
async test_host_and_remote_share_one_theme_accent_palette() {
let accent, palette, rule, selector, styles;
palette = readFileSync(path.join(path.join(ROOT, "static"), "accent-palette.css"), "utf8");
for (const styles of iterableValues([this.styles, this.remote_styles])) {
assert.ok(hasContent(styles.startsWith("@import url(\"./accent-palette.css\");")));
assert.doesNotMatch(styles, new RegExp("--accent(?:-deep|-soft|-soft-hover)?\\s*:",""));
}
for (const [selector, accent] of iterableValues([[":root", "#d05a3f"], [":root[data-theme=\"dark\"]", "#e06c53"], [":root[data-theme=\"blue\"]", "#00d2ff"]])) {
rule = palette.match(new RegExp(concatenate(RegExp.escape(selector), "\\s*\\{([^}]*)\\}"),""))[1];
assert.ok(contains(("--accent: " + String(accent) + ";"), rule));
}
},
async test_right_dock_has_six_direct_icon_and_label_destinations() {
let expected, rail;
expected = ["queue", "history", "request", "random", "users", "settings"];
assert.deepEqual(Array.from(this.markup.matchAll(new RegExp("data-host-workspace=\"([^\"]+)\"","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)), expected);
rail = this.markup.match(new RegExp("<nav class=\"work-rail\".*?</nav>","s"))[0];
assert.ok(contains("class=\"work-rail-icon\"", rail));
assert.deepEqual(countOccurrences(rail, "<svg"), 6);
assert.match(this.markup, new RegExp("id=\"host-workspace-history\".*?</aside>\\s*</section>\\s*</section>\\s*<nav class=\"work-rail\"","s"));
assert.ok(contains(".layout > .work-rail", this.styles));
},
async test_restore_banner_floats_without_reserving_a_shell_row() {
let banner, banner_rule, region_rule, rule, shell_rule;
banner = this.markup.match(new RegExp("<section class=\"backup-banner hidden\" id=\"backup-banner\"[^>]*>",""))[0];
assert.ok(contains("aria-hidden=\"true\"", banner));
assert.ok(contains("inert", banner));
region_rule = Array.from(this.styles.matchAll(new RegExp("\\.critical-banner-region\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("position: fixed", region_rule));
assert.ok(contains("height: 0", region_rule));
assert.ok(contains("z-index: var(--host-layer-critical)", region_rule));
assert.ok(contains("pointer-events: none", region_rule));
shell_rule = firstMatch(Array.from(Array.from(iterableValues(Array.from(this.styles.matchAll(new RegExp("\\.app-shell\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)))) .filter((rule) => (contains("--host-shell-padding-inline", rule)))).map((rule) => rule));
assert.ok(contains("grid-template-rows: auto minmax(0, 1fr)", shell_rule));
banner_rule = Array.from(this.styles.matchAll(new RegExp("\\.critical-banner-region \\.backup-banner\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1))[0];
assert.ok(contains("position: absolute", banner_rule));
assert.ok(contains("opacity: 0", banner_rule));
assert.ok(contains("translate(-50%, -16px)", banner_rule));
assert.ok(contains("opacity 360ms", banner_rule));
assert.ok(contains("transform 360ms", banner_rule));
assert.ok(contains(".backup-banner.is-visible", this.styles));
assert.ok(contains("function showBackupBanner(banner = elements.backupBanner, motion = state)", this.script));
assert.ok(contains("function hideBackupBanner({ immediate = false, banner = elements.backupBanner, motion = state } = {})", this.script));
assert.ok(contains("banner.setAttribute(\"aria-hidden\", \"false\")", this.script));
assert.ok(contains("banner.setAttribute(\"aria-hidden\", \"true\")", this.script));
},
async test_host_global_viewport_layers_are_semantic_and_ordered() {
let layer, layer_names, layers, name, rule, rules, selector, selector_layers;
layer_names = ["header", "modal", "modal-content", "tooltip", "confirm", "toast", "fullscreen", "fullscreen-controls", "critical"];
layers = Object.fromEntries(Array.from(Array.from(iterableValues(layer_names))).map((name) => [name, Number(this.styles.match(new RegExp(("--host-layer-" + String(name) + ":\\s*(\\d+)"),""))[1])]));
assert.deepEqual(Array.from(Array.from(iterableValues(layer_names))).map((name) => layers[name]), Array.from(Object.values(layers)).sort((a, b) => typeof a === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0));
selector_layers = {[".topbar"]: "header", [".selection-modal"]: "modal", [".rating-modal"]: "modal", [".audio-variant-backdrop"]: "modal", [".stage-control-backdrop"]: "modal", [".audio-variant-popover"]: "modal-content", [".stage-control-tray"]: "modal-content", [".cache-advanced-info .cache-advanced-tooltip"]: "tooltip", [".confirm-popover"]: "confirm", [".app-toast"]: "toast", [".player-panel.is-tauri-fullscreen"]: "fullscreen", ["body.is-presentation-stage-only .player-panel"]: "fullscreen", ["body.is-presentation-stage-only .player-panel > .panel-head"]: "fullscreen-controls", [".critical-banner-region"]: "critical"};
for (const [selector, layer] of iterableValues(Object.entries(selector_layers))) {
rules = Array.from(this.styles.matchAll(new RegExp((String(RegExp.escape(selector)) + "\\s*\\{([^}]*)\\}"),"g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.ok(hasContent(rules), selector);
assert.ok(hasContent(Array.from(Array.from(iterableValues(rules))).map((rule) => (contains(("z-index: var(--host-layer-" + String(layer) + ")"), rule))).some(Boolean)), selector);
}
assert.ok(!contains("z-index: 9999", this.styles));
assert.ok(!contains("z-index: 10001", this.styles));
assert.ok(!contains("z-index: 1305", this.styles));
assert.ok(!contains("z-index: 1400", this.styles));
},
async test_request_actions_use_toasts_and_duplicate_confirm_measures_real_height() {
let add_by_url, confirm_render, confirm_rule, form_message, remote_add_by_url;
form_message = this.script.slice(sourceIndex(this.script, "function setFormMessage"), sourceIndex(this.script, "function setSearchMessage"));
assert.ok(contains("elements.formMessage.textContent = \"\"", form_message));
assert.ok(contains("setAppMessage(message, isError)", form_message));
add_by_url = this.script.slice(sourceIndex(this.script, "async function handleAddByUrl"), sourceIndex(this.script, "async function discardBackup"));
assert.ok(contains("setRequestActionMessage", add_by_url));
assert.ok(!contains("setMessageForSource", add_by_url));
remote_add_by_url = this.remote_script.slice(sourceIndex(this.remote_script, "async function addByUrl"), sourceIndex(this.remote_script, "async function confirmGatchaCandidate"));
assert.ok(contains("setAppMessage", remote_add_by_url));
assert.ok(!contains("setMessageForSource", remote_add_by_url));
confirm_render = this.script.slice(sourceIndex(this.script, "function renderConfirmPopover"), sourceIndex(this.script, "function anchorPointForEvent"));
assert.ok(contains("elements.confirmPopover.offsetWidth", confirm_render));
assert.ok(contains("style.visibility = \"hidden\"", confirm_render));
assert.ok(contains("elements.confirmPopover.offsetHeight", confirm_render));
confirm_rule = this.styles.match(new RegExp("\\.confirm-popover\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("max-height: calc(100dvh - 24px)", confirm_rule));
assert.ok(contains("overflow-y: auto", confirm_rule));
},
async test_narrow_request_mode_tabs_do_not_reserve_a_status_message_column() {
let media, mode_head, mode_tabs;
media = this.styles.slice(sourceIndex(this.styles, "@media (max-width: 699px)"), sourceIndex(this.styles, "@media (pointer: coarse)"));
mode_head = media.match(new RegExp("\\.request-mode-head\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("display: flex", mode_head));
assert.ok(!contains("grid-template-columns", mode_head));
mode_tabs = media.match(new RegExp("\\.request-mode-tabs\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: auto", mode_tabs));
assert.ok(!contains("request-mode-contract", this.markup));
assert.ok(!contains("searchModeContract", this.script));
},
async test_peer_buttons_and_close_controls_share_geometry_and_motion() {
let conventional_actions, declaration, form_action_rule, pool_head_rule, secret_actions_rule, secret_input_rule, source_action_rule;
assert.ok(contains(`width: 32px;
  height: 32px;`, this.styles));
assert.ok(contains("font: 400 20px/0 sans-serif", this.styles));
assert.ok(contains("#dismiss-backup-button.is-close-glyph", this.styles));
assert.ok(contains(`.critical-banner-region .backup-actions .banner-action,
.critical-banner-region .backup-actions .next-button,
.critical-banner-region .backup-actions .banner-close`, this.styles));
assert.ok(contains(`.selection-modal-actions .toolbar-button,
.selection-modal-actions .next-button`, this.styles));
assert.ok(contains("background: var(--btn-secondary-bg)", this.styles));
assert.ok(!contains(".banner-close:active:not(:disabled)", this.styles));
assert.ok(!contains(".rating-close:active:not(:disabled)", this.styles));
secret_input_rule = this.styles.match(new RegExp("\\.bilikara-secret-form \\.input-group input\\s*\\{([^}]*)\\}",""))[1];
for (const declaration of iterableValues(["height: var(--host-control-height)", "min-height: var(--host-control-height)", "border: 1px solid var(--line)", "border-radius: var(--host-control-radius)", "background: var(--input-bg)", "color: var(--ink)", "font-size: var(--host-control-font-size)"])) {
assert.ok(contains(declaration, secret_input_rule));
}
conventional_actions = splitOnce(splitOnce(this.styles, "/* Conventional workspace actions")[1], ".tag-letter-button")[0];
assert.ok(contains("font-weight: 400", conventional_actions));
source_action_rule = this.styles.match(new RegExp("\\.source-action-row input,\\s*\\.source-action-row button\\s*\\{([^}]*)\\}",""))[1];
for (const declaration of iterableValues(["height: var(--source-action-control-height)", "border-radius: var(--host-control-radius)", "font-family: var(--font-sans)", "font-size: var(--host-control-font-size)", "font-weight: 400", "line-height: 1"])) {
assert.ok(contains(declaration, source_action_rule));
}
assert.ok(contains(".source-action-row input:focus", this.styles));
assert.ok(contains(".bilikara-secret-form .search-message:empty", this.styles));
assert.ok(contains(":root:is([data-theme=\"dark\"], [data-theme=\"blue\"]) .bilikara-secret-form .selection-modal-actions", this.styles));
secret_actions_rule = this.styles.match(new RegExp("\\.bilikara-secret-form \\.selection-modal-actions\\s*\\{([^}]*)\\}",""))[1];
for (const declaration of iterableValues(["margin-top: 0", "padding: 0", "border-top: 0", "background: transparent"])) {
assert.ok(contains(declaration, secret_actions_rule));
}
assert.ok(contains("--remote-peer-action-height: 44px", this.remote_styles));
assert.ok(contains("--remote-close-control-size: 32px", this.remote_styles));
assert.ok(contains(`.binding-sheet-close,
.rating-close`, this.remote_styles));
pool_head_rule = this.remote_styles.match(new RegExp("\\.pool-config-head-actions \\.ghost-button\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("height: var(--remote-peer-action-height)", pool_head_rule));
assert.ok(contains("font-size: var(--remote-peer-action-font-size)", pool_head_rule));
form_action_rule = this.remote_styles.match(new RegExp("\\.remote-identity-actions :is\\(\\.primary-button, \\.ghost-button\\),\\s*\\.internet-remote-join-card \\.primary-button\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("height: var(--remote-form-control-height)", form_action_rule));
assert.ok(contains("min-height: var(--remote-form-control-height)", form_action_rule));
assert.ok(contains("border-radius: var(--remote-form-control-radius)", form_action_rule));
},
async test_remote_sheets_remain_centered_dismissible_with_separate_host_backdrop_policy() {
let backdrop_name, button, close_buttons, close_call, dialog, dialog_id, languages, panel_rule, pool_slider, sheet_rule, surface_styles, volume_slider_rule;
for (const dialog_id of iterableValues(["binding-sheet", "gatcha-favlist-sheet", "gatcha-pool-config-sheet", "reorder-confirm-sheet"])) {
dialog = this.remote_markup.match(new RegExp(("<div[^>]+id=\"" + String(dialog_id) + "\"[^>]+>"),""))[0];
assert.ok(contains("role=\"dialog\"", dialog));
assert.ok(contains("aria-modal=\"true\"", dialog));
}
close_buttons = Array.from(this.remote_markup.matchAll(new RegExp("<button[^>]+class=\"binding-sheet-close\"[^>]*><svg class=\"close-icon\"[^>]*><path[^>]+/></svg></button>","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(close_buttons.length, 5);
assert.ok(hasContent(Array.from(Array.from(iterableValues(close_buttons))).map((button) => (contains("data-i18n-aria-label=\"common.close\"", button))).every(Boolean)));
sheet_rule = this.remote_styles.match(new RegExp("\\.binding-sheet\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("display: grid", sheet_rule));
assert.ok(contains("place-items: center", sheet_rule));
panel_rule = this.remote_styles.match(new RegExp("\\.binding-sheet-panel\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("position: relative", panel_rule));
assert.ok(contains("border-radius: 20px", panel_rule));
assert.ok(!contains("bottom: 0", panel_rule));
surface_styles = readFileSync(path.join(path.join(ROOT, "static"), "ui-surfaces.css"), "utf8");
assert.ok(contains("--modal-surface-blur: 12px", surface_styles));
assert.ok(contains("--modal-card-bg: rgba(var(--modal-surface-rgb), 0.90)", surface_styles));
assert.ok(contains("border-radius: 18px", surface_styles));
assert.ok(contains("--modal-backdrop-blur: 0px", this.styles));
assert.ok(contains("--modal-backdrop-blur: 0px", this.remote_styles));
assert.ok(contains("backdrop-filter: blur(var(--modal-backdrop-blur))", this.styles));
assert.ok(countOccurrences(this.remote_styles, "backdrop-filter: blur(var(--modal-backdrop-blur))") >= 5);
pool_slider = this.remote_markup.match(new RegExp("<input[^>]+id=\"gatcha-pool-weight-slider\"[^>]+>",""))[0];
assert.ok(contains("remote-volume-slider pool-config-weight-slider", pool_slider));
assert.ok(contains("setRangeFillPercent(elements.poolConfigWeightSlider, uidWeight)", this.remote_script));
volume_slider_rule = this.remote_styles.match(new RegExp("\\.remote-volume-slider\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("min-height: 20px", volume_slider_rule));
for (const [backdrop_name, close_call] of iterableValues([["bindingSheetBackdrop", "closeBindingSheet()"], ["gatchaFavlistSheetBackdrop", "closeGatchaFavlistSheet()"], ["poolConfigSheetBackdrop", "closePoolConfigSheet()"], ["reorderConfirmSheetBackdrop", "closeReorderConfirmSheet()"]])) {
assert.match(this.remote_script, new RegExp(("elements\\." + String(backdrop_name) + "\\?\\.addEventListener\\(\\\"click\\\", \\(\\) => \\{\\s*" + String(RegExp.escape(close_call))),""));
}
assert.ok(contains("elements.remoteIdentityBackdrop?.addEventListener(\"click\", closeRemoteIdentityRename)", this.remote_script));
languages = this.translations["languages"];
assert.deepEqual(languages["zh"]["binding.confirm"], "点歌");
assert.deepEqual(languages["en"]["binding.confirm"], "Request Song");
assert.deepEqual(languages["ja"]["binding.confirm"], "リクエスト");
},
async test_part_binding_help_uses_contextual_info_in_both_frontends() {
let host_dialog, languages, remote_dialog;
host_dialog = this.markup.match(new RegExp("<div class=\"selection-modal hidden\" id=\"binding-modal\".*?<div class=\"selection-modal hidden\" id=\"gatcha-favlist-modal\"","s"))[0];
remote_dialog = this.remote_markup.match(new RegExp("<div id=\"binding-sheet\".*?<div id=\"gatcha-favlist-sheet\"","s"))[0];
assert.ok(!contains("id=\"binding-modal-text\"", host_dialog));
assert.ok(!contains("id=\"binding-sheet-text\"", remote_dialog));
assert.ok(contains("binding-modal-title-row cache-contextual-info-region", host_dialog));
assert.ok(contains("aria-describedby=\"binding-modal-help\"", host_dialog));
assert.ok(contains("id=\"binding-modal-help\" role=\"tooltip\"", host_dialog));
assert.ok(contains("binding-sheet-title-row remote-contextual-info-region", remote_dialog));
assert.ok(contains("aria-describedby=\"binding-sheet-help\"", remote_dialog));
assert.ok(contains("id=\"binding-sheet-help\" role=\"tooltip\"", remote_dialog));
assert.ok(!contains("bindingModalText", this.script));
assert.ok(!contains("bindingSheetText", this.remote_script));
assert.ok(contains("function positionRemoteContextualTooltip(wrap)", this.remote_script));
languages = this.translations["languages"];
assert.deepEqual(languages["zh"]["binding.help"], "选择一个分 P 作为视频画面，再选择至少一个分 P 作为可切换的音频。");
assert.deepEqual(languages["en"]["binding.help"], "Choose one part for the video and at least one part for the audio. You can switch between the selected audio tracks during playback.");
assert.deepEqual(languages["ja"]["binding.help"], "映像に使うパートを1つ、音声に使うパートを1つ以上選んでください。選んだ音声は再生中に切り替えられます。");
},
async test_queue_and_history_are_direct_and_next_is_queue_current_owned() {
let current, history, player, queue;
assert.deepEqual(countOccurrences(this.markup, "id=\"next-button\""), 1);
queue = this.markup.match(new RegExp("<aside[^>]+id=\"host-workspace-queue\".*?</aside>","s"))[0];
history = this.markup.match(new RegExp("<aside[^>]+id=\"host-workspace-history\".*?</aside>","s"))[0];
player = this.markup.match(new RegExp("<section class=\"player-panel\">.*?</section>\\s*</section>","s"))[0];
current = queue.match(new RegExp("<section class=\"queue-current[^>]*>.*?</section>","s"))[0];
assert.ok(contains("id=\"next-button\"", current));
assert.ok(!contains("id=\"next-button\"", history));
assert.ok(!contains("id=\"next-button\"", player));
assert.ok(contains("queue-current-next", current));
assert.ok(!contains("data-list-view", this.markup));
assert.ok(!contains("listView:", this.script));
assert.ok(!contains("activateListSubview", this.script));
assert.ok(!contains("syncListSubview", this.script));
assert.ok(contains("data-host-workspace-panel=\"history\"", history));
assert.ok(contains("data-i18n=\"common.clear\">清空</button>", queue));
assert.ok(contains("data-i18n=\"common.clear\">清空</button>", history));
},
async test_shell_uses_one_width_per_state_and_measured_stage_modes() {
let inline_rules, player_frame_rule;
assert.doesNotMatch(this.styles, new RegExp("\\[data-active-workspace=\"(?:queue|history|request|random|users)\"\\]\\s*\\{[^}]*--host-",""));
assert.ok(!contains("data-request-subview", this.styles));
assert.ok(contains("--host-tool-card-width", this.styles));
assert.ok(contains("--host-tool-card-width: minmax(380px, 1fr)", this.styles));
assert.ok(contains("grid-template-columns: minmax(0, 1.82fr) var(--host-tool-card-width)", this.styles));
assert.ok(!contains("--host-tool-dock-width", this.styles));
assert.ok(contains("\"compact\"", this.script));
assert.ok(contains("\"narrow\"", this.script));
assert.ok(contains("data-stage-controls-layout=\"inline\"", this.styles));
assert.ok(contains("id=\"stage-controls-toggle\"", this.markup));
assert.ok(contains("id=\"stage-control-backdrop\"", this.markup));
assert.ok(contains("id=\"stage-control-tray\"", this.markup));
assert.ok(contains("ResizeObserver", this.script));
assert.ok(contains("measurePersistentStage", this.script));
assert.ok(!contains("innerWidth >= 760", this.script));
assert.ok(contains("layout: \"inline\"", this.script));
assert.ok(contains("contentFits: controlsStayOnOneRow && panelColumnsStayAligned && labelledButtonsFit", this.script));
assert.ok(contains("inlineTraySize.contentFits", this.script));
player_frame_rule = Array.from(this.styles.matchAll(new RegExp("\\.left-column \\.player-frame\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("aspect-ratio: 16 / 9", player_frame_rule));
assert.ok(!contains("aspect-ratio: auto", player_frame_rule));
assert.ok(contains("--stage-frame-inline-size", player_frame_rule));
assert.ok(contains("data-i18n=\"player.controls\"", this.markup));
assert.ok(contains("stageControlTrayDirection", this.script));
assert.ok(contains("spaceBelow", this.script));
inline_rules = this.styles.slice(sourceIndex(this.styles, ".app-shell[data-stage-controls-layout=\"inline\"] .left-column > .player-panel"), sourceIndex(this.styles, ".host-workspace-region {", sourceIndex(this.styles, ".app-shell[data-stage-controls-layout=\"inline\"] .left-column > .player-panel")));
assert.ok(contains(".stage-controls-toggle", inline_rules));
assert.ok(contains(".stage-control-tray-head", inline_rules));
assert.ok(contains("display: none", inline_rules));
assert.ok(!contains(".stage-extended-controls .av-sync-panel", inline_rules));
assert.ok(contains("state.stageControlInlineCollapsed = false", this.script));
},
async test_narrow_tool_card_uses_measured_resident_or_bottom_overlay_geometry() {
let narrow_rules;
narrow_rules = this.styles.slice(lastSourceIndex(this.styles, "@media (max-width: 1179px)"), undefined);
assert.ok(contains("grid-template-rows: minmax(0, 1fr)", narrow_rules));
assert.ok(contains("position: absolute", narrow_rules));
assert.ok(contains("inset: auto 0 0", narrow_rules));
assert.ok(contains("height: clamp(360px, 68%, 520px)", narrow_rules));
assert.ok(contains("z-index: 20", narrow_rules));
assert.ok(contains("border-radius: 16px", narrow_rules));
assert.ok(contains("[data-narrow-tool-layout=\"resident\"]", narrow_rules));
assert.ok(contains("--narrow-stage-resident-height", narrow_rules));
assert.ok(contains("grid-template-rows: minmax(0, var(--narrow-stage-resident-height)) minmax(300px, 1fr)", narrow_rules));
assert.match(narrow_rules, new RegExp("\\[data-narrow-tool-layout=\"resident\"\\] \\.left-column\\s*\\{[^}]*z-index: 30;","s"));
assert.ok(!contains("grid-template-rows: clamp(190px, 34%, 280px)", narrow_rules));
assert.ok(contains("state.hostWorkspaceOverlayOpen = false", this.script));
assert.ok(contains("function syncNarrowToolLayout()", this.script));
assert.ok(contains("minimumResidentToolHeight = 300", this.script));
assert.ok(contains("inlineTrayFitsWidth && availableStageHeight >= fullStageHeight", this.script));
assert.ok(contains(": compactStageHeight", this.script));
assert.ok(contains("[data-stage-controls-layout=\"popup\"] .left-column > .player-panel", this.styles));
assert.match(this.styles, new RegExp("\\[data-stage-controls-layout=\"popup\"\\] \\.left-column > \\.player-panel\\s*\\{[^}]*align-content: start;","s"));
assert.ok(contains("dataset.narrowToolLayout = \"overlay\"", this.script));
assert.ok(contains("dataset.narrowToolLayout = \"resident\"", this.script));
assert.ok(contains("previousNarrowToolLayout !== nextNarrowToolLayout", this.script));
assert.ok(contains("window.requestAnimationFrame(schedulePersistentStageMeasurement)", this.script));
},
async test_service_and_playback_controls_use_distinct_reviewed_icons() {
let remote_control_path, rule, service, settings, stage_button;
remote_control_path = "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z";
assert.ok(!contains(remote_control_path, this.remote_markup));
assert.ok(contains(remote_control_path, this.markup));
service = this.markup.match(new RegExp("id=\"cache-settings-toggle\".*?</button>","s"))[0];
assert.ok(contains("M3 12A9 9 0 1 1 18.36 18.36", service));
assert.ok(contains("m12 12 4.3-4.8", service));
assert.ok(contains("M3 16.1h12", service));
assert.ok(contains("<circle cx=\"6.7\" cy=\"16.1\" r=\"1.15\" fill=\"var(--panel)\" stroke=\"currentColor\" stroke-width=\"1.2\"></circle>", service));
assert.ok(contains("M3 20.2h12", service));
assert.ok(contains("<circle cx=\"11.2\" cy=\"20.2\" r=\"1.15\" fill=\"var(--panel)\" stroke=\"currentColor\" stroke-width=\"1.2\"></circle>", service));
assert.ok(!contains("M12 3.5v2", service));
assert.ok(!contains("M12.22 2h-.44", service));
assert.ok(!contains(remote_control_path, service));
settings = this.markup.match(new RegExp("id=\"work-rail-settings\".*?</button>","s"))[0];
assert.ok(contains("M12.22 2h-.44", settings));
assert.ok(contains("<circle cx=\"12\" cy=\"12\" r=\"3\"></circle>", settings));
stage_button = firstMatch(Array.from(Array.from(iterableValues(Array.from(this.styles.matchAll(new RegExp("\\.stage-controls-toggle\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)))) .filter((rule) => (contains("background:", rule)))).map((rule) => rule));
assert.ok(contains("background: var(--accent)", stage_button));
assert.ok(contains("color: var(--on-accent)", stage_button));
},
async test_queue_and_history_actions_share_the_title_row() {
let card_head_rules, toolbar_rules;
card_head_rules = Array.from(this.styles.matchAll(new RegExp("\\.host-workspace-region \\.queue-card-head\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("grid-template-columns: minmax(0, 1fr) auto", card_head_rules));
assert.ok(contains("grid-template-rows: auto auto", card_head_rules));
toolbar_rules = Array.from(this.styles.matchAll(new RegExp("\\.host-workspace-region \\.queue-toolbar\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("grid-column: 2", toolbar_rules));
assert.ok(contains("grid-row: 2", toolbar_rules));
},
async test_toolbar_badge_messages_and_product_copy_match_review() {
let expected_gatcha, language, service_wrap, topbar_rule, update_dot, values;
assert.ok(contains("class=\"global-action-icon\"", this.markup));
assert.ok(countOccurrences(this.markup, "class=\"global-action-icon\"") >= 3);
assert.match(this.styles, new RegExp("\\.topbar \\.control-label[^}]*font-size:\\s*(?:13|14|15|16)px",""));
service_wrap = this.styles.match(new RegExp("\\.service-status-wrap\\s*\\{([^}]*)\\}",""))[1];
assert.ok(!contains("border:", service_wrap));
assert.ok(!contains("service-status-ring", this.markup));
assert.ok(contains("--update-available-dot: var(--accent)", this.styles));
update_dot = this.styles.match(new RegExp("\\.work-rail-update-dot\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: 7px", update_dot));
assert.ok(contains("height: 7px", update_dot));
assert.ok(contains("background: var(--accent)", update_dot));
assert.ok(contains("0 0 0 3px", update_dot));
assert.ok(!contains("setClassToggle(elements.serviceUpdateIndicator, \"has-update\"", this.script));
assert.ok(contains("syncUpdateIndicator(elements.settingsUpdateIndicator, eligible, accessibleText)", this.script));
topbar_rule = Array.from(this.styles.matchAll(new RegExp("^\\.topbar\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("border-bottom: 0", topbar_rule));
assert.ok(contains("background: transparent", topbar_rule));
assert.ok(contains(".message-surface", this.styles));
assert.ok(contains("white-space: normal", this.styles));
for (const [language, values] of iterableValues(Object.entries(this.translations["languages"]))) {
expected_gatcha = {["zh"]: "试试运气", ["en"]: "Gatcha", ["ja"]: "ガチャ"}[language];
assert.deepEqual(values["shell.random"], expected_gatcha, language);
assert.deepEqual(values["gatcha.title"], expected_gatcha, language);
assert.ok(!contains("Discover", values["request.workspaceTitle"]), language);
assert.ok(!contains("发现", values["request.workspaceTitle"]), language);
assert.ok(!contains("見つ", values["request.workspaceTitle"]), language);
}
},
async test_playback_controls_share_one_divided_surface_and_gatcha_restores_web_dice() {
let aligned_controls, combined_surfaces, control_rows, gatcha_rail, idle_view, inline_tray, rule;
assert.ok(contains(".stage-extended-controls > .av-sync-panel + .volume-panel", this.styles));
combined_surfaces = Array.from(this.styles.matchAll(new RegExp("\\.stage-extended-controls\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.ok(hasContent(Array.from(Array.from(iterableValues(combined_surfaces))).map((rule) => (contains("gap: 0", rule))).some(Boolean)));
assert.ok(hasContent(Array.from(Array.from(iterableValues(combined_surfaces))).map((rule) => (contains("border: 1px solid var(--line)", rule))).some(Boolean)));
assert.ok(hasContent(Array.from(Array.from(iterableValues(combined_surfaces))).map((rule) => (contains("background: var(--bottom-panel-bg)", rule))).some(Boolean)));
control_rows = this.styles.match(new RegExp("\\.stage-extended-controls > \\.av-sync-panel,\\s*\\.stage-extended-controls > \\.volume-panel\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("grid-template-columns: minmax(112px, max-content) minmax(0, 1fr)", control_rows));
assert.ok(contains("border: 0", control_rows));
aligned_controls = this.styles.match(new RegExp("\\.stage-extended-controls \\.av-sync-controls,\\s*\\.stage-extended-controls \\.volume-controls\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: max-content", aligned_controls));
assert.ok(contains("justify-self: end", aligned_controls));
inline_tray = this.styles.match(new RegExp("\\.app-shell\\[data-stage-controls-layout=\"inline\"\\] \\.stage-control-tray\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("z-index: 7", inline_tray));
gatcha_rail = this.markup.match(new RegExp("id=\"work-rail-random\"(?<body>.*?)</button>","s")).groups["body"];
assert.ok(contains("<rect", gatcha_rail));
assert.ok(countOccurrences(gatcha_rail, "<circle") >= 5);
idle_view = this.markup.match(new RegExp("id=\"gatcha-init-view\"(?<body>.*?)</section>","s")).groups["body"];
assert.ok(contains("<div class=\"gatcha-icon\" aria-hidden=\"true\">🎲</div>", idle_view));
assert.ok(!contains("<svg", idle_view));
},
async test_empty_player_uses_one_i18n_key_before_and_after_runtime_render() {
let empty_renderer, expected;
empty_renderer = this.script.slice(sourceIndex(this.script, "function renderEmptyHostPlaybackState"), sourceIndex(this.script, "function renderPreparingHostPlaybackState"));
assert.ok(contains("t(\"player.empty\")", empty_renderer));
assert.ok(!contains("player.emptyShort", empty_renderer));
assert.ok(!contains("\"player.emptyShort\"", JSON.stringify(this.translations)));
expected = "把 Bilibili 或 YouTube 视频链接加入点歌列表后，这里会开始播放。";
assert.deepEqual(this.translations["languages"]["zh"]["player.empty"], expected);
assert.ok(contains(("data-i18n=\"player.empty\">" + String(expected) + "</p>"), this.markup));
},
async test_peer_workspace_and_dialog_headers_share_one_geometry_contract() {
let selector;
assert.ok(contains("--host-peer-eyebrow-size: 12px", this.styles));
assert.ok(contains("--host-peer-title-size: 24px", this.styles));
assert.ok(contains("--host-peer-action-height: 44px", this.styles));
assert.ok(contains("--host-peer-head-padding-inline: 16px", this.styles));
for (const selector of iterableValues([".panel-head", ".host-workspace-region .queue-card-head", ".request-workspace-head", ".host-workspace-region .request-head", ".selection-modal-head"])) {
assert.ok(contains(selector, this.styles));
}
assert.ok(contains("class=\"host-peer-heading\"", this.markup));
},
async test_sources_and_pool_use_direct_compact_responsive_controls() {
let pool_slider;
pool_slider = this.markup.match(new RegExp("<input[^>]+id=\"gatcha-pool-weight-slider\"[^>]+>",""))[0];
assert.ok(contains("class=\"volume-slider pool-config-weight-slider\"", pool_slider));
assert.ok(!contains("id=\"open-favorites-button\"", this.markup));
assert.ok(!contains("data-sources-mode=\"followed\"", this.markup));
assert.ok(contains("data-i18n=\"sources.ownerList\">UP 主列表", this.markup));
assert.ok(contains("data-i18n=\"gatcha.refresh\">手动更新", this.markup));
assert.ok(!contains("data-i18n=\"sources.refreshVideos\">刷新视频", this.markup));
assert.ok(contains("setRangeFillPercent(elements.poolConfigWeightSlider", this.script));
assert.ok(contains("--source-card-min-inline-size: 104px", this.styles));
assert.ok(contains("repeat(auto-fill, minmax(min(100%, var(--source-card-min-inline-size)), 1fr))", this.styles));
assert.ok(contains("--request-song-card-min-inline-size: 200px", this.styles));
assert.ok(countOccurrences(this.styles, "minmax(min(100%, var(--request-song-card-min-inline-size)), 1fr)") >= 2);
assert.ok(!contains("minmax(min(100%, 280px), 1fr)", this.styles));
assert.ok(contains("justify-content: stretch", this.styles));
assert.ok(contains("height: var(--source-action-control-height)", this.styles));
},
async test_discover_hierarchy_uses_one_local_scroll_owner_per_level() {
let owner, selector;
owner = this.script.slice(sourceIndex(this.script, "function activeRequestScrollOwner"), sourceIndex(this.script, "function normalizedD1BrowseLevel"));
for (const selector of iterableValues(["[data-category-browser-home]", "[data-category-browse-results]", "[data-d1-browse-tags]", "[data-d1-browse-results]"])) {
assert.ok(contains(selector, owner));
}
assert.ok(contains(`.request-discover-view > .request-mode-panel {
  overflow: hidden;`, this.styles));
assert.ok(contains(".request-discover-view .category-browser,", this.styles));
assert.ok(contains(`height: 100%;
  overflow: hidden;`, this.styles));
assert.ok(contains(".tag-browser.has-request-session-user-notice", this.styles));
assert.ok(contains(".category-browser-detail.has-request-session-user-notice", this.styles));
},
async test_follow_owner_detail_assigns_scrolling_to_cards_only() {
let owner;
owner = this.script.slice(sourceIndex(this.script, "function activeRequestScrollOwner"), sourceIndex(this.script, "function normalizedD1BrowseLevel"));
assert.ok(contains("state.followBrowseSelectedUid", owner));
assert.ok(contains("elements.followSongResults", owner));
assert.ok(contains("#request-sources-followed-scroll.is-detail-view #follow-song-results", this.styles));
assert.ok(contains("overflow-y: hidden", this.styles));
assert.ok(contains("overflow-y: auto", this.styles));
},
async test_player_fullscreen_overrides_persistent_card_and_webkit_insets() {
let declaration, fullscreen_rule, selector;
for (const selector of iterableValues([".left-column > .player-panel:fullscreen", ".left-column > .player-panel:-webkit-full-screen", ".left-column > .player-panel.is-tauri-fullscreen", "body.is-tauri-fullscreen-active .app-shell"])) {
assert.ok(contains(selector, this.styles));
}
fullscreen_rule = this.styles.slice(lastSourceIndex(this.styles, "/* Player fullscreen must win"), undefined);
for (const declaration of iterableValues(["position: fixed;", "inset: 0;", "padding: 0;", "border: 0;", "border-radius: 0;", "box-shadow: none;"])) {
assert.ok(contains(declaration, fullscreen_rule));
}
},
async test_fullscreen_exit_combines_remote_qr_and_touch_safe_exit() {
let declaration, fullscreen_popover, fullscreen_popover_end, fullscreen_popover_start, links, marker;
for (const marker of iterableValues(["id=\"player-fullscreen-control\"", "id=\"player-fullscreen-remote-popover\"", "id=\"player-fullscreen-remote-qr-image\"", "id=\"player-fullscreen-public-meta\"", "id=\"player-fullscreen-public-qr-image\"", "id=\"player-fullscreen-public-password\"", "class=\"fullscreen-enter-icon\"", "class=\"fullscreen-phone-icon\"", "class=\"fullscreen-exit-icon\""])) {
assert.ok(contains(marker, this.markup));
}
for (const marker of iterableValues(["function setPlayerFullscreenRemotePinned", "function playerFullscreenActivationUsesTouch", "function syncPlayerFullscreenExpandedWidth", "setPlayerFullscreenRemotePinned(true)", "playerFullscreenPublicMeta"])) {
assert.ok(contains(marker, this.script));
}
fullscreen_popover_start = sourceIndex(this.markup, "<div class=\"fullscreen-remote-popover remote-access-popover\"");
fullscreen_popover_end = sourceIndex(this.markup, "<div class=\"player-frame\"", fullscreen_popover_start);
fullscreen_popover = this.markup.slice(fullscreen_popover_start, fullscreen_popover_end);
assert.ok(!contains("<button", fullscreen_popover));
assert.ok(!contains("<input", fullscreen_popover));
links = Array.from(fullscreen_popover.matchAll(new RegExp("<a\\b[^>]*>","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(links.length, 1);
assert.ok(contains("id=\"player-fullscreen-remote-url\"", links[0]));
assert.ok(contains("aria-disabled=\"true\"", links[0]));
assert.ok(contains("tabindex=\"-1\"", links[0]));
assert.ok(!contains("href=", links[0]));
assert.ok(contains("M14 10l6-6M15 4h5v5M10 14l-6 6M4 15v5h5", this.markup));
assert.ok(contains("M20 4l-6 6M14 5v5h5M4 20l6-6M5 14h5v5", this.markup));
assert.ok(contains(".fullscreen-action-control.is-qr-pinned .fullscreen-remote-popover", this.styles));
for (const declaration of iterableValues(["--fullscreen-action-collapsed-width: 84px;", "--fullscreen-action-expanded-width: 112px;", "--fullscreen-action-label-width: 110px;", "--fullscreen-action-label-gap: 8px;", "width: var(--fullscreen-action-collapsed-width);", "width: var(--fullscreen-action-expanded-width);", "width 170ms cubic-bezier(0.16, 1, 0.3, 1)"])) {
assert.ok(contains(declaration, this.styles));
}
assert.ok(!contains("html:lang(en) .fullscreen-action-control", this.styles));
assert.ok(!contains("html:lang(ja) .fullscreen-action-control", this.styles));
assert.ok(!contains("max-width: 180px;", this.styles));
},
async test_fullscreen_address_updates_disable_stale_links_and_use_external_open() {
let script;
script = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/app.js', 'utf8').replace(/\\r\\n/g, '\\n');
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const listeners = {}, opened = [];
const link = {
  href: '', attributes: {}, classList: {remove() {}},
  setAttribute(name, value) { this.attributes[name] = value; },
  removeAttribute(name) { delete this.attributes[name]; if (name === 'href') this.href = ''; },
  addEventListener(type, listener) { listeners[type] = listener; },
};
const context = {
  URL, elements: {playerFullscreenRemoteUrl: link},
  setTextContent(node, text) { if (node) node.textContent = text; },
  t: (key) => key, renderRemoteQr() {}, renderProvidedRemoteQr() {},
  openExternalUrl: (url) => opened.push(url),
};
vm.createContext(context);
vm.runInContext(
  slice('function renderPlayerFullscreenRemoteAccess', 'function normalizedRemoteHttpUrl') +
  slice('function openRemoteAccessLink', 'const developerTagResetFieldKeys') +
  slice('[\\n  elements.remoteUrlLink,', 'elements.presentationOutputButton?.addEventListener'),
  context,
);
let prevented = 0;
const click = () => listeners.click({currentTarget: link, preventDefault() { prevented++; }});
const disabled = () => {
  assert.equal(link.href, '');
  assert.equal(link.tabIndex, -1);
  assert.equal(link.attributes['aria-disabled'], 'true');
  assert.equal(link.textContent, 'remote.noAddress');
  const count = opened.length;
  click();
  assert.equal(opened.length, count);
};
context.renderPlayerFullscreenRemoteAccess({});
disabled();
for (const url of ['http://192.168.1.10:8080/remote', 'https://example.test/remote?fixture=one']) {
  context.renderPlayerFullscreenRemoteAccess({localDisplayUrl: \` \${url} \`});
  assert.equal(link.href, url);
  assert.equal(link.tabIndex, 0);
  assert.equal(link.attributes['aria-disabled'], 'false');
  assert.equal(link.textContent, new URL(url).origin + new URL(url).pathname);
  click();
  assert.equal(opened.at(-1), url);
  context.renderPlayerFullscreenRemoteAccess({localDisplayUrl: ''});
  disabled();
}
assert.equal(prevented, 2);
`;
(await checked("node", ["-e", script], ROOT));
},
async test_stage_density_prefers_full_frame_and_checks_group_overflow() {
let attribute, label, markup, step;
assert.ok(contains("data-stage-control-density=\"compact\"", this.styles));
assert.ok(contains("data-stage-control-density=\"plain\"", this.styles));
for (const [markup, attribute] of iterableValues([[this.markup, "data-step"], [this.remote_markup, "data-av-step"]])) {
for (const step of iterableValues([(-200), (-50), 50, 200])) {
label = ((step >= 0 ? "+" : "") + String(step));
assert.match(markup, new RegExp((String(attribute) + "=\"" + String(step) + "\">" + String(RegExp.escape(label)) + "</button>"),""));
}
}
assert.ok(contains("controls.scrollWidth <= controls.clientWidth + 1", this.script));
assert.ok(contains("fullFrameWithInlineControlsFits", this.script));
assert.ok(contains("findStageControlFit", this.script));
},
async test_platform_specific_tauri_chrome_is_explicit() {
let macos, main_capability, permission, window, windows, windows_path;
windows_path = path.join(path.join(ROOT, "src-tauri"), "tauri.windows.conf.json");
assert.ok(hasContent(existsSync(windows_path)));
windows = JSON.parse(readFileSync(windows_path, "utf8"));
window = windows["app"]["windows"][0];
assert.ok(!hasContent(window["decorations"]));
main_capability = JSON.parse(readFileSync(path.join(path.join(path.join(ROOT, "src-tauri"), "capabilities"), "main.json"), "utf8"));
for (const permission of iterableValues(["core:window:allow-close", "core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-start-dragging"])) {
assert.ok(contains(permission, main_capability["permissions"]));
}
macos = JSON.parse(readFileSync(path.join(path.join(ROOT, "src-tauri"), "tauri.macos.conf.json"), "utf8"))["app"]["windows"][0];
assert.deepEqual(macos["titleBarStyle"], "Overlay");
assert.ok(hasContent(macos["hiddenTitle"]));
assert.ok(contains("id=\"window-controls\"", this.markup));
assert.ok(contains("initializeWindowChrome", this.script));
},
async test_integrated_titlebar_and_followed_sources_use_peer_sizing() {
let brand_rule, eyebrow_rule, request_follow_grids, request_follow_name, rule, shell_rule, title_rule, topbar_rule, transition_out_rule, transition_styles, value, values, window_controls;
shell_rule = Array.from(this.styles.matchAll(new RegExp("^\\.app-shell\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("padding: 0 var(--host-shell-padding-inline) 12px", shell_rule));
brand_rule = Array.from(this.styles.matchAll(new RegExp("^\\.host-brand\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("min-width: 142px", brand_rule));
assert.ok(contains("display: flex", brand_rule));
title_rule = Array.from(this.styles.matchAll(new RegExp("^\\.host-brand h1\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("font-size: 28px", title_rule));
eyebrow_rule = Array.from(this.styles.matchAll(new RegExp("^\\.host-brand \\.eyebrow\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("display: none", eyebrow_rule));
assert.ok(!contains("KARAOKE HOST", this.markup));
topbar_rule = Array.from(this.styles.matchAll(new RegExp("^\\.topbar\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("border-bottom: 0", topbar_rule));
window_controls = Array.from(this.styles.matchAll(new RegExp("^\\.window-controls\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(!contains("margin-right", window_controls));
transition_out_rule = Array.from(this.styles.matchAll(new RegExp("^\\.host-workspace-fragment\\.is-tool-transition-out\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("background: transparent !important", transition_out_rule));
assert.ok(contains("border-color: transparent !important", transition_out_rule));
assert.ok(contains("box-shadow: none !important", transition_out_rule));
assert.ok(!contains("@keyframes host-tool-transition-veil", this.styles));
assert.ok(contains("@keyframes host-tool-content-out", this.styles));
assert.ok(contains("@keyframes host-tool-content-in", this.styles));
assert.ok(contains("@keyframes host-tool-content-resume", this.styles));
assert.ok(contains("animation: host-tool-content-out 70ms cubic-bezier(0.4, 0, 1, 1) both", this.styles));
assert.ok(contains("animation: host-tool-content-in 190ms linear both", this.styles));
transition_styles = this.styles.slice(sourceIndex(this.styles, ".host-workspace-fragment.is-tool-transition-out"), sourceIndex(this.styles, ".request-workspace {"));
assert.ok(!contains("translateX", transition_styles));
assert.ok(!contains("translateY", transition_styles));
assert.ok(contains("background-color 150ms ease-out", this.styles));
assert.ok(!contains("syncHostWorkspaceRailHighlight", this.script));
assert.ok(contains("renderHostWorkspaceSelection({ measureNarrowLayout: false })", this.script));
assert.ok(contains("const inlineControls = narrowShell", this.script));
request_follow_grids = Array.from(this.styles.matchAll(new RegExp("#host-workspace-request \\.follow-up-grid,\\s*\\.request-workspace \\.follow-up-grid\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.ok(hasContent(Array.from(Array.from(iterableValues(request_follow_grids))).map((rule) => (contains("min(100%, 112px)", rule))).some(Boolean)));
request_follow_name = this.styles.match(new RegExp("#host-workspace-request \\.follow-up-name,\\s*\\.request-workspace \\.follow-up-name\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("font-size: 14px", request_follow_name));
assert.ok(!contains("抽卡缓存", this.markup));
for (const values of iterableValues(Object.values(this.translations["languages"]))) {
assert.ok(!contains("抽卡缓存", Array.from(Array.from(iterableValues(Object.values(values)))).map((value) => String(value)).join(`
`)));
assert.ok(!contains("Gacha cache", Array.from(Array.from(iterableValues(Object.values(values)))).map((value) => String(value)).join(`
`)));
assert.ok(!contains("ガチャキャッシュ", Array.from(Array.from(iterableValues(Object.values(values)))).map((value) => String(value)).join(`
`)));
}
},
async test_session_user_drag_surface_spacing_and_trash_are_not_clipped() {
const editor = readFileSync(path.join(ROOT, 'static/session-user-editor.js'), 'utf8');
assert.ok(contains('dragImage.className = "session-user-drag-image"', editor));
const drag = this.styles.match(/\.session-user-drag-image\s*\{([^}]*)\}/)[1];
assert.ok(contains('background: transparent', drag)); assert.ok(contains('box-shadow: none', drag));
const slot = this.styles.match(/\.session-user-trash-slot\s*\{([^}]*)\}/)[1];
assert.ok(contains('width: 52px', slot)); assert.ok(contains('height: 52px', slot));
assert.ok(52 >= 44 * 1.15); assert.ok(contains('grid-template-rows: minmax(0, 1fr) 52px', this.styles));
assert.ok(contains('this.drag?.image?.remove()', editor));
},
async test_audio_variants_are_persistent_and_expand_as_one_popup() {
let anchor_markup, control_tray, extended_controls, player_frame, renderer, tray_markup, variants;
player_frame = sourceIndex(this.markup, "id=\"player-frame\"");
variants = sourceIndex(this.markup, "id=\"audio-variant-bar\"");
control_tray = sourceIndex(this.markup, "id=\"stage-control-tray\"");
extended_controls = sourceIndex(this.markup, "id=\"stage-extended-controls\"");
assert.ok(player_frame < variants);
assert.ok(variants < control_tray);
assert.ok(control_tray < extended_controls);
tray_markup = this.markup.slice(control_tray, sourceIndex(this.markup, "</section>", extended_controls));
assert.ok(!contains("id=\"audio-variant-bar\"", tray_markup));
assert.ok(contains("id=\"audio-variant-backdrop\"", this.markup));
anchor_markup = this.markup.slice(sourceIndex(this.markup, "id=\"audio-variant-anchor\""), sourceIndex(this.markup, "id=\"audio-variant-backdrop\""));
assert.ok(contains("id=\"audio-variant-toggle\"", anchor_markup));
assert.ok(contains("elements.audioVariantToggle?.addEventListener(\"click\"", this.script));
assert.ok(contains("anchor.right - width", this.script));
assert.ok(contains("function positionAudioVariantPopover()", this.script));
assert.ok(contains("function setAudioVariantPopoverOpen", this.script));
assert.ok(contains("dataset.popoverDirection", this.script));
assert.ok(contains("const fits = list.scrollWidth <= bar.clientWidth + 1", this.script));
assert.ok(contains("elements.audioVariantPopover.append(list.cloneNode(true))", this.script));
renderer = this.script.slice(sourceIndex(this.script, "function renderAudioVariantBar("), sourceIndex(this.script, "function renderAvSyncControls("));
assert.ok(!contains("summary.className = \"audio-variant-summary\"", renderer));
assert.ok(contains("elements.audioVariantBar.append(list)", renderer));
},
async test_narrow_stage_keeps_song_title_peer_size() {
let narrow;
narrow = this.styles.slice(sourceIndex(this.styles, "@media (max-width: 1230px)"), sourceIndex(this.styles, "@media (pointer: coarse)"));
assert.doesNotMatch(narrow, new RegExp("\\.left-column \\.panel-head h2\\s*\\{[^}]*font-size:",""));
},
async test_stage_title_uses_spare_height_before_single_line_marquee() {
let current_title;
current_title = this.markup.match(new RegExp("<h2 id=\"current-title\">(.*?)</h2>","s"))[1];
assert.ok(contains("id=\"current-title-text\"", current_title));
assert.ok(contains("data-i18n=\"player.noSong\"", current_title));
assert.ok(contains("titleHeightSlack >= titleLineHeight + 4", this.script));
assert.ok(contains("titleFitsWithinTwoLines", this.script));
assert.ok(contains("titleNaturalWrappedHeight", this.script));
assert.ok(contains("!narrowShell", this.script));
assert.ok(contains("titleNode?.classList.toggle(\"is-two-line\"", this.script));
assert.ok(contains("titleNode.classList.add(\"is-scrolling\")", this.script));
assert.ok(contains("--host-current-title-marquee-offset", this.script));
assert.ok(contains("#current-title.is-two-line .current-title-text", this.styles));
assert.ok(contains("#current-title.is-measuring-two-line .current-title-text", this.styles));
assert.ok(contains("-webkit-line-clamp: 2", this.styles));
assert.ok(contains("@keyframes host-current-title-marquee", this.styles));
assert.match(this.styles, new RegExp("\\.audio-variant-button\\s*\\{[^}]*white-space:\\s*nowrap",""));
},
async test_advanced_service_copy_uses_info_buttons_and_local_update_badge() {
let appearance, badge, cleanup, cleanup_heading, narrow_settings, restart, settings_row, update_heading, update_upper;
restart = this.markup.match(new RegExp("id=\"application-restart-row\".*?</div>\\s*</div>","s"))[0];
cleanup_heading = lastSourceIndex(this.markup, "<div class=\"cache-advanced-label-row", 0, sourceIndex(this.markup, "data-i18n=\"service.dataCleanup\""));
cleanup = this.markup.slice(cleanup_heading, sourceIndex(this.markup, "id=\"data-reset-button\""));
assert.ok(contains("cache-contextual-info-region", restart));
assert.ok(contains("data-i18n=\"service.restartApplicationHint\"", restart));
assert.ok(!contains("<p class=\"cache-panel-hint\"", restart));
assert.ok(sourceIndex(this.markup, "data-i18n=\"service.playbackRepair\"") < sourceIndex(this.markup, "id=\"application-restart-row\""));
settings_row = this.styles.match(new RegExp("\\.settings-section-card > \\.cache-panel-row\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("align-items: center", settings_row));
update_upper = this.styles.match(new RegExp("\\.cache-update-upper-field\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("align-self: center", update_upper));
assert.ok(contains("cache-contextual-info-region", cleanup));
assert.ok(contains("data-i18n=\"service.dataCleanupScope\"", cleanup));
assert.ok(!contains("cache-data-cleanup-scope", cleanup));
appearance = this.markup.slice(sourceIndex(this.markup, "id=\"settings-appearance-title\""), sourceIndex(this.markup, "id=\"settings-maintenance-title\""));
assert.ok(!contains("data-i18n=\"display.languageHint\"", appearance));
assert.ok(!contains("data-i18n=\"display.themeHint\"", appearance));
assert.deepEqual(this.translations["languages"]["zh"]["settings.workspaceTag"], "Settings");
assert.deepEqual(this.translations["languages"]["en"]["settings.workspaceTag"], "设置");
assert.deepEqual(this.translations["languages"]["ja"]["settings.workspaceTag"], "Settings");
assert.deepEqual(this.translations["languages"]["zh"]["service.bbdownLogin"], "Bilibili 登录");
assert.deepEqual(this.translations["languages"]["ja"]["common.resetShort"], "Reset");
narrow_settings = this.styles.slice(lastSourceIndex(this.styles, "/* Settings keeps the wide layout's"), sourceIndex(this.styles, ".request-quick-view #requester-select[hidden]"));
assert.ok(contains("flex-direction: row", narrow_settings));
assert.ok(contains("justify-content: space-between", narrow_settings));
assert.ok(contains("margin-left: auto", narrow_settings));
assert.ok(!contains(".cache-panel-update-row.has-update", this.styles));
badge = this.styles.match(new RegExp("\\.app-update-version-badge\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("border-radius: 999px", badge));
assert.ok(contains("background:", badge));
update_heading = this.styles.match(new RegExp("\\.cache-app-update-heading\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("flex-direction: row", update_heading));
assert.ok(contains("align-items: center", update_heading));
assert.ok(!contains("setClassToggle(elements.appUpdateRow, \"has-update\"", this.script));
},
async test_titlebar_double_click_uses_the_whole_noninteractive_surface() {
let chrome;
chrome = this.script.slice(sourceIndex(this.script, "function renderWindowMaximizeState"), sourceIndex(this.script, "function initializeHostShell"));
assert.ok(contains("elements.topbar?.addEventListener(\"dblclick\"", chrome));
assert.ok(contains("closest(\"button, a, input, select, textarea", chrome));
assert.ok(contains("closest(\"[data-tauri-drag-region]\")", chrome));
assert.ok(contains("appWindow.toggleMaximize()", chrome));
},
async test_request_feedback_uses_persistent_prerequisite_and_action_toasts() {
let discover_controls, lark_search, local_search, message_surfaces, notice, session_empty, source_messages, source_panel, values;
assert.ok(contains("id=\"request-session-user-notice\"", this.markup));
assert.ok(contains("data-i18n=\"session.empty\"", this.markup));
notice = this.styles.match(new RegExp("^\\.request-session-user-notice\\s*\\{([^}]*)\\}","m"))[1];
assert.ok(contains("background: transparent", notice));
assert.ok(contains("color: var(--accent)", notice));
assert.ok(contains("font-weight: 700", notice));
assert.ok(contains("border: 0", notice));
assert.ok(contains("text-align: left", notice));
message_surfaces = this.styles.slice(sourceIndex(this.styles, ".message-surface,"), sourceIndex(this.styles, ".message-inline:empty,"));
assert.ok(contains("text-align: center", message_surfaces));
assert.ok(contains("border: 0", message_surfaces));
assert.ok(contains("background: var(--btn-secondary-bg)", message_surfaces));
session_empty = Array.from(this.styles.matchAll(new RegExp("^\\.session-user-list \\.session-user-empty\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(session_empty.length, 1);
assert.ok(contains('empty.className = "request-session-user-notice session-user-empty"', readFileSync(path.join(ROOT, 'static/session-user-editor.js'), 'utf8')));
assert.ok(contains('empty.setAttribute("role", "status")', readFileSync(path.join(ROOT, 'static/session-user-editor.js'), 'utf8')));
assert.ok(!contains("class=\"queue-empty session-user-empty\"", readFileSync(path.join(ROOT, 'static/session-user-editor.js'), 'utf8')));
assert.ok(!contains("background:", session_empty[0]));
assert.ok(!contains("color:", session_empty[0]));
assert.deepEqual(this.translations["languages"]["zh"]["list.emptyHint"], "请前往“点歌”界面点歌。");
assert.deepEqual(this.translations["languages"]["zh"]["list.emptyWithCurrentHint"], "可以继续前往“点歌”界面点下一首。");
assert.deepEqual(this.translations["languages"]["en"]["list.emptyHint"], "Request songs from the Request workspace.");
assert.deepEqual(this.translations["languages"]["ja"]["list.emptyHint"], "「リクエスト」画面から曲を予約してください。");
assert.ok(contains("function syncRequestSessionUserNoticePlacement()", this.script));
assert.ok(contains("placement.anchor.insertAdjacentElement(\"afterend\", notice)", this.script));
assert.ok(contains("showSessionUsersRequiredToast", this.script));
assert.ok(contains("setAppMessage(t(\"session.requireUsers\"), true)", this.script));
assert.ok(contains("id=\"gatcha-login-notice\"", this.markup));
assert.ok(contains("id=\"gatcha-session-user-notice\"", this.markup));
assert.ok(contains("state.data?.bbdown?.login?.logged_in", this.script));
assert.ok(contains("button.disabled = state.gatchaDrawBusy || !loggedIn", this.script));
source_panel = this.styles.match(new RegExp("^\\.source-mode-panel\\s*\\{([^}]*)\\}","m"))[1];
assert.ok(contains("display: flex", source_panel));
assert.ok(contains("flex-direction: column", source_panel));
source_messages = this.script.slice(sourceIndex(this.script, "function setMessageForSource"), sourceIndex(this.script, "function setAppMessage"));
assert.ok(contains("setAppMessage(message, true)", source_messages));
lark_search = this.script.slice(sourceIndex(this.script, "async function handleLarkSearchSubmit"), sourceIndex(this.script, "elements.larkSearchForm?.addEventListener"));
assert.ok(contains("hideLarkSearchResults()", lark_search));
assert.ok(!contains("t(\"search.larkNoResultsLong\")", lark_search));
local_search = this.script.slice(sourceIndex(this.script, "elements.searchForm?.addEventListener(\"submit\""), sourceIndex(this.script, "elements.searchQuery?.addEventListener(\"input\""));
assert.ok(contains("hideSearchResults()", local_search));
for (const values of iterableValues(Object.values(this.translations["languages"]))) {
assert.ok(hasContent(values["search.larkNoResults"]));
assert.notDeepEqual(values["search.larkPartialNoResults"], values["search.larkNoResults"]);
}
discover_controls = this.styles.match(new RegExp("\\.request-discover-view \\.tag-browser-search input,\\s*\\.request-discover-view \\.tag-browser-search button\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("height: var(--host-control-height)", discover_controls));
assert.ok(contains("border-radius: var(--host-control-radius)", discover_controls));
assert.ok(contains("font-size: var(--host-control-font-size)", discover_controls));
},
async test_ultranarrow_toolbar_menus_and_windows_frame_keep_desktop_geometry() {
let chrome, frame, toolbar_repair, topbar_rule, windows;
toolbar_repair = this.styles.slice(sourceIndex(this.styles, "/* v0.8 ultra-narrow toolbar popover repair"), sourceIndex(this.styles, "/* v0.8 Windows application frame"));
topbar_rule = Array.from(this.styles.matchAll(new RegExp("^\\.topbar\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("flex-direction: row", topbar_rule));
assert.ok(contains("width: 340px", toolbar_repair));
assert.ok(contains("max-width: calc(100vw - 24px)", toolbar_repair));
assert.ok(contains(".topbar .cache-panel-row", toolbar_repair));
assert.ok(contains(".topbar .cache-panel-row-stack", toolbar_repair));
frame = this.styles.slice(sourceIndex(this.styles, "/* v0.8 Windows application frame"), undefined);
assert.ok(contains("body[data-tauri-platform=\"windows\"] .app-shell", frame));
assert.ok(contains("border: 0", frame));
assert.ok(contains("border-radius: 0", frame));
assert.ok(contains("DWM", frame));
assert.ok(!contains("--window-frame-shadow", frame));
assert.ok(!contains("box-shadow: var(--window-frame-shadow)", frame));
assert.ok(contains(".is-tauri-maximized .app-shell", frame));
assert.ok(contains("/* Windows chrome always owns a separate system-control row", frame));
assert.ok(contains("body[data-tauri-platform=\"windows\"] .topbar", frame));
assert.ok(contains("grid-template-rows: 32px 52px", frame));
windows = JSON.parse(readFileSync(path.join(path.join(ROOT, "src-tauri"), "tauri.windows.conf.json"), "utf8"))["app"]["windows"][0];
assert.ok(hasContent(windows["transparent"]));
assert.ok(hasContent(windows["shadow"]));
chrome = this.script.slice(sourceIndex(this.script, "function renderWindowMaximizeState"), sourceIndex(this.script, "function initializeHostShell"));
assert.ok(contains("appWindow.isMaximized", chrome));
assert.ok(contains("is-tauri-maximized", chrome));
},
async test_service_ready_mark_matches_the_web_indicator_size() {
let service_wraps, shared, shared_ready, toolbar_indicator;
service_wraps = Array.from(this.styles.matchAll(new RegExp("\\.service-status-wrap\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.ok(hasContent(service_wraps));
assert.ok(contains("width: 18px", service_wraps.at((-1))));
assert.ok(contains("height: 18px", service_wraps.at((-1))));
toolbar_indicator = Array.from(this.styles.matchAll(new RegExp("\\.service-status-wrap \\.tool-status-indicator\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.ok(hasContent(toolbar_indicator));
assert.ok(contains("font-size: 12px", toolbar_indicator.at((-1))));
shared_ready = this.styles.match(new RegExp("\\.service-status-wrap \\.tool-status-indicator\\.is-ready\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("background: var(--tool-ready-bg)", shared_ready));
assert.ok(!contains("setTextContent(indicator, \"✓\")", this.script));
shared = readFileSync(path.join(ROOT, "static/status-indicators.css"), "utf8");
assert.ok(contains(".tool-status-indicator::after, .presentation-state-dot::after", shared));
assert.ok(contains(".tool-status-indicator.is-warning", shared));
},
async test_latest_shell_review_uses_shared_tabs_controls_scrollbars_and_responsive_detail() {
let active_variant, final_cache_panel;
active_variant = Array.from(this.styles.matchAll(new RegExp("\\.audio-variant-button\\.active\\s*\\{([^}]*)\\}","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("box-shadow: none", active_variant));
assert.ok(contains("scrollbar-color: var(--scrollbar-thumb-bg) var(--scrollbar-track-bg)", this.styles));
assert.ok(contains("*::-webkit-scrollbar-thumb", this.styles));
assert.ok(contains("scrollbar-gutter: auto", this.styles));
assert.ok(contains("--host-control-height: var(--host-peer-action-height)", this.styles));
assert.ok(contains("--host-control-font-size: 16px", this.styles));
assert.ok(contains("--host-peer-action-font-size: 16px", this.styles));
assert.ok(contains(`.request-subview-tabs,
.request-mode-tabs`, this.styles));
assert.ok(contains("container-type: inline-size", this.styles));
assert.ok(contains("@container request-workspace (min-width: 500px)", this.styles));
assert.ok(contains("grid-template-columns: minmax(0, 1.45fr) minmax(150px, 0.85fr)", this.styles));
assert.ok(!contains(`.left-column .panel-head .section-tag {
    display: none;`, this.styles));
final_cache_panel = Array.from(this.styles.matchAll(new RegExp("^\\.topbar \\.cache-panel\\s*\\{([^}]*)\\}","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1)).at((-1));
assert.ok(contains("padding-right: max(0px, calc(16px - var(--cache-panel-scrollbar-width, 0px)))", final_cache_panel));
assert.ok(contains("scrollbar-gutter: auto", final_cache_panel));
assert.ok(!contains("padding-left", final_cache_panel));
},
async test_scroll_regions_reserve_scrollbar_space_only_while_scrolling() {
let name, remote, rule, source;
remote = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
for (const [name, source] of iterableValues([["styles.css", this.styles], ["remote.css", remote]])) {
for (const rule of iterableValues(Array.from(source.matchAll(new RegExp("([^{}]+)\\{([^}]*scrollbar-gutter:\\s*stable[^}]*)\\}","g"))))) {
assert.ok(contains(".playlist.is-scrollable", rule[1]), (String(name) + ": " + String(rule[1].trim())));
}
}
},
async test_request_grids_add_columns_before_cards_become_oversized() {
let box, cover, image, selector;
assert.ok(contains("--request-song-card-min-inline-size: 200px;", this.styles));
assert.ok(contains("#host-workspace-request .tag-browser-tags {", this.styles));
assert.ok(contains("#host-workspace-request .tag-browser-tag {", this.styles));
for (const selector of iterableValues(["#host-workspace-request \\.search-result-cover", ":is\\(\\.request-workspace, \\.search-card-surface\\) \\.search-result-cover"])) {
box = this.styles.match(new RegExp(concatenate(selector, "\\s*\\{([^}]*)\\}"),""))[1];
assert.ok(contains("aspect-ratio: 16 / 9", box));
assert.ok(contains("min-height: 0", box));
image = this.styles.match(new RegExp(concatenate(selector, " img\\s*\\{([^}]*)\\}"),""))[1];
assert.ok(contains("position: absolute", image));
assert.ok(contains("inset: 0", image));
}
assert.ok(!contains("min-height: 118px", this.styles));
cover = this.styles.match(new RegExp("\\.category-browser-card-name\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("font-size: clamp(18px, 13cqi, 34px)", cover));
},
async test_shared_ui_records_current_workspace_and_scroll_ownership() {
let phrase;
for (const phrase of iterableValues(["Queue and History", "Direct destinations", "Queue's Now Playing card", "independent fixed right-side tool rail", "same width at a fixed viewport", "width-and-height measured Stage modes", "one-line icon-plus-label controls", "platform-specific integrated window chrome", "workspace and scroll ownership"])) {
assert.ok(contains(phrase, this.design));
}
}
};
test("HostBuildReviewRepairTest.test_progress_revisions_do_not_invalidate_workspace_rendering", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_progress_revisions_do_not_invalidate_workspace_rendering(); });
test("HostBuildReviewRepairTest.test_runtime_settings_account_and_media_status_presentation", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_runtime_settings_account_and_media_status_presentation(); });
test("HostBuildReviewRepairTest.test_host_and_remote_share_one_theme_accent_palette", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_host_and_remote_share_one_theme_accent_palette(); });
test("HostBuildReviewRepairTest.test_right_dock_has_six_direct_icon_and_label_destinations", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_right_dock_has_six_direct_icon_and_label_destinations(); });
test("HostBuildReviewRepairTest.test_restore_banner_floats_without_reserving_a_shell_row", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_restore_banner_floats_without_reserving_a_shell_row(); });
test("HostBuildReviewRepairTest.test_host_global_viewport_layers_are_semantic_and_ordered", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_host_global_viewport_layers_are_semantic_and_ordered(); });
test("HostBuildReviewRepairTest.test_request_actions_use_toasts_and_duplicate_confirm_measures_real_height", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_request_actions_use_toasts_and_duplicate_confirm_measures_real_height(); });
test("HostBuildReviewRepairTest.test_narrow_request_mode_tabs_do_not_reserve_a_status_message_column", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_narrow_request_mode_tabs_do_not_reserve_a_status_message_column(); });
test("HostBuildReviewRepairTest.test_peer_buttons_and_close_controls_share_geometry_and_motion", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_peer_buttons_and_close_controls_share_geometry_and_motion(); });
test("HostBuildReviewRepairTest.test_remote_sheets_remain_centered_dismissible_with_separate_host_backdrop_policy", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_remote_sheets_remain_centered_dismissible_with_separate_host_backdrop_policy(); });
test("HostBuildReviewRepairTest.test_part_binding_help_uses_contextual_info_in_both_frontends", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_part_binding_help_uses_contextual_info_in_both_frontends(); });
test("HostBuildReviewRepairTest.test_queue_and_history_are_direct_and_next_is_queue_current_owned", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_queue_and_history_are_direct_and_next_is_queue_current_owned(); });
test("HostBuildReviewRepairTest.test_shell_uses_one_width_per_state_and_measured_stage_modes", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_shell_uses_one_width_per_state_and_measured_stage_modes(); });
test("HostBuildReviewRepairTest.test_narrow_tool_card_uses_measured_resident_or_bottom_overlay_geometry", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_narrow_tool_card_uses_measured_resident_or_bottom_overlay_geometry(); });
test("HostBuildReviewRepairTest.test_service_and_playback_controls_use_distinct_reviewed_icons", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_service_and_playback_controls_use_distinct_reviewed_icons(); });
test("HostBuildReviewRepairTest.test_queue_and_history_actions_share_the_title_row", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_queue_and_history_actions_share_the_title_row(); });
test("HostBuildReviewRepairTest.test_toolbar_badge_messages_and_product_copy_match_review", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_toolbar_badge_messages_and_product_copy_match_review(); });
test("HostBuildReviewRepairTest.test_playback_controls_share_one_divided_surface_and_gatcha_restores_web_dice", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_playback_controls_share_one_divided_surface_and_gatcha_restores_web_dice(); });
test("HostBuildReviewRepairTest.test_empty_player_uses_one_i18n_key_before_and_after_runtime_render", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_empty_player_uses_one_i18n_key_before_and_after_runtime_render(); });
test("HostBuildReviewRepairTest.test_peer_workspace_and_dialog_headers_share_one_geometry_contract", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_peer_workspace_and_dialog_headers_share_one_geometry_contract(); });
test("HostBuildReviewRepairTest.test_sources_and_pool_use_direct_compact_responsive_controls", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_sources_and_pool_use_direct_compact_responsive_controls(); });
test("HostBuildReviewRepairTest.test_discover_hierarchy_uses_one_local_scroll_owner_per_level", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_discover_hierarchy_uses_one_local_scroll_owner_per_level(); });
test("HostBuildReviewRepairTest.test_follow_owner_detail_assigns_scrolling_to_cards_only", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_follow_owner_detail_assigns_scrolling_to_cards_only(); });
test("HostBuildReviewRepairTest.test_player_fullscreen_overrides_persistent_card_and_webkit_insets", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_player_fullscreen_overrides_persistent_card_and_webkit_insets(); });
test("HostBuildReviewRepairTest.test_fullscreen_exit_combines_remote_qr_and_touch_safe_exit", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_fullscreen_exit_combines_remote_qr_and_touch_safe_exit(); });
test("HostBuildReviewRepairTest.test_fullscreen_address_updates_disable_stale_links_and_use_external_open", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_fullscreen_address_updates_disable_stale_links_and_use_external_open(); });
test("HostBuildReviewRepairTest.test_stage_density_prefers_full_frame_and_checks_group_overflow", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_stage_density_prefers_full_frame_and_checks_group_overflow(); });
test("HostBuildReviewRepairTest.test_platform_specific_tauri_chrome_is_explicit", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_platform_specific_tauri_chrome_is_explicit(); });
test("HostBuildReviewRepairTest.test_integrated_titlebar_and_followed_sources_use_peer_sizing", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_integrated_titlebar_and_followed_sources_use_peer_sizing(); });
test("HostBuildReviewRepairTest.test_session_user_drag_surface_spacing_and_trash_are_not_clipped", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_session_user_drag_surface_spacing_and_trash_are_not_clipped(); });
test("HostBuildReviewRepairTest.test_audio_variants_are_persistent_and_expand_as_one_popup", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_audio_variants_are_persistent_and_expand_as_one_popup(); });
test("HostBuildReviewRepairTest.test_narrow_stage_keeps_song_title_peer_size", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_narrow_stage_keeps_song_title_peer_size(); });
test("HostBuildReviewRepairTest.test_stage_title_uses_spare_height_before_single_line_marquee", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_stage_title_uses_spare_height_before_single_line_marquee(); });
test("HostBuildReviewRepairTest.test_advanced_service_copy_uses_info_buttons_and_local_update_badge", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_advanced_service_copy_uses_info_buttons_and_local_update_badge(); });
test("HostBuildReviewRepairTest.test_titlebar_double_click_uses_the_whole_noninteractive_surface", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_titlebar_double_click_uses_the_whole_noninteractive_surface(); });
test("HostBuildReviewRepairTest.test_request_feedback_uses_persistent_prerequisite_and_action_toasts", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_request_feedback_uses_persistent_prerequisite_and_action_toasts(); });
test("HostBuildReviewRepairTest.test_ultranarrow_toolbar_menus_and_windows_frame_keep_desktop_geometry", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_ultranarrow_toolbar_menus_and_windows_frame_keep_desktop_geometry(); });
test("HostBuildReviewRepairTest.test_service_ready_mark_matches_the_web_indicator_size", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_service_ready_mark_matches_the_web_indicator_size(); });
test("HostBuildReviewRepairTest.test_latest_shell_review_uses_shared_tabs_controls_scrollbars_and_responsive_detail", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_latest_shell_review_uses_shared_tabs_controls_scrollbars_and_responsive_detail(); });
test("HostBuildReviewRepairTest.test_scroll_regions_reserve_scrollbar_space_only_while_scrolling", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_scroll_regions_reserve_scrollbar_space_only_while_scrolling(); });
test("HostBuildReviewRepairTest.test_request_grids_add_columns_before_cards_become_oversized", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_request_grids_add_columns_before_cards_become_oversized(); });
test("HostBuildReviewRepairTest.test_shared_ui_records_current_workspace_and_scroll_ownership", async () => { const instance = Object.create(HostBuildReviewRepairTest); await instance.setUpClass(); await instance.test_shared_ui_records_current_workspace_and_scroll_ownership(); });
