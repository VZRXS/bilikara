//! Exercise discover(), not just DiscoveryLease. Only network inputs are replaced:
//! real socket creation, UDP M-SEARCH, collection, cancellation and Drop still run.
use super::*;
use crate::cast_platform::{
    self,
    test_support::{self, RecordingPlatform},
};
use std::{cell::RefCell, sync::Arc};

type Setup = (Vec<Ipv4Addr>, NetworkPolicy, Options);
thread_local! {
    static SETUP: RefCell<Option<Setup>> = const { RefCell::new(None) };
}
pub(super) fn setup() -> Option<Setup> {
    SETUP.with(|v| v.borrow().clone())
}
fn scoped<T>(interfaces: Vec<Ipv4Addr>, destination: SocketAddr, action: impl FnOnce() -> T) -> T {
    struct Reset(Option<Setup>);
    impl Drop for Reset {
        fn drop(&mut self) {
            SETUP.with(|v| *v.borrow_mut() = self.0.take());
        }
    }
    let _reset = Reset(SETUP.with(|v| {
        v.replace(Some((
            interfaces,
            NetworkPolicy::LoopbackFixture,
            Options {
                destination,
                window: Duration::from_millis(120),
                notify_port: 0,
                ..Options::default()
            },
        )))
    }));
    action()
}

#[test]
fn discover_platform_lease_covers_udp_and_releases_on_finish_cancel_error_and_drop() {
    test_support::scoped(|| {
        let platform = Arc::new(RecordingPlatform::default());
        cast_platform::install(platform.clone()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let udp = StdUdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        udp.set_nonblocking(true).unwrap();
        let destination = udp.local_addr().unwrap();
        scoped(vec![Ipv4Addr::LOCALHOST], destination, || {
            runtime.block_on(async {
                let receiver = UdpSocket::from_std(udp).unwrap();
                let cancel = CancellationToken::new();
                let mut finished_at = None;
                let result = discover(&cancel, |event| {
                    assert_eq!(
                        platform.active(),
                        1,
                        "lock must cover every discovery stage"
                    );
                    if matches!(event, DiscoveryUpdate::Stage(ref stage) if stage.stage == Stage::Discovery) {
                        finished_at = Some(Instant::now());
                    }
                })
                .await;
                assert!(result.result.is_ok());
                assert!(finished_at.unwrap().elapsed() < Duration::from_secs(1));
                let mut buffer = [0; 4096];
                let (size, _) = receiver
                    .try_recv_from(&mut buffer)
                    .expect("actual M-SEARCH reached loopback");
                assert!(buffer[..size].starts_with(b"M-SEARCH "));
                platform.assert_finished(1);

                let cancel = CancellationToken::new();
                let mut cancelled_at = None;
                let result = discover(&cancel, |_| {
                    assert_eq!(platform.active(), 1);
                    cancelled_at.get_or_insert_with(Instant::now);
                    cancel.cancel();
                })
                .await;
                assert_eq!(result.result.unwrap_err().code, ErrorCode::Cancelled);
                assert!(cancelled_at.unwrap().elapsed() < Duration::from_secs(1));
                platform.assert_finished(2);

                let cancel = CancellationToken::new();
                let dropped_at;
                {
                    let scan = discover(&cancel, |_| assert_eq!(platform.active(), 1));
                    tokio::pin!(scan);
                    tokio::select! {
                        _ = &mut scan => panic!("scan should still be running"),
                        _ = tokio::time::sleep(Duration::from_millis(20)) => {}
                    }
                    assert_eq!(platform.active(), 1);
                    dropped_at = Instant::now();
                }
                assert!(dropped_at.elapsed() < Duration::from_secs(1));
                platform.assert_finished(3);
            })
        });
        scoped(vec![], destination, || {
            runtime.block_on(async {
                let since = Instant::now();
                let result = discover(&CancellationToken::new(), |_| {
                    assert_eq!(platform.active(), 1)
                })
                .await;
                assert_eq!(result.result.unwrap_err().code, ErrorCode::NoInterfaces);
                assert!(since.elapsed() < Duration::from_secs(1));
                platform.assert_finished(4);
            })
        });
    });
}
