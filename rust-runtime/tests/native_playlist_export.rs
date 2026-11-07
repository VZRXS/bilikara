#![cfg(feature = "native-host")]
use bilikara_runtime::{
    AppStateSeed, initialize_native_host,
    native_host::{Asset, NativeHost, render_rust_export},
};
use serde_json::json;
use std::{
    io::{Cursor, Read},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

fn png_height(bytes: Vec<u8>) -> u32 {
    let mut decoder = png::Decoder::new(Cursor::new(bytes)).read_info().unwrap();
    assert_eq!(decoder.info().width, 1600);
    let mut pixels = vec![0; decoder.output_buffer_size().unwrap()];
    let info = decoder.next_frame(&mut pixels).unwrap();
    assert!(
        pixels.iter().any(|b| *b < 80),
        "actual text/table pixels must be present"
    );
    info.height
}

#[test]
fn native_save_and_authenticated_http_share_real_csv_png_zip_and_retire_scratch() {
    let directory = std::env::temp_dir().join(format!(
        "bilikara-export-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let history = (0..55).rev().map(|i| json!({"key":format!("export-{i}"),"title":format!("中文,日本語 {i}"),
        "display_title":format!("中文,日本語 {i}"),"original_url":"https://example.invalid/export", "resolved_url":"https://example.invalid/export", "requester_name":"演示歌手", "requested_at":1000.0+i as f64})).collect::<Vec<_>>();
    let seed: AppStateSeed = serde_json::from_value(json!({"session_started_at":1.0,"session_played_file":"test.json","updated_at":1.0,"history":history,
        "session_archives":[{"file_name":"played-old.json","session_started_at":1.0,"items":[]}]})).unwrap();
    assert!(initialize_native_host(&directory, seed).error().is_none());
    let host = NativeHost::start(
        &directory,
        Arc::new(|_| {
            Some(Asset {
                bytes: b"<!doctype html>Host".to_vec(),
                mime: "text/html".into(),
            })
        }),
    )
    .unwrap();
    let font = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../static/fonts/SourceHanSans-VF.ttf");
    let fail = Arc::new(AtomicBool::new(false));
    let failing = fail.clone();
    host.set_export_renderer(Arc::new(move |spec, path| {
        if failing.load(Ordering::Acquire) {
            std::fs::write(path, b"partial").unwrap();
            return Err("controlled write failure".into());
        }
        render_rust_export(spec, path, &font, "test")
    }))
    .unwrap();
    let exporter = host.playlist_exporter();
    let csv = exporter.prepare("csv", "history", 50).unwrap();
    let csv_bytes = std::fs::read(csv.path()).unwrap();
    assert!(csv_bytes.starts_with(&[0xef, 0xbb, 0xbf]));
    let rows = csv::Reader::from_reader(&csv_bytes[3..])
        .records()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(rows.len(), 55);
    assert_eq!(&rows[0][1], "中文,日本語 0");
    assert_eq!(&rows[54][1], "中文,日本語 54");
    assert_eq!(&rows[0][3], "演示歌手");
    assert!(
        exporter.prepare("csv", "history", 50).is_err(),
        "one render/download reservation at a time"
    );
    let scratch = csv.path().to_owned();
    drop(csv);
    assert!(!scratch.exists());
    assert!(exporter.prepare("csv", "../host-state.json", 50).is_err());
    assert!(exporter.prepare("csv", "played-missing.json", 50).is_err());
    assert!(exporter.prepare("csv", "history", 1).is_err());
    let single = exporter.prepare("image", "played-old.json", 50).unwrap();
    assert!(single.filename.ends_with(".png"));
    assert_eq!(single.mime_type, "image/png");
    assert!(png_height(std::fs::read(single.path()).unwrap()) > 300);
    drop(single);
    let multiple = exporter.prepare("image", "history", 50).unwrap();
    assert!(multiple.filename.ends_with(".zip"));
    let mut zip = zip::ZipArchive::new(std::fs::File::open(multiple.path()).unwrap()).unwrap();
    assert_eq!(zip.len(), 2);
    let mut heights = vec![];
    for i in 0..zip.len() {
        let mut bytes = vec![];
        zip.by_index(i).unwrap().read_to_end(&mut bytes).unwrap();
        heights.push(png_height(bytes));
    }
    assert!(heights[0] > heights[1] && heights[1] > 300);
    drop(zip);
    drop(multiple);
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .build()
        .unwrap();
    let bootstrap = client.get(host.bootstrap_url()).send().unwrap();
    let cookie = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let url = format!(
        "http://127.0.0.1:{}/api/playlist/export?format=csv&source=history&page_size=50",
        host.local_port()
    );
    assert_eq!(client.get(&url).send().unwrap().status(), 403);
    let downloaded = client.get(&url).header("cookie", cookie).send().unwrap();
    assert_eq!(downloaded.status(), 200);
    assert_eq!(downloaded.bytes().unwrap().as_ref(), csv_bytes);
    fail.store(true, Ordering::Release);
    assert!(exporter.prepare("image", "history", 50).is_err());
    assert_eq!(
        std::fs::read_dir(directory.join("remote-exports"))
            .unwrap()
            .count(),
        0
    );
    fail.store(false, Ordering::Release);
    drop(exporter.prepare("csv", "history", 50).unwrap());
    drop(host);
    assert!(
        exporter.prepare("csv", "history", 50).is_err(),
        "shutdown revokes a retained native capability"
    );
    drop(exporter);
    std::fs::remove_dir_all(directory).unwrap();
}
