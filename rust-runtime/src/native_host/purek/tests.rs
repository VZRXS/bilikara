//! Retained next QR contracts and actual Host process fixture. Network coverage
//! lives in T2/T4/T5/T9 and the Node receiver scripts.
use super::*;

fn qr(base: &str, token: &str) -> String {
    let mut inner = Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
    inner
        .query_pairs_mut()
        .append_pair("url", base)
        .append_pair("token", token)
        .append_pair("name", "Fixture room");
    let mut outer = Url::parse("https://wx.chunk.cn/projection/login").unwrap();
    outer
        .query_pairs_mut()
        .append_pair(
            "projection_url",
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(inner.as_str()),
        )
        .append_pair("place_code", "fixture");
    outer.into()
}
#[test]
fn qr_uses_t9_bounds_and_keeps_private_authorization_out_of_snapshots() {
    let raw = qr("http://192.168.1.8:1234/render", "a+b/c=&<");
    let room = Room::parse(&raw).unwrap();
    assert_eq!(room.authorization_url(), Some(raw.as_str()));
    assert_eq!(
        room.description.as_str(),
        "http://192.168.1.8:1234/render/description.xml"
    );
    for raw in [
        raw.replace("wx.chunk.cn", "evil.example"),
        format!("{raw}&place_code=duplicate"),
        qr("http://8.8.8.8", "x"),
        qr("http://user:pass@192.168.1.8", "x"),
    ] {
        assert!(Room::parse(&raw).is_err());
    }
    let state = RoomState {
        room: Some(room),
        ..Default::default()
    };
    let snapshot = state.room_snapshot().to_string();
    assert!(!snapshot.contains("a+b"));
    assert!(!snapshot.contains("projection_url"));
    assert!(!snapshot.contains("192.168"));
}

#[test]
fn ordinary_dlna_input_is_local_explicit_and_has_no_vendor_authorization() {
    let room = Room::from_input("http://192.168.1.8:8200/renderer/device.xml").unwrap();
    assert_eq!(room.connection_type(), "dlna");
    assert!(room.authorization.is_none());
    assert_eq!(room.description.path(), "/renderer/device.xml");
    for input in [
        "https://example.com/device.xml",
        "http://8.8.8.8/device.xml",
        "file:///tmp/device.xml",
        "http://user:pass@192.168.1.8/device.xml",
        "http://192.168.1.8/device.xml?token=secret",
        "http://192.168.1.8/device.xml#fragment",
        "http://[::1]/device.xml",
        "http://169.254.1.8/device.xml",
        "http://192.168.1.8/\ndevice.xml",
    ] {
        assert!(
            Room::from_input(input).is_err(),
            "invalid description input accepted"
        );
    }
    assert_eq!(
        Room::from_input(&qr("http://192.168.1.8", "opaque"))
            .unwrap()
            .connection_type(),
        "purek"
    );
    let state = RoomState {
        room: Some(room),
        ..Default::default()
    }
    .room_snapshot()
    .to_string();
    assert!(!state.contains("192.168") && !state.contains("device.xml"));
}

#[test]
fn qr_image_decode_works_without_browser_barcode_detector() {
    let raw = qr("http://192.168.1.8", "fixture");
    let code = crate::qr_image::encode_qr(&raw).unwrap();
    let width = (code.width() + 8) * 3;
    let mut pixels = vec![255; width * width];
    for y in 0..code.width() {
        for x in 0..code.width() {
            if code[(x, y)] == qrcode::Color::Dark {
                for yy in (y + 4) * 3..(y + 5) * 3 {
                    for xx in (x + 4) * 3..(x + 5) * 3 {
                        pixels[yy * width + xx] = 0;
                    }
                }
            }
        }
    }
    assert_eq!(
        decode(&json!({"width":width,"height":width,"pixels":STANDARD.encode(&pixels)})).unwrap(),
        raw
    );
    assert!(decode(&json!({"width":577,"height":576,"pixels":""})).is_err());
    assert!(
        decode(
            &json!({"width":width,"height":width,"pixels":STANDARD.encode(vec![255;width*width])})
        )
        .is_err()
    );
}

