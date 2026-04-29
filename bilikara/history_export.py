from __future__ import annotations

import csv
import io
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

HISTORY_IMAGE_PAGE_SIZE = 25
PROJECT_URL = "https://github.com/VZRXS/bilikara"
RELEASES_URL = "https://github.com/VZRXS/bilikara/releases"

_BV_RE = re.compile(r"(BV[0-9A-Za-z]+)", re.IGNORECASE)
_AV_RE = re.compile(r"(av\d+)", re.IGNORECASE)


def history_csv_bytes(history: list[dict[str, Any]]) -> bytes:
    ordered_history = _history_in_export_order(history)
    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=[
            "序号",
            "标题",
            "BV号",
            "点歌人",
            "UP主",
            "UP主UID",
            "点歌次数",
            "点歌时间",
            "视频链接",
            "原始链接",
            "分P/版本",
        ],
        extrasaction="ignore",
    )
    writer.writeheader()
    for index, entry in enumerate(ordered_history, start=1):
        writer.writerow(
            {
                "序号": index,
                "标题": _text(entry.get("display_title") or entry.get("title")),
                "BV号": _video_id(entry),
                "点歌人": _text(entry.get("requester_name")),
                "UP主": _text(entry.get("owner_name")),
                "UP主UID": _text(entry.get("owner_mid")),
                "点歌次数": _request_count(entry),
                "点歌时间": _format_time(entry.get("requested_at")),
                "视频链接": _text(entry.get("resolved_url")),
                "原始链接": _text(entry.get("original_url")),
                "分P/版本": _text(entry.get("part_title")),
            }
        )
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def history_image_export(
    history: list[dict[str, Any]],
    *,
    logo_path: Path | None = None,
) -> tuple[bytes, str, str]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError as exc:  # pragma: no cover - depends on optional runtime dependency
        raise RuntimeError("图片导出需要安装 Pillow：py -m pip install Pillow") from exc

    ordered_history = _history_in_export_order(history)
    pages = [
        ordered_history[index : index + HISTORY_IMAGE_PAGE_SIZE]
        for index in range(0, max(1, len(ordered_history)), HISTORY_IMAGE_PAGE_SIZE)
    ]
    rendered_pages = [
        _render_history_page(
            page,
            page_number=page_index + 1,
            page_count=len(pages),
            total_count=len(ordered_history),
            logo_path=logo_path,
            image_module=Image,
            draw_module=ImageDraw,
            font_module=ImageFont,
        )
        for page_index, page in enumerate(pages)
    ]

    if len(rendered_pages) == 1:
        output = io.BytesIO()
        rendered_pages[0].save(output, format="PNG", optimize=True)
        return output.getvalue(), "image/png", "bilikara-history.png"

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for index, page in enumerate(rendered_pages, start=1):
            output = io.BytesIO()
            page.save(output, format="PNG", optimize=True)
            zf.writestr(f"bilikara-history-page-{index:02d}.png", output.getvalue())
    return archive.getvalue(), "application/zip", "bilikara-history-images.zip"


