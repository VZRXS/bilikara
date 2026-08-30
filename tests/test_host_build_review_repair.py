import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HostBuildReviewRepairTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.markup = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        cls.remote_markup = (ROOT / "static" / "remote.html").read_text(
            encoding="utf-8"
        )
        cls.styles = (ROOT / "static" / "styles.css").read_text(encoding="utf-8")
        cls.script = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        cls.translations = json.loads(
            (ROOT / "static" / "i18n.json").read_text(encoding="utf-8")
        )
        cls.design = (ROOT / "docs" / "host-shell-v0.8-design.txt").read_text(
            encoding="utf-8"
        )

    def test_right_dock_has_five_direct_icon_and_label_destinations(self):
        expected = ["queue", "history", "request", "random", "users"]
        self.assertEqual(
            re.findall(r'data-host-workspace="([^"]+)"', self.markup), expected
        )
        rail = re.search(
            r'<nav class="work-rail".*?</nav>', self.markup, re.DOTALL
        ).group(0)
        self.assertIn('class="work-rail-icon"', rail)
        self.assertEqual(rail.count("<svg"), 5)
        self.assertRegex(
            self.markup,
            r'(?s)id="host-workspace-history".*?</aside>\s*</section>\s*</section>\s*'
            r'<nav class="work-rail"',
        )
        self.assertIn(".layout > .work-rail", self.styles)

    def test_queue_and_history_are_direct_and_next_is_queue_current_owned(self):
        self.assertEqual(self.markup.count('id="next-button"'), 1)
        queue = re.search(
            r'<aside[^>]+id="host-workspace-queue".*?</aside>',
            self.markup,
            re.DOTALL,
        ).group(0)
        history = re.search(
            r'<aside[^>]+id="host-workspace-history".*?</aside>',
            self.markup,
            re.DOTALL,
        ).group(0)
        player = re.search(
            r'<section class="player-panel">.*?</section>\s*</section>',
            self.markup,
            re.DOTALL,
        ).group(0)
        current = re.search(
            r'<section class="queue-current[^>]*>.*?</section>',
            queue,
            re.DOTALL,
        ).group(0)
        self.assertIn('id="next-button"', current)
        self.assertNotIn('id="next-button"', history)
        self.assertNotIn('id="next-button"', player)
        self.assertIn("queue-current-next", current)
        self.assertNotIn("data-list-view", self.markup)
        self.assertNotIn("listView:", self.script)
        self.assertNotIn("activateListSubview", self.script)
        self.assertNotIn("syncListSubview", self.script)
        self.assertIn('data-host-workspace-panel="history"', history)
        self.assertIn('data-i18n="common.clear">清空</button>', queue)
        self.assertIn('data-i18n="common.clear">清空</button>', history)

    def test_shell_uses_one_width_per_state_and_measured_stage_modes(self):
        self.assertNotRegex(
            self.styles,
            r'\[data-active-workspace="(?:queue|history|request|random|users)"\]\s*\{[^}]*--host-',
        )
        self.assertNotIn("data-request-subview", self.styles)
        self.assertIn("--host-tool-card-width", self.styles)
        self.assertIn("--host-tool-card-width: minmax(380px, 1fr)", self.styles)
        self.assertIn("grid-template-columns: minmax(0, 1.82fr) var(--host-tool-card-width)", self.styles)
        self.assertNotIn("--host-tool-dock-width", self.styles)
        self.assertIn('"compact"', self.script)
        self.assertIn('"narrow"', self.script)
        self.assertIn('data-stage-controls-layout="inline"', self.styles)
        self.assertIn('id="stage-controls-toggle"', self.markup)
        self.assertIn('id="stage-control-backdrop"', self.markup)
        self.assertIn('id="stage-control-tray"', self.markup)
        self.assertIn("ResizeObserver", self.script)
        self.assertIn("measurePersistentStage", self.script)
        self.assertNotIn("innerWidth >= 760", self.script)
        self.assertIn('layout: "inline"', self.script)
        self.assertIn("contentFits: controlsStayOnOneRow && panelColumnsStayAligned && labelledButtonsFit", self.script)
        self.assertIn("inlineTraySize.contentFits", self.script)
        player_frame_rule = re.findall(
            r"\.left-column \.player-frame\s*\{([^}]*)\}", self.styles
        )[-1]
        self.assertIn("aspect-ratio: 16 / 9", player_frame_rule)
        self.assertNotIn("aspect-ratio: auto", player_frame_rule)
        self.assertIn("--stage-frame-inline-size", player_frame_rule)
        self.assertIn('data-i18n="player.controls"', self.markup)
        self.assertIn("stageControlTrayDirection", self.script)
        self.assertIn("spaceBelow", self.script)
        inline_rules = self.styles[
            self.styles.index('.app-shell[data-stage-controls-layout="inline"] .left-column > .player-panel') :
            self.styles.index(".host-workspace-region {", self.styles.index('.app-shell[data-stage-controls-layout="inline"] .left-column > .player-panel'))
        ]
        self.assertIn(".stage-controls-toggle", inline_rules)
        self.assertIn(".stage-control-tray-head", inline_rules)
        self.assertIn("display: none", inline_rules)
        self.assertNotIn(".stage-extended-controls .av-sync-panel", inline_rules)
        self.assertIn("state.stageControlInlineCollapsed = false", self.script)

    def test_narrow_tool_card_uses_measured_resident_or_bottom_overlay_geometry(self):
        narrow_rules = self.styles[self.styles.rindex("@media (max-width: 1179px)") :]
        self.assertIn("grid-template-rows: minmax(0, 1fr)", narrow_rules)
        self.assertIn("position: absolute", narrow_rules)
        self.assertIn("inset: auto 0 0", narrow_rules)
        self.assertIn("height: clamp(360px, 68%, 520px)", narrow_rules)
        self.assertIn("z-index: 20", narrow_rules)
        self.assertIn("border-radius: 16px", narrow_rules)
        self.assertIn('[data-narrow-tool-layout="resident"]', narrow_rules)
        self.assertIn("--narrow-stage-resident-height", narrow_rules)
        self.assertIn("grid-template-rows: minmax(0, var(--narrow-stage-resident-height)) minmax(300px, 1fr)", narrow_rules)
        self.assertRegex(
            narrow_rules,
            r'(?s)\[data-narrow-tool-layout="resident"\] \.left-column\s*\{[^}]*z-index: 30;',
        )
        self.assertNotIn("grid-template-rows: clamp(190px, 34%, 280px)", narrow_rules)
        self.assertIn("state.hostWorkspaceOverlayOpen = false", self.script)
        self.assertIn("function syncNarrowToolLayout()", self.script)
        self.assertIn("minimumResidentToolHeight = 300", self.script)
        self.assertIn("inlineTrayFitsWidth && availableStageHeight >= fullStageHeight", self.script)
        self.assertIn(": compactStageHeight", self.script)
        self.assertIn(
            '[data-stage-controls-layout="popup"] .left-column > .player-panel',
            self.styles,
        )
        self.assertRegex(
            self.styles,
            r'(?s)\[data-stage-controls-layout="popup"\] \.left-column > \.player-panel\s*\{[^}]*align-content: start;',
        )
        self.assertIn('dataset.narrowToolLayout = "overlay"', self.script)
        self.assertIn('dataset.narrowToolLayout = "resident"', self.script)

    def test_service_and_playback_controls_use_distinct_reviewed_icons(self):
        remote_control_path = (
            "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2z"
            "M7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"
        )
        self.assertIn(remote_control_path, self.remote_markup)
        self.assertIn(remote_control_path, self.markup)
        service = re.search(
            r'id="cache-settings-toggle".*?</button>', self.markup, re.DOTALL
        ).group(0)
        self.assertIn("M12.22 2h-.44", service)
        self.assertIn('<circle cx="12" cy="12" r="3">', service)
        self.assertNotIn(remote_control_path, service)
        stage_button = next(
            rule
            for rule in re.findall(
                r"\.stage-controls-toggle\s*\{([^}]*)\}", self.styles
            )
            if "background:" in rule
        )
        self.assertIn("background: var(--accent)", stage_button)
        self.assertIn("color: var(--on-accent)", stage_button)

    def test_queue_and_history_actions_share_the_title_row(self):
        card_head_rules = re.findall(
            r"\.host-workspace-region \.queue-card-head\s*\{([^}]*)\}",
            self.styles,
        )[-1]
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto", card_head_rules)
        self.assertIn("grid-template-rows: auto auto", card_head_rules)
        toolbar_rules = re.findall(
            r"\.host-workspace-region \.queue-toolbar\s*\{([^}]*)\}",
            self.styles,
        )[-1]
        self.assertIn("grid-column: 2", toolbar_rules)
        self.assertIn("grid-row: 2", toolbar_rules)

    def test_toolbar_badge_messages_and_product_copy_match_review(self):
        self.assertIn('class="global-action-icon"', self.markup)
        self.assertGreaterEqual(self.markup.count('class="global-action-icon"'), 4)
        self.assertRegex(
            self.styles,
            r'\.topbar \.control-label[^}]*font-size:\s*(?:13|14|15|16)px',
        )
        service_wrap = re.search(r"\.service-status-wrap\s*\{([^}]*)\}", self.styles).group(1)
        self.assertNotIn("border:", service_wrap)
        self.assertNotIn("service-status-ring", self.markup)
        self.assertIn("--update-available-dot: var(--accent)", self.styles)
        update_dot = re.search(r"\.app-update-indicator\s*\{([^}]*)\}", self.styles).group(1)
        self.assertIn("var(--update-available-dot)", update_dot)
        self.assertNotIn('setClassToggle(elements.serviceUpdateIndicator, "has-update"', self.script)
        topbar_rule = re.findall(r"(?m)^\.topbar\s*\{([^}]*)\}", self.styles)[-1]
        self.assertIn("border-bottom: 0", topbar_rule)
        self.assertIn("background: transparent", topbar_rule)
        self.assertIn(".message-surface", self.styles)
        self.assertIn("white-space: normal", self.styles)
        for language, values in self.translations["languages"].items():
            expected_gatcha = "试试运气" if language == "zh" else "Gatcha"
            self.assertEqual(values["shell.random"], expected_gatcha, language)
            self.assertEqual(values["gatcha.title"], expected_gatcha, language)
            self.assertNotIn("Discover", values["request.workspaceTitle"], language)
            self.assertNotIn("发现", values["request.workspaceTitle"], language)
            self.assertNotIn("見つ", values["request.workspaceTitle"], language)

    def test_playback_controls_share_one_divided_surface_and_gatcha_restores_web_dice(self):
        self.assertIn(
            ".stage-extended-controls > .av-sync-panel + .volume-panel",
            self.styles,
        )
        combined_surfaces = re.findall(
            r"\.stage-extended-controls\s*\{([^}]*)\}", self.styles
        )
        self.assertTrue(any("gap: 0" in rule for rule in combined_surfaces))
        self.assertTrue(any("border: 1px solid var(--line)" in rule for rule in combined_surfaces))
        self.assertTrue(any("background: var(--bottom-panel-bg)" in rule for rule in combined_surfaces))
        control_rows = re.search(
            r"\.stage-extended-controls > \.av-sync-panel,\s*"
            r"\.stage-extended-controls > \.volume-panel\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("grid-template-columns: max-content minmax(0, 1fr)", control_rows)
        self.assertIn("border: 0", control_rows)
        aligned_controls = re.search(
            r"\.stage-extended-controls \.av-sync-controls,\s*"
            r"\.stage-extended-controls \.volume-controls\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("width: max-content", aligned_controls)
        self.assertIn("justify-self: end", aligned_controls)
        inline_tray = re.search(
            r'\.app-shell\[data-stage-controls-layout="inline"\] '
            r"\.stage-control-tray\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("z-index: 7", inline_tray)
        gatcha_rail = re.search(
            r'id="work-rail-random"(?P<body>.*?)</button>', self.markup, re.S
        ).group("body")
        self.assertIn("<rect", gatcha_rail)
        self.assertGreaterEqual(gatcha_rail.count("<circle"), 5)
        idle_view = re.search(
            r'id="gatcha-init-view"(?P<body>.*?)</section>', self.markup, re.S
        ).group("body")
        self.assertIn('<div class="gatcha-icon" aria-hidden="true">🎲</div>', idle_view)
        self.assertNotIn("<svg", idle_view)

    def test_peer_workspace_and_dialog_headers_share_one_geometry_contract(self):
        self.assertIn("--host-peer-eyebrow-size: 12px", self.styles)
        self.assertIn("--host-peer-title-size: 24px", self.styles)
        self.assertIn("--host-peer-action-height: 40px", self.styles)
        self.assertIn("--host-peer-head-padding-inline: 16px", self.styles)
        for selector in (
            ".panel-head",
            ".host-workspace-region .queue-card-head",
            ".request-workspace-head",
            ".host-workspace-region .request-head",
            ".selection-modal-head",
        ):
            self.assertIn(selector, self.styles)
        self.assertIn('class="host-peer-heading"', self.markup)

    def test_sources_and_pool_use_direct_compact_responsive_controls(self):
        pool_slider = re.search(
            r'<input[^>]+id="gatcha-pool-weight-slider"[^>]+>', self.markup
        ).group(0)
        self.assertIn('class="volume-slider pool-config-weight-slider"', pool_slider)
        self.assertNotIn('id="open-favorites-button"', self.markup)
        self.assertNotIn('data-sources-mode="followed"', self.markup)
        self.assertIn('data-i18n="sources.ownerList">UP 主列表', self.markup)
        self.assertIn("setRangeFillPercent(elements.poolConfigWeightSlider", self.script)
        self.assertIn("--source-card-min-inline-size: 104px", self.styles)
        self.assertIn(
            "repeat(auto-fill, minmax(min(100%, var(--source-card-min-inline-size)), 1fr))",
            self.styles,
        )
        self.assertIn(
            "--request-song-card-min-inline-size: 220px",
            self.styles,
        )
        self.assertGreaterEqual(
            self.styles.count(
                "minmax(min(100%, var(--request-song-card-min-inline-size)), 1fr)"
            ),
            2,
        )
        self.assertNotIn("minmax(min(100%, 280px), 1fr)", self.styles)
        self.assertIn("justify-content: stretch", self.styles)
        self.assertIn("height: var(--source-action-control-height)", self.styles)

    def test_discover_hierarchy_uses_one_local_scroll_owner_per_level(self):
        owner = self.script[
            self.script.index("function activeRequestScrollOwner") :
            self.script.index("function normalizedD1BrowseLevel")
        ]
        for selector in (
            '[data-category-browser-home]',
            '[data-category-browse-results]',
            '[data-d1-browse-tags]',
            '[data-d1-browse-results]',
        ):
            self.assertIn(selector, owner)
        self.assertIn(".request-discover-view > .request-mode-panel {\n  overflow: hidden;", self.styles)
        self.assertIn(".request-discover-view .category-browser,", self.styles)
        self.assertIn("height: 100%;\n  overflow: hidden;", self.styles)

    def test_player_fullscreen_overrides_persistent_card_and_webkit_insets(self):
        for selector in (
            ".left-column > .player-panel:fullscreen",
            ".left-column > .player-panel:-webkit-full-screen",
            ".left-column > .player-panel.is-tauri-fullscreen",
            "body.is-tauri-fullscreen-active .app-shell",
        ):
            self.assertIn(selector, self.styles)
        fullscreen_rule = self.styles[
            self.styles.rindex("/* Player fullscreen must win") :
        ]
        for declaration in (
            "position: fixed;",
            "inset: 0;",
            "padding: 0;",
            "border: 0;",
            "border-radius: 0;",
            "box-shadow: none;",
        ):
            self.assertIn(declaration, fullscreen_rule)

    def test_stage_density_prefers_full_frame_and_checks_group_overflow(self):
        self.assertIn('data-stage-control-density="compact"', self.styles)
        self.assertIn('data-stage-control-density="plain"', self.styles)
        self.assertIn('class="av-sync-step-symbol"', self.markup)
        self.assertIn("controls.scrollWidth <= controls.clientWidth + 1", self.script)
        self.assertIn("fullFrameWithInlineControlsFits", self.script)
        self.assertIn("findStageControlFit", self.script)

    def test_platform_specific_tauri_chrome_is_explicit(self):
        windows_path = ROOT / "src-tauri" / "tauri.windows.conf.json"
        self.assertTrue(windows_path.exists())
        windows = json.loads(windows_path.read_text(encoding="utf-8"))
        window = windows["app"]["windows"][0]
        self.assertFalse(window["decorations"])
        main_capability = json.loads(
            (ROOT / "src-tauri" / "capabilities" / "main.json").read_text(
                encoding="utf-8"
            )
        )
        for permission in (
            "core:window:allow-close",
            "core:window:allow-minimize",
            "core:window:allow-toggle-maximize",
            "core:window:allow-start-dragging",
        ):
            self.assertIn(permission, main_capability["permissions"])
        macos = json.loads(
            (ROOT / "src-tauri" / "tauri.macos.conf.json").read_text(
                encoding="utf-8"
            )
        )["app"]["windows"][0]
        self.assertEqual(macos["titleBarStyle"], "Overlay")
        self.assertTrue(macos["hiddenTitle"])
        self.assertIn('id="window-controls"', self.markup)
        self.assertIn("initializeWindowChrome", self.script)

    def test_integrated_titlebar_and_followed_sources_use_peer_sizing(self):
        shell_rule = re.findall(r"(?m)^\.app-shell\s*\{([^}]*)\}", self.styles)[-1]
        self.assertIn("padding: 0 var(--host-shell-padding-inline) 12px", shell_rule)
        title_rule = re.findall(r"(?m)^\.host-brand h1\s*\{([^}]*)\}", self.styles)[-1]
        self.assertIn("font-size: 28px", title_rule)
        topbar_rule = re.findall(r"(?m)^\.topbar\s*\{([^}]*)\}", self.styles)[-1]
        self.assertIn("border-bottom: 0", topbar_rule)
        window_controls = re.findall(r"(?m)^\.window-controls\s*\{([^}]*)\}", self.styles)[-1]
        self.assertNotIn("margin-right", window_controls)

        request_follow_grids = re.findall(
            r"#host-workspace-request \.follow-up-grid,\s*"
            r"\.request-workspace \.follow-up-grid\s*\{([^}]*)\}",
            self.styles,
        )
        self.assertTrue(any("min(100%, 112px)" in rule for rule in request_follow_grids))
        request_follow_name = re.search(
            r"#host-workspace-request \.follow-up-name,\s*"
            r"\.request-workspace \.follow-up-name\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("font-size: 14px", request_follow_name)
        self.assertNotIn("抽卡缓存", self.markup)
        for values in self.translations["languages"].values():
            self.assertNotIn("抽卡缓存", "\n".join(str(value) for value in values.values()))
            self.assertNotIn("Gacha cache", "\n".join(str(value) for value in values.values()))
            self.assertNotIn("ガチャキャッシュ", "\n".join(str(value) for value in values.values()))

    def test_session_user_drag_surface_spacing_and_trash_are_not_clipped(self):
        self.assertIn('dragImage.className = "session-user-drag-image"', self.script)
        drag_image_rule = re.search(
            r"\.session-user-drag-image\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("background: transparent", drag_image_rule)
        self.assertIn("box-shadow: none", drag_image_rule)
        spacing_rule = re.search(
            r"\.session-user-form \+ \.message-surface\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("margin-top: 10px", spacing_rule)
        trash_rule = re.search(
            r"(?m)^\.session-user-trash\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertRegex(trash_rule, r"bottom:\s*[1-9]\d*px")
        self.assertRegex(trash_rule, r"right:\s*[1-9]\d*px")

    def test_audio_variants_are_persistent_and_expand_as_one_popup(self):
        player_frame = self.markup.index('id="player-frame"')
        variants = self.markup.index('id="audio-variant-bar"')
        control_tray = self.markup.index('id="stage-control-tray"')
        extended_controls = self.markup.index('id="stage-extended-controls"')
        self.assertLess(player_frame, variants)
        self.assertLess(variants, control_tray)
        self.assertLess(control_tray, extended_controls)
        tray_markup = self.markup[control_tray : self.markup.index("</section>", extended_controls)]
        self.assertNotIn('id="audio-variant-bar"', tray_markup)
        self.assertIn('id="audio-variant-backdrop"', self.markup)
        anchor_markup = self.markup[
            self.markup.index('id="audio-variant-anchor"') : self.markup.index('id="audio-variant-backdrop"')
        ]
        self.assertIn('id="audio-variant-toggle"', anchor_markup)
        self.assertIn('elements.audioVariantToggle?.addEventListener("click"', self.script)
        self.assertIn("anchor.right - width", self.script)
        self.assertIn("function positionAudioVariantPopover()", self.script)
        self.assertIn("function setAudioVariantPopoverOpen", self.script)
        self.assertIn('dataset.popoverDirection', self.script)
        self.assertIn('classList.toggle("hidden", !isOverflowing)', self.script)

    def test_narrow_stage_keeps_song_title_peer_size(self):
        narrow = self.styles[
            self.styles.index("@media (max-width: 1230px)") :
            self.styles.index("@media (pointer: coarse)")
        ]
        self.assertNotRegex(
            narrow,
            r"\.left-column \.panel-head h2\s*\{[^}]*font-size:",
        )

    def test_advanced_service_copy_uses_info_buttons_and_local_update_badge(self):
        restart = re.search(
            r'id="application-restart-row".*?</div>\s*</div>',
            self.markup,
            re.DOTALL,
        ).group(0)
        cleanup_heading = self.markup.rfind(
            '<div class="cache-advanced-label-row',
            0,
            self.markup.index('data-i18n="service.dataCleanup"'),
        )
        cleanup = self.markup[
            cleanup_heading :
            self.markup.index('id="data-reset-button"')
        ]
        self.assertIn("cache-contextual-info-region", restart)
        self.assertIn('data-i18n="service.restartApplicationHint"', restart)
        self.assertNotIn('<p class="cache-panel-hint"', restart)
        self.assertIn("cache-contextual-info-region", cleanup)
        self.assertIn('data-i18n="service.dataCleanupScope"', cleanup)
        self.assertNotIn("cache-data-cleanup-scope", cleanup)
        self.assertNotIn(".cache-panel-update-row.has-update", self.styles)
        badge = re.search(
            r"\.app-update-version-badge\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("border-radius: 999px", badge)
        self.assertIn("background:", badge)
        update_heading = re.search(
            r"\.cache-app-update-heading\s*\{([^}]*)\}", self.styles
        ).group(1)
        self.assertIn("flex-direction: column", update_heading)
        self.assertNotIn('setClassToggle(elements.appUpdateRow, "has-update"', self.script)

    def test_titlebar_double_click_uses_the_whole_noninteractive_surface(self):
        chrome = self.script[
            self.script.index("function initializeWindowChrome") :
            self.script.index("function initializeHostShell")
        ]
        self.assertIn('elements.topbar?.addEventListener("dblclick"', chrome)
        self.assertIn('closest("button, a, input, select, textarea', chrome)
        self.assertIn("appWindow.toggleMaximize()", chrome)

    def test_ultranarrow_toolbar_menus_and_windows_frame_keep_desktop_geometry(self):
        toolbar_repair = self.styles[
            self.styles.index("/* v0.8 ultra-narrow toolbar popover repair") :
            self.styles.index("/* v0.8 Windows application frame")
        ]
        topbar_rule = re.findall(r"(?m)^\.topbar\s*\{([^}]*)\}", self.styles)[-1]
        self.assertIn("flex-direction: row", topbar_rule)
        self.assertIn("width: 340px", toolbar_repair)
        self.assertIn("max-width: calc(100vw - 24px)", toolbar_repair)
        self.assertIn(".topbar .cache-panel-row", toolbar_repair)
        self.assertIn(".topbar .cache-panel-row-stack", toolbar_repair)

        frame = self.styles[self.styles.index("/* v0.8 Windows application frame") :]
        self.assertIn('body[data-tauri-platform="windows"] .app-shell', frame)
        self.assertIn("border-radius: var(--window-frame-radius)", frame)
        self.assertNotIn("--window-frame-shadow", frame)
        self.assertNotIn("box-shadow: var(--window-frame-shadow)", frame)
        self.assertIn(".is-tauri-maximized .app-shell", frame)
        self.assertIn("/* Windows chrome always owns a separate system-control row", frame)
        self.assertIn('body[data-tauri-platform="windows"] .topbar', frame)
        self.assertIn("grid-template-rows: 32px 52px", frame)
        windows = json.loads(
            (ROOT / "src-tauri" / "tauri.windows.conf.json").read_text(
                encoding="utf-8"
            )
        )["app"]["windows"][0]
        self.assertTrue(windows["transparent"])
        self.assertTrue(windows["shadow"])

        chrome = self.script[
            self.script.index("function initializeWindowChrome") :
            self.script.index("function initializeHostShell")
        ]
        self.assertIn("appWindow.isMaximized", chrome)
        self.assertIn("is-tauri-maximized", chrome)

    def test_service_ready_mark_matches_the_web_indicator_size(self):
        service_wraps = re.findall(r"\.service-status-wrap\s*\{([^}]*)\}", self.styles)
        self.assertTrue(service_wraps)
        self.assertIn("width: 20px", service_wraps[-1])
        self.assertIn("height: 20px", service_wraps[-1])
        toolbar_indicator = re.findall(
            r"\.service-status-wrap \.tool-status-indicator\s*\{([^}]*)\}",
            self.styles,
        )
        self.assertTrue(toolbar_indicator)
        self.assertIn("font-size: 18px", toolbar_indicator[-1])
        shared_ready = re.search(
            r"\.service-status-wrap \.tool-status-indicator\.is-ready,\s*"
            r"\.cache-panel-tool-indicator\.is-ready\s*\{([^}]*)\}",
            self.styles,
        ).group(1)
        self.assertIn("background: var(--tool-ready-bg)", shared_ready)
        self.assertIn('setTextContent(indicator, "✓")', self.script)

    def test_latest_shell_review_uses_shared_tabs_controls_scrollbars_and_responsive_detail(self):
        active_variant = re.findall(
            r"\.audio-variant-button\.active\s*\{([^}]*)\}", self.styles
        )[-1]
        self.assertIn("box-shadow: none", active_variant)
        self.assertIn("scrollbar-color: var(--scrollbar-thumb-bg) var(--scrollbar-track-bg)", self.styles)
        self.assertIn("*::-webkit-scrollbar-thumb", self.styles)
        self.assertIn("scrollbar-gutter: auto", self.styles)
        self.assertIn("--host-control-height: 48px", self.styles)
        self.assertIn("--host-control-font-size: 14px", self.styles)
        self.assertIn(".request-subview-tabs,\n.request-mode-tabs", self.styles)
        self.assertIn("container-type: inline-size", self.styles)
        self.assertIn("@container request-workspace (min-width: 500px)", self.styles)
        self.assertIn("grid-template-columns: minmax(0, 1.45fr) minmax(150px, 0.85fr)", self.styles)
        self.assertNotIn(".left-column .panel-head .section-tag {\n    display: none;", self.styles)
        final_cache_panel = re.findall(
            r"(?m)^\.topbar \.cache-panel\s*\{([^}]*)\}", self.styles
        )[-1]
        self.assertIn("padding-right: 12px", final_cache_panel)

    def test_design_records_corrected_contract_and_scroll_owner_table(self):
        for phrase in (
            "Queue and History are direct destinations",
            "Queue's Now Playing card",
            "independent fixed right-side tool rail",
            "same width at a fixed viewport",
            "width-and-height measured Stage modes",
            "one-line icon-plus-label global toolbar",
            "platform-specific integrated window chrome",
            "Scroll-owner table",
        ):
            self.assertIn(phrase, self.design)


if __name__ == "__main__":
    unittest.main()
