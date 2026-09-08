//! Developer driver for the real runtime entry; never invokes ffprobe/ffmpeg.
use bilikara_runtime::experimental_libav::LibavMetadataProbe;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        eprintln!("usage: libav_metadata /trusted/companion.so /absolute/media");
        std::process::exit(2);
    }
    // SAFETY: this developer-only invocation explicitly authorizes the artifact
    // and dependency prefix described in media-libav/README.md.
    let probe = unsafe { LibavMetadataProbe::load(&PathBuf::from(&args[0])) };
    let result = probe.and_then(|probe| {
        probe.probe_metadata(&PathBuf::from(&args[1]), &AtomicBool::new(false))
            .map(|metadata| serde_json::json!({ "backend_info": probe.backend_info(), "metadata": metadata }))
    });
    match result {
        Ok(value) => println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("serialize metadata")
        ),
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::to_string(&error).expect("serialize probe error")
            );
            std::process::exit(1);
        }
    }
}
