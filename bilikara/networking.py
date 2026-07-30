from __future__ import annotations

import ctypes
import ipaddress
import json
import os
import socket
import subprocess
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterable

ROUTE_PROBE_TARGETS = (("1.1.1.1", 80), ("8.8.8.8", 80), ("9.9.9.9", 80))
IFF_UP = 0x1

MACOS_VIRTUAL_PREFIXES = (
    "lo",
    "utun",
    "bridge",
    "awdl",
    "llw",
    "ap",
    "gif",
    "stf",
    "p2p",
    "vmnet",
    "vnic",
)
LINUX_VIRTUAL_PREFIXES = (
    "lo",
    "docker",
    "veth",
    "virbr",
    "br-",
    "tun",
    "tap",
    "wg",
    "tailscale",
    "zt",
    "cni",
    "flannel",
    "kube",
    "podman",
)
WINDOWS_VIRTUAL_KEYWORDS = (
    "hyper-v",
    "vethernet",
    "vmware",
    "virtualbox",
    "wsl",
    "docker",
    "tailscale",
    "zerotier",
    "vpn",
    "tunnel",
    "wintun",
    "loopback",
)


@dataclass(frozen=True)
class InterfaceAddress:
    name: str
    address: str
    is_up: bool | None = None
    has_default_route: bool = False
    interface_type: str = "unknown"
    description: str = ""


def _valid_ipv4(value: object) -> ipaddress.IPv4Address | None:
    try:
        address = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        return None
    if not isinstance(address, ipaddress.IPv4Address):
        return None
    if address.is_loopback or address.is_unspecified or address.is_multicast:
        return None
    return address


def _is_virtual_interface(candidate: InterfaceAddress, platform_name: str) -> bool:
    name = candidate.name.casefold()
    description = candidate.description.casefold()
    interface_type = candidate.interface_type.casefold()
    if interface_type in {"virtual", "tunnel", "loopback", "container"}:
        return True
    if platform_name == "darwin":
        return name.startswith(MACOS_VIRTUAL_PREFIXES)
    if platform_name.startswith("linux"):
        return name.startswith(LINUX_VIRTUAL_PREFIXES)
    if platform_name.startswith("win"):
        labels = f"{name} {description}"
        return any(keyword in labels for keyword in WINDOWS_VIRTUAL_KEYWORDS)
    return False


def _interface_score(
    candidate: InterfaceAddress,
    address: ipaddress.IPv4Address,
    *,
    route_sources: set[str],
    platform_name: str,
) -> int:
    score = 0
    if str(address) in route_sources:
        score += 10_000
    if candidate.has_default_route:
        score += 1_500
    if candidate.is_up is True:
        score += 500
    elif candidate.is_up is False:
        score -= 4_000
    if address.is_private:
        score += 600
    else:
        score += 150
    if address.is_link_local:
        score -= 2_500
    if _is_virtual_interface(candidate, platform_name):
        # A route-selected VPN/container link is still less useful for a phone
        # on the LAN when an active physical address is available.
        score -= 12_000
    else:
        score += 800
    name = candidate.name.casefold()
    if platform_name == "darwin" and name.startswith("en"):
        score += 500
    elif platform_name.startswith("linux") and name.startswith(
        ("eth", "en", "wlan", "wl")
    ):
        score += 500
    if candidate.interface_type.casefold() in {"ethernet", "wifi", "physical"}:
        score += 500
    return score


