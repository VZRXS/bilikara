//! Pure K QR / UPnP wire validation. Protocol reference: ChunK-Helper (MIT),
//! e223fac61e3991689bf7ef7125297583f5b56b9e; attribution in third-party notices.
use super::*;
use base64::engine::general_purpose::STANDARD;
use std::collections::HashMap;

#[derive(Clone)]
pub(crate) struct Room {
    pub name: String,
    pub description: Url,
    pub authorization: Option<RoomAuthorization>,
}
#[derive(Clone)]
pub(crate) struct RoomAuthorization {
    pub url: String,
    pub token: String,
}
#[derive(Clone)]
pub(crate) struct Renderer {
    pub udn: String,
    pub name: String,
    pub control: Url,
    pub service: String,
    pub identities: Vec<String>,
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
fn web(value: &str, domain: &str, path: &str) -> Result<Url, ApiError> {
    let u = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str() != Some(domain)
        || u.path().trim_end_matches('/') != path
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some()
        || u.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(u)
}
// Decode percent escapes without treating opaque '+' tokens as spaces.
fn query(url: &Url) -> Result<HashMap<String, String>, ApiError> {
    let mut fields = HashMap::new();
    for pair in url
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|s| !s.is_empty())
    {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let decode = |v: &str| {
            let protected = v.replace('+', "%2B");
            url::form_urlencoded::parse(format!("v={protected}").as_bytes())
                .next()
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        };
        let key = decode(key).to_ascii_lowercase();
        let value = if key == "name" {
            decode(value).replace('+', " ")
        } else {
            decode(value)
        };
        if fields.insert(key, value).is_some() {
            return Err(invalid());
        }
    }
    Ok(fields)
}
fn required<'a>(fields: &'a HashMap<String, String>, key: &str) -> Result<&'a str, ApiError> {
    fields
        .get(key)
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(invalid)
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

    pub fn parse(raw: &str) -> Result<Self, ApiError> {
        if raw.len() > 32768 || raw.chars().any(char::is_control) {
            return Err(invalid());
        }
        let outer = web(raw.trim(), "wx.chunk.cn", "/projection/login")?;
        let q = query(&outer)?;
        let place = required(&q, "place_code")?;
        let encoded = required(&q, "projection_url")?
            .replace('-', "+")
            .replace('_', "/");
        let encoded = format!("{encoded}{}", "=".repeat((4 - encoded.len() % 4) % 4));
        let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
        let inner = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
        let decoded;
        let inner = match web(inner, "conn.dolphinstar.cn", "/Remote") {
            Ok(url) => url,
            Err(_) => {
                decoded = url::form_urlencoded::parse(
                    format!("v={}", inner.replace('+', "%2B")).as_bytes(),
                )
                .next()
                .map(|(_, v)| v.into_owned())
                .ok_or_else(invalid)?;
                web(&decoded, "conn.dolphinstar.cn", "/Remote")?
            }
        };
        let fields = query(&inner)?;
        let mut description = Url::parse(required(&fields, "url")?).map_err(|_| invalid())?;
        local_address(&description)?;
        let path = format!(
            "{}/description.xml",
            description.path().trim_end_matches('/')
        );
        description.set_path(&path);
        let token = required(&fields, "token")?.to_owned();
        if token.len() > 4096 || token.chars().any(char::is_control) {
            return Err(invalid());
        }
        let name = fields
            .get("name")
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| format!("房间 {place}"));
        if name.chars().count() > 100 || name.chars().any(char::is_control) {
            return Err(invalid());
        }
        Ok(Self {
            name,
            description,
            authorization: Some(RoomAuthorization {
                url: outer.to_string(),
                token,
            }),
        })
    }
}
pub(super) fn xml(text: &str) -> Result<roxmltree::Document<'_>, ApiError> {
    roxmltree::Document::parse_with_options(
        text,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: 8192,
        },
    )
    .map_err(|_| failure(502, "protocol", "房台返回了无效的协议响应"))
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
        let connection = endpoints
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
            control: connection.control.clone(),
            service: connection.service_type.clone(),
            identities,
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
pub(super) fn authorization(
    authorization: &RoomAuthorization,
    renderer: &Renderer,
    address: Ipv4Addr,
    enable: bool,
) -> String {
    format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:SetDeviceAuthorization xmlns:u=\"{}\"><DeviceIP>{address}</DeviceIP><Token>{}</Token><Enable>{}</Enable></u:SetDeviceAuthorization></s:Body></s:Envelope>",
        escape(&renderer.service),
        escape(&authorization.token),
        u8::from(enable)
    )
}
pub(super) fn authorization_result(text: &str, service: &str) -> Result<(), ApiError> {
    let doc = xml(text)?;
    let body = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Body")));
    if body.is_some_and(|n| {
        n.children()
            .any(|n| n.has_tag_name((service, "SetDeviceAuthorizationResponse")))
    }) && !body.is_some_and(|n| n.children().any(|n| n.tag_name().name() == "Fault"))
    {
        return Ok(());
    }
    Err(failure(
        502,
        "authorization",
        "房台未确认设备登记，请完成官方授权后重试",
    ))
}
pub(super) fn advertisement(
    room: &Room,
    renderer: &Renderer,
    identity: &str,
    alive: bool,
) -> Vec<u8> {
    let usn = if identity == renderer.udn {
        identity.into()
    } else {
        format!("{}::{identity}", renderer.udn)
    };
    let location = if alive {
        format!(
            "CACHE-CONTROL: max-age=60\r\nLOCATION: {}\r\nSERVER: bilikara/0.8 UPnP/1.0\r\n",
            room.description
        )
    } else {
        String::new()
    };
    format!("NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n{location}NT: {identity}\r\nNTS: ssdp:{}\r\nUSN: {usn}\r\n\r\n", if alive { "alive" } else { "byebye" }).into_bytes()
}
