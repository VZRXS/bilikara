//! Pure validation for the iOS main-frame system bridge. No business state.
use serde::Deserialize;
use url::Url;

#[derive(Clone)]
pub(crate) struct HostFramePolicy {
    origin: url::Origin,
    port: u16,
}

impl HostFramePolicy {
    pub fn new(bootstrap: &str) -> Result<Self, &'static str> {
        let url = Url::parse(bootstrap).map_err(|_| "ios_bridge_origin")?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.port().is_some_and(|port| port > 0)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("ios_bridge_origin");
        }
        Ok(Self {
            origin: url.origin(),
            port: url.port().unwrap(),
        })
    }
    pub fn origin(&self) -> String {
        self.origin.ascii_serialization()
    }
    pub fn allows_origin(&self, scheme: &str, host: &str, port: i64) -> bool {
        scheme == "http" && host == "127.0.0.1" && port == i64::from(self.port)
    }
    pub fn allows(
        &self,
        main_frame: bool,
        same_webview: bool,
        source: &str,
        current: &str,
    ) -> bool {
        let allowed = |value| {
            Url::parse(value).is_ok_and(|url| {
                url.origin() == self.origin
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && matches!(url.path(), "/" | "/index.html")
            })
        };
        main_frame && same_webview && allowed(source) && allowed(current)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub schema_version: u32,
    pub document_id: String,
    pub id: u32,
    pub action: String,
    pub url: Option<String>,
    pub active: Option<bool>,
    pub dock: Option<Dock>,
    pub export: Option<ExportOptions>,
    pub json_request: Option<serde_json::Value>,
}

impl Request {
    pub fn parse(body: &str) -> Result<Self, &'static str> {
        if body.len() > 600 * 1024 {
            return Err("ios_platform_request");
        }
        let request: Self = serde_json::from_str(body).map_err(|_| "ios_platform_request")?;
        if request.schema_version != 1
            || (request.id == 0 && !matches!(request.action.as_str(), "document" | "retire"))
            || request.document_id.len() != 32
            || !request.document_id.bytes().all(|b| b.is_ascii_hexdigit())
            || !matches!(
                request.action.as_str(),
                "open-bilibili-login"
                    | "open-bilibili-video"
                    | "cancel"
                    | "set-player-fullscreen"
                    | "document"
                    | "retire"
                    | "sync-dock"
                    | "save-history"
                    | "request-json"
            )
        {
            return Err("ios_platform_request");
        }
        let fields_valid = match request.action.as_str() {
            "request-json" => {
                request.url.is_none()
                    && request.active.is_none()
                    && request
                        .json_request
                        .as_ref()
                        .is_some_and(serde_json::Value::is_object)
            }
            "save-history" => {
                request.url.is_none()
                    && request.active.is_none()
                    && request.export.as_ref().is_some_and(ExportOptions::valid)
            }
            "sync-dock" => {
                request.active.is_none()
                    && request.url.is_none()
                    && request.dock.as_ref().is_some_and(Dock::valid)
            }
            "open-bilibili-login" => request.active.is_none(),
            "open-bilibili-video" => {
                request.active.is_none()
                    && request
                        .url
                        .as_deref()
                        .is_some_and(|value| video_url(value).is_ok())
            }
            "set-player-fullscreen" => request.active.is_some() && request.url.is_none(),
            _ => request.active.is_none() && request.url.is_none(),
        };
        if !fields_valid
            || (request.action != "sync-dock" && request.dock.is_some())
            || (request.action != "save-history" && request.export.is_some())
            || (request.action != "request-json" && request.json_request.is_some())
            || (request.action != "request-json" && body.len() > 8192)
        {
            return Err("ios_platform_request");
        }
        Ok(request)
    }
}

/// Save-only options. No caller paths, arbitrary URLs or supplied record data.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportOptions {
    pub format: String,
    pub source: String,
    pub page_size: usize,
}
impl ExportOptions {
    fn valid(&self) -> bool {
        ["csv", "image"].contains(&self.format.as_str())
            && [50, 60, 80, 100, 150, 200].contains(&self.page_size)
            && !self.source.is_empty()
            && self.source.len() <= 140
            && self
                .source
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    }
}