def rank_lan_ipv4_candidates(
    candidates: Iterable[InterfaceAddress],
    *,
    route_sources: Iterable[str] = (),
    platform_name: str | None = None,
) -> list[str]:
    """Rank usable addresses while keeping virtual links as last-resort paths."""

    platform_key = (platform_name or sys.platform).casefold()
    route_set = {
        str(address)
        for value in route_sources
        if (address := _valid_ipv4(value)) is not None
    }
    unique: dict[str, InterfaceAddress] = {}
    for candidate in candidates:
        address = _valid_ipv4(candidate.address)
        if address is None:
            continue
        normalized = str(address)
        existing = unique.get(normalized)
        if existing is None or (
            candidate.is_up is True and existing.is_up is not True
        ):
            unique[normalized] = replace(candidate, address=normalized)

    values = [value for value in unique.values() if value.is_up is not False]
    if any(not _valid_ipv4(value.address).is_link_local for value in values):
        values = [
            value for value in values if not _valid_ipv4(value.address).is_link_local
        ]
    values.sort(
        key=lambda value: (
            -_interface_score(
                value,
                _valid_ipv4(value.address),
                route_sources=route_set,
                platform_name=platform_key,
            ),
            value.name.casefold(),
            int(_valid_ipv4(value.address)),
        )
    )
    if not values:
        return []

    recommended = values[0]
    physical = [
        value
        for value in values
        if not _is_virtual_interface(value, platform_key) and value.is_up is not False
    ]
    if physical and _is_virtual_interface(recommended, platform_key):
        visible = [recommended, *physical]
    elif physical:
        visible = physical
    else:
        visible = [recommended]
    return list(dict.fromkeys(value.address for value in visible))


def route_selected_ipv4s(
    targets: Iterable[tuple[str, int]] = ROUTE_PROBE_TARGETS,
) -> list[str]:
    selected: list[str] = []
    for target in targets:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(target)
                address = sock.getsockname()[0]
        except OSError:
            continue
        if _valid_ipv4(address) is not None and address not in selected:
            selected.append(address)
    return selected


class _SockaddrLinux(ctypes.Structure):
    _fields_ = [("family", ctypes.c_ushort), ("data", ctypes.c_ubyte * 14)]


class _SockaddrDarwin(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ubyte), ("family", ctypes.c_ubyte), ("data", ctypes.c_ubyte * 14)]


class _SockaddrIn(ctypes.Structure):
    _fields_ = [
        ("family", ctypes.c_ushort),
        ("port", ctypes.c_ushort),
        ("address", ctypes.c_ubyte * 4),
        ("padding", ctypes.c_ubyte * 8),
    ]


class _SockaddrInDarwin(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_ubyte),
        ("family", ctypes.c_ubyte),
        ("port", ctypes.c_ushort),
        ("address", ctypes.c_ubyte * 4),
        ("padding", ctypes.c_ubyte * 8),
    ]


class _Ifaddrs(ctypes.Structure):
    pass


_Ifaddrs._fields_ = [
    ("next", ctypes.POINTER(_Ifaddrs)),
    ("name", ctypes.c_char_p),
    ("flags", ctypes.c_uint),
    ("address", ctypes.c_void_p),
    ("netmask", ctypes.c_void_p),
    ("ifu", ctypes.c_void_p),
    ("data", ctypes.c_void_p),
]


def _linux_default_route_interfaces(path: Path = Path("/proc/net/route")) -> set[str]:
    try:
        lines = path.read_text(encoding="ascii", errors="replace").splitlines()[1:]
    except OSError:
        return set()
    interfaces: set[str] = set()
    for line in lines:
        fields = line.split()
        if len(fields) >= 4 and fields[1] == "00000000":
            try:
                flags = int(fields[3], 16)
            except ValueError:
                continue
            if flags & 0x1:
                interfaces.add(fields[0])
    return interfaces


def enumerate_posix_ipv4_interfaces(
    *, platform_name: str | None = None
) -> list[InterfaceAddress]:
    platform_key = (platform_name or sys.platform).casefold()
    try:
        libc = ctypes.CDLL(None)
        getifaddrs = libc.getifaddrs
        freeifaddrs = libc.freeifaddrs
    except (AttributeError, OSError):
        return []
    head = ctypes.POINTER(_Ifaddrs)()
    getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(_Ifaddrs))]
    getifaddrs.restype = ctypes.c_int
    freeifaddrs.argtypes = [ctypes.POINTER(_Ifaddrs)]
    if getifaddrs(ctypes.byref(head)) != 0:
        return []
    defaults = _linux_default_route_interfaces() if platform_key.startswith("linux") else set()
    candidates: list[InterfaceAddress] = []
    try:
        current = head
        while current:
            entry = current.contents
            if entry.address:
                if platform_key == "darwin":
                    family = ctypes.cast(
                        entry.address, ctypes.POINTER(_SockaddrDarwin)
                    ).contents.family
                else:
                    family = ctypes.cast(
                        entry.address, ctypes.POINTER(_SockaddrLinux)
                    ).contents.family
                if family == socket.AF_INET:
                    structure = _SockaddrInDarwin if platform_key == "darwin" else _SockaddrIn
                    sockaddr = ctypes.cast(
                        entry.address, ctypes.POINTER(structure)
                    ).contents
                    address = socket.inet_ntoa(bytes(sockaddr.address))
                    name = entry.name.decode("utf-8", errors="replace") if entry.name else ""
                    candidates.append(
                        InterfaceAddress(
                            name=name,
                            address=address,
                            is_up=bool(entry.flags & IFF_UP),
                            has_default_route=name in defaults,
                        )
                    )
            current = entry.next
    finally:
        freeifaddrs(head)
    return candidates


