from __future__ import annotations

from html.parser import HTMLParser
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class _OutputMarkupParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tags: list[str] = []
        self.ids: set[str] = set()
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        values = dict(attrs)
        if values.get("id"):
            self.ids.add(str(values["id"]))
        if tag == "script" and values.get("src"):
            self.scripts.append(str(values["src"]))


class ControllerFrontendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        static = ROOT / "static"
        cls.html = (static / "controller.html").read_text(encoding="utf-8")
        cls.css = (static / "controller.css").read_text(encoding="utf-8")
        cls.shared_css = (static / "remote-access.css").read_text(encoding="utf-8")
        cls.source = (static / "controller.js").read_text(encoding="utf-8")

    def test_output_window_is_a_stage_not_a_second_control_console(self):
        parser = _OutputMarkupParser()
        parser.feed(self.html)
        self.assertFalse({"video", "audio", "iframe", "canvas"} & set(parser.tags))
        self.assertEqual(
            parser.scripts,
            [
                "/presentation-scene.js",
                "/presentation-renderer.js",
                "/presentation-sync.js",
                "/controller.js",
            ],
        )
        self.assertTrue(
            {
                "controller-shell",
                "controller-stage-frame",
                "controller-empty",
                "controller-status",
                "controller-output-control",
                "controller-exit",
                "controller-remote-popover",
                "controller-remote-qr-image",
                "controller-remote-url-link",
                "controller-internet-remote-meta",
                "controller-internet-remote-connection-count",
                "controller-internet-remote-room",
                "controller-internet-remote-qr-image",
                "controller-internet-remote-qr-placeholder",
                "controller-internet-remote-password",
                "controller-error",
                "controller-unavailable",
            }.issubset(parser.ids)
        )
        self.assertIn("candidate?.qr_image", self.source)
        self.assertIn("candidate?.password", self.source)
        self.assertIn("__bilikaraQrImage", self.source)
        for rejected_id in (
            "controller-play-toggle",
            "controller-back-15",
            "controller-forward-15",
            "controller-next",
            "controller-volume",
        ):
            self.assertNotIn(rejected_id, parser.ids)

    def test_output_video_is_muted_clock_follower_and_never_host_authority(self):
        self.assertIn('candidate?.type !== "master-state"', self.source)
        self.assertIn('document.createElement("video")', self.source)
        self.assertIn("video.muted = true", self.source)
        self.assertIn("video.defaultMuted = true", self.source)
        self.assertIn("sync.planClockCorrection", self.source)
        self.assertIn("BroadcastChannel(sync.channelName)", self.source)
        self.assertIn("localStorage.setItem(sync.storageKey", self.source)
        self.assertNotIn('document.createElement("audio")', self.source)
        self.assertNotIn('document.createElement("iframe")', self.source)
        self.assertNotIn("EventSource", self.source)
        self.assertNotIn("/api/player/", self.source)
        self.assertNotIn('invoke("send_presentation_command"', self.source)

    def test_output_only_marks_ready_and_can_exit_fullscreen_mode(self):
        self.assertIn('invoke("get_presentation_session")', self.source)
        self.assertIn('invoke("mark_presentation_controller_ready"', self.source)
        self.assertIn('invoke("deactivate_local_presentation", { generation })', self.source)
        self.assertIn('data-i18n-aria-label="player.fullscreenRemoteExit"', self.html)
        self.assertIn("presentation-output-phone-icon", self.html)
        self.assertIn("presentation-output-exit-icon", self.html)
        self.assertIn("M20 4l-6 6M14 5v5h5M4 20l6-6M5 14h5v5", self.html)
        self.assertIn("activationUsesTouch(event)", self.source)
        self.assertIn("setRemoteQrPinned(true)", self.source)
        self.assertIn("candidate.payload?.remoteAccess", self.source)
        self.assertIn("candidate.payload?.internetRemote", self.source)
        self.assertIn("function renderInternetRemote", self.source)
        self.assertIn("applyLanguage(candidate.payload?.language)", self.source)
        self.assertIn('fetch("/api/app/open-url"', self.source)
        self.assertIn("position: fixed", self.css)
        self.assertIn("top: 16px", self.css)
        self.assertIn("right: 16px", self.css)
        self.assertNotIn("presentation-controller-controls", self.css)

    def test_output_remote_control_uses_theme_tokens_and_hover_exit_label(self):
        self.assertIn('data-i18n="player.fullscreenExit"', self.html)
        self.assertIn("color: var(--ink)", self.css)
        self.assertIn("background: var(--settings-panel-bg)", self.css)
        self.assertIn(
            "background: color-mix(in srgb, var(--settings-panel-bg)",
            self.css,
        )
        self.assertIn(".presentation-output-exit-label", self.css)
        self.assertIn("cubic-bezier(0.16, 1, 0.3, 1)", self.css)
        self.assertIn('href="/remote-access.css"', self.html)
        self.assertIn("width: min(390px, calc(100vw - 32px))", self.shared_css)
        self.assertIn(".remote-access-card", self.shared_css)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", self.shared_css)
        self.assertIn("font-size: 12px", self.shared_css)
        self.assertNotIn("remote-access-public-state-icon", self.html)
        self.assertIn(
            'class="remote-access-public-connection-indicator"',
            self.html,
        )
        self.assertIn("candidate?.connected_count", self.source)
        local_details = self.html[
            self.html.index('id="controller-remote-url-link"')
            - 200 : self.html.index('id="controller-internet-remote-meta"')
        ]
        self.assertLess(
            local_details.index('id="controller-remote-url-link"'),
            local_details.index('id="controller-remote-url-hint"'),
        )
        self.assertNotIn("presentation-remote-meta-font-size", self.css)

    def test_output_remote_copy_uses_the_shared_local_and_public_wording(self):
        self.assertIn(
            'class="remote-access-copy-title" data-i18n="internetRemote.localScanTitle"',
            self.html,
        )
        self.assertIn(
            'id="controller-remote-url-hint" data-i18n="internetRemote.localSameNetwork"',
            self.html,
        )
        self.assertIn(
            'data-i18n="internetRemote.publicScanTitle"',
            self.html,
        )
        self.assertIn(
            'elements.remoteUrlHint.textContent = t("internetRemote.localSameNetwork")',
            self.source,
        )

    def test_output_fails_closed_without_tauri_or_sync_contract(self):
        self.assertIn('typeof invoke !== "function"', self.source)
        self.assertIn('typeof listen !== "function"', self.source)
        self.assertIn("!sceneApi", self.source)
        self.assertIn("!renderer", self.source)
        self.assertIn("!sync", self.source)
        self.assertIn('failClosed(t("controller.tauriRequired"))', self.source)
        self.assertIn("elements.exit.disabled = true", self.source)
        self.assertIn('elements.unavailable.classList.remove("hidden")', self.source)


if __name__ == "__main__":
    unittest.main()
