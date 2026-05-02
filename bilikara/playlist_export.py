from __future__ import annotations

import csv
import io
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import APP_VERSION
from .title_cleanup import clean_display_title

PLAYLIST_IMAGE_PAGE_SIZE = 80
PROJECT_URL = "https://github.com/VZRXS/bilikara"
QR_QUIET_MODULES = 2

_BV_RE = re.compile(r"(BV[0-9A-Za-z]+)", re.IGNORECASE)
_AV_RE = re.compile(r"(av\d+)", re.IGNORECASE)


def playlist_csv_bytes(items: list[dict[str, Any]], *, time_header: str = "点歌时间") -> bytes:
    ordered_items = _items_in_export_order(items)
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=[
            "序号",
            "标题",
            "BV 号",
            "点歌人",
            "UP 主",
            "UP 主UID",
            "点歌次数",
            time_header,
            "视频链接",
            "原始链接",
            "分P/版本",
        ],
        extrasaction="ignore",
    )
    writer.writeheader()
    for index, entry in enumerate(ordered_items, start=1):
        writer.writerow(
            {
                "序号": index,
                "标题": _text(entry.get("display_title") or entry.get("title")),
                "BV 号": _video_id(entry),
                "点歌人": _text(entry.get("requester_name")),
                "UP 主": _text(entry.get("owner_name")),
                "UP 主UID": _text(entry.get("owner_mid")),
                "点歌次数": _request_count(entry),
                time_header: _format_time(entry.get("requested_at")),
                "视频链接": _text(entry.get("resolved_url")),
                "原始链接": _text(entry.get("original_url")),
                "分P/版本": _text(entry.get("part_title")),
            }
        )
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def playlist_image_export(
    items: list[dict[str, Any]],
    *,
    logo_path: Path | None = None,
    title: str = "bilikara 歌单导出",
) -> tuple[bytes, str, str]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as exc:  # pragma: no cover - depends on optional runtime dependency
        raise RuntimeError("图片导出需要安装 Pillow：py -m pip install Pillow") from exc

    ordered_items = _items_in_export_order(items)
    pages = [
        ordered_items[index : index + PLAYLIST_IMAGE_PAGE_SIZE]
        for index in range(0, max(1, len(ordered_items)), PLAYLIST_IMAGE_PAGE_SIZE)
    ]
    rendered_pages = [
        _render_playlist_page(
            page,
            page_number=page_index + 1,
            page_count=len(pages),
            total_count=len(ordered_items),
            logo_path=logo_path,
            title=title,
            time_range=_calculate_time_range(ordered_items),
            image_module=Image,
            draw_module=ImageDraw,
            font_module=ImageFont,
        )
        for page_index, page in enumerate(pages)
    ]

    if len(rendered_pages) == 1:
        output = io.BytesIO()
        rendered_pages[0].save(output, format="PNG", optimize=True)
        return output.getvalue(), "image/png", "bilikara-playlist.png"

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for index, page in enumerate(rendered_pages, start=1):
            output = io.BytesIO()
            page.save(output, format="PNG", optimize=True)
            zf.writestr(f"bilikara-playlist-page-{index:02d}.png", output.getvalue())
    return archive.getvalue(), "application/zip", "bilikara-playlist-images.zip"


