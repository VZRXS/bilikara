//! Private subprocess authority and bounded plain-loopback HTTP transport.
use super::require;
use crate::Result;
use serde_json::{Value, json};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read},
    net::{SocketAddr, TcpStream},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
use ureq::{
    Agent, Body,
    http::{Response, Uri},
};

const SHUTDOWN: &str = "fixture-shutdown-capability";
const LOG_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy)]
pub(super) struct Limits {
    pub ready: Duration,
    pub request: Duration,
    pub shutdown: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            ready: Duration::from_secs(40),
            request: Duration::from_secs(10),
            shutdown: Duration::from_secs(30),
        }
    }
}

pub(super) fn isolated_environment(home: &Path) -> Result<BTreeMap<OsString, OsString>> {
    let mut environment = std::env::vars_os()
        .filter(|(key, _)| {
            let name = key.to_string_lossy().to_ascii_uppercase();
            ![
                "BILIKARA_",
                "BB_DOWN",
                "ARIA2C_",
                "FFMPEG_",
                "FFPROBE_",
                "PYTHON",
                "CARGO_",
                "RUSTUP_",
                "RUSTFLAGS",
                "NODE_",
                "LD_",
                "DYLD_",
                "AWS_",
                "R2_",
                "CLOUDFLARE_",
                "CF_",
                "GITHUB_",
                "GH_",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
                && ![
                    "SSL_CERT_FILE",
                    "SSL_CERT_DIR",
                    "REQUESTS_CA_BUNDLE",
                    "CURL_CA_BUNDLE",
                    "BASH_ENV",
                    "ENV",
                ]
                .contains(&name.as_str())
                && ![
                    "HOME",
                    "USERPROFILE",
                    "LOCALAPPDATA",
                    "APPDATA",
                    "XDG_DATA_HOME",
                    "XDG_CONFIG_HOME",
                    "XDG_CACHE_HOME",
                    "TMPDIR",
                    "TEMP",
                    "TMP",
                    "PATH",
                    "HTTP_PROXY",
                    "HTTPS_PROXY",
                    "ALL_PROXY",
                    "NO_PROXY",
                ]
                .contains(&name.as_str())
        })
        .collect::<BTreeMap<_, _>>();
    let empty = home.join("empty-path");
    fs::create_dir_all(&empty)?;
    for (key, value) in [
        ("HOME", home.to_owned()),
        ("USERPROFILE", home.to_owned()),
        ("LOCALAPPDATA", home.join("local")),
        ("APPDATA", home.join("roaming")),
        ("XDG_DATA_HOME", home.join("share")),
        ("XDG_CONFIG_HOME", home.join("config")),
        ("XDG_CACHE_HOME", home.join("cache")),
        ("TMPDIR", home.join("tmp")),
        ("TEMP", home.join("tmp")),
        ("TMP", home.join("tmp")),
        ("PATH", empty),
    ] {
        environment.insert(key.into(), value.into_os_string());
    }
    fs::create_dir_all(home.join("tmp"))?;
    environment.insert("BILIKARA_SHUTDOWN_TOKEN".into(), SHUTDOWN.into());
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        environment.insert(key.into(), "http://127.0.0.1:1".into());
    }
    for key in ["NO_PROXY", "no_proxy"] {
        environment.insert(key.into(), "127.0.0.1,localhost".into());
    }
    Ok(environment)
}

fn agent(timeout: Duration) -> Agent {
    Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .build()
        .into()
}

// Never print the request URL, cookies, headers or a library error's arbitrary
// text: bootstrap URLs contain private capabilities. Keep enough information
// to distinguish a deadline from EOF/reset/refusal at a known verifier stage.
fn request_error(stage: &str, error: ureq::Error) -> Box<dyn std::error::Error> {
    let cause = match error {
        ureq::Error::Io(error) => format!(
            "I/O {:?} (OS code {:?})",
            error.kind(),
            error.raw_os_error()
        ),
        ureq::Error::Timeout(phase) => format!("timeout {phase:?}"),
        ureq::Error::Protocol(_) => "HTTP protocol failure".into(),
        ureq::Error::Http(_) => "HTTP request construction failure".into(),
        _ => "HTTP client failure".into(),
    };
    format!("Local Host HTTP request failed at {stage}: {cause}").into()
}