/// Presentation facts only; no arbitrary native selectors or navigation URLs.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Dock {
    pub visible: bool,
    #[serde(default = "dock_interactive_default")]
    pub interactive: bool,
    #[serde(default)]
    pub modal_covered: bool,
    #[serde(default)]
    pub sequence: u32,
    #[serde(default)]
    pub back_enabled: bool,
    #[serde(default)]
    pub back_exclusions: Vec<[f64; 4]>,
    pub selected: usize,
    pub labels: Vec<String>,
    pub viewport_width: f64,
    pub viewport_height: f64,
    pub dark: bool,
    pub accent: [u8; 3],
}
fn dock_interactive_default() -> bool {
    true
}
impl Dock {
    fn valid(&self) -> bool {
        self.back_exclusions.len() <= 96
            && self.back_exclusions.iter().all(|rect| {
                rect.iter()
                    .all(|v| v.is_finite() && (0.0..=10000.0).contains(v))
            })
            && (!self.back_enabled || (self.visible && self.interactive && !self.modal_covered))
            && self.sequence < u32::MAX
            && !(self.modal_covered && self.interactive)
            && self.selected < 5
            && self.labels.len() == 5
            && self.labels.iter().all(|v| {
                !v.is_empty() && v.chars().count() <= 64 && !v.chars().any(char::is_control)
            })
            && [self.viewport_width, self.viewport_height]
                .iter()
                .all(|v| v.is_finite() && (100.0..=10000.0).contains(v))
    }
}

// Only the active document may operate UIKit. WK messages are ordered, but an
// asynchronous old completion or a BFCache page must not revive retired UI.
#[derive(Default)]
pub(crate) struct DocumentSession {
    active: Option<String>,
    retired: std::collections::VecDeque<String>,
}

impl DocumentSession {
    pub fn is_current(&self, document: &str) -> bool {
        self.active.as_deref() == Some(document)
    }
    pub fn accept(&mut self, request: &Request) -> bool {
        self.accept_message(&request.document_id, &request.action)
    }
    pub fn accept_message(&mut self, document: &str, action: &str) -> bool {
        if self.retired.iter().any(|old| old == document) {
            return false;
        }
        if action == "document" {
            if !self.is_current(document) {
                self.retire();
                self.active = Some(document.into());
            }
            return true;
        }
        if !self.is_current(document) {
            return false;
        }
        if action == "retire" {
            self.retire();
        }
        true
    }

    fn retire(&mut self) {
        if let Some(old) = self.active.take() {
            self.retired.push_back(old);
            // Requests and callbacks are independently bounded/timed out.
            if self.retired.len() > 16 {
                self.retired.pop_front();
            }
        }
    }
}

pub(crate) fn video_url(value: &str) -> Result<Url, &'static str> {
    let invalid = "ios_video_url";
    if value.len() > 128 {
        return Err(invalid);
    }
    let tail = value
        .strip_prefix("https://www.bilibili.com/video/")
        .ok_or(invalid)?;
    let (bvid, query) = tail
        .split_once('?')
        .map_or((tail, None), |(b, q)| (b, Some(q)));
    if bvid.len() != 12
        || !bvid.starts_with("BV")
        || !bvid.bytes().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(invalid);
    }
    if let Some(query) = query {
        let page = query.strip_prefix("p=").ok_or(invalid)?;
        let parsed = page.parse::<u32>().map_err(|_| invalid)?;
        if parsed == 0 || parsed > i32::MAX as u32 || parsed.to_string() != page {
            return Err(invalid);
        }
    }
    let url = Url::parse(value).map_err(|_| invalid)?;
    if url.as_str() != value {
        return Err(invalid);
    }
    Ok(url)
}

