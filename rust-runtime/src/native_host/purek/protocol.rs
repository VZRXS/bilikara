//! Pure K QR / UPnP wire validation. Protocol reference: ChunK-Helper (MIT),
//! e223fac61e3991689bf7ef7125297583f5b56b9e; attribution in third-party notices.
use super::*;
use bilikara_rust::dlna_policy::{PolicyError, bounded_xml};

#[derive(Clone)]
pub(crate) struct Room {
    pub name: String,
    pub description: Url,
    pub authorization: Option<crate::dlna::purek::Room>,
}
#[derive(Clone)]
pub(crate) struct Renderer {
    pub udn: String,
    pub name: String,
    pub services: Services,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Service {
    pub control: Url,
    pub service_type: String,
}
#[derive(Clone, Default, PartialEq, Eq)]
pub(super) struct Services {
    pub av_transport: Option<Service>,
    pub rendering_control: Option<Service>,
    pub connection_manager: Option<Service>,
}
fn invalid() -> ApiError {
    failure(400, "qr_invalid", "请使用完整的纯 K 房间投屏二维码")
}
pub(super) fn local_address(url: &Url) -> Result<Ipv4Addr, ApiError> {
    let ip = url
        .host_str()
        .and_then(|s| s.parse::<Ipv4Addr>().ok())
        .ok_or_else(invalid)?;
    let allowed = ip.is_private();
    #[cfg(test)]
    let allowed = allowed || ip.is_loopback();
    if !matches!(url.scheme(), "http" | "https")
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return Err(invalid());
    }
    Ok(ip)
}
impl Room {
    pub fn from_input(raw: &str) -> Result<Self, ApiError> {
        if Url::parse(raw.trim()).is_ok_and(|url| url.host_str() == Some("wx.chunk.cn")) {
            Self::parse(raw)
        } else {
            Self::dlna(raw)
        }
    }

    pub fn dlna(raw: &str) -> Result<Self, ApiError> {
        let invalid = || failure(400, "description_invalid", "请填写局域网 DLNA 设备描述地址");
        if raw.len() > 4096 || raw.chars().any(char::is_control) {
            return Err(invalid());
        }
        let description = Url::parse(raw.trim()).map_err(|_| invalid())?;
        local_address(&description).map_err(|_| invalid())?;
        Ok(Self {
            name: "DLNA".into(),
            description,
            authorization: None,
        })
    }

    pub fn connection_type(&self) -> &'static str {
        if self.authorization.is_some() {
            "purek"
        } else {
            "dlna"
        }
    }

    pub fn authorization_url(&self) -> Option<&str> {
        self.authorization
            .as_ref()
            .map(crate::dlna::purek::Room::authorization_url)
    }

    pub fn parse(raw: &str) -> Result<Self, ApiError> {
        let parsed = crate::dlna::purek::Room::parse(raw);
        #[cfg(test)]
        let parsed = parsed.or_else(|_| crate::dlna::purek::Room::parse_fixture(raw));
        let authorization = parsed.map_err(|error| super::authorization::error(&error))?;
        Ok(Self {
            name: authorization.name().to_owned(),
            description: authorization.description_url().clone(),
            authorization: Some(authorization),
        })
    }
}
// HTTP reads and direct parser calls share the domain's maximum byte budget.
pub(super) use bilikara_rust::dlna_policy::MAX_XML_BYTES;

fn invalid_xml() -> ApiError {
    failure(502, "protocol", "房台返回了无效的协议响应")
}

