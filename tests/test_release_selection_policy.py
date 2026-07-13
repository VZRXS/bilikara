import unittest

from bilikara.updater import _py_latest_release_for_current

class TestReleaseSelectionPolicy(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(_py_latest_release_for_current("v0.7.0", []), {})

    def test_all_releases_are_drafts(self):
        releases = [
            {"tag_name": "v0.8.0", "draft": True},
            {"tag_name": "v0.9.0", "draft": True},
        ]
        self.assertEqual(_py_latest_release_for_current("v0.7.0", releases), {})

    def test_invalid_tags_only(self):
        releases = [
            {"tag_name": "invalid-tag", "draft": False},
            {"tag_name": "v1.x.y", "draft": False},
        ]
        self.assertEqual(_py_latest_release_for_current("v0.7.0", releases), {})

    def test_mixed_valid_and_invalid_tags(self):
        releases = [
            {"tag_name": "invalid-tag", "draft": False},
            {"tag_name": "v0.8.0", "draft": False},
        ]
        self.assertIs(
            _py_latest_release_for_current("v0.7.0", releases),
            releases[1]
        )

    def test_stable_only_selection(self):
        releases = [
            {"tag_name": "v0.8.0-preview.1", "draft": False},
            {"tag_name": "v0.8.0", "draft": False},
        ]
        self.assertIs(
            _py_latest_release_for_current("v0.7.0", releases, include_preview=False),
            releases[1]
        )

    def test_preview_enabled_selection(self):
        releases = [
            {"tag_name": "v0.8.0", "draft": False},
            {"tag_name": "v0.9.0-preview.1", "draft": False},
        ]
        self.assertIs(
            _py_latest_release_for_current("v0.7.0", releases, include_preview=True),
            releases[1]
        )

    def test_preview_exclusion_in_stable_mode(self):
        releases = [
            {"tag_name": "v0.8.0-preview.1", "draft": False},
        ]
        self.assertEqual(
            _py_latest_release_for_current("v0.7.0", releases, include_preview=False),
            {}
        )

    def test_current_version_newer_than_every_candidate(self):
        # The python function actually always returns the max release from the list,
        # checking "is_newer" happens at the check_for_update level. So it will return the latest.
        # We just test what _py_latest_release_for_current actually does.
        releases = [
            {"tag_name": "v0.6.0", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[0])

    def test_candidate_equal_to_current_version(self):
        releases = [
            {"tag_name": "v0.7.0", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[0])

    def test_candidate_older_than_current_version(self):
        releases = [
            {"tag_name": "v0.6.0", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[0])

    def test_current_version_is_a_preview(self):
        releases = [
            {"tag_name": "v0.8.0", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.8.0-preview.1", releases), releases[0])

    def test_duplicate_normalized_versions(self):
        releases = [
            {"tag_name": "v0.8.0", "draft": False, "id": 1},
            {"tag_name": "v0.8.0", "draft": False, "id": 2},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[0])

    def test_duplicate_version_input_order_tie_breaking(self):
        releases = [
            {"tag_name": "v0.8.0", "draft": False, "id": 1},
            {"tag_name": "v0.8.0", "draft": False, "id": 2},
            {"tag_name": "0.8.0", "draft": False, "id": 3},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[0])

    def test_uppercase_v(self):
        releases = [
            {"tag_name": "V0.8.0", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[0])

    def test_multiple_stable_versions(self):
        releases = [
            {"tag_name": "v0.8.0", "draft": False},
            {"tag_name": "v0.9.0", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[1])

    def test_multiple_preview_versions(self):
        releases = [
            {"tag_name": "v0.8.0-preview.1", "draft": False},
            {"tag_name": "v0.8.0-preview.2", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases, include_preview=True), releases[1])

    def test_stable_and_preview_releases_mixed(self):
        releases = [
            {"tag_name": "v0.8.0", "draft": False},
            {"tag_name": "v0.9.0-preview.1", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases, include_preview=False), releases[0])
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases, include_preview=True), releases[1])

    def test_shuffled_release_order(self):
        releases = [
            {"tag_name": "v0.9.0", "draft": False},
            {"tag_name": "v0.8.0", "draft": False},
            {"tag_name": "v1.0.0", "draft": False},
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases), releases[2])

    def test_conflicting_prerelease_field_and_tag_semantics(self):
        # Prerelease field isn't checked by the python code! It only looks at the tag string!
        releases = [
            {"tag_name": "v0.8.0", "draft": False, "prerelease": True}, # It's a stable tag, even though prerelease is True
        ]
        self.assertIs(_py_latest_release_for_current("v0.7.0", releases, include_preview=False), releases[0])

    def test_valid_no_match(self):
        releases = [
            {"tag_name": "invalid", "draft": False},
        ]
        self.assertEqual(_py_latest_release_for_current("v0.7.0", releases), {})

if __name__ == '__main__':
    unittest.main()
