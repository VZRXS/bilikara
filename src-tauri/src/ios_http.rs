//! Owned main-document JSON I/O. No UIKit object crosses the worker boundary.
use crate::{
    ios_bridge_policy::HostFramePolicy,
    ios_platform::{HostWebView, reply_data},
};
use bilikara_runtime::native_host::{NativeJsonClient, NativeJsonRequest};
use block2::RcBlock;
use objc2::rc::Weak;
use objc2_foundation::{MainThreadMarker, NSOperationQueue};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

struct Job {
    view: Weak<HostWebView>,
    policy: HostFramePolicy,
}
thread_local! {static JOBS: RefCell<HashMap<(String,u32),Job>> = RefCell::new(HashMap::new());}
static ACTIVE: AtomicUsize = AtomicUsize::new(0);

fn finish(document: &str, id: u32, result: Value) {
    if MainThreadMarker::new().is_none() {
        return;
    }
    let Some(job) = JOBS.with(|jobs| jobs.borrow_mut().remove(&(document.to_owned(), id))) else {
        return;
    };
    let Some(view) = job.view.load() else {
        return;
    };
    let current = unsafe { view.url() }
        .and_then(|url| url.absoluteString())
        .map(|url| url.to_string());
    if !current.is_some_and(|url| job.policy.allows(true, true, &url, &url)) {
        return;
    }
    reply_data(&view, document, id, Some(result));
}

pub(crate) fn start(
    view: &HostWebView,
    policy: HostFramePolicy,
    document: String,
    id: u32,
    request: Value,
    client: Option<NativeJsonClient>,
) {
    let request = serde_json::from_value::<NativeJsonRequest>(request);
    let Some(client) = client else {
        reply_data(
            view,
            &document,
            id,
            Some(json!({"transport_error":"native_api_unavailable"})),
        );
        return;
    };
    let Ok(request) = request else {
        reply_data(
            view,
            &document,
            id,
            Some(json!({"transport_error":"native_api_request"})),
        );
        return;
    };
    if ACTIVE
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 16).then_some(n + 1)
        })
        .is_err()
    {
        reply_data(
            view,
            &document,
            id,
            Some(json!({"transport_error":"native_api_busy"})),
        );
        return;
    }
    let admitted = JOBS.with(|jobs| {
        let mut jobs = jobs.borrow_mut();
        if jobs.len() >= 16 {
            return false;
        }
        jobs.insert(
            (document.clone(), id),
            Job {
                view: Weak::new(view),
                policy,
            },
        );
        true
    });
    if !admitted {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
        reply_data(
            view,
            &document,
            id,
            Some(json!({"transport_error":"native_api_busy"})),
        );
        return;
    }
    let worker_document = document.clone();
    let spawned = std::thread::Builder::new()
        .name("bilikara-ios-host-json".into())
        .spawn(move || {
            struct Release;
            impl Drop for Release {
                fn drop(&mut self) {
                    ACTIVE.fetch_sub(1, Ordering::AcqRel);
                }
            }
            let _release = Release;
            let reply = match client.execute(request) {
                Ok(reply) => serde_json::to_value(reply).expect("native JSON reply"),
                Err(code) => json!({"transport_error":code}),
            };
            let result = Mutex::new(Some(reply));
            let callback = RcBlock::new(move || {
                if let Some(result) = result.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    finish(&worker_document, id, result);
                }
            });
            unsafe {
                NSOperationQueue::mainQueue().addOperationWithBlock(&callback);
            }
        });
    if spawned.is_err() {
        ACTIVE.fetch_sub(1, Ordering::AcqRel);
        finish(
            &document,
            id,
            json!({"transport_error":"native_api_worker"}),
        );
    }
}

/// Retiring a reply never rolls back or repeats a command already sent to Rust.
pub(crate) fn cancel(document: &str, id: Option<u32>, retire: bool) {
    JOBS.with(|jobs| {
        jobs.borrow_mut().retain(|(doc, key), _| {
            !if let Some(id) = id {
                doc == document && *key == id
            } else {
                (doc == document) == retire
            }
        })
    });
}
