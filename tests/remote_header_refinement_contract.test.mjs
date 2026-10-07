import { readSourceText as readFileSync } from './frontend_contract_support.mjs';
// Existing frontend checks transferred to node:test; no Python execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { root, runNative } from './desktop_construction_support.mjs';
const ROOT = root;
import { contains, hasContent, splitOnce, sourceIndex, firstMatch, iterableValues, concatenate, markupSummary, countOccurrences, words } from './frontend_contract_support.mjs';
async function checked(program, args, cwd) { const result = await runNative(program, args, process.env, 120000, cwd); assert.equal(result.status, 0, result.stdout + result.stderr); return result; }
const RemoteHeaderRefinementTest = {
async test_pointer_focus_suppression_keeps_keyboard_navigation_and_menu_border() {
let program, rule, selector, source;
if ((!this.node)) {
(() => { throw new Error("Node.js is required"); })();
}
source = splitOnce(this.script, "const playerSettingsEchoSuppressMs")[0];
program = concatenate(concatenate(`
const assert = require('node:assert/strict');
const handlers = {};
const document = {
  documentElement: { dataset: {} },
  addEventListener(type, handler, capture) {
    assert.equal(capture, true);
    handlers[type] = handler;
  },
};
`, source), `
handlers.pointerdown({ pointerType: 'mouse' });
assert.equal(document.documentElement.dataset.remoteInputModality, 'pointer');
handlers.keydown({ key: 'Tab' });
assert.equal(document.documentElement.dataset.remoteInputModality, 'keyboard');
handlers.pointerdown({ pointerType: 'touch' });
assert.equal(document.documentElement.dataset.remoteInputModality, 'pointer');
handlers.keydown({ key: 'l', ctrlKey: true });
assert.equal(document.documentElement.dataset.remoteInputModality, 'pointer');
handlers.keydown({ key: 'Enter' });
assert.equal(document.documentElement.dataset.remoteInputModality, 'keyboard');
`);
(await checked(this.node, ["-e", program], root));
rule = (await this._first_base_rule(this.styles, ":root[data-remote-input-modality=\"pointer\"] body :is(button, [role=\"button\"]):is(:focus, :focus-visible)"));
assert.deepEqual(rule, {["outline"]: "none"});
assert.ok(contains(".binding-sheet-close:focus-visible,", this.styles));
for (const selector of iterableValues([".remote-menu-toggle", "#remote-av-sync-panel .remote-lock-button"])) {
assert.ok(contains(concatenate(concatenate(":root:not([data-remote-input-modality=\"pointer\"]) ", selector), ":focus-visible {"), this.styles));
}
},
async setUpClass() {
let parser;
this.node = process.execPath;
this.markup = readFileSync(path.join(path.join(ROOT, "static"), "remote.html"), "utf8");
this.styles = readFileSync(path.join(path.join(ROOT, "static"), "remote.css"), "utf8");
this.host_styles = readFileSync(path.join(path.join(ROOT, "static"), "styles.css"), "utf8");
this.script = readFileSync(path.join(path.join(ROOT, "static"), "remote.js"), "utf8");
this.translations = JSON.parse(readFileSync(path.join(path.join(ROOT, "static"), "i18n.json"), "utf8"));
parser = markupSummary();
Object.assign(parser, markupSummary(this.markup));
this.elements = parser.elements;
},
async _first_base_rule(source, selector) {
let match, name, value;
match = source.match(new RegExp(("^[ \\t]*" + String(RegExp.escape(selector)) + "[ \\t]*\\{(?<body>[^}]*)\\}"),"m"));
if ((!match)) {
throw new Error(("missing base rule for " + String(selector)));
}
return Object.fromEntries(Array.from(Array.from(iterableValues(Array.from(match.groups["body"].matchAll(new RegExp("^[ \\t]*([-\\w]+)[ \\t]*:[ \\t]*([^;{}]+);","gm")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1))))).map(([name, value]) => [name, value.trim().replaceAll(new RegExp("\\s+","g"), " ")]));
},
async assert_declaration_parity(host_selector, remote_selector, properties) {
let host, property_name, remote;
host = (await this._first_base_rule(this.host_styles, host_selector));
remote = (await this._first_base_rule(this.styles, remote_selector));
for (const property_name of iterableValues(properties)) {
assert.ok(contains(property_name, host), host_selector);
assert.ok(contains(property_name, remote), remote_selector);
assert.deepEqual(remote[property_name], host[property_name], (String(remote_selector) + " " + String(property_name) + " should match " + String(host_selector)));
}
},
async run_node(body) {
let completed, end, menu_source, script, start;
if ((!this.node)) {
(() => { throw new Error("node is unavailable"); })();
}
start = sourceIndex(this.script, "function remoteConnectionStatusKey");
end = sourceIndex(this.script, "function syncRemoteMenuBounds", start);
menu_source = this.script.slice(start, end);
script = (`
const document = {documentElement: {dataset: {nativeHost: "false"}}};
const state = {
  remoteMenuOpen: false,
  remoteQrSectionOpen: false,
  remoteSettingsSectionOpen: false,
  remoteConnectionPhase: "connecting",
};
function classList() {
  const values = new Set(["hidden"]);
  return {
    toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    add(...names) { names.forEach((name) => values.add(name)); },
    has(name) { return values.has(name); },
  };
}
function element() {
  return {
    classList: classList(),
    dataset: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
  };
}
const focusCalls = [];
const elements = {
  remoteConnectionIndicator: element(),
  remoteConnectionStatusValue: element(),
  remoteConnectionStatusText: element(),
  remoteMenuToggle: {
    ...element(),
    focus(options) { focusCalls.push(options); },
  },
  remoteMenuPanel: element(),
  remoteQrToggle: element(),
  remoteQrContent: element(),
  remoteSettingsToggle: element(),
  remoteSettingsContent: element(),
  remoteConnectionStatusIndicator: element(),
  remoteConnectionStatusTrigger: element(),
};
function t(key, replacements = {}) {
  return key === "remote.menuLabel" || key === "remote.connectionIndicatorLabel"
    ? \`menu:\${replacements.status}\`
    : key;
}
function setTextContent(target, key) { target.textContent = key; }
// Layout and invitation rendering are covered by the browser regression.
function syncRemoteMenuBounds() {}
function renderRemoteAccess() {}
` + String(menu_source) + `
` + String(body) + `
`);
completed = (await runNative(this.node, ["-e", script], process.env, 10 * 1000, ROOT));
assert.deepEqual(completed.status, 0, completed.stderr);
return JSON.parse(completed.stdout);
},
async test_compact_header_has_one_unified_menu_trigger() {
let _, attrs, header, ids, obsolete_class, obsolete_id, parser_elements, trigger;
parser_elements = this.elements;
ids = Array.from(Array.from(iterableValues(parser_elements))).map(([_, attrs]) => (Object.hasOwn(attrs, "id") ? attrs["id"] : null));
assert.deepEqual(countOccurrences(ids, "remote-menu-toggle"), 1);
assert.deepEqual(countOccurrences(ids, "remote-menu-panel"), 1);
assert.deepEqual(countOccurrences(ids, "remote-connection-indicator"), 1);
assert.deepEqual(countOccurrences(ids, "remote-qr-toggle"), 1);
trigger = firstMatch(Array.from(Array.from(iterableValues(parser_elements)) .filter(([_, attrs]) => (((Object.hasOwn(attrs, "id") ? attrs["id"] : null) === "remote-menu-toggle")))).map(([_, attrs]) => attrs));
assert.deepEqual((Object.hasOwn(trigger, "type") ? trigger["type"] : null), "button");
assert.deepEqual((Object.hasOwn(trigger, "aria-haspopup") ? trigger["aria-haspopup"] : null), "menu");
assert.deepEqual((Object.hasOwn(trigger, "aria-expanded") ? trigger["aria-expanded"] : null), "false");
assert.deepEqual((Object.hasOwn(trigger, "aria-controls") ? trigger["aria-controls"] : null), "remote-menu-panel");
assert.ok(contains("aria-label", trigger));
assert.ok(contains("data-i18n-aria-label", trigger));
header = this.markup.match(new RegExp("<header class=\"remote-header\".*?</header>","s"))[0];
assert.ok(!contains("class=\"hero-card\"", this.markup));
assert.ok(!contains("remote.heroTag", header));
assert.ok(!contains("remote.heroCopy", header));
assert.ok(contains("class=\"remote-brand\"", header));
assert.ok(contains("data-i18n-aria-label=\"remote.heroTitle\"", header));
assert.ok(contains("<span class=\"remote-brand-wordmark\">bilikara</span>", header));
assert.deepEqual(countOccurrences(header, "class=\"remote-brand-phone-icon\""), 1);
assert.ok(contains("<rect x=\"7\" y=\"2.5\" width=\"10\" height=\"19\" rx=\"2\"></rect>", header));
assert.ok(contains("<rect x=\"10.4\" y=\"4.5\" width=\"3.2\" height=\"1.4\" rx=\"0.7\" fill=\"currentColor\" stroke=\"none\"></rect>", header));
assert.ok(contains("<path d=\"M10 19h4\" stroke-width=\"1\"></path>", header));
assert.ok(contains("aria-hidden=\"true\"", header));
assert.ok(contains("focusable=\"false\"", header));
assert.ok(!contains("data-i18n=\"remote.heroTitle\"", header));
assert.ok(!contains("点歌台", header));
assert.ok(!contains(">Remote<", header));
assert.deepEqual(countOccurrences(header, "class=\"remote-menu-toggle\""), 1);
assert.deepEqual(countOccurrences(header, "class=\"remote-menu-icon\""), 1);
assert.deepEqual(countOccurrences(header, "class=\"tool-status-indicator is-loading\""), 2);
assert.deepEqual(countOccurrences(header, "class=\"remote-menu-section-toggle-chevron\""), 2);
assert.deepEqual(countOccurrences(header, "class=\"remote-info-button"), 3);
assert.ok(contains("id=\"remote-connection-status-trigger\"", header));
assert.ok(contains("aria-describedby=\"remote-connection-status-text\"", header));
assert.ok(contains("data-i18n-aria-label=\"remote.connectionIndicatorLabel\"", header));
assert.ok(contains("aria-hidden=\"true\"", header));
for (const obsolete_id of iterableValues(["display-settings-toggle", "display-settings-popover", "remote-qr-control", "remote-qr-popover", "remote-qr-popover-close", "remote-mini-qr-image", "remote-mini-qr-placeholder", "player-control-hint", "remote-layout-summary"])) {
assert.ok(!contains(("id=\"" + String(obsolete_id) + "\""), this.markup));
}
for (const obsolete_class of iterableValues(["remote-menu-status-text", "remote-menu-action", "remote-menu-section-action", "remote-menu-setting-hint", "remote-menu-setting-current"])) {
assert.ok(!contains(("class=\"" + String(obsolete_class) + "\""), this.markup));
}
},
async test_unified_menu_contains_status_settings_and_inline_qr_content() {
let panel, required_id;
panel = this.markup.match(new RegExp("<div\\s+id=\"remote-menu-panel\".*?</div>\\s*</div>\\s*</header>","s"))[0];
for (const required_id of iterableValues(["remote-connection-status-row", "remote-connection-status-indicator", "remote-connection-status-trigger", "remote-connection-status-value", "remote-connection-status-text", "remote-settings-toggle", "remote-settings-content", "language-switch", "theme-switch", "remote-qr-toggle", "remote-qr-content", "remote-popover-qr-image", "remote-popover-url-link", "remote-popover-url-hint"])) {
assert.ok(contains(("id=\"" + String(required_id) + "\""), panel));
}
assert.ok(contains("data-i18n=\"top.language\"", panel));
assert.ok(contains("data-i18n=\"top.theme\"", panel));
assert.ok(contains("data-i18n=\"settings.appearance\"", panel));
assert.ok(contains("aria-controls=\"remote-qr-content\"", panel));
assert.ok(contains("aria-controls=\"remote-settings-content\"", panel));
assert.ok(contains("aria-expanded=\"false\"", panel));
assert.deepEqual(countOccurrences(panel, "class=\"remote-menu-section-toggle\""), 2);
assert.deepEqual(countOccurrences(panel, "class=\"remote-menu-setting-label-row remote-contextual-info-region\""), 2);
assert.ok(sourceIndex(panel, "data-i18n=\"top.mobileRemote\"") < sourceIndex(panel, "data-i18n=\"settings.appearance\""));
assert.ok(!contains("id=\"layout-mode-switch\"", panel));
assert.ok(!contains("data-layout-mode=", panel));
assert.ok(!contains("data-i18n=\"top.layout\"", panel));
assert.ok(!contains("id=\"remote-layout-summary\"", panel));
assert.ok(!contains("class=\"remote-menu-setting-hint\"", panel));
assert.ok(!contains("class=\"remote-menu-section-action\"", panel));
},
async test_connection_status_uses_the_same_indicator_and_localized_bubble() {
let result;
result = (await this.run_node(`
renderRemoteConnectionStatus();
const initial = {
  triggerPhase: elements.remoteConnectionIndicator.dataset.connectionPhase,
  statusPhase: elements.remoteConnectionStatusIndicator.dataset.connectionPhase,
  triggerGlyph: elements.remoteConnectionIndicator.textContent,
  statusGlyph: elements.remoteConnectionStatusIndicator.textContent,
  visibleStatusText: elements.remoteConnectionStatusValue.textContent,
  statusText: elements.remoteConnectionStatusText.textContent,
  statusLabel: elements.remoteConnectionStatusTrigger.attributes["aria-label"],
};
setRemoteConnectionPhase("connected");
const connected = {
  triggerPhase: elements.remoteConnectionIndicator.dataset.connectionPhase,
  statusPhase: elements.remoteConnectionStatusIndicator.dataset.connectionPhase,
  triggerGlyph: elements.remoteConnectionIndicator.textContent,
  statusGlyph: elements.remoteConnectionStatusIndicator.textContent,
  visibleStatusText: elements.remoteConnectionStatusValue.textContent,
  statusText: elements.remoteConnectionStatusText.textContent,
  statusLabel: elements.remoteConnectionStatusTrigger.attributes["aria-label"],
};
setRemoteConnectionPhase("reconnecting");
const reconnecting = {
  triggerPhase: elements.remoteConnectionIndicator.dataset.connectionPhase,
  statusPhase: elements.remoteConnectionStatusIndicator.dataset.connectionPhase,
  triggerGlyph: elements.remoteConnectionIndicator.textContent,
  statusGlyph: elements.remoteConnectionStatusIndicator.textContent,
  visibleStatusText: elements.remoteConnectionStatusValue.textContent,
  statusText: elements.remoteConnectionStatusText.textContent,
  statusLabel: elements.remoteConnectionStatusTrigger.attributes["aria-label"],
};
setRemoteConnectionPhase("offline");
console.log(JSON.stringify({ initial, connected, reconnecting, offline: {
  triggerPhase: elements.remoteConnectionIndicator.dataset.connectionPhase,
  statusPhase: elements.remoteConnectionStatusIndicator.dataset.connectionPhase,
  triggerGlyph: elements.remoteConnectionIndicator.textContent,
  statusGlyph: elements.remoteConnectionStatusIndicator.textContent,
  visibleStatusText: elements.remoteConnectionStatusValue.textContent,
  statusText: elements.remoteConnectionStatusText.textContent,
  statusLabel: elements.remoteConnectionStatusTrigger.attributes["aria-label"],
}}));
`));
assert.deepEqual(result["initial"], {["triggerPhase"]: "connecting", ["statusPhase"]: "connecting", ["triggerGlyph"]: "", ["statusGlyph"]: "", ["visibleStatusText"]: "remote.connectionConnecting", ["statusText"]: "remote.connectionConnecting", ["statusLabel"]: "menu:remote.connectionConnecting"});
assert.deepEqual(result["connected"], {["triggerPhase"]: "connected", ["statusPhase"]: "connected", ["triggerGlyph"]: "", ["statusGlyph"]: "", ["visibleStatusText"]: "remote.connectionConnected", ["statusText"]: "remote.connectionConnected", ["statusLabel"]: "menu:remote.connectionConnected"});
assert.deepEqual(result["reconnecting"], {["triggerPhase"]: "reconnecting", ["statusPhase"]: "reconnecting", ["triggerGlyph"]: "", ["statusGlyph"]: "", ["visibleStatusText"]: "remote.connectionReconnecting", ["statusText"]: "remote.connectionReconnecting", ["statusLabel"]: "menu:remote.connectionReconnecting"});
assert.deepEqual(result["offline"]["triggerGlyph"], "");
assert.deepEqual(result["offline"]["statusGlyph"], "");
assert.deepEqual(result["offline"]["visibleStatusText"], "remote.connectionOffline");
assert.deepEqual(result["offline"]["statusText"], "remote.connectionOffline");
assert.deepEqual(result["offline"]["statusLabel"], "menu:remote.connectionOffline");
},
async test_menu_toggle_and_qr_section_restore_focus_without_body_lock() {
let result;
result = (await this.run_node(`
setRemoteMenuOpen(true);
setRemoteQrSectionOpen(true);
setRemoteSettingsSectionOpen(true);
const openState = {
  menuOpen: state.remoteMenuOpen,
  menuExpanded: elements.remoteMenuToggle.attributes["aria-expanded"],
  menuHidden: elements.remoteMenuPanel.classList.has("hidden"),
  qrOpen: state.remoteQrSectionOpen,
  qrExpanded: elements.remoteQrToggle.attributes["aria-expanded"],
  qrHidden: elements.remoteQrContent.classList.has("hidden"),
  settingsOpen: state.remoteSettingsSectionOpen,
  settingsExpanded: elements.remoteSettingsToggle.attributes["aria-expanded"],
  settingsHidden: elements.remoteSettingsContent.classList.has("hidden"),
};
setRemoteMenuOpen(false, { restoreFocus: true });
console.log(JSON.stringify({
  openState,
  closed: {
    menuOpen: state.remoteMenuOpen,
    menuExpanded: elements.remoteMenuToggle.attributes["aria-expanded"],
    menuHidden: elements.remoteMenuPanel.classList.has("hidden"),
    qrOpen: state.remoteQrSectionOpen,
    qrHidden: elements.remoteQrContent.classList.has("hidden"),
    settingsOpen: state.remoteSettingsSectionOpen,
    settingsHidden: elements.remoteSettingsContent.classList.has("hidden"),
    focusCalls,
  },
}));
`));
assert.deepEqual(result["openState"], {["menuOpen"]: true, ["menuExpanded"]: "true", ["menuHidden"]: false, ["qrOpen"]: true, ["qrExpanded"]: "true", ["qrHidden"]: false, ["settingsOpen"]: true, ["settingsExpanded"]: "true", ["settingsHidden"]: false});
assert.ok(!hasContent(result["closed"]["menuOpen"]));
assert.deepEqual(result["closed"]["menuExpanded"], "false");
assert.ok(hasContent(result["closed"]["menuHidden"]));
assert.ok(!hasContent(result["closed"]["qrOpen"]));
assert.ok(hasContent(result["closed"]["qrHidden"]));
assert.ok(!hasContent(result["closed"]["settingsOpen"]));
assert.ok(hasContent(result["closed"]["settingsHidden"]));
assert.deepEqual(result["closed"]["focusCalls"], [{["preventScroll"]: true}]);
},
async test_remote_menu_matches_host_panel_primitives() {
let _, attrs, chevron_contents, content, divider_elements, obsolete_variable, remote_chevron, remote_toggle, section_rule, status_rule;
(await this.assert_declaration_parity(".cache-panel", ".remote-menu-panel", ["top", "right", "width", "display", "flex-direction", "border-radius", "background", "border", "box-shadow", "backdrop-filter", "z-index"]));
assert.deepEqual((await this._first_base_rule(this.styles, ".remote-menu-panel"))["-webkit-backdrop-filter"], "none");
(await this.assert_declaration_parity(".cache-panel-divider", ".remote-menu-divider", ["height", "background", "margin"]));
assert.deepEqual((await this._first_base_rule(this.styles, ".remote-menu-divider"))["flex"], "0 0 1px");
(await this.assert_declaration_parity(".cache-panel-row", ".remote-menu-status-row", ["display", "justify-content", "gap"]));
assert.deepEqual((await this._first_base_rule(this.styles, ".remote-menu-status-row"))["align-items"], "center");
(await this.assert_declaration_parity(".cache-panel-menu-row", ".remote-menu-section-toggle", ["width", "display", "align-items", "justify-content", "background", "border", "padding", "cursor", "border-radius", "transition", "font-family"]));
remote_toggle = (await this._first_base_rule(this.styles, ".remote-menu-section-toggle"));
assert.deepEqual((await this._first_base_rule(this.styles, ".remote-menu-panel"))["padding"], "8px 16px");
assert.deepEqual((await this._first_base_rule(this.styles, ".remote-menu-panel"))["gap"], "4px");
assert.deepEqual(remote_toggle["color"], "var(--ink)");
assert.deepEqual(remote_toggle["min-height"], "44px");
assert.deepEqual(remote_toggle["margin"], "0");
assert.doesNotMatch(this.styles, new RegExp("\\.remote-menu-section-toggle:(?:active|hover)[^\\{]*\\{[^}]*background:",""));
(await this.assert_declaration_parity(".cache-panel-menu-chevron", ".remote-menu-section-toggle-chevron", ["width", "height", "border-top", "border-right", "transform", "opacity", "margin-right", "transition"]));
remote_chevron = (await this._first_base_rule(this.styles, ".remote-menu-section-toggle-chevron"));
assert.deepEqual(remote_chevron["flex"], "0 0 6px");
divider_elements = Array.from(Array.from(iterableValues(this.elements)) .filter(([_, attrs]) => (contains("remote-menu-divider", words((Object.hasOwn(attrs, "class") ? attrs["class"] : "")))))).map(([_, attrs]) => attrs);
assert.deepEqual(divider_elements.length, 2);
assert.ok(hasContent(Array.from(Array.from(iterableValues(divider_elements))).map((attrs) => (((Object.hasOwn(attrs, "aria-hidden") ? attrs["aria-hidden"] : null) === "true"))).every(Boolean)));
chevron_contents = Array.from(this.markup.matchAll(new RegExp("<span class=\"remote-menu-section-toggle-chevron\" aria-hidden=\"true\">(.*?)</span>","gs")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(chevron_contents.length, 2);
assert.ok(hasContent(Array.from(Array.from(iterableValues(chevron_contents))).map((content) => (!content.trim())).every(Boolean)));
section_rule = (await this._first_base_rule(this.styles, ".remote-menu-section"));
assert.deepEqual(section_rule["min-height"], "0");
assert.deepEqual(section_rule["box-shadow"], "none");
assert.doesNotMatch(this.styles, new RegExp("\\.remote-menu-section \\+ \\.remote-menu-section\\s*\\{",""));
status_rule = (await this._first_base_rule(this.styles, ".remote-menu-status-row"));
assert.deepEqual(status_rule["min-height"], "44px");
assert.ok(!contains("border-bottom", status_rule));
for (const obsolete_variable of iterableValues(["--remote-menu-bg", "--remote-menu-border", "--remote-menu-shadow"])) {
assert.ok(!contains(obsolete_variable, this.styles));
}
assert.ok(!contains("styles.css", this.markup));
assert.deepEqual((await this._first_base_rule(this.host_styles, ".cache-panel")), {["position"]: "absolute", ["top"]: "calc(100% + 12px)", ["right"]: "0", ["width"]: "min(340px, calc(100vw - 32px))", ["display"]: "flex", ["flex-direction"]: "column", ["gap"]: "14px", ["padding"]: "16px", ["border-radius"]: "20px", ["background"]: "var(--settings-panel-bg)", ["border"]: "var(--settings-panel-border)", ["box-shadow"]: "var(--shadow)", ["backdrop-filter"]: "none", ["z-index"]: "120"});
},
async test_connection_indicator_and_motion_contract_are_remote_local() {
let action, brand_rule, expanded_trigger_rule, header_rule, icon_rule, identity_action, mode_button_rule, obsolete_property, queue_action, reduced_motion, shell_rule, status_opacity_rule, transport, trigger_rule;
assert.ok(!contains(".hero-card", this.styles));
assert.ok(!contains(".player-control-hint", this.styles));
assert.ok(!contains(".count-chip", this.styles));
shell_rule = this.styles.match(new RegExp("\\.remote-shell\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("env(safe-area-inset-top)", shell_rule));
header_rule = this.styles.match(new RegExp("\\.remote-header\\s*\\{([^}]*)\\}",""))[1];
for (const obsolete_property of iterableValues(["background", "border", "border-radius", "box-shadow", "backdrop-filter"])) {
assert.ok(!contains((String(obsolete_property) + ":"), header_rule));
}
brand_rule = this.styles.match(new RegExp("\\.remote-brand\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("display: inline-flex", brand_rule));
assert.ok(contains("align-items: center", brand_rule));
assert.ok(contains("gap: 7px", brand_rule));
icon_rule = this.styles.match(new RegExp("\\.remote-brand-phone-icon\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("width: 22px", icon_rule));
assert.ok(contains("height: 22px", icon_rule));
assert.ok(contains("color: var(--muted)", icon_rule));
trigger_rule = this.styles.match(new RegExp("\\.remote-menu-toggle\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("min-height: 44px", trigger_rule));
assert.ok(contains("border-radius: 12px", trigger_rule));
assert.ok(contains("var(--remote-menu-trigger-bg)", trigger_rule));
assert.ok(contains("var(--remote-menu-trigger-border)", trigger_rule));
assert.ok(contains("var(--remote-menu-trigger-color)", trigger_rule));
assert.ok(contains("var(--chip-bg)", this.styles));
assert.ok(contains("--remote-menu-trigger-border: var(--top-control-border)", this.styles));
identity_action = (await this._first_base_rule(this.styles, ".remote-identity-row .secondary-button"));
queue_action = (await this._first_base_rule(this.styles, ".queue-header-action"));
for (const action of iterableValues([identity_action, queue_action])) {
assert.deepEqual(action["background"], "var(--remote-secondary-button-bg)");
assert.deepEqual(action["color"], "var(--remote-secondary-button-color)");
}
assert.deepEqual(identity_action["min-height"], "var(--remote-form-control-height)");
assert.deepEqual(identity_action["border-radius"], "var(--remote-form-control-radius)");
assert.deepEqual(queue_action["min-height"], "var(--remote-peer-action-height)");
assert.deepEqual(queue_action["border-radius"], "var(--remote-peer-action-radius)");
assert.ok(contains(".remote-menu-toggle:focus-visible", this.styles));
assert.ok(!contains(".remote-menu-toggle:hover", this.styles));
assert.ok(contains(".remote-menu-toggle:active:not(:disabled)", this.styles));
expanded_trigger_rule = this.styles.match(new RegExp("\\.remote-menu-toggle\\[aria-expanded=\"true\"\\]\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("border: var(--remote-menu-trigger-border)", expanded_trigger_rule));
assert.ok(!contains("border-color: transparent", expanded_trigger_rule));
assert.ok(contains(".remote-menu-section-toggle", this.styles));
assert.ok(contains(".remote-menu-section-toggle-chevron", this.styles));
assert.ok(contains(".remote-menu-panel .remote-tooltip-bubble", this.styles));
status_opacity_rule = this.styles.match(new RegExp("\\.remote-menu-status-info \\.remote-info-button\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("opacity: 1", status_opacity_rule));
assert.ok(contains("max-height: var(--remote-menu-available-height, calc(100dvh - 68px));", this.styles));
assert.ok(!contains("max-height: min(620px", this.styles));
(await this.assert_declaration_parity(".cache-panel-label", ".remote-menu-setting-label", ["color", "font-size", "line-height", "letter-spacing", "text-transform"]));
assert.ok(contains("font-weight: 400", this.styles.match(new RegExp("\\.remote-menu-setting-label\\s*\\{([^}]*)\\}",""))[1]));
mode_button_rule = this.styles.match(new RegExp("\\.remote-menu-panel \\.mode-button\\s*\\{([^}]*)\\}",""))[1];
assert.ok(contains("min-height: 30px", mode_button_rule));
assert.ok(contains("padding: 6px 12px", mode_button_rule));
assert.ok(contains("font-weight: 400", mode_button_rule));
assert.ok(!contains(".remote-menu-action", this.styles));
assert.ok(contains(".tool-status-indicator.is-ready", this.styles));
assert.ok(contains(".tool-status-indicator.is-loading", this.styles));
assert.ok(contains(".tool-status-indicator.is-failed", this.styles));
assert.ok(contains("indicator.textContent = \"\"", this.script));
assert.ok(!contains("indicator.textContent = \"×\"", this.script));
assert.ok(contains("low-cost-indicator-blink 3.2s", this.styles));
reduced_motion = this.styles.match(new RegExp("@media \\(prefers-reduced-motion: reduce\\)\\s*\\{(.*?)\\n\\}","s"))[1];
assert.ok(contains("animation: none", reduced_motion));
transport = this.script.slice(sourceIndex(this.script, "async function fetchState"), sourceIndex(this.script, "async function searchGatchaCache"));
assert.deepEqual(countOccurrences(this.script, "new window.EventSource"), 1);
assert.deepEqual(countOccurrences(this.script, "/api/events?client_id"), 1);
assert.ok(!contains("/api/ping", transport));
assert.ok(!contains("/api/health", transport));
assert.ok(!contains("setInterval", transport));
},
async test_secondary_button_borders_match_host_theme_contract() {
let host_root, host_rules, name, remote_root, remote_rules, rule, theme, value;
function variables(block) {
return Object.fromEntries(Array.from(Array.from(iterableValues(Array.from(block.matchAll(new RegExp("(--[\\w-]+)\\s*:\\s*([^;]+);","g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1))))).map(([name, value]) => [name, value.trim().replaceAll(new RegExp("\\s+","g"), " ")]));
}
remote_root = this.styles.match(new RegExp("^:root\\s*\\{([^}]*)\\}","m"));
host_root = this.host_styles.match(new RegExp("^:root\\s*\\{([^}]*)\\}","m"));
assert.notEqual(remote_root, null);
assert.notEqual(host_root, null);
assert.deepEqual(variables(remote_root[1])["--btn-border"], variables(host_root[1])["--btn-secondary-border"]);
for (const theme of iterableValues(["dark", "blue"])) {
remote_rules = Array.from(this.styles.matchAll(new RegExp((":root\\[data-theme=\"" + String(theme) + "\"\\]\\s*\\{([^}]*)\\}"),"g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
host_rules = Array.from(this.host_styles.matchAll(new RegExp((":root\\[data-theme=\"" + String(theme) + "\"\\]\\s*\\{([^}]*)\\}"),"g")), m => m.length === 1 ? m[0] : m.length === 2 ? m[1] : m.slice(1));
assert.deepEqual(remote_rules.length, host_rules.length);
assert.deepEqual(Array.from(Array.from(iterableValues(remote_rules))).map((rule) => variables(rule)["--btn-border"]), Array.from(Array.from(iterableValues(host_rules))).map((rule) => variables(rule)["--btn-secondary-border"]));
}
},
async test_now_playing_uses_deduplicated_toasts_for_exceptional_states_only() {
let command_end, command_source, command_start, controls, controls_end, controls_start;
assert.ok(!contains("player-control-hint", this.markup));
assert.ok(!contains("playerControlHint", this.script));
controls_start = sourceIndex(this.script, "function renderPlayerControls");
controls_end = sourceIndex(this.script, "function renderListHeader", controls_start);
controls = this.script.slice(controls_start, controls_end);
assert.ok(!contains("controlPausedHint", controls));
assert.ok(!contains("controlPlayingHint", controls));
assert.ok(contains("remotePlayerIssueSignature", controls));
assert.ok(contains("itemIncarnationId", controls));
assert.ok(contains("playbackGeneration", controls));
assert.ok(contains("\"player-control-unsupported\"", controls));
assert.ok(!contains("t(\"remote.controlCachePending\")", controls));
assert.ok(!contains("reportRemoteIssue(cachePendingIssueSignature", controls));
assert.ok(contains("function reportRemoteIssue", this.script));
assert.ok(contains("remoteIssueSignatureSet().has(normalizedSignature)", this.script));
assert.ok(contains("clearRemoteIssue(issueSignature)", this.script));
command_start = sourceIndex(this.script, "async function sendPlayerControl");
command_end = sourceIndex(this.script, "function disconnectClient", command_start);
command_source = this.script.slice(command_start, command_end);
assert.ok(contains("remotePlayerIssueSignature", command_source));
assert.ok(contains("reportRemoteIssue(issueSignature", command_source));
assert.ok(contains("t(\"remote.controlRejected\")", command_source));
assert.ok(contains("t(\"remote.controlCommandFailed\")", command_source));
},
async test_queue_header_owns_reorder_action_and_localized_parenthetical_count() {
let count_rule, key, language, list_end, list_source, list_start, obsolete_property, queue_header;
assert.deepEqual(countOccurrences(this.markup, "id=\"resort-playlist-button\""), 1);
queue_header = this.markup.match(new RegExp("<div class=\"panel-head panel-head-stack queue-panel-head\">.*?</div>\\s*\\n\\s*<div class=\"view-toggle\"","s"))[0];
assert.ok(contains("class=\"queue-panel-heading\"", queue_header));
assert.ok(contains("id=\"resort-playlist-button\"", queue_header));
assert.ok(sourceIndex(queue_header, "id=\"list-title-text\"") < sourceIndex(queue_header, "id=\"list-count\""));
assert.ok(contains("id=\"list-title-text\"", queue_header));
assert.ok(contains("class=\"list-count\"", queue_header));
assert.ok(!contains("class=\"count-chip\"", this.markup));
list_start = sourceIndex(this.script, "function renderListHeader");
list_end = sourceIndex(this.script, "function syncListView", list_start);
list_source = this.script.slice(list_start, list_end);
assert.ok(contains("elements.listTitleText", list_source));
assert.ok(contains("\"history.title\"", list_source));
assert.ok(contains("\"list.title\"", list_source));
assert.ok(contains("\"history.count\"", list_source));
assert.ok(contains("\"list.count\"", list_source));
assert.ok(!contains("elements.listTitle.textContent", list_source));
assert.ok(!contains("follow.countSongs", list_source));
count_rule = this.styles.match(new RegExp("\\.list-count\\s*\\{([^}]*)\\}",""))[1];
for (const obsolete_property of iterableValues(["background", "border", "border-radius", "padding"])) {
assert.ok(!contains((String(obsolete_property) + ":"), count_rule));
}
for (const language of iterableValues(Object.values(this.translations["languages"]))) {
for (const key of iterableValues(["list.count", "history.count"])) {
assert.ok(contains("{count}", language[key]));
assert.ok(hasContent(((contains("(", language[key])) || (contains("（", language[key])))), language[key]);
}
}
},
async test_new_remote_strings_exist_in_all_languages() {
let key, language, required, translations;
required = ["remote.menuLabel", "remote.connectionStatusLabel", "remote.connectionIndicatorLabel", "remote.connectionConnecting", "remote.connectionReconnecting", "remote.connectionConnected", "remote.connectionOffline", "remote.connectionOfflineToast", "remote.openInBrowser", "remote.controlRejected", "remote.controlCommandFailed", "display.themeLight", "display.themeDark", "display.themeBlue"];
for (const [language, translations] of iterableValues(Object.entries(this.translations["languages"]))) {
for (const key of iterableValues(required)) {
assert.ok(hasContent((Object.hasOwn(translations, key) ? translations[key] : null)), ("missing " + String(language) + ":" + String(key)));
}
}
},
async test_remote_brand_accessible_name_and_document_title_are_localized() {
let expected_label, expected_labels, language, translations;
expected_labels = {["zh"]: "bilikara 远程控制", ["en"]: "bilikara remote control", ["ja"]: "bilikara リモコン"};
for (const [language, expected_label] of iterableValues(Object.entries(expected_labels))) {
translations = this.translations["languages"][language];
assert.deepEqual(translations["document.remoteTitle"], "bilikara remote");
assert.deepEqual(translations["remote.heroTitle"], expected_label);
}
}
};
test("RemoteHeaderRefinementTest.test_pointer_focus_suppression_keeps_keyboard_navigation_and_menu_border", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_pointer_focus_suppression_keeps_keyboard_navigation_and_menu_border(); });
test("RemoteHeaderRefinementTest.test_compact_header_has_one_unified_menu_trigger", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_compact_header_has_one_unified_menu_trigger(); });
test("RemoteHeaderRefinementTest.test_unified_menu_contains_status_settings_and_inline_qr_content", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_unified_menu_contains_status_settings_and_inline_qr_content(); });
test("RemoteHeaderRefinementTest.test_connection_status_uses_the_same_indicator_and_localized_bubble", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_connection_status_uses_the_same_indicator_and_localized_bubble(); });
test("RemoteHeaderRefinementTest.test_menu_toggle_and_qr_section_restore_focus_without_body_lock", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_menu_toggle_and_qr_section_restore_focus_without_body_lock(); });
test("RemoteHeaderRefinementTest.test_remote_menu_matches_host_panel_primitives", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_remote_menu_matches_host_panel_primitives(); });
test("RemoteHeaderRefinementTest.test_connection_indicator_and_motion_contract_are_remote_local", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_connection_indicator_and_motion_contract_are_remote_local(); });
test("RemoteHeaderRefinementTest.test_secondary_button_borders_match_host_theme_contract", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_secondary_button_borders_match_host_theme_contract(); });
test("RemoteHeaderRefinementTest.test_now_playing_uses_deduplicated_toasts_for_exceptional_states_only", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_now_playing_uses_deduplicated_toasts_for_exceptional_states_only(); });
test("RemoteHeaderRefinementTest.test_queue_header_owns_reorder_action_and_localized_parenthetical_count", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_queue_header_owns_reorder_action_and_localized_parenthetical_count(); });
test("RemoteHeaderRefinementTest.test_new_remote_strings_exist_in_all_languages", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_new_remote_strings_exist_in_all_languages(); });
test("RemoteHeaderRefinementTest.test_remote_brand_accessible_name_and_document_title_are_localized", async () => { const instance = Object.create(RemoteHeaderRefinementTest); await instance.setUpClass(); await instance.test_remote_brand_accessible_name_and_document_title_are_localized(); });