pub(super) fn xml(text: &str) -> Result<roxmltree::Document<'_>, ApiError> {
    bounded_xml(text, MAX_XML_BYTES).map_err(|error| match error {
        PolicyError::TooLarge => failure(502, "protocol", "房台响应过大"),
        PolicyError::TooDeep => failure(502, "protocol", "房台协议响应的 XML 嵌套过深"),
        _ => invalid_xml(),
    })
}
fn field<'a>(node: roxmltree::Node<'a, '_>, name: &str) -> &'a str {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .unwrap_or_default()
        .trim()
}
pub(super) fn same_origin(a: &Url, b: &Url) -> bool {
    a.origin() == b.origin()
        && a.username().is_empty()
        && a.password().is_none()
        && a.fragment().is_none()
        && a.query().is_none()
}
fn identifier(text: &str) -> bool {
    !text.is_empty() && text.len() <= 512 && text.bytes().all(|b| (33..=126).contains(&b))
}
impl Renderer {
    pub fn parse(text: &str, location: &Url) -> Result<Self, ApiError> {
        let doc = xml(text)?;
        let device = doc
            .descendants()
            .find(|n| {
                n.is_element()
                    && n.tag_name().name() == "device"
                    && field(*n, "deviceType")
                        .starts_with("urn:schemas-upnp-org:device:MediaRenderer:")
            })
            .ok_or_else(|| failure(502, "renderer", "未确认房台的投屏设备身份"))?;
        let udn = field(device, "UDN");
        if !udn.starts_with("uuid:") || !identifier(udn) {
            return Err(failure(502, "renderer", "房台设备身份无效"));
        }
        let base = doc
            .root_element()
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "URLBase")
            .and_then(|n| n.text())
            .map(|s| {
                Url::parse(s.trim())
                    .ok()
                    .filter(|u| same_origin(u, location))
                    .ok_or_else(|| failure(502, "renderer", "房台服务地址无效"))
            })
            .transpose()?
            .unwrap_or_else(|| location.clone());
        let services = device
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "serviceList");
        let mut identities = vec![udn.to_owned(), field(device, "deviceType").into()];
        if device.parent() == Some(doc.root_element()) {
            identities.push("upnp:rootdevice".into());
        }
        let mut endpoints = Services::default();
        for node in services
            .into_iter()
            .flat_map(|n| n.children())
            .filter(|n| n.is_element() && n.tag_name().name() == "service")
        {
            let service = field(node, "serviceType");
            if !identifier(service) || !service.starts_with("urn:") {
                continue;
            }
            identities.push(service.to_owned());
            let Some((kind, version)) = service
                .strip_prefix("urn:schemas-upnp-org:service:")
                .and_then(|s| s.split_once(':'))
            else {
                continue;
            };
            let slot = match kind {
                "AVTransport" => &mut endpoints.av_transport,
                "RenderingControl" => &mut endpoints.rendering_control,
                "ConnectionManager" => &mut endpoints.connection_manager,
                _ => continue,
            };
            if version.parse::<u32>().ok().filter(|v| *v > 0).is_none()
                || slot.is_some()
                || field(node, "controlURL").is_empty()
            {
                return Err(failure(502, "renderer", "房台服务列表无效"));
            }
            let control = base
                .join(field(node, "controlURL"))
                .ok()
                .filter(|u| same_origin(u, location))
                .ok_or_else(|| failure(502, "renderer", "房台服务地址无效"))?;
            *slot = Some(Service {
                control,
                service_type: service.into(),
            });
        }
        if identities.len() > 32 {
            return Err(failure(502, "renderer", "房台服务列表过大"));
        }
        endpoints
            .connection_manager
            .as_ref()
            .or(endpoints.av_transport.as_ref())
            .ok_or_else(|| failure(502, "renderer", "房台未提供可用的设备登记接口"))?;
        identities.sort();
        identities.dedup();
        if identities.iter().any(|s| !identifier(s)) {
            return Err(failure(502, "renderer", "设备公告字段无效"));
        }
        Ok(Self {
            udn: udn.into(),
            name: field(device, "friendlyName").chars().take(100).collect(),
            services: endpoints,
        })
    }
}
pub(super) fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
/// Only a structurally valid UPnPError code is reported; never fault text.
pub(super) fn fault_code(fault: roxmltree::Node<'_, '_>) -> Option<u32> {
    let details: Vec<_> = fault
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "detail")
        .collect();
    if details.len() != 1 {
        return None;
    }
    let errors: Vec<_> = details[0].children().filter(|n| n.is_element()).collect();
    if errors.len() != 1
        || !errors[0].has_tag_name(("urn:schemas-upnp-org:control-1-0", "UPnPError"))
    {
        return None;
    }
    let codes: Vec<_> = errors[0]
        .children()
        .filter(|n| n.has_tag_name(("urn:schemas-upnp-org:control-1-0", "errorCode")))
        .collect();
    if codes.len() != 1 || codes[0].children().any(|n| n.is_element()) {
        return None;
    }
    let code = codes[0].text()?.trim();
    (!code.is_empty() && code.len() <= 4 && code.bytes().all(|b| b.is_ascii_digit()))
        .then(|| code.parse().ok())
        .flatten()
}
