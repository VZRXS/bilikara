//! Test-only access to the existing private loopback transport; no production API change.
use super::*;

pub(crate) async fn discover(
    location: String,
    trace: &super::super::diagnostics::SessionTrace,
    connection: u64,
) -> Renderer {
    let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let destination = udp.local_addr().unwrap();
    let cancel = CancellationToken::new();
    let stopping = cancel.clone();
    let worker = tokio::spawn(async move {
        let mut buffer = [0; 4096];
        loop {
            let (_, peer) = tokio::select! {
                biased;
                _ = stopping.cancelled() => break,
                response = udp.recv_from(&mut buffer) => response.unwrap(),
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nLOCATION: {location}\r\nUSN: uuid:fixture::upnp:rootdevice\r\nSERVER: fixture/1\r\n\r\n"
            );
            udp.send_to(response.as_bytes(), peer).await.unwrap();
        }
    });
    let mut found = None;
    let operation = discover_on(
        vec![Ipv4Addr::LOCALHOST],
        NetworkPolicy::LoopbackFixture,
        Options {
            window: SEARCH_WINDOW,
            destination,
            notify_port: 0,
            route_lookup: |_| Ok(Ipv4Addr::LOCALHOST),
        },
        &cancel,
        |update| {
            trace.discovery(connection, &update);
            if let DiscoveryUpdate::Renderers(renderers) = update
                && let Some(renderer) = renderers.into_iter().next()
            {
                found = Some(renderer);
                cancel.cancel();
            }
        },
    )
    .await;
    cancel.cancel();
    worker.await.unwrap();
    assert!(operation.result.unwrap_err().is_cancelled());
    found.expect("discovery must publish the real HTTP description before cancellation")
}
