//! Overlay of the composited cast: the Host page publishes the Audience
//! view-model (display-ready strings and expiry times); this module keeps the
//! latest one and rasterizes what is visible at production time into
//! premultiplied RGBA at the output size. Only content changes re-render.
//! A simulated mirror: same content and placement as the Audience window,
//! not its pixels or animations.
use crate::experimental_libav::{ProbeError, live_audio::OverlaySource};
use crate::native_host::ApiError;
use cosmic_text::{
    Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache, Weight, Wrap, fontdb,
};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

const MAX_FEEDBACK: usize = 2;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Toast {
    pub key: String,
    pub label: String,
    pub title: String,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Feedback {
    pub key: String,
    pub label: String,
    pub value: String,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Model {
    pub toast: Option<Toast>,
    pub feedback: Vec<Feedback>,
}

fn bounded(value: &Value, field: &str, max: usize) -> Result<String, ApiError> {
    let text = value[field]
        .as_str()
        .ok_or_else(|| ApiError::invalid("Invalid cast overlay"))?;
    if text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(ApiError::invalid("Invalid cast overlay"));
    }
    Ok(text.to_owned())
}
fn expiry(value: &Value, now_ms: u64) -> Result<u64, ApiError> {
    value["expires_at"]
        .as_u64()
        .filter(|at| *at <= now_ms + 60_000)
        .ok_or_else(|| ApiError::invalid("Invalid cast overlay expiry"))
}

impl Model {
    /// `{"toast": {key,label,title,expires_at} | null,
    ///   "feedback": [{key,label,value,expires_at}]}`; times are epoch ms.
    pub(crate) fn parse(body: &Value, now_ms: u64) -> Result<Self, ApiError> {
        let object = body
            .as_object()
            .filter(|o| o.keys().all(|k| k == "toast" || k == "feedback"))
            .ok_or_else(|| ApiError::invalid("Invalid cast overlay"))?;
        let toast = match object.get("toast") {
            None | Some(Value::Null) => None,
            Some(t) => Some(Toast {
                key: bounded(t, "key", 200)?,
                label: bounded(t, "label", 40)?,
                title: bounded(t, "title", 300)?,
                expires_at_ms: expiry(t, now_ms)?,
            }),
        };
        let feedback = match object.get("feedback") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(entries)) if entries.len() <= MAX_FEEDBACK => entries
                .iter()
                .map(|f| {
                    Ok(Feedback {
                        key: bounded(f, "key", 200)?,
                        label: bounded(f, "label", 40)?,
                        value: bounded(f, "value", 40)?,
                        expires_at_ms: expiry(f, now_ms)?,
                    })
                })
                .collect::<Result<_, ApiError>>()?,
            _ => return Err(ApiError::invalid("Invalid cast overlay")),
        };
        Ok(Self { toast, feedback })
    }
    fn visible(&self, now_ms: u64) -> Model {
        Model {
            toast: self.toast.clone().filter(|t| t.expires_at_ms > now_ms),
            feedback: self
                .feedback
                .iter()
                .filter(|f| f.expires_at_ms > now_ms)
                .cloned()
                .collect(),
        }
    }
}

