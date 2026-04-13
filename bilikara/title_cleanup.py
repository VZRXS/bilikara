from __future__ import annotations

import re

FULLWIDTH_BRACKET_RE = re.compile(r"【[^】]*】")
EDGE_SEPARATOR_RE = re.compile(r"^[\s\-|｜/:：]+|[\s\-|｜/:：]+$")
MULTISPACE_RE = re.compile(r"\s+")


def clean_display_title(
    *,
    title: str = "",
    display_title: str = "",
    part_title: str = "",
) -> str:
    base_title = str(title or "").strip()
    fallback_title = _remove_part_suffix(str(display_title or ""), str(part_title or ""))
    candidate = base_title or fallback_title or str(display_title or "").strip()
    cleaned = FULLWIDTH_BRACKET_RE.sub(" ", candidate)
    cleaned = MULTISPACE_RE.sub(" ", cleaned).strip()
    cleaned = EDGE_SEPARATOR_RE.sub("", cleaned).strip()
    return cleaned or candidate.strip()


def _remove_part_suffix(display_title: str, part_title: str) -> str:
    normalized_display = str(display_title or "").strip()
    normalized_part = str(part_title or "").strip()
    if not normalized_display or not normalized_part:
        return normalized_display

    suffix = f" - {normalized_part}"
    if normalized_display.endswith(suffix):
        return normalized_display[: -len(suffix)].rstrip()
    return normalized_display
