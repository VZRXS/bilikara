use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

// Only this suite touches catalog cache state; other tests use pure normalization.
static CACHE_TEST: Mutex<()> = Mutex::new(());
fn request(query: &str) -> CatalogRequest {
    CatalogRequest {
        base_url: "http://127.0.0.1:1".into(),
        operation: CatalogOperation::Read {
            path: "/api/catalog/search".into(),
            query: query.into(),
        },
        ..CatalogRequest::default()
    }
}
fn raw_error(status: u16) -> CloudflareServiceError {
    CloudflareServiceError {
        kind: "http_status".into(),
        message: "private upstream text".into(),
        status_code: Some(status),
        body_preview: Some("private credentials".into()),
    }
}
fn clear() {
    with_catalog(|s| {
        *s = CatalogState::default();
        Ok(())
    })
    .unwrap();
}

#[test]
fn primary_success_empty_cache_expiry_backoff_and_authorization() {
    let _guard = CACHE_TEST.lock().unwrap();
    clear();
    let r = request("q=fixture");
    let count = AtomicUsize::new(0);
    let fetch = |r: &CloudflareServiceRequest| {
        count.fetch_add(1, Ordering::SeqCst);
        let CloudflareOperation::Request {
            method,
            path,
            payload,
            authorization,
        } = &r.operation
        else {
            panic!()
        };
        assert_eq!(method, "GET");
        assert!(path.starts_with("/search?"));
        assert!(payload.is_none());
        assert!(authorization.is_empty());
        Ok(json!({"payload":[]}))
    };
    assert_eq!(execute_with(&r, &fetch).unwrap(), json!({"items":[]}));
    assert_eq!(execute_with(&r, &fetch).unwrap(), json!({"items":[]}));
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "D1 empty success is cached, not an outage"
    );
    with_catalog(|s| {
        s.cache.front_mut().unwrap().1 = Instant::now() - Duration::from_secs(61);
        Ok(())
    })
    .unwrap();
    let error = execute_with(&r, &|_| Err(raw_error(503))).unwrap_err();
    assert!(error.fallback_eligible);
    assert!(!error.message.contains("private"));
    assert_eq!(
        execute_with(&r, &|_| panic!("backoff should suppress HTTP"))
            .unwrap_err()
            .status_code,
        503
    );
    assert!(
        with_catalog(|s| Ok(s.cache.is_empty())).unwrap(),
        "expired data must never be served on error"
    );
    clear();
    for status in [400, 401, 403, 404, 409, 422] {
        let error = execute_with(&r, &|_| Err(raw_error(status))).unwrap_err();
        assert_eq!(error.status_code, status);
        assert!(!error.fallback_eligible);
    }
    assert!(
        execute_with(&r, &fetch).is_ok(),
        "authorization failure must not poison public-read cache"
    );
    clear();
}

