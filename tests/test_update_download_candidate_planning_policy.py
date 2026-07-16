import unittest

from bilikara import updater


def inputs(*items: tuple[str, str]) -> list[dict[str, object]]:
    return [
        {"original_index": index, "url": url, "source": source}
        for index, (url, source) in enumerate(items)
    ]


class UpdateDownloadCandidatePlanningPolicyTest(unittest.TestCase):
    def test_python_dedupe_trims_drops_empty_and_keeps_first(self):
        self.assertEqual(
            updater._py_dedupe_urls(
                ["  https://primary  ", "", " \t ", "https://primary", "https://mirror"]
            ),
            ["https://primary", "https://mirror"],
        )

    def test_empty_plan_is_valid(self):
        self.assertEqual(updater._py_plan_update_download_candidates([]), [])
        self.assertEqual(
            updater._py_plan_update_download_candidates(
                inputs(("   ", "primary"), ("\n", "mirror"))
            ),
            [],
        )

    def test_source_identity_and_order_are_preserved(self):
        plan = updater._py_plan_update_download_candidates(
            inputs(
                ("https://primary", "primary"),
                ("https://mirror-b", "mirror"),
                ("https://mirror-a", "derived_mirror"),
            )
        )
        self.assertEqual(
            plan,
            [
                {"input_index": 0, "source": "primary", "route": "direct", "url": "https://primary"},
                {"input_index": 1, "source": "mirror", "route": "direct", "url": "https://mirror-b"},
                {"input_index": 2, "source": "derived_mirror", "route": "direct", "url": "https://mirror-a"},
            ],
        )

    def test_duplicates_across_primary_and_mirrors_keep_first_identity(self):
        plan = updater._py_plan_update_download_candidates(
            inputs(
                (" https://same ", "primary"),
                ("https://same", "mirror"),
                ("https://other", "derived_mirror"),
            )
        )
        self.assertEqual([candidate["url"] for candidate in plan], ["https://same", "https://other"])
        self.assertEqual([candidate["input_index"] for candidate in plan], [0, 2])

    def test_direct_and_proxy_order_follow_proxy_first(self):
        candidates = inputs(("https://example/app.zip", "primary"))
        direct_first = updater._py_plan_update_download_candidates(
            candidates,
            proxy="https://proxy/{url}",
            proxy_first=False,
        )
        proxy_first = updater._py_plan_update_download_candidates(
            candidates,
            proxy="https://proxy/{url}",
            proxy_first=True,
        )
        self.assertEqual([item["route"] for item in direct_first], ["direct", "proxy"])
        self.assertEqual([item["route"] for item in proxy_first], ["proxy", "direct"])

    def test_proxy_placeholder_encoding_and_suffixes_match_phase1(self):
        url = "https://example/歌曲 a.zip?x=1&y=2"
        encoded = updater._py_plan_update_download_candidates(
            inputs((url, "primary")),
            proxy="https://proxy/{url_encoded}",
            proxy_first=True,
        )
        self.assertEqual(
            encoded[0]["url"],
            "https://proxy/https%3A%2F%2Fexample%2F%E6%AD%8C%E6%9B%B2%20a.zip%3Fx%3D1%26y%3D2",
        )
        for proxy in ("https://proxy/", "https://proxy=", "https://proxy?", "https://proxy&"):
            with self.subTest(proxy=proxy):
                plan = updater._py_plan_update_download_candidates(
                    inputs(("https://example/a", "primary")),
                    proxy=proxy,
                    proxy_first=True,
                )
                self.assertEqual(plan[0]["url"], f"{proxy}https://example/a")

    def test_empty_and_equal_proxy_do_not_create_proxy_candidate(self):
        candidates = inputs(("https://example/a", "primary"))
        for proxy in ("", "   ", "{url}"):
            with self.subTest(proxy=proxy):
                plan = updater._py_plan_update_download_candidates(
                    candidates,
                    proxy=proxy,
                    proxy_first=True,
                )
                self.assertEqual(
                    plan,
                    [{"input_index": 0, "source": "primary", "route": "direct", "url": "https://example/a"}],
                )

    def test_generated_proxy_duplicates_are_removed_stably(self):
        plan = updater._py_plan_update_download_candidates(
            inputs(
                ("https://example/a", "primary"),
                ("https://proxy/https://example/a", "mirror"),
            ),
            proxy="https://proxy/{url}",
            proxy_first=False,
        )
        urls = [candidate["url"] for candidate in plan]
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(urls[1], "https://proxy/https://example/a")
        self.assertEqual(plan[1]["input_index"], 0)

    def test_unicode_and_percent_encoded_urls_are_opaque(self):
        urls = ["https://例子.test/歌曲.zip", "https://example/%E6%AD%8C.zip"]
        plan = updater._py_plan_update_download_candidates(
            inputs((urls[0], "primary"), (urls[1], "mirror"))
        )
        self.assertEqual([candidate["url"] for candidate in plan], urls)

    def test_reference_updater_helpers_preserve_existing_sequences(self):
        self.assertEqual(
            updater._py_latest_release_api_urls(
                " https://api.example/latest ",
                ["https://mirror/latest", "https://api.example/latest"],
            ),
            ["https://api.example/latest", "https://mirror/latest"],
        )
        self.assertEqual(
            updater._py_release_list_api_urls(
                "https://api.example/releases",
                ["https://mirror/releases"],
                ["https://derived/releases/latest", "invalid"],
            ),
            [
                "https://api.example/releases",
                "https://mirror/releases",
                "https://derived/releases",
            ],
        )
        self.assertEqual(
            updater._py_download_url_candidates(
                " https://example/app.zip ",
                "https://proxy/{url}",
                True,
            ),
            ["https://proxy/https://example/app.zip", "https://example/app.zip"],
        )

    def test_reference_planning_is_deterministic(self):
        candidates = inputs(
            ("https://primary", "primary"),
            ("https://mirror", "mirror"),
        )
        expected = updater._py_plan_update_download_candidates(
            candidates,
            proxy="https://proxy/{url_encoded}",
            proxy_first=True,
        )
        for _ in range(20):
            self.assertEqual(
                updater._py_plan_update_download_candidates(
                    candidates,
                    proxy="https://proxy/{url_encoded}",
                    proxy_first=True,
                ),
                expected,
            )


if __name__ == "__main__":
    unittest.main()
