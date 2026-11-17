//! Receiver-free T3 -> T4 check. URLs, paths and input media never enter its result.
use super::*;
use crate::dlna::cast_http::{CastEndpoint, TsMime};
use crate::experimental_libav::cast_mux::{CastFormat, CastSession};

pub(super) async fn run(context: Arc<HostContext>, cancel: &CancellationToken) -> Value {
    if !media::probe().is_ok_and(|probe| probe.cast_mux_available()) {
        return json!({"ok":false,"code":"cast_backend_unavailable"});
    }
    let (_sample_lease, uniform) = self_test::samples::load_uniform(context.clone()).await;
    let sample_b = match uniform {
        Ok(_) => "verified",
        Err(crate::dlna::diagnostics::SkipReason::PlatformUnavailable) => {
            return json!({"ok":false,"code":"cast_sample_not_integrated"});
        }
        Err(crate::dlna::diagnostics::SkipReason::SampleIntegrityFailed) => "integrity_failed",
        Err(_) => "unavailable",
    };
    let result = check(context, cancel).await;
    match result {
        Ok(()) => json!({"ok":true,"first_byte":true,"sample_b":sample_b}),
        Err(code) => json!({"ok":false,"code":code,"sample_b":sample_b}),
    }
}

async fn check(context: Arc<HostContext>, cancel: &CancellationToken) -> Result<(), &'static str> {
    let session = Arc::new(
        CastSession::new(&context.cache_root, media::MAX_BYTES)
            .map_err(|_| "cast_prepare_failed")?,
    );
    let sample = self_test::samples::prepare(context, session.clone(), None, cancel)
        .await
        .map_err(|reason| match reason {
            crate::dlna::diagnostics::SkipReason::NoCachedSong => "cast_no_media",
            crate::dlna::diagnostics::SkipReason::Cancelled => "cast_cancelled",
            _ => "cast_prepare_failed",
        })?;
    let file = self_test::samples::remux(session, sample, CastFormat::Ts, cancel)
        .await
        .map_err(|_| "cast_prepare_failed")?;
    let endpoint = CastEndpoint::bind_pipeline()
        .await
        .map_err(|_| "cast_pipeline_failed")?;
    let result = async {
        let media = endpoint
            .publish_file(1, file, TsMime::Mp2t)
            .map_err(|_| "cast_pipeline_failed")?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "cast_pipeline_failed")?;
        let mut response = client
            .get(media.uri)
            .header("Range", "bytes=0-187")
            .send()
            .await
            .map_err(|_| "cast_pipeline_failed")?;
        if !response.status().is_success() {
            return Err("cast_pipeline_failed");
        }
        let bytes = response
            .chunk()
            .await
            .map_err(|_| "cast_pipeline_failed")?
            .ok_or("cast_pipeline_failed")?;
        if bytes.first() != Some(&0x47) {
            return Err("cast_pipeline_failed");
        }
        Ok(())
    };
    let checked = tokio::select! {
        _ = cancel.cancelled() => Err("cast_cancelled"),
        result = result => result,
    };
    endpoint.shutdown().await;
    checked
}

// R2 A4 receiver-free check supplements next's existing local L1 preview.
pub(super) fn start(context: &Arc<HostContext>) -> Result<(), ApiError> {
    with_app(|app| {
        let state = &mut app.native().cast;
        if state.pipeline_running || state.self_test.running {
            return Ok(());
        }
        state.pipeline_running = true;
        state.pipeline_result = None;
        let context = context.clone();
        let worker_context = context.clone();
        if context.spawn("cast-pipeline-check", move || {
            let cancel = CancellationToken::new();
            let result = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2).enable_all().build().map(|runtime| runtime.block_on(async {
                    let check = run(worker_context.clone(), &cancel);
                    let stop = async {
                        loop {
                            if worker_context.stop.load(Ordering::Acquire) || !with_app(|app| Ok(app.native().local_output.controller.owns_playback)).unwrap_or(false) {
                                cancel.cancel(); break;
                            }
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    };
                    tokio::pin!(check);
                    tokio::select! { result = &mut check => result, _ = stop => check.await }
                })).unwrap_or_else(|_| json!({"ok":false,"code":"cast_backend_unavailable"}));
            let _ = with_app(|app| {
                app.native().cast.pipeline_running = false;
                app.native().cast.pipeline_result = Some(result);
                app.native().revision += 1;
                Ok(())
            });
        }).is_err() {
            state.pipeline_running = false;
            return Err(ApiError::new(503, "cast_worker_unavailable", "Cannot start pipeline check"));
        }
        app.native().revision += 1;
        Ok(())
    })
}
