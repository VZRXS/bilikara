import os
import unittest

from bilikara import rust_backend
from bilikara.bilibili import (
    AudioBindingDecision,
    VideoPage,
    _auto_dual_audio_video_page,
    _is_auto_dual_audio_pair,
    _part_keyword_match,
    _py_auto_dual_audio_video_page,
    _py_decide_audio_binding,
    _py_is_auto_dual_audio_pair,
    _py_part_keyword_match,
    _py_requires_manual_binding,
    _requires_manual_binding,
)


def page(
    number: int,
    part: str,
    duration: int = 300,
    *,
    cid: int | None = None,
) -> VideoPage:
    return VideoPage(
        page=number,
        cid=cid if cid is not None else 100 + number,
        duration=duration,
        part=part,
    )


class AudioBindingPythonPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") != "1":
            return
        status = rust_backend.backend_status()
        if not status["loaded"]:
            raise AssertionError(
                f"BILIKARA_REQUIRE_RUST_LIB=1 but Rust backend did not load: {status['error']}"
            )
        if not status["capabilities"].get("decide_audio_binding", False):
            raise AssertionError(
                "BILIKARA_REQUIRE_RUST_LIB=1 but decide_audio_binding is unavailable"
            )

    def assert_decision(
        self,
        pages: list[VideoPage],
        mode: str,
        selected_indices: tuple[int, ...],
        automatic_video_index: int | None = None,
        *,
        tolerance_seconds: int = 3,
    ) -> None:
        self.assertEqual(
            _py_decide_audio_binding(pages, tolerance_seconds),
            AudioBindingDecision(
                mode=mode,
                selected_indices=selected_indices,
                automatic_video_index=automatic_video_index,
            ),
        )

    def test_empty_input_is_no_match(self):
        self.assertIsNone(_py_decide_audio_binding([]))
        self.assertFalse(_py_requires_manual_binding([]))

    def test_single_page(self):
        self.assert_decision([page(7, "plain")], "single", (0,))

    def test_two_pages_without_keyword_require_manual_binding(self):
        pages = [page(1, "main track"), page(2, "music track", 301)]
        self.assert_decision(pages, "manual_required", ())
        self.assertTrue(_py_requires_manual_binding(pages))

    def test_exactly_one_recognized_label_is_automatic(self):
        pages = [page(1, "plain"), page(2, "伴奏版", 301)]
        self.assert_decision(pages, "automatic", (0, 1), 1)

    def test_both_recognized_labels_are_automatic_without_override(self):
        pages = [page(1, "on vocal"), page(2, "off vocal", 301)]
        self.assert_decision(pages, "automatic", (0, 1))

    def test_english_keyword_case_variants(self):
        for label in ("ON", "On", "on", "OFF", "Off", "off"):
            with self.subTest(label=label):
                self.assertTrue(_py_part_keyword_match(label))

    def test_cjk_keywords(self):
        for label in ("人声", "原唱", "伴奏"):
            with self.subTest(label=label):
                self.assertTrue(_py_part_keyword_match(label))

    def test_leading_and_trailing_whitespace(self):
        for label in ("  ON  ", "\t伴奏\n"):
            with self.subTest(label=label):
                self.assertTrue(_py_part_keyword_match(label))

    def test_current_english_substring_side_effects(self):
        self.assertTrue(_py_part_keyword_match("song"))
        self.assertTrue(_py_part_keyword_match("office"))
        self.assertTrue(_py_part_keyword_match("instrumental song version"))
        self.assertFalse(_py_part_keyword_match("vocal track"))

    def test_duration_tolerance_boundaries(self):
        for difference, expected_mode in ((2, "automatic"), (3, "automatic"), (4, "manual_required")):
            with self.subTest(difference=difference):
                self.assert_decision(
                    [page(1, "plain", 300), page(2, "off", 300 + difference)],
                    expected_mode,
                    (0, 1) if expected_mode == "automatic" else (),
                    1 if expected_mode == "automatic" else None,
                )

    def test_custom_tolerance_is_applied_by_reference_decision(self):
        pages = [page(1, "plain", 300), page(2, "off", 304)]
        self.assert_decision(pages, "automatic", (0, 1), 1, tolerance_seconds=4)

    def test_reversed_input_preserves_selected_order_and_maps_override_index(self):
        p2 = page(2, "off vocal", 301)
        p1 = page(1, "plain", 300)
        self.assert_decision([p2, p1], "automatic", (0, 1), 0)

    def test_p1_p2_automatic_video_override(self):
        pages = [page(1, "main track"), page(2, "off vocal", 301)]
        self.assertEqual(_py_auto_dual_audio_video_page(pages), 2)
        self.assert_decision(pages, "automatic", (0, 1), 1)

    def test_p1_recognized_p2_unrecognized_has_no_override(self):
        pages = [page(1, "on vocal"), page(2, "music track", 301)]
        self.assertIsNone(_py_auto_dual_audio_video_page(pages))
        self.assert_decision(pages, "automatic", (0, 1))

    def test_both_p1_p2_recognized_have_no_override(self):
        pages = [page(1, "on vocal"), page(2, "off vocal", 301)]
        self.assertIsNone(_py_auto_dual_audio_video_page(pages))

    def test_other_page_numbers_have_no_override(self):
        pages = [page(3, "main track"), page(4, "off vocal", 301)]
        self.assert_decision(pages, "automatic", (0, 1))

    def test_duplicate_page_numbers_have_no_override(self):
        pages = [page(1, "main track", cid=101), page(1, "off vocal", 301, cid=102)]
        self.assert_decision(pages, "automatic", (0, 1))

    def test_more_than_two_pages_require_manual_binding(self):
        pages = [page(1, "on"), page(2, "off"), page(3, "伴奏")]
        self.assert_decision(pages, "manual_required", ())
        self.assertTrue(_py_requires_manual_binding(pages))

    def test_automatic_selected_indices_stay_in_input_order(self):
        pages = [page(9, "off", 302), page(2, "plain", 300)]
        self.assert_decision(pages, "automatic", (0, 1))

    def test_legacy_helpers_remain_python_equivalent(self):
        pages = [page(1, "plain"), page(2, "off", 301)]
        for label in ("ON", "office", "plain"):
            with self.subTest(label=label):
                self.assertEqual(_part_keyword_match(label), _py_part_keyword_match(label))
        self.assertEqual(_is_auto_dual_audio_pair(pages), _py_is_auto_dual_audio_pair(pages))
        self.assertEqual(
            _auto_dual_audio_video_page(pages),
            _py_auto_dual_audio_video_page(pages),
        )
        self.assertEqual(_requires_manual_binding(pages), _py_requires_manual_binding(pages))


if __name__ == "__main__":
    unittest.main()
