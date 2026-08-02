from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, TypeVar

from . import rust_backend

PLAYBACK_SELECTOR_MODES = ("python", "rust")
DEFAULT_PLAYBACK_SELECTOR_MODE = "rust"
PLAYBACK_RUST_CAPABILITIES = (
    "decide_audio_binding",
    "decide_quality_policy",
    "select_video_stream",
    "select_audio_stream",
    "select_preferred_audio_source",
    "plan_media_download_candidates",
    "apply_av_delay_action",
)

T = TypeVar("T")


class PlaybackCapabilityError(RuntimeError):
    """An explicitly selected playback backend could not make a decision."""

    def __init__(self, capability: str, detail: str = "") -> None:
        self.capability = capability
        message = f"Rust playback capability failed: {capability}"
        if detail:
            message = f"{message} ({detail})"
        super().__init__(message)


def rust_playback_availability() -> tuple[bool, str]:
    status = rust_backend.backend_status()
    capabilities = status.get("capabilities")
    if not isinstance(capabilities, dict):
        return False, "Rust backend status is invalid"
    missing = [
        capability
        for capability in PLAYBACK_RUST_CAPABILITIES
        if capabilities.get(capability) is not True
    ]
    if missing:
        detail = str(status.get("error") or "").strip()
        suffix = f"; {detail}" if detail else ""
        return False, f"missing playback capabilities: {', '.join(missing)}{suffix}"
    return True, ""


def validate_playback_selector_mode(mode: object) -> str:
    if not isinstance(mode, str) or mode not in PLAYBACK_SELECTOR_MODES:
        raise ValueError("playback selector mode must be python or rust")
    if mode == "rust":
        available, warning = rust_playback_availability()
        if not available:
            raise PlaybackCapabilityError("availability", warning)
    return mode


def normalize_persisted_playback_selector_mode(mode: object) -> tuple[str, str]:
    if mode not in PLAYBACK_SELECTOR_MODES:
        fallback_mode = DEFAULT_PLAYBACK_SELECTOR_MODE
        if fallback_mode == "rust":
            available, warning = rust_playback_availability()
            if not available:
                return (
                    "python",
                    f"invalid persisted playback selector mode {mode!r}; using python ({warning})",
                )
        return (
            fallback_mode,
            f"invalid persisted playback selector mode {mode!r}; using {fallback_mode}",
        )
    if mode == "rust":
        available, warning = rust_playback_availability()
        if not available:
            return (
                "python",
                f"persisted Rust playback mode is unavailable; using python ({warning})",
            )
    return str(mode), ""


@dataclass(frozen=True)
class PlaybackSelector:
    mode: str

    def dispatch(
        self,
        capability: str,
        *,
        python: Callable[[], T],
        rust: Callable[[], tuple[bool, T | None]],
    ) -> T:
        if capability not in PLAYBACK_RUST_CAPABILITIES:
            raise ValueError(f"not a playback capability: {capability}")
        if self.mode == "python":
            return python()
        completed, result = rust()
        if not completed or result is None:
            raise PlaybackCapabilityError(capability)
        return result

    def decide(
        self,
        capability: str,
        *,
        python: Callable[[], T],
        rust: Callable[[], tuple[bool, object | None]],
        decode_rust: Callable[[object], T],
    ) -> T:
        if capability not in PLAYBACK_RUST_CAPABILITIES:
            raise ValueError(f"not a playback capability: {capability}")
        if self.mode == "python":
            return python()
        completed, response = rust()
        if not completed or response is None:
            raise PlaybackCapabilityError(capability)
        try:
            return decode_rust(response)
        except PlaybackCapabilityError:
            raise
        except Exception as exc:
            raise PlaybackCapabilityError(capability, "invalid native result") from exc


def capture_playback_selector(mode: object) -> PlaybackSelector:
    return PlaybackSelector(validate_playback_selector_mode(mode))


def playback_selector_snapshot(mode: str, warning: str = "") -> dict[str, object]:
    rust_available, rust_warning = rust_playback_availability()
    return {
        "mode": mode,
        "modes": list(PLAYBACK_SELECTOR_MODES),
        "rust_available": rust_available,
        "warning": warning or (rust_warning if mode == "rust" else ""),
    }