def _render_history_page(
    entries: list[dict[str, Any]],
    *,
    page_number: int,
    page_count: int,
    total_count: int,
    logo_path: Path | None,
    image_module: Any,
    draw_module: Any,
    font_module: Any,
) -> Any:
    width, height = 1600, 2200
    image = image_module.new("RGB", (width, height), "#101018")
    draw = draw_module.Draw(image)

    _draw_gradient(draw, width, height)
    _draw_glow(draw, width, height)
    _draw_neon_details(draw, width, height)

    title_font = _load_font(font_module, 66, bold=True)
    subtitle_font = _load_font(font_module, 28)
    header_font = _load_font(font_module, 25, bold=True)
    row_font = _load_font(font_module, 24)
    small_font = _load_font(font_module, 21)
    footer_font = _load_font(font_module, 23, bold=True)

    draw.text((90, 78), "Bilikara 点歌历史", fill="#2A213B", font=title_font)
    draw.text((84, 72), "Bilikara 点歌历史", fill="#FFF7E6", font=title_font)
    subtitle = f"共 {total_count} 首 · 第 {page_number}/{page_count} 页 · {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    draw.text((88, 154), subtitle, fill="#F7B98A", font=subtitle_font)

    _draw_logo(image, logo_path, image_module, size=168, position=(1348, 52))

    table_x = 70
    table_y = 245
    table_w = width - table_x * 2
    row_h = 66
    header_h = 58
    columns = [
        ("#", 64),
        ("标题", 612),
        ("BV号", 180),
        ("点歌人", 170),
        ("UP主", 230),
        ("时间", 280),
    ]

    _rounded_rectangle(draw, (table_x, table_y, table_x + table_w, table_y + header_h), 24, "#252036")
    draw.line((table_x + 28, table_y + header_h - 2, table_x + table_w - 28, table_y + header_h - 2), fill="#5FD6D1", width=2)
    cursor_x = table_x + 24
    for label, col_w in columns:
        draw.text((cursor_x, table_y + 11), label, fill="#FFD9A8", font=header_font)
        cursor_x += col_w

    start_index = (page_number - 1) * HISTORY_IMAGE_PAGE_SIZE
    for row_index, entry in enumerate(entries):
        top = table_y + header_h + row_index * row_h
        bg = "#1B1927" if row_index % 2 == 0 else "#171520"
        _rounded_rectangle(draw, (table_x, top + 5, table_x + table_w, top + row_h - 5), 18, bg)

        values = [
            str(start_index + row_index + 1),
            _text(entry.get("display_title") or entry.get("title")) or "未命名歌曲",
            _video_id(entry),
            _text(entry.get("requester_name")) or "-",
            _text(entry.get("owner_name")) or "-",
            _format_time(entry.get("requested_at"), short=True),
        ]
        cursor_x = table_x + 24
        for col_index, ((_, col_w), value) in enumerate(zip(columns, values)):
            fill = "#F8F0DF" if col_index in {0, 1} else "#BFC2D6"
            clipped = _fit_text(draw, value, row_font, col_w - 18)
            draw.text((cursor_x, top + 17), clipped, fill=fill, font=row_font)
            cursor_x += col_w

    footer_y = height - 155
    draw.line((80, footer_y - 26, width - 80, footer_y - 26), fill="#343044", width=2)
    draw.text((92, footer_y), PROJECT_URL, fill="#FFE0AC", font=footer_font)

    qr_matrix = _qr_matrix(RELEASES_URL)
    _draw_qr(draw, qr_matrix, x=width - 230, y=height - 255, size=154)
    draw.text((width - 252, height - 81), "Releases", fill="#FFF7E6", font=small_font)
    return image


def _draw_gradient(draw: Any, width: int, height: int) -> None:
    for y in range(height):
        t = y / max(1, height - 1)
        r = int(16 + 23 * t)
        g = int(16 + 9 * t)
        b = int(30 + 10 * t)
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
    quiet = 4
    cell = max(1, size // (count + quiet * 2))
    actual = cell * (count + quiet * 2)
    draw.rounded_rectangle((x, y, x + actual, y + actual), radius=18, fill="#FFF8EC")
    offset = quiet * cell
    for row_index, row in enumerate(matrix):
        for col_index, dark in enumerate(row):
            if not dark:
                continue
            left = x + offset + col_index * cell
            top = y + offset + row_index * cell
            draw.rectangle((left, top, left + cell - 1, top + cell - 1), fill="#11131C")


def _load_font(font_module: Any, size: int, *, bold: bool = False) -> Any:
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        try:
            if candidate:
                return font_module.truetype(candidate, size)
        except OSError:
            continue
    return font_module.load_default()


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


def _text(value: object) -> str:
    return str(value or "").strip()


def _request_count(entry: dict[str, Any]) -> int:
    try:
        return max(1, int(entry.get("request_count") or 1))
    except (TypeError, ValueError):
        return 1


def _history_in_export_order(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        entry
        for _, entry in sorted(
            enumerate(history),
            key=lambda pair: _history_export_sort_key(pair[0], pair[1]),
        )
    ]


def _history_export_sort_key(index: int, entry: dict[str, Any]) -> tuple[int, float | int, int]:
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
