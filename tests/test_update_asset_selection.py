from __future__ import annotations

import ctypes
import json
import os
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator
from unittest.mock import patch

from bilikara import rust_backend, updater


TARGET_WINDOWS_X64 = {"platform": "windows", "arch": "x64"}
TARGET_WINDOWS_ARM64 = {"platform": "windows", "arch": "arm64"}
TARGET_MACOS_X64 = {"platform": "macos", "arch": "x64"}
TARGET_MACOS_ARM64 = {"platform": "macos", "arch": "arm64"}


class FakeFunction:
    def __init__(self, result: int | None = None) -> None:
        self.result = result

    def __call__(self, *args: object) -> int | None:
        return self.result


def _asset(
    name: str,
    *,
    url: str | None = None,
    label: object = "",
    content_type: object = "application/zip",
    size: object = 100,
    **extra: object,
) -> dict[str, object]:
    return {
        "name": name,
        "label": label,
        "browser_download_url": url
        if url is not None
        else f"https://example.test/{name}",
        "content_type": content_type,
        "size": size,
        **extra,
    }


def _native_request(
    release: dict[str, Any],
    target: dict[str, str],
) -> dict[str, object]:
    assets = release.get("assets")
    normalized_assets: list[dict[str, object]] = []
    if isinstance(assets, list):
        for original_index, asset in enumerate(assets):
            if not isinstance(asset, dict):
                continue
            normalized_assets.append(
                {
                    "original_index": original_index,
                    "name": str(asset.get("name") or ""),
                    "label": str(asset.get("label") or ""),
                    "browser_download_url": str(
                        asset.get("browser_download_url") or ""
                    ),
                    "content_type": str(asset.get("content_type") or ""),
                }
            )
    return {
        "schema_version": 1,
        "target": {
            "platform": str(target.get("platform") or ""),
            "arch": str(target.get("arch") or ""),
        },
        "assets": normalized_assets,
    }


