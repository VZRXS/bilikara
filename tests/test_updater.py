import unittest

from bilikara.updater import check_for_update, is_newer_version, version_tuple


class UpdateCheckTest(unittest.TestCase):
    def test_version_tuple_accepts_release_tags(self):
        self.assertEqual(version_tuple("v0.4.1"), (0, 4, 1))
        self.assertEqual(version_tuple("0.4.1"), (0, 4, 1))
        self.assertIsNone(version_tuple("v0.4.1-2-gabc123"))

    def test_is_newer_version_compares_semver_tags(self):
        self.assertTrue(is_newer_version("v0.4.1", "v0.4.0"))
        self.assertFalse(is_newer_version("v0.4.0", "v0.4.0"))
        self.assertFalse(is_newer_version("v0.4.0", "dev"))

    def test_check_for_update_reports_release_link(self):
        result = check_for_update(
            current_version="v0.4.0",
            release_fetcher=lambda: {
                "tag_name": "v0.4.1",
                "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.1",
                "name": "v0.4.1",
                "published_at": "2026-04-29T00:00:00Z",
            },
        )

        self.assertTrue(result["update_available"])
        self.assertEqual(result["current_version"], "v0.4.0")
        self.assertEqual(result["latest_version"], "v0.4.1")
        self.assertEqual(result["release_url"], "https://github.com/VZRXS/bilikara/releases/tag/v0.4.1")

    def test_check_for_update_offers_switch_for_non_release_build(self):
        result = check_for_update(
            current_version="v0.4.0-8-gabcdef-dirty",
            release_fetcher=lambda: {
                "tag_name": "v0.4.0",
                "html_url": "https://github.com/VZRXS/bilikara/releases/tag/v0.4.0",
            },
        )

        self.assertFalse(result["current_is_release"])
        self.assertFalse(result["update_available"])
        self.assertTrue(result["switch_to_release_available"])
        self.assertIn("非正式版", result["message"])


if __name__ == "__main__":
    unittest.main()
