use super::*;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

fn options() -> Options {
    Options {
        delay: 0.0,
        bili_retry_delay: 0.0,
        ..Default::default()
    }
}
fn item(id: usize) -> Value {
    json!({"bvid":format!("BV{id:010}"),"title":format!("song {id}")})
}
#[derive(Default)]
struct Fixture {
    records: Vec<Value>,
    pages: BTreeMap<(String, usize), Vec<Value>>,
    totals: BTreeMap<String, usize>,
    calls: Vec<(String, usize)>,
    failures: usize,
    uploads: Vec<Vec<Value>>,
    replies: VecDeque<Value>,
    pauses: Vec<f64>,
    export_failed: bool,
}
impl Source for Fixture {
    fn export(&mut self) -> Result<Vec<Value>, MaintenanceError> {
        if self.export_failed {
            Err(error("export", "fixture export failed"))
        } else {
            Ok(self.records.clone())
        }
    }
    fn page(&mut self, uid: &str, page: usize) -> Result<(Vec<Value>, usize), MaintenanceError> {
        self.calls.push((uid.into(), page));
        if self.failures > 0 {
            self.failures -= 1;
            return Err(error("bilibili", "fixture interrupted"));
        }
        Ok((
            self.pages
                .get(&(uid.into(), page))
                .cloned()
                .unwrap_or_default(),
            self.totals.get(uid).copied().unwrap_or(0),
        ))
    }
    fn upload(&mut self, entries: &[Value]) -> Result<Value, MaintenanceError> {
        self.uploads.push(entries.into());
        Ok(self
            .replies
            .pop_front()
            .unwrap_or(json!({"success":true,"attempted":entries.len(),"added":entries.len()})))
    }
    fn pause(&mut self, seconds: f64) {
        self.pauses.push(seconds);
    }
}
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "catalog admin 中文 & $ {}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let file = self.0.join(name);
        std::fs::write(&file, bytes).unwrap();
        file
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn independent_uid_formats_preserve_order_and_reject_unsupported_json() {
    let dir = Directory::new();
    for (name,bytes,expected) in [
        ("plain.json",r#"["https://space.bilibili.com/00042",123,"42","name 0099 end","bad",0]"#.as_bytes(),vec!["42","123","99","0"]),
        ("array.json",r#"{"uids":["0099","https://space.bilibili.com/42",99],"ignored":true}"#.as_bytes(),vec!["99","42"]),
        ("map.JSON",r#"{"ignore":0,"uids":{"900":{},"42":{},"3":{},"00042":{}}}"#.as_bytes(),vec!["900","42","3"]),
        ("lines.txt","\u{feff}# comment\n// comment\nhttps://space.bilibili.com/00042\nname 99 here\n42\n\ninvalid\n".as_bytes(),vec!["42","99"]),
    ] {assert_eq!(load_uids(&dir.file(name,bytes)).unwrap(),expected,"{name}");}
    assert_eq!(
        load_uids(&dir.file("lossy.txt", b"42\n\xff\n99")).unwrap(),
        ["42", "99"]
    );
    for (i, value) in [
        "{}",
        "{\"uids\":null}",
        "{\"uids\":1}",
        "{\"uids\":\"42\"}",
        "null",
        "1",
        "{bad",
        "\u{feff}[42]",
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            load_uids(&dir.file(&format!("bad{i}.json"), value.as_bytes()))
                .unwrap_err()
                .kind,
            "input"
        );
    }
    for (text, expected) in [
        ("https://space.bilibili.com/00042/video", Some("42")),
        ("prefix 0012 suffix", Some("12")),
        (" 7 ", Some("7")),
        ("000", Some("0")),
        ("invalid", None),
        ("", None),
    ] {
        assert_eq!(normalize_uid(text).as_deref(), expected, "{text}");
    }
}

#[test]
fn probe_has_independent_middle_latest_empty_and_invalid_boundaries() {
    let entries = vec![
        json!({"bvid":"invalid"}),
        json!({"bvid":"BVNEW0000001"}),
        json!({"bvid":"BVMID0000001"}),
        json!({"bvid":"BVOLD0000001"}),
        json!({"bvid":"BVMID0000001"}),
    ];
    let known = HashSet::from(["BVNEW0000001".into(), "BVOLD0000001".into()]);
    assert!(needs_refresh(&entries, &known, "page-any"));
    assert!(!needs_refresh(&entries, &known, "latest"));
    assert!(needs_refresh(&entries, &HashSet::new(), "latest"));
    assert!(!needs_refresh(&[json!({"bvid":"BV1"})], &known, "page-any"));
    assert!(!needs_refresh(&[], &known, "latest"));
}

#[test]
fn upload_keeps_bounded_authenticated_recipe_counters_and_atomic_known_set() {
    let entries: Vec<_> = (0..1201).map(item).collect();
    let mut fixture = Fixture::default();
    let mut config = options();
    assert_eq!(
        upload_entries(&mut fixture, &config, &entries).unwrap(),
        Upload {
            attempted: 1201,
            added: 1201,
            ..Default::default()
        }
    );
    assert_eq!(
        fixture.uploads.iter().map(Vec::len).collect::<Vec<_>>(),
        [500, 500, 201]
    );
    assert_eq!(fixture.uploads.concat(), entries);
    fixture.uploads.clear();
    config.upload_batch_size = 9000;
    upload_entries(
        &mut fixture,
        &config,
        &(0..2001).map(item).collect::<Vec<_>>(),
    )
    .unwrap();
    assert_eq!(
        fixture.uploads.iter().map(Vec::len).collect::<Vec<_>>(),
        [2000, 1]
    );
    fixture.uploads.clear();
    config.upload_batch_size = -1;
    upload_entries(&mut fixture, &config, &entries[..3]).unwrap();
    assert_eq!(
        fixture.uploads.iter().map(Vec::len).collect::<Vec<_>>(),
        [1, 1, 1]
    );
    fixture.uploads.clear();
    config.dry_run = true;
    assert_eq!(
        upload_entries(&mut fixture, &config, &entries)
            .unwrap()
            .attempted,
        1201
    );
    assert!(fixture.uploads.is_empty());
    config.dry_run = false;
    fixture.replies.push_back(json!({"success":1,"attempted":"3","added":1,"updated_existing":true,"skipped_existing":1.9,"skipped_blacklisted":2}));
    config.upload_batch_size = 500;
    assert_eq!(
        upload_entries(&mut fixture, &config, &entries[..3]).unwrap(),
        Upload {
            attempted: 3,
            added: 1,
            updated_existing: 1,
            skipped_existing: 1,
            skipped_blacklisted: 2
        }
    );
    for reply in [
        json!({"success":false}),
        json!([]),
        json!({"success":true,"added":"invalid"}),
    ] {
        fixture.replies.push_back(reply);
        assert_eq!(
            upload_entries(&mut fixture, &config, &entries[..1])
                .unwrap_err()
                .kind,
            "upload"
        );
    }
    fixture.uploads.clear();
    fixture
        .pages
        .insert(("42".into(), 1), vec![item(1), item(2)]);
    fixture
        .pages
        .insert(("99".into(), 1), vec![item(1), item(2)]);
    config.upload_batch_size = 1;
    fixture.replies = VecDeque::from([json!({"success":true}), json!({"success":false})]);
    let result = run(&mut fixture, &config, vec!["42".into(), "99".into()]).unwrap();
    assert_eq!((result.refreshed, result.failed), (1, 1));
    assert_eq!(
        fixture.uploads.len(),
        4,
        "partially completed UID never marks both records known"
    );
}

#[test]
fn source_paging_refetches_probe_filters_before_boundary_and_deduplicates() {
    let mut fixture = Fixture::default();
    let config = options();
    fixture
        .pages
        .insert(("42".into(), 1), (0..50).map(item).collect());
    fixture.pages.insert(
        ("42".into(), 2),
        vec![
            item(0),
            item(50),
            json!({"bvid":"unusual-but-nonempty","title":"source entry"}),
        ],
    );
    fixture.records = vec![item(1)];
    let result = run(&mut fixture, &config, vec!["42".into()]).unwrap();
    assert_eq!((result.refreshed, result.skipped, result.failed), (1, 0, 0));
    assert_eq!(
        fixture.calls,
        [("42".into(), 1), ("42".into(), 1), ("42".into(), 2)]
    );
    assert_eq!(fixture.uploads[0].len(), 51);
    assert_eq!(fixture.uploads[0][0], item(0));
    assert_eq!(fixture.uploads[0][49], item(50));
    assert_eq!(fixture.uploads[0][50]["bvid"], "unusual-but-nonempty");
    fixture.calls.clear();
    fixture
        .pages
        .insert(("99".into(), 1), (100..149).map(item).collect());
    fixture.pages.insert(("99".into(), 2), vec![item(999)]);
    run(&mut fixture, &config, vec!["99".into()]).unwrap();
    assert_eq!(
        fixture.calls,
        [("99".into(), 1), ("99".into(), 1)],
        "49 selected records end paging even if raw upstream page has more videos"
    );
}

#[test]
fn union_local_d1_limit_numeric_order_force_threshold_and_dry_run() {
    let mut fixture = Fixture {
        records: vec![
            json!({"mid":"900"}),
            json!({"mid":"3"}),
            json!({"mid":"0042"}),
            json!({"mid":0}),
        ],
        ..Default::default()
    };
    let mut config = options();
    run(&mut fixture, &config, vec!["99".into(), "42".into()]).unwrap();
    assert_eq!(
        fixture.calls,
        [
            ("99".into(), 1),
            ("42".into(), 1),
            ("3".into(), 1),
            ("900".into(), 1)
        ]
    );
    fixture.calls.clear();
    config.uid_mode = "d1".into();
    config.limit_uids = 2;
    run(&mut fixture, &config, vec!["99".into()]).unwrap();
    assert_eq!(fixture.calls, [("3".into(), 1), ("42".into(), 1)]);
    fixture.calls.clear();
    config.uid_mode = "local".into();
    config.limit_uids = 0;
    config.force = true;
    config.delay = 2.0;
    fixture.totals.insert("99".into(), 8001);
    fixture.pages.insert(("42".into(), 1), vec![item(99)]);
    let result = run(&mut fixture, &config, vec!["99".into(), "42".into()]).unwrap();
    assert_eq!((result.refreshed, result.skipped), (1, 1));
    assert!(
        fixture.pauses.is_empty(),
        "skipped UID preserves no inter-UID delay"
    );
    fixture.calls.clear();
    fixture.uploads.clear();
    config.dry_run = true;
    config.max_visible_total = 0;
    fixture.pages.insert(("99".into(), 1), vec![item(99)]);
    let result = run(&mut fixture, &config, vec!["99".into(), "42".into()]).unwrap();
    assert_eq!(result.refreshed, 2);
    assert!(fixture.uploads.is_empty());
    assert_eq!(fixture.pauses, [2.0]);
    fixture.export_failed = true;
    assert_eq!(
        run(&mut fixture, &config, vec![]).unwrap_err().kind,
        "export",
        "empty UID input still requires initial D1 export"
    );
}

#[test]
fn retry_counts_failure_continuation_and_unlimited_modes_are_literal() {
    for (retries, failures, expected_calls, succeeds) in [
        (3, 3, 4, true),
        (3, 4, 4, false),
        (0, 8, 9, true),
        (-1, 5, 6, true),
    ] {
        let mut fixture = Fixture {
            failures,
            ..Default::default()
        };
        let mut config = options();
        config.bili_max_retries = retries;
        config.bili_retry_delay = 2.5;
        assert_eq!(
            page_with_retry(&mut fixture, &config, "42", 2).is_ok(),
            succeeds
        );
        assert_eq!(fixture.calls.len(), expected_calls);
        assert_eq!(fixture.pauses.len(), if succeeds { failures } else { 3 });
        assert!(fixture.pauses.iter().all(|v| *v == 2.5));
    }
    let mut fixture = Fixture {
        failures: 4,
        ..Default::default()
    };
    fixture.pages.insert(("99".into(), 1), vec![item(99)]);
    let result = run(&mut fixture, &options(), vec!["42".into(), "99".into()]).unwrap();
    assert_eq!((result.refreshed, result.skipped, result.failed), (1, 0, 1));
}

#[test]
fn local_input_missing_secret_malformed_options_and_default_data_path() {
    let dir = Directory::new();
    let mut config = options();
    config.uid_source = dir.0.join("missing.json");
    config.uid_mode = "local".into();
    assert_eq!(execute(&config, "").unwrap_err().kind, "uid_source");
    config.uid_mode = "union".into();
    assert_eq!(execute(&config, "").unwrap_err().kind, "secret");
    for value in [f64::NAN, f64::INFINITY, 0.0, -1.0] {
        config.export_timeout = value;
        assert_eq!(validate(&config).unwrap_err().kind, "arguments");
    }
    config = options();
    assert!(config.uid_source.ends_with("data/gatcha_uids.json"));
    for mode in ["phone", "LOCAL", ""] {
        config.uid_mode = mode.into();
        assert_eq!(validate(&config).unwrap_err().kind, "arguments");
    }
    assert_eq!(cli(["--missing".into()]), 2);
    assert_eq!(cli(["--limit-uids".into(), "bad".into()]), 2);
    if std::env::var("BILIKARA_VERSION")
        .ok()
        .is_none_or(|v| v.trim().is_empty())
    {
        assert_eq!(source_version(&dir.0), "dev");
    }
    dir.file("APP_VERSION", b"version-file\n");
    if std::env::var("BILIKARA_VERSION").is_err() {
        assert_eq!(source_version(&dir.0), "version-file");
    }
}

#[test]
fn background_claim_duplicate_missing_secret_and_spawn_failure_release() {
    static SERIAL: Mutex<()> = Mutex::new(());
    let _serial = SERIAL.lock().unwrap();
    let request = || StartRequest {
        options: options(),
        secret: " fixture-secret ".into(),
        requested_by: " tester ".into(),
    };
    let mut empty = request();
    empty.secret.clear();
    assert_eq!(
        start_with(empty, |_| panic!("no spawn on empty secret")).unwrap()["error"],
        "missing secret"
    );
    let mut task = None;
    let result = start_with(request(), |job| {
        task = Some(job);
        Ok(())
    })
    .unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["execution"], "local");
    assert!(
        result["instance_id"]
            .as_str()
            .unwrap()
            .starts_with("local-monthly-")
    );
    let duplicate = start_with(request(), |_| panic!("duplicate cannot spawn")).unwrap();
    assert_eq!(duplicate["success"], false);
    assert_eq!(
        duplicate["error"],
        "monthly D1 refresh is already running locally"
    );
    drop(task.take());
    assert!(!crate::app_state::source_monthly_guard(|active| *active).unwrap());
    let failed = start_with(request(), |_job| {
        Err(std::io::Error::other("fixture thread failure"))
    })
    .unwrap();
    assert_eq!(failed["success"], false);
    assert!(
        failed["error"]
            .as_str()
            .unwrap()
            .contains("failed to start local monthly")
    );
    assert!(!crate::app_state::source_monthly_guard(|active| *active).unwrap());
}

#[test]
fn additive_ffi_service_keeps_typed_validation_and_owned_result() {
    use std::ffi::{CStr, CString};
    fn call(payload: Value) -> Value {
        let request = CString::new(payload.to_string()).unwrap();
        // The existing public C ABI owns its returned allocation until free.
        unsafe {
            let pointer = crate::ffi::bilikara_runtime_service(request.as_ptr());
            assert!(!pointer.is_null());
            let result = serde_json::from_slice(CStr::from_ptr(pointer).to_bytes()).unwrap();
            crate::ffi::bilikara_runtime_free_string(pointer);
            result
        }
    }
    let result = call(
        json!({"service":"catalog_refresh","request":{"options":{},"secret":"","requested_by":"fixture"}}),
    );
    assert_eq!(
        result,
        json!({"schema_version":1,"status":"completed","result":{"success":false,"job":"monthly-d1-refresh","error":"missing secret"}})
    );
    let denied = call(
        json!({"service":"catalog_refresh","request":{"options":{"uid_mode":"invalid"},"secret":"fixture-secret"}}),
    );
    assert_eq!(denied["status"], "failed");
    assert_eq!(denied["error"]["kind"], "arguments");
    assert!(denied.to_string().find("fixture-secret").is_none());
}
