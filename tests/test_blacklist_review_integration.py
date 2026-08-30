import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class BlacklistReviewIntegrationTest(unittest.TestCase):
    def test_developer_catalog_tools_expose_blacklist_below_pending_review(self):
        html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        review_index = html.index('data-catalog-tool="review"')
        blacklist_index = html.index('data-catalog-tool="blacklist"')

        self.assertLess(review_index, blacklist_index)
        self.assertIn('data-i18n="search.blacklistBrowse"', html)
        self.assertIn('class="catalog-advanced developer-only"', html)

    def test_frontend_separates_review_rejection_from_generic_delete(self):
        source = (ROOT / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn('action = "reject-entry"', source)
        self.assertIn('apiPost("/api/admin-review/reject"', source)
        self.assertIn('releaseButton.dataset.devAction = "blacklist-release"', source)
        self.assertIn(
            'restoreButton.dataset.devAction = "blacklist-release-restore"', source
        )
        self.assertIn('apiPost("/api/admin-blacklist/restore"', source)
        self.assertIn('apiPost("/api/admin-video/delete"', source)

    def test_blacklist_translations_exist_in_all_languages(self):
        payload = json.loads((ROOT / "static" / "i18n.json").read_text(encoding="utf-8"))
        required = {
            "search.blacklistBrowse",
            "search.blacklistTitle",
            "search.blacklistRelease",
            "search.blacklistReleaseRestore",
        }

        for locale in ("zh", "en", "ja"):
            with self.subTest(locale=locale):
                self.assertTrue(required.issubset(payload["languages"][locale]))

    def test_developer_mode_exposes_maintenance_workflow_triggers(self):
        html = (ROOT / "static" / "index.html").read_text(encoding="utf-8")
        frontend = (ROOT / "static" / "app.js").read_text(encoding="utf-8")
        server = (ROOT / "bilikara" / "server.py").read_text(encoding="utf-8")

        self.assertEqual(html.count('data-catalog-tool="maintenance"'), 1)
        self.assertNotIn('data-target="maintenance"', html)
        self.assertEqual(html.count('data-catalog-tool="review"'), 1)
        self.assertEqual(html.count('data-catalog-tool="blacklist"'), 1)
        self.assertIn('id="catalog-advanced-content"', html)
        self.assertNotIn('id="search-modal-other-view"', html)
        self.assertIn('apiPost("/api/admin-maintenance/trigger"', frontend)
        self.assertIn('elements.catalogAdvancedContent.textContent = ""', frontend)
        self.assertIn('["review", "blacklist", "maintenance"]', frontend)
        self.assertIn('route == "/api/admin-maintenance/trigger"', server)

    def test_maintenance_translations_exist_in_all_languages(self):
        payload = json.loads((ROOT / "static" / "i18n.json").read_text(encoding="utf-8"))
        required = {
            "maintenance.browse",
            "maintenance.title",
            "maintenance.description",
            "maintenance.monthlyTitle",
            "maintenance.monthlyDescription",
            "maintenance.taggerYomiTitle",
            "maintenance.taggerYomiDescription",
            "maintenance.start",
            "maintenance.starting",
            "maintenance.started",
        }

        for locale in ("zh", "en", "ja"):
            with self.subTest(locale=locale):
                self.assertTrue(required.issubset(payload["languages"][locale]))

    def test_tauri_packages_the_shared_frontend_and_python_backend(self):
        tauri = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
        backend_source = (
            ROOT / "src-tauri" / "src" / "backend_process.rs"
        ).read_text(encoding="utf-8")
        bundle_source = (ROOT / "build_bundle.py").read_text(encoding="utf-8")

        self.assertEqual(tauri["build"]["frontendDist"], "../static")
        self.assertIn('join("bilikara").join("bilikara.exe")', backend_source)
        self.assertIn("ROOT_DIR / 'static'", bundle_source)


if __name__ == "__main__":
    unittest.main()
