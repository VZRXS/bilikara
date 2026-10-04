#[path = "support/image_decoder.rs"]
mod decoder;
#[path = "support/runtime_service.rs"]
mod service;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use decoder::Pixels;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::{Cursor, Read},
    path::PathBuf,
};

const REMOTE: &str = "https://rtc.kevinx96.icu/remote.html#";
const PROJECT: &str = "https://github.com/VZRXS/bilikara";
fn bytes(value: &Value, field: &str) -> Vec<u8> {
    STANDARD.decode(value[field].as_str().unwrap()).unwrap()
}
fn image_request(items: Vec<Value>, font: PathBuf) -> Value {
    json!({"operation":"image","items":items,"font_path":font,"title":"Bilikara 歌单","page_size":80,"app_version":"0.8.0"})
}
fn font() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../static/fonts/SourceHanSans-VF.ttf")
}
fn decode_export(bytes: &[u8], rows: usize) -> Pixels {
    let pixels = Pixels::png(bytes);
    assert_eq!(pixels.color, png::ColorType::Rgb);
    assert_eq!(pixels.depth, png::BitDepth::Eight);
    assert_eq!(
        (pixels.width, pixels.height),
        (1600, 760.max(634 + rows * 104))
    );
    pixels.decode(80, 430 + rows * 104, 180, 180, 0, PROJECT);
    pixels
}

#[test]
fn actual_qr_abi_preserves_exact_utf8_and_m_level_for_both_quiet_borders() {
    let values = [
        "https://example.test/".into(),
        format!(
            "{REMOTE}room=SYNTHETIC00000000000000000&join=SYNTHETIC0000000000000000000000000000000&expires=1788649200000&password=synthetic%2Bonly%26value"
        ),
        format!("{REMOTE}url=https%3A%2F%2Fexample.test%2Fa%3Fx%3D1&x=a+b%20c%2f%2F#fragment"),
        format!("{REMOTE}room=合成测试&name=カラオケ🎤&value=%E4%B8%AD#片段"),
        format!("{REMOTE}{}", "x".repeat(2048 - REMOTE.len())),
        "https://passport.bilibili.com/synthetic-login?token=SYNTHETIC-ONLY%2B123#qr".into(),
    ];
    for text in values {
        for border in [0, 4] {
            let result = service::execute(
                "qr_image",
                json!({"payload":text,"module_scale":10,"border":border}),
            );
            let png = bytes(&result, "png_base64");
            assert_eq!(
                png,
                bilikara_runtime::generate_qr_png(&text, 10, border).unwrap()
            );
            let image = Pixels::png(&png);
            assert_eq!(image.width, image.height);
            assert_eq!(image.depth, png::BitDepth::One);
            assert_eq!(image.color, png::ColorType::Grayscale);
            image.decode(
                0,
                0,
                image.width,
                image.height,
                if border == 0 { 40 } else { 0 },
                &text,
            );
            assert_eq!(image.bytes[0], if border == 0 { 0 } else { 255 });
        }
    }
}

#[test]
fn actual_qr_abi_capacity_and_strict_input_errors_have_no_artifact() {
    for (request, expected) in [
        (
            json!({"payload":"x".repeat(2332),"module_scale":10,"border":0}),
            "capacity_exceeded",
        ),
        (
            json!({"payload":"","module_scale":10,"border":0}),
            "invalid_request",
        ),
        (
            json!({"payload":"x","module_scale":0,"border":0}),
            "invalid_request",
        ),
        (
            json!({"payload":"x","module_scale":17,"border":0}),
            "size_limit",
        ),
        (
            json!({"payload":"x","module_scale":10,"border":17}),
            "size_limit",
        ),
        (
            json!({"payload":"x","module_scale":-1,"border":0}),
            "invalid_request",
        ),
        (
            json!({"payload":12,"module_scale":10,"border":0}),
            "invalid_request",
        ),
        (
            json!({"payload":"x","module_scale":10,"border":false}),
            "invalid_request",
        ),
        (
            json!({"payload":"x","module_scale":10,"border":0,"extra":true}),
            "invalid_request",
        ),
        (json!({}), "invalid_request"),
    ] {
        let result = service::response("qr_image", request);
        assert_eq!(result["status"], "failed");
        assert_eq!(result["error"]["kind"], expected);
        assert!(result.get("result").is_none());
    }
    assert!(std::panic::catch_unwind(|| Pixels::png(b"\x89PNG\r\n\x1a\n")).is_err());
}