def _render_playlist_page(
    entries: list[dict[str, Any]],
    *,
    page_number: int,
    page_count: int,
    total_count: int,
    logo_path: Path | None,
    title: str,
    time_range: str,
    image_module: Any,
    draw_module: Any,
    font_module: Any,
) -> Any:
    width = 1600
    table_y = 292
    row_h = 104
    header_h = 62
    row_count = len(entries)
    table_h = header_h + row_count * row_h + 24
    footer_gap = 44
    footer_h = footer_gap + 154 + 58
    height = max(760, table_y + table_h + footer_h)
    image = image_module.new("RGB", (width, height), "#F6EFE3")
    draw = draw_module.Draw(image)

    _draw_gradient(draw, width, height)

    title_font = _load_font(font_module, 72, bold=True)
    subtitle_font = _load_font(font_module, 27)
    header_font = _load_font(font_module, 25, bold=True)
    row_font = _load_font(font_module, 24)
    footer_font = _load_font(font_module, 22)

    draw.text((84, 94), title, fill="#1F1A16", font=title_font)
    subtitle = f"共 {total_count} 首 · 第 {page_number}/{page_count} 页 · {time_range}"
    draw.text((88, 188), subtitle, fill="#77695E", font=subtitle_font)

    table_x = 70
    table_w = width - table_x * 2
    columns = [
        ("#", 64),
        ("标题", 564),
        ("BV 号", 228),
        ("点歌人", 170),
        ("UP 主", 230),
        ("时间", 280),
    ]

    card_box = (table_x, table_y, table_x + table_w, table_y + table_h)
    _rounded_rectangle(draw, card_box, 34, "#FFFCF7")
    draw.rounded_rectangle(card_box, radius=34, outline="#EADDD0", width=2)
    _rounded_rectangle(draw, (table_x + 18, table_y + 18, table_x + table_w - 18, table_y + header_h + 10), 24, "#F5E7DA")
    cursor_x = table_x + 24
    for label, col_w in columns:
        draw.text((cursor_x, table_y + 30), label, fill="#8F3E2B", font=header_font)
        cursor_x += col_w

    start_index = (page_number - 1) * PLAYLIST_IMAGE_PAGE_SIZE
    for row_index, entry in enumerate(entries):
        top = table_y + header_h + row_index * row_h
        bg = "#FFFFFF" if row_index % 2 == 0 else "#FBF6EF"
        _rounded_rectangle(draw, (table_x + 18, top + 9, table_x + table_w - 18, top + row_h - 7), 18, bg)

        values = [
            str(start_index + row_index + 1),
            _export_title(entry) or "未命名歌曲",
            _video_id(entry),
            _text(entry.get("requester_name")) or "-",
            _text(entry.get("owner_name")) or "-",
            _format_time(entry.get("requested_at"), short=True),
        ]
        cursor_x = table_x + 24
        for col_index, ((_, col_w), value) in enumerate(zip(columns, values)):
            fill = "#1F1A16" if col_index == 1 else "#6F6258"
            if col_index == 0:
                fill = "#8F3E2B"
            lines = _wrap_text(draw, value, row_font, col_w - 18, max_lines=3)
            line_y = top + 17
            for line in lines:
                draw.text((cursor_x, line_y), line, fill=fill, font=row_font)
                line_y += 29
            cursor_x += col_w

    qr_matrix = _qr_matrix(PROJECT_URL)
    qr_x = 92
    qr_y = table_y + table_h + footer_gap
    qr_visual_y = qr_y + 28
    qr_size = 154
    qr_quiet_px = _qr_quiet_zone_pixels(qr_matrix, qr_size)
    _draw_qr(draw, qr_matrix, x=qr_x, y=qr_visual_y, size=qr_size)

    link_x = qr_x + 190
    text_offset_y = qr_quiet_px // 2
    draw.text((link_x, qr_y + 58 - text_offset_y), "项目地址", fill="#8F3E2B", font=header_font)
    draw.text((link_x, qr_y + 100 - text_offset_y), PROJECT_URL, fill="#8B7B6D", font=footer_font)
    draw.text((link_x, qr_y + 132 - text_offset_y), f"版本 {APP_VERSION}", fill="#A99B8E", font=footer_font)
    return image


def _draw_gradient(draw: Any, width: int, height: int) -> None:
    for y in range(height):
        t = y / max(1, height - 1)
        r = int(250 - 7 * t)
        g = int(244 - 14 * t)
        b = int(235 - 25 * t)
        draw.line((0, y, width, y), fill=(r, g, b))


