// Adapted from bilikara-next 7750dca, native_host/purek/protocol.rs (MIT),
// ChunK-Helper 3b00533, Network/{RendererClient,SsdpAdvertisement}.cs (MIT),
// and bilikara T1 description policy. See THIRD_PARTY_NOTICES.md.
//! Pure authorization-time description policy; AVTransport may appear later.

use super::*;
use dlna_policy::{
    AV_TRANSPORT, CONNECTION_MANAGER, RENDERING_CONTROL, RendererDescription, ServiceEndpoint,
    bounded_xml, lan_web_url, service_version, vendor_class,
};
use roxmltree::Node;

const MAX_IDENTITIES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ServiceKind {
    AvTransport,
    ConnectionManager,
    RenderingControl,
    /// Never expose untrusted service names: they may contain room identifiers.
    Other {
        salted_digest: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ServiceSummaryEntry {
    pub kind: ServiceKind,
    pub version: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServiceSummary {
    pub entries: Vec<ServiceSummaryEntry>,
    pub advertised: usize,
    pub truncated: bool,
}

#[derive(Clone)]
pub(super) struct Description {
    pub location: Url,
    pub udn: String,
    pub identities: Vec<String>,
    pub manager: Option<ServiceEndpoint>,
    pub av_transport: Option<ServiceEndpoint>,
    rendering: Option<ServiceEndpoint>,
    name: String,
    manufacturer: String,
    model_name: String,
    model_description: String,
    services: Vec<(String, u32)>,
}

fn field<'a>(node: Node<'a, '_>, name: &str) -> &'a str {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
        .and_then(|child| child.text())
        .unwrap_or_default()
        .trim()
}

fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && value.bytes().all(|byte| (33..=126).contains(&byte))
}

fn endpoint_url(
    raw: &str,
    base: &Url,
    original_host: Option<&str>,
    policy: NetworkPolicy,
) -> Result<Url, PolicyError> {
    if raw.chars().any(char::is_control) || raw.contains('\\') {
        return Err(PolicyError::InvalidUrl);
    }
    let relative = if !raw.starts_with('/') && raw.contains(':') && !raw.contains("://") {
        format!("./{raw}")
    } else {
        raw.to_owned()
    };
    let url = base.join(&relative).map_err(|_| PolicyError::InvalidUrl)?;
    let mut url = qr::safe_web(url.as_str()).map_err(|_| PolicyError::InvalidUrl)?;
    if original_host.is_some_and(|host| url.host_str() == Some(host)) {
        url.set_host(base.host_str())
            .map_err(|_| PolicyError::InvalidUrl)?;
    }
    let (url, address) = lan_web_url(url.as_str(), policy)?;
    let (_, expected) = lan_web_url(base.as_str(), policy)?;
    if address != expected {
        return Err(PolicyError::ExternalControl);
    }
    Ok(url)
}

impl Description {
    pub fn parse(
        source: &str,
        location: &Url,
        original_host: Option<&str>,
        policy: NetworkPolicy,
    ) -> Result<Self, PolicyError> {
        lan_web_url(location.as_str(), policy)?;
        let document = bounded_xml(source, dlna_policy::MAX_DESCRIPTION_BYTES)?;
        let device = document
            .descendants()
            .find(|node| {
                node.is_element()
                    && node.tag_name().name() == "device"
                    && service_version(
                        field(*node, "deviceType"),
                        "urn:schemas-upnp-org:device:MediaRenderer:",
                    )
                    .is_some()
            })
            .ok_or(PolicyError::NotRenderer)?;
        let udn = field(device, "UDN");
        if !identifier(udn)
            || !udn
                .get(..5)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("uuid:"))
            || udn.len() == 5
            || udn.contains("::")
        {
            return Err(PolicyError::NotRenderer);
        }
        let udn = udn.to_ascii_lowercase();
        let base = endpoint_url(
            field(document.root_element(), "URLBase"),
            location,
            original_host,
            policy,
        )
        .ok()
        .filter(|url| url.origin() == location.origin())
        .unwrap_or_else(|| location.clone());
        let mut identities = Vec::new();
        if device.parent() == Some(document.root_element()) {
            identities.push("upnp:rootdevice".into());
        }
        identities.push(udn.clone());
        identities.push(field(device, "deviceType").to_owned());
        let mut services = Vec::new();
        let mut manager = None;
        let mut av_transport = None;
        let mut rendering = None;
        let service_list = device
            .children()
            .find(|node| node.is_element() && node.tag_name().name() == "serviceList");
        for node in service_list
            .into_iter()
            .flat_map(|list| list.children())
            .filter(|node| node.is_element() && node.tag_name().name() == "service")
        {
            let kind = field(node, "serviceType");
            if !identifier(kind) || !kind.starts_with("urn:") {
                continue;
            }
            let Some(version) = kind
                .rsplit_once(':')
                .and_then(|(_, version)| version.parse::<u32>().ok())
                .filter(|v| *v > 0)
            else {
                continue;
            };
            services.push((kind.to_owned(), version));
            if identities.len() < MAX_IDENTITIES
                && !identities.iter().any(|id| id.eq_ignore_ascii_case(kind))
            {
                identities.push(kind.to_owned());
            }
            let (slot, prefix) = if service_version(kind, AV_TRANSPORT).is_some() {
                (&mut av_transport, AV_TRANSPORT)
            } else if service_version(kind, CONNECTION_MANAGER).is_some() {
                (&mut manager, CONNECTION_MANAGER)
            } else if service_version(kind, RENDERING_CONTROL).is_some() {
                (&mut rendering, RENDERING_CONTROL)
            } else {
                continue;
            };
            let control = field(node, "controlURL");
            if control.is_empty() {
                continue;
            }
            if slot.as_ref().is_some_and(|old: &ServiceEndpoint| {
                service_version(&old.service_type, prefix).is_some_and(|v| v >= version)
            }) {
                continue;
            }
            let control_url = endpoint_url(control, &base, original_host, policy)?.into();
            *slot = Some(ServiceEndpoint {
                service_type: kind.into(),
                control_url,
            });
        }
        services.sort();
        services.dedup();
        Ok(Self {
            location: location.clone(),
            udn,
            identities,
            manager,
            av_transport,
            rendering,
            name: field(device, "friendlyName").chars().take(100).collect(),
            manufacturer: field(device, "manufacturer").chars().take(100).collect(),
            model_name: field(device, "modelName").chars().take(100).collect(),
            model_description: field(device, "modelDescription")
                .chars()
                .take(100)
                .collect(),
            services,
        })
    }

    pub fn summary(&self, salt: &[u8; 32]) -> ServiceSummary {
        let mut entries: Vec<_> = self
            .services
            .iter()
            .take(MAX_IDENTITIES)
            .map(|(kind, version)| {
                let kind = if service_version(kind, AV_TRANSPORT).is_some() {
                    ServiceKind::AvTransport
                } else if service_version(kind, CONNECTION_MANAGER).is_some() {
                    ServiceKind::ConnectionManager
                } else if service_version(kind, RENDERING_CONTROL).is_some() {
                    ServiceKind::RenderingControl
                } else {
                    ServiceKind::Other {
                        salted_digest: salted_hash(salt, kind),
                    }
                };
                ServiceSummaryEntry {
                    kind,
                    version: *version,
                }
            })
            .collect();
        entries.sort();
        ServiceSummary {
            entries,
            advertised: self.services.len(),
            truncated: self.services.len() > MAX_IDENTITIES,
        }
    }

    pub fn services_changed(&self, previous: &Self) -> bool {
        self.services != previous.services
    }

    pub fn renderer(
        &self,
        local_address: Ipv4Addr,
        context: DeviceContext,
    ) -> Result<Renderer, DlnaError> {
        let av_transport = self
            .av_transport
            .clone()
            .ok_or(PolicyError::MissingAvTransport)?;
        Ok(Renderer {
            description: RendererDescription {
                id: self.udn.clone(),
                name: self.name.clone(),
                location: self.location.to_string(),
                av_transport,
                connection_manager: self.manager.clone(),
                rendering_control: self.rendering.clone(),
                manufacturer: self.manufacturer.clone(),
                model_name: self.model_name.clone(),
                model_description: self.model_description.clone(),
                vendor_class: vendor_class(&[
                    &self.name,
                    &self.manufacturer,
                    &self.model_name,
                    &self.model_description,
                ]),
            },
            local_address,
            context,
        })
    }

    /// Real receiver LOCATION/UDN/NT, never the sender's endpoint or identity.
    pub fn advertisements(&self, alive: bool) -> Vec<Vec<u8>> {
        self.identities.iter().map(|identity| {
            let usn = if *identity == self.udn { self.udn.clone() } else { format!("{}::{identity}", self.udn) };
            let location = if alive {
                format!("CACHE-CONTROL: max-age=60\r\nLOCATION: {}\r\nSERVER: bilikara/0.8 UPnP/1.1\r\n", self.location)
            } else { String::new() };
            format!("NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n{location}NT: {identity}\r\nNTS: ssdp:{}\r\nUSN: {usn}\r\n\r\n", if alive { "alive" } else { "byebye" }).into_bytes()
        }).collect()
    }
}
