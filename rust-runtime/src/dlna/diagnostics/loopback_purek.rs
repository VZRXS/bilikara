//! Test-only construction of the existing loopback policy, isolated from production.
use super::*;

pub(crate) async fn connect(qr: &str) -> PureKOperation<Session> {
    client()
        .connect(
            qr,
            AddressApproval::LanLiteralOnly,
            &CancellationToken::new(),
        )
        .await
}

pub(crate) fn client() -> PureKClient {
    PureKClient {
        policy: NetworkPolicy::LoopbackFixture,
        interfaces: Some(vec![Ipv4Addr::LOCALHOST]),
        timeout: Duration::from_secs(2),
        retry_interval: Duration::from_millis(1),
        route_lookup: |_| Ok(Ipv4Addr::LOCALHOST),
        notify_destination: (Ipv4Addr::LOCALHOST, 9).into(),
    }
}

#[allow(dead_code)] // P6 cast-session fixtures use this parser.
pub(crate) fn parse(qr: &str) -> Result<Room, PureKError> {
    Room::parse_on(qr, NetworkPolicy::LoopbackFixture)
}