#[test]
fn real_export_abi_empty_single_boundary_zip_and_continuing_row_numbers() {
    for count in [0, 2, 80, 81] {
        let items = (0..count)
            .map(|i| json!({"title":format!("合成歌单 Synthetic {i}"),"requested_at":1718000000+i}))
            .collect();
        let result = service::execute("playlist_export", image_request(items, font()));
        let png = bytes(&result, "data_base64");
        if count <= 80 {
            assert_eq!(result["mime_type"], "image/png");
            assert_eq!(result["filename"], "bilikara-playlist.png");
            decode_export(&png, count);
        } else {
            assert_eq!(result["mime_type"], "application/zip");
            assert_eq!(result["filename"], "bilikara-playlist-images.zip");
            let mut archive = zip::ZipArchive::new(Cursor::new(png)).unwrap();
            assert_eq!(archive.len(), 2);
            let mut pages = Vec::new();
            for (index, rows) in [80, 1].into_iter().enumerate() {
                let mut entry = archive.by_index(index).unwrap();
                assert_eq!(
                    entry.name(),
                    format!("bilikara-playlist-page-{:02}.png", index + 1)
                );
                let mut png = Vec::new();
                entry.read_to_end(&mut png).unwrap();
                pages.push(decode_export(&png, rows));
            }
            assert_ne!(
                pages[0].crop_bytes(94, 371, 51, 36),
                pages[1].crop_bytes(94, 371, 51, 36)
            );
        }
    }
}

#[test]
fn real_export_abi_multilingual_long_fields_and_alternate_rows_stay_in_the_card() {
    let result = service::execute(
        "playlist_export",
        image_request(
            vec![
                json!({"title":"【ニコカラ】你好、日本語 Latin Café ★ 😀","display_title":"CSV, \"quotes\"\nsecond line","requester_name":" Alice, \"B\"\nC ","owner_name":"山田 🎶","owner_mid":123,"request_count":3,"requested_at":1718000000,"played_at":1718000200,"resolved_url":"https://www.bilibili.com/video/BV1xx411c7xv","original_url":"av123","part_title":"原曲"}),
                json!({"title":"long 中文日本語 ".repeat(30),"requester_name":"点歌人".repeat(20),"owner_name":"UP主".repeat(20),"played_at":1718000100}),
            ],
            font(),
        ),
    );
    let pixels = decode_export(&bytes(&result, "data_base64"), 2);
    assert_eq!(pixels.rgb(100, 365), [255, 255, 255]);
    assert_eq!(pixels.rgb(100, 469), [251, 246, 239]);
    for (x, y, w, h) in [(1280, 371, 225, 42), (158, 371, 492, 79)] {
        let colors: BTreeSet<_> = pixels
            .crop_bytes(x, y, w, h)
            .chunks_exact(3)
            .map(|v| <[u8; 3]>::try_from(v).unwrap())
            .collect();
        assert!(colors.len() > 10, "actual glyphs remain above footer");
    }
}

#[test]
fn real_export_abi_preserves_csv_bom_order_quoting_crlf_and_custom_label() {
    let items = vec![
        json!({"title":"Later","played_at":1718000100}),
        json!({"title":"Undated","requested_at":0}),
        json!({"title":"early","display_title":"CSV, \"quotes\"\nsecond line","requester_name":" Alice, \"B\"\nC ","owner_name":"山田 🎶","owner_mid":123,"request_count":3,"requested_at":1718000000,"resolved_url":"https://www.bilibili.com/video/BV1xx411c7xv","original_url":"av123","part_title":"原曲"}),
        json!({"title":"Tie","requested_at":1718000000,"request_count":"bad"}),
    ];
    let result = service::execute(
        "playlist_export",
        json!({"operation":"csv","items":items,"time_header":"自定义时间"}),
    );
    let bytes = bytes(&result, "data_base64");
    assert!(bytes.starts_with(&[239, 187, 191]));
    let mut csv = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(&bytes[3..]);
    let rows: Vec<_> = csv.records().map(Result::unwrap).collect();
    assert_eq!(
        rows[0].iter().collect::<Vec<_>>(),
        [
            "序号",
            "标题",
            "BV 号",
            "点歌人",
            "UP 主",
            "UP 主 UID",
            "点歌次数",
            "自定义时间",
            "视频链接",
            "原始链接",
            "分P/版本"
        ]
    );
    assert_eq!(
        rows[1..].iter().map(|r| &r[0]).collect::<Vec<_>>(),
        ["1", "2", "3", "4"]
    );
    assert_eq!(
        rows[1..].iter().map(|r| &r[1]).collect::<Vec<_>>(),
        ["CSV, \"quotes\"\nsecond line", "Tie", "Later", "Undated"]
    );
    assert_eq!(
        rows[1].iter().skip(2).take(5).collect::<Vec<_>>(),
        ["BV1xx411c7xv", "Alice, \"B\"\nC", "山田 🎶", "123", "3"]
    );
    assert_eq!(&rows[4][7], "");
    assert_eq!(&rows[2][6], "1");
    let mut expected = String::from("\u{feff}");
    for row in &rows {
        let fields: Vec<_> = row
            .iter()
            .map(|value| {
                if value.contains([',', '"', '\r', '\n']) {
                    format!("\"{}\"", value.replace('"', "\"\""))
                } else {
                    value.to_owned()
                }
            })
            .collect();
        expected.push_str(&fields.join(","));
        expected.push_str("\r\n");
    }
    assert_eq!(bytes, expected.as_bytes());
    let empty = service::execute(
        "playlist_export",
        json!({"operation":"csv","items":[],"time_header":"时间"}),
    );
    assert_eq!(
        STANDARD
            .decode(empty["data_base64"].as_str().unwrap())
            .unwrap()
            .iter()
            .filter(|&&b| b == b'\n')
            .count(),
        1
    );
}

