use super::{ExportError, ImageExportRequest, PROJECT_URL, format_time};
use bilikara_rust::playlist_export::ExportEntry;
use cosmic_text::{
    Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache, Weight, Wrap, fontdb,
};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

type SharedFonts = Arc<Mutex<Fonts>>;
static FONTS: OnceLock<Mutex<Option<(PathBuf, SharedFonts)>>> = OnceLock::new();
const WIDTH: usize = 1600;
const ROW_HEIGHT: usize = 104;
const TABLE_Y: usize = 292;
const HEADER_HEIGHT: usize = 62;
// Original columns totalled 1536 px inside a 1412 px content area, clipping
// the time column. Redistribute 124 px; retain all six columns and font sizes.
const COLUMNS: [(&str, i32); 6] = [
    ("#", 64),
    ("标题", 500),
    ("BV 号", 218),
    ("点歌人", 170),
    ("UP 主", 230),
    ("时间", 230),
];

pub(super) struct Fonts {
    system: FontSystem,
    cache: SwashCache,
    family: String,
    #[cfg(test)]
    primary: fontdb::ID,
}

pub(super) fn font_resources(path: &Path) -> Result<SharedFonts, ExportError> {
    if !path.is_absolute() {
        return Err(ExportError::new(
            "invalid_request",
            "Export font path must be absolute",
        ));
    }
    let mut resources = FONTS
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| ExportError::new("font_unavailable", "Export font cache is unavailable"))?;
    if let Some((cached_path, fonts)) = resources.as_ref()
        && cached_path == path
    {
        return Ok(Arc::clone(fonts));
    }
    let data = std::fs::read(path).map_err(|_| {
        ExportError::new(
            "font_unavailable",
            "Bundled Source Han Sans export font is unavailable",
        )
    })?;
    let mut db = fontdb::Database::new();
    let ids = db.load_font_source(fontdb::Source::Binary(Arc::new(data)));
    let primary = *ids.first().ok_or_else(|| {
        ExportError::new(
            "font_unavailable",
            "Bundled export font could not be parsed",
        )
    })?;
    let family = db
        .face(primary)
        .and_then(|face| face.families.first())
        .map(|family| family.0.clone())
        .ok_or_else(|| ExportError::new("font_unavailable", "Bundled export font has no family"))?;
    // fontdb's platform discovery reads installed fonts (including collections,
    // symbols and Emoji), without a subprocess or runtime font downloads.
    db.load_system_fonts();
    db.set_sans_serif_family(family.clone());
    // Prefer the bundled face even if another installed copy shares its name.
    let duplicates: Vec<_> = db
        .faces()
        .filter(|face| face.id != primary && face.families.iter().any(|f| f.0 == family))
        .map(|f| f.id)
        .collect();
    for id in duplicates {
        db.remove_face(id);
    }
    let mut system = FontSystem::new_with_locale_and_db("zh-CN".into(), db);
    for weight in [450, 800] {
        if system.get_font(primary, Weight(weight)).is_none() {
            return Err(ExportError::new(
                "font_unavailable",
                "Bundled export font could not be loaded",
            ));
        }
    }
    let fonts = Arc::new(Mutex::new(Fonts {
        system,
        cache: SwashCache::new(),
        family,
        #[cfg(test)]
        primary,
    }));
    *resources = Some((path.to_owned(), Arc::clone(&fonts)));
    Ok(fonts)
}

impl Fonts {
    fn shape(
        &mut self,
        text: &str,
        size: f32,
        weight: u16,
        width: f32,
        line_height: f32,
    ) -> Buffer {
        let mut buffer = Buffer::new(&mut self.system, Metrics::new(size, line_height));
        buffer.set_size(&mut self.system, Some(width), None);
        buffer.set_wrap(&mut self.system, Wrap::Glyph);
        buffer.set_text(
            &mut self.system,
            text,
            &Attrs::new()
                .family(Family::Name(&self.family))
                .weight(Weight(weight)),
            Shaping::Advanced,
            None,
        );
        buffer.shape_until_scroll(&mut self.system, false);
        buffer
    }

