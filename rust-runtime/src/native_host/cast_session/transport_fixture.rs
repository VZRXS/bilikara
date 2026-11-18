//! Test-only adapter to T2's existing loopback transport policy.
use super::*;
pub(crate) fn control(renderer: Renderer) -> Result<control::ControlClient, DlnaError> {
    control::ControlClient::with_policy(
        renderer,
        &[Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        HTTP_TIMEOUT,
    )
}

pub(crate) fn renderer(location: &str, description: &str) -> Renderer {
    Renderer {
        description: dlna_policy::parse_description(
            description,
            location,
            "",
            "",
            NetworkPolicy::LoopbackFixture,
        )
        .unwrap(),
        local_address: Ipv4Addr::LOCALHOST,
        context: DeviceContext::new(
            DiscoverySource::Manual,
            location,
            "uuid:cast-fixture",
            "fixture",
        ),
    }
}