fn request_stage(path: &str) -> &'static str {
    match path.split('?').next().unwrap_or("") {
        "/api/health" => "health",
        "/api/state" => "state",
        "/api/app/update/status" => "update status",
        "/api/events" => "SSE entry",
        "/api/session-users/add" => "origin rejection",
        "/api/app/shutdown" => "shutdown",
        "/controller.html" => "audience document",
        "/display-identifier.html" => "identifier document",
        "/vendor/signalsmith-stretch/SignalsmithStretch.js" => "Signalsmith resource",
        "/vendor/BBDown.exe"
        | "/vendor/BBDown"
        | "/vendor/ffmpeg-runtime.json"
        | "/vendor/signalsmith-stretch/../ffmpeg-runtime.json" => "private resource rejection",
        _ => "local request",
    }
}

#[test]
fn request_diagnostics_do_not_echo_untrusted_paths_or_error_text() {
    let error = request_error(
        request_stage("/bootstrap/private-capability?secret=private-credential"),
        ureq::Error::Io(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "private-capability private-credential",
        )),
    )
    .to_string();
    assert_eq!(
        error,
        "Local Host HTTP request failed at local request: I/O ConnectionReset (OS code None)"
    );
}

fn read_body(response: &mut Response<Body>) -> Result<Vec<u8>> {
    response
        .body_mut()
        .with_config()
        .limit(10 * 1024 * 1024)
        .read_to_vec()
        .map_err(|_| "Invalid, oversized or stalled HTTP response".into())
}

fn status(response: &Response<Body>, expected: u16) -> Result<()> {
    require(
        response.status().as_u16() == expected,
        &format!("Unexpected HTTP status (expected {expected})"),
    )
}

fn content_type(response: &Response<Body>, expected: &str) -> Result<()> {
    require(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains(expected)),
        "Unexpected HTTP Content-Type",
    )
}

fn session_cookie(response: &Response<Body>, agent: &Agent) -> Result<()> {
    let headers: Vec<_> = response.headers().get_all("set-cookie").iter().collect();
    require(
        headers.len() == 1,
        "Bootstrap must set exactly one session cookie",
    )?;
    let cookie = headers[0]
        .to_str()
        .map_err(|_| "Invalid bootstrap cookie")?;
    let fields: Vec<_> = cookie
        .split(';')
        .map(|s| s.trim().to_ascii_lowercase())
        .collect();
    require(
        fields.contains(&"httponly".into())
            && fields.contains(&"samesite=strict".into())
            && fields.contains(&"path=/".into())
            && !fields
                .iter()
                .any(|s| s.starts_with("max-age=") || s.starts_with("expires=")),
        "Bootstrap cookie must be HttpOnly, SameSite=Strict and session-only",
    )?;
    let jar = agent.cookie_jar_lock();
    require(
        jar.iter().count() == 1
            && jar
                .iter()
                .all(|c| c.name() == "bilikara_native" && !c.value().is_empty()),
        "Bootstrap did not establish its own native session",
    )
}

#[derive(Default)]
struct Log {
    bytes: Vec<u8>,
    total: usize,
}
impl Log {
    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len();
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() > LOG_LIMIT {
            self.bytes.drain(..self.bytes.len() - LOG_LIMIT);
        }
    }
}

