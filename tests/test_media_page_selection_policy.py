import itertools
import os
import unittest

from bilikara import rust_backend
from bilikara.bilibili import (
    VideoPage,
    _py_select_matching_pages,
    _py_is_better_cluster,
    _py_cluster_spread,
    _py_cluster_representative_duration,
    select_matching_pages,
)


class TestMediaPageSelectionPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") != "1":
            return
        status = rust_backend.backend_status()
        if not status["loaded"]:
            raise AssertionError(
                f"BILIKARA_REQUIRE_RUST_LIB=1 but Rust backend did not load: {status['error']}"
            )
        if not status["capabilities"].get("select_media_pages", False):
            raise AssertionError(
                "BILIKARA_REQUIRE_RUST_LIB=1 but select_media_pages is unavailable"
            )

    def test_empty_input(self):
        self.assertEqual(_py_select_matching_pages([], preferred_page=1), [])
        self.assertEqual(select_matching_pages([], preferred_page=1), [])

    def test_single_page(self):
        page = VideoPage(page=1, cid=100, duration=240, part="P1")
        selected_py = _py_select_matching_pages([page], preferred_page=1)
        self.assertEqual(len(selected_py), 1)
        self.assertIs(selected_py[0], page)

        selected_pub = select_matching_pages([page], preferred_page=1)
        self.assertEqual(len(selected_pub), 1)
        self.assertIs(selected_pub[0], page)

    def test_two_pages_inside_tolerance(self):
        p1 = VideoPage(page=1, cid=101, duration=300, part="P1")
        p2 = VideoPage(page=2, cid=102, duration=302, part="P2")
        selected = _py_select_matching_pages([p1, p2], preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected), 2)
        self.assertIs(selected[0], p1)
        self.assertIs(selected[1], p2)

    def test_tolerance_boundary_cases(self):
        p1 = VideoPage(page=1, cid=101, duration=300, part="P1")
        
        # 1 unit below tolerance (diff 2, tol 3)
        p2_below = VideoPage(page=2, cid=102, duration=302, part="P2")
        selected_below = _py_select_matching_pages([p1, p2_below], preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected_below), 2)
        self.assertIs(selected_below[0], p1)
        self.assertIs(selected_below[1], p2_below)

        # Exactly on boundary (diff 3, tol 3)
        p2_exact = VideoPage(page=2, cid=102, duration=303, part="P2")
        selected_exact = _py_select_matching_pages([p1, p2_exact], preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected_exact), 2)
        self.assertIs(selected_exact[0], p1)
        self.assertIs(selected_exact[1], p2_exact)

        # 1 unit above boundary (diff 4, tol 3)
        p2_above = VideoPage(page=2, cid=102, duration=304, part="P2")
        selected_above = _py_select_matching_pages([p1, p2_above], preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected_above), 1)
        self.assertIs(selected_above[0], p2_above)

    def test_multiple_clusters_different_sizes(self):
        p1 = VideoPage(page=1, cid=101, duration=100, part="outlier")
        p2 = VideoPage(page=2, cid=102, duration=300, part="c1")
        p3 = VideoPage(page=3, cid=103, duration=301, part="c2")
        p4 = VideoPage(page=4, cid=104, duration=302, part="c3")
        pages = [p1, p2, p3, p4]
        selected = _py_select_matching_pages(pages, preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected), 3)
        self.assertIs(selected[0], p2)
        self.assertIs(selected[1], p3)
        self.assertIs(selected[2], p4)

    def test_equal_size_cluster_tie_breaks(self):
        # 1. Higher average representative duration wins
        c1 = [VideoPage(page=1, cid=101, duration=100, part="A"), VideoPage(page=2, cid=102, duration=101, part="B")]
        c2 = [VideoPage(page=3, cid=103, duration=200, part="C"), VideoPage(page=4, cid=104, duration=201, part="D")]
        self.assertTrue(_py_is_better_cluster(c2, c1, preferred_page=1))

        # 2. Preferred page present in cluster wins on duration tie
        c_pref = [VideoPage(page=1, cid=101, duration=100, part="A"), VideoPage(page=2, cid=102, duration=100, part="B")]
        c_nopref = [VideoPage(page=3, cid=103, duration=100, part="C"), VideoPage(page=4, cid=104, duration=100, part="D")]
        self.assertTrue(_py_is_better_cluster(c_pref, c_nopref, preferred_page=1))

        # 3. Smaller spread wins when duration and preferred flag tie
        c_narrow = [VideoPage(page=2, cid=102, duration=100, part="A"), VideoPage(page=3, cid=103, duration=100, part="B")]
        c_wide = [VideoPage(page=4, cid=104, duration=99, part="C"), VideoPage(page=5, cid=105, duration=101, part="D")]
        self.assertTrue(_py_is_better_cluster(c_narrow, c_wide, preferred_page=1))

        # 4. Page number lexicographical order tie-break
        c_lower = [VideoPage(page=1, cid=101, duration=100, part="A"), VideoPage(page=2, cid=102, duration=100, part="B")]
        c_higher = [VideoPage(page=3, cid=103, duration=100, part="C"), VideoPage(page=4, cid=104, duration=100, part="D")]
        self.assertTrue(_py_is_better_cluster(c_lower, c_higher, preferred_page=99))

    def test_preferred_page_absent_and_non_winning(self):
        p1 = VideoPage(page=1, cid=101, duration=50, part="short_pref")
        p2 = VideoPage(page=2, cid=102, duration=300, part="A")
        p3 = VideoPage(page=3, cid=103, duration=301, part="B")
        pages = [p1, p2, p3]
        selected = _py_select_matching_pages(pages, preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected), 2)
        self.assertIs(selected[0], p2)
        self.assertIs(selected[1], p3)

    def test_shuffled_input_and_order_preservation(self):
        p3 = VideoPage(page=3, cid=103, duration=302, part="P3")
        p1 = VideoPage(page=1, cid=101, duration=300, part="P1")
        p2 = VideoPage(page=2, cid=102, duration=301, part="P2")
        pages = [p3, p1, p2]
        selected = _py_select_matching_pages(pages, preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected), 3)
        self.assertIs(selected[0], p1)
        self.assertIs(selected[1], p2)
        self.assertIs(selected[2], p3)

    def test_duplicate_page_numbers_ordering_regression(self):
        # index 0: page=1, duration=301
        # index 1: page=1, duration=300
        p0 = VideoPage(page=1, cid=101, duration=301, part="P1_longer")
        p1 = VideoPage(page=1, cid=102, duration=300, part="P1_shorter")
        pages = [p0, p1]

        py_res = _py_select_matching_pages(pages, preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(py_res), 2)
        self.assertIs(py_res[0], p1)
        self.assertIs(py_res[1], p0)

        pub_res = select_matching_pages(pages, preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(pub_res), 2)
        self.assertIs(pub_res[0], p1)
        self.assertIs(pub_res[1], p0)

    def test_duplicate_page_numbers_and_cids(self):
        p1_a = VideoPage(page=1, cid=101, duration=300, part="P1_a")
        p1_b = VideoPage(page=1, cid=101, duration=301, part="P1_b")
        pages = [p1_a, p1_b]
        selected = _py_select_matching_pages(pages, preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected), 2)
        self.assertIs(selected[0], p1_a)
        self.assertIs(selected[1], p1_b)

    def test_zero_or_identical_durations(self):
        p1 = VideoPage(page=1, cid=101, duration=0, part="P1")
        p2 = VideoPage(page=2, cid=102, duration=0, part="P2")
        pages = [p1, p2]
        selected = _py_select_matching_pages(pages, preferred_page=1, tolerance_seconds=3)
        self.assertEqual(len(selected), 2)
        self.assertIs(selected[0], p1)
        self.assertIs(selected[1], p2)

    def test_real_multipage_fixtures(self):
        p1 = VideoPage(page=1, cid=101, duration=25, part="preview")
        p2 = VideoPage(page=2, cid=102, duration=301, part="on vocal")
        p3 = VideoPage(page=3, cid=103, duration=303, part="off vocal")
        p4 = VideoPage(page=4, cid=104, duration=302, part="duet")
        pages = [p1, p2, p3, p4]
        selected = _py_select_matching_pages(pages, preferred_page=1)
        self.assertEqual(len(selected), 3)
        self.assertIs(selected[0], p2)
        self.assertIs(selected[1], p3)
        self.assertIs(selected[2], p4)

    def test_permutations_equivalence(self):
        base_pages = [
            VideoPage(page=1, cid=101, duration=301, part="p1"),
            VideoPage(page=2, cid=102, duration=300, part="p2"),
            VideoPage(page=3, cid=103, duration=302, part="p3"),
        ]
        for perm in itertools.permutations(base_pages):
            perm_list = list(perm)
            py_res = _py_select_matching_pages(perm_list, preferred_page=1, tolerance_seconds=3)
            pub_res = select_matching_pages(perm_list, preferred_page=1, tolerance_seconds=3)
            self.assertEqual(len(py_res), len(pub_res))
            for a, b in zip(py_res, pub_res):
                self.assertIs(a, b)


if __name__ == "__main__":
    unittest.main()
