// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna.rs. See THIRD_PARTY_NOTICES.md.
//! Media-backend-independent native DLNA I/O. Session ownership stays with
//! AppState; these operations return typed, recordable facts for its worker.

pub mod cast_http;
pub mod control;
pub mod diagnostics;
pub mod discovery;
pub mod purek;
#[cfg(test)]
mod test_support;

pub use bilikara_rust::dlna_policy;
pub use tokio_util::sync::CancellationToken;

use dlna_policy::{LocalSourceKind, NetworkPolicy, PolicyError, RendererDescription, SoapAction};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};
use url::Url;

pub const HTTP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Renderer {
    pub description: RendererDescription,
    /// Selected source (including interface fallback), verified as local.
    pub local_address: Ipv4Addr,
    pub context: DeviceContext,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscoverySource {
    SearchResponse,
    Notify,
    Manual,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteFacts {
    pub selection: Option<LocalSourceKind>,
    pub routed_source_is_local: Option<bool>,
    pub route_matches_selected: Option<bool>,
    pub route_matches_reply: Option<bool>,
}

/// Correlates stages without exposing LOCATION, addresses or raw USN/UDN.
/// SERVER is untrusted, truncated metadata; diagnostic exporters must redact
/// embedded identifiers just as they do manufacturer/model/friendlyName.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceContext {
    /// SHA-256 first 16 bytes, from canonical advertised USN or normalized URL.
    /// Remains unchanged when a missing UDN is learned from the description.
    pub device_key: String,
    pub udn_hash: Option<String>,
    pub source: DiscoverySource,
    pub server: String,
    pub route: Option<RouteFacts>,
}

fn identifier_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl DeviceContext {
    fn new(source: DiscoverySource, location: &str, usn: &str, server: &str) -> Self {
        let usn = dlna_policy::canonical_usn(usn);
        let udn_hash = (!usn.is_empty()).then(|| identifier_hash(&usn));
        Self {
            device_key: udn_hash.clone().unwrap_or_else(|| {
                Url::parse(location).map_or_else(
                    |_| identifier_hash(location),
                    |url| identifier_hash(url.as_str()),
                )
            }),
            udn_hash,
            source,
            server: server.chars().take(256).collect(),
            route: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    Cancelled,
    NoInterfaces,
    DiscoveryUnavailable,
    SocketBind,
    MulticastJoin,
    SearchSend,
    RouteUnavailable,
    HttpInitialization,
    Connect,
    Timeout,
    Io,
    HttpStatus,
    InvalidUtf8,
    Unavailable,
    Policy(PolicyError),
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::NoInterfaces => "no_interfaces",
            Self::DiscoveryUnavailable => "discovery_unavailable",
            Self::SocketBind => "socket_bind",
            Self::MulticastJoin => "multicast_join",
            Self::SearchSend => "search_send",
            Self::RouteUnavailable => "route_unavailable",
            Self::HttpInitialization => "http_initialization",
            Self::Connect => "connect",
            Self::Timeout => "timeout",
            Self::Io => "io",
            Self::HttpStatus => "http_status",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::Unavailable => "unavailable",
            Self::Policy(policy) => match policy {
                PolicyError::InvalidUrl => "invalid_url",
                PolicyError::AddressNotAllowed => "address_not_allowed",
                PolicyError::ExternalControl => "external_control",
                PolicyError::InvalidXml => "invalid_xml",
                PolicyError::TooLarge => "response_too_large",
                PolicyError::TooDeep => "xml_too_deep",
                PolicyError::NotRenderer => "not_renderer",
                PolicyError::MissingAvTransport => "missing_av_transport",
                PolicyError::InvalidService => "invalid_service",
                PolicyError::AdvertisementSourceMismatch => "advertisement_source_mismatch",
                PolicyError::RouteNotLocal => "route_not_local",
                PolicyError::InvalidSoap => "invalid_soap",
                PolicyError::SoapFault(_) => "soap_fault",
                PolicyError::InvalidTime => "invalid_time",
            },
        }
    }
}

/// No raw response, URLs, tokens or addresses: safe facts for T7a to record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DlnaError {
    pub code: ErrorCode,
    pub http_status: Option<u16>,
    pub upnp_code: Option<u32>,
}

impl DlnaError {
    fn new(code: ErrorCode) -> Self {
        Self {
            code,
            http_status: None,
            upnp_code: None,
        }
    }
    fn status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }
    pub fn is_network(&self) -> bool {
        matches!(
            self.code,
            ErrorCode::Connect | ErrorCode::Timeout | ErrorCode::Io
        )
    }
    pub fn is_cancelled(&self) -> bool {
        self.code == ErrorCode::Cancelled
    }
    fn metadata_retry(&self) -> bool {
        matches!(self.code, ErrorCode::Policy(PolicyError::SoapFault(_)))
            || self
                .http_status
                .is_some_and(|status| (400..600).contains(&status))
    }
}

