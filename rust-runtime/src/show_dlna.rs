//! Bounded LAN discovery and UPnP control for the optional Show media backend.
//!
//! Show owns encoding and its HTTP stream. This adapter owns the renderer's
//! SetAVTransportURI/Play/Stop calls, following Kirakara App's control sequence.

use reqwest::blocking::Client;
use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use url::Url;

mod discovery;
pub use discovery::discover;

const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DESCRIPTION: usize = 1024 * 1024;
const MAX_SOAP_RESPONSE: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Renderer {
    pub id: String,
    pub name: String,
    pub location: String,
    pub av_transport_url: String,
    pub av_transport_type: String,
    pub local_address: Ipv4Addr,
}

#[derive(Clone, Copy)]
enum NetworkPolicy {
    Lan,
    #[cfg(test)]
    LoopbackFixture,
}

impl NetworkPolicy {
    fn allows(self, address: Ipv4Addr) -> bool {
        match self {
            Self::Lan => {
                let [first, second, ..] = address.octets();
                address.is_private()
                    || address.is_link_local()
                    || (first == 100 && (64..=127).contains(&second))
            }
            #[cfg(test)]
            Self::LoopbackFixture => address.is_loopback(),
        }
    }
}

struct Advertisement {
    location: Url,
    usn: String,
    local_address: Ipv4Addr,
}

fn lan_url(value: &str, policy: NetworkPolicy) -> Result<(Url, Ipv4Addr), String> {
    let uri = Url::parse(value).map_err(|error| format!("Invalid DLNA URL: {error}"))?;
    let address = uri
        .host_str()
        .and_then(|value| value.parse::<Ipv4Addr>().ok())
        .filter(|address| policy.allows(*address))
        .ok_or_else(|| {
            "DLNA URL requires a private, shared or link-local IPv4 address".to_owned()
        })?;
    if uri.scheme() != "http"
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.fragment().is_some()
        || uri.port_or_known_default() == Some(0)
    {
        return Err("DLNA URL must be an unauthenticated LAN HTTP endpoint".to_owned());
    }
    Ok((uri, address))
}

fn http_client(local_address: Ipv4Addr, timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .local_address(IpAddr::V4(local_address))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(timeout)
        .timeout(timeout)
        .user_agent("bilikara/0.8 UPnP/1.1")
        .build()
        .map_err(|error| format!("DLNA HTTP initialization failed: {error}"))
}

fn bounded_body(response: reqwest::blocking::Response, limit: usize) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("DLNA HTTP response exceeds its size limit".to_owned());
    }
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("DLNA HTTP response failed: {error}"))?;
    if bytes.len() > limit {
        return Err("DLNA HTTP response exceeds its size limit".to_owned());
    }
    String::from_utf8(bytes).map_err(|error| format!("DLNA HTTP response is not UTF-8: {error}"))
}

fn load_description(
    advertisement: &Advertisement,
    timeout: Duration,
    policy: NetworkPolicy,
) -> Result<Renderer, String> {
    let client = http_client(advertisement.local_address, timeout)?;
    let response = client
        .get(advertisement.location.clone())
        .header(reqwest::header::ACCEPT, "text/xml, application/xml")
        .send()
        .map_err(|error| format!("DLNA description request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "DLNA description returned HTTP {}",
            response.status()
        ));
    }
    parse_description(
        &bounded_body(response, MAX_DESCRIPTION)?,
        advertisement,
        policy,
    )
}

fn direct_text<'a>(node: Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == name)
        .and_then(|child| child.text())
        .map(str::trim)
}

