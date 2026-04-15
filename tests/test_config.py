import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from bilikara import config


class ConfigPathTest(unittest.TestCase):
    def test_frozen_build_defaults_to_runtime_within_app_folder(self):
        with TemporaryDirectory() as temp_dir:
            fake_executable = Path(temp_dir) / "bilikara.exe"
            fake_executable.touch()
            expected_home = fake_executable.resolve().parent / "runtime"
            with patch.dict(os.environ, {}, clear=True):
                with patch.object(config.sys, "frozen", True, create=True):
                    with patch.object(config.sys, "executable", str(fake_executable)):
                        self.assertEqual(config._default_app_home(), expected_home)

    def test_windows_frozen_prefers_detected_lan_host(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(config.sys, "frozen", True, create=True):
                with patch.object(config.os, "name", "nt"):
                    with patch("bilikara.config._detect_windows_physical_host", return_value="192.168.31.8"):
                        self.assertEqual(config._default_host(), "192.168.31.8")

    def test_windows_frozen_falls_back_to_all_interfaces_when_detection_fails(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(config.sys, "frozen", True, create=True):
                with patch.object(config.os, "name", "nt"):
                    with patch("bilikara.config._detect_windows_physical_host", return_value=None):
                        with patch("bilikara.config._detect_windows_bind_host", return_value="0.0.0.0"):
                            self.assertEqual(config._default_host(), "0.0.0.0")

    def test_windows_frozen_falls_back_to_legacy_detection_when_physical_host_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(config.sys, "frozen", True, create=True):
                with patch.object(config.os, "name", "nt"):
                    with patch("bilikara.config._detect_windows_physical_host", return_value=None):
                        with patch("bilikara.config._detect_windows_bind_host", return_value="192.168.31.8"):
                            self.assertEqual(config._default_host(), "192.168.31.8")

    def test_env_host_override_wins_over_windows_strategy(self):
        with patch.dict(os.environ, {"BILIKARA_HOST": "0.0.0.0"}, clear=True):
            with patch.object(config.sys, "frozen", True, create=True):
                with patch.object(config.os, "name", "nt"):
                    with patch("bilikara.config._detect_windows_physical_host", return_value="192.168.31.8"):
                        self.assertEqual(config._default_host(), "0.0.0.0")

    def test_pick_windows_physical_host_prefers_non_virtual_adapter_with_gateway(self):
        payload = [
            {
                "InterfaceAlias": "vEthernet (WSL)",
                "InterfaceDescription": "Hyper-V Virtual Ethernet Adapter",
                "IPv4Address": [{"IPAddress": "172.18.0.1"}],
                "IPv4DefaultGateway": [],
            },
            {
                "InterfaceAlias": "Wi-Fi",
                "InterfaceDescription": "Intel Wi-Fi Adapter",
                "IPv4Address": [{"IPAddress": "192.168.31.8"}],
                "IPv4DefaultGateway": [{"NextHop": "192.168.31.1"}],
            },
        ]
        self.assertEqual(config._pick_windows_physical_host(payload), "192.168.31.8")

    def test_pick_windows_physical_host_returns_none_for_virtual_only_candidates(self):
        payload = [
            {
                "InterfaceAlias": "vEthernet (Default Switch)",
                "InterfaceDescription": "Hyper-V Virtual Ethernet Adapter",
                "IPv4Address": [{"IPAddress": "172.28.32.1"}],
                "IPv4DefaultGateway": [{"NextHop": "172.28.32.254"}],
            }
        ]
        self.assertIsNone(config._pick_windows_physical_host(payload))


if __name__ == "__main__":
    unittest.main()
