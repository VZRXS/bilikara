from __future__ import annotations

import json
import re
import shutil
import subprocess
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class _RemoteMarkupParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.elements: list[tuple[str, dict[str, str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append((tag, {name: value or "" for name, value in attrs}))


class RemoteHeaderRefinementTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.node = shutil.which("node")
        cls.markup = (ROOT / "static" / "remote.html").read_text(encoding="utf-8")
        cls.styles = (ROOT / "static" / "remote.css").read_text(encoding="utf-8")
        cls.host_styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "remote.js").read_text(encoding="utf-8")
        cls.translations = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )
        parser = _RemoteMarkupParser()
        parser.feed(cls.markup)
        cls.elements = parser.elements

    @staticmethod
    def _first_base_rule(source: str, selector: str) -> dict[str, str]:
        match = re.search(
            rf"(?m)^[ \t]*{re.escape(selector)}[ \t]*\{{(?P<body>[^}}]*)\}}",
            source,
        )
        if not match:
            raise AssertionError(f"missing base rule for {selector}")
        return {
            name: re.sub(r"\s+", " ", value.strip())
            for name, value in re.findall(
                r"(?m)^[ \t]*([-\w]+)[ \t]*:[ \t]*([^;{}]+);",
                match.group("body"),
            )
        }

    def assert_declaration_parity(
        self,
        host_selector: str,
        remote_selector: str,
        properties: tuple[str, ...],
    ) -> None:
        host = self._first_base_rule(self.host_styles, host_selector)
        remote = self._first_base_rule(self.styles, remote_selector)
        for property_name in properties:
            self.assertIn(property_name, host, host_selector)
            self.assertIn(property_name, remote, remote_selector)
            self.assertEqual(
                remote[property_name],
                host[property_name],
                f"{remote_selector} {property_name} should match {host_selector}",
            )

    def run_node(self, body: str) -> dict:
        if not self.node:
            self.skipTest("node is unavailable")
        start = self.script.index("function remoteConnectionStatusKey")
        end = self.script.index("function renderRemoteAccess", start)
        menu_source = self.script[start:end]
        script = f"""
const state = {{
  remoteMenuOpen: false,
  remoteQrSectionOpen: false,
  remoteSettingsSectionOpen: false,
  remoteConnectionPhase: "connecting",
}};
function classList() {{
  const values = new Set(["hidden"]);
  return {{
    toggle(name, enabled) {{ if (enabled) values.add(name); else values.delete(name); }},
    remove(...names) {{ names.forEach((name) => values.delete(name)); }},
    add(...names) {{ names.forEach((name) => values.add(name)); }},
    has(name) {{ return values.has(name); }},
  }};
}}
function element() {{
  return {{
    classList: classList(),
    dataset: {{}},
    attributes: {{}},
    setAttribute(name, value) {{ this.attributes[name] = String(value); }},
  }};
}}
const focusCalls = [];
const elements = {{
  remoteConnectionIndicator: element(),
  remoteConnectionStatusValue: element(),
  remoteConnectionStatusText: element(),
  remoteMenuToggle: {{
    ...element(),
    focus(options) {{ focusCalls.push(options); }},
  }},
  remoteMenuPanel: element(),
  remoteQrToggle: element(),
  remoteQrContent: element(),
  remoteSettingsToggle: element(),
  remoteSettingsContent: element(),
  remoteConnectionStatusIndicator: element(),
  remoteConnectionStatusTrigger: element(),
}};
function t(key, replacements = {{}}) {{
  return key === "remote.menuLabel" || key === "remote.connectionIndicatorLabel"
    ? `menu:${{replacements.status}}`
    : key;
}}
function setTextContent(target, key) {{ target.textContent = key; }}
{menu_source}
{body}
"""
        completed = subprocess.run(
            [self.node, "-e", script],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_compact_header_has_one_unified_menu_trigger(self):
        parser_elements = self.elements
        ids = [attrs.get("id") for _, attrs in parser_elements]
        self.assertEqual(ids.count("remote-menu-toggle"), 1)
        self.assertEqual(ids.count("remote-menu-panel"), 1)
        self.assertEqual(ids.count("remote-connection-indicator"), 1)
        self.assertEqual(ids.count("remote-qr-toggle"), 1)

        trigger = next(
            attrs
            for _, attrs in parser_elements
            if attrs.get("id") == "remote-menu-toggle"
        )
        self.assertEqual(trigger.get("type"), "button")
        self.assertEqual(trigger.get("aria-haspopup"), "menu")
        self.assertEqual(trigger.get("aria-expanded"), "false")
        self.assertEqual(trigger.get("aria-controls"), "remote-menu-panel")
        self.assertIn("aria-label", trigger)
        self.assertIn("data-i18n-aria-label", trigger)

        header = re.search(
            r'<header class="remote-header".*?</header>', self.markup, re.DOTALL
        ).group(0)
        self.assertNotIn('class="hero-card"', self.markup)
        self.assertNotIn("remote.heroTag", header)
        self.assertNotIn("remote.heroCopy", header)
        self.assertIn('class="remote-brand"', header)
        self.assertIn('data-i18n-aria-label="remote.heroTitle"', header)
        self.assertIn('<span class="remote-brand-wordmark">bilikara</span>', header)
        self.assertEqual(header.count('class="remote-brand-phone-icon"'), 1)
        self.assertIn('<rect x="7" y="2.5" width="10" height="19" rx="2"></rect>', header)
        self.assertIn('<path d="M10 5h4M11 18.5h2"></path>', header)
        self.assertIn('aria-hidden="true"', header)
        self.assertIn('focusable="false"', header)
        self.assertNotIn('data-i18n="remote.heroTitle"', header)
        self.assertNotIn("点歌台", header)
        self.assertNotIn(">Remote<", header)
        self.assertEqual(header.count('class="remote-menu-toggle"'), 1)
        self.assertEqual(header.count('class="remote-menu-icon"'), 1)
        self.assertEqual(header.count('class="tool-status-indicator is-loading"'), 2)
        self.assertEqual(header.count('class="remote-menu-section-toggle-chevron"'), 2)
        self.assertEqual(header.count('class="remote-info-button'), 3)
        self.assertIn('id="remote-connection-status-trigger"', header)
        self.assertIn('aria-describedby="remote-connection-status-text"', header)
        self.assertIn('data-i18n-aria-label="remote.connectionIndicatorLabel"', header)
        self.assertIn('aria-hidden="true"', header)

        for obsolete_id in (
            "display-settings-toggle",
            "display-settings-popover",
            "remote-qr-control",
            "remote-qr-popover",
            "remote-qr-popover-close",
            "remote-mini-qr-image",
            "remote-mini-qr-placeholder",
            "player-control-hint",
            "remote-layout-summary",
        ):
            self.assertNotIn(f'id="{obsolete_id}"', self.markup)
        for obsolete_class in (
            "remote-menu-status-text",
            "remote-menu-action",
            "remote-menu-section-action",
            "remote-menu-setting-hint",
            "remote-menu-setting-current",
        ):
            self.assertNotIn(f'class="{obsolete_class}"', self.markup)

    def test_unified_menu_contains_status_settings_and_inline_qr_content(self):
        panel = re.search(
            r'<div\s+id="remote-menu-panel".*?</div>\s*</div>\s*</header>',
            self.markup,
            re.DOTALL,
        ).group(0)
        for required_id in (
            "remote-connection-status-row",
            "remote-connection-status-indicator",
            "remote-connection-status-trigger",
            "remote-connection-status-value",
            "remote-connection-status-text",
            "remote-settings-toggle",
            "remote-settings-content",
            "language-switch",
            "theme-switch",
            "remote-qr-toggle",
            "remote-qr-content",
            "remote-popover-qr-image",
            "remote-popover-url-link",
            "remote-popover-url-hint",
        ):
            self.assertIn(f'id="{required_id}"', panel)
        self.assertIn('data-i18n="top.language"', panel)
        self.assertIn('data-i18n="top.theme"', panel)
        self.assertIn('data-i18n="settings.appearance"', panel)
        self.assertIn('aria-controls="remote-qr-content"', panel)
        self.assertIn('aria-controls="remote-settings-content"', panel)
        self.assertIn('aria-expanded="false"', panel)
        self.assertEqual(panel.count('class="remote-menu-section-toggle"'), 2)
        self.assertEqual(panel.count('class="remote-menu-setting-label-row remote-contextual-info-region"'), 2)
        self.assertLess(panel.index('data-i18n="top.mobileRemote"'), panel.index('data-i18n="settings.appearance"'))
        self.assertNotIn('id="layout-mode-switch"', panel)
        self.assertNotIn('data-layout-mode=', panel)
        self.assertNotIn('data-i18n="top.layout"', panel)
        self.assertNotIn('id="remote-layout-summary"', panel)
        self.assertNotIn('class="remote-menu-setting-hint"', panel)
        self.assertNotIn('class="remote-menu-section-action"', panel)

    def test_connection_status_uses_the_same_indicator_and_localized_bubble(self):
        result = self.run_node(
            """
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
"""
        )
        self.assertEqual(result["initial"], {
            "triggerPhase": "connecting",
            "statusPhase": "connecting",
            "triggerGlyph": "",
            "statusGlyph": "",
            "visibleStatusText": "remote.connectionConnecting",
            "statusText": "remote.connectionConnecting",
            "statusLabel": "menu:remote.connectionConnecting",
        })
        self.assertEqual(result["connected"], {
            "triggerPhase": "connected",
            "statusPhase": "connected",
            "triggerGlyph": "✓",
            "statusGlyph": "✓",
            "visibleStatusText": "remote.connectionConnected",
            "statusText": "remote.connectionConnected",
            "statusLabel": "menu:remote.connectionConnected",
        })
        self.assertEqual(result["reconnecting"], {
            "triggerPhase": "reconnecting",
            "statusPhase": "reconnecting",
            "triggerGlyph": "",
            "statusGlyph": "",
            "visibleStatusText": "remote.connectionReconnecting",
            "statusText": "remote.connectionReconnecting",
            "statusLabel": "menu:remote.connectionReconnecting",
        })
        self.assertEqual(result["offline"]["triggerGlyph"], "×")
        self.assertEqual(result["offline"]["statusGlyph"], "×")
        self.assertEqual(result["offline"]["visibleStatusText"], "remote.connectionOffline")
        self.assertEqual(result["offline"]["statusText"], "remote.connectionOffline")
        self.assertEqual(result["offline"]["statusLabel"], "menu:remote.connectionOffline")

    def test_menu_toggle_and_qr_section_restore_focus_without_body_lock(self):
        result = self.run_node(
            """
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
"""
        )
        self.assertEqual(
            result["openState"],
            {
                "menuOpen": True,
                "menuExpanded": "true",
                "menuHidden": False,
                "qrOpen": True,
                "qrExpanded": "true",
                "qrHidden": False,
                "settingsOpen": True,
                "settingsExpanded": "true",
                "settingsHidden": False,
            },
        )
        self.assertFalse(result["closed"]["menuOpen"])
        self.assertEqual(result["closed"]["menuExpanded"], "false")
        self.assertTrue(result["closed"]["menuHidden"])
        self.assertFalse(result["closed"]["qrOpen"])
        self.assertTrue(result["closed"]["qrHidden"])
        self.assertFalse(result["closed"]["settingsOpen"])
        self.assertTrue(result["closed"]["settingsHidden"])
        self.assertEqual(result["closed"]["focusCalls"], [{"preventScroll": True}])

    def test_remote_menu_matches_host_panel_primitives(self):
        self.assert_declaration_parity(
            ".cache-panel",
            ".remote-menu-panel",
            (
                "top",
                "right",
                "width",
                "display",
                "flex-direction",
                "gap",
                "padding",
                "border-radius",
                "background",
                "border",
                "box-shadow",
                "backdrop-filter",
                "z-index",
            ),
        )
        self.assertEqual(
            self._first_base_rule(self.styles, ".remote-menu-panel")[
                "-webkit-backdrop-filter"
            ],
            "none",
        )
        self.assert_declaration_parity(
            ".cache-panel-divider",
            ".remote-menu-divider",
            ("height", "background", "margin"),
        )
        self.assertEqual(
            self._first_base_rule(self.styles, ".remote-menu-divider")["flex"],
            "0 0 1px",
        )
        self.assert_declaration_parity(
            ".cache-panel-row",
            ".remote-menu-status-row",
            ("display", "justify-content", "gap"),
        )
        self.assertEqual(
            self._first_base_rule(self.styles, ".remote-menu-status-row")[
                "align-items"
            ],
            "center",
        )
        self.assert_declaration_parity(
            ".cache-panel-menu-row",
            ".remote-menu-section-toggle",
            (
                "width",
                "display",
                "align-items",
                "justify-content",
                "background",
                "border",
                "padding",
                "margin",
                "cursor",
                "border-radius",
                "transition",
                "font-family",
            ),
        )
        remote_toggle = self._first_base_rule(self.styles, ".remote-menu-section-toggle")
        self.assertEqual(remote_toggle["color"], "var(--ink)")
        self.assertEqual(remote_toggle["min-height"], "44px")
        self.assertNotRegex(
            self.styles,
            r"\.remote-menu-section-toggle:(?:active|hover)[^\{]*\{[^}]*background:",
        )
        self.assert_declaration_parity(
            ".cache-panel-menu-chevron",
            ".remote-menu-section-toggle-chevron",
            (
                "width",
                "height",
                "border-top",
                "border-right",
                "transform",
                "opacity",
                "margin-right",
                "transition",
            ),
        )
        remote_chevron = self._first_base_rule(
            self.styles, ".remote-menu-section-toggle-chevron"
        )
        self.assertEqual(remote_chevron["flex"], "0 0 6px")

        divider_elements = [
            attrs
            for _, attrs in self.elements
            if "remote-menu-divider" in attrs.get("class", "").split()
        ]
        self.assertEqual(len(divider_elements), 2)
        self.assertTrue(
            all(attrs.get("aria-hidden") == "true" for attrs in divider_elements)
        )
        chevron_contents = re.findall(
            r'<span class="remote-menu-section-toggle-chevron" aria-hidden="true">(.*?)</span>',
            self.markup,
            re.DOTALL,
        )
        self.assertEqual(len(chevron_contents), 2)
        self.assertTrue(all(not content.strip() for content in chevron_contents))

        section_rule = self._first_base_rule(self.styles, ".remote-menu-section")
        self.assertEqual(section_rule["min-height"], "0")
        self.assertEqual(section_rule["box-shadow"], "none")
        self.assertNotRegex(
            self.styles,
            r"\.remote-menu-section \+ \.remote-menu-section\s*\{",
        )
        status_rule = self._first_base_rule(self.styles, ".remote-menu-status-row")
        self.assertNotIn("min-height", status_rule)
        self.assertNotIn("border-bottom", status_rule)
        for obsolete_variable in (
            "--remote-menu-bg",
            "--remote-menu-border",
            "--remote-menu-shadow",
        ):
            self.assertNotIn(obsolete_variable, self.styles)
        self.assertNotIn("styles.css", self.markup)
        host_diff = subprocess.run(
            ["git", "diff", "--name-only", "HEAD", "--", "static/styles.css"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(host_diff.returncode, 0, host_diff.stderr)
        self.assertEqual(host_diff.stdout.strip(), "")

    def test_connection_indicator_and_motion_contract_are_remote_local(self):
        self.assertNotIn(".hero-card", self.styles)
        self.assertNotIn(".player-control-hint", self.styles)
        self.assertNotIn(".count-chip", self.styles)
        shell_rule = re.search(r"\.remote-shell\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("env(safe-area-inset-top)", shell_rule)
        header_rule = re.search(r"\.remote-header\s*\{([^}]*)\}", self.styles).group(1)
        for obsolete_property in ("background", "border", "border-radius", "box-shadow", "backdrop-filter"):
            self.assertNotIn(f"{obsolete_property}:", header_rule)
        brand_rule = re.search(r"\.remote-brand\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("display: inline-flex", brand_rule)
        self.assertIn("align-items: center", brand_rule)
        self.assertIn("gap: 7px", brand_rule)
        icon_rule = re.search(r"\.remote-brand-phone-icon\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("width: 22px", icon_rule)
        self.assertIn("height: 22px", icon_rule)
        self.assertIn("color: var(--muted)", icon_rule)
        trigger_rule = re.search(
            r"\.remote-menu-toggle\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("min-height: 44px", trigger_rule)
        self.assertIn("border-radius: 12px", trigger_rule)
        self.assertIn("var(--remote-menu-trigger-bg)", trigger_rule)
        self.assertIn("var(--remote-menu-trigger-border)", trigger_rule)
        self.assertIn("var(--remote-menu-trigger-color)", trigger_rule)
        self.assertIn("var(--chip-bg)", self.styles)
        self.assertIn("var(--chip-border)", self.styles)
        identity_action = self._first_base_rule(
            self.styles, ".remote-identity-row .secondary-button"
        )
        queue_action = self._first_base_rule(self.styles, ".queue-header-action")
        for action in (identity_action, queue_action):
            self.assertEqual(
                action["background"], "var(--remote-secondary-button-bg)"
            )
            self.assertEqual(action["color"], "var(--remote-secondary-button-color)")
        self.assertEqual(
            identity_action["min-height"], "var(--remote-form-control-height)"
        )
        self.assertEqual(
            identity_action["border-radius"], "var(--remote-form-control-radius)"
        )
        self.assertEqual(
            queue_action["min-height"], "var(--remote-peer-action-height)"
        )
        self.assertEqual(
            queue_action["border-radius"], "var(--remote-peer-action-radius)"
        )
        self.assertIn(".remote-menu-toggle:focus-visible", self.styles)
        self.assertIn("var(--remote-menu-trigger-hover-bg)", self.styles)
        self.assertIn("var(--remote-menu-trigger-hover-border)", self.styles)
        expanded_trigger_rule = re.search(
            r'\.remote-menu-toggle\[aria-expanded="true"\]\s*\{([^}]*)\}',
            self.styles,
        ).group(1)

        self.assertIn("border-color: transparent", expanded_trigger_rule)
        self.assertIn(".remote-menu-section-toggle", self.styles)
        self.assertIn(".remote-menu-section-toggle-chevron", self.styles)
        self.assertIn(".remote-menu-panel .remote-tooltip-bubble", self.styles)
        status_opacity_rule = re.search(
            r"\.remote-menu-status-info \.remote-info-button\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("opacity: 1", status_opacity_rule)
        self.assertIn("max-height: min(620px, calc(100dvh - 68px));", self.styles)
        self.assert_declaration_parity(
            ".cache-panel-label",
            ".remote-menu-setting-label",
            (
                "color",
                "font-size",
                "line-height",
                "letter-spacing",
                "text-transform",
            ),
        )
        self.assertIn("font-weight: 400", re.search(r"\.remote-menu-setting-label\s*\{([^}]*)\}", self.styles).group(1))
        mode_button_rule = re.search(r"\.remote-menu-panel \.mode-button\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("min-height: 30px", mode_button_rule)
        self.assertIn("padding: 6px 12px", mode_button_rule)
        self.assertIn("font-weight: 400", mode_button_rule)
        self.assertNotIn(".remote-menu-action", self.styles)
        self.assertIn(".tool-status-indicator.is-ready", self.styles)
        self.assertIn(".tool-status-indicator.is-loading", self.styles)
        self.assertIn(".tool-status-indicator.is-failed", self.styles)
        self.assertIn('indicator.textContent = "✓"', self.script)
        self.assertIn('indicator.textContent = "×"', self.script)
        self.assertIn("low-cost-indicator-blink 3.2s", self.styles)
        reduced_motion = re.search(
            r"@media \(prefers-reduced-motion: reduce\)\s*\{(.*?)\n\}",
            self.styles,
            re.DOTALL,
        ).group(1)
        self.assertIn("animation: none", reduced_motion)

        transport = self.script[
            self.script.index("async function fetchState") : self.script.index(
                "async function searchGatchaCache"
            )
        ]
        self.assertEqual(self.script.count("new window.EventSource"), 1)
        self.assertEqual(self.script.count("/api/events?client_id"), 1)
        self.assertNotIn("/api/ping", transport)
        self.assertNotIn("/api/health", transport)
        self.assertNotIn("setInterval", transport)

    def test_secondary_button_borders_match_host_theme_contract(self):
        def variables(block: str) -> dict[str, str]:
            return {
                name: re.sub(r"\s+", " ", value.strip())
                for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", block)
            }

        remote_root = re.search(r"(?m)^:root\s*\{([^}]*)\}", self.styles)
        host_root = re.search(r"(?m)^:root\s*\{([^}]*)\}", self.host_styles)
        self.assertIsNotNone(remote_root)
        self.assertIsNotNone(host_root)
        self.assertEqual(
            variables(remote_root.group(1))["--btn-border"],
            variables(host_root.group(1))["--btn-secondary-border"],
        )

        for theme in ("dark", "blue"):
            remote_rules = re.findall(
                rf':root\[data-theme="{theme}"\]\s*\{{([^}}]*)\}}', self.styles
            )
            host_rules = re.findall(
                rf':root\[data-theme="{theme}"\]\s*\{{([^}}]*)\}}',
                self.host_styles,
            )
            self.assertEqual(len(remote_rules), len(host_rules))
            self.assertEqual(
                [variables(rule)["--btn-border"] for rule in remote_rules],
                [variables(rule)["--btn-secondary-border"] for rule in host_rules],
            )

    def test_now_playing_uses_deduplicated_toasts_for_exceptional_states_only(self):
        self.assertNotIn("player-control-hint", self.markup)
        self.assertNotIn("playerControlHint", self.script)
        controls_start = self.script.index("function renderPlayerControls")
        controls_end = self.script.index("function renderListHeader", controls_start)
        controls = self.script[controls_start:controls_end]
        self.assertNotIn("controlPausedHint", controls)
        self.assertNotIn("controlPlayingHint", controls)
        self.assertIn("remotePlayerIssueSignature", controls)
        self.assertIn("itemIncarnationId", controls)
        self.assertIn("playbackGeneration", controls)
        self.assertIn('"player-control-unsupported"', controls)
        self.assertIn('"player-control-cache-pending"', controls)
        self.assertIn("function reportRemoteIssue", self.script)
        self.assertIn("remoteIssueSignatureSet().has(normalizedSignature)", self.script)
        self.assertIn("clearRemoteIssue(issueSignature)", self.script)
        command_start = self.script.index("async function sendPlayerControl")
        command_end = self.script.index("function disconnectClient", command_start)
        command_source = self.script[command_start:command_end]
        self.assertIn("remotePlayerIssueSignature", command_source)
        self.assertIn("reportRemoteIssue(issueSignature", command_source)
        self.assertIn('t("remote.controlRejected")', command_source)
        self.assertIn('t("remote.controlCommandFailed")', command_source)

    def test_queue_header_owns_reorder_action_and_localized_parenthetical_count(self):
        self.assertEqual(self.markup.count('id="resort-playlist-button"'), 1)
        queue_header = re.search(
            r'<div class="panel-head panel-head-stack queue-panel-head">.*?</div>\s*\n\s*<div class="view-toggle"',
            self.markup,
            re.DOTALL,
        ).group(0)
        self.assertIn('class="queue-panel-heading"', queue_header)
        self.assertIn('id="resort-playlist-button"', queue_header)
        self.assertLess(
            queue_header.index('id="list-title-text"'),
            queue_header.index('id="list-count"'),
        )
        self.assertIn('id="list-title-text"', queue_header)
        self.assertIn('class="list-count"', queue_header)
        self.assertNotIn('class="count-chip"', self.markup)

        list_start = self.script.index("function renderListHeader")
        list_end = self.script.index("function syncListView", list_start)
        list_source = self.script[list_start:list_end]
        self.assertIn("elements.listTitleText", list_source)
        self.assertIn('"history.title"', list_source)
        self.assertIn('"list.title"', list_source)
        self.assertIn('"history.count"', list_source)
        self.assertIn('"list.count"', list_source)
        self.assertNotIn("elements.listTitle.textContent", list_source)
        self.assertNotIn("follow.countSongs", list_source)

        count_rule = re.search(r"\.list-count\s*\{([^}]*)\}", self.styles).group(1)
        for obsolete_property in ("background", "border", "border-radius", "padding"):
            self.assertNotIn(f"{obsolete_property}:", count_rule)

        for language in self.translations["languages"].values():
            for key in ("list.count", "history.count"):
                self.assertIn("{count}", language[key])
                self.assertTrue(
                    "(" in language[key] or "（" in language[key],
                    language[key],
                )

    def test_new_remote_strings_exist_in_all_languages(self):
        required = (
            "remote.menuLabel",
            "remote.connectionStatusLabel",
            "remote.connectionIndicatorLabel",
            "remote.connectionConnecting",
            "remote.connectionReconnecting",
            "remote.connectionConnected",
            "remote.connectionOffline",
            "remote.connectionOfflineToast",
            "remote.shareQr",
            "remote.controlRejected",
            "remote.controlCommandFailed",
            "display.themeLight",
            "display.themeDark",
            "display.themeBlue",
        )
        for language, translations in self.translations["languages"].items():
            for key in required:
                self.assertTrue(translations.get(key), f"missing {language}:{key}")

    def test_remote_brand_accessible_name_and_document_title_are_localized(self):
        expected_labels = {
            "zh": "bilikara 远程控制",
            "en": "bilikara remote control",
            "ja": "bilikara リモコン",
        }
        for language, expected_label in expected_labels.items():
            translations = self.translations["languages"][language]
            self.assertEqual(translations["document.remoteTitle"], "bilikara remote")
            self.assertEqual(translations["remote.heroTitle"], expected_label)
