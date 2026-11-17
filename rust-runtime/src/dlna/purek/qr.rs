// Adapted from bilikara-next 7750dca, native_host/purek/protocol.rs (MIT),
// and ChunK-Helper 3b00533, Qr/PureKQrParser.cs (MIT, (c) 2026 键盘Office).
// Rewritten with bounded, redacted inputs. See THIRD_PARTY_NOTICES.md.
//! Pure QR interpretation. No network access or authorization side effects.

use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::HashMap;

pub const MAX_QR_BYTES: usize = 32_768;
pub const MAX_TOKEN_BYTES: usize = 4_096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AddressClass {
    Private,
    Shared,
    LinkLocal,
    Hostname,
    LoopbackFixture,
}

pub(super) fn address_class(address: Ipv4Addr, policy: NetworkPolicy) -> Option<AddressClass> {
    if !policy.allows(address) {
        None
    } else if address.is_loopback() {
        Some(AddressClass::LoopbackFixture)
    } else if address.is_private() {
        Some(AddressClass::Private)
    } else if address.is_link_local() {
        Some(AddressClass::LinkLocal)
    } else {
        Some(AddressClass::Shared)
    }
}

/// Only these facts may enter a diagnostic record. Room values are ephemeral.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QrFacts {
    pub place_present: bool,
    pub bill_present: bool,
    pub token_present: bool,
    pub token_bytes: usize,
    pub name_present: bool,
    pub appid_present: bool,
    pub address_class: AddressClass,
    pub requires_address_confirmation: bool,
}

#[derive(Clone)]
pub struct Room {
    pub(super) description: Url,
    pub(super) token: String,
    authorization_url: String,
    name: String,
    pub(super) facts: QrFacts,
}

impl std::fmt::Debug for Room {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Room")
            .field("facts", &self.facts)
            .finish_non_exhaustive()
    }
}

impl Room {
    pub fn parse(raw: &str) -> Result<Self, PureKError> {
        Self::parse_on(raw, NetworkPolicy::Lan)
    }

    pub fn facts(&self) -> &QrFacts {
        &self.facts
    }

    /// Sensitive, for explicit local UI use only; never log or persist this URL.
    pub fn authorization_url(&self) -> &str {
        &self.authorization_url
    }

    /// Sensitive room label, for the local UI only, never diagnostic metadata.
    pub fn name(&self) -> &str {
        &self.name
    }

    pub(super) fn parse_on(raw: &str, policy: NetworkPolicy) -> Result<Self, PureKError> {
        let raw = raw.trim();
        if raw.len() > MAX_QR_BYTES || raw.chars().any(char::is_control) {
            return Err(invalid());
        }
        let outer = web(raw, "wx.chunk.cn", "/projection/login")?;
        let fields = query(&outer)?;
        let place = required(&fields, "place_code")?;
        let encoded = required(&fields, "projection_url")?
            .replace('-', "+")
            .replace('_', "/");
        let encoded: String = encoded.chars().filter(|c| *c != ' ').collect();
        let encoded = format!("{encoded}{}", "=".repeat((4 - encoded.len() % 4) % 4));
        let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
        let inner = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
        let inner = web(inner, "conn.dolphinstar.cn", "/Remote")
            .or_else(|_| web(&decode(inner, false)?, "conn.dolphinstar.cn", "/Remote"))?;
        let inner_fields = query(&inner)?;
        let mut description = safe_web(required(&inner_fields, "url")?)?;
        // Like ChunK's DescriptionUrl, accept receiver query/fragment syntax
        // without sending QR room/bill parameters to HTTP or multicast peers.
        description.set_query(None);
        description.set_fragment(None);
        // Intentional production policy: confirmation never permits public
        // literals or public DNS answers, keeping registration tokens on LAN.
        // Hostname confirmation only admits resolution to allowed IPv4 addresses.
        let class = match description.host() {
            Some(url::Host::Ipv4(address)) => address_class(address, policy).ok_or_else(invalid)?,
            Some(url::Host::Domain(host))
                if host.len() <= 253
                    && host.split('.').all(|part| {
                        !part.is_empty()
                            && part.len() <= 63
                            && !part.starts_with('-')
                            && !part.ends_with('-')
                            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    }) =>
            {
                AddressClass::Hostname
            }
            _ => return Err(invalid()),
        };
        let path = description.path().trim_end_matches('/');
        if !path.to_ascii_lowercase().ends_with("/description.xml") {
            let path = format!("{path}/description.xml");
            description.set_path(&path);
        }
        let token = required(&inner_fields, "token")?.to_owned();
        if token.len() > MAX_TOKEN_BYTES {
            return Err(invalid());
        }
        let name = inner_fields
            .get("name")
            .filter(|name| !name.trim().is_empty());
        if name.is_some_and(|name| name.chars().count() > 100) {
            return Err(invalid());
        }
        let facts = QrFacts {
            place_present: !place.is_empty(),
            bill_present: present(&fields, "bill_id"),
            token_present: true,
            token_bytes: token.len(),
            name_present: name.is_some(),
            appid_present: present(&inner_fields, "appid"),
            address_class: class,
            requires_address_confirmation: class == AddressClass::Hostname,
        };
        Ok(Self {
            description,
            token,
            authorization_url: outer.into(),
            name: name.cloned().unwrap_or_else(|| format!("房间 {place}")),
            facts,
        })
    }
}