fn parse_description(
    source: &str,
    advertisement: &Advertisement,
    policy: NetworkPolicy,
) -> Result<Renderer, String> {
    let document = Document::parse(source)
        .map_err(|error| format!("Invalid DLNA description XML: {error}"))?;
    let renderer = document
        .descendants()
        .find(|node| {
            node.is_element()
                && node.tag_name().name() == "device"
                && direct_text(*node, "deviceType")
                    .is_some_and(|kind| kind.contains(":device:MediaRenderer:"))
        })
        .ok_or_else(|| "UPnP device is not a MediaRenderer".to_owned())?;
    let (_, address) = lan_url(advertisement.location.as_str(), policy)?;
    let base = direct_text(document.root_element(), "URLBase")
        .filter(|value| !value.is_empty())
        .unwrap_or(advertisement.location.as_str());
    let (base, base_address) = lan_url(base, policy)?;
    if address != base_address {
        return Err("DLNA URLBase must belong to the responding renderer".to_owned());
    }
    let service_list = renderer
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "serviceList")
        .ok_or_else(|| "MediaRenderer has no service list".to_owned())?;
    let (service_type, control) = service_list
        .children()
        .filter(|node| node.is_element() && node.tag_name().name() == "service")
        .filter_map(|node| {
            let kind = direct_text(node, "serviceType")?;
            if !kind.starts_with("urn:schemas-upnp-org:service:AVTransport:") {
                return None;
            }
            let version = kind.rsplit(':').next()?.parse::<u32>().ok()?;
            let control = direct_text(node, "controlURL")?;
            (!control.is_empty()).then_some((version, kind, control))
        })
        .max_by_key(|(version, _, _)| *version)
        .map(|(_, kind, control)| (kind, control))
        .ok_or_else(|| "MediaRenderer has no AVTransport service".to_owned())?;
    // Some MStar/Myou devices use a colon in a relative path's first segment.
    let control = if !control.starts_with('/') && control.contains(':') && !control.contains("://")
    {
        format!("./{control}")
    } else {
        control.to_owned()
    };
    let control = base
        .join(&control)
        .map_err(|error| format!("Invalid DLNA control URL: {error}"))?;
    let (_, control_address) = lan_url(control.as_str(), policy)?;
    if address != control_address {
        return Err("DLNA control URL must belong to the responding renderer".to_owned());
    }
    let declared_id = direct_text(renderer, "UDN").unwrap_or_default();
    let id = if declared_id.is_empty() {
        if advertisement.usn.is_empty() {
            advertisement.location.as_str()
        } else {
            &advertisement.usn
        }
    } else {
        declared_id
    };
    let name = direct_text(renderer, "friendlyName")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| advertisement.location.host_str().unwrap_or_default());
    Ok(Renderer {
        id: id.to_owned(),
        name: name.to_owned(),
        location: advertisement.location.to_string(),
        av_transport_url: control.to_string(),
        av_transport_type: service_type.to_owned(),
        local_address: advertisement.local_address,
    })
}

#[derive(Debug)]
enum InvokeError {
    Transport(String),
    Soap(String),
}

impl std::fmt::Display for InvokeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) | Self::Soap(message) => formatter.write_str(message),
        }
    }
}

fn validated_renderer(renderer: &Renderer, policy: NetworkPolicy) -> Result<Url, String> {
    let (_, address) = lan_url(&renderer.location, policy)?;
    let (control, control_address) = lan_url(&renderer.av_transport_url, policy)?;
    if address != control_address || !policy.allows(renderer.local_address) {
        return Err("DLNA renderer has an invalid LAN control route".to_owned());
    }
    if !renderer
        .av_transport_type
        .strip_prefix("urn:schemas-upnp-org:service:AVTransport:")
        .is_some_and(|version| version.parse::<u32>().is_ok())
    {
        return Err("DLNA renderer has an invalid AVTransport service type".to_owned());
    }
    Ok(control)
}

