//! Approved S1 metadata projection. Retain fixed vocabulary and conservative
//! product codes, never descriptions, protocol extensions or arbitrary names.
use super::privacy::{bounded_metadata, bounded_model};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Brand,
    Stack,
    System,
}

struct Rule {
    name: &'static str,
    server_name: &'static str,
    aliases: &'static [&'static str],
    kind: Kind,
}
macro_rules! rule {
    ($name:literal,$display:literal,$kind:ident,[$($alias:literal),+]) => {
        Rule {name:$name,server_name:$display,kind:Kind::$kind,aliases:&[$($alias),+]}
    }
}
// The single whitelist: aliases are matched case-insensitively at word
// boundaries, except explicit CJK spellings which may adjoin Chinese prose.
const RULES: &[Rule] = &[
    rule!(
        "dolphinstar",
        "DolphinStar",
        Brand,
        ["DolphinStar", "海豚星空"]
    ),
    rule!("lebo", "LeBo", Brand, ["Hpplay", "LeBo", "Lelink", "乐播"]),
    rule!("purek", "PureK", Brand, ["PureK", "Pure K", "纯K", "ChunK"]),
    rule!("xiaomi", "Xiaomi", Brand, ["Xiaomi", "MiTV", "小米"]),
    rule!("huawei", "Huawei", Brand, ["Huawei", "华为"]),
    rule!("honor", "Honor", Brand, ["Honor", "荣耀"]),
    rule!("hisense", "Hisense", Brand, ["Hisense", "VIDAA", "海信"]),
    rule!("tcl", "TCL", Brand, ["TCL"]),
    rule!(
        "skyworth",
        "Skyworth",
        Brand,
        ["Skyworth", "Coocaa", "创维"]
    ),
    rule!("changhong", "Changhong", Brand, ["Changhong", "长虹"]),
    rule!("konka", "Konka", Brand, ["Konka", "康佳"]),
    rule!("sony", "Sony", Brand, ["Sony", "BRAVIA", "索尼"]),
    rule!("samsung", "Samsung", Brand, ["Samsung", "三星"]),
    rule!("lg", "LG", Brand, ["LG", "webOS"]),
    rule!("philips", "Philips", Brand, ["Philips", "飞利浦"]),
    rule!("sharp", "Sharp", Brand, ["Sharp", "夏普"]),
    rule!("dangbei", "Dangbei", Brand, ["Dangbei", "当贝"]),
    rule!("alibaba", "Alibaba", Brand, ["Alibaba", "天猫魔盒"]),
    rule!("tencent", "Tencent", Brand, ["Tencent", "腾讯极光"]),
    rule!(
        "google",
        "Google",
        Brand,
        ["Google", "Android TV", "AndroidTV", "Chromecast"]
    ),
    rule!("amazon", "Amazon", Brand, ["Amazon", "Fire TV", "FireTV"]),
    rule!("roku", "Roku", Brand, ["Roku"]),
    rule!("vlc", "VLC", Brand, ["VLC"]),
    rule!("bubbleupnp", "BubbleUPnP", Brand, ["BubbleUPnP"]),
    rule!("kodi", "Kodi", Brand, ["Kodi"]),
    rule!(
        "windows_media_player",
        "Windows Media Player",
        Brand,
        ["Windows Media Player", "Windows-Media-Player"]
    ),
    rule!("platinum", "Platinum", Stack, ["Platinum"]),
    rule!("libupnp", "libupnp", Stack, ["libupnp", "pupnp"]),
    rule!(
        "intel_upnp",
        "Intel UPnP",
        Stack,
        [
            "Intel UPnP",
            "Intel_UPnP",
            "IntelUPnP",
            "Intel SDK for UPnP"
        ]
    ),
    rule!(
        "microsoft_windows",
        "Microsoft-Windows",
        Stack,
        ["Microsoft-Windows"]
    ),
    rule!("linux", "Linux", System, ["Linux"]),
];

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Field {
    Manufacturer,
    ModelName,
    Server,
}

#[derive(Clone, Debug, Serialize)]
struct Hit {
    field: Field,
    rule: &'static str,
}