#[test]
fn eligibility_is_explicit_and_never_used_for_mutations() {
    for status in [408, 429, 500, 502, 503, 504] {
        assert!(CatalogError::upstream(raw_error(status)).fallback_eligible);
    }
    for status in [301, 400, 401, 403, 404, 409, 422, 501] {
        assert!(!CatalogError::upstream(raw_error(status)).fallback_eligible);
    }
    for kind in ["timeout", "transport", "invalid_json", "response_too_large"] {
        let mut e = raw_error(200);
        e.kind = kind.into();
        assert!(CatalogError::upstream(e).fallback_eligible);
    }
    let r = CatalogRequest {
        operation: CatalogOperation::Mutate {
            action: CatalogAction::VerifySecret,
            params: json!({"secret":"fixture"}),
        },
        ..request("")
    };
    let count = AtomicUsize::new(0);
    let result = execute_with(&r, &|_| {
        count.fetch_add(1, Ordering::SeqCst);
        Err(raw_error(403))
    })
    .unwrap();
    assert_eq!(result["success"], false);
    assert_eq!(result["status_code"], 403);
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn bounded_concurrency_releases_lock_and_invalidated_inflight_data_cannot_return() {
    let _guard = CACHE_TEST.lock().unwrap();
    clear();
    let (started, observed) = mpsc::channel();
    let (release, ready) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        execute_with(&request("q=one"), &|_| {
            // This must acquire AppState while the network request is in flight.
            with_catalog(|_| Ok(())).unwrap();
            started.send(()).unwrap();
            ready.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(json!({"payload":[{"bvid":"BV1xx411c7mD","title":"old"}]}))
        })
    });
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    let duplicate =
        std::thread::spawn(|| execute_with(&request("q=one"), &|_| panic!("duplicate fetch")));
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !with_catalog(|state| {
        Ok(state
            .inflight
            .values()
            .any(|flight| flight.waiters.load(Ordering::SeqCst) > 0))
    })
    .unwrap()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "duplicate request did not join"
        );
        std::thread::yield_now();
    }
    invalidate().unwrap();
    release.send(()).unwrap();
    assert_eq!(handle.join().unwrap().unwrap_err().kind, "catalog_changed");
    assert_eq!(
        duplicate.join().unwrap().unwrap_err().kind,
        "catalog_changed"
    );
    assert!(with_catalog(|s| Ok(s.inflight.is_empty() && s.cache.is_empty())).unwrap());
    clear();
}

#[test]
fn distinct_catalog_reads_wait_and_identical_reads_share_the_result() {
    let _guard = CACHE_TEST.lock().unwrap();
    clear();
    let calls = AtomicUsize::new(0);
    let active = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let fetch = |_: &CloudflareServiceRequest| {
        calls.fetch_add(1, Ordering::SeqCst);
        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(now, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(60));
        active.fetch_sub(1, Ordering::SeqCst);
        Ok(json!({"payload":[]}))
    };
    std::thread::scope(|scope| {
        let handles: Vec<_> = ["q=one", "q=one", "q=two", "q=three"]
            .into_iter()
            .map(|query| {
                let fetch = &fetch;
                scope.spawn(move || execute_with(&request(query), fetch))
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap().unwrap(), json!({"items":[]}));
        }
    });
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert_eq!(peak.load(Ordering::SeqCst), 2);
    clear();
}

#[test]
fn checked_bvid_urls_and_unicode_never_panic_or_fabricate_optional_fields() {
    for bad in [
        "歌曲歌曲歌曲",
        "BVSHORT",
        "javascript:evil",
        "https://example.org/video/BV1xx411c7mD",
    ] {
        assert!(normalize_bvid(bad, "").is_none());
    }
    assert_eq!(normalize_bvid("bv1xx411c7mD", "").unwrap(), "BV1xx411c7mD");
    let item=read::normalize_item(&json!({"url":"https://www.bilibili.com/video/BV1xx411c7mD?p=2","title":" 日本語, \"歌曲\"\n🎶 "})).unwrap();
    assert_eq!(item["bvid"], "BV1xx411c7mD");
    assert!(item.get("tag_1").is_none());
    assert!(item.get("preserved_1").is_none());
    assert!(read::normalize_item(&json!({"bvid":"BV1xx411c7mD","title":"已失效视频"})).is_none());
}

#[test]
fn ffi_request_deserializes_every_operation() {
    for op in [
        json!({"operation":"read","path":"/api/catalog/search","query":"q=x"}),
        json!({"operation":"normalize_entry","entry":{}}),
        json!({"operation":"append","entries":[]}),
        json!({"operation":"enqueue_append","entries":[]}),
        json!({"operation":"export","secret":"fixture","limit":5000}),
        json!({"operation":"pending_review","secret":"fixture","limit":20,"export_limit":5000}),
        json!({"operation":"approve_review","secret":"fixture","bvids":[],"limit":20,"export_limit":5000}),
        json!({"operation":"mutate","action":"verify_secret","params":{"secret":"fixture"}}),
    ] {
        let mut request = json!({"schema_version":1,"base_url":"http://127.0.0.1:1","user_agent":"fixture","timeout_ms":1000,"review_keywords":[]});
        request
            .as_object_mut()
            .unwrap()
            .extend(op.as_object().unwrap().clone());
        serde_json::from_value::<CatalogRequest>(request.clone())
            .unwrap_or_else(|e| panic!("{request}: {e}"));
    }
}