    #[allow(clippy::too_many_arguments)]
    fn layout(
        &mut self,
        text: &str,
        size: f32,
        weight: u16,
        width: f32,
        line_height: f32,
        max_lines: usize,
        missing: &mut BTreeSet<String>,
    ) -> Buffer {
        let mut value = text.trim().to_owned();
        let initial = self.shape(&value, size, weight, width, line_height);
        let mut absent = BTreeSet::new();
        for run in initial.layout_runs() {
            for glyph in run.glyphs.iter().filter(|g| g.glyph_id == 0) {
                if let Some(cluster) = run.text.get(glyph.start..glyph.end) {
                    absent.extend(cluster.chars().filter(|c| {
                        !c.is_whitespace() && !matches!(*c, '\u{200d}' | '\u{fe0e}' | '\u{fe0f}')
                    }));
                }
            }
        }
        // If no installed font covers a character, expose its identity visibly
        // instead of accepting a blank glyph. This is not a semantic fallback.
        if !absent.is_empty() {
            value = value
                .chars()
                .map(|c| {
                    if absent.contains(&c) {
                        let name = format!("U+{:04X}", c as u32);
                        missing.insert(name.clone());
                        format!("[{name}]")
                    } else {
                        c.to_string()
                    }
                })
                .collect();
        }
        let mut buffer = if absent.is_empty() {
            initial
        } else {
            self.shape(&value, size, weight, width, line_height)
        };
        if buffer.layout_runs().count() > max_lines {
            let run = buffer.layout_runs().nth(max_lines - 1).unwrap();
            let line_offset: usize = buffer
                .lines
                .iter()
                .take(run.line_i)
                .map(|line| line.text().len() + line.ending().as_str().len())
                .sum();
            let end = run.glyphs.iter().map(|g| g.end).max().unwrap_or(0);
            value.truncate((line_offset + end).min(value.len()));
            loop {
                let fitted = format!("{}...", value.trim_end());
                buffer = self.shape(&fitted, size, weight, width, line_height);
                if buffer.layout_runs().count() <= max_lines || value.is_empty() {
                    break;
                }
                value.pop();
            }
        }
        buffer
    }

