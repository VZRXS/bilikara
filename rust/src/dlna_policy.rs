// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna.rs and rust-runtime/src/show_dlna/discovery.rs.
// SOAP/DIDL and MIME preference follow Kirakara-App (MIT), commit e449070,
// lib/services/dlna/dlna_control_point.dart. See THIRD_PARTY_NOTICES.md.
//! Immutable DLNA protocol policy. No sockets, state, clocks or other I/O.

use roxmltree::{Document, Node};
use std::net::Ipv4Addr;
use std::time::Duration;
use url::Url;

pub const MAX_XML_BYTES: usize = 1024 * 1024;
pub const MAX_DESCRIPTION_BYTES: usize = MAX_XML_BYTES;
pub const MAX_SOAP_BYTES: usize = 64 * 1024;
pub const MAX_SSDP_BYTES: usize = 16 * 1024;
pub const MAX_XML_DEPTH: usize = 64;
pub const MAX_XML_NODES: u32 = 8192;
pub const DEFAULT_PROTOCOL_INFO: &str = "http-get:*:video/MP2T:*";
pub const MEDIA_RENDERER: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
pub const AV_TRANSPORT: &str = "urn:schemas-upnp-org:service:AVTransport:";
pub const CONNECTION_MANAGER: &str = "urn:schemas-upnp-org:service:ConnectionManager:";
pub const RENDERING_CONTROL: &str = "urn:schemas-upnp-org:service:RenderingControl:";

/// Stable policy codes; adapters may attach transport facts without raw XML.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyError {
    InvalidUrl,
    AddressNotAllowed,
    ExternalControl,
    InvalidXml,
    TooLarge,
    TooDeep,
    NotRenderer,
    MissingAvTransport,
    InvalidService,
    AdvertisementSourceMismatch,
    RouteNotLocal,
    InvalidSoap,
    SoapFault(Option<u32>),
    InvalidTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkPolicy {
    Lan,
    /// Explicit local fixture policy, never selected by production adapters.
    LoopbackFixture,
}

impl NetworkPolicy {
    pub fn allows(self, address: Ipv4Addr) -> bool {
        match self {
            Self::Lan => {
                let [first, second, ..] = address.octets();
                address.is_private()
                    || address.is_link_local()
                    || (first == 100 && (64..=127).contains(&second))
            }
            Self::LoopbackFixture => address.is_loopback(),
        }
    }
}

pub fn lan_url(value: &str, policy: NetworkPolicy) -> Result<(Url, Ipv4Addr), PolicyError> {
    let result = lan_web_url(value, policy)?;
    if result.0.scheme() != "http" {
        return Err(PolicyError::InvalidUrl);
    }
    Ok(result)
}

/// QR-directed receivers may use HTTPS. Discovery keeps its HTTP-only contract.
/// Both variants require literal, allowed IPv4 addresses and no credentials.
pub fn lan_web_url(value: &str, policy: NetworkPolicy) -> Result<(Url, Ipv4Addr), PolicyError> {
    let uri = Url::parse(value).map_err(|_| PolicyError::InvalidUrl)?;
    let address = uri
        .host_str()
        .and_then(|host| host.parse::<Ipv4Addr>().ok())
        .filter(|&address| policy.allows(address))
        .ok_or(PolicyError::AddressNotAllowed)?;
    if !matches!(uri.scheme(), "http" | "https")
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.fragment().is_some()
        || uri.port_or_known_default() == Some(0)
    {
        return Err(PolicyError::InvalidUrl);
    }
    Ok((uri, address))
}

