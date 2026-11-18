// Adapted from bilikara-next 7750dca, native_host/purek/tests.rs (MIT), with
// ChunK-Helper 3b00533 protocol examples (MIT). See THIRD_PARTY_NOTICES.md.
use super::*;
use crate::dlna::test_support::{Fixture, Reply, fault, run};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};

mod lifecycle;
mod qr;

fn service(kind: &str, version: &str, control: &str) -> String {
    format!(
        "<service><serviceType>urn:schemas-upnp-org:service:{kind}:{version}</serviceType><controlURL>{control}</controlURL></service>"
    )
}

fn description(udn: &str, media: bool) -> String {
    describe(
        udn,
        &format!(
            "{}{}",
            service("ConnectionManager", "1", "/cm?opaque=room"),
            if media {
                service("AVTransport", "1", "/av")
            } else {
                String::new()
            }
        ),
    )
}

fn describe(udn: &str, services: &str) -> String {
    format!(
        "<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Room Secret Label</friendlyName><UDN>{udn}</UDN><serviceList>{services}</serviceList></device></root>"
    )
}

fn room_qr(base: &str, token: &str) -> String {
    let mut inner = Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
    inner
        .query_pairs_mut()
        .append_pair("url", base)
        .append_pair("token", token)
        .append_pair("name", "Secret Room Label")
        .append_pair("appid", "secret-app");
    wrap(inner.as_str(), "https://wx.chunk.cn/projection/login", true)
}

fn wrap(inner: &str, outer: &str, url_safe: bool) -> String {
    let mut url = Url::parse(outer).unwrap();
    let encoded = if url_safe {
        URL_SAFE_NO_PAD.encode(inner)
    } else {
        STANDARD.encode(inner)
    };
    url.query_pairs_mut()
        .append_pair("place_code", "secret-place")
        .append_pair("bill_id", "secret-bill")
        .append_pair("projection_url", &encoded);
    url.into()
}

fn authorization(status: u16, body: &str) -> Reply {
    Reply::raw(Some(SoapAction::SetDeviceAuthorization), status, body)
}
fn authorized() -> Reply {
    Reply::ok(SoapAction::SetDeviceAuthorization)
}
fn device(udn: &str, media: bool) -> Reply {
    Reply::raw(None, 200, description(udn, media))
}
fn client() -> PureKClient {
    PureKClient {
        policy: NetworkPolicy::LoopbackFixture,
        interfaces: Some(vec![Ipv4Addr::LOCALHOST, Ipv4Addr::new(127, 0, 0, 2)]),
        timeout: Duration::from_millis(250),
        retry_interval: Duration::from_millis(1),
        route_lookup: |_| Ok(Ipv4Addr::LOCALHOST),
        notify_destination: (Ipv4Addr::LOCALHOST, 9).into(),
    }
}
fn fixture_qr(fixture: &Fixture) -> String {
    room_qr(
        &format!("http://{}/room?room=secret-query", fixture.address),
        "token+a/b=&<secret>",
    )
}
fn connect(client: &PureKClient, fixture: &Fixture) -> PureKOperation<Session> {
    run(client.connect(
        &fixture_qr(fixture),
        AddressApproval::LanLiteralOnly,
        &CancellationToken::new(),
    ))
}
