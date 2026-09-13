//! Desktop acceptance harness for the same native Host embedded on Android.
//! Not linked into the application. Optional fixtures never perform network I/O.
use bilikara_runtime::{
    AppStateRequest, AppStateSeed, execute_app_state, initialize_native_host,
    native_host::{Asset, NativeHost},
};
use serde_json::{Value, json};
use std::{io::Write, path::Path, sync::Arc};

fn execute(value: Value) -> bilikara_runtime::AppStateResponse {
    let result = execute_app_state(serde_json::from_value(value).unwrap());
    assert!(result.error().is_none(), "{:?}", result.error());
    result
}

fn fixture(directory: &Path, video: &Path, audio: &Path, count: usize) {
    execute(json!({"schema_version":1,"command":"add_session_user","name":"Alice","now":2.0}));
    for (index, id) in ["fixture-first", "fixture-second", "fixture-third"]
        .iter()
        .take(count)
        .enumerate()
    {
        let mut item = json!({"id":id,"original_url":"https://www.bilibili.com/video/BV1z84y1p7oS","resolved_url":"https://www.bilibili.com/video/BV1z84y1p7oS?p=1","bvid":"BV1z84y1p7oS","aid":1,"cid":2,"page":1,"video_page":1,
            "title":format!("Native Alpha fixture {}",index+1),"part_title":"Original","display_title":format!("Native Alpha fixture {}",index+1),"cover_url":"","embed_url":"",
            "selected_pages":[1,2],"selected_cids":[2,3],"selected_durations":[90,90],"selected_parts":["Original","Instrumental"],
            "available_pages":[1,2],"available_cids":[2,3],"available_durations":[90,90],"available_parts":["Original","Instrumental"]});
        // Layout tests must use the same metadata as subsequent SSE snapshots.
        // The third part is available but deliberately not bound/cached.
        if std::env::var_os("BILIKARA_NATIVE_FIXTURE_THREE_PARTS").is_some() {
            item["available_pages"] = json!([1, 2, 3]);
            item["available_cids"] = json!([2, 3, 4]);
            item["available_durations"] = json!([90, 90, 90]);
            item["available_parts"] = json!(["on vocal", "off vocal 有和声", "off vocal 无和声"]);
        }
        let added = execute(
            json!({"schema_version":1,"command":"add_item","item":item,"position":"tail","requester_name":"Alice","reset_av_delay":false,"allow_repeat":true,"now":3.0}),
        );
        let snapshot = added.snapshot().unwrap();
        let entry = snapshot
            .current_item
            .iter()
            .chain(snapshot.playlist.iter())
            .find(|i| i.id == *id)
            .unwrap();
        let reservation = execute(
            json!({"schema_version":1,"command":"begin_cache_attempt","item_id":id,"expected_item_incarnation_id":entry.item_incarnation_id}),
        );
        let reserved = reservation.result().unwrap();
        let relative = reserved["artifact_relative_directory"].as_str().unwrap();
        let artifact = directory.join("media").join(relative);
        std::fs::create_dir_all(&artifact).unwrap();
        std::fs::copy(video, artifact.join("video.mp4")).unwrap();
        std::fs::copy(audio, artifact.join("original.m4a")).unwrap();
        std::fs::copy(audio, artifact.join("instrumental.m4a")).unwrap();
        execute(
            json!({"schema_version":1,"command":"apply_cache_event","item_id":id,"cache_attempt_token":reserved["cache_attempt_token"],"now":4.0,
            "event":{"kind":"ready","message":"Ready","item_incarnation_id":reserved["item_incarnation_id"],"artifact_set_id":reserved["artifact_set_id"],"artifact_relative_directory":relative,
                "video_relative_path":format!("{relative}/video.mp4"),"video_media_url":format!("/media/{relative}/video.mp4"),
                "audio_variants":[{"id":"p1_original","label":"Original","page":1,"audio_url":format!("/media/{relative}/original.m4a")},
                    {"id":"p2_instrumental","label":"Instrumental","page":2,"audio_url":format!("/media/{relative}/instrumental.m4a")}],"selected_audio_variant_id":"p1_original"}}),
        );
    }
}

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    assert!(
        [2, 4, 5].contains(&arguments.len()),
        "Usage: native_host_alpha PRIVATE_DIR STATIC_DIR [FIXTURE_VIDEO FIXTURE_AUDIO [COUNT]]"
    );
    let directory = Path::new(&arguments[0]);
    let assets = Path::new(&arguments[1]).canonicalize().unwrap();
    let seed: AppStateSeed = serde_json::from_value(
        json!({"session_started_at":1.0,"session_played_file":"native.json","updated_at":1.0}),
    )
    .unwrap();
    assert!(initialize_native_host(directory, seed).error().is_none());
    if arguments.len() >= 4 {
        fixture(
            directory,
            Path::new(&arguments[2]),
            Path::new(&arguments[3]),
            arguments
                .get(4)
                .map(|value| value.parse::<usize>().unwrap().clamp(2, 3))
                .unwrap_or(2),
        );
    }
    let host = NativeHost::start(
        directory,
        Arc::new(move |name| {
            let path = assets.join(name).canonicalize().ok()?;
            if !path.starts_with(&assets) {
                return None;
            }
            let mime = match path.extension()?.to_str()? {
                "js" => "text/javascript",
                "css" => "text/css",
                "html" => "text/html",
                "json" => "application/json",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "woff2" => "font/woff2",
                _ => "application/octet-stream",
            };
            Some(Asset {
                bytes: std::fs::read(path).ok()?,
                mime: mime.into(),
            })
        }),
    )
    .unwrap();
    // The test runner captures this locally; never publish it in a report/log.
    println!("{}", json!({"bootstrap_url":host.bootstrap_url()}));
    std::io::stdout().flush().unwrap();
    let mut stop = String::new();
    let _ = std::io::stdin().read_line(&mut stop);
    drop(host);
    std::thread::sleep(std::time::Duration::from_millis(500));
    execute_app_state(AppStateRequest::Shutdown { schema_version: 1 });
}
