//! Real HTTP requests on the production two-worker router. Slow synchronous
//! state/asset work must not prevent the independent health route from running.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Condvar, Mutex, atomic::AtomicUsize};
use std::time::Instant;

#[derive(Default)]
struct Stall(Mutex<bool>, Condvar);
impl Stall {
    fn wait(&self) {
        let (released, _) = self
            .1
            .wait_timeout_while(self.0.lock().unwrap(), Duration::from_secs(5), |v| !*v)
            .unwrap();
        assert!(*released, "test stall was not released");
    }
    fn release(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
}
struct Release<'a>(&'a Stall);
impl Drop for Release<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "HTTP requests did not enter the stall"
        );
        thread::sleep(Duration::from_millis(2));
    }
}

fn request(port: u16, path: &str) -> TcpStream {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    write!(socket, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: bilikara_native=transport-fixture\r\nConnection: close\r\n\r\n").unwrap();
    socket
}

fn health_while_stalled(assets: AssetSource, release: &Stall, stalled: impl Fn() -> bool) -> bool {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let context = Arc::new(HostContext {
        directory: PathBuf::new(),
        cache_root: PathBuf::new(),
        assets,
        stop: Arc::new(AtomicBool::new(false)),
        api_slots: Arc::new(Semaphore::new(32)),
        export_slots: Arc::new(Semaphore::new(1)),
        export_renderer: Default::default(),
        port,
        desktop: true,
        bind_address: std::net::Ipv4Addr::LOCALHOST,
        allowed_hosts: Default::default(),
        bbdown: None,
        aria2: Mutex::new(None),
        aria2_prepare: Mutex::new(()),
        shutdown_token: None,
        desktop_installation: None,
        workers: Mutex::new(Vec::new()),
    });
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let _release = Release(release);
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let entered = Arc::new(AtomicUsize::new(0));
    let requests_entered = entered.clone();
    runtime.spawn(async move {
        let router =
            Router::new()
                .fallback(handle)
                .with_state(context)
                .layer(axum::middleware::from_fn(
                    move |request: Request<Body>, next: axum::middleware::Next| {
                        let entered = requests_entered.clone();
                        async move {
                            if request.uri().path() == "/app.js" {
                                entered.fetch_add(1, Ordering::AcqRel);
                            }
                            next.run(request).await
                        }
                    },
                ));
        axum::serve(
            tokio::net::TcpListener::from_std(listener).unwrap(),
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
    });
    let pending = [request(port, "/app.js"), request(port, "/app.js")];
    wait_until(|| entered.load(Ordering::Acquire) == 2 && stalled());
    let mut line = String::new();
    let health = BufReader::new(request(port, "/api/health")).read_line(&mut line);
    release.release();
    for socket in pending {
        let mut status = String::new();
        BufReader::new(socket).read_line(&mut status).unwrap();
        assert!(
            status.starts_with("HTTP/1.1 200 "),
            "pending asset request: {status}"
        );
    }
    let _ = stop.send(());
    runtime.shutdown_timeout(Duration::from_secs(3));
    health.is_ok() && line.starts_with("HTTP/1.1 200 ")
}

fn isolated(action: impl FnOnce()) {
    let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let previous = with_app(|app| {
        let previous = std::mem::take(app.native());
        app.native().host_token = "transport-fixture".into();
        Ok(previous)
    })
    .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action));
    with_app(|app| {
        *app.native() = previous;
        Ok(())
    })
    .unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

#[test]
fn stalled_state_admission_keeps_http_health_responsive() {
    isolated(|| {
        let stall = Stall::default();
        let held = AtomicBool::new(false);
        let responsive = thread::scope(|scope| {
            scope.spawn(|| {
                with_app(|_| {
                    held.store(true, Ordering::Release);
                    stall.wait();
                    Ok(())
                })
                .unwrap()
            });
            wait_until(|| held.load(Ordering::Acquire));
            health_while_stalled(
                Arc::new(|_| {
                    Some(Asset {
                        bytes: b"fixture".to_vec(),
                        mime: "text/javascript".into(),
                    })
                }),
                &stall,
                || true,
            )
        });
        assert!(
            responsive,
            "state admission must not occupy the HTTP I/O workers"
        );
    });
}

#[test]
fn stalled_asset_reads_keep_http_health_responsive() {
    isolated(|| {
        let stall = Arc::new(Stall::default());
        let reads = Arc::new(AtomicUsize::new(0));
        let assets = {
            let stall = stall.clone();
            let reads = reads.clone();
            Arc::new(move |_: &str| {
                reads.fetch_add(1, Ordering::AcqRel);
                stall.wait();
                Some(Asset {
                    bytes: b"fixture".to_vec(),
                    mime: "text/javascript".into(),
                })
            }) as AssetSource
        };
        let responsive =
            health_while_stalled(assets, &stall, || reads.load(Ordering::Acquire) == 2);
        assert!(
            responsive,
            "filesystem reads must not occupy the HTTP I/O workers"
        );
    });
}

#[test]
fn uncontended_lease_cleanup_remains_immediate_and_runs_once() {
    isolated(|| {
        let calls = Arc::new(AtomicUsize::new(0));
        let completed = calls.clone();
        retire_state(move |_| {
            completed.fetch_add(1, Ordering::AcqRel);
            Ok(())
        });
        assert_eq!(calls.load(Ordering::Acquire), 1);
    });
}

#[test]
fn contended_lease_cleanup_keeps_async_workers_running_and_drains_on_shutdown() {
    isolated(|| {
        let stall = Stall::default();
        let held = AtomicBool::new(false);
        let entered = Arc::new(AtomicUsize::new(0));
        let completed = Arc::new(AtomicUsize::new(0));
        let responsive = thread::scope(|scope| {
            scope.spawn(|| {
                with_app(|_| {
                    held.store(true, Ordering::Release);
                    stall.wait();
                    Ok(())
                })
                .unwrap()
            });
            wait_until(|| held.load(Ordering::Acquire));
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            let _release = Release(&stall);
            for _ in 0..2 {
                let entered = entered.clone();
                let completed = completed.clone();
                runtime.spawn(async move {
                    entered.fetch_add(1, Ordering::AcqRel);
                    retire_state(move |_| {
                        completed.fetch_add(1, Ordering::AcqRel);
                        Ok(())
                    });
                });
            }
            wait_until(|| entered.load(Ordering::Acquire) == 2);
            let (tick, ticked) = std::sync::mpsc::channel();
            runtime.spawn(async move {
                tokio::time::sleep(Duration::from_millis(1)).await;
                let _ = tick.send(());
            });
            let responsive = ticked.recv_timeout(Duration::from_millis(500)).is_ok();
            assert_eq!(completed.load(Ordering::Acquire), 0);
            stall.release();
            runtime.shutdown_timeout(Duration::from_secs(3));
            assert_eq!(completed.load(Ordering::Acquire), 2);
            responsive
        });
        assert!(
            responsive,
            "lease cancellation must not park the I/O workers"
        );
    });
}