fn xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn invoke(
    client: &Client,
    renderer: &Renderer,
    control: &Url,
    action: &str,
    arguments: &[(&str, &str)],
) -> Result<(), InvokeError> {
    let arguments: String = arguments
        .iter()
        .map(|(name, value)| format!("<{name}>{}</{name}>", xml_text(value)))
        .collect();
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">{arguments}</u:{action}></s:Body></s:Envelope>",
        xml_text(&renderer.av_transport_type)
    );
    let response = client
        .post(control.clone())
        .header(reqwest::header::CONTENT_TYPE, "text/xml; charset=utf-8")
        .header(
            "SOAPACTION",
            format!("\"{}#{action}\"", renderer.av_transport_type),
        )
        .header(reqwest::header::CONNECTION, "close")
        .header(reqwest::header::CONTENT_LENGTH, body.len())
        .body(body)
        .send()
        .map_err(|error| {
            InvokeError::Transport(format!("DLNA {action} request failed: {error}"))
        })?;
    let status = response.status();
    let body = bounded_body(response, MAX_SOAP_RESPONSE).map_err(InvokeError::Transport)?;
    let document = Document::parse(&body);
    let fault = document.as_ref().ok().and_then(|document| {
        document
            .descendants()
            .find(|node| node.is_element() && node.tag_name().name() == "Fault")
    });
    if !status.is_success() || fault.is_some() {
        let detail = fault
            .map(|node| {
                node.descendants()
                    .filter(|node| node.is_element())
                    .filter(|node| {
                        matches!(
                            node.tag_name().name(),
                            "errorCode" | "errorDescription" | "faultstring"
                        )
                    })
                    .filter_map(|node| node.text())
                    .collect::<Vec<_>>()
                    .join(" · ")
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| body.chars().take(200).collect());
        return Err(InvokeError::Soap(format!(
            "DLNA {action} failed (HTTP {status}): {detail}"
        )));
    }
    if let Err(error) = document {
        return Err(InvokeError::Soap(format!(
            "Invalid DLNA {action} response XML: {error}"
        )));
    }
    Ok(())
}

/// Starts a selected renderer with Show's already-running LAN HTTP stream.
pub fn connect(renderer: &Renderer, uri: &str, title: &str) -> Result<(), String> {
    connect_with_policy(renderer, uri, title, NetworkPolicy::Lan)
}

fn connect_with_policy(
    renderer: &Renderer,
    uri: &str,
    title: &str,
    policy: NetworkPolicy,
) -> Result<(), String> {
    let control = validated_renderer(renderer, policy)?;
    let (_, stream_address) = lan_url(uri, policy)?;
    if stream_address != renderer.local_address {
        return Err("DLNA stream URL must advertise the renderer's local LAN route".to_owned());
    }
    let client = http_client(renderer.local_address, HTTP_TIMEOUT)?;
    // Freshly booted or already-stopped renderers commonly reject Stop.
    let _ = invoke(&client, renderer, &control, "Stop", &[("InstanceID", "0")]);
    let metadata = format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"0\" restricted=\"1\"><dc:title>{}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"http-get:*:video/MP2T:*\">{}</res></item></DIDL-Lite>",
        xml_text(title),
        xml_text(uri)
    );
    let set_uri = |metadata: &str| {
        invoke(
            &client,
            renderer,
            &control,
            "SetAVTransportURI",
            &[
                ("InstanceID", "0"),
                ("CurrentURI", uri),
                ("CurrentURIMetaData", metadata),
            ],
        )
    };
    match set_uri(&metadata) {
        Err(InvokeError::Soap(_)) => set_uri("").map_err(|error| error.to_string())?,
        result => result.map_err(|error| error.to_string())?,
    }
    invoke(
        &client,
        renderer,
        &control,
        "Play",
        &[("InstanceID", "0"), ("Speed", "1")],
    )
    .map_err(|error| error.to_string())
}

