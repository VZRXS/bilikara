#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
from typing import Iterable

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError as exc:  # pragma: no cover - developer helper
    raise SystemExit("This preview script needs Pillow. Install it with: python3 -m pip install Pillow") from exc


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO_ROOT / "data" / "previews" / "transition-overlay-preview.png"

BG = (246, 239, 227)
INK = (29, 26, 24)
MUTED = (109, 98, 88)
ACCENT = (208, 90, 63)
ACCENT_DEEP = (163, 54, 33)
CARD = (255, 239, 222, 255)
CARD_GLOSS = (255, 255, 255, 112)
WHITE_SOFT = (255, 255, 255, 132)
WHITE_ROW = (255, 255, 255, 94)


def font_candidates() -> Iterable[Path]:
    env_font = os.environ.get("BILIKARA_PREVIEW_FONT")
    if env_font:
        yield Path(env_font)
    for raw_path in (
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyhbd.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        yield Path(raw_path)


def load_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    env_font = os.environ.get("BILIKARA_PREVIEW_FONT_BOLD" if bold else "BILIKARA_PREVIEW_FONT")
    candidates = [Path(env_font)] if env_font else []
    candidates.extend(font_candidates())
    if bold:
        candidates.extend(
            [
                Path("C:/Windows/Fonts/msyhbd.ttc"),
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
            ]
        )
    for path in candidates:
        if not path or not path.exists():
            continue
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def using_cjk_font() -> bool:
    env_font = os.environ.get("BILIKARA_PREVIEW_FONT")
    if env_font:
        return True
    return any(path.exists() for path in font_candidates() if "DejaVu" not in path.name)


def text_size(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def truncate_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> str:
    if text_size(draw, text, font)[0] <= max_width:
        return text
    suffix = "..."
    available = max_width - text_size(draw, suffix, font)[0]
    if available <= 0:
        return suffix
    result = ""
    for char in text:
        if text_size(draw, result + char, font)[0] > available:
            break
        result += char
    return result.rstrip() + suffix


def wrap_two_lines(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = text.split()
    if len(words) <= 1:
        chars = list(text)
        lines: list[str] = [""]
        for index, char in enumerate(chars):
            if text_size(draw, lines[-1] + char, font)[0] <= max_width:
                lines[-1] += char
            elif len(lines) < 2:
                lines.append(char)
            else:
                lines[-1] = truncate_text(draw, lines[-1] + char + "".join(chars[index + 1 :]), font, max_width)
                break
        return [line for line in lines if line]

    lines = [""]
    for word in words:
        candidate = f"{lines[-1]} {word}".strip()
        if text_size(draw, candidate, font)[0] <= max_width:
            lines[-1] = candidate
        elif len(lines) < 2:
            lines.append(word)
        else:
            lines[-1] = truncate_text(draw, f"{lines[-1]} {word}", font, max_width)
            break
    return lines


def alpha_composite_rounded(
    base: Image.Image,
    box: tuple[int, int, int, int],
    radius: int,
    fill: tuple[int, int, int, int],
    outline: tuple[int, int, int, int] | None = None,
    width: int = 1,
) -> None:
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)
    base.alpha_composite(overlay)


def draw_text_lines(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    lines: list[str],
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int],
    line_gap: int,
) -> None:
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        y += text_size(draw, line, font)[1] + line_gap


def draw_text_lines_centered(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    lines: list[str],
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int],
    line_gap: int,
) -> None:
    heights = [text_size(draw, line, font)[1] for line in lines]
    total_height = sum(heights) + max(0, len(lines) - 1) * line_gap
    y = box[1] + max(0, (box[3] - box[1] - total_height) // 2)
    for line, height in zip(lines, heights):
        draw.text((box[0], y), line, font=font, fill=fill)
        y += height + line_gap


def draw_countdown_ring(
    draw: ImageDraw.ImageDraw,
    center: tuple[int, int],
    radius: int,
    text: str,
    font: ImageFont.ImageFont,
    *,
    progress: float = 0.72,
) -> None:
    x, y = center
    outer = (x - radius, y - radius, x + radius, y + radius)
    draw.ellipse(outer, fill=(255, 255, 255, 92), outline=(255, 255, 255, 128), width=2)
    inset = 9
    track = (outer[0] + inset, outer[1] + inset, outer[2] - inset, outer[3] - inset)
    draw.arc(track, 0, 360, fill=(208, 90, 63, 44), width=5)
    draw.arc(track, -90, -90 + int(360 * max(0, min(1, progress))), fill=(208, 90, 63, 210), width=5)
    tw, th = text_size(draw, text, font)
    draw.text((x - tw // 2, y - th // 2 - 1), text, font=font, fill=ACCENT_DEEP)


def sample_copy() -> dict[str, object]:
    if using_cjk_font():
        return {
            "heading": "即将播放",
            "section": "后续点歌列表",
            "total": "共 7 首",
            "requesters": ["点歌人 Aki", "VZRXS", "Mika", "Nozomi"],
            "durations": ["4:28", "5:02", "3:51", "4:06"],
            "songs": [
                "【カラオケ】 late in autumn - fripSide",
                "Heaven is a Place on Earth - fripSide",
                "さようならへさよなら! - Aqours",
                "double Decades - fripSide【补档】",
            ],
        }
    return {
        "heading": "Up Next",
        "section": "Following Queue",
        "total": "7 songs",
        "requesters": ["Aki", "VZRXS", "Mika", "Nozomi"],
        "durations": ["4:28", "5:02", "3:51", "4:06"],
        "songs": [
            "late in autumn - fripSide",
            "Heaven is a Place on Earth - fripSide",
            "Sayonara e Sayonara! - Aqours",
            "double Decades - fripSide",
        ],
    }


def render_preview(output: Path) -> None:
    width, height = 1920, 1080
    image = Image.new("RGBA", (width, height), BG + (255,))
    draw = ImageDraw.Draw(image)

    for y in range(height):
        t = y / max(1, height - 1)
        color = (
            int(250 - 8 * t),
            int(244 - 16 * t),
            int(235 - 28 * t),
            255,
        )
        draw.line((0, y, width, y), fill=color)

    # Dark video surface behind the fullscreen overlay.
    video_box = (80, 70, width - 80, height - 70)
    draw.rounded_rectangle(video_box, radius=34, fill=(42, 35, 30, 255))
    draw.rounded_rectangle(video_box, radius=34, outline=(255, 255, 255, 36), width=2)
    dim = Image.new("RGBA", image.size, (0, 0, 0, 0))
    ImageDraw.Draw(dim).rounded_rectangle(video_box, radius=34, fill=(0, 0, 0, 96))
    image.alpha_composite(dim)

    card_w, card_h = 980, 670
    card_x = (width - card_w) // 2
    card_y = (height - card_h) // 2
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((card_x, card_y + 18, card_x + card_w, card_y + card_h + 18), radius=34, fill=(0, 0, 0, 70))
    image.alpha_composite(shadow)
    alpha_composite_rounded(
        image,
        (card_x, card_y, card_x + card_w, card_y + card_h),
        34,
        CARD,
        outline=(255, 255, 255, 124),
        width=2,
    )
    alpha_composite_rounded(
        image,
        (card_x + 2, card_y + 2, card_x + card_w - 2, card_y + 178),
        32,
        CARD_GLOSS,
    )
    alpha_composite_rounded(
        image,
        (card_x + 28, card_y + 22, card_x + card_w - 28, card_y + card_h - 22),
        26,
        (255, 255, 255, 24),
        outline=(208, 90, 63, 24),
        width=1,
    )

    copy = sample_copy()
    heading_font = load_font(34, bold=True)
    countdown_font = load_font(30, bold=True)
    title_font = load_font(28, bold=True)
    row_title_font = load_font(22, bold=True)
    meta_font = load_font(20, bold=True)
    small_font = load_font(18, bold=True)

    padding = 44
    x = card_x + padding
    y = card_y + 36
    draw.text((x, y), str(copy["heading"]), font=heading_font, fill=INK)

    draw_countdown_ring(
        draw,
        (card_x + card_w - padding - 30, y + 28),
        30,
        "5s",
        countdown_font,
    )

    row_y = y + 78
    now_box = (x, row_y, card_x + card_w - padding, row_y + 112)
    alpha_composite_rounded(image, now_box, 24, WHITE_SOFT, outline=(208, 90, 63, 32))

    icon_box = (x + 18, row_y + 38, x + 50, row_y + 70)
    alpha_composite_rounded(image, icon_box, 999, (208, 90, 63, 36))
    draw.polygon([(icon_box[0] + 12, icon_box[1] + 8), (icon_box[0] + 12, icon_box[3] - 8), (icon_box[2] - 8, (icon_box[1] + icon_box[3]) // 2)], fill=ACCENT_DEEP)

    title_x = x + 68
    requester_x = card_x + card_w - padding - 250
    duration_x = card_x + card_w - padding - 72
    title_max = requester_x - title_x - 28
    lines = wrap_two_lines(draw, str(copy["songs"][0]), title_font, title_max)
    draw_text_lines_centered(draw, (title_x, row_y + 14, requester_x - 28, row_y + 98), lines, title_font, INK, 8)
    draw.text((requester_x, row_y + 42), str(copy["requesters"][0]), font=meta_font, fill=MUTED)
    draw.text((duration_x, row_y + 42), str(copy["durations"][0]), font=meta_font, fill=MUTED)

    section_y = row_y + 150
    draw.text((x, section_y), str(copy["section"]), font=title_font, fill=ACCENT_DEEP)

    list_y = section_y + 48
    row_h = 76
    for index in range(1, 4):
        top = list_y + (index - 1) * (row_h + 12)
        alpha_composite_rounded(
            image,
            (x, top, card_x + card_w - padding, top + row_h),
            20,
            WHITE_ROW,
        )
        idx_box = (x + 14, top + 24, x + 44, top + 54)
        alpha_composite_rounded(image, idx_box, 999, (208, 90, 63, 32))
        draw.text((idx_box[0] + 10, idx_box[1] + 3), str(index), font=small_font, fill=ACCENT_DEEP)
        song = str(copy["songs"][index])
        draw_text_lines_centered(
            draw,
            (title_x, top + 8, requester_x - 28, top + row_h - 8),
            wrap_two_lines(draw, song, row_title_font, title_max),
            row_title_font,
            INK,
            6,
        )
        draw.text((requester_x, top + 26), str(copy["requesters"][index]), font=small_font, fill=MUTED)
        draw.text((duration_x, top + 26), str(copy["durations"][index]), font=small_font, fill=MUTED)

    total = str(copy["total"])
    tw, th = text_size(draw, total, meta_font)
    total_box = (
        card_x + card_w - padding - tw - 26,
        list_y + 3 * (row_h + 12) + 12,
        card_x + card_w - padding,
        list_y + 3 * (row_h + 12) + th + 28,
    )
    alpha_composite_rounded(image, total_box, 999, (255, 255, 255, 86))
    draw.text((total_box[0] + 13, total_box[1] + 7), total, font=meta_font, fill=INK)

    output.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a static preview of the fullscreen transition queue overlay.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help=f"PNG output path. Default: {DEFAULT_OUTPUT}")
    args = parser.parse_args()
    render_preview(args.output)
    print(f"Preview written to: {args.output}")


if __name__ == "__main__":
    main()