#[derive(Clone, Debug, Serialize)]
struct ServerProduct {
    name: &'static str,
    major: Option<u16>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub(super) struct RuleHits {
    is_purek_room: bool,
    is_lebo_receiver: bool,
    pub has_avtransport: Option<bool>,
    pub has_rendering_control: Option<bool>,
    pub declares_ts: Option<bool>,
    server_stack: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct Identification {
    brands: Vec<&'static str>,
    brand_matches: Vec<Hit>,
    model: String,
    server_products: Vec<ServerProduct>,
    pub rules: RuleHits,
}
impl Default for Identification {
    fn default() -> Self {
        Self {
            brands: vec!["unknown"],
            brand_matches: vec![],
            model: "unknown".into(),
            server_products: vec![ServerProduct {
                name: "unknown",
                major: None,
            }],
            rules: RuleHits::default(),
        }
    }
}

fn matches(text: &str, alias: &str) -> Option<usize> {
    text.match_indices(alias).find_map(|(at, _)| {
        let end = at + alias.len();
        let word = |c: char| c.is_alphanumeric() || c == '_';
        let left = alias
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        let right = alias
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        ((!left || !text[..at].chars().next_back().is_some_and(word))
            && (!right || !text[end..].chars().next().is_some_and(word)))
        .then_some(end)
    })
}

impl Identification {
    fn field(&mut self, field: Field, text: &str) {
        self.brand_matches.retain(|h| h.field != field);
        let text = bounded_metadata(text, 256).to_lowercase();
        if field == Field::Server {
            self.server_products.clear();
            self.rules.server_stack.clear();
        }
        for rule in RULES {
            let end = rule
                .aliases
                .iter()
                .filter_map(|a| matches(&text, &a.to_lowercase()))
                .min();
            if let Some(end) = end {
                self.brand_matches.push(Hit {
                    field,
                    rule: rule.name,
                });
                if field == Field::Server {
                    let major = if rule.kind == Kind::System {
                        None
                    } else {
                        server_major(&text[end..])
                    };
                    self.server_products.push(ServerProduct {
                        name: rule.server_name,
                        major,
                    });
                    if rule.kind == Kind::Stack {
                        self.rules.server_stack.push(rule.name);
                    }
                }
            }
        }
        if field == Field::Server && self.server_products.is_empty() {
            self.server_products.push(ServerProduct {
                name: "unknown",
                major: None,
            });
        }
        self.brands = RULES
            .iter()
            .filter(|r| self.brand_matches.iter().any(|h| h.rule == r.name))
            .map(|r| r.name)
            .collect();
        if self.brands.is_empty() {
            self.brands.push("unknown");
        }
        self.rules.is_purek_room =
            self.brands.contains(&"purek") || self.brands.contains(&"dolphinstar");
        self.rules.is_lebo_receiver = self.brands.contains(&"lebo");
    }
    pub fn server(&mut self, text: &str) {
        self.field(Field::Server, text);
    }
    pub fn description(&mut self, d: &super::super::dlna_policy::RendererDescription) {
        // Room/store names and free-form descriptions are not product evidence.
        // They retain only HMAC metadata at the diagnostic boundary.
        for (field, text) in [
            (Field::Manufacturer, &d.manufacturer),
            (Field::ModelName, &d.model_name),
        ] {
            self.field(field, text);
        }
        self.model = sanitize_model(&bounded_model(&d.model_name));
        self.rules.has_avtransport = Some(true);
        self.rules.has_rendering_control = Some(d.rendering_control.is_some());
    }
    pub fn summary(&self) -> String {
        let server = self
            .server_products
            .iter()
            .map(|p| {
                p.major
                    .map_or_else(|| p.name.to_owned(), |v| format!("{}/{v}", p.name))
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "brands={}; model={}; SERVER={server}",
            self.brands.join(", "),
            self.model
        )
    }
}

fn server_major(tail: &str) -> Option<u16> {
    let tail = tail.strip_prefix('/')?;
    let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 3 {
        return None;
    }
    let rest = &tail[digits.len()..];
    if rest
        .chars()
        .next()
        .is_some_and(|c| c != '.' && !c.is_whitespace() && c != ')' && c != ';')
    {
        return None;
    }
    digits.parse().ok()
}

fn sensitive_atom(atom: &str) -> bool {
    static PRIVATE: OnceLock<Regex> = OnceLock::new();
    // Deliberately unanchored: product prefixes can adjoin an address (IP192-...).
    let pattern=PRIVATE.get_or_init(||Regex::new(r"(?i)([0-9]{6,}|[0-9a-f]{8,}|(?:[0-9]{1,3}[-._]){3}[0-9]{1,3}|token|secret|password|room|place|bill|uuid|user|serial|\.mp4|\.exe)").expect("fixed private forms"));
    if atom.len() > 24 || pattern.is_match(atom) {
        return true;
    }
    if !atom
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
    {
        return true;
    }
    let compact: String = atom.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if compact.len() >= 8 && compact.bytes().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    if atom.len() >= 8
        && [STANDARD.decode(atom), URL_SAFE_NO_PAD.decode(atom)]
            .into_iter()
            .any(|v| {
                v.ok()
                    .and_then(|v| String::from_utf8(v).ok())
                    .is_some_and(|v| v.chars().all(|c| !c.is_control()))
            })
    {
        return true;
    }
    false
}

fn sanitize_model(text: &str) -> String {
    // A path/URL, encoded payload or key=value is not model syntax. Avoid
    // retaining isolated path components or values separated by whitespace.
    if text.chars().any(|c| "\\/:@%=+".contains(c)) {
        return "*".into();
    }
    let mut redact_next = false;
    let mut seen_brands = Vec::new();
    let words: Vec<String> = text
        .split_whitespace()
        .filter_map(|atom| {
            let label = matches!(
                atom.to_ascii_lowercase().as_str(),
                "token"
                    | "secret"
                    | "password"
                    | "room"
                    | "place_code"
                    | "bill_id"
                    | "user"
                    | "username"
                    | "serial"
                    | "sn"
                    | "path"
                    | "udn"
                    | "mac"
                    | "ip"
                    | "authorization"
            );
            let redact = redact_next || label;
            redact_next = label;
            if redact {
                return Some("*".into());
            }
            if sensitive_atom(atom) {
                return Some("*".into());
            }
            if let Some(rule) = RULES.iter().find(|r| {
                r.aliases
                    .iter()
                    .any(|a| a.is_ascii() && a.eq_ignore_ascii_case(atom))
            }) {
                if seen_brands.contains(&rule.name) {
                    return None;
                }
                seen_brands.push(rule.name);
                return Some(rule.server_name.to_owned());
            }
            const WORDS: &[&str] = &[
                "TV",
                "Smart",
                "Box",
                "Model",
                "Series",
                "Android",
                "Media",
                "Renderer",
                "Player",
                "Projector",
                "Stick",
                "Pro",
                "Ultra",
                "Max",
            ];
            if let Some(word) = WORDS.iter().find(|w| w.eq_ignore_ascii_case(atom)) {
                return Some((*word).into());
            }
            // A narrow public prefix exception, after the full atom's privacy
            // checks. Unknown mixed-case prefixes still fail closed.
            if atom
                .get(..5)
                .is_some_and(|p| p.eq_ignore_ascii_case("MiTV-"))
                && product_code(&atom[5..])
            {
                return Some(format!("MiTV-{}", &atom[5..]));
            }
            // Ordinary names/opaque words are not model codes. Require digits and
            // uppercase short product prefixes; unknown prose is fail-closed.
            Some(if product_code(atom) {
                atom.to_owned()
            } else {
                "*".into()
            })
        })
        .collect();
    let mut model = words.join(" ");
    model.truncate(model.len().min(48));
    let model = model.trim();
    if model.is_empty() {
        "unknown".into()
    } else {
        model.to_owned()
    }
}

fn product_code(atom: &str) -> bool {
    let prefix = atom.bytes().take_while(u8::is_ascii_alphabetic).count();
    atom.bytes().any(|c| c.is_ascii_digit())
        && atom.bytes().any(|c| c.is_ascii_alphabetic())
        && prefix <= 4
        && atom
            .bytes()
            .all(|c| !c.is_ascii_alphabetic() || c.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_whitelisted_alias_is_normalized_and_words_are_not_substring_matches() {
        for rule in RULES {
            for alias in rule.aliases {
                let mut id = Identification::default();
                id.field(
                    Field::Manufacturer,
                    &format!("  {}  ", alias.to_uppercase()),
                );
                assert!(id.brands.contains(&rule.name), "{alias}");
            }
        }
        for text in [
            "xsonyx",
            "notclue",
            "logo",
            "TCLsecret",
            "unlebon",
            "纯Kevin",
            "chromeCASTsecret",
            "notLinuxKernel",
        ] {
            let mut id = Identification::default();
            id.server(text);
            assert_eq!(id.brands, vec!["unknown"], "{text}");
        }
        let mut id = Identification::default();
        id.field(Field::Manufacturer, &format!("{} Sony", "x".repeat(256)));
        assert_eq!(id.brands, vec!["unknown"]);
    }
    #[test]
    fn server_exports_only_known_products_and_bounded_major_versions() {
        let mut id = Identification::default();
        id.server(
            "UnknownSecret/2 Linux/6.8.12 Platinum/1.0 Intel_UPnP/2.5 Microsoft-Windows/10.0",
        );
        assert_eq!(
            id.summary(),
            "brands=platinum, intel_upnp, microsoft_windows, linux; model=unknown; SERVER=Platinum/1, Intel UPnP/2, Microsoft-Windows/10, Linux"
        );
        id.server("Platinum/123456789.7");
        assert!(id.server_products[0].major.is_none());
        id.server("Platinum/1private-token");
        assert!(id.server_products[0].major.is_none());
        id.server("Secret/1.0");
        assert_eq!(id.brands, vec!["unknown"]);
    }
}