// No output is echoed: stdout's first line carries a private capability. Both
// streams continue draining after readiness, with bounded retained diagnostics.
pub(super) struct Process {
    pub child: Child,
    #[cfg(test)]
    stdout: Arc<Mutex<Log>>,
    #[cfg(test)]
    stderr: Arc<Mutex<Log>>,
    drained: mpsc::Receiver<()>,
    drained_count: usize,
    #[cfg(windows)]
    job: Job,
}
impl Process {
    #[cfg(test)]
    pub fn log_sizes(&self) -> ((usize, usize), (usize, usize)) {
        let stdout = self.stdout.lock().unwrap();
        let stderr = self.stderr.lock().unwrap();
        (
            (stdout.total, stdout.bytes.len()),
            (stderr.total, stderr.bytes.len()),
        )
    }
    pub fn spawn(
        executable: &Path,
        home: &Path,
        args: &[OsString],
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>)> {
        let mut command = Command::new(executable);
        command
            .current_dir(home)
            .args(args)
            .env_clear()
            .envs(isolated_environment(home)?)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn()?;
        #[cfg(windows)]
        let job = match Job::new(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdout = Arc::new(Mutex::new(Log::default()));
        let stderr = Arc::new(Mutex::new(Log::default()));
        let (ready_tx, ready) = mpsc::channel();
        let (done_tx, drained) = mpsc::channel();
        let mut out = child.stdout.take().unwrap();
        let log = stdout.clone();
        let done = done_tx.clone();
        thread::spawn(move || {
            let mut buffer = [0; 8192];
            let mut line = Vec::new();
            let mut sent = false;
            while let Ok(size) = out.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                log.lock().unwrap().push(&buffer[..size]);
                if !sent {
                    for byte in &buffer[..size] {
                        line.push(*byte);
                        if *byte == b'\n' || line.len() > 16 * 1024 {
                            let _ = ready_tx.send(std::mem::take(&mut line));
                            sent = true;
                            break;
                        }
                    }
                }
            }
            // Disconnected channel/EOF without a newline is a readiness failure.
            drop(ready_tx);
            let _ = done.send(());
        });
        let mut err = child.stderr.take().unwrap();
        let log = stderr.clone();
        thread::spawn(move || {
            let mut buffer = [0; 8192];
            while let Ok(size) = err.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                log.lock().unwrap().push(&buffer[..size]);
            }
            let _ = done_tx.send(());
        });
        Ok((
            Self {
                child,
                #[cfg(test)]
                stdout,
                #[cfg(test)]
                stderr,
                drained,
                drained_count: 0,
                #[cfg(windows)]
                job,
            },
            ready,
        ))
    }
    pub fn wait(&mut self, timeout: Duration) -> Result<ExitStatus> {
        let end = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(status);
            }
            require(Instant::now() < end, "Native Host exit timed out")?;
            thread::sleep(Duration::from_millis(10));
        }
    }
    #[cfg(test)]
    pub fn output(&mut self, timeout: Duration) -> Result<std::process::Output> {
        let status = self.wait(timeout)?;
        self.drain();
        Ok(std::process::Output {
            status,
            stdout: self.stdout.lock().unwrap().bytes.clone(),
            stderr: self.stderr.lock().unwrap().bytes.clone(),
        })
    }
    fn terminate(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        self.job.terminate();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.wait(Duration::from_secs(5));
    }
    fn drain(&mut self) {
        // Bounded even if a broken executable retained inherited pipe handles.
        while self.drained_count < 2 {
            if self
                .drained
                .recv_timeout(Duration::from_millis(500))
                .is_err()
            {
                break;
            }
            self.drained_count += 1;
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.terminate();
        self.drain();
    }
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Job {
    fn new(child: &Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            require(!handle.is_null(), "Cannot create verification process job")?;
            let job = Self(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            require(
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32,
                ) != 0
                    && AssignProcessToJobObject(handle, child.as_raw_handle()) != 0,
                "Cannot isolate verification process job",
            )?;
            Ok(job)
        }
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

pub(super) struct RunningHost {
    pub process: Process,
    pub base: String,
    bootstrap: String,
    client: Agent,
    address: SocketAddr,
    #[cfg(target_os = "linux")]
    executable: PathBuf,
    limits: Limits,
}
impl RunningHost {
    #[cfg(test)]
    pub fn set_test_listener(&mut self, address: SocketAddr) {
        self.address = address;
    }
    pub fn start(executable: &Path, home: &Path, args: &[OsString]) -> Result<Self> {
        Self::start_with_limits(executable, home, args, Limits::default())
    }
    pub fn start_with_limits(
        executable: &Path,
        home: &Path,
        args: &[OsString],
        limits: Limits,
    ) -> Result<Self> {
        let (mut process, ready) = Process::spawn(executable, home, args)?;
        let line = ready
            .recv_timeout(limits.ready)
            .map_err(|_| "Native Host readiness missing or timed out")?;
        require(
            line.len() <= 16 * 1024 && line.last() == Some(&b'\n'),
            "Incomplete or oversized native Host readiness record",
        )?;
        let ready: Value =
            serde_json::from_slice(&line).map_err(|_| "Malformed native Host readiness record")?;
        let (base, bootstrap, address) = readiness(&ready)?;
        require(
            process.child.try_wait()?.is_none(),
            "Native Host exited before verification",
        )?;
        let client = agent(limits.request);
        let mut response = client
            .get(&bootstrap)
            .call()
            .map_err(|error| request_error("main bootstrap", error))?;
        status(&response, 200)?;
        session_cookie(&response, &client)?;
        read_body(&mut response)?;
        Ok(Self {
            process,
            base,
            bootstrap,
            client,
            address,
            #[cfg(target_os = "linux")]
            executable: executable.canonicalize()?,
            limits,
        })
    }
    fn request_with(
        &self,
        client: &Agent,
        path: &str,
        body: Option<&Value>,
        headers: &[(&str, &str)],
    ) -> Result<Response<Body>> {
        require(
            path.starts_with('/') && !path.starts_with("//") && !path.contains(['\r', '\n', '#']),
            "Invalid local request path",
        )?;
        let url = format!("{}{path}", self.base);
        let mut all = vec![];
        for (key, value) in [
            ("Origin", self.base.as_str()),
            ("Content-Type", "application/json"),
        ] {
            if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(key)) {
                all.push((key, value));
            }
        }
        all.extend_from_slice(headers);
        let response = if let Some(body) = body {
            let mut request = client.post(&url);
            for (key, value) in all {
                request = request.header(key, value);
            }
            request.send(serde_json::to_vec(body)?)
        } else {
            let mut request = client.get(&url);
            for (key, value) in all {
                request = request.header(key, value);
            }
            request.call()
        };
        response.map_err(|error| request_error(request_stage(path), error))
    }
    pub fn request(
        &self,
        path: &str,
        body: Option<&Value>,
        headers: &[(&str, &str)],
    ) -> Result<Response<Body>> {
        self.request_with(&self.client, path, body, headers)
    }
    pub fn api(&self, path: &str, body: Option<&Value>) -> Result<Value> {
        let mut response = self.request(path, body, &[])?;
        status(&response, 200)?;
        content_type(&response, "application/json")?;
        let value: Value = serde_json::from_slice(&read_body(&mut response)?)
            .map_err(|_| "Malformed native API JSON")?;
        value
            .get("data")
            .cloned()
            .ok_or("Native API response omitted data".into())
    }
    fn auxiliary(&self) -> Result<()> {
        for (page, query, document) in [
            ("controller", "presentationGeneration=42", "controller.html"),
            (
                "display-identifier",
                "number=2&theme=dark&language=ja&role=audience",
                "display-identifier.html",
            ),
        ] {
            let client = agent(self.limits.request); // Never clone/share the main jar.
            let path = format!("/{document}?{query}");
            status(&self.request_with(&client, &path, None, &[])?, 403)?;
            let mut response = client
                .get(format!("{}?page={page}&{query}", self.bootstrap))
                .call()
                .map_err(|error| request_error("auxiliary bootstrap", error))?;
            status(&response, 200)?;
            session_cookie(&response, &client)?;
            let html = String::from_utf8(read_body(&mut response)?)
                .map_err(|_| "Invalid auxiliary HTML")?;
            require(
                html.contains("<body></body>")
                    && html.contains(&format!("url=/{document}?{}", query.replace('&', "&amp;"))),
                "Auxiliary bootstrap body/query propagation changed",
            )?;
            let mut response = self.request_with(&client, &path, None, &[])?;
            status(&response, 200)?;
            content_type(&response, "text/html")?;
            let script = document.replace(".html", ".js");
            require(
                read_body(&mut response)?
                    .windows(script.len())
                    .any(|w| w == script.as_bytes()),
                "Auxiliary document script missing",
            )?;
        }
        Ok(())
    }
    pub fn check(&self, facts: &Value) -> Result<()> {
        let mut response = self.request("/api/health", None, &[])?;
        status(&response, 200)?;
        let health: Value = serde_json::from_slice(&read_body(&mut response)?)
            .map_err(|_| "Malformed health JSON")?;
        require(
            health["backend"] == "rust",
            "Health did not identify native Rust backend",
        )?;
        require(
            self.api("/api/state", None)?["app"]["version"] == facts["version"],
            "Running Host version mismatch",
        )?;
        self.auxiliary()?;
        require(
            self.api("/api/app/update/status", None)?["auto_update_supported"] == false,
            "Direct offline Host unexpectedly advertises automatic update",
        )?;
        let mut response = self.request(
            "/vendor/signalsmith-stretch/SignalsmithStretch.js",
            None,
            &[],
        )?;
        status(&response, 200)?;
        content_type(&response, "javascript")?;
        require(
            read_body(&mut response)?
                .windows(11)
                .any(|w| w == b"WebAssembly"),
            "Signalsmith resource content changed",
        )?;
        for path in [
            "/vendor/BBDown.exe",
            "/vendor/BBDown",
            "/vendor/ffmpeg-runtime.json",
            "/vendor/signalsmith-stretch/../ffmpeg-runtime.json",
        ] {
            require(
                matches!(self.request(path, None, &[])?.status().as_u16(), 400 | 404),
                "Private native vendor resource exposed over HTTP",
            )?;
        }
        let mut response = self.request("/api/events", None, &[])?;
        status(&response, 200)?;
        content_type(&response, "text/event-stream")?;
        let mut reader = BufReader::new(response.body_mut().as_reader().take(1024 * 1024));
        let mut line = String::new();
        let mut data = false;
        loop {
            require(
                reader
                    .read_line(&mut line)
                    .map_err(|_| "SSE read failed or timed out")?
                    > 0,
                "SSE did not yield an event",
            )?;
            if line.trim().is_empty() {
                break;
            }
            if let Some(value) = line.strip_prefix("data:") {
                let _: Value = serde_json::from_str(value).map_err(|_| "Malformed SSE data")?;
                data = true;
            }
            line.clear();
        }
        require(data, "SSE did not yield a real data event")?;
        status(
            &self.request(
                "/api/session-users/add",
                Some(&json!({"name":"forbidden"})),
                &[("Origin", "https://unrelated.invalid")],
            )?,
            403,
        )?;
        // The authenticated renderer alone cannot exercise the shell lifecycle capability.
        status(
            &self.request("/api/app/shutdown", Some(&json!({})), &[])?,
            403,
        )?;
        #[cfg(target_os = "linux")]
        {
            let pid = self.process.child.id();
            let proc = PathBuf::from(format!("/proc/{pid}"));
            require(
                fs::read_link(proc.join("exe"))? == self.executable,
                "Executed Host differs from supplied artifact",
            )?;
            let maps = fs::read_to_string(proc.join("maps"))?;
            require(
                !["libpython", "site-packages", "_MEI"]
                    .iter()
                    .any(|s| maps.contains(s)),
                "Forbidden mapped library",
            )?;
            require(
                fs::read_to_string(proc.join(format!("task/{pid}/children")))?
                    .trim()
                    .is_empty(),
                "Native Host spawned an unexpected child",
            )?;
        }
        Ok(())
    }
    pub fn close(&mut self) -> Result<()> {
        require(
            self.process.child.try_wait()?.is_none(),
            "Native Host exited before authorized shutdown",
        )?;
        let response = self.request(
            "/api/app/shutdown",
            Some(&json!({})),
            &[("X-Bilikara-Shutdown-Token", SHUTDOWN)],
        )?;
        status(&response, 200)?; // HTTP errors cannot become passing cleanup.
        require(
            self.process.wait(self.limits.shutdown)?.success(),
            "Native Host shutdown exit was unsuccessful",
        )?;
        require(
            TcpStream::connect_timeout(&self.address, Duration::from_secs(1)).is_err(),
            "Backend listener survived shutdown",
        )?;
        Ok(())
    }
}

fn readiness(value: &Value) -> Result<(String, String, SocketAddr)> {
    require(
        value["event"] == "bilikara.ready"
            && value["backend"] == "rust"
            && value["host"] == "127.0.0.1",
        "Invalid native Host readiness identity",
    )?;
    let base = value["baseUrl"]
        .as_str()
        .ok_or("Readiness omitted local base URL")?;
    let uri: Uri = base.parse().map_err(|_| "Invalid readiness base URL")?;
    let port = uri
        .port_u16()
        .filter(|p| *p != 0)
        .ok_or("Invalid readiness listener port")?;
    require(
        uri.scheme_str() == Some("http")
            && uri.host() == Some("127.0.0.1")
            && uri
                .authority()
                .is_some_and(|a| a.as_str() == format!("127.0.0.1:{port}"))
            && uri.path() == "/"
            && uri.query().is_none()
            && value["port"] == port,
        "Readiness must select only the intended loopback listener",
    )?;
    let bootstrap = value["bootstrapUrl"]
        .as_str()
        .ok_or("Readiness omitted bootstrap URL")?;
    let entry: Uri = bootstrap.parse().map_err(|_| "Invalid bootstrap URL")?;
    require(
        entry.scheme() == uri.scheme()
            && entry.authority() == uri.authority()
            && entry.query().is_none()
            && entry.path().strip_prefix("/bootstrap/").is_some_and(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            }),
        "Bootstrap must stay on the intended loopback listener",
    )?;
    Ok((
        base.trim_end_matches('/').into(),
        bootstrap.into(),
        SocketAddr::from(([127, 0, 0, 1], port)),
    ))
}
