//! Test-only loopback listener; leaves production route admission unchanged.
use super::*;

pub(crate) async fn bind(context: DeviceContext) -> CastEndpoint {
    CastEndpoint::bind_on(
        Ipv4Addr::LOCALHOST,
        Ipv4Addr::LOCALHOST,
        context,
        ServerIdentity::new("Windows", "11").unwrap(),
        Arc::new(Semaphore::new(MAX_SESSIONS)),
        DEFAULT_STAGES,
    )
    .await
    .unwrap()
}
