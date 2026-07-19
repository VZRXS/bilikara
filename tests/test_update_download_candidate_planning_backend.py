import json
import os
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from bilikara import rust_backend, updater


def request(
    urls: list[str],
    sources: list[str] | None = None,
    *,
    proxy: str | None = None,
    proxy_first: bool = False,
) -> dict[str, object]:
    if sources is None:
        sources = ["primary"] * len(urls)
    return {
        "schema_version": 1,
        "candidates": [
            {"original_index": index, "url": url, "source": sources[index]}
            for index, url in enumerate(urls)
        ],
        "proxy": (
            {"template": proxy, "proxy_first": proxy_first}
            if proxy is not None
            else None
        ),
    }


class UpdateDownloadCandidatePlanningBackendTest(unittest.TestCase):
    def _mock_native_response(self, response_json: str, *, capability: bool = True):
        class DummyLibrary:
            pass

        library = rust_backend._rust_lib or DummyLibrary()

        class MockPointer:
            pass

        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(rust_backend, "_rust_lib", library))
        stack.enter_context(
            patch.dict(
                rust_backend._CAPABILITIES,
                {"plan_update_download_candidates": capability},
            )
        )
        stack.enter_context(
            patch.object(
                library,
                "rust_plan_update_download_candidates",
                new=lambda _payload: MockPointer(),
                create=True,
            )
        )
        stack.enter_context(
            patch.object(
                rust_backend,
                "_read_rust_string",
                new=lambda pointer: response_json if isinstance(pointer, MockPointer) else None,
            )
        )

    def test_valid_empty_plan_is_success_not_failure(self):
        self._mock_native_response(
            json.dumps({"schema_version": 1, "status": "empty", "candidates": []})
        )
        self.assertEqual(
            rust_backend.try_plan_update_download_candidates(request([])),
            (
                True,
                {"schema_version": 1, "status": "empty", "candidates": []},
            ),
        )

    def test_valid_native_plan_is_accepted_without_python_fallback(self):
        response = {
            "schema_version": 1,
            "status": "planned",
            "candidates": [
                {"input_index": 0, "source": "primary", "route": "proxy", "url": "https://proxy/https://example/app.zip"},
                {"input_index": 0, "source": "primary", "route": "direct", "url": "https://example/app.zip"},
            ],
        }
        self._mock_native_response(json.dumps(response))
        with patch.object(
            updater,
            "_py_download_url_candidates",
            wraps=updater._py_download_url_candidates,
        ) as fallback, patch.object(
            updater,
            "APP_UPDATE_DOWNLOAD_PROXY",
            "https://proxy/{url}",
        ), patch.object(
            updater,
            "APP_UPDATE_DOWNLOAD_PROXY_FIRST",
            True,
        ):
            self.assertEqual(
                updater._download_url_candidates("https://example/app.zip"),
                ["https://proxy/https://example/app.zip", "https://example/app.zip"],
            )
            fallback.assert_not_called()

    def test_request_validation_is_strict(self):
        valid = request(["https://example/a"])
        invalid = [
            None,
            [],
            {**valid, "schema_version": True},
            {**valid, "schema_version": 2},
            {**valid, "extra": True},
            {**valid, "candidates": "invalid"},
            {
                **valid,
                "candidates": [{**valid["candidates"][0], "original_index": True}],
            },
            {
                **valid,
                "candidates": [{**valid["candidates"][0], "original_index": -1}],
            },
            {
                **valid,
                "candidates": [
                    valid["candidates"][0],
                    {**valid["candidates"][0], "url": "https://example/b"},
                ],
            },
            {**valid, "candidates": [{**valid["candidates"][0], "url": None}]},
            {**valid, "candidates": [{**valid["candidates"][0], "source": "unknown"}]},
            {**valid, "candidates": [{**valid["candidates"][0], "extra": True}]},
            {**valid, "proxy": []},
            {**valid, "proxy": {"template": 3, "proxy_first": False}},
            {**valid, "proxy": {"template": "x", "proxy_first": 1}},
            {**valid, "proxy": {"template": "x", "proxy_first": False, "extra": 1}},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assertIsNone(rust_backend._update_download_plan_request(value))

    def test_response_validation_rejects_every_untrusted_invariant(self):
        req = request(
            ["https://example/a", "https://example/b"],
            ["primary", "mirror"],
            proxy="https://proxy/{url}",
            proxy_first=False,
        )
        candidates, proxy = rust_backend._update_download_plan_request(req)
        expected = rust_backend._expected_update_download_candidates(candidates, proxy)
        base = {"schema_version": 1, "status": "planned", "candidates": expected}
        invalid = [
            None,
            [],
            {**base, "schema_version": True},
            {**base, "schema_version": 2},
            {**base, "status": "unknown"},
            {**base, "status": "empty"},
            {**base, "candidates": "invalid"},
            {**base, "extra": True},
            {**base, "candidates": [{**expected[0], "input_index": True}, *expected[1:]]},
            {**base, "candidates": [{**expected[0], "input_index": 99}, *expected[1:]]},
            {**base, "candidates": [{**expected[0], "source": "unknown"}, *expected[1:]]},
            {**base, "candidates": [{**expected[0], "source": "mirror"}, *expected[1:]]},
            {**base, "candidates": [{**expected[0], "route": "unknown"}, *expected[1:]]},
            {**base, "candidates": [{**expected[0], "url": ""}, *expected[1:]]},
            {**base, "candidates": [{**expected[0], "url": f" {expected[0]['url']} "}, *expected[1:]]},
            {**base, "candidates": [expected[0], expected[0], *expected[2:]]},
            {**base, "candidates": list(reversed(expected))},
            {**base, "candidates": [{**expected[0], "url": "https://invented"}, *expected[1:]]},
            {**base, "candidates": [{**expected[0], "extra": True}, *expected[1:]]},
        ]
        for value in invalid:
            with self.subTest(value=value):
                self.assertFalse(
                    rust_backend._valid_update_download_plan_response(
                        value,
                        candidates,
                        proxy,
                    )
                )

    def test_proxy_output_without_proxy_configuration_is_impossible(self):
        req = request(["https://example/a"])
        candidates, proxy = rust_backend._update_download_plan_request(req)
        response = {
            "schema_version": 1,
            "status": "planned",
            "candidates": [
                {"input_index": 0, "source": "primary", "route": "proxy", "url": "https://example/a"}
            ],
        }
        self.assertFalse(
            rust_backend._valid_update_download_plan_response(response, candidates, proxy)
        )

    def test_malformed_json_unknown_status_source_duplicate_index_and_order_fall_back(self):
        invalid_responses = [
            "not json",
            json.dumps({"schema_version": 1, "status": "unknown", "candidates": []}),
            json.dumps(
                {
                    "schema_version": 1,
                    "status": "planned",
                    "candidates": [
                        {"input_index": 0, "source": "unknown", "route": "direct", "url": "https://example/a"}
                    ],
                }
            ),
            json.dumps(
                {
                    "schema_version": 1,
                    "status": "planned",
                    "candidates": [
                        {"input_index": 99, "source": "primary", "route": "direct", "url": "https://example/a"}
                    ],
                }
            ),
            json.dumps(
                {
                    "schema_version": 1,
                    "status": "planned",
                    "candidates": [
                        {"input_index": 0, "source": "primary", "route": "direct", "url": "https://example/a"},
                        {"input_index": 0, "source": "primary", "route": "direct", "url": "https://example/a"},
                    ],
                }
            ),
        ]
        for response_json in invalid_responses:
            with self.subTest(response_json=response_json):
                expected = updater._py_download_url_candidates(
                    "https://example/a",
                    updater.APP_UPDATE_DOWNLOAD_PROXY,
                    updater.APP_UPDATE_DOWNLOAD_PROXY_FIRST,
                )
                self._mock_native_response(response_json)
                with patch.object(
                    updater,
                    "_py_download_url_candidates",
                    wraps=updater._py_download_url_candidates,
                ) as fallback:
                    self.assertEqual(
                        updater._download_url_candidates("https://example/a"),
                        expected,
                    )
                    fallback.assert_called_once()

    def test_missing_library_symbol_incompatible_abi_null_and_exception_fall_back(self):
        expected = updater._py_download_url_candidates(
            "https://example/a", "", False
        )
        scenarios = [
            (None, rust_backend._empty_capabilities(), None),
            (object(), rust_backend._empty_capabilities(), None),
        ]
        for library, capabilities, _ in scenarios:
            with self.subTest(library=library), patch.object(
                rust_backend, "_rust_lib", library
            ), patch.object(
                rust_backend, "_CAPABILITIES", capabilities
            ), patch.object(
                updater, "APP_UPDATE_DOWNLOAD_PROXY", ""
            ), patch.object(
                updater, "APP_UPDATE_DOWNLOAD_PROXY_FIRST", False
            ):
                self.assertEqual(updater._download_url_candidates("https://example/a"), expected)

        capabilities = rust_backend._empty_capabilities()
        with patch.object(rust_backend, "_rust_lib", None), patch.object(
            rust_backend, "_CAPABILITIES", capabilities
        ), patch.object(rust_backend, "_ABI_COMPATIBLE", False):
            self.assertEqual(updater._download_url_candidates("https://example/a"), expected)

        class NullLibrary:
            rust_plan_update_download_candidates = staticmethod(lambda _payload: None)

        capabilities["plan_update_download_candidates"] = True
        with patch.object(rust_backend, "_rust_lib", NullLibrary()), patch.object(
            rust_backend, "_CAPABILITIES", capabilities
        ):
            self.assertEqual(updater._download_url_candidates("https://example/a"), expected)

        class RaisingLibrary:
            rust_plan_update_download_candidates = staticmethod(
                lambda _payload: (_ for _ in ()).throw(RuntimeError("native failure"))
            )

        with patch.object(rust_backend, "_rust_lib", RaisingLibrary()), patch.object(
            rust_backend, "_CAPABILITIES", capabilities
        ):
            self.assertEqual(updater._download_url_candidates("https://example/a"), expected)

    def test_capability_isolation(self):
        capabilities = rust_backend._empty_capabilities()
        capabilities["select_update_asset"] = True
        with patch.object(rust_backend, "_rust_lib", object()), patch.object(
            rust_backend, "_CAPABILITIES", capabilities
        ):
            self.assertEqual(updater._download_url_candidates("https://example/a"), ["https://example/a"])
            self.assertTrue(rust_backend._CAPABILITIES["select_update_asset"])
            self.assertFalse(rust_backend._CAPABILITIES["plan_update_download_candidates"])

    def test_every_public_updater_helper_uses_its_complete_reference_on_failure(self):
        with patch.object(
            rust_backend,
            "try_plan_update_download_candidates",
            return_value=(False, None),
        ), patch.object(
            updater,
            "_py_dedupe_urls",
            wraps=updater._py_dedupe_urls,
        ) as dedupe_fallback, patch.object(
            updater,
            "_py_latest_release_api_urls",
            wraps=updater._py_latest_release_api_urls,
        ) as latest_fallback, patch.object(
            updater,
            "_py_release_list_api_urls",
            wraps=updater._py_release_list_api_urls,
        ) as list_fallback, patch.object(
            updater,
            "_py_download_url_candidates",
            wraps=updater._py_download_url_candidates,
        ) as download_fallback:
            self.assertEqual(
                updater._dedupe_urls([" a ", "a", "b"]),
                ["a", "b"],
            )
            self.assertTrue(updater._latest_release_api_urls())
            self.assertTrue(updater._release_list_api_urls())
            self.assertEqual(
                updater._download_url_candidates("https://example/a"),
                ["https://example/a"],
            )

        self.assertGreaterEqual(dedupe_fallback.call_count, 1)
        latest_fallback.assert_called_once()
        list_fallback.assert_called_once()
        download_fallback.assert_called_once()


class UpdateDownloadCandidatePlanningNativeEquivalenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        status = rust_backend.backend_status()
        available = status["loaded"] and status["capabilities"].get(
            "plan_update_download_candidates", False
        )
        if available:
            return
        if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
            raise AssertionError(
                "BILIKARA_REQUIRE_RUST_LIB=1 but native update download planning "
                f"is unavailable: {status}"
            )
        raise unittest.SkipTest("native update download planning is unavailable")

    def assert_equivalent(self, payload: dict[str, object]):
        validated = rust_backend._update_download_plan_request(payload)
        self.assertIsNotNone(validated)
        candidates, proxy = validated
        expected = updater._py_plan_update_download_candidates(
            candidates,
            proxy=str(proxy["template"]) if proxy is not None else None,
            proxy_first=bool(proxy["proxy_first"]) if proxy is not None else False,
        )
        completed, response = rust_backend.try_plan_update_download_candidates(payload)
        self.assertTrue(completed)
        self.assertIsNotNone(response)
        self.assertEqual(response["candidates"], expected)
        self.assertEqual(response["status"], "planned" if expected else "empty")

    def test_fixed_fixtures(self):
        fixtures = [
            request([]),
            request(["https://example/a"]),
            request([" ", "https://example/a", "https://example/a"]),
            request(
                ["https://primary", "https://mirror-b", "https://mirror-a"],
                ["primary", "mirror", "derived_mirror"],
            ),
            request(
                ["https://例子.test/歌曲.zip", "https://example/%E6%AD%8C.zip"],
                ["primary", "mirror"],
                proxy="https://proxy/{url_encoded}",
                proxy_first=True,
            ),
        ]
        for payload in fixtures:
            with self.subTest(payload=payload):
                self.assert_equivalent(payload)

    def test_generated_direct_mirror_proxy_combinations(self):
        url_sets = [
            [],
            ["https://primary"],
            ["https://primary", "https://mirror"],
            [" https://same ", "https://same", "", "https://other"],
            ["https://例子.test/歌", "https://example/%E6%AD%8C"],
        ]
        proxies = [None, "", "{url}", "https://proxy/{url}", "https://proxy/{url_encoded}", "https://proxy="]
        for urls in url_sets:
            sources = ["primary", *("mirror" for _ in urls[1:])]
            for proxy in proxies:
                for proxy_first in (False, True):
                    payload = request(
                        urls,
                        sources,
                        proxy=proxy,
                        proxy_first=proxy_first,
                    )
                    with self.subTest(urls=urls, proxy=proxy, proxy_first=proxy_first):
                        self.assert_equivalent(payload)


if __name__ == "__main__":
    unittest.main()
