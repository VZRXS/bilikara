from __future__ import annotations

import unittest
from unittest.mock import patch

from bilikara import networking
from bilikara.networking import InterfaceAddress, rank_lan_ipv4_candidates


def candidate(
    name: str,
    address: str,
    *,
    up: bool = True,
    default: bool = False,
    kind: str = "unknown",
    description: str = "",
) -> InterfaceAddress:
    return InterfaceAddress(
        name=name,
        address=address,
        is_up=up,
        has_default_route=default,
        interface_type=kind,
        description=description,
    )


class LanAddressRankingTest(unittest.TestCase):
    def test_macos_hotspot_prefers_route_selected_en0(self):
        values = [
            candidate("en0", "172.20.10.12"),
            candidate("bridge0", "192.168.3.1"),
            candidate("bridge100", "192.168.2.1"),
            candidate("utun0", "10.0.0.2"),
            candidate("utun7", "10.0.0.7"),
            candidate("awdl0", "169.254.10.2"),
            candidate("llw0", "169.254.10.3"),
        ]
        ranked = rank_lan_ipv4_candidates(
            values,
            route_sources=["172.20.10.12"],
            platform_name="darwin",
        )
        self.assertEqual(ranked, ["172.20.10.12"])

    def test_macos_active_en_variants_and_default_route(self):
        values = [
            candidate("en0", "192.168.1.10", up=False),
            candidate("en1", "192.168.1.11", default=True),
            candidate("en2", "192.168.1.12"),
        ]
        self.assertEqual(
            rank_lan_ipv4_candidates(
                values,
                route_sources=["192.168.1.11"],
                platform_name="darwin",
            ),
            ["192.168.1.11", "192.168.1.12"],
        )

    def test_linux_physical_names_beat_container_and_bridge_names(self):
        cases = (
            ("eth0", "docker0"),
            ("wlan0", "virbr0"),
            ("enp3s0", "br-123"),
            ("wlp2s0", "veth123"),
        )
        for physical, virtual in cases:
            with self.subTest(physical=physical, virtual=virtual):
                values = [
                    candidate(physical, "192.168.50.20", default=True),
                    candidate(virtual, "172.18.0.1"),
                ]
                self.assertEqual(
                    rank_lan_ipv4_candidates(
                        values,
                        route_sources=["192.168.50.20"],
                        platform_name="linux",
                    ),
                    ["192.168.50.20"],
                )

    def test_linux_fallback_without_default_route_and_tunnel_only(self):
        self.assertEqual(
            rank_lan_ipv4_candidates(
                [candidate("enp3s0", "10.10.0.5")], platform_name="linux"
            ),
            ["10.10.0.5"],
        )
        self.assertEqual(
            rank_lan_ipv4_candidates(
                [candidate("tun0", "10.8.0.2", kind="tunnel")],
                platform_name="linux",
            ),
            ["10.8.0.2"],
        )

    def test_windows_route_and_physical_adapter_ranking(self):
        values = [
            candidate(
                "vEthernet (WSL)",
                "172.28.32.1",
                kind="virtual",
                description="Hyper-V Virtual Ethernet Adapter",
            ),
            candidate("Ethernet", "192.168.31.8", kind="physical"),
            candidate("VPN", "10.8.0.2", kind="tunnel"),
        ]
        self.assertEqual(
            rank_lan_ipv4_candidates(
                values,
                route_sources=["192.168.31.8"],
                platform_name="win32",
            ),
            ["192.168.31.8"],
        )
        self.assertEqual(
            rank_lan_ipv4_candidates(
                [values[2]],
                route_sources=["10.8.0.2"],
                platform_name="win32",
            ),
            ["10.8.0.2"],
        )
        self.assertEqual(
            rank_lan_ipv4_candidates(
                values,
                route_sources=["10.8.0.2"],
                platform_name="win32",
            )[0],
            "192.168.31.8",
        )

    def test_windows_structured_payload_deprioritizes_virtual_adapters(self):
        payload = [
            {
                "InterfaceAlias": "vEthernet (Default Switch)",
                "InterfaceDescription": "Hyper-V Virtual Ethernet Adapter",
                "IPv4Address": [{"IPAddress": "172.28.32.1"}],
                "IPv4DefaultGateway": [],
                "Status": "Up",
                "HardwareInterface": False,
                "Virtual": True,
            },
            {
                "InterfaceAlias": "Wi-Fi",
                "InterfaceDescription": "Intel Adapter",
                "IPv4Address": [{"IPAddress": "192.168.31.8"}],
                "IPv4DefaultGateway": [{"NextHop": "192.168.31.1"}],
                "Status": "Up",
                "HardwareInterface": True,
                "Virtual": False,
                "NdisPhysicalMedium": "Native 802.11",
            },
        ]
        values = networking.enumerate_windows_ipv4_interfaces(payload)
        self.assertEqual(
            rank_lan_ipv4_candidates(
                values,
                route_sources=["192.168.31.8"],
                platform_name="win32",
            ),
            ["192.168.31.8"],
        )

    def test_general_validity_public_private_link_local_and_empty(self):
        values = [
            candidate("lo0", "127.0.0.1"),
            candidate("en0", "0.0.0.0"),
            candidate("en1", "224.0.0.1"),
            candidate("en2", "169.254.20.1"),
            candidate("en3", "8.8.4.4"),
            candidate("en4", "192.168.1.20"),
        ]
        ranked = rank_lan_ipv4_candidates(values, platform_name="darwin")
        self.assertEqual(ranked[0], "192.168.1.20")
        self.assertIn("8.8.4.4", ranked)
        self.assertNotIn("169.254.20.1", ranked)
        self.assertEqual(
            rank_lan_ipv4_candidates(
                [candidate("en0", "169.254.20.1")], platform_name="darwin"
            ),
            ["169.254.20.1"],
        )
        self.assertEqual(rank_lan_ipv4_candidates([], platform_name="linux"), [])
        self.assertEqual(
            rank_lan_ipv4_candidates(
                [candidate("en0", "192.168.1.20", up=False)],
                platform_name="darwin",
            ),
            [],
        )

    def test_detect_uses_route_source_then_structured_interfaces(self):
        values = [
            candidate("en0", "192.168.1.50"),
            candidate("bridge0", "192.168.2.1"),
        ]
        with patch.object(
            networking, "route_selected_ipv4s", return_value=["192.168.1.50"]
        ), patch.object(
            networking, "enumerate_posix_ipv4_interfaces", return_value=values
        ):
            self.assertEqual(
                networking.detect_lan_ipv4_addresses(platform_name="darwin"),
                ["192.168.1.50"],
            )


if __name__ == "__main__":
    unittest.main()