impl From<PolicyError> for DlnaError {
    fn from(error: PolicyError) -> Self {
        let upnp_code = if let PolicyError::SoapFault(code) = error {
            code
        } else {
            None
        };
        Self {
            code: ErrorCode::Policy(error),
            http_status: None,
            upnp_code,
        }
    }
}

impl std::fmt::Display for DlnaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code.as_str())
    }
}
impl std::error::Error for DlnaError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Discovery,
    SearchBind,
    NotifyListen,
    MulticastJoin,
    SearchSend,
    Advertisement,
    Route,
    Description,
    Action(SoapAction),
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Discovery => "discovery",
            Self::SearchBind => "search_bind",
            Self::NotifyListen => "notify_listen",
            Self::MulticastJoin => "multicast_join",
            Self::SearchSend => "search_send",
            Self::Advertisement => "advertisement",
            Self::Route => "route",
            Self::Description => "description",
            Self::Action(action) => action.as_str(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Applied,
    Ignored,
    Retrying,
}

#[derive(Clone, Debug)]
pub struct StageResult {
    pub stage: Stage,
    pub attempt: u8,
    pub elapsed: Duration,
    pub http_status: Option<u16>,
    pub result: Result<(), DlnaError>,
    pub disposition: Disposition,
    /// Successful no-value acknowledgements may have an empty or vendor body.
    pub nonconforming_body: Option<PolicyError>,
    /// None only for scan-wide socket/search stages.
    pub context: Option<DeviceContext>,
}

impl StageResult {
    fn new<T>(
        stage: Stage,
        since: Instant,
        status: Option<u16>,
        result: &Result<T, DlnaError>,
    ) -> Self {
        Self {
            stage,
            attempt: 1,
            elapsed: since.elapsed(),
            http_status: status
                .or_else(|| result.as_ref().err().and_then(|error| error.http_status)),
            result: result.as_ref().map(|_| ()).map_err(Clone::clone),
            disposition: Disposition::Applied,
            nonconforming_body: None,
            context: None,
        }
    }
    fn for_device(mut self, context: &DeviceContext) -> Self {
        self.context = Some(context.clone());
        self
    }
}

/// Includes failed/ignored/retried stages even when a later stage succeeds.
#[derive(Debug)]
pub struct Operation<T> {
    pub result: Result<T, DlnaError>,
    pub stages: Vec<StageResult>,
    /// Retention limit reached; live discovery stages are still published.
    pub dropped_stages: usize,
}

pub(crate) fn local_ipv4(policy: NetworkPolicy) -> Vec<Ipv4Addr> {
    crate::networking::local_transport_addresses()
        .into_iter()
        .filter_map(|address| match address {
            IpAddr::V4(address) if policy.allows(address) => Some(address),
            _ => None,
        })
        .collect()
}

fn http_client(local: Ipv4Addr, timeout: Duration) -> Result<reqwest::Client, DlnaError> {
    crate::http_client::async_builder()
        .no_proxy()
        .local_address(IpAddr::V4(local))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .http1_only()
        .connect_timeout(timeout)
        .timeout(timeout)
        .pool_max_idle_per_host(0)
        .user_agent("bilikara/0.8 UPnP/1.1")
        .build()
        .map_err(|_| DlnaError::new(ErrorCode::HttpInitialization))
}

fn request_error(error: reqwest::Error) -> DlnaError {
    DlnaError::new(if error.is_timeout() {
        ErrorCode::Timeout
    } else if error.is_connect() {
        ErrorCode::Connect
    } else {
        ErrorCode::Io
    })
}

struct HttpReply {
    status: u16,
    body: String,
}

async fn http_request(
    client: &reqwest::Client,
    url: Url,
    soap: Option<(&str, &str, String)>,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<HttpReply, DlnaError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(DlnaError::new(ErrorCode::Cancelled)),
        result = async {
            let request = if let Some((service, action, body)) = soap {
                client.post(url).header(reqwest::header::CONTENT_TYPE, "text/xml; charset=\"utf-8\"")
                    .header("SOAPACTION", format!("\"{service}#{action}\""))
                    .header(reqwest::header::CONTENT_LENGTH, body.len())
                    .header(reqwest::header::CONNECTION, "close").body(body)
            } else {
                client.get(url).header(reqwest::header::ACCEPT, "text/xml, application/xml")
                    .header(reqwest::header::CONNECTION, "close")
            };
            let mut response = request.send().await.map_err(request_error)?;
            let status = response.status().as_u16();
            if response.content_length().is_some_and(|size| size > limit as u64) {
                return Err(DlnaError::from(PolicyError::TooLarge).status(status));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| request_error(error).status(status))? {
                if chunk.len() > limit.saturating_sub(bytes.len()) {
                    return Err(DlnaError::from(PolicyError::TooLarge).status(status));
                }
                bytes.extend_from_slice(&chunk);
            }
            let body = String::from_utf8(bytes).map_err(|_| DlnaError::new(ErrorCode::InvalidUtf8).status(status))?;
            Ok(HttpReply { status, body })
        } => result,
    }
}