#[test]
fn real_export_abi_missing_font_and_malformed_requests_fail_without_fallback() {
    for request in [
        json!({"operation":"bogus"}),
        json!({"operation":"csv","items":[null],"time_header":"time"}),
    ] {
        let response = service::response("playlist_export", request);
        assert_eq!(response["error"]["kind"], "invalid_request");
        assert!(response.get("result").is_none());
    }
    let missing = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("does-not-exist-test-font");
    for request in [
        image_request(vec![], missing.clone()),
        json!({"operation":"prewarm","font_path":missing}),
    ] {
        let response = service::response("playlist_export", request);
        assert_eq!(response["error"]["kind"], "font_unavailable");
        assert!(response.get("result").is_none());
    }
}

#[test]
#[ignore = "requires isolated caller-supplied timezone and independent expected time"]
fn local_export_timezone() {
    let expected =
        std::env::var("BILIKARA_TEST_EXPORT_TIME").expect("required expected local time");
    let csv = service::execute(
        "playlist_export",
        json!({"operation":"csv","items":[{"requested_at":1718000000}],"time_header":"时间"}),
    );
    assert!(
        String::from_utf8(bytes(&csv, "data_base64"))
            .unwrap()
            .contains(&expected)
    );
}

#[test]
#[ignore = "requires isolated bundle/source-kit font and unrelated working directory"]
fn configured_font_and_cwd_independence() {
    let supplied =
        PathBuf::from(std::env::var_os("BILIKARA_TEST_EXPORT_FONT").expect("required copied font"));
    assert!(supplied.is_absolute());
    assert_ne!(
        std::env::current_dir().unwrap(),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    );
    assert_eq!(
        service::execute(
            "playlist_export",
            json!({"operation":"prewarm","font_path":supplied})
        )["prewarmed"],
        true
    );
    decode_export(
        &bytes(
            &service::execute(
                "playlist_export",
                image_request(vec![json!({"title":"合成 PNG"})], supplied),
            ),
            "data_base64",
        ),
        1,
    );
}

#[test]
#[ignore = "requires a test-owned actual Host export file and independent row count"]
fn isolated_export_file() {
    let path = std::env::var_os("BILIKARA_TEST_EXPORT_FILE").expect("required actual export");
    let rows = std::env::var("BILIKARA_TEST_EXPORT_ROWS")
        .expect("required expected rows")
        .parse::<usize>()
        .unwrap();
    decode_export(&std::fs::read(path).unwrap(), rows);
}

#[test]
#[ignore = "requires test-owned actual Host SVG plus exact independent URL bytes"]
fn isolated_remote_svg() {
    let path = std::env::var_os("BILIKARA_TEST_QR_SVG").expect("required actual SVG");
    let expected = std::env::var("BILIKARA_TEST_QR_URL").expect("required independent URL");
    let svg = std::fs::read_to_string(path).unwrap();
    assert!(svg.len() < 16 * 1024 * 1024);
    let view = regex::Regex::new(r#"viewBox="0 0 ([0-9]+) ([0-9]+)""#)
        .unwrap()
        .captures(&svg)
        .unwrap();
    let width = view[1].parse::<usize>().unwrap();
    let height = view[2].parse::<usize>().unwrap();
    assert_eq!(width, height);
    assert!(width <= 3344);
    let path = regex::Regex::new(r##"<path fill="#000" d="([^"]+)""##)
        .unwrap()
        .captures(&svg)
        .unwrap()[1]
        .to_owned();
    let rectangles =
        regex::Regex::new(r"M([0-9]+) ([0-9]+)h([0-9]+)v([0-9]+)H([0-9]+)V([0-9]+)").unwrap();
    let mut grey = vec![255; width * height];
    let mut consumed = 0;
    for rect in rectangles.captures_iter(&path) {
        assert_eq!(rect.get(0).unwrap().start(), consumed);
        consumed = rect.get(0).unwrap().end();
        let values: Vec<_> = (1..=6).map(|i| rect[i].parse::<usize>().unwrap()).collect();
        let (x, y, w, h) = (values[0], values[1], values[2], values[3]);
        assert_eq!((x, y), (values[4], values[5]));
        assert!(w > 0 && h > 0 && x + w <= width && y + h <= height);
        for row in y..y + h {
            grey[row * width + x..row * width + x + w].fill(0);
        }
    }
    assert_eq!(consumed, path.len());
    assert!(consumed > 0);
    decoder::Pixels {
        width,
        height,
        color: png::ColorType::Grayscale,
        depth: png::BitDepth::Eight,
        bytes: grey,
    }
    .decode(0, 0, width, height, 40, &expected);
}
