//! Public YouTube watch extraction. No yt-dlp process, account cookies, D1 or
//! mutable playlist state. Signed URLs stay in memory for one cache attempt.
use bilikara_rust::media_source::{MediaSource, valid_youtube_id};
use bilikara_rust::youtube_selection::{YouTubeCodec, YouTubeFormat, select_youtube_formats};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Read;
use std::sync::{
    Arc, Mutex, TryLockError,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use url::Url;

const MAX_RESPONSE: usize = 6 * 1024 * 1024;
pub(crate) const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug, Clone)]
pub(crate) struct Error {
    pub code: &'static str,
    pub message: &'static str,
}
fn error(code: &'static str, message: &'static str) -> Error {
    Error { code, message }
}
fn invalid() -> Error {
    error(
        "youtube_response",
        "YouTube returned unsupported video data",
    )
}

#[derive(Debug, Clone)]
pub(crate) struct Metadata {
    pub source: MediaSource,
    pub title: String,
    pub author: String,
    pub duration: i64,
    pub cover_url: String,
}

#[derive(Debug, Clone)]
pub(crate) struct Streams {
    pub video_url: String,
    pub audio_url: String,
}

struct Watch {
    metadata: Metadata,
    player: Value,
    player_url: String,
    visitor: String,
}

fn client() -> Result<reqwest::blocking::Client, Error> {
    crate::http_client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| error("youtube_network", "Cannot initialize YouTube connection"))
}