pub(crate) fn login_url(value: &str) -> Result<Url, &'static str> {
    if value.len() > 4096
        || value.trim() != value
        || value.chars().any(char::is_control)
        || value.contains('\\')
    {
        return Err("ios_login_url");
    }
    let url = Url::parse(value).map_err(|_| "ios_login_url")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.fragment().is_some()
        || !matches!(
            url.host_str(),
            Some("account.bilibili.com" | "passport.bilibili.com")
        )
    {
        return Err("ios_login_url");
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    #[test]
    fn video_only_handoff_keeps_login_authorization_separate() {
        let base = "https://www.bilibili.com/video/BV1yyjzzCEQn";
        assert!(video_url(base).is_ok());
        assert!(video_url(&format!("{base}?p=2")).is_ok());
        assert!(login_url(base).is_err());
        for value in [
            "http://www.bilibili.com/video/BV1yyjzzCEQn",
            "https://www.bilibili.com:443/video/BV1yyjzzCEQn",
            "https://www.bilibili.com:8443/video/BV1yyjzzCEQn",
            "https://evil@www.bilibili.com/video/BV1yyjzzCEQn",
            "https://www.bilibili.com.evil.test/video/BV1yyjzzCEQn",
            "https://account.bilibili.com/login",
            "javascript:alert(1)",
            "file:///video/BV1yyjzzCEQn",
            "https://www.bilibili.com/video/BV1",
            "https://www.bilibili.com/video/BV1yyjzzCEQn/",
        ] {
            assert!(video_url(value).is_err(), "{value}");
        }
        for suffix in [
            "?p=0",
            "?p=-1",
            "?p=01",
            "?p=1.5",
            "?p=2147483648",
            "?p=2&p=3",
            "?redirect=x",
            "#fragment",
            "?p=2&redirect=x",
        ] {
            assert!(video_url(&format!("{base}{suffix}")).is_err());
        }
        assert!(video_url(&format!("{base}{}", "x".repeat(200))).is_err());
        let body = serde_json::json!({"schema_version":1,"document_id":"a".repeat(32),"id":1,"action":"open-bilibili-video","url":base});
        assert!(Request::parse(&body.to_string()).is_ok());
        let mut wrong = body.clone();
        wrong["active"] = serde_json::json!(true);
        assert!(Request::parse(&wrong.to_string()).is_err());
        wrong = body;
        wrong["url"] = serde_json::json!("https://account.bilibili.com/login");
        assert!(Request::parse(&wrong.to_string()).is_err());
    }
    use super::*;
    #[test]
    fn export_accepts_save_options_without_paths_records_or_unbounded_work() {
        let good = serde_json::json!({"schema_version":1,"document_id":"a".repeat(32),"id":1,"action":"save-history",
          "export":{"format":"image","source":"played-2026.json","pageSize":50}});
        assert!(Request::parse(&good.to_string()).is_ok());
        for (key, value) in [
            ("format", serde_json::json!("exe")),
            ("pageSize", serde_json::json!(1)),
            ("source", serde_json::json!("../host-state.json")),
            ("path", serde_json::json!("/private/file")),
            ("rows", serde_json::json!([])),
        ] {
            let mut bad = good.clone();
            bad["export"][key] = value;
            assert!(Request::parse(&bad.to_string()).is_err());
        }
        let mut bad = good;
        bad["action"] = serde_json::json!("sync-dock");
        assert!(Request::parse(&bad.to_string()).is_err());
    }

    #[test]
    fn native_dock_accepts_only_bounded_five_page_presentation() {
        let good = serde_json::json!({"schema_version":1,"document_id":"a".repeat(32),"id":1,"action":"sync-dock",
            "dock":{"visible":true,"selected":0,"labels":["播放","队列","点歌","本场用户","我的"],"viewport_width":393,"viewport_height":844,"dark":false,"accent":[200,80,55]}});
        let dock = Request::parse(&good.to_string()).unwrap().dock.unwrap();
        assert!(dock.visible);
        assert!(!dock.dark);
        assert_eq!(dock.accent, [200, 80, 55]);
        for (key, value) in [
            ("selected", serde_json::json!(5)),
            ("labels", serde_json::json!(["One"])),
            ("viewport_width", serde_json::json!(0)),
            ("viewport_height", serde_json::json!(10001)),
            ("accent", serde_json::json!([256, 0, 0])),
            ("back_exclusions", serde_json::json!([[0, -1, 20, 30]])),
            (
                "back_exclusions",
                serde_json::json!(vec![[0, 1, 20, 30]; 97]),
            ),
            ("url", serde_json::json!("http://evil.invalid")),
        ] {
            let mut bad = good.clone();
            bad["dock"][key] = value;
            assert!(Request::parse(&bad.to_string()).is_err(), "{key}");
        }
        let mut bad = good.clone();
        bad["action"] = serde_json::json!("document");
        bad["id"] = serde_json::json!(0);
        assert!(Request::parse(&bad.to_string()).is_err());
        let mut bad = good;
        bad["dock"]["labels"][0] = serde_json::json!("x".repeat(65));
        assert!(Request::parse(&bad.to_string()).is_err());
    }

    #[test]
    fn only_native_created_origin_and_main_host_paths_can_call_system_actions() {
        let policy = HostFramePolicy::new("http://127.0.0.1:12345/bootstrap/private").unwrap();
        assert_eq!(policy.origin(), "http://127.0.0.1:12345");
        let host = "http://127.0.0.1:12345/";
        assert!(policy.allows(true, true, host, host));
        assert!(policy.allows(true, true, "http://127.0.0.1:12345/index.html", host));
        assert!(!policy.allows(false, true, host, host));
        assert!(!policy.allows(true, false, host, host));
        assert!(policy.allows_origin("http", "127.0.0.1", 12345));
        assert!(!policy.allows_origin("http", "127.0.0.1", 12346));
        assert!(!policy.allows_origin("https", "127.0.0.1", 12345));
        for url in [
            "https://account.bilibili.com/login",
            "http://127.0.0.1:12346/",
            "http://localhost:12345/",
            "http://127.0.0.1:12345/remote",
            "http://127.0.0.1:12345/controller.html",
            "http://127.0.0.1:12345/?redirect=1",
            "http://user@127.0.0.1:12345/",
            "http://127.0.0.1:12345/#iframe",
            "about:blank",
            "tauri://localhost/ios-startup.html",
        ] {
            assert!(!policy.allows(true, true, url, host), "{url}");
            assert!(!policy.allows(true, true, host, url), "{url}");
        }
    }
    #[test]
    fn login_opener_is_https_two_hosts_without_credentials_ports_or_schemes() {
        for url in [
            "https://account.bilibili.com/login",
            "https://passport.bilibili.com:443/h5-app/passport/login/scan?key=test",
        ] {
            assert!(login_url(url).is_ok());
        }
        for url in [
            "https://www.bilibili.com/",
            "http://account.bilibili.com/login",
            "https://account.bilibili.com.evil.test/",
            "https://account.bilibili.com@evil.test/",
            "https://user:password@account.bilibili.com/",
            "https://passport.bilibili.com:444/",
            "weixin://login",
            "javascript:alert(1)",
            "file:///private/data",
            "https://passport.bilibili.com/#credential",
            " https://account.bilibili.com/",
            "https://account.bilibili.com/\n",
            "https://account.bilibili.com\\@evil.test/",
        ] {
            assert!(login_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn json_transport_is_typed_and_cannot_add_ui_or_export_fields() {
        let base = serde_json::json!({"schema_version":1,"document_id":"a".repeat(32),"id":7,
            "action":"request-json","json_request":{"method":"POST","path":"/api/player/control","client_id":"fixture","body":{"action":"pause"}}});
        assert!(Request::parse(&base.to_string()).is_ok());
        for (key, value) in [
            ("url", serde_json::json!("http://example.invalid/")),
            ("active", serde_json::json!(true)),
            ("dock", serde_json::json!({})),
            (
                "export",
                serde_json::json!({"format":"csv","source":"history","pageSize":50}),
            ),
            ("json_request", serde_json::json!([])),
        ] {
            let mut bad = base.clone();
            bad[key] = value;
            assert!(Request::parse(&bad.to_string()).is_err());
        }
        let mut bad = base.clone();
        bad["action"] = serde_json::json!("cancel");
        assert!(Request::parse(&bad.to_string()).is_err());
        let mut large = base;
        large["json_request"]["body"]["data"] = serde_json::json!("x".repeat(600 * 1024));
        assert!(Request::parse(&large.to_string()).is_err());
    }

    #[test]
    fn wire_requests_are_bounded_typed_and_reject_unknown_actions_and_fields() {
        let request = serde_json::json!({"schema_version":1,"document_id":"a".repeat(32),"id":1,
            "action":"open-bilibili-login","url":"https://account.bilibili.com/login"});
        assert!(Request::parse(&request.to_string()).is_ok());
        for (key, value) in [
            ("schema_version", serde_json::json!(2)),
            ("document_id", serde_json::json!("old")),
            ("id", serde_json::json!(0)),
            ("id", serde_json::json!(4294967296_u64)),
            ("action", serde_json::json!("open-any-url")),
            ("private_field", serde_json::json!("secret")),
        ] {
            let mut bad = request.clone();
            bad[key] = value;
            assert!(Request::parse(&bad.to_string()).is_err());
        }
        assert!(Request::parse(&"x".repeat(8193)).is_err());
    }

    #[test]
    fn fullscreen_has_typed_fields_and_only_active_documents_can_change_ui() {
        let base = serde_json::json!({"schema_version":1,"document_id":"a".repeat(32),"id":1,
            "action":"set-player-fullscreen","active":true});
        let parsed = |value: &serde_json::Value| Request::parse(&value.to_string()).unwrap();
        let mut session = DocumentSession::default();
        assert!(!session.accept(&parsed(&base)));
        let mut document = base.clone();
        document["id"] = serde_json::json!(0);
        document["action"] = serde_json::json!("document");
        document.as_object_mut().unwrap().remove("active");
        assert!(session.accept(&parsed(&document)));
        assert!(session.is_current(&"a".repeat(32)));
        assert!(session.accept(&parsed(&document))); // Re-announcing is idempotent.
        assert!(session.accept(&parsed(&base)));
        let mut retire = document.clone();
        retire["action"] = serde_json::json!("retire");
        assert!(session.accept(&parsed(&retire)));
        assert!(!session.accept(&parsed(&base)));
        assert!(!session.accept(&parsed(&document)));
        document["document_id"] = serde_json::json!("b".repeat(32));
        assert!(session.accept(&parsed(&document)));
        assert!(!session.accept(&parsed(&retire)));
        let mut bad = base.clone();
        bad["active"] = serde_json::json!("true");
        assert!(Request::parse(&bad.to_string()).is_err());
        bad["active"] = serde_json::json!(false);
        bad["url"] = serde_json::json!("https://account.bilibili.com/");
        assert!(Request::parse(&bad.to_string()).is_err());
        bad.as_object_mut().unwrap().remove("url");
        bad.as_object_mut().unwrap().remove("active");
        assert!(Request::parse(&bad.to_string()).is_err());
    }
}