pub fn canonical_usn(usn: &str) -> String {
    usn.split("::")
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdvertisementLocation {
    pub url: Url,
    pub address: Ipv4Addr,
    pub helper: Option<Ipv4Addr>,
}

/// Only an on-device publisher or a local NOTIFY helper may advertise a target.
pub fn accept_advertisement(
    location: &str,
    sender: Ipv4Addr,
    reply_on: Option<Ipv4Addr>,
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
) -> Result<AdvertisementLocation, PolicyError> {
    let (url, address) = lan_url(location, policy)?;
    let helper = (sender != address).then_some(sender);
    if helper.is_some_and(|sender| reply_on.is_some() || !interfaces.contains(&sender)) {
        return Err(PolicyError::AdvertisementSourceMismatch);
    }
    Ok(AdvertisementLocation {
        url,
        address,
        helper,
    })
}

pub fn validate_route_source(
    source: Ipv4Addr,
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
) -> Result<Ipv4Addr, PolicyError> {
    if interfaces.contains(&source) && policy.allows(source) {
        Ok(source)
    } else {
        Err(PolicyError::RouteNotLocal)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalSourceKind {
    Route,
    ReplyInterface,
    SameSubnet,
    Explicit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalSource {
    pub address: Ipv4Addr,
    pub kind: LocalSourceKind,
}

/// Prefer the OS route, then the proven receiving interface (PR #120), then
/// a local /24 for unsolicited NOTIFY/manual URLs. Every choice must be local.
pub fn select_local_source(
    target: Ipv4Addr,
    routed: Option<Ipv4Addr>,
    reply_on: Option<Ipv4Addr>,
    interfaces: &[Ipv4Addr],
    policy: NetworkPolicy,
) -> Result<LocalSource, PolicyError> {
    if !policy.allows(target) {
        return Err(PolicyError::AddressNotAllowed);
    }
    let valid = |source| validate_route_source(source, interfaces, policy).ok();
    if let Some(address) = routed.and_then(valid) {
        return Ok(LocalSource {
            address,
            kind: LocalSourceKind::Route,
        });
    }
    if let Some(address) = reply_on.and_then(valid) {
        return Ok(LocalSource {
            address,
            kind: LocalSourceKind::ReplyInterface,
        });
    }
    interfaces
        .iter()
        .copied()
        .find(|source| source.octets()[..3] == target.octets()[..3] && valid(*source).is_some())
        .map(|address| LocalSource {
            address,
            kind: LocalSourceKind::SameSubnet,
        })
        .ok_or(PolicyError::RouteNotLocal)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SsdpChannel {
    SearchResponse,
    Notify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdvertisementKind {
    Response,
    Alive,
    Update,
    Byebye,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SsdpMessage {
    pub kind: AdvertisementKind,
    pub location: Option<String>,
    pub usn: String,
    pub server: String,
}

/// Parse the socket's expected message class. Legacy non-UTF-8 optional SERVER
/// headers are omitted, while invalid critical headers invalidate the message.
pub fn parse_ssdp(packet: &[u8], channel: SsdpChannel) -> Option<SsdpMessage> {
    if packet.len() > MAX_SSDP_BYTES {
        return None;
    }
    let mut lines = packet.split(|&byte| byte == b'\n');
    let mut start = std::str::from_utf8(lines.next()?)
        .ok()?
        .split_ascii_whitespace();
    let first = start.next()?;
    let second = start.next()?;
    match channel {
        SsdpChannel::SearchResponse => {
            if !(first.eq_ignore_ascii_case("HTTP/1.1") || first.eq_ignore_ascii_case("HTTP/1.0"))
                || second != "200"
            {
                return None;
            }
        }
        SsdpChannel::Notify => {
            if !first.eq_ignore_ascii_case("NOTIFY")
                || second != "*"
                || !start.next()?.eq_ignore_ascii_case("HTTP/1.1")
                || start.next().is_some()
            {
                return None;
            }
        }
    }
    let mut location = None;
    let mut usn = "";
    let mut nts = "";
    let mut server = "";
    for line in lines {
        if line == b"\r" || line.is_empty() {
            break;
        }
        let Some(colon) = line.iter().position(|&byte| byte == b':') else {
            continue;
        };
        let Ok(name) = std::str::from_utf8(&line[..colon]) else {
            continue;
        };
        let value = std::str::from_utf8(&line[colon + 1..]);
        if name.trim().eq_ignore_ascii_case("location") {
            if location.replace(value.ok()?.trim().to_owned()).is_some() {
                return None;
            }
        } else if name.trim().eq_ignore_ascii_case("usn") {
            usn = value.ok()?.trim();
        } else if name.trim().eq_ignore_ascii_case("nts") {
            nts = value.ok()?.trim();
        } else if name.trim().eq_ignore_ascii_case("server") {
            server = value.unwrap_or_default().trim();
        }
    }
    let usn = canonical_usn(usn);
    let kind = match channel {
        SsdpChannel::SearchResponse => AdvertisementKind::Response,
        SsdpChannel::Notify if nts.eq_ignore_ascii_case("ssdp:alive") => AdvertisementKind::Alive,
        SsdpChannel::Notify if nts.eq_ignore_ascii_case("ssdp:update") => AdvertisementKind::Update,
        SsdpChannel::Notify if nts.eq_ignore_ascii_case("ssdp:byebye") && !usn.is_empty() => {
            AdvertisementKind::Byebye
        }
        _ => return None,
    };
    if kind != AdvertisementKind::Byebye && location.as_ref().is_none_or(|s| s.is_empty()) {
        return None;
    }
    Some(SsdpMessage {
        kind,
        location,
        usn,
        server: server.to_owned(),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VendorClass {
    Lebo,
    Dolphinstar,
    Generic,
}

impl VendorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lebo => "lebo",
            Self::Dolphinstar => "dolphinstar",
            Self::Generic => "generic",
        }
    }
}

/// Classification is advisory: never an admission or capability check.
pub fn vendor_class(fields: &[&str]) -> VendorClass {
    let fields: Vec<_> = fields.iter().map(|s| s.to_lowercase()).collect();
    if fields
        .iter()
        .any(|s| ["hpplay", "lebo", "乐播"].iter().any(|key| s.contains(key)))
    {
        VendorClass::Lebo
    } else if fields.iter().any(|s| {
        ["dolphinstar", "chunk.cn", "purek", "纯k", "海豚星空"]
            .iter()
            .any(|key| s.contains(key))
    }) {
        VendorClass::Dolphinstar
    } else {
        VendorClass::Generic
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceEndpoint {
    pub service_type: String,
    pub control_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RendererDescription {
    pub id: String,
    pub name: String,
    pub location: String,
    pub av_transport: ServiceEndpoint,
    pub connection_manager: Option<ServiceEndpoint>,
    pub rendering_control: Option<ServiceEndpoint>,
    pub manufacturer: String,
    pub model_name: String,
    pub model_description: String,
    pub vendor_class: VendorClass,
}

fn direct_text<'a>(node: Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
        .and_then(|child| child.text())
        .map(str::trim)
}

pub fn service_version(kind: &str, prefix: &str) -> Option<u32> {
    kind.strip_prefix(prefix)?.parse().ok().filter(|&v| v > 0)
}

pub fn parse_description(
    source: &str,
    location: &str,
    usn: &str,
    server: &str,
    policy: NetworkPolicy,
) -> Result<RendererDescription, PolicyError> {
    let (location, address) = lan_url(location, policy)?;
    let document = bounded_xml(source, MAX_DESCRIPTION_BYTES)?;
    let renderer = document
        .descendants()
        .find(|node| {
            node.is_element()
                && node.tag_name().name() == "device"
                && direct_text(*node, "deviceType").is_some_and(|kind| {
                    service_version(kind, "urn:schemas-upnp-org:device:MediaRenderer:").is_some()
                })
        })
        .ok_or(PolicyError::NotRenderer)?;
    // Cross-origin/invalid URLBase is an advisory defect, not a discovery failure.
    let base = direct_text(document.root_element(), "URLBase")
        .and_then(|value| lan_url(value, policy).ok())
        .map(|(base, _)| base)
        .filter(|base| base.origin() == location.origin())
        .unwrap_or_else(|| location.clone());
    let service_list = renderer
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "serviceList")
        .ok_or(PolicyError::MissingAvTransport)?;
    let endpoint = |prefix: &str| -> Result<Option<ServiceEndpoint>, PolicyError> {
        let selected = service_list
            .children()
            .filter(|node| node.is_element() && node.tag_name().name() == "service")
            .filter_map(|node| {
                let kind = direct_text(node, "serviceType")?;
                let version = service_version(kind, prefix)?;
                let control = direct_text(node, "controlURL").filter(|s| !s.is_empty())?;
                Some((version, kind, control))
            })
            .max_by_key(|(version, _, _)| *version);
        let Some((_, kind, control)) = selected else {
            return Ok(None);
        };
        // MStar/Myou put a colon in the first segment of a relative path.
        let control =
            if !control.starts_with('/') && control.contains(':') && !control.contains("://") {
                format!("./{control}")
            } else {
                control.to_owned()
            };
        let control = base.join(&control).map_err(|_| PolicyError::InvalidUrl)?;
        let (control, control_address) = lan_url(control.as_str(), policy)?;
        if control_address != address {
            return Err(PolicyError::ExternalControl);
        }
        Ok(Some(ServiceEndpoint {
            service_type: kind.to_owned(),
            control_url: control.into(),
        }))
    };
    let av_transport = endpoint(AV_TRANSPORT)?.ok_or(PolicyError::MissingAvTransport)?;
    let name = direct_text(renderer, "friendlyName")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| location.host_str().unwrap_or_default())
        .to_owned();
    let manufacturer = direct_text(renderer, "manufacturer")
        .unwrap_or_default()
        .to_owned();
    let model_name = direct_text(renderer, "modelName")
        .unwrap_or_default()
        .to_owned();
    let model_description = direct_text(renderer, "modelDescription")
        .unwrap_or_default()
        .to_owned();
    let vendor_class = vendor_class(&[
        &manufacturer,
        &model_name,
        &model_description,
        &name,
        server,
    ]);
    let id = direct_text(renderer, "UDN")
        .filter(|s| !s.is_empty())
        .unwrap_or(usn);
    let id = if id.is_empty() {
        location.to_string()
    } else {
        canonical_usn(id)
    };
    Ok(RendererDescription {
        id,
        name,
        location: location.to_string(),
        av_transport,
        connection_manager: endpoint(CONNECTION_MANAGER)?,
        rendering_control: endpoint(RENDERING_CONTROL)?,
        manufacturer,
        model_name,
        model_description,
        vendor_class,
    })
}

/// Match Kirakara-App's MIME ordering and preserve the receiver's MIME casing.
/// Missing/failed/not-yet-queried capabilities all use the same safe trial default.
pub fn choose_mpeg_ts_protocol_info(sink_entries: &[String]) -> String {
    for preferred in ["video/mp2t", "video/mpeg", "video/vnd.dlna.mpeg-tts"] {
        for entry in sink_entries {
            let parts: Vec<_> = entry.split(':').collect();
            if parts.len() >= 4
                && parts[0].eq_ignore_ascii_case("http-get")
                && parts[2].trim().eq_ignore_ascii_case(preferred)
            {
                return format!("http-get:*:{}:*", parts[2].trim());
            }
        }
    }
    DEFAULT_PROTOCOL_INFO.to_owned()
}

// Text escaping matches Dart XmlText.toXmlString(), with its explicit '>' escape.
fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn xml_attribute(value: &str) -> String {
    xml_text(value)
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryMode {
    File,
    Live,
}

pub fn content_features(mode: DeliveryMode, converted: bool) -> String {
    let op = if mode == DeliveryMode::File {
        "01"
    } else {
        "00"
    };
    let ci = u8::from(mode == DeliveryMode::File && converted);
    format!("DLNA.ORG_OP={op};DLNA.ORG_CI={ci};DLNA.ORG_FLAGS=01700000000000000000000000000000")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileMetadata {
    pub size: u64,
    pub duration: Duration,
}

pub fn build_didl(
    uri: &str,
    title: &str,
    protocol_info: &str,
    file: Option<FileMetadata>,
) -> String {
    let file = file
        .map(|file| {
            format!(
                " size=\"{}\" duration=\"{}\"",
                file.size,
                format_upnp_time(file.duration)
            )
        })
        .unwrap_or_default();
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"0\" restricted=\"1\"><dc:title>{}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"{}\"{file}>{}</res></item></DIDL-Lite>",
        xml_text(title),
        xml_attribute(protocol_info),
        xml_text(uri)
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SoapAction {
    GetProtocolInfo,
    SetDeviceAuthorization,
    Stop,
    SetAVTransportURI,
    Play,
    Pause,
    Seek,
    GetTransportInfo,
    GetPositionInfo,
    SetNextAVTransportURI,
    SetVolume,
}

impl SoapAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GetProtocolInfo => "GetProtocolInfo",
            Self::SetDeviceAuthorization => "SetDeviceAuthorization",
            Self::Stop => "Stop",
            Self::SetAVTransportURI => "SetAVTransportURI",
            Self::Play => "Play",
            Self::Pause => "Pause",
            Self::Seek => "Seek",
            Self::GetTransportInfo => "GetTransportInfo",
            Self::GetPositionInfo => "GetPositionInfo",
            Self::SetNextAVTransportURI => "SetNextAVTransportURI",
            Self::SetVolume => "SetVolume",
        }
    }
}

pub fn soap_envelope(
    service_type: &str,
    action: SoapAction,
    arguments: &[(&str, &str)],
) -> Result<String, PolicyError> {
    let mut argument_xml = String::new();
    for (name, value) in arguments {
        if !name.starts_with(|c: char| c.is_ascii_alphabetic())
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        {
            return Err(PolicyError::InvalidSoap);
        }
        argument_xml.push_str(&format!("<{name}>{}</{name}>", xml_text(value)));
    }
    let action = action.as_str();
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">{argument_xml}</u:{action}></s:Body></s:Envelope>",
        xml_attribute(service_type)
    ))
}

/// Shared network XML entry point: at most 1 MiB, 64 levels and 8192 nodes.
/// Callers may impose smaller budgets (for example, SOAP's 64 KiB limit).
/// B8 bounds ported from bilikara-next integration 3057fb7 (7061f1f).
pub fn bounded_xml(source: &str, limit: usize) -> Result<Document<'_>, PolicyError> {
    if source.len() > limit.min(MAX_XML_BYTES) {
        return Err(PolicyError::TooLarge);
    }
    check_xml_depth(source)?;
    Document::parse_with_options(
        source,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: MAX_XML_NODES,
        },
    )
    .map_err(|_| PolicyError::InvalidXml)
}

/// roxmltree 0.20 descends recursively. Bound nesting before it sees any XML,
/// including malformed input. This scanner is iterative and allocates nothing;
/// roxmltree still performs all XML/name/namespace validation afterwards.
fn check_xml_depth(source: &str) -> Result<(), PolicyError> {
    let bytes = source.as_bytes();
    let mut cursor = 0;
    let mut depth = 0_usize;
    while let Some(offset) = bytes[cursor..].iter().position(|&byte| byte == b'<') {
        cursor += offset;
        let tail = &bytes[cursor..];
        let marker = if tail.starts_with(b"<!--") {
            Some((&b"-->"[..], 4))
        } else if tail.starts_with(b"<![CDATA[") {
            Some((&b"]]>"[..], 9))
        } else if tail.starts_with(b"<?") {
            Some((&b"?>"[..], 2))
        } else {
            None
        };
        if let Some((end, prefix)) = marker {
            let length = tail[prefix..]
                .windows(end.len())
                .position(|part| part == end)
                .ok_or(PolicyError::InvalidXml)?;
            cursor += prefix + length + end.len();
            continue;
        }
        // DTDs/entities already are disabled in roxmltree. Reject declarations
        // here too, so none can obscure the depth preflight's token boundaries.
        if tail.starts_with(b"<!") {
            return Err(PolicyError::InvalidXml);
        }
        let closing = tail.starts_with(b"</");
        if !closing {
            depth += 1;
            if depth > MAX_XML_DEPTH {
                return Err(PolicyError::TooDeep);
            }
        }
        let mut end = cursor + 1;
        let mut quote = None;
        let mut self_closing = false;
        loop {
            let byte = *bytes.get(end).ok_or(PolicyError::InvalidXml)?;
            // B8: raw '<' is invalid even inside a quoted attribute. Encoded
            // '&lt;' remains valid and cannot hide markup from the preflight.
            if byte == b'<' {
                return Err(PolicyError::InvalidXml);
            }
            if let Some(delimiter) = quote {
                if byte == delimiter {
                    quote = None;
                }
            } else if matches!(byte, b'\'' | b'"') {
                quote = Some(byte);
                self_closing = false;
            } else if byte == b'>' {
                break;
            } else {
                self_closing = byte == b'/';
            }
            end += 1;
        }
        if closing || self_closing {
            depth = depth.checked_sub(1).ok_or(PolicyError::InvalidXml)?;
        }
        cursor = end + 1;
    }
    if depth != 0 {
        return Err(PolicyError::InvalidXml);
    }
    Ok(())
}

/// A Fault can be returned with HTTP 200. Keep the UPnP code for diagnostics.
pub fn validate_soap_response(source: &str, action: SoapAction) -> Result<(), PolicyError> {
    let document = bounded_xml(source, MAX_SOAP_BYTES)?;
    if let Some(fault) = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "Fault")
    {
        let code = fault
            .descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "errorCode")
            .and_then(|node| node.text())
            .and_then(|s| s.trim().parse().ok());
        return Err(PolicyError::SoapFault(code));
    }
    let body = document
        .root_element()
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "Body");
    let response = format!("{}Response", action.as_str());
    if document.root_element().tag_name().name() != "Envelope"
        || !body.is_some_and(|body| {
            body.children()
                .any(|node| node.is_element() && node.tag_name().name() == response)
        })
    {
        return Err(PolicyError::InvalidSoap);
    }
    Ok(())
}

