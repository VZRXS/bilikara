//! Fail-closed diagnostic boundary. Unchecked text never enters reports.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::net::Ipv4Addr;

pub(super) struct Privacy([u8; 32]);

impl Privacy {
    pub fn new() -> Result<Self, super::DiagnosticError> {
        let mut key = [0; 32];
        getrandom::fill(&mut key).map_err(|_| super::DiagnosticError::EntropyUnavailable)?;
        Ok(Self(key))
    }

    /// RFC 2104 HMAC-SHA256, with a fixed 32-byte OS-random key. Domains
    /// prevent metadata, service and device identifiers from sharing a namespace.
    pub fn id(&self, domain: &str, value: &str) -> String {
        let digest = self.hmac(&[domain.as_bytes(), &[0], value.as_bytes()]);
        digest[..16].iter().map(|b| format!("{b:02x}")).collect()
    }

    fn hmac(&self, parts: &[&[u8]]) -> [u8; 32] {
        let mut inner_pad = [0x36; 64];
        let mut outer_pad = [0x5c; 64];
        for (i, byte) in self.0.iter().enumerate() {
            inner_pad[i] ^= byte;
            outer_pad[i] ^= byte;
        }
        let mut inner = Sha256::new();
        inner.update(inner_pad);
        for part in parts {
            inner.update(part);
        }
        let mut outer = Sha256::new();
        outer.update(outer_pad);
        outer.update(inner.finalize());
        outer.finalize().into()
    }

    pub fn metadata(&self, value: &str, limit: usize) -> Metadata {
        // Bound BEFORE hashing or retaining metadata. Discard controls, including
        // newlines/NUL; never keep a raw device name that might be a room/user.
        let bounded = bounded_metadata(value, limit);
        Metadata {
            digest: self.id("metadata", &bounded),
            characters: bounded.chars().count(),
            truncated: value
                .chars()
                .filter(|c| !diagnostic_control(*c))
                .take(limit + 1)
                .count()
                > limit,
            controls_removed: value.chars().any(diagnostic_control),
        }
    }
}

pub(super) fn bounded_metadata(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !diagnostic_control(*c))
        .take(limit.min(256))
        .collect()
}

pub(super) fn bounded_model(value: &str) -> String {
    value
        .chars()
        .filter_map(|c| {
            if c.is_whitespace() {
                Some(' ')
            } else if diagnostic_control(c) {
                None
            } else {
                Some(c)
            }
        })
        .take(256)
        .collect()
}

/// Only the diagnostic projection is normalized. Device/UI text stays intact.
fn diagnostic_control(c: char) -> bool {
    static FORMAT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    c.is_control()
        || FORMAT
            .get_or_init(|| regex::Regex::new(r"\p{Cf}").expect("fixed Unicode category"))
            .is_match(c.encode_utf8(&mut [0; 4]))
}

/// Even apparently innocuous friendlyName/model/SERVER can contain an arbitrary
/// token, user or room name. Export a session pseudonym, never their raw text.
#[derive(Clone, Debug, Serialize)]
pub struct Metadata {
    pub digest: String,
    pub characters: usize,
    pub truncated: bool,
    pub controls_removed: bool,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AddressClass {
    Private,
    LinkLocal,
    Shared,
    Public,
    Loopback,
    Unspecified,
    Multicast,
}

pub fn address_class(address: Ipv4Addr) -> AddressClass {
    let [a, b, ..] = address.octets();
    if address.is_unspecified() {
        AddressClass::Unspecified
    } else if address.is_multicast() {
        AddressClass::Multicast
    } else if address.is_loopback() {
        AddressClass::Loopback
    } else if address.is_private() {
        AddressClass::Private
    } else if address.is_link_local() {
        AddressClass::LinkLocal
    } else if a == 100 && (64..128).contains(&b) {
        AddressClass::Shared
    } else {
        AddressClass::Public
    }
}

pub(super) fn version(raw: &str) -> Option<String> {
    // Numeric components and known release channels only; never echo an
    // arbitrary build/OS label or a four-component IP literal.
    let (base, channel) = raw
        .split_once('-')
        .map_or((raw, None), |(base, suffix)| (base, Some(suffix)));
    let channel_ok = channel.is_none_or(|suffix| {
        suffix.split_once('.').is_some_and(|(name, n)| {
            matches!(name, "preview" | "alpha" | "beta" | "rc")
                && !n.is_empty()
                && n.len() <= 4
                && n.bytes().all(|b| b.is_ascii_digit())
        })
    });
    (raw.len() <= 40
        && channel_ok
        && (1..=3).contains(&base.split('.').count())
        && base.split('.').all(|part| {
            !part.is_empty() && part.len() <= 6 && part.bytes().all(|b| b.is_ascii_digit())
        }))
    .then(|| raw.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hmac_sha256_matches_rfc4231_case_two() {
        let mut key = [0; 32];
        key[..4].copy_from_slice(b"Jefe");
        let result = Privacy(key).hmac(&[b"what do ya want for nothing?"]);
        let hex: String = result.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }
}
