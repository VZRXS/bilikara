use super::*;

#[path = "tests/inspect.rs"]
mod inspect;
pub(super) use inspect::inspect_ts;

#[test]
fn packaged_sample_is_pinned_and_corruption_is_rejected() {
    let bytes = include_bytes!("../../../../../resources/cast-samples/sample-b.ts");
    assert!(samples::verified(bytes));
    let mut broken = bytes.to_vec();
    broken[0] ^= 1;
    assert!(!samples::verified(&broken));
    assert!(!samples::verified(&bytes[..bytes.len() - 1]));
}

pub(crate) async fn run(
    context: Arc<HostContext>,
    renderer: Option<Renderer>,
    qr: Option<String>,
    cancel: CancellationToken,
    send: mpsc::Sender<AnswerEnvelope>,
    receive: mpsc::Receiver<AnswerEnvelope>,
    timing: runner::Timing,
) -> diag::Report {
    samples::MUX_COUNT.store(0, Ordering::Relaxed);
    // Queued answers from an earlier cell/run must never become current answers.
    send.try_send(AnswerEnvelope {
        cell: Cell::FileB,
        question_id: 0,
        answers: UserAnswers {
            video: diag::VideoAnswer::Unsupported,
            ..Default::default()
        },
    })
    .unwrap();
    let trace = Arc::new(
        SessionTrace::new(
            worker::platform(),
            if qr.is_some() {
                diag::TargetKind::Purek
            } else {
                diag::TargetKind::Generic
            },
            "0.8.0",
            "11",
        )
        .unwrap(),
    );
    with_app(|app| {
        let cast = &mut app.native().cast;
        cast.self_test = State {
            generation: 1,
            running: true,
            cancel: cancel.clone(),
            answers: Some(send),
            trace: Some(trace.clone()),
            ..Default::default()
        };
        Ok(())
    })
    .unwrap();
    let next = runner::run(
        context.clone(),
        1,
        Request {
            renderer,
            qr,
            confirmed: false,
        },
        trace.clone(),
        cancel.clone(),
        receive,
        timing,
    )
    .await;
    complete(1, &trace, cancel.is_cancelled());
    if let Some(next) = next {
        let previous = with_app(|app| Ok(app.native().cast.operation)).unwrap();
        worker::handoff(&context, previous, next.renderer, next.room, &cancel).await;
    }
    update(1, |s| {
        s.running = false;
        s.question = false;
    });
    trace.report()
}

pub(crate) async fn question() -> Value {
    loop {
        let (notify, state) = with_app(|app| {
            Ok((
                app.native().cast.self_test.changed.clone(),
                app.native().cast.self_test.snapshot(),
            ))
        })
        .unwrap();
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let state = with_app(|app| Ok(app.native().cast.self_test.snapshot())).unwrap_or(state);
        if state["question"] == true
            || state["handoff_available"] == true
            || (state["generation"] == 1 && state["running"] == false)
        {
            return state;
        }
        tokio::time::timeout(Duration::from_secs(45), notified)
            .await
            .expect("self-test must make progress");
    }
}

pub(crate) fn mux_count() -> usize {
    samples::MUX_COUNT.load(Ordering::Relaxed)
}

pub(crate) async fn file_sample_is_vbr(context: Arc<HostContext>) {
    samples::assert_file_sample_is_vbr(context).await;
}

pub(crate) fn recorded_end_us() -> i64 {
    samples::RECORDED_END_US.load(Ordering::Relaxed)
}

pub(crate) fn expired_answer(context: &Arc<HostContext>, identity: &Identity, body: &Value) {
    let old = with_app(|app| {
        let s = &mut app.native().cast.self_test;
        let old = s.question_deadline_ms;
        s.question_deadline_ms = Some(0);
        Ok(old)
    })
    .unwrap();
    assert_eq!(
        route(
            context,
            identity,
            &Method::POST,
            "/api/cast/self-test/answer",
            body
        )
        .unwrap_err()
        .code,
        "cast_self_test_stale"
    );
    update(1, |s| s.question_deadline_ms = old);
}