def _draw_glow(draw: Any, width: int, height: int) -> None:
    for radius, color in (
        (620, "#3A244A"),
        (460, "#4A2936"),
        (330, "#1E5151"),
    ):
        draw.ellipse((width - radius, -radius // 2, width + radius // 2, radius), fill=color)
    draw.rectangle((0, 0, width, height), outline="#342E44", width=8)


def _draw_neon_details(draw: Any, width: int, height: int) -> None:
    draw.line((86, 216, 390, 216), fill="#F2745B", width=5)
    draw.line((410, 216, 540, 216), fill="#8DD7D2", width=5)
    for index in range(28):
        x = 92 + index * 52
        y = height - 300 + (index % 4) * 8
        fill = "#3C354F" if index % 3 else "#4B3B5E"
        draw.rectangle((x, y, x + 5, y + 5), fill=fill)


def _draw_logo(image: Any, logo_path: Path | None, image_module: Any, *, size: int, position: tuple[int, int]) -> None:
    if not logo_path or not logo_path.exists():
        return
    try:
        logo = image_module.open(logo_path).convert("RGBA")
    except OSError:
        return
    logo.thumbnail((size, size))
    x, y = position
    paste_position = (x + size - logo.width, y)
    image.paste(logo, paste_position, logo)


def _draw_qr(draw: Any, matrix: list[list[bool]], *, x: int, y: int, size: int) -> None:
    count = len(matrix)
    quiet = QR_QUIET_MODULES
    cell = max(1, size // (count + quiet * 2))
    actual = cell * (count + quiet * 2)
    draw.rectangle((x, y, x + actual, y + actual), fill="#FFFCF7")
    offset = quiet * cell
    for row_index, row in enumerate(matrix):
        for col_index, dark in enumerate(row):
            if not dark:
                continue
            left = x + offset + col_index * cell
            top = y + offset + row_index * cell
            draw.rectangle((left, top, left + cell - 1, top + cell - 1), fill="#1F1A16")


def _qr_quiet_zone_pixels(matrix: list[list[bool]], size: int) -> int:
    quiet = QR_QUIET_MODULES
    count = len(matrix)
    cell = max(1, size // (count + quiet * 2))
    return quiet * cell


def _find_system_font(*, bold: bool = False) -> str | None:
    import shutil
    import subprocess

    if not shutil.which("fc-list"):
        return None
    try:
        # Try to find a CJK font specifically
        pattern = ":lang=zh"
        result = subprocess.run(
            ["fc-list", pattern, "file"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0 and result.stdout:
            for line in result.stdout.splitlines():
                path = line.split(":")[0].strip()
                if path.lower().endswith((".ttf", ".ttc", ".otf")):
                    return path
    except Exception:
        pass
    return None


def _load_font(font_module: Any, size: int, *, bold: bool = False) -> Any:
    candidates = [
        "static/fonts/SourceHanSans-VF.ttf",
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msjhbd.ttc" if bold else "C:/Windows/Fonts/msjh.ttc",
        "C:/Windows/Fonts/Dengb.ttf" if bold else "C:/Windows/Fonts/Deng.ttf",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/simsun.ttc",
        "C:/Windows/Fonts/ARIALUNI.TTF",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Bold.otf" if bold else "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
        "/usr/share/fonts/truetype/arphic/ukai.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        _find_system_font(bold=bold),
    ]
    for candidate in candidates:
        try:
            if candidate:
                font = font_module.truetype(candidate, size)
                # 针对思源黑体 VF 等可变字体，主动设置字重轴
                # 默认值通常太细 (250)，需要调整到 Regular (400-500) 或 Bold (700+)
                if hasattr(font, "set_variation_by_axes"):
                    try:
                        axes = font.get_variation_axes()
                        if axes and any(ax.get("name") in (b"Weight", b"wght") for ax in axes):
                            weight = 800 if bold else 450
                            font.set_variation_by_axes([weight])
                    except Exception:
                        pass
                return font
        except OSError:
            continue
    return font_module.load_default()



def _calculate_time_range(items: list[dict[str, Any]]) -> str:
    times = [float(item.get("requested_at") or 0) for item in items if item.get("requested_at")]
    if not times:
        return datetime.now().strftime("%Y-%m-%d %H:%M")
    start_dt = datetime.fromtimestamp(min(times))
    end_dt = datetime.fromtimestamp(max(times))
    if start_dt.date() == end_dt.date():
        return f"{start_dt.strftime('%Y-%m-%d %H:%M')} ~ {end_dt.strftime('%H:%M')}"
    return f"{start_dt.strftime('%Y-%m-%d %H:%M')} ~ {end_dt.strftime('%Y-%m-%d %H:%M')}"


def _fit_text(draw: Any, text: str, font: Any, max_width: int) -> str:
    value = _text(text)
    if not value:
        return ""
    if draw.textlength(value, font=font) <= max_width:
        return value
    ellipsis = "..."
    while value and draw.textlength(value + ellipsis, font=font) > max_width:
        value = value[:-1]
    return value + ellipsis if value else ellipsis


def _wrap_text(draw: Any, text: str, font: Any, max_width: int, *, max_lines: int) -> list[str]:
    value = _text(text)
    if not value:
        return [""]

    lines: list[str] = []
    current = ""
    for char in value:
        candidate = current + char
        if current and draw.textlength(candidate, font=font) > max_width:
            lines.append(current)
            current = char
            if len(lines) >= max_lines:
                break
        else:
            current = candidate

    if len(lines) < max_lines and current:
        lines.append(current)

    if len(lines) > max_lines:
        lines = lines[:max_lines]

    consumed = "".join(lines)
    if len(consumed) < len(value) and lines:
        ellipsis = "..."
        last_line = lines[-1].rstrip()
        while last_line and draw.textlength(last_line + ellipsis, font=font) > max_width:
            last_line = last_line[:-1]
        lines[-1] = f"{last_line}{ellipsis}" if last_line else ellipsis

    return lines or [""]


def _rounded_rectangle(draw: Any, box: tuple[int, int, int, int], radius: int, fill: str) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def _format_time(value: object, *, short: bool = False) -> str:
    try:
        timestamp = float(value or 0)
    except (TypeError, ValueError):
        timestamp = 0.0
    if timestamp <= 0:
        return ""
    fmt = "%m-%d %H:%M" if short else "%Y-%m-%d %H:%M:%S"
    return datetime.fromtimestamp(timestamp).strftime(fmt)


def _video_id(entry: dict[str, Any]) -> str:
    for key in ("resolved_url", "original_url", "key"):
        text = _text(entry.get(key))
        match = _BV_RE.search(text)
        if match:
            return match.group(1)
        match = _AV_RE.search(text)
        if match:
            return match.group(1)
    return ""


def _export_title(entry: dict[str, Any]) -> str:
    return clean_display_title(
        title=_text(entry.get("title")),
        display_title=_text(entry.get("display_title")),
        part_title=_text(entry.get("part_title")),
    )


def _text(value: object) -> str:
    return str(value or "").strip()


def _request_count(entry: dict[str, Any]) -> int:
    try:
        return max(1, int(entry.get("request_count") or 1))
    except (TypeError, ValueError):
        return 1


def _items_in_export_order(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        entry
        for _, entry in sorted(
            enumerate(items),
            key=lambda pair: _playlist_export_sort_key(pair[0], pair[1]),
        )
    ]


def _playlist_export_sort_key(index: int, entry: dict[str, Any]) -> tuple[int, float | int, int]:
    timestamp = _timestamp(entry.get("requested_at"))
    if timestamp is None:
        return (1, index, index)
    return (0, timestamp, index)


def _timestamp(value: object) -> float | None:
    try:
        timestamp = float(value or 0)
    except (TypeError, ValueError):
        return None
    return timestamp if timestamp > 0 else None


def _qr_matrix(text: str) -> list[list[bool]]:
    version = 3
    size = 17 + version * 4
    data_codewords = 55
    ec_codewords = 15
    data = text.encode("utf-8")
    if len(data) > 53:
        raise ValueError("QR payload is too long for the built-in encoder")

    bits: list[int] = []
    _append_bits(bits, 0b0100, 4)
    _append_bits(bits, len(data), 8)
    for byte in data:
        _append_bits(bits, byte, 8)
    capacity = data_codewords * 8
    _append_bits(bits, 0, min(4, capacity - len(bits)))
    while len(bits) % 8:
        bits.append(0)

    codewords = [
        sum(bits[index + bit] << (7 - bit) for bit in range(8))
        for index in range(0, len(bits), 8)
    ]
    for pad in (0xEC, 0x11):
        if len(codewords) >= data_codewords:
            break
        codewords.append(pad)
    pad_index = 0
    while len(codewords) < data_codewords:
        codewords.append(0xEC if pad_index % 2 == 0 else 0x11)
        pad_index += 1

    all_codewords = codewords + _rs_remainder(codewords, ec_codewords)
    matrix: list[list[bool | None]] = [[None for _ in range(size)] for _ in range(size)]
    function = [[False for _ in range(size)] for _ in range(size)]

    def set_function(x: int, y: int, dark: bool) -> None:
        if 0 <= x < size and 0 <= y < size:
            matrix[y][x] = dark
            function[y][x] = True

    def draw_finder(x: int, y: int) -> None:
        for dy in range(-1, 8):
            for dx in range(-1, 8):
                xx, yy = x + dx, y + dy
                if not (0 <= xx < size and 0 <= yy < size):
                    continue
                dark = 0 <= dx <= 6 and 0 <= dy <= 6 and max(abs(dx - 3), abs(dy - 3)) != 2
                set_function(xx, yy, dark)

    def draw_alignment(cx: int, cy: int) -> None:
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                set_function(cx + dx, cy + dy, max(abs(dx), abs(dy)) == 2 or (dx == 0 and dy == 0))

    draw_finder(0, 0)
    draw_finder(size - 7, 0)
    draw_finder(0, size - 7)
    draw_alignment(22, 22)
    for index in range(8, size - 8):
        set_function(6, index, index % 2 == 0)
        set_function(index, 6, index % 2 == 0)
    set_function(8, 4 * version + 9, True)
    _draw_format_bits(matrix, function, size, mask=0)

    payload_bits = [
        (codeword >> bit) & 1
        for codeword in all_codewords
        for bit in range(7, -1, -1)
    ]
    bit_index = 0
    upward = True
    x = size - 1
    y = size - 1
    while x > 0:
        if x == 6:
            x -= 1
        while True:
            for dx in (0, 1):
                xx = x - dx
                if not function[y][xx]:
                    bit = payload_bits[bit_index] if bit_index < len(payload_bits) else 0
                    bit_index += 1
                    matrix[y][xx] = bool(bit) ^ ((xx + y) % 2 == 0)
            y += -1 if upward else 1
            if y < 0 or y >= size:
                y += 1 if upward else -1
                upward = not upward
                break
        x -= 2
    _draw_format_bits(matrix, function, size, mask=0)
    return [[bool(cell) for cell in row] for row in matrix]


def _append_bits(bits: list[int], value: int, length: int) -> None:
    for index in range(length - 1, -1, -1):
        bits.append((value >> index) & 1)


def _draw_format_bits(matrix: list[list[bool | None]], function: list[list[bool]], size: int, *, mask: int) -> None:
    data = (0b01 << 3) | mask
    remainder = data << 10
    for bit_index in range(14, 9, -1):
        if (remainder >> bit_index) & 1:
            remainder ^= 0x537 << (bit_index - 10)
    bits = ((data << 10) | (remainder & 0x3FF)) ^ 0x5412

    def set_cell(x: int, y: int, index: int) -> None:
        matrix[y][x] = bool((bits >> index) & 1)
        function[y][x] = True

    for i in range(6):
        set_cell(8, i, i)
    set_cell(8, 7, 6)
    set_cell(8, 8, 7)
    set_cell(7, 8, 8)
    for i in range(9, 15):
        set_cell(14 - i, 8, i)
    for i in range(8):
        set_cell(size - 1 - i, 8, i)
    for i in range(8, 15):
        set_cell(8, size - 15 + i, i)


def _rs_remainder(data: list[int], degree: int) -> list[int]:
    generator = _rs_generator(degree)
    remainder = [0] * degree
    for byte in data:
        factor = byte ^ remainder.pop(0)
        remainder.append(0)
        for index in range(degree):
            remainder[index] ^= _gf_mul(generator[index + 1], factor)
    return remainder


def _rs_generator(degree: int) -> list[int]:
    generator = [1]
    for index in range(degree):
        generator = _poly_multiply(generator, [1, _gf_pow(2, index)])
    return generator


def _poly_multiply(left: list[int], right: list[int]) -> list[int]:
    result = [0] * (len(left) + len(right) - 1)
    for left_index, left_value in enumerate(left):
        for right_index, right_value in enumerate(right):
            result[left_index + right_index] ^= _gf_mul(left_value, right_value)
    return result


def _gf_pow(value: int, power: int) -> int:
    result = 1
    for _ in range(power):
        result = _gf_mul(result, value)
    return result


def _gf_mul(left: int, right: int) -> int:
    result = 0
    while right:
        if right & 1:
            result ^= left
        left <<= 1
        if left & 0x100:
            left ^= 0x11D
        right >>= 1
    return result