#[test]
fn dense_room_qr_survives_a_photographed_screen() {
    // Synthetic camera frame: dense modules, skewed screen, antialiasing and
    // uneven screen brightness. No venue credentials or user photo is stored.
    let raw = format!(
        "{}&bill_id={}",
        qr("http://192.168.1.8", "fixture"),
        "7".repeat(90)
    );
    let code = crate::qr_image::encode_qr(&raw).unwrap();
    let width = 324;
    let height = 576;
    let mut pixels = vec![35; width * height];
    for y in 200..385 {
        for x in 45..225 {
            let mut level = 0.0;
            for (dx, dy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                let (px, py) = (x as f64 + dx, y as f64 + dy);
                let mut v = (py - 210.0) / 156.0;
                let mut u = 0.0;
                for _ in 0..4 {
                    let left = 62.0 - 10.0 * v;
                    u = (px - left) / (152.0 + 2.0 * v);
                    v = (py - 210.0 - 3.0 * u) / (150.0 + 9.0 * u);
                }
                let inside = (0.0..1.0).contains(&u) && (0.0..1.0).contains(&v);
                let sx = (u * (code.width() + 8) as f64).floor() as isize - 4;
                let sy = (v * (code.width() + 8) as f64).floor() as isize - 4;
                let dark = inside
                    && sx >= 0
                    && sy >= 0
                    && sx < code.width() as isize
                    && sy < code.width() as isize
                    && code[(sx as usize, sy as usize)] == qrcode::Color::Dark;
                level += if !inside {
                    35.0
                } else if dark {
                    35.0 + 15.0 * u
                } else {
                    245.0 - 20.0 * v
                };
            }
            pixels[y * width + x] = (level / 4.0).round() as u8;
        }
    }
    assert_eq!(
        decode(&json!({"width":width,"height":height,"pixels":STANDARD.encode(pixels)})).unwrap(),
        raw
    );
}