    fn check_raster(&mut self, buffer: &Buffer) -> Result<(), ExportError> {
        for run in buffer.layout_runs() {
            for glyph in run.glyphs {
                let visible = run.text.get(glyph.start..glyph.end).is_some_and(|text| {
                    text.chars().any(|c| {
                        !c.is_whitespace()
                            && !c.is_control()
                            && !matches!(
                                c,
                                '\u{200d}'
                                    | '\u{fe0e}'
                                    | '\u{fe0f}'
                                    | '\u{200b}'
                                    | '\u{200c}'
                                    | '\u{2060}'
                                    | '\u{feff}'
                            )
                    })
                });
                if visible
                    && self
                        .cache
                        .get_image(
                            &mut self.system,
                            glyph.physical((0., run.line_y), 1.).cache_key,
                        )
                        .is_none()
                {
                    return Err(ExportError::new(
                        "render_failed",
                        "An export text glyph could not be rasterized",
                    ));
                }
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn text(
        &mut self,
        image: &mut Canvas,
        x: i32,
        y: i32,
        value: &str,
        size: f32,
        weight: u16,
        width: f32,
        max_lines: usize,
        fill: u32,
        missing: &mut BTreeSet<String>,
    ) -> Result<(), ExportError> {
        let line_height = if size == 24. { 29. } else { size * 1.25 };
        let buffer = self.layout(value, size, weight, width, line_height, max_lines, missing);
        self.check_raster(&buffer)?;
        let color = Color::rgb((fill >> 16) as u8, (fill >> 8) as u8, fill as u8);
        buffer.draw(
            &mut self.system,
            &mut self.cache,
            color,
            |dx, dy, w, h, color| {
                for py in 0..h {
                    for px in 0..w {
                        image.blend(x + dx + px as i32, y + dy + py as i32, color);
                    }
                }
            },
        );
        Ok(())
    }
}

pub fn prewarm_fonts(path: &Path) -> Result<(), ExportError> {
    let resources = font_resources(path)?;
    let mut fonts = resources
        .lock()
        .map_err(|_| ExportError::new("font_unavailable", "Export font cache is unavailable"))?;
    for (size, weight) in [(72., 800), (27., 450), (25., 800), (24., 450), (22., 450)] {
        let buffer = fonts.shape("bilikara 歌单导出 标题 点歌人 时间 项目地址 版本 0123456789 你好 日本語 。! ★ 😀 🌟 💖 🎶", size, weight, 1400., size * 1.25);
        let Fonts { system, cache, .. } = &mut *fonts;
        buffer.draw(system, cache, Color::rgb(0, 0, 0), |_, _, _, _, _| {});
    }
    Ok(())
}

pub(super) struct Canvas {
    height: usize,
    pixels: Vec<u8>,
}
impl Canvas {
    fn new(rows: usize) -> Result<Self, ExportError> {
        let height = rows
            .checked_mul(ROW_HEIGHT)
            .and_then(|v| v.checked_add(TABLE_Y + HEADER_HEIGHT + 24 + 256))
            .filter(|v| *v <= i32::MAX as usize)
            .ok_or_else(|| {
                ExportError::new("invalid_dimensions", "Export image dimensions overflow")
            })?
            .max(760);
        let length = WIDTH
            .checked_mul(height)
            .and_then(|v| v.checked_mul(3))
            .ok_or_else(|| {
                ExportError::new("invalid_dimensions", "Export image allocation overflows")
            })?;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(length)
            .map_err(|_| ExportError::new("allocation_failed", "Cannot allocate export image"))?;
        pixels.resize(length, 0);
        for (y, row) in pixels.chunks_exact_mut(WIDTH * 3).enumerate() {
            let t = y as f64 / (height - 1) as f64;
            for p in row.chunks_exact_mut(3) {
                p.copy_from_slice(&[
                    (250. - 7. * t) as u8,
                    (244. - 14. * t) as u8,
                    (235. - 25. * t) as u8,
                ]);
            }
        }
        Ok(Self { height, pixels })
    }
    fn blend(&mut self, x: i32, y: i32, color: Color) {
        if x < 0 || y < 0 || x as usize >= WIDTH || y as usize >= self.height {
            return;
        }
        let at = (y as usize * WIDTH + x as usize) * 3;
        let alpha = u32::from(color.a());
        for (i, c) in [color.r(), color.g(), color.b()].iter().enumerate() {
            self.pixels[at + i] =
                ((u32::from(*c) * alpha + u32::from(self.pixels[at + i]) * (255 - alpha) + 127)
                    / 255) as u8;
        }
    }
    fn rect(&mut self, x: i32, y: i32, width: i32, height: i32, radius: i32, fill: u32) {
        let color = Color::rgb((fill >> 16) as u8, (fill >> 8) as u8, fill as u8);
        for dy in 0..height {
            for dx in 0..width {
                let cx = dx.clamp(radius, width - radius - 1);
                let cy = dy.clamp(radius, height - radius - 1);
                if radius == 0 || (dx - cx).pow(2) + (dy - cy).pow(2) <= radius.pow(2) {
                    self.blend(x + dx, y + dy, color);
                }
            }
        }
    }
    pub(super) fn encode(self) -> Result<Vec<u8>, ExportError> {
        let mut bytes = Vec::new();
        let error = |_| ExportError::new("encoding_failed", "Export PNG encoding failed");
        {
            let mut encoder = png::Encoder::new(&mut bytes, WIDTH as u32, self.height as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(error)?;
            writer.write_image_data(&self.pixels).map_err(error)?;
            writer.finish().map_err(error)?;
        }
        Ok(bytes)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn render_page(
    entries: &[&ExportEntry],
    request: &ImageExportRequest,
    page: usize,
    count: usize,
    start: usize,
    range: &str,
    resources: &SharedFonts,
    missing: &mut BTreeSet<String>,
) -> Result<Canvas, ExportError> {
    let mut image = Canvas::new(entries.len())?;
    let mut fonts = resources
        .lock()
        .map_err(|_| ExportError::new("font_unavailable", "Export font cache is unavailable"))?;
    let table_height = (HEADER_HEIGHT + entries.len() * ROW_HEIGHT + 24) as i32;
    fonts.text(
        &mut image,
        84,
        94,
        &request.title,
        72.,
        800,
        1432.,
        1,
        0x1F1A16,
        missing,
    )?;
    fonts.text(
        &mut image,
        88,
        188,
        &format!(
            "共 {} 首 · 第 {page}/{count} 页 · {range}",
            request.entries.len()
        ),
        27.,
        450,
        1424.,
        1,
        0x77695E,
        missing,
    )?;
    image.rect(70, 292, 1460, table_height, 34, 0xEADDD0);
    image.rect(72, 294, 1456, table_height - 4, 32, 0xFFFCF7);
    image.rect(88, 310, 1424, 54, 24, 0xF5E7DA);
    let mut x = 94;
    for (label, width) in COLUMNS {
        fonts.text(
            &mut image,
            x,
            322,
            label,
            25.,
            800,
            (width - 18) as f32,
            1,
            0x8F3E2B,
            missing,
        )?;
        x += width;
    }
    for (index, entry) in entries.iter().enumerate() {
        let top = (TABLE_Y + HEADER_HEIGHT + index * ROW_HEIGHT) as i32;
        image.rect(
            88,
            top + 9,
            1424,
            88,
            18,
            if index % 2 == 0 { 0xFFFFFF } else { 0xFBF6EF },
        );
        let values = [
            (start + index + 1).to_string(),
            entry.image_title(),
            entry.video_id(),
            if entry.requester_name.is_empty() {
                "-".into()
            } else {
                entry.requester_name.clone()
            },
            if entry.owner_name.is_empty() {
                "-".into()
            } else {
                entry.owner_name.clone()
            },
            format_time(entry.timestamp, true)?,
        ];
        let mut x = 94;
        for (col, ((_, width), value)) in COLUMNS.iter().zip(values).enumerate() {
            fonts.text(
                &mut image,
                x,
                top + 17,
                &value,
                24.,
                450,
                (width - 18) as f32,
                3,
                match col {
                    0 => 0x8F3E2B,
                    1 => 0x1F1A16,
                    _ => 0x6F6258,
                },
                missing,
            )?;
            x += width;
        }
    }
    // Reuse P01's maintained QR encoder; preserve the footer's compact design.
    let code = crate::qr_image::encode_qr(PROJECT_URL)
        .map_err(|_| ExportError::new("encoding_failed", "Export footer QR encoding failed"))?;
    let cell = (154 / (code.width() + 4)).max(1) as i32;
    let qr_y = 292 + table_height + 44;
    image.rect(
        92,
        qr_y + 28,
        (code.width() as i32 + 4) * cell,
        (code.width() as i32 + 4) * cell,
        0,
        0xFFFCF7,
    );
    for y in 0..code.width() {
        for x in 0..code.width() {
            if code[(x, y)] == qrcode::Color::Dark {
                image.rect(
                    92 + (x as i32 + 2) * cell,
                    qr_y + 28 + (y as i32 + 2) * cell,
                    cell,
                    cell,
                    0,
                    0x1F1A16,
                );
            }
        }
    }
    fonts.text(
        &mut image,
        282,
        qr_y + 58 - cell,
        "项目地址",
        25.,
        800,
        1200.,
        1,
        0x8F3E2B,
        missing,
    )?;
    fonts.text(
        &mut image,
        282,
        qr_y + 100 - cell,
        PROJECT_URL,
        22.,
        450,
        1200.,
        1,
        0x8B7B6D,
        missing,
    )?;
    fonts.text(
        &mut image,
        282,
        qr_y + 132 - cell,
        &format!("版本 {}", request.app_version),
        22.,
        450,
        1200.,
        1,
        0xA99B8E,
        missing,
    )?;
    Ok(image)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../static/fonts/SourceHanSans-VF.ttf")
    }
    #[test]
    fn primary_weights_fallback_layout_and_prewarm_share_resources() {
        let first = font_resources(&path()).unwrap();
        prewarm_fonts(&path()).unwrap();
        assert!(Arc::ptr_eq(&first, &font_resources(&path()).unwrap()));
        let mut fonts = first.lock().unwrap();
        for weight in [450, 800] {
            let buffer = fonts.shape("A7你日。!", 24., weight, 500., 29.);
            for run in buffer.layout_runs() {
                for glyph in run.glyphs {
                    assert_ne!(glyph.glyph_id, 0);
                    assert_eq!(glyph.font_id, fonts.primary);
                    assert_eq!(glyph.font_weight, Weight(weight));
                }
            }
        }
        let mut normal = Canvas::new(0).unwrap();
        let mut bold = Canvas::new(0).unwrap();
        let mut absent = BTreeSet::new();
        fonts
            .text(
                &mut normal,
                0,
                0,
                "A7你好日本語",
                24.,
                450,
                500.,
                1,
                0,
                &mut absent,
            )
            .unwrap();
        fonts
            .text(
                &mut bold,
                0,
                0,
                "A7你好日本語",
                24.,
                800,
                500.,
                1,
                0,
                &mut absent,
            )
            .unwrap();
        assert!(absent.is_empty());
        assert_ne!(normal.pixels, bold.pixels);
        assert!(
            normal.pixels.iter().map(|v| u64::from(*v)).sum::<u64>()
                > bold.pixels.iter().map(|v| u64::from(*v)).sum::<u64>()
        );
        let unsupported = fonts.layout("A\u{10ffff}日", 24., 450, 500., 29., 3, &mut absent);
        assert!(absent.contains("U+10FFFF"));
        assert!(unsupported.lines[0].text().contains("[U+10FFFF]"));
        for text in ["😀", "🌟", "💖", "🎶", "★ ∑ →", "你好、日本語 Latin Café"]
        {
            let shaped = fonts.shape(text, 24., 450, 1000., 29.);
            for run in shaped.layout_runs() {
                for glyph in run.glyphs {
                    eprintln!(
                        "text={text}, glyph={}, font={:?}",
                        glyph.glyph_id,
                        fonts.system.db().face(glyph.font_id).map(|f| &f.families)
                    );
                }
            }
        }
        let buffer = fonts.shape("😀", 24., 450, 500., 29.);
        let available = buffer
            .layout_runs()
            .flat_map(|r| r.glyphs)
            .any(|g| g.glyph_id != 0 && g.font_id != fonts.primary);
        // Platform font availability is reported, never treated as text proof.
        eprintln!("Installed Emoji fallback for U+1F600: {available}");
        let mut missing = BTreeSet::new();
        let buffer = fonts.layout(
            &"长字段 Latin 日本語 🌟 ".repeat(30),
            24.,
            450,
            160.,
            29.,
            3,
            &mut missing,
        );
        assert_eq!(buffer.layout_runs().count(), 3);
        assert!(buffer.lines.last().unwrap().text().ends_with("..."));
        assert!(buffer.layout_runs().all(|r| r.line_w <= 160.));
        for separator in ["\n", "\r", "\r\n", "\n\r"] {
            let text = ["你好", "日", "A", "界界界界"].join(separator);
            let layout = fonts.layout(&text, 24., 450, 160., 29., 3, &mut missing);
            assert_eq!(layout.layout_runs().count(), 3);
            assert!(layout.lines.last().unwrap().text().ends_with("..."));
        }
        assert!(Canvas::new(usize::MAX).is_err());
    }
}