class UpdateAssetSelectionRustTest(unittest.TestCase):
    def test_direct_rust_selection_returns_selected_index_and_score_vector(self) -> None:
        self._require_native_selection()
        release = {
            "assets": [
                _asset("bilikara-windows-arm64.zip"),
                _asset("bilikara-windows-x64.zip", size=1),
                _asset("bilikara-macos-x64.zip"),
            ]
        }
        request = _native_request(release, TARGET_WINDOWS_X64)

        completed, response = rust_backend.try_select_update_asset(request)

        self.assertTrue(completed)
        self.assertIsNotNone(response)
        assert response is not None
        self.assertEqual(response["schema_version"], 1)
        self.assertEqual(response["status"], "selected")
        self.assertEqual(response["selected_index"], 1)
        self.assertEqual(
            response["scores"],
            [
                {"original_index": 0, "score": -1},
                {"original_index": 1, "score": 140},
                {"original_index": 2, "score": -1},
            ],
        )

    def test_direct_rust_no_match_is_success_not_backend_failure(self) -> None:
        self._require_native_selection()
        release = {
            "assets": [
                _asset("bilikara-linux-x64.zip"),
                _asset("bilikara-windows-arm64.zip"),
            ]
        }

        completed, response = rust_backend.try_select_update_asset(
            _native_request(release, TARGET_WINDOWS_X64)
        )

        self.assertTrue(completed)
        self.assertIsNotNone(response)
        assert response is not None
        self.assertEqual(response["status"], "no_match")
        self.assertIsNone(response["selected_index"])
        self.assertEqual(
            response["scores"],
            [
                {"original_index": 0, "score": -1},
                {"original_index": 1, "score": -1},
            ],
        )

    def test_public_wrapper_uses_completed_rust_selection_without_fallback(self) -> None:
        self._require_native_selection()
        release = {"assets": [_asset("bilikara-windows-x64.zip", size="42")]}

        with patch.object(
            updater,
            "_py_select_update_asset",
            side_effect=AssertionError("Python fallback was called"),
        ):
            selected = updater.select_update_asset(release, target=TARGET_WINDOWS_X64)

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected["name"], "bilikara-windows-x64.zip")
        self.assertEqual(selected["size"], 42)

        with patch.object(
            updater,
            "_py_score_asset_for_target",
            side_effect=AssertionError("Python score fallback was called"),
        ):
            self.assertEqual(
                updater._score_asset_for_target(
                    release["assets"][0],
                    TARGET_WINDOWS_X64,
                ),
                140,
            )

    def test_public_wrapper_uses_completed_rust_no_match_without_fallback(self) -> None:
        self._require_native_selection()
        release = {"assets": [_asset("bilikara-linux-x64.zip")]}

        with patch.object(
            updater,
            "_py_select_update_asset",
            side_effect=AssertionError("Python fallback was called"),
        ):
            selected = updater.select_update_asset(release, target=TARGET_WINDOWS_X64)

        self.assertIsNone(selected)

    def test_golden_selection_matrix_matches_python_reference(self) -> None:
        cases: list[
            tuple[str, dict[str, str], list[object], str | None]
        ] = [
            (
                "windows x64",
                TARGET_WINDOWS_X64,
                [
                    _asset("bilikara-windows-arm64.zip"),
                    _asset("bilikara-windows-x64.zip"),
                ],
                "bilikara-windows-x64.zip",
            ),
            (
                "windows arm64",
                TARGET_WINDOWS_ARM64,
                [
                    _asset("bilikara-windows-x64.zip"),
                    _asset("bilikara-windows-arm64.zip"),
                ],
                "bilikara-windows-arm64.zip",
            ),
            (
                "macos x64",
                TARGET_MACOS_X64,
                [
                    _asset("bilikara-macos-arm64.zip"),
                    _asset("bilikara-macos-universal2.zip"),
                    _asset("bilikara-macos-x64.zip"),
                ],
                "bilikara-macos-x64.zip",
            ),
            (
                "macos arm64",
                TARGET_MACOS_ARM64,
                [
                    _asset("bilikara-macos-x64.zip"),
                    _asset("bilikara-macos-universal2.zip"),
                    _asset("bilikara-macos-arm64.zip"),
                ],
                "bilikara-macos-arm64.zip",
            ),
            (
                "macos universal",
                TARGET_MACOS_ARM64,
                [
                    _asset("bilikara-macos.zip"),
                    _asset("bilikara-macos-universal2.zip"),
                ],
                "bilikara-macos-universal2.zip",
            ),
            (
                "macos generic architecture",
                TARGET_MACOS_X64,
                [_asset("bilikara-macos.zip")],
                "bilikara-macos.zip",
            ),
            (
                "wrong platform",
                TARGET_WINDOWS_X64,
                [_asset("bilikara-macos-x64.zip")],
                None,
            ),
            (
                "wrong architecture",
                TARGET_WINDOWS_ARM64,
                [_asset("bilikara-windows-x64.zip")],
                None,
            ),
            (
                "checksum signature and text",
                TARGET_WINDOWS_X64,
                [
                    _asset("bilikara-windows-x64.zip.sha256"),
                    _asset("bilikara-windows-x64.zip.sha256sum"),
                    _asset("bilikara-windows-x64.zip.sig"),
                    _asset("bilikara-windows-x64.zip.asc"),
                    _asset("bilikara-windows-x64.txt"),
                ],
                None,
            ),
            (
                "missing URL",
                TARGET_WINDOWS_X64,
                [_asset("bilikara-windows-x64.zip", url="")],
                None,
            ),
            (
                "ZIP URL with query",
                TARGET_WINDOWS_X64,
                [
                    _asset(
                        "bilikara-windows-x64",
                        url="https://example.test/download.zip?token=abc",
                    )
                ],
                "bilikara-windows-x64",
            ),
            (
                "duplicate equal score keeps earliest",
                TARGET_WINDOWS_X64,
                [
                    _asset("first-windows-x64.zip", size=1),
                    _asset("second-windows-x64.zip", size=999999),
                ],
                "first-windows-x64.zip",
            ),
            (
                "unexpected fields ignored",
                TARGET_WINDOWS_X64,
                [
                    _asset(
                        "bilikara-windows-x64.zip",
                        unexpected={"nested": [1, 2, 3]},
                    )
                ],
                "bilikara-windows-x64.zip",
            ),
            (
                "platform markers from label",
                TARGET_WINDOWS_X64,
                [_asset("bilikara.zip", label="windows x64")],
                "bilikara.zip",
            ),
            (
                "platform markers from content type",
                TARGET_MACOS_ARM64,
                [
                    _asset(
                        "bilikara.zip",
                        content_type="application/bilikara-macos-arm64",
                    )
                ],
                "bilikara.zip",
            ),
            ("empty assets", TARGET_WINDOWS_X64, [], None),
            (
                "non-dictionary entries retain original indexes",
                TARGET_WINDOWS_X64,
                [None, "ignored", _asset("bilikara-windows-x64.zip")],
                "bilikara-windows-x64.zip",
            ),
            (
                "Unicode and NUL are deterministic token delimiters",
                TARGET_WINDOWS_X64,
                [_asset("歌曲-\x00windows-x64.zip")],
                "歌曲-\x00windows-x64.zip",
            ),
        ]

        native_available = self._native_selection_available()
        for label, target, assets, expected_name in cases:
            with self.subTest(case=label):
                release = {"assets": assets}
                python_result = updater._py_select_update_asset(release, target=target)
                public_result = updater.select_update_asset(release, target=target)
                self.assertEqual(public_result, python_result)
                self.assertEqual(
                    None if python_result is None else python_result["name"],
                    expected_name,
                )

                if native_available:
                    request = _native_request(release, target)
                    completed, native_response = rust_backend.try_select_update_asset(
                        request
                    )
                    self.assertTrue(completed)
                    self.assertIsNotNone(native_response)
                    assert native_response is not None
                    expected_scores = [
                        {
                            "original_index": item["original_index"],
                            "score": updater._py_score_asset_for_target(
                                assets[item["original_index"]], target
                            ),
                        }
                        for item in request["assets"]
                    ]
                    for score in expected_scores:
                        original_index = score["original_index"]
                        self.assertEqual(
                            updater._score_asset_for_target(
                                assets[original_index], target
                            ),
                            score["score"],
                        )
                    self.assertEqual(native_response["scores"], expected_scores)
                    expected_index = None
                    if python_result is not None:
                        expected_index = next(
                            index
                            for index, asset in enumerate(assets)
                            if isinstance(asset, dict)
                            and str(asset.get("name") or "")
                            == python_result["name"]
                            and str(asset.get("browser_download_url") or "")
                            == python_result["browser_download_url"]
                        )
                    self.assertEqual(
                        native_response["selected_index"], expected_index
                    )

    def test_generated_native_score_matrix_matches_python_reference(self) -> None:
        self._require_native_selection()
        names = [
            "bilikara-windows-x64.zip",
            "bilikara-windows-arm64.zip",
            "bilikara-win64.zip",
            "bilikara-macos-x64.zip",
            "bilikara-macos-arm64.zip",
            "bilikara-macos-universal2.zip",
            "bilikara-linux-x86_64.zip",
            "bilikara-windows-x64.zip.sha256",
            "bilikara-windows-x64.zip.asc",
            "歌曲-windows-x64.zip",
            "mixed-windows-macos-x64-arm64.zip",
        ]
        urls = [
            "https://example.test/download.zip",
            "https://example.test/download.zip?token=1",
            "https://example.test/download.tar.gz",
            "",
        ]
        targets = [
            {"platform": platform, "arch": arch}
            for platform in ("windows", "macos", "linux", "unknown", "")
            for arch in ("x64", "amd64", "arm64", "x86", "unknown")
        ]

        checked = 0
        for name in names:
            for url in urls:
                asset = _asset(name, url=url)
                for target in targets:
                    with self.subTest(name=name, url=url, target=target):
                        completed, response = rust_backend.try_select_update_asset(
                            _native_request({"assets": [asset]}, target)
                        )
                        self.assertTrue(completed)
                        self.assertIsNotNone(response)
                        assert response is not None
                        self.assertEqual(
                            response["scores"][0]["score"],
                            updater._py_score_asset_for_target(asset, target),
                        )
                        checked += 1
        self.assertEqual(checked, 1_100)

    def test_asset_size_does_not_affect_equal_score_tie_breaking(self) -> None:
        target = TARGET_WINDOWS_X64
        small_first = {
            "assets": [
                _asset("first-windows-x64.zip", size=1),
                _asset("second-windows-x64.zip", size=10_000_000),
            ]
        }
        large_first = {
            "assets": [
                _asset("first-windows-x64.zip", size=10_000_000),
                _asset("second-windows-x64.zip", size=1),
            ]
        }

        self.assertEqual(
            updater._py_select_update_asset(small_first, target=target)["name"],
            "first-windows-x64.zip",
        )
        self.assertEqual(
            updater.select_update_asset(small_first, target=target)["name"],
            "first-windows-x64.zip",
        )
        self.assertEqual(
            updater.select_update_asset(large_first, target=target)["name"],
            "first-windows-x64.zip",
        )

        for size, expected_size in [
            (-10, 0),
            ("invalid", 0),
            (10**100, 10**100),
        ]:
            with self.subTest(size=size):
                release = {
                    "assets": [_asset("first-windows-x64.zip", size=size)]
                }
                python_result = updater._py_select_update_asset(
                    release,
                    target=target,
                )
                public_result = updater.select_update_asset(release, target=target)
                self.assertEqual(public_result, python_result)
                assert public_result is not None
                self.assertEqual(public_result["size"], expected_size)

    def test_no_library_missing_symbol_and_partial_legacy_library_fall_back(self) -> None:
        release = {"assets": [_asset("bilikara-windows-x64.zip")]}
        expected = updater._py_select_update_asset(
            release, target=TARGET_WINDOWS_X64
        )

        scenarios: list[tuple[str, object | None, dict[str, bool]]] = [
            ("no library", None, rust_backend._empty_capabilities()),
            (
                "missing selection symbol",
                SimpleNamespace(rust_free_string=FakeFunction()),
                rust_backend._empty_capabilities(),
            ),
            (
                "partial legacy library",
                SimpleNamespace(
                    rust_free_string=FakeFunction(),
                    rust_clean_display_title=FakeFunction(),
                ),
                {
                    **rust_backend._empty_capabilities(),
                    "title_cleanup": True,
                },
            ),
        ]
        for label, library, capabilities in scenarios:
            with self.subTest(case=label), patch(
                "bilikara.rust_backend._rust_lib", library
            ), patch(
                "bilikara.rust_backend._CAPABILITIES", capabilities
            ):
                self.assertEqual(
                    rust_backend.try_select_update_asset(
                        _native_request(release, TARGET_WINDOWS_X64)
                    ),
                    (False, None),
                )
                self.assertEqual(
                    updater.select_update_asset(
                        release, target=TARGET_WINDOWS_X64
                    ),
                    expected,
                )

    def test_incompatible_abi_uses_python_fallback(self) -> None:
        release = {"assets": [_asset("bilikara-windows-x64.zip")]}
        expected = updater._py_select_update_asset(
            release, target=TARGET_WINDOWS_X64
        )
        with patch("bilikara.rust_backend._rust_lib", None), patch(
            "bilikara.rust_backend._CAPABILITIES",
            rust_backend._empty_capabilities(),
        ), patch("bilikara.rust_backend._ABI_VERSION", 2), patch(
            "bilikara.rust_backend._ABI_COMPATIBLE", False
        ):
            self.assertEqual(
                updater.select_update_asset(release, target=TARGET_WINDOWS_X64),
                expected,
            )

    def test_backend_failure_uses_python_fallback(self) -> None:
        release = {"assets": [_asset("bilikara-windows-x64.zip")]}
        expected = updater._py_select_update_asset(
            release, target=TARGET_WINDOWS_X64
        )
        with patch(
            "bilikara.updater.rust_backend.try_select_update_asset",
            return_value=(False, None),
        ):
            self.assertEqual(
                updater.select_update_asset(release, target=TARGET_WINDOWS_X64),
                expected,
            )

    def test_null_malformed_and_invalid_native_responses_use_python_fallback(self) -> None:
        release = {"assets": [_asset("bilikara-windows-x64.zip")]}
        request = _native_request(release, TARGET_WINDOWS_X64)
        expected = updater._py_select_update_asset(
            release, target=TARGET_WINDOWS_X64
        )
        invalid_payloads: list[tuple[str, str | None]] = [
            ("null", None),
            ("malformed JSON", "{"),
            (
                "wrong schema",
                json.dumps(
                    {
                        "schema_version": 2,
                        "status": "selected",
                        "selected_index": 0,
                        "scores": [{"original_index": 0, "score": 140}],
                    }
                ),
            ),
            (
                "selected index outside request",
                json.dumps(
                    {
                        "schema_version": 1,
                        "status": "selected",
                        "selected_index": 99,
                        "scores": [{"original_index": 0, "score": 140}],
                    }
                ),
            ),
            (
                "invalid status",
                json.dumps(
                    {
                        "schema_version": 1,
                        "status": "maybe",
                        "selected_index": None,
                        "scores": [{"original_index": 0, "score": -1}],
                    }
                ),
            ),
            (
                "incomplete scores",
                json.dumps(
                    {
                        "schema_version": 1,
                        "status": "selected",
                        "selected_index": 0,
                        "scores": [],
                    }
                ),
            ),
        ]
        for label, payload in invalid_payloads:
            with self.subTest(case=label), self._fake_native_payload(payload):
                self.assertEqual(
                    rust_backend.try_select_update_asset(request),
                    (False, None),
                )
                self.assertEqual(
                    updater.select_update_asset(
                        release, target=TARGET_WINDOWS_X64
                    ),
                    expected,
                )

    def test_response_validation_rejects_late_equal_score_selection(self) -> None:
        release = {
            "assets": [
                _asset("first-windows-x64.zip"),
                _asset("second-windows-x64.zip"),
            ]
        }
        request = _native_request(release, TARGET_WINDOWS_X64)
        invalid_response = json.dumps(
            {
                "schema_version": 1,
                "status": "selected",
                "selected_index": 1,
                "scores": [
                    {"original_index": 0, "score": 140},
                    {"original_index": 1, "score": 140},
                ],
            }
        )

        with self._fake_native_payload(invalid_response):
            self.assertEqual(
                rust_backend.try_select_update_asset(request),
                (False, None),
            )
            self.assertEqual(
                updater.select_update_asset(release, target=TARGET_WINDOWS_X64),
                updater._py_select_update_asset(
                    release,
                    target=TARGET_WINDOWS_X64,
                ),
            )

    def test_check_for_update_keeps_selected_asset_shape(self) -> None:
        release = {
            "tag_name": "v9.0.0",
            "html_url": "https://example.test/releases/v9.0.0",
            "assets": [
                _asset(
                    "bilikara-windows-x64.zip",
                    size="12345",
                    content_type="application/zip",
                )
            ],
        }
        with patch.object(
            updater, "detect_update_target", return_value=TARGET_WINDOWS_X64
        ), patch.object(updater, "is_auto_update_supported", return_value=True):
            result = updater.check_for_update(
                current_version="v1.0.0",
                release_fetcher=lambda: release,
            )

        self.assertEqual(
            result["update_asset"],
            {
                "name": "bilikara-windows-x64.zip",
                "browser_download_url": (
                    "https://example.test/bilikara-windows-x64.zip"
                ),
                "size": 12345,
                "content_type": "application/zip",
                "platform": "windows",
                "arch": "x64",
            },
        )
        self.assertTrue(result["auto_update_supported"])

    @staticmethod
    def _native_selection_available() -> bool:
        status = rust_backend.backend_status()
        available = bool(
            Path(str(status["path"])).is_file()
            and status["capabilities"].get("select_update_asset", False)
        )
        if not available and os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
            raise AssertionError(
                "BILIKARA_REQUIRE_RUST_LIB=1 but native select_update_asset is unavailable"
            )
        return available

    def _require_native_selection(self) -> None:
        status = rust_backend.backend_status()
        if not Path(str(status["path"])).is_file():
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail(
                    "BILIKARA_REQUIRE_RUST_LIB=1 but the Rust dynamic library is not compiled"
                )
            self.skipTest("Rust dynamic library is not compiled")
        if not status["capabilities"].get("select_update_asset", False):
            if os.environ.get("BILIKARA_REQUIRE_RUST_LIB") == "1":
                self.fail(
                    "BILIKARA_REQUIRE_RUST_LIB=1 but select_update_asset is unavailable"
                )
            self.skipTest("compiled Rust library has no update asset selection symbol")

    @staticmethod
    @contextmanager
    def _fake_native_payload(payload: str | None) -> Iterator[None]:
        buffer = None
        pointer = None
        if payload is not None:
            buffer = ctypes.create_string_buffer(payload.encode("utf-8"))
            pointer = ctypes.addressof(buffer)
        library = SimpleNamespace(
            rust_free_string=FakeFunction(),
            rust_select_update_asset=FakeFunction(pointer),
        )
        capabilities = rust_backend._configure_library(library)
        with patch("bilikara.rust_backend._rust_lib", library), patch(
            "bilikara.rust_backend._CAPABILITIES", capabilities
        ):
            yield
        # Keep the ctypes allocation alive until both calls have completed.
        _ = buffer
