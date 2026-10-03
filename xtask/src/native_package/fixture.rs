// Compiled native VERIFIER fixture only. It is never a product Host or payload.
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    thread,
    time::Duration,
};

fn field(json: &str, key: &str) -> String {
    json.split(&format!("\"{key}\":"))
        .nth(1)
        .unwrap()
        .trim_start()
        .trim_start_matches('"')
        .split('"')
        .next()
        .unwrap()
        .into()
}
fn respond(mut stream: TcpStream, listener: &TcpListener, mode: &str, version: &str) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let request = line.clone();
    let path = request.split_whitespace().nth(1).unwrap_or("");
    let mut headers = String::new();
    let mut size = 0;
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        if line.to_ascii_lowercase().starts_with("content-length:") {
            size = line.split(':').nth(1).unwrap().trim().parse().unwrap();
        }
        headers.push_str(&line);
    }
    let mut body = vec![0; size];
    reader.read_exact(&mut body).unwrap();
    let mut status = 200;
    let mut kind = "application/json";
    let mut extra = String::new();
    let mut output = String::from("{}");
    let mut exit = None;
    let base = format!("http://{}", listener.local_addr().unwrap());
    if mode == "stall" && path == "/api/health" {
        thread::sleep(Duration::from_secs(60));
    }
    if path.starts_with("/bootstrap/") {
        kind = "text/html";
        if mode == "redirect" {
            status = 302;
            extra = "Location: https://unrelated.invalid/private\r\n".into();
        } else {
            extra = if mode == "bad-cookie" {
                "Set-Cookie: bilikara_native=test-host; Path=/; SameSite=Strict; Max-Age=20\r\n"
            } else {
                "Set-Cookie: bilikara_native=test-host; Path=/; HttpOnly; SameSite=Strict\r\n"
            }
            .into();
            let document = if path.contains("page=controller") {
                "controller.html"
            } else if path.contains("page=display-identifier") {
                "display-identifier.html"
            } else {
                "index.html"
            };
            let query = path.split('&').skip(1).collect::<Vec<_>>().join("&amp;");
            output = format!("<meta content=\"0;url=/{document}?{query}\"><body></body>");
            if mode == "bad-query" {
                output = "<body></body>".into();
            }
            if mode == "flash" {
                output = "<body>Host entry</body>".into();
            }
        }
    } else if path.starts_with("/controller.html") || path.starts_with("/display-identifier.html") {
        if !headers.contains("bilikara_native=test-host") && mode != "unauth" {
            status = 403;
        } else {
            kind = "text/html";
            output = if path.starts_with("/controller") {
                "<script src=controller.js></script>"
            } else {
                "<script src=display-identifier.js></script>"
            }
            .into();
        }
    } else if path == "/api/health" {
        output = if mode == "bad-health" {
            "{\"backend\":\"python\"}"
        } else {
            "{\"backend\":\"rust\"}"
        }
        .into();
    } else if path == "/api/state" {
        output = format!(
            "{{\"data\":{{\"app\":{{\"version\":\"{}\"}}}}}}",
            if mode == "wrong-state" {
                "wrong"
            } else {
                version
            }
        );
        if mode == "bad-json" {
            output = "not JSON".into();
        }
    } else if path == "/api/app/update/status" {
        output = format!(
            "{{\"data\":{{\"auto_update_supported\":{}}}}}",
            mode == "updater"
        );
    } else if path == "/vendor/signalsmith-stretch/SignalsmithStretch.js" {
        kind = if mode == "bad-js-type" {
            "text/plain"
        } else {
            "application/javascript"
        };
        output = if mode == "bad-js" {
            "missing module"
        } else {
            "new WebAssembly.Module"
        }
        .into();
    } else if path.starts_with("/vendor/") {
        status = if mode == "expose-private" { 200 } else { 404 };
    } else if path == "/api/events" {
        kind = if mode == "bad-sse-type" {
            "text/plain"
        } else {
            "text/event-stream"
        };
        output = if mode == "no-event" {
            ": heartbeat\n\n"
        } else {
            "event: state\ndata: {}\n\n"
        }
        .into();
    } else if path == "/api/session-users/add" {
        assert!(headers.contains("https://unrelated.invalid"));
        status = if mode == "foreign-origin" { 200 } else { 403 };
    } else if path == "/api/app/shutdown" {
        if !headers.contains("fixture-shutdown-capability") {
            status = if mode == "no-capability" { 200 } else { 403 };
        } else if mode == "shutdown-403" {
            status = 403;
        } else if mode == "shutdown-stuck" {
            exit = None;
        } else {
            exit = Some(if mode == "shutdown-exit" { 7 } else { 0 });
        }
    } else {
        status = 404;
    }
    let response = format!(
        "HTTP/1.1 {status} fixture\r\nContent-Type: {kind}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{output}",
        output.len()
    );
    let _ = stream.write_all(response.as_bytes());
    drop(stream);
    if let Some(exit) = exit {
        std::process::exit(exit);
    }
    let _ = base;
}
fn main() {
    assert_eq!(
        std::env::args_os().count(),
        1,
        "verifier passes no shell or interpreter arguments"
    );
    let executable = std::env::current_exe().unwrap();
    #[cfg(windows)]
    {
        let data = executable.parent().unwrap().parent().unwrap().join("runtime/data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("host-state.json"), "fixture checkpoint").unwrap();
    }
    fs::write(
        executable.with_extension("pid"),
        std::process::id().to_string(),
    )
    .unwrap();
    let mode =
        fs::read_to_string(executable.with_extension("mode")).unwrap_or_else(|_| "valid".into());
    if mode == "early" {
        std::process::exit(7);
    }
    if mode == "no-ready" {
        thread::sleep(Duration::from_secs(60));
    }
    if mode == "oversized" {
        std::io::stdout()
            .write_all(&vec![b'x'; 1024 * 1024])
            .unwrap();
        thread::sleep(Duration::from_secs(60));
    }
    if mode == "no-newline" {
        std::io::stdout()
            .write_all(b"{\"backend\":\"rust\"}")
            .unwrap();
        std::io::stdout().flush().unwrap();
        thread::sleep(Duration::from_secs(60));
    }
    if mode == "malformed" {
        println!("private credential malformed ready");
        thread::sleep(Duration::from_secs(60));
    }
    if mode == "pressure" {
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        std::io::stderr().write_all(&bytes).unwrap();
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    fs::write(executable.with_extension("port"), port.to_string()).unwrap();
    let bootstrap = if mode == "foreign-ready" {
        "http://unrelated.invalid/private".into()
    } else {
        format!("http://127.0.0.1:{port}/bootstrap/test-token")
    };
    println!(
        "{{\"event\":\"bilikara.ready\",\"backend\":\"rust\",\"host\":\"127.0.0.1\",\"port\":{port},\"baseUrl\":\"http://127.0.0.1:{port}\",\"bootstrapUrl\":\"{bootstrap}\"}}"
    );
    std::io::stdout().flush().unwrap();
    if mode == "pressure" {
        std::io::stdout()
            .write_all(&vec![b'x'; 2 * 1024 * 1024])
            .unwrap();
        std::io::stderr()
            .write_all(&vec![b'y'; 2 * 1024 * 1024])
            .unwrap();
    }
    assert!(!std::env::vars().any(|(k, _)| k.starts_with("PYTHON")
        || k.starts_with("CARGO_")
        || k.starts_with("RUSTUP_")
        || k.starts_with("NODE_")
        || k.starts_with("GH_")));
    assert_eq!(
        fs::read_dir(std::env::var_os("PATH").unwrap())
            .unwrap()
            .count(),
        0
    );
    let resources = if executable.parent().unwrap().file_name().unwrap() == "MacOS" {
        executable
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("Resources")
    } else {
        executable.parent().unwrap().to_owned()
    };
    let manifest = fs::read_to_string(resources.join("native-desktop.json")).unwrap();
    let version = field(&manifest, "version");
    for stream in listener.incoming() {
        if let Ok(stream) = stream {
            respond(stream, &listener, &mode, &version);
        }
    }
    let _ = Path::new("");
}