/// Stops the remote renderer; callers must tear down Show even if this fails.
pub fn stop(renderer: &Renderer) -> Result<(), String> {
    let control = validated_renderer(renderer, NetworkPolicy::Lan)?;
    let client = http_client(renderer.local_address, HTTP_TIMEOUT)?;
    invoke(&client, renderer, &control, "Stop", &[("InstanceID", "0")])
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;
    use std::time::Instant;

    fn advertisement(location: &str) -> Advertisement {
        Advertisement {
            location: Url::parse(location).unwrap(),
            usn: "uuid:response".to_owned(),
            local_address: Ipv4Addr::LOCALHOST,
        }
    }

    fn description(control: &str) -> String {
        format!(
            "<root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>电视 &amp; 音响</friendlyName><UDN>uuid:renderer</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/old</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType><controlURL>{control}</controlURL></service></serviceList></device></root>"
        )
    }

    #[test]
    fn description_resolves_namespaces_relative_colon_paths_and_highest_service() {
        let renderer = parse_description(
            &description("_urn:schemas-upnp-org:service:AVTransport_control"),
            &advertisement("http://127.0.0.1:9000/path/description.xml"),
            NetworkPolicy::LoopbackFixture,
        )
        .unwrap();
        assert_eq!(renderer.name, "电视 & 音响");
        assert_eq!(renderer.id, "uuid:renderer");
        assert!(renderer.av_transport_type.ends_with(":2"));
        assert_eq!(
            renderer.av_transport_url,
            "http://127.0.0.1:9000/path/_urn:schemas-upnp-org:service:AVTransport_control"
        );
    }

    #[test]
    fn description_rejects_external_controls_and_non_renderers() {
        let advertisement = advertisement("http://192.168.1.12/device.xml");
        assert!(
            parse_description(
                &description("http://192.168.1.13/control"),
                &advertisement,
                NetworkPolicy::Lan
            )
            .is_err()
        );
        assert!(
            parse_description(
                &description("http://1.1.1.1/control"),
                &advertisement,
                NetworkPolicy::Lan
            )
            .is_err()
        );
        assert!(
            parse_description(
                &description("/control").replace(
                    "<device>",
                    "<URLBase>http://192.168.1.13/</URLBase><device>"
                ),
                &advertisement,
                NetworkPolicy::Lan
            )
            .is_err()
        );
        assert!(parse_description("<root><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType></device></root>", &advertisement, NetworkPolicy::Lan).is_err());
    }

    fn read_request(stream: &mut TcpStream) -> (String, String) {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut byte = [0_u8; 1];
        while !request.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            request.push(byte[0]);
            assert!(request.len() < 64 * 1024);
        }
        let headers = String::from_utf8(request).unwrap();
        let length: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        assert!(!headers.to_lowercase().contains("transfer-encoding:"));
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        (headers, String::from_utf8(body).unwrap())
    }

    #[test]
    fn actual_http_soap_retries_metadata_and_preserves_xml_arguments() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let uri = format!("http://{address}/cast/stage.ts?a=1&b=2");
        let fixture_uri = uri.clone();
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            let actions = ["Stop", "SetAVTransportURI", "SetAVTransportURI", "Play"];
            for (index, action) in actions.iter().enumerate() {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        result => panic!("SOAP fixture did not receive {action}: {result:?}"),
                    }
                };
                let (headers, body) = read_request(&mut stream);
                assert!(headers.contains(&format!("#{action}\"")));
                assert!(headers.to_lowercase().contains("connection: close"));
                let document = Document::parse(&body).unwrap();
                if *action == "SetAVTransportURI" {
                    let current_uri = document
                        .descendants()
                        .find(|node| node.is_element() && node.tag_name().name() == "CurrentURI")
                        .unwrap()
                        .text()
                        .unwrap();
                    assert_eq!(current_uri, fixture_uri);
                    let metadata = document
                        .descendants()
                        .find(|node| {
                            node.is_element() && node.tag_name().name() == "CurrentURIMetaData"
                        })
                        .unwrap()
                        .text()
                        .unwrap_or_default();
                    if index == 1 {
                        let metadata = Document::parse(metadata).unwrap();
                        let title = metadata
                            .descendants()
                            .find(|node| node.is_element() && node.tag_name().name() == "title")
                            .unwrap()
                            .text()
                            .unwrap();
                        assert_eq!(title, "歌曲 <一> & \"二\"");
                    } else {
                        assert_eq!(metadata, "");
                    }
                }
                let (status, response_body) = if index == 1 {
                    ("500 Internal Server Error", "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError><errorCode>714</errorCode><errorDescription>Unsupported metadata</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>".to_owned())
                } else {
                    (
                        "200 OK",
                        format!(
                            "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"/></s:Body></s:Envelope>"
                        ),
                    )
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}", response_body.len()).unwrap();
            }
        });
        let renderer = Renderer {
            id: "fixture".to_owned(),
            name: "fixture".to_owned(),
            location: format!("http://{address}/description.xml"),
            av_transport_url: format!("http://{address}/control"),
            av_transport_type: "urn:schemas-upnp-org:service:AVTransport:1".to_owned(),
            local_address: Ipv4Addr::LOCALHOST,
        };
        let result = connect_with_policy(
            &renderer,
            &uri,
            "歌曲 <一> & \"二\"",
            NetworkPolicy::LoopbackFixture,
        );
        worker.join().unwrap();
        result.unwrap();
        assert!(connect(&renderer, &uri, "fixture").is_err());
    }
}
