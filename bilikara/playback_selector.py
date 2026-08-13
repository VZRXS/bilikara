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
    rust_available, availability_warning = rust_playback_availability()
    completed, decision = rust_backend.try_decide_playback_selector_policy(
        {
            "schema_version": 1,
            "operation": "validate_requested",
            "rust_available": rust_available,
            "mode": mode,
        }
    )
    if completed and decision is not None:
        reason = decision["reason"]
        if decision["status"] == "rejected":
            if reason == "invalid_requested":
                raise ValueError("playback selector mode must be python or rust")
            raise PlaybackCapabilityError("availability", availability_warning)
        return str(decision["effective_mode"])

    # Bootstrap-only compatibility for a completely unavailable or stale Rust
    # library. It preserves the existing Python escape hatch, but never accepts
    # Rust mode or invents a second selector normalization policy.
    if mode == "python":
        return "python"
    if mode == "rust":
        detail = availability_warning or "Rust selector policy is unavailable"
        raise PlaybackCapabilityError("availability", detail)
    raise ValueError("playback selector mode must be python or rust")


def normalize_persisted_playback_selector_mode(
    mode: object,
    *,
    is_set: bool = True,
) -> tuple[str, str]:
    rust_available, availability_warning = rust_playback_availability()
    completed, decision = rust_backend.try_decide_playback_selector_policy(
        {
            "schema_version": 1,
            "operation": "resolve_persisted",
            "rust_available": rust_available,
            "is_set": is_set,
            "mode": mode,
        }
    )
    if completed and decision is not None:
        effective_mode = str(decision["effective_mode"])
        reason = decision["reason"]
        if reason == "invalid_persisted":
            return (
                effective_mode,
                f"invalid persisted playback selector mode {mode!r}; "
                f"using {effective_mode}"
                + (
                    f" ({availability_warning})"
                    if effective_mode == "python" and availability_warning
                    else ""
                ),
            )
        if reason == "rust_unavailable":
            if is_set and mode == "rust":
                return (
                    "python",
                    "persisted Rust playback mode is unavailable; "
                    f"using python ({availability_warning})",
                )
            return (
                "python",
                "Rust playback mode is unavailable; "
                f"using python ({availability_warning})",
            )
        return effective_mode, ""

    # Narrow startup compatibility when the new Rust policy export itself is
    # absent. Python mode is the sole safe effective mode; no Rust decision is
    # approximated here.
    detail = availability_warning or "Rust selector policy is unavailable"
    if is_set and mode == "python":
        return "python", ""
    if is_set and mode not in PLAYBACK_SELECTOR_MODES:
        return (
            "python",
            f"invalid persisted playback selector mode {mode!r}; "
            f"using python ({detail})",
        )
    if is_set and mode == "rust":
        return (
            "python",
            f"persisted Rust playback mode is unavailable; using python ({detail})",
        )
    return "python", f"Rust playback mode is unavailable; using python ({detail})"


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