fn response_fields(source: &str, action: SoapAction) -> Result<Vec<(String, String)>, PolicyError> {
    validate_soap_response(source, action)?;
    let document = bounded_xml(source, MAX_SOAP_BYTES)?;
    let response_name = format!("{}Response", action.as_str());
    let response = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == response_name)
        .ok_or(PolicyError::InvalidSoap)?;
    Ok(response
        .children()
        .filter(|node| node.is_element())
        .map(|node| {
            (
                node.tag_name().name().to_owned(),
                node.text().unwrap_or_default().trim().to_owned(),
            )
        })
        .collect())
}

pub fn parse_sink_protocol_info(source: &str) -> Result<Vec<String>, PolicyError> {
    let fields = response_fields(source, SoapAction::GetProtocolInfo)?;
    Ok(fields
        .iter()
        .find(|(name, _)| name == "Sink")
        .map(|(_, value)| {
            value
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportState {
    Playing,
    Paused,
    Transitioning,
    Stopped,
    NoMedia,
    Unknown,
}

pub fn parse_transport_info(source: &str) -> Result<TransportState, PolicyError> {
    let fields = response_fields(source, SoapAction::GetTransportInfo)?;
    let value = fields
        .iter()
        .find(|(name, _)| name == "CurrentTransportState")
        .ok_or(PolicyError::InvalidSoap)?;
    Ok(match value.1.to_ascii_uppercase().as_str() {
        "PLAYING" => TransportState::Playing,
        "PAUSED_PLAYBACK" | "PAUSED_RECORDING" => TransportState::Paused,
        "TRANSITIONING" => TransportState::Transitioning,
        "STOPPED" => TransportState::Stopped,
        "NO_MEDIA_PRESENT" => TransportState::NoMedia,
        _ => TransportState::Unknown,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionInfo {
    pub position: Option<Duration>,
    pub duration: Option<Duration>,
}

pub fn parse_position_info(source: &str) -> Result<PositionInfo, PolicyError> {
    let fields = response_fields(source, SoapAction::GetPositionInfo)?;
    let time = |key| {
        fields
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| parse_upnp_time(value))
            .unwrap_or(Ok(None))
    };
    Ok(PositionInfo {
        position: time("RelTime")?,
        duration: time("TrackDuration")?,
    })
}

/// Empty and NOT_IMPLEMENTED are valid unavailable values, not zero positions.
pub fn parse_upnp_time(value: &str) -> Result<Option<Duration>, PolicyError> {
    let value = value.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("NOT_IMPLEMENTED") {
        return Ok(None);
    }
    let parts: Vec<_> = value.split(':').collect();
    if parts.len() != 3 {
        return Err(PolicyError::InvalidTime);
    }
    let number = |s: &str| -> Result<u64, PolicyError> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(PolicyError::InvalidTime);
        }
        s.parse().map_err(|_| PolicyError::InvalidTime)
    };
    let hours = number(parts[0])?;
    let minutes = number(parts[1])?;
    let (seconds, fraction) = parts[2]
        .split_once('.')
        .map_or((parts[2], None), |(s, f)| (s, Some(f)));
    let seconds = number(seconds)?;
    if parts[1].len() != 2
        || seconds >= 60
        || minutes >= 60
        || parts[2].split('.').next().unwrap_or_default().len() != 2
    {
        return Err(PolicyError::InvalidTime);
    }
    let millis = match fraction {
        Some(fraction) if (1..=3).contains(&fraction.len()) => {
            number(fraction)? * 10_u64.pow(3 - fraction.len() as u32)
        }
        Some(_) => return Err(PolicyError::InvalidTime),
        None => 0,
    };
    let total = hours
        .checked_mul(3600)
        .and_then(|v| v.checked_add(minutes * 60 + seconds))
        .ok_or(PolicyError::InvalidTime)?;
    Ok(Some(Duration::new(total, (millis * 1_000_000) as u32)))
}

pub fn format_upnp_time(value: Duration) -> String {
    let seconds = value.as_secs();
    let base = format!(
        "{}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    );
    if value.subsec_millis() == 0 {
        base
    } else {
        format!("{base}.{:03}", value.subsec_millis())
    }
}

#[cfg(test)]
#[path = "dlna_policy_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "dlna_policy_xml_tests.rs"]
mod xml_tests;