def _windows_adapter_payload() -> object:
    command = (
        "Get-NetIPConfiguration | ForEach-Object { "
        "$a = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; "
        "[PSCustomObject]@{ InterfaceAlias=$_.InterfaceAlias; "
        "InterfaceDescription=$_.InterfaceDescription; "
        "InterfaceIndex=$_.InterfaceIndex; IPv4Address=$_.IPv4Address; "
        "IPv4DefaultGateway=$_.IPv4DefaultGateway; Status=$a.Status; "
        "HardwareInterface=$a.HardwareInterface; Virtual=$a.Virtual; "
        "NdisPhysicalMedium=$a.NdisPhysicalMedium } } | "
        "ConvertTo-Json -Depth 6 -Compress"
    )
    try:
        process = subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
            timeout=8,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if process.returncode != 0 or not (process.stdout or "").strip():
        return []
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError:
        return []


def enumerate_windows_ipv4_interfaces(payload: object | None = None) -> list[InterfaceAddress]:
    raw = _windows_adapter_payload() if payload is None else payload
    configs = raw if isinstance(raw, list) else [raw]
    candidates: list[InterfaceAddress] = []
    for config in configs:
        if not isinstance(config, dict):
            continue
        alias = str(config.get("InterfaceAlias") or "")
        description = str(config.get("InterfaceDescription") or "")
        status = str(config.get("Status") or "").casefold()
        hardware = config.get("HardwareInterface")
        virtual = config.get("Virtual")
        medium = str(config.get("NdisPhysicalMedium") or "").casefold()
        structured_virtual = virtual is True or hardware is False
        structured_physical = hardware is True and virtual is not True
        gateways = config.get("IPv4DefaultGateway")
        gateway_values = gateways if isinstance(gateways, list) else [gateways] if gateways else []
        has_gateway = any(
            isinstance(value, dict) and value.get("NextHop") for value in gateway_values
        )
        addresses = config.get("IPv4Address")
        address_values = addresses if isinstance(addresses, list) else [addresses] if addresses else []
        for value in address_values:
            if not isinstance(value, dict):
                continue
            address = str(value.get("IPAddress") or "").strip()
            if _valid_ipv4(address) is None:
                continue
            candidates.append(
                InterfaceAddress(
                    name=alias,
                    description=description,
                    address=address,
                    is_up=status == "up" if status else True,
                    has_default_route=has_gateway,
                    interface_type=(
                        "virtual"
                        if structured_virtual
                        or any(
                            keyword in f"{alias} {description}".casefold()
                            for keyword in WINDOWS_VIRTUAL_KEYWORDS
                        )
                        else (
                            "physical"
                            if structured_physical
                            or medium in {"802.3", "native 802.11", "wireless lan"}
                            else "unknown"
                        )
                    ),
                )
            )
    return candidates


def detect_lan_ipv4_addresses(*, platform_name: str | None = None) -> list[str]:
    platform_key = (platform_name or sys.platform).casefold()
    route_sources = route_selected_ipv4s()
    if platform_key.startswith("win") or os.name == "nt":
        candidates = enumerate_windows_ipv4_interfaces()
    else:
        candidates = enumerate_posix_ipv4_interfaces(platform_name=platform_key)
    known = {candidate.address for candidate in candidates}
    candidates.extend(
        InterfaceAddress(
            name="route-selected",
            address=address,
            is_up=True,
            has_default_route=True,
            interface_type="unknown",
        )
        for address in route_sources
        if address not in known
    )
    return rank_lan_ipv4_candidates(
        candidates,
        route_sources=route_sources,
        platform_name=platform_key,
    )