fn invalid() -> PureKError {
    PureKError::new(PureKErrorCode::InvalidQr, PolicyError::InvalidUrl.into())
}

pub(super) fn safe_web(raw: &str) -> Result<Url, PureKError> {
    if raw.len() > MAX_QR_BYTES
        || raw.chars().any(char::is_control)
        || raw.contains(['\\', '<', '>', '"', '`'])
    {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Err(invalid());
    }
    // URL parsers otherwise normalize away some dangerous encoded characters.
    let path = decode(url.path(), false)?;
    decode(url.query().unwrap_or_default(), false)?;
    if path.chars().any(char::is_control) || path.contains(['\\', '<', '>', '"', '`']) {
        return Err(invalid());
    }
    Ok(url)
}

fn web(raw: &str, host: &str, path: &str) -> Result<Url, PureKError> {
    let mut url = safe_web(raw)?;
    if url.host_str() != Some(host) || !url.path().trim_end_matches('/').eq_ignore_ascii_case(path)
    {
        return Err(invalid());
    }
    url.set_fragment(None);
    Ok(url)
}

fn present(fields: &HashMap<String, String>, key: &str) -> bool {
    fields.get(key).is_some_and(|value| !value.is_empty())
}

fn required<'a>(fields: &'a HashMap<String, String>, key: &str) -> Result<&'a str, PureKError> {
    fields
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(invalid)
}

fn query(url: &Url) -> Result<HashMap<String, String>, PureKError> {
    let mut fields = HashMap::new();
    for pair in url
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|s| !s.is_empty())
    {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode(key, false)?.to_ascii_lowercase();
        let value = decode(value, key == "name")?;
        if fields.insert(key, value).is_some() {
            return Err(invalid());
        }
    }
    Ok(fields)
}

/// Percent-decode exactly once; only raw '+' in a name is a form space.
/// Malformed escapes remain errors, unlike ChunK's Uri.UnescapeDataString.
/// Keep this strict interpretation until actual InvalidQr samples justify it.
fn decode(value: &str, form: bool) -> Result<String, PureKError> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        bytes.push(match byte {
            b'%' => {
                let high = input
                    .next()
                    .and_then(|b| (b as char).to_digit(16))
                    .ok_or_else(invalid)?;
                let low = input
                    .next()
                    .and_then(|b| (b as char).to_digit(16))
                    .ok_or_else(invalid)?;
                ((high << 4) | low) as u8
            }
            b'+' if form => b' ',
            _ => byte,
        });
    }
    let decoded = String::from_utf8(bytes).map_err(|_| invalid())?;
    if decoded.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(decoded)
}