#[test]
fn photo_with_multiple_valid_rooms_is_ambiguous() {
    let width = 576;
    let height = 288;
    let mut pixels = vec![255; width * height];
    for (left, raw) in [
        (20, qr("http://192.168.1.8", "one")),
        (310, qr("http://192.168.1.9", "two")),
    ] {
        let code = crate::qr_image::encode_qr(&raw).unwrap();
        assert!((code.width() + 8) * 3 < height);
        for y in 0..code.width() {
            for x in 0..code.width() {
                if code[(x, y)] == qrcode::Color::Dark {
                    for yy in (y + 4) * 3..(y + 5) * 3 {
                        for xx in left + (x + 4) * 3..left + (x + 5) * 3 {
                            pixels[yy * width + xx] = 0;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(
        decode(&json!({"width":width,"height":height,"pixels":STANDARD.encode(pixels)}))
            .unwrap_err()
            .code,
        "purek_qr_image"
    );
}
#[test]
#[ignore = "requires Node 24 and real P1 companion; invoked by npm run test:purek-output"]
fn node_receiver_live_output_integration() {
    use crate::app_state::{AppStateRequest, CacheEvent};
    let _owned = crate::app_state::native_session::GLOBAL_APP_TEST_LOCK
        .lock()
        .unwrap();
    let directory =
        PathBuf::from(std::env::var_os("BILIKARA_TEST_PUREK_HOME").expect("isolated test home"));
    let companion =
        PathBuf::from(std::env::var_os("BILIKARA_TEST_LIBAV_COMPANION").expect("P1 companion"));
    // A test process has one trusted companion; R1's fixture transport is
    // selected by the caller and still uses the admitted cancellation token.
    crate::media_routing::configure(crate::media_routing::Configuration {
        mode: Default::default(),
        companion: Some(companion),
    })
    .unwrap();
    crate::execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
    let seed=serde_json::from_value(json!({"session_users":["Fixture singer"],"session_started_at":1.0,"session_played_file":"fixture.json","updated_at":1.0})).unwrap();
    assert!(
        crate::initialize_native_host(&directory, seed)
            .error()
            .is_none()
    );
    let host = super::super::start(
        &directory,
        Arc::new(|name| match name {
            "index.html" | "remote.html" => Some(Asset {
                bytes: b"<!doctype html><title>bilikara fixture</title>".to_vec(),
                mime: "text/html".into(),
            }),
            _ => None,
        }),
        true,
        None,
    )
    .unwrap();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("tests/fixtures/bbdown");
    let l1 = std::env::var_os("BILIKARA_TEST_PUREK_L1").is_some();
    let original_audio = std::env::var_os("BILIKARA_TEST_PUREK_AUDIO")
        .map(PathBuf::from)
        .unwrap_or_else(|| fixtures.join("audio.m4a"));
    let instrumental_audio = std::env::var_os("BILIKARA_TEST_PUREK_SECOND_AUDIO")
        .map(PathBuf::from)
        .unwrap_or_else(|| fixtures.join("audio-flac.mp4"));
    let long_video = directory.join("synthetic-l1-video.mp4");
    if l1 {
        if let Some(video) = std::env::var_os("BILIKARA_TEST_PUREK_VIDEO") {
            std::fs::copy(video, &long_video).unwrap();
        } else {
            extend_idr_fixture(&fixtures.join("video-reordered-start.mp4"), &long_video);
        }
    }
    with_app(|app|{
        for index in 0..if std::env::var_os("BILIKARA_TEST_PUREK_CONTROLLER").is_some() || std::env::var_os("BILIKARA_TEST_PUREK_EOF").is_some(){3}else{2} {
            let id=format!("purek-fixture-{index}");
            let item=serde_json::from_value(json!({"id":id,"original_url":"https://example.test/song","resolved_url":"https://example.test/song","bvid":"BV1xx411c7mD","aid":1,"cid":index+1,"title":"Fixture song","part_title":"P1","display_title":"Fixture song","cover_url":"","embed_url":"","selected_pages":[1],"selected_cids":[index+1],"selected_durations":[1],"selected_parts":["P1"],"available_pages":[1],"available_cids":[index+1],"available_durations":[1],"available_parts":["P1"]})).unwrap();
            app.native_execute(AppStateRequest::AddItem{schema_version:1,item,position:"tail".into(),requester_name:"Fixture singer".into(),requester_user_id:None,reset_av_delay:false,allow_repeat:true,now:2.0})?;
            if index==2 {continue;}
            let item=app.native_core_snapshot()?.current_item.into_iter().chain(app.native_core_snapshot()?.playlist).find(|i|i.id==id).unwrap();
            let reservation=app.reserve_runtime_attempt(&id,&item.item_incarnation_id).unwrap();
            let relative=&reservation.artifact_relative_directory;
            let path=host.context.cache_root.join(relative);std::fs::create_dir_all(&path).unwrap();
            std::fs::copy(if l1{long_video.clone()}else{fixtures.join("video-reordered-start.mp4")},path.join("video.mp4")).unwrap();
            std::fs::copy(&original_audio,path.join("audio.m4a")).unwrap();
            let mut variants=vec![json!({"id":"original","label":"Original","page":1,"audio_url":format!("/media/{relative}/audio.m4a")})];
            if l1 {std::fs::copy(&instrumental_audio,path.join("instrumental.mp4")).unwrap();variants.push(json!({"id":"instrumental","label":"Instrumental","page":1,"audio_url":format!("/media/{relative}/instrumental.mp4")}));}
            let event:CacheEvent=serde_json::from_value(json!({"kind":"ready","message":"ready","video_relative_path":format!("{relative}/video.mp4"),"video_media_url":format!("/media/{relative}/video.mp4"),"audio_variants":variants,"selected_audio_variant_id":"original","item_incarnation_id":reservation.item_incarnation_id,"artifact_set_id":reservation.artifact_set_id,"artifact_relative_directory":relative})).unwrap();
            app.native_execute(AppStateRequest::ApplyCacheEvent{schema_version:1,item_id:id,cache_attempt_token:reservation.cache_attempt_token,event,now:3.0})?;
        }Ok(())
    }).unwrap();
    let result = std::process::Command::new(
        std::env::var_os("BILIKARA_TEST_NODE").expect("Node executable"),
    )
    .arg(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(
                if std::env::var_os("BILIKARA_TEST_PUREK_MONITOR").is_some() {
                    "tests/purek_monitor_receiver.mjs"
                } else if std::env::var_os("BILIKARA_TEST_PUREK_COMPOSITED").is_some() {
                    "tests/cast_l2_receiver.mjs"
                } else if std::env::var_os("BILIKARA_TEST_PUREK_COMPATIBILITY").is_some() {
                    "tests/purek_compatibility_receiver.mjs"
                } else if std::env::var_os("BILIKARA_TEST_PUREK_CONTROLLER").is_some() {
                    "tests/purek_controller_receiver.mjs"
                } else {
                    "tests/purek_output.test.mjs"
                },
            ),
    )
    .arg(if l1 { "--receiver-l1" } else { "--receiver" })
    .env("BILIKARA_TEST_PUREK_BOOTSTRAP", host.bootstrap_url())
    .output()
    .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8(result.stdout)
            .unwrap()
            .contains("purek-node-receiver-ok")
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while with_app(|app| Ok(app.artifact_reader_count())).unwrap() != 0 && Instant::now() < deadline
    {
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(with_app(|app| Ok(app.artifact_reader_count())).unwrap(), 0);
    drop(host);
    crate::execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
}

// Repeat only an existing IDR packet, without a video encoder/CLI. This longer
// test-only file makes real Host parameter edits occur before pipeline EOF.
fn extend_idr_fixture(source: &Path, destination: &Path) {
    use mp4::{
        AvcConfig, MediaConfig, Mp4Config, Mp4Reader, Mp4Sample, Mp4Writer, TrackConfig, TrackType,
    };
    // mp4 0.14 does not provide reliable fragmented sample byte offsets. First
    // use the real validated copy-remuxer, then read its ordinary sample table.
    let companion = crate::media_routing::output_companion().unwrap();
    let probe = unsafe { crate::experimental_libav::LibavMetadataProbe::load(companion) }.unwrap();
    let flat = destination.with_extension("flat.mp4");
    probe
        .copy_remux_mp4(
            &crate::experimental_libav::CopyRemuxRequest {
                source,
                destination: &flat,
                expected_kind: crate::ExpectedMediaKind::Video,
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    let file = std::fs::File::open(flat).unwrap();
    let length = file.metadata().unwrap().len();
    let mut reader = Mp4Reader::read_header(file, length).unwrap();
    let (&id, track) = reader.tracks().iter().next().unwrap();
    let config = AvcConfig {
        width: track.width(),
        height: track.height(),
        seq_param_set: track.sequence_parameter_set().unwrap().to_vec(),
        pic_param_set: track.picture_parameter_set().unwrap().to_vec(),
    };
    let sample = reader.read_sample(id, 1).unwrap().unwrap();
    assert!(sample.is_sync);
    let file = std::fs::File::create(destination).unwrap();
    let mut writer = Mp4Writer::write_start(
        file,
        &Mp4Config {
            major_brand: "isom".parse().unwrap(),
            minor_version: 512,
            compatible_brands: vec!["isom".parse().unwrap(), "avc1".parse().unwrap()],
            timescale: 1000,
        },
    )
    .unwrap();
    writer
        .add_track(&TrackConfig {
            track_type: TrackType::Video,
            timescale: 24000,
            language: "und".into(),
            media_conf: MediaConfig::AvcConfig(config),
        })
        .unwrap();
    let frames = if std::env::var_os("BILIKARA_TEST_PUREK_MONITOR").is_some()
        && std::env::var_os("BILIKARA_TEST_PUREK_EOF").is_none()
    {
        864
    } else {
        144
    };
    for n in 0..frames {
        writer
            .write_sample(
                1,
                &Mp4Sample {
                    start_time: n * 1001,
                    duration: 1001,
                    rendering_offset: 0,
                    is_sync: true,
                    bytes: sample.bytes.clone(),
                },
            )
            .unwrap();
    }
    writer.write_end().unwrap();
}