/// The Host's latest published model, shared by every composited producer.
#[derive(Default)]
pub(crate) struct Hub {
    model: Mutex<Model>,
}
impl Hub {
    pub(crate) fn set(&self, model: Model) {
        *self.model.lock().unwrap_or_else(|e| e.into_inner()) = model;
    }
    fn get(&self) -> Model {
        self.model.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// One producer's view: re-renders when the visible content changes.
pub(crate) struct View {
    hub: Arc<Hub>,
    width: u32,
    height: u32,
    clock: Box<dyn Fn() -> u64 + Send + Sync>,
    state: Mutex<ViewState>,
}
struct ViewState {
    shown: Option<Model>,
    generation: u64,
    rgba: Vec<u8>,
}
impl View {
    pub(crate) fn new(hub: Arc<Hub>, width: u32, height: u32) -> Self {
        Self::with_clock(hub, width, height, Box::new(now_ms))
    }
    pub(crate) fn with_clock(
        hub: Arc<Hub>,
        width: u32,
        height: u32,
        clock: Box<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self {
            hub,
            width,
            height,
            clock,
            // Generation 0 is the empty overlay both sides start with.
            state: Mutex::new(ViewState {
                shown: Some(Model::default()),
                generation: 0,
                rgba: vec![0; width as usize * height as usize * 4],
            }),
        }
    }
    /// The current image when it changed since `known`: (generation, RGBA).
    pub(crate) fn refresh(&self, known: u64) -> Result<Option<(u64, Vec<u8>)>, String> {
        let visible = self.hub.get().visible((self.clock)());
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shown.as_ref() != Some(&visible) {
            state.rgba = render(&visible, self.width, self.height)?;
            state.shown = Some(visible);
            state.generation += 1;
        }
        Ok((state.generation != known).then(|| (state.generation, state.rgba.clone())))
    }
}
impl OverlaySource for View {
    fn read(
        &self,
        generation: &mut u64,
        rgba: &mut [u8],
        width: u32,
        height: u32,
    ) -> Result<(), ProbeError> {
        if (width, height) != (self.width, self.height) {
            return Err(ProbeError::BackendFailure("overlay size mismatch".into()));
        }
        let visible = self.hub.get().visible((self.clock)());
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shown.as_ref() != Some(&visible) {
            state.rgba = render(&visible, width, height).map_err(ProbeError::BackendFailure)?;
            state.shown = Some(visible);
            state.generation += 1;
        }
        if *generation != state.generation {
            rgba.copy_from_slice(&state.rgba);
            *generation = state.generation;
        }
        Ok(())
    }
}

// ---- rasterization -------------------------------------------------------

struct Fonts {
    system: FontSystem,
    cache: SwashCache,
    family: Option<String>,
}
static FONTS: OnceLock<Result<Mutex<Fonts>, String>> = OnceLock::new();

fn bundled_font() -> Option<PathBuf> {
    if let Some(path) = super::super::desktop::font_path() {
        return Some(path);
    }
    #[cfg(test)]
    {
        Some(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()?
                .join("static/fonts/SourceHanSans-VF.ttf"),
        )
    }
    #[cfg(not(test))]
    None
}

fn fonts() -> Result<&'static Mutex<Fonts>, String> {
    FONTS
        .get_or_init(|| {
            let mut db = fontdb::Database::new();
            let mut family = None;
            if let Some(path) = bundled_font()
                && let Ok(data) = std::fs::read(path)
            {
                let ids = db.load_font_source(fontdb::Source::Binary(Arc::new(data)));
                family = ids
                    .first()
                    .and_then(|id| db.face(*id))
                    .and_then(|face| face.families.first())
                    .map(|(name, _)| name.clone());
            }
            // Android ships Noto CJK in /system/fonts; desktops fill gaps.
            #[cfg(target_os = "android")]
            db.load_fonts_dir("/system/fonts");
            #[cfg(not(target_os = "android"))]
            db.load_system_fonts();
            if db.is_empty() {
                return Err("No font for the cast overlay".into());
            }
            Ok(Mutex::new(Fonts {
                system: FontSystem::new_with_locale_and_db("zh-CN".into(), db),
                cache: SwashCache::new(),
                family,
            }))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Loads the fonts off the producer thread; the first notice then draws
/// without stalling a frame (Android scans /system/fonts once).
pub(crate) fn prewarm() {
    std::thread::spawn(|| {
        let _ = fonts();
    });
}

struct Canvas {
    width: i32,
    height: i32,
    rgba: Vec<u8>,
}
impl Canvas {
    /// Source-over with a straight-alpha color and coverage in 0..=255.
    fn blend(&mut self, x: i32, y: i32, rgb: [u8; 3], alpha: u32) {
        if x < 0 || y < 0 || x >= self.width || y >= self.height || alpha == 0 {
            return;
        }
        let at = ((y * self.width + x) * 4) as usize;
        let p = &mut self.rgba[at..at + 4];
        let keep = 255 - alpha;
        for c in 0..3 {
            p[c] = ((u32::from(rgb[c]) * alpha + u32::from(p[c]) * keep + 127) / 255) as u8;
        }
        p[3] = (alpha + (u32::from(p[3]) * keep + 127) / 255) as u8;
    }
    /// `rect` is x, y, width, height.
    fn rounded(&mut self, rect: [f32; 4], r: f32, rgb: [u8; 3], alpha: f32) {
        let [x, y, w, h] = rect;
        let (x0, y0) = (x.floor() as i32, y.floor() as i32);
        let (x1, y1) = ((x + w).ceil() as i32, (y + h).ceil() as i32);
        for py in y0..y1 {
            for px in x0..x1 {
                // Signed distance to the rounded rectangle at the pixel center.
                let (cx, cy) = (
                    px as f32 + 0.5 - (x + w / 2.),
                    py as f32 + 0.5 - (y + h / 2.),
                );
                let (qx, qy) = (cx.abs() - (w / 2. - r), cy.abs() - (h / 2. - r));
                let outside = (qx.max(0.).powi(2) + qy.max(0.).powi(2)).sqrt();
                let distance = outside + qx.max(qy).min(0.) - r;
                let coverage = (0.5 - distance).clamp(0., 1.);
                self.blend(px, py, rgb, (coverage * alpha * 255.).round() as u32);
            }
        }
    }
}

struct Text {
    buffer: Buffer,
    width: f32,
    height: f32,
}
fn text(fonts: &mut Fonts, value: &str, size: f32, weight: u16, max_width: f32) -> Text {
    let shape = |fonts: &mut Fonts, value: &str| {
        let mut buffer = Buffer::new(&mut fonts.system, Metrics::new(size, size * 1.3));
        buffer.set_size(&mut fonts.system, None, None);
        buffer.set_wrap(&mut fonts.system, Wrap::None);
        let attrs = Attrs::new().weight(Weight(weight));
        let attrs = match &fonts.family {
            Some(name) => attrs.family(Family::Name(name)),
            None => attrs.family(Family::SansSerif),
        };
        buffer.set_text(&mut fonts.system, value, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut fonts.system, false);
        let width = buffer.layout_runs().map(|r| r.line_w).fold(0., f32::max);
        (buffer, width)
    };
    let mut current = value.trim().to_owned();
    let (mut buffer, mut width) = shape(fonts, &current);
    // Single line; an over-long title ends in an ellipsis.
    while width > max_width && !current.is_empty() {
        current.pop();
        (buffer, width) = shape(fonts, &format!("{}…", current.trim_end()));
    }
    Text {
        buffer,
        width,
        height: size * 1.3,
    }
}
fn draw(fonts: &mut Fonts, canvas: &mut Canvas, text: &Text, x: f32, y: f32, rgb: [u8; 3]) {
    let Fonts { system, cache, .. } = fonts;
    text.buffer.draw(
        system,
        cache,
        Color::rgb(rgb[0], rgb[1], rgb[2]),
        |dx, dy, w, h, color| {
            for py in 0..h as i32 {
                for px in 0..w as i32 {
                    canvas.blend(
                        x.round() as i32 + dx + px,
                        y.round() as i32 + dy + py,
                        rgb,
                        u32::from(color.a()),
                    );
                }
            }
        },
    );
}

const PANEL: [u8; 3] = [18, 18, 24];
const ACCENT: [u8; 3] = [255, 107, 154];
const VALUE: [u8; 3] = [124, 196, 255];
const WHITE: [u8; 3] = [255, 255, 255];
const MUTED: [u8; 3] = [200, 204, 214];

/// Premultiplied RGBA; the layout follows the Audience window at 1080p,
/// scaled to the output height.
pub(crate) fn render(model: &Model, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut canvas = Canvas {
        width: width as i32,
        height: height as i32,
        rgba: vec![0; width as usize * height as usize * 4],
    };
    if model.toast.is_none() && model.feedback.is_empty() {
        return Ok(canvas.rgba);
    }
    let mut fonts = fonts()?.lock().unwrap_or_else(|e| e.into_inner());
    let s = height as f32 / 1080.;
    if let Some(toast) = &model.toast {
        // Top-left request toast: accent label pill, then the title.
        let label = text(&mut fonts, &toast.label, 22. * s, 700, 300. * s);
        let title_max = width as f32 * 0.5 - label.width - 80. * s;
        let title = text(
            &mut fonts,
            &toast.title,
            32. * s,
            800,
            title_max.max(60. * s),
        );
        let (x, y, pad) = (32. * s, 32. * s, 18. * s);
        let pill_w = label.width + 24. * s;
        let pill_h = label.height + 6. * s;
        let card_h = title.height.max(pill_h) + pad * 2.;
        let card_w = pad + pill_w + 16. * s + title.width + pad;
        canvas.rounded([x, y, card_w, card_h], 16. * s, PANEL, 0.82);
        let pill_y = y + (card_h - pill_h) / 2.;
        canvas.rounded([x + pad, pill_y, pill_w, pill_h], pill_h / 2., ACCENT, 1.);
        draw(
            &mut fonts,
            &mut canvas,
            &label,
            x + pad + 12. * s,
            pill_y + 3. * s,
            WHITE,
        );
        let title_y = y + (card_h - title.height) / 2.;
        draw(
            &mut fonts,
            &mut canvas,
            &title,
            x + pad + pill_w + 16. * s,
            title_y,
            WHITE,
        );
    }
    // Right-edge operation cards, stacked around the vertical center.
    let size = 150. * s;
    let gap = 8. * s;
    let count = model.feedback.len().min(MAX_FEEDBACK) as f32;
    let top = height as f32 / 2. - (count * size + (count - 1.) * gap) / 2.;
    for (n, entry) in model.feedback.iter().take(MAX_FEEDBACK).enumerate() {
        let (x, y) = (width as f32 - 24. * s - size, top + n as f32 * (size + gap));
        canvas.rounded([x, y, size, size], 22. * s, PANEL, 0.82);
        let label = text(&mut fonts, &entry.label, 24. * s, 600, size - 16. * s);
        let value = text(&mut fonts, &entry.value, 40. * s, 800, size - 16. * s);
        draw(
            &mut fonts,
            &mut canvas,
            &label,
            x + (size - label.width) / 2.,
            y + 28. * s,
            MUTED,
        );
        draw(
            &mut fonts,
            &mut canvas,
            &value,
            x + (size - value.width) / 2.,
            y + 74. * s,
            VALUE,
        );
    }
    Ok(canvas.rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn alpha(rgba: &[u8], width: u32, x: u32, y: u32) -> u8 {
        rgba[((y * width + x) * 4 + 3) as usize]
    }

    #[test]
    fn parse_bounds_the_view_model() {
        let now = 1_000_000;
        let model = Model::parse(
            &json!({"toast":{"key":"a","label":"新点歌","title":"夜に駆ける","expires_at":now + 4200},
                "feedback":[{"key":"v","label":"音量","value":"35%","expires_at":now + 2000}]}),
            now,
        )
        .unwrap();
        assert_eq!(model.toast.as_ref().unwrap().title, "夜に駆ける");
        assert_eq!(model.feedback[0].value, "35%");
        for bad in [
            json!({"toast":{"key":"a","label":"x","title":"t","expires_at":now + 120_000}}),
            json!({"feedback":[{"key":"v","label":"x","value":"1"}]}),
            json!({"feedback":[{},{},{}]}),
            json!({"other":1}),
            json!({"toast":{"key":"a","label":"x","title":"line\nbreak","expires_at":now}}),
        ] {
            assert!(Model::parse(&bad, now).is_err(), "{bad}");
        }
    }

    #[test]
    fn views_render_visible_content_and_expire_it() {
        let hub = Arc::new(Hub::default());
        let now = Arc::new(std::sync::atomic::AtomicU64::new(10_000));
        let clock = now.clone();
        let view = View::with_clock(
            hub.clone(),
            640,
            360,
            Box::new(move || clock.load(std::sync::atomic::Ordering::SeqCst)),
        );
        assert!(
            view.refresh(0).unwrap().is_none(),
            "starts empty, like the encoder"
        );
        let first = 0;
        hub.set(Model {
            toast: Some(Toast {
                key: "k".into(),
                label: "新点歌".into(),
                title: "夜に駆ける — YOASOBI".into(),
                expires_at_ms: 14_200,
            }),
            feedback: vec![Feedback {
                key: "f".into(),
                label: "变调".into(),
                value: "+2".into(),
                expires_at_ms: 12_000,
            }],
        });
        let (second, shown) = view.refresh(first).unwrap().unwrap();
        // Toast card at the top-left, feedback card at the right edge.
        assert!(alpha(&shown, 640, 16, 16) > 150, "toast panel");
        assert!(alpha(&shown, 640, 640 - 30, 180) > 150, "feedback card");
        assert_eq!(alpha(&shown, 640, 320, 300), 0, "video stays clear");
        // Glyphs differ from the flat panel color.
        let panel = &shown[((16 * 640 + 16) * 4) as usize..][..3];
        assert!(
            shown
                .chunks_exact(4)
                .any(|p| p[3] > 200 && p[0] > 240 && p[1] > 240 && p[0] != panel[0])
        );
        now.store(13_000, std::sync::atomic::Ordering::SeqCst);
        let (_, toast_only) = view.refresh(second).unwrap().unwrap();
        assert_eq!(
            alpha(&toast_only, 640, 640 - 30, 180),
            0,
            "feedback expired"
        );
        assert!(alpha(&toast_only, 640, 16, 16) > 150);
        now.store(20_000, std::sync::atomic::Ordering::SeqCst);
        let (_, cleared) = view.refresh(0).unwrap().unwrap();
        assert!(cleared.iter().all(|b| *b == 0));
    }
}