fn read_text(response: reqwest::blocking::Response, cancel: &AtomicBool) -> Result<String, Error> {
    if !response.status().is_success() {
        return Err(error(
            "youtube_unavailable",
            "YouTube request denied; check network/region or try another public video",
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("youtube_network", "Cannot read YouTube response"))?;
    if cancel.load(Ordering::Acquire) {
        return Err(error("cancelled", "YouTube request cancelled"));
    }
    if bytes.len() > MAX_RESPONSE {
        return Err(invalid());
    }
    String::from_utf8(bytes).map_err(|_| invalid())
}

fn get(
    client: &reqwest::blocking::Client,
    url: &str,
    cancel: &AtomicBool,
) -> Result<String, Error> {
    if cancel.load(Ordering::Acquire) {
        return Err(error("cancelled", "YouTube request cancelled"));
    }
    let response = client
        .get(url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .map_err(|_| {
            error(
                "youtube_network",
                "Cannot connect to YouTube; check network access",
            )
        })?;
    read_text(response, cancel)
}

fn json_after(input: &str, markers: &[&str]) -> Option<Value> {
    markers.iter().find_map(|marker| {
        let start = input.find(marker)? + marker.len();
        Value::deserialize(&mut serde_json::Deserializer::from_str(
            input[start..].trim_start(),
        ))
        .ok()
    })
}

fn parse_watch(id: &str, html: &str) -> Result<Watch, Error> {
    let player = json_after(
        html,
        &[
            "var ytInitialPlayerResponse =",
            "ytInitialPlayerResponse =",
            "window[\"ytInitialPlayerResponse\"] =",
        ],
    )
    .ok_or_else(invalid)?;
    if player["playabilityStatus"]["status"] != "OK" {
        return Err(error(
            "youtube_unavailable",
            "This YouTube video is private, restricted, unavailable or requires login",
        ));
    }
    let details = &player["videoDetails"];
    if details["videoId"] != id {
        return Err(invalid());
    }
    if details["isLive"] == true || player["playabilityStatus"]["liveStreamability"].is_object() {
        return Err(error(
            "youtube_live",
            "Live YouTube streams are not supported; use a completed watch video",
        ));
    }
    let duration = details["lengthSeconds"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| (1..=86400).contains(n))
        .ok_or_else(invalid)?;
    let title = details["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(invalid)?;
    if title.len() > 8192 {
        return Err(invalid());
    }
    let player_path = json_after(html, &["\"jsUrl\":", "\"PLAYER_JS_URL\":"])
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let player_url = if player_path.starts_with("/s/player/") && !player_path.contains('\\') {
        format!("https://www.youtube.com{player_path}")
    } else {
        player_path
    };
    let metadata = Metadata {
        source: MediaSource::YouTube {
            video_id: id.into(),
        },
        title: title.into(),
        author: details["author"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(256)
            .collect(),
        duration,
        cover_url: format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),
    };
    let visitor = json_after(html, &["\"VISITOR_DATA\":", "\"visitorData\":"])
        .and_then(|v| v.as_str().map(str::to_owned))
        .filter(|s| s.len() < 4096)
        .unwrap_or_default();
    Ok(Watch {
        metadata,
        player,
        player_url,
        visitor,
    })
}

fn watch(
    client: &reqwest::blocking::Client,
    id: &str,
    cancel: &AtomicBool,
) -> Result<Watch, Error> {
    if !valid_youtube_id(id) {
        return Err(invalid());
    }
    let html = get(
        client,
        &format!("https://www.youtube.com/watch?v={id}&hl=en"),
        cancel,
    )?;
    parse_watch(id, &html)
}

pub(crate) fn metadata(id: &str) -> Result<Metadata, Error> {
    Ok(watch(&client()?, id, &AtomicBool::new(false))?.metadata)
}

// Pinned public client profile, following yt-dlp's current VISIONOS profile.
// It does not use Bilibili cookies or attempt to bypass login/region/DRM gates.
fn player_response(
    client: &reqwest::blocking::Client,
    id: &str,
    visitor: &str,
    cancel: &AtomicBool,
) -> Result<Value, Error> {
    const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    let body = json!({"videoId":id,"context":{"client":{
        "clientName":"VISIONOS","clientVersion":"1.02","deviceMake":"Apple","deviceModel":"RealityDevice17,1",
        "userAgent":UA,"osName":"visionOS","osVersion":"26.5.23O471","hl":"en","gl":"US","visitorData":visitor
    }},"contentCheckOk":true,"racyCheckOk":true,"playbackContext":{"contentPlaybackContext":{"html5Preference":"HTML5_PREF_WANTS"}}});
    let response = client
        .post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false")
        .header("User-Agent", UA)
        .header("Origin", "https://www.youtube.com")
        .header("X-YouTube-Client-Name", "101")
        .header("X-YouTube-Client-Version", "1.02")
        .header("X-Goog-Visitor-Id", visitor)
        .json(&body)
        .send()
        .map_err(|_| error("youtube_network", "Cannot connect to YouTube player API"))?;
    let value: Value =
        serde_json::from_str(&read_text(response, cancel)?).map_err(|_| invalid())?;
    if value["playabilityStatus"]["status"] != "OK" {
        return Err(error(
            "youtube_unavailable",
            "YouTube requires sign-in or blocked this network; public anonymous playback is unavailable",
        ));
    }
    if value["videoDetails"]["videoId"] != id {
        return Err(invalid());
    }
    Ok(value)
}

fn descriptor(index: usize, f: &Value) -> YouTubeFormat {
    let mime = f["mimeType"].as_str().unwrap_or("");
    let mut properties = mime.split(';');
    let container = properties.next().unwrap_or_default().trim();
    let codecs = properties
        .find_map(|p| p.trim().strip_prefix("codecs="))
        .unwrap_or_default()
        .trim_matches('"');
    let codec = if container == "video/mp4" && codecs.starts_with("avc1.") && !codecs.contains(',')
    {
        YouTubeCodec::Avc
    } else if container == "audio/mp4" && codecs == "mp4a.40.2" {
        YouTubeCodec::Aac
    } else {
        YouTubeCodec::Other
    };
    let track = &f["audioTrack"];
    YouTubeFormat {
        index,
        codec,
        height: f["height"].as_u64().unwrap_or(0).min(u64::from(u32::MAX)) as u32,
        fps: f["fps"].as_u64().unwrap_or(0).min(u64::from(u32::MAX)) as u32,
        bitrate: f["bitrate"].as_u64().unwrap_or(0),
        audio_channels: f["audioChannels"]
            .as_u64()
            .unwrap_or(0)
            .min(u64::from(u32::MAX)) as u32,
        original_audio: track["displayName"]
            .as_str()
            .is_some_and(|s| s.to_ascii_lowercase().contains("original")),
        default_audio: track["audioIsDefault"] == true || track.is_null(),
        protected: f.get("drmFamilies").is_some() || f.get("drmTrackType").is_some(),
    }
}

pub(crate) fn media_url_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|h| h.ends_with(".googlevideo.com"))
        && url.path() == "/videoplayback"
}

struct ChallengeUrl {
    url: Url,
    signature: Option<(String, String)>,
    n: Option<String>,
}
impl ChallengeUrl {
    fn from_format(format: &Value) -> Result<Self, Error> {
        let mut signature = None;
        let raw = if let Some(url) = format["url"].as_str() {
            url.to_owned()
        } else {
            let cipher = format["signatureCipher"]
                .as_str()
                .or(format["cipher"].as_str())
                .ok_or_else(invalid)?;
            let fields: std::collections::HashMap<_, _> =
                url::form_urlencoded::parse(cipher.as_bytes())
                    .into_owned()
                    .collect();
            let sig = fields
                .get("s")
                .filter(|v| !v.is_empty() && v.len() <= 4096)
                .ok_or_else(invalid)?;
            let key = fields.get("sp").map(String::as_str).unwrap_or("signature");
            if !["sig", "signature"].contains(&key) {
                return Err(invalid());
            }
            signature = Some((key.into(), sig.clone()));
            fields.get("url").ok_or_else(invalid)?.clone()
        };
        if raw.len() > 16384 {
            return Err(invalid());
        }
        let url = Url::parse(&raw).map_err(|_| invalid())?;
        if !media_url_allowed(&url) {
            return Err(invalid());
        }
        let n = url
            .query_pairs()
            .find(|(k, _)| k == "n")
            .map(|(_, v)| v.into_owned());
        Ok(Self { url, signature, n })
    }
    fn finish(mut self, solutions: &Value) -> Result<String, Error> {
        let mut pairs: Vec<(String, String)> = self
            .url
            .query_pairs()
            .into_owned()
            .filter(|(k, _)| k != "n")
            .collect();
        if let Some(n) = self.n {
            pairs.push(("n".into(), solution(solutions, "n", &n)?));
        }
        if let Some((key, sig)) = self.signature {
            pairs.retain(|(k, _)| *k != key);
            pairs.push((key, solution(solutions, "sig", &sig)?));
        }
        self.url.query_pairs_mut().clear().extend_pairs(pairs);
        Ok(self.url.into())
    }
}
fn solution(solutions: &Value, kind: &str, challenge: &str) -> Result<String, Error> {
    solutions[kind][challenge]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 4096 && !s.starts_with("enhanced_except_"))
        .map(str::to_owned)
        .ok_or_else(|| {
            error(
                "youtube_signature",
                "YouTube signature format changed; update bilikara",
            )
        })
}

fn solver_failure() -> Error {
    error(
        "youtube_signature",
        "Cannot resolve YouTube signature within resource limits; update bilikara or try again",
    )
}

fn with_bounded_vm<T>(
    cancel: Arc<AtomicBool>,
    run: impl for<'js> FnOnce(rquickjs::Ctx<'js>) -> Result<T, Error>,
) -> Result<T, Error> {
    // Meriyah's AST for current multi-megabyte players exceeds 128 MiB.
    // Serialize VMs so simultaneous cache jobs cannot multiply this peak.
    static SOLVER_SLOT: Mutex<()> = Mutex::new(());
    let admission_deadline = Instant::now() + Duration::from_secs(20);
    let _slot = loop {
        if cancel.load(Ordering::Acquire) || Instant::now() > admission_deadline {
            return Err(solver_failure());
        }
        match SOLVER_SLOT.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let failure = solver_failure;
    let runtime = rquickjs::Runtime::new().map_err(|_| failure())?;
    runtime.set_memory_limit(256 * 1024 * 1024);
    runtime.set_max_stack_size(2 * 1024 * 1024);
    let deadline = Instant::now() + Duration::from_secs(10);
    runtime.set_interrupt_handler(Some(Box::new(move || {
        cancel.load(Ordering::Acquire) || Instant::now() > deadline
    })));
    let context = rquickjs::Context::full(&runtime).map_err(|_| failure())?;
    // No module loader, filesystem, network, process or host callbacks. The
    // remotely supplied player can only compute strings in this bounded VM.
    context.with(run)
}

fn solve(player: &str, requests: Value, cancel: Arc<AtomicBool>) -> Result<Value, Error> {
    let failure = solver_failure;
    with_bounded_vm(cancel, |ctx| {
        ctx.eval::<(), _>(include_str!("../vendor/yt-dlp-ejs/yt.solver.lib.min.js"))
            .map_err(|_| failure())?;
        ctx.eval::<(), _>("Object.assign(globalThis, lib);")
            .map_err(|_| failure())?;
        ctx.eval::<(), _>(include_str!("../vendor/yt-dlp-ejs/yt.solver.core.min.js"))
            .map_err(|_| failure())?;
        ctx.globals()
            .set(
                "requestJson",
                json!({"type":"player", "player":player,"requests":requests}).to_string(),
            )
            .map_err(|_| failure())?;
        let output: String = ctx
            .eval("JSON.stringify(jsc(JSON.parse(requestJson)))")
            .map_err(|_| failure())?;
        if output.len() > 65536 {
            return Err(failure());
        }
        serde_json::from_str(&output).map_err(|_| failure())
    })
}

pub(crate) fn resolve(
    id: &str,
    quality: &str,
    cap: &str,
    cancel: Arc<AtomicBool>,
) -> Result<Streams, Error> {
    let client = client()?;
    let mut watch = watch(&client, id, &cancel)?;
    // Current WEB responses can contain only SABR metadata, without track URLs.
    // Use one bounded player request; never loop through clients or retries.
    let has_urls = watch.player["streamingData"]["adaptiveFormats"]
        .as_array()
        .is_some_and(|formats| {
            formats
                .iter()
                .any(|f| f["url"].is_string() || f["signatureCipher"].is_string())
        });
    if !has_urls {
        watch.player = player_response(&client, id, &watch.visitor, &cancel)?;
    }
    let formats = watch.player["streamingData"]["adaptiveFormats"]
        .as_array()
        .filter(|v| v.len() <= 256)
        .ok_or_else(|| {
            error(
                "youtube_formats",
                "No downloadable separate YouTube tracks; live/SABR/DRM streams are unsupported",
            )
        })?;
    let descriptors: Vec<_> = formats
        .iter()
        .enumerate()
        .map(|(i, f)| descriptor(i, f))
        .collect();
    let (v, a) = select_youtube_formats(&descriptors, quality, cap).ok_or_else(|| {
        error(
            "youtube_formats",
            "No compatible H.264 video + stereo AAC audio at the selected quality",
        )
    })?;
    let video = ChallengeUrl::from_format(&formats[v])?;
    let audio = ChallengeUrl::from_format(&formats[a])?;
    let mut requests = Vec::new();
    let mut kinds = Vec::new();
    for kind in ["n", "sig"] {
        let mut challenges = Vec::new();
        for track in [&video, &audio] {
            let challenge = if kind == "n" {
                track.n.as_ref()
            } else {
                track.signature.as_ref().map(|(_, s)| s)
            };
            if let Some(s) = challenge
                && !challenges.contains(s)
            {
                challenges.push(s.clone());
            }
        }
        if !challenges.is_empty() {
            kinds.push(kind);
            requests.push(json!({"type":kind,"challenges":challenges}));
        }
    }
    let mut solutions = json!({});
    if !requests.is_empty() {
        let parsed = Url::parse(&watch.player_url).map_err(|_| invalid())?;
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("www.youtube.com")
            || parsed.port().is_some()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || !parsed.path().starts_with("/s/player/")
            || !parsed.path().ends_with("/base.js")
        {
            return Err(invalid());
        }
        let player = get(&client, parsed.as_str(), &cancel)?;
        let output = solve(&player, json!(requests), cancel)?;
        for (index, kind) in kinds.iter().enumerate() {
            solutions[*kind] = output["responses"][index]["data"].clone();
        }
    }
    Ok(Streams {
        video_url: video.finish(&solutions)?,
        audio_url: audio.finish(&solutions)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_solver_transforms_both_challenges_without_a_cli() {
        let player = r#"(function(){
            function extract(url, key, sig) { var box = new Box(); box.set("alr","yes"); box.set("s",sig); return box; }
            function Box() { this.values = {}; }
            Box.prototype.set = function(k,v) { this.values[k]=v; };
            Box.prototype.get = function(k) { return this.values[k]; };
            Box.prototype.transform = function() { if(this.get("s")) this.set("s",this.get("s").split("").reverse().join("")); this.set("n","decoded-"+this.get("n")); };
        }).call(this);"#;
        let result = solve(
            player,
            json!([{"type":"sig","challenges":["abc"]},{"type":"n","challenges":["xyz"]}]),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(result["responses"][0]["data"]["abc"], "cba");
        assert_eq!(result["responses"][1]["data"]["xyz"], "decoded-xyz");
    }

    #[test]
    fn bounded_js_has_no_host_access_and_honors_cancellation() {
        let capabilities: String = with_bounded_vm(Arc::new(AtomicBool::new(false)), |ctx| {
            ctx.eval(
                "JSON.stringify([typeof fetch,typeof process,typeof require,typeof std,typeof os])",
            )
            .map_err(|_| solver_failure())
        })
        .unwrap();
        assert_eq!(
            capabilities,
            r#"["undefined","undefined","undefined","undefined","undefined"]"#
        );
        assert!(
            with_bounded_vm(Arc::new(AtomicBool::new(true)), |ctx| {
                ctx.eval::<(), _>("while(true) {}")
                    .map_err(|_| solver_failure())
            })
            .is_err()
        );
        assert!(
            solve(
                "invalid JavaScript!",
                json!([{"type":"n","challenges":["test"]}]),
                Arc::new(AtomicBool::new(false))
            )
            .is_err()
        );
    }

    #[test]
    #[ignore = "Explicit upstream player/signature compatibility smoke"]
    fn live_player_signature_solver() {
        let client = client().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let watch = watch(&client, "YE7VzlLtp-4", &cancel).unwrap();
        assert!(
            watch
                .player_url
                .starts_with("https://www.youtube.com/s/player/")
        );
        let player = get(&client, &watch.player_url, &cancel).unwrap();
        let challenge = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        let result = solve(
            &player,
            json!([{"type":"sig","challenges":[challenge]}]),
            cancel,
        )
        .unwrap();
        let sig = result["responses"][0]["data"][challenge]
            .as_str()
            .expect("signature solution");
        assert!(!sig.is_empty());
        assert!(sig.len() <= challenge.len());
    }

    #[test]
    fn html_json_parsing_and_video_identity_are_checked() {
        let html = r#"<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"videoDetails":{"videoId":"YE7VzlLtp-4","lengthSeconds":"123","title":"A }; escaped \\\" title","author":"Test"}}; var x=1;</script>"#;
        let watch = parse_watch("YE7VzlLtp-4", html).unwrap();
        assert_eq!(watch.metadata.duration, 123);
        assert_eq!(watch.metadata.author, "Test");
        assert!(parse_watch("abcdefghijk", html).is_err());
        assert!(parse_watch("YE7VzlLtp-4", &html.replace("\"OK\"", "\"LOGIN_REQUIRED\"")).is_err());
    }
    #[test]
    fn untrusted_stream_locations_and_wrong_formats_are_rejected() {
        for url in [
            "http://rr1.googlevideo.com/videoplayback",
            "https://127.0.0.1/videoplayback",
            "https://rr1.googlevideo.com.evil.invalid/videoplayback",
            "https://u:p@rr1.googlevideo.com/videoplayback",
        ] {
            assert!(ChallengeUrl::from_format(&json!({"url":url})).is_err());
        }
        assert_eq!(
            descriptor(
                0,
                &json!({"mimeType":"video/mp4; codecs=\"avc1.4d, mp4a.40.2\""})
            )
            .codec,
            YouTubeCodec::Other
        );
        assert_eq!(
            descriptor(1, &json!({"mimeType":"audio/mp4; codecs=\"mp4a.40.29\""})).codec,
            YouTubeCodec::Other
        );
    }
    #[test]
    fn cipher_and_n_are_encoded_without_duplicate_parameters() {
        let cipher = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs([
                (
                    "url",
                    "https://rr1.googlevideo.com/videoplayback?x=1&n=challenge",
                ),
                ("s", "secret"),
                ("sp", "sig"),
            ])
            .finish();
        let parsed = ChallengeUrl::from_format(&json!({"signatureCipher":cipher})).unwrap();
        let result = parsed
            .finish(&json!({"n":{"challenge":"done"},"sig":{"secret":"a+b"}}))
            .unwrap();
        assert!(result.contains("n=done"));
        assert!(result.contains("sig=a%2Bb"));
        assert!(!result.contains("challenge"));
    }
    #[test]
    #[ignore = "Explicit public YouTube network smoke; never part of the offline test suite"]
    fn live_public_watch() {
        let id = std::env::var("BILIKARA_TEST_YOUTUBE_VIDEO_ID")
            .unwrap_or_else(|_| "YE7VzlLtp-4".into());
        let metadata = metadata(&id).unwrap();
        eprintln!(
            "YouTube watch: id={id}, title={}, duration={}s",
            metadata.title, metadata.duration
        );
        let streams = resolve(&id, "360P 流畅", "", Arc::new(AtomicBool::new(false))).unwrap();
        eprintln!("YouTube native stream resolution: compatible video/audio pair obtained");
        let client = client().unwrap();
        for url in [streams.video_url, streams.audio_url] {
            let response = client
                .get(url)
                .header("Range", "bytes=0-4095")
                .send()
                .unwrap();
            assert!(
                response.status().is_success(),
                "media HTTP {}",
                response.status()
            );
            let mut bytes = Vec::new();
            response.take(4096).read_to_end(&mut bytes).unwrap();
            assert!(bytes.windows(4).any(|s| s == b"ftyp"));
            eprintln!(
                "YouTube media range: {} bytes, valid MP4 header",
                bytes.len()
            );
        }
    }
}