fn sheets_request(query: &str) -> CatalogRequest {
    CatalogRequest {
        sheets_url: Some("http://127.0.0.1:1/catalog.csv".into()),
        ..request(query)
    }
}
fn snapshot() -> Vec<Value> {
    sheets::parse(
        "bvid,title,url,mid,owner_name,tag_1\nBV1xx411c7mD,歌曲 日本語,,42,fixture,动画\n"
            .as_bytes(),
    )
    .unwrap()
}
#[test]
fn sheets_csv_contract_quotes_unicode_duplicates_missing_fields_and_malformed_input() {
    let csv = "\u{feff}bvid,title,url,mid,owner_name,rank\r\nBV1xx411c7mD,\"歌曲, \"\"日本語\"\"\n🎶\",,42,作者,\r\nBV1xx411c7mD,duplicate,,42,作者,\r\n,URL only,https://www.bilibili.com/video/BV1yy411c7mD?p=2,,,\r\nbad,invalid,,,,\r\n";
    let items = sheets::parse(csv.as_bytes()).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["title"], "歌曲, \"日本語\"\n🎶");
    assert_eq!(items[0]["source"], "sheets");
    assert!(items[0].get("rank").is_none());
    assert!(items[0].get("tag_1").is_none());
    assert_eq!(
        items[1]["url"],
        "https://www.bilibili.com/video/BV1yy411c7mD"
    );
    for malformed in [
        "<html>sign in</html>",
        "google.visualization.Query.setResponse({})",
        "bvid,title,url,mid,owner_name\nBV1xx411c7mD,\"unclosed,,,",
        "bvid,title,url,mid,owner_name\nBV1xx411c7mD,un\"quoted,,,",
        "bvid,title,url,mid,owner_name\nBV1xx411c7mD,\"closed\"junk,,,",
        "bvid,title,url,mid,owner_name\nBV1xx411c7mD,missing cells",
        "bvid,title,url,mid,owner_name,title\n",
        "bvid,score\nBV1xx411c7mD,5\n",
    ] {
        assert!(sheets::parse(malformed.as_bytes()).is_err(), "{malformed}");
    }
    assert!(sheets::parse(&[0xff, 0xfe]).is_err());
}
#[test]
fn fallback_only_for_eligible_search_and_reuses_snapshot_across_keywords() {
    let _guard = CACHE_TEST.lock().unwrap();
    clear();
    let r = sheets_request("q=日本語");
    let downloads = AtomicUsize::new(0);
    let fetch = |_: &str, _: &CatalogRequest| {
        downloads.fetch_add(1, Ordering::SeqCst);
        with_catalog(|_| Ok(())).unwrap(); // No AppState lock during parsing.
        Ok(snapshot())
    };
    assert_eq!(
        execute_with_fallback(&r, &|_| Ok(json!({"payload":[]})), &|_, _| panic!(
            "D1 empty is success"
        ))
        .unwrap(),
        json!({"items":[]})
    );
    clear();
    for status in [400, 401, 403, 404, 422] {
        assert_eq!(
            execute_with_fallback(&r, &|_| Err(raw_error(status)), &|_, _| panic!(
                "ineligible"
            ))
            .unwrap_err()
            .status_code,
            status
        );
    }
    let result = execute_with_fallback(&r, &|_| Err(raw_error(503)), &fetch).unwrap();
    assert_eq!(result["items"][0]["source"], "sheets");
    assert!(
        result["exclusion_coverage"]
            .as_str()
            .unwrap()
            .contains("unverified")
    );
    let result =
        execute_with_fallback(&sheets_request("q=动画"), &|_| panic!("D1 backoff"), &fetch)
            .unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(downloads.load(Ordering::SeqCst), 1);
    let result = execute_with_fallback(
        &sheets_request("q=absent"),
        &|_| panic!("D1 backoff"),
        &fetch,
    )
    .unwrap();
    assert_eq!(result["items"], json!([]));
    let browse = CatalogRequest {
        operation: CatalogOperation::Read {
            path: "/api/d1/browse".into(),
            query: String::new(),
        },
        ..r.clone()
    };
    assert!(
        execute_with_fallback(&browse, &|_| Err(raw_error(503)), &|_, _| panic!(
            "browse is D1 only"
        ))
        .is_err()
    );
    clear();
    let mutation = CatalogRequest {
        operation: CatalogOperation::Mutate {
            action: CatalogAction::VerifySecret,
            params: json!({"secret":"fixture"}),
        },
        ..r
    };
    assert_eq!(
        execute_with_fallback(&mutation, &|_| Err(raw_error(503)), &|_, _| panic!(
            "no privileged fallback"
        ))
        .unwrap()["success"],
        false
    );
    clear();
}
#[test]
fn sheets_expiry_refresh_failure_backoff_and_known_removal_exclusions() {
    let _guard = CACHE_TEST.lock().unwrap();
    clear();
    let r = sheets_request("q=歌曲");
    let outage = |_: &CloudflareServiceRequest| Err(raw_error(503));
    execute_with_fallback(&r, &outage, &|_, _| Ok(snapshot())).unwrap();
    with_catalog(|s| {
        s.sheets.snapshot.as_mut().unwrap().1 = Instant::now() - Duration::from_secs(61);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        execute_with_fallback(&r, &outage, &|_, _| Err(CatalogError::new(
            503,
            "catalog_providers_unavailable",
            "fixture"
        )))
        .unwrap_err()
        .kind,
        "catalog_providers_unavailable"
    );
    assert!(with_catalog(|s| Ok(s.sheets.snapshot.is_none())).unwrap());
    assert!(execute_with_fallback(&r, &outage, &|_, _| panic!("Sheets backoff")).is_err());
    clear();
    let removal = CatalogRequest {
        operation: CatalogOperation::Mutate {
            action: CatalogAction::DeleteVideo,
            params: json!({"bvid":"BV1xx411c7mD","secret":"fixture"}),
        },
        ..r.clone()
    };
    execute_with(&removal, &|_| Ok(json!({"payload":{"success":true}}))).unwrap();
    assert_eq!(
        execute_with_fallback(&r, &outage, &|_, _| Ok(snapshot())).unwrap()["items"],
        json!([])
    );
    invalidate().unwrap();
    assert_eq!(
        execute_with_fallback(&r, &outage, &|_, _| Ok(snapshot())).unwrap()["items"],
        json!([]),
        "fresh Sheets must not undo known deletion"
    );
    clear();
}
#[test]
fn sheets_concurrent_refresh_is_bounded_and_invalidation_rejects_old_snapshot() {
    let _guard = CACHE_TEST.lock().unwrap();
    clear();
    let (started, observed) = mpsc::channel();
    let (release, ready) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        execute_with_fallback(
            &sheets_request("q=one"),
            &|_| Err(raw_error(503)),
            &|_, _| {
                started.send(()).unwrap();
                ready.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(snapshot())
            },
        )
    });
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        execute_with_fallback(
            &sheets_request("q=two"),
            &|_| panic!("D1 backoff"),
            &|_, _| panic!("second snapshot fetch")
        )
        .unwrap_err()
        .kind,
        "catalog_busy"
    );
    invalidate().unwrap();
    release.send(()).unwrap();
    assert_eq!(handle.join().unwrap().unwrap_err().kind, "catalog_changed");
    assert!(with_catalog(|s| Ok(s.sheets.snapshot.is_none())).unwrap());
    assert!(
        execute_with_fallback(
            &sheets_request("q=歌曲"),
            &|_| Err(raw_error(503)),
            &|_, _| Ok(snapshot())
        )
        .is_ok()
    );
    clear();
}
