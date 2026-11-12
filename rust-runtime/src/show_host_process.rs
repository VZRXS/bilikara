//! Private process boundary for the optional, unmodified ShowHost DLL.
//! A whole casting session shares one child, native instance and HTTP stream.
//! Process exit reclaims native resources which the DLL cannot release itself.
use crate::windows_show_host::{AudioSlot, Error, QueueHud, ShowHostNativeAdapter, Status};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const WORKER_FLAG: &str = "--show-host-media-worker";
const MAX_LINE_BYTES: usize = 64 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

fn error(code: &str, message: impl Into<String>) -> Error {
    Error {
        code: code.into(),
        message: message.into(),
    }
}

/// The native handle never enters this process. All commands use private pipes;
/// neither HTTP clients nor shell text can select commands or the executable.
pub struct ShowHostProcess {
    child: Option<Child>,
    commands: Option<SyncSender<Vec<u8>>>,
    replies: Receiver<Result<Value, String>>,
    reader: Option<JoinHandle<()>>,
    sequence: u64,
    process_id: u32,
}

impl ShowHostProcess {
    pub fn open(dll: &Path) -> Result<Self, Error> {
        let executable = std::env::current_exe().map_err(|e| {
            error(
                "INIT_FAILED",
                format!("cannot locate the media worker executable: {e}"),
            )
        })?;
        Self::with_executable(&executable, dll)
    }

    /// Explicit executable is for standalone native smoke/fixture consumers.
    /// Production always re-enters its own trusted native Host executable.
    pub fn with_executable(executable: &Path, dll: &Path) -> Result<Self, Error> {
        if !executable.is_absolute() || !dll.is_absolute() {
            return Err(error(
                "INVALID_ARGUMENT",
                "media worker and DLL paths must be absolute",
            ));
        }
        let dll = path_text(dll)?.to_owned();
        let mut command = Command::new(executable);
        command
            .arg(WORKER_FLAG)
            .env(
                "BILIKARA_SHOW_WORKER_PARENT_PID",
                std::process::id().to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Keep native failure details on the Host's existing diagnostic
            // stream; stdout alone belongs to the bounded private protocol.
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Inherit the native Host's existing process Job; do not break away.
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| {
            error(
                "INIT_FAILED",
                format!("cannot start the Show media worker: {e}"),
            )
        })?;
        let process_id = child.id();
        let input = child.stdin.take().expect("piped media-worker stdin");
        let output = child.stdout.take().expect("piped media-worker stdout");
        let (commands, requests) = mpsc::sync_channel::<Vec<u8>>(1);
        let (responses, replies) = mpsc::sync_channel(1);
        // Both writing and reading happen off the caller. A hung child cannot
        // block the service thread in write_all before its response deadline.
        let reader = match thread::Builder::new()
            .name("show-host-private-pipe".into())
            .spawn(move || {
                let mut input = input;
                let mut output = BufReader::new(output);
                while let Ok(request) = requests.recv() {
                    let result = (|| {
                        input
                            .write_all(&request)
                            .and_then(|()| input.flush())
                            .map_err(|e| format!("media-worker pipe write failed: {e}"))?;
                        let line = read_line(&mut output)?
                            .ok_or_else(|| "media worker exited without a response".to_owned())?;
                        serde_json::from_slice::<Value>(&line)
                            .map_err(|e| format!("media worker returned invalid JSON: {e}"))
                    })();
                    let failed = result.is_err();
                    if responses.send(result).is_err() || failed {
                        break;
                    }
                }
            }) {
            Ok(reader) => reader,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error(
                    "INIT_FAILED",
                    format!("cannot start the media-worker pipe reader: {e}"),
                ));
            }
        };
        let mut worker = Self {
            child: Some(child),
            commands: Some(commands),
            replies,
            reader: Some(reader),
            sequence: 0,
            process_id,
        };
        worker.request("open", json!({"dll": dll}))?;
        Ok(worker)
    }

    pub fn id(&self) -> u32 {
        self.process_id
    }

    fn request(&mut self, command: &str, arguments: Value) -> Result<Value, Error> {
        if self.child.is_none() {
            return Err(error("SESSION_CLOSED", "Show media worker is closed"));
        }
        self.sequence = self.sequence.checked_add(1).ok_or_else(|| {
            error(
                "WORKER_PROTOCOL_FAILED",
                "media-worker request sequence exhausted",
            )
        })?;
        let id = self.sequence;
        let mut request =
            serde_json::to_vec(&json!({"id": id, "command": command, "arguments": arguments}))
                .map_err(|e| error("INVALID_ARGUMENT", e.to_string()))?;
        request.push(b'\n');
        if request.len() > MAX_LINE_BYTES {
            return Err(error(
                "INVALID_ARGUMENT",
                "media-worker request exceeds 64 KiB",
            ));
        }
        if self
            .commands
            .as_ref()
            .is_none_or(|sender| sender.try_send(request).is_err())
        {
            self.terminate();
            return Err(error(
                "WORKER_PIPE_FAILED",
                "media-worker request pipe is unavailable",
            ));
        }
        let reply = match self.replies.recv_timeout(COMMAND_TIMEOUT) {
            Ok(Ok(reply)) => reply,
            Ok(Err(message)) => {
                self.terminate();
                return Err(error("WORKER_PROTOCOL_FAILED", message));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.terminate();
                return Err(error(
                    "WORKER_TIMEOUT",
                    format!("Show media worker did not finish {command} within 30 seconds"),
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.terminate();
                return Err(error(
                    "WORKER_PIPE_FAILED",
                    "Show media-worker reader stopped",
                ));
            }
        };
        if reply["id"].as_u64() != Some(id) || !reply["ok"].is_boolean() {
            self.terminate();
            return Err(error(
                "WORKER_PROTOCOL_FAILED",
                "media-worker response identity is invalid",
            ));
        }
        if reply["ok"] == true {
            if let Some(data) = reply.get("data") {
                return Ok(data.clone());
            }
        } else if let (Some(code), Some(message)) = (
            reply["error"]["code"].as_str(),
            reply["error"]["message"].as_str(),
        ) {
            return Err(error(code, message));
        }
        self.terminate();
        Err(error(
            "WORKER_PROTOCOL_FAILED",
            "media-worker response payload is invalid",
        ))
    }

    pub fn start_stream(&mut self) -> Result<u16, Error> {
        let result = self.request("start_stream", json!({}))?;
        let port = result
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .filter(|value| *value > 0);
        port.ok_or_else(|| {
            error(
                "NATIVE_OUTPUT_INVALID",
                "Show media worker returned an invalid stream port",
            )
        })
    }

    pub fn port(&mut self) -> Result<u16, Error> {
        let result = self.request("port", json!({}))?;
        result
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .ok_or_else(|| {
                error(
                    "NATIVE_OUTPUT_INVALID",
                    "Show media worker returned an invalid port",
                )
            })
    }

    pub fn load(&mut self, video: &Path, audio: &Path) -> Result<(), Error> {
        self.load_pair(video, audio, None)
    }

    pub(crate) fn load_pair(
        &mut self,
        video: &Path,
        audio: &Path,
        alternate: Option<&Path>,
    ) -> Result<(), Error> {
        self.request(
            "load",
            json!({"video": path_text(video)?, "audio": path_text(audio)?, "alternate": alternate.map(path_text).transpose()?}),
        )
        .map(|_| ())
    }
    pub(crate) fn prepare_next(
        &mut self,
        video: &Path,
        audio: &Path,
        alternate: Option<&Path>,
    ) -> Result<bool, Error> {
        self.request(
            "prepare_next",
            json!({"video": path_text(video)?, "audio": path_text(audio)?, "alternate": alternate.map(path_text).transpose()?}),
        )?
        .as_bool()
        .ok_or_else(|| error("NATIVE_OUTPUT_INVALID", "invalid Show standby result"))
    }

    pub(crate) fn set_audio_track(&mut self, slot: AudioSlot) -> Result<(), Error> {
        self.request("set_audio_track", json!({"slot": slot}))
            .map(|_| ())
    }

    pub(crate) fn set_queue_hud(&mut self, revision: u64, hud: &QueueHud) -> Result<(), Error> {
        self.request("set_queue_hud", json!({"revision": revision, "hud": hud}))?;
        Ok(())
    }

    pub fn play(&mut self) -> Result<(), Error> {
        self.request("play", json!({})).map(|_| ())
    }
    pub fn pause(&mut self) -> Result<(), Error> {
        self.request("pause", json!({})).map(|_| ())
    }
    pub fn stop(&mut self) -> Result<(), Error> {
        self.request("stop", json!({})).map(|_| ())
    }
    pub fn seek(&mut self, seconds: f64) -> Result<(), Error> {
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(error(
                "INVALID_ARGUMENT",
                "Show seek requires finite nonnegative seconds",
            ));
        }
        self.request("seek", json!({"seconds": seconds}))
            .map(|_| ())
    }
    pub fn set_volume(&mut self, percent: i32) -> Result<(), Error> {
        self.request("set_volume", json!({"percent": percent}))
            .map(|_| ())
    }
    pub fn set_key(&mut self, semitones: i32) -> Result<(), Error> {
        self.request("set_key", json!({"semitones": semitones}))
            .map(|_| ())
    }
    pub fn set_audio_offset(&mut self, seconds: f64) -> Result<(), Error> {
        if !seconds.is_finite() {
            return Err(error(
                "INVALID_ARGUMENT",
                "Show offset requires finite seconds",
            ));
        }
        self.request("set_audio_offset", json!({"seconds": seconds}))
            .map(|_| ())
    }
    pub fn status(&mut self) -> Result<Status, Error> {
        decode_status(self.request("status", json!({}))?)
    }
    pub fn decoded_frames(&mut self) -> Result<u64, Error> {
        self.request("decoded_frames", json!({}))?
            .as_u64()
            .ok_or_else(|| {
                error(
                    "NATIVE_OUTPUT_INVALID",
                    "Show media worker returned an invalid decoded-frame count",
                )
            })
    }

    pub(crate) fn served_streams(&mut self) -> Result<u64, Error> {
        self.request("served_streams", json!({}))?
            .as_u64()
            .ok_or_else(|| error("NATIVE_OUTPUT_INVALID", "invalid Show HTTP delivery count"))
    }

    /// The child must be gone before this returns, including on native timeout.
    /// Callers may then safely remove session-owned media names.
    pub fn close(&mut self) -> Result<(), Error> {
        if self.child.is_none() {
            return Ok(());
        }
        let reply = self.request("close", json!({}));
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        let exit = loop {
            let Some(child) = self.child.as_mut() else {
                break Ok(());
            };
            match child.try_wait() {
                Ok(Some(status)) if status.success() => break Ok(()),
                Ok(Some(status)) => {
                    break Err(error(
                        "SESSION_DESTROY_FAILED",
                        format!("Show media worker exited with {status}"),
                    ));
                }
                Err(e) => {
                    break Err(error(
                        "SESSION_DESTROY_FAILED",
                        format!("cannot wait for Show media worker: {e}"),
                    ));
                }
                Ok(None) if Instant::now() >= deadline => {
                    break Err(error(
                        "WORKER_TIMEOUT",
                        "Show media worker did not exit after close",
                    ));
                }
                Ok(None) => thread::sleep(Duration::from_millis(10)),
            }
        };
        self.terminate();
        reply.map(|_| ()).and(exit)
    }

    fn terminate(&mut self) {
        self.commands.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

impl Drop for ShowHostProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn path_text(path: &Path) -> Result<&str, Error> {
    path.to_str()
        .filter(|value| !value.contains('\0'))
        .ok_or_else(|| {
            error(
                "INVALID_ARGUMENT",
                "media-worker paths must be valid Unicode without NUL characters",
            )
        })
}

fn decode_status(value: Value) -> Result<Status, Error> {
    let invalid = || {
        error(
            "NATIVE_OUTPUT_INVALID",
            "Show media worker returned invalid playback status",
        )
    };
    let state = value["state"]
        .as_i64()
        .filter(|state| (0..=3).contains(state))
        .ok_or_else(invalid)? as i32;
    let position = value["position"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(invalid)?;
    let duration = value["duration"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(invalid)?;
    let buffering = value["buffering"].as_bool().ok_or_else(invalid)?;
    Ok(Status {
        state,
        position,
        duration,
        buffering,
    })
}

fn read_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut line = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|e| format!("media-worker pipe read failed: {e}"))?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err("unterminated media-worker response".into())
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(available.len(), |index| index + 1);
        if line.len() + count > MAX_LINE_BYTES {
            return Err("media-worker line exceeds 64 KiB".into());
        }
        line.extend_from_slice(&available[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}

fn argument<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, Error> {
    arguments[name]
        .as_str()
        .filter(|value| !value.is_empty() && !value.contains('\0'))
        .ok_or_else(|| {
            error(
                "INVALID_ARGUMENT",
                format!("missing media-worker argument: {name}"),
            )
        })
}

fn execute(
    native: &mut Option<ShowHostNativeAdapter>,
    command: &str,
    arguments: &Value,
) -> Result<Value, Error> {
    if command == "open" {
        if native.is_some() {
            return Err(error(
                "INVALID_ARGUMENT",
                "Show media worker is already initialized",
            ));
        }
        *native = Some(ShowHostNativeAdapter::open(Path::new(argument(
            arguments, "dll",
        )?))?);
        return Ok(Value::Null);
    }
    let instance = native
        .as_mut()
        .ok_or_else(|| error("SESSION_CLOSED", "Show media worker is not initialized"))?;
    let integer = |name: &str| {
        arguments[name]
            .as_i64()
            .and_then(|value| i32::try_from(value).ok())
            .ok_or_else(|| {
                error(
                    "INVALID_ARGUMENT",
                    format!("invalid integer argument: {name}"),
                )
            })
    };
    let seconds = || {
        arguments["seconds"]
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| error("INVALID_ARGUMENT", "invalid media-worker seconds"))
    };
    let media_paths = || {
        let video = Path::new(argument(arguments, "video")?);
        let audio = Path::new(argument(arguments, "audio")?);
        let alternate = if arguments["alternate"].is_null() {
            None
        } else {
            Some(Path::new(argument(arguments, "alternate")?))
        };
        Ok::<_, Error>((video, audio, alternate))
    };
    match command {
        "start_stream" => return instance.start_stream().map(|port| json!(port)),
        "port" => return instance.port().map(|port| json!(port)),
        "load" => {
            let (video, audio, alternate) = media_paths()?;
            instance.load_pair(video, audio, alternate)?;
        }
        "prepare_next" => {
            let (video, audio, alternate) = media_paths()?;
            return instance
                .prepare_next(video, audio, alternate)
                .map(|prepared| json!(prepared));
        }
        "set_queue_hud" => {
            let revision = arguments["revision"]
                .as_u64()
                .filter(|revision| *revision > 0)
                .ok_or_else(|| error("INVALID_ARGUMENT", "invalid queue HUD revision"))?;
            let hud: QueueHud = serde_json::from_value(arguments["hud"].clone())
                .map_err(|_| error("INVALID_ARGUMENT", "invalid queue HUD"))?;
            if hud.upcoming.len() > 4 {
                return Err(error("INVALID_ARGUMENT", "too many queue HUD rows"));
            }
            instance.set_queue_hud(revision, &hud)?;
        }
        "play" => instance.play()?,
        "pause" => instance.pause()?,
        "stop" => instance.stop()?,
        "seek" => instance.seek(seconds()?)?,
        "set_volume" => instance.set_volume(integer("percent")?)?,
        "set_key" => instance.set_key(integer("semitones")?)?,
        "set_audio_offset" => instance.set_audio_offset(seconds()?)?,
        "set_audio_track" => {
            let slot = serde_json::from_value(arguments["slot"].clone())
                .map_err(|_| error("INVALID_ARGUMENT", "invalid Show audio slot"))?;
            instance.set_audio_track(slot)?;
        }
        "status" => {
            return serde_json::to_value(instance.status()?)
                .map_err(|e| error("NATIVE_OUTPUT_INVALID", e.to_string()));
        }
        "decoded_frames" => return instance.decoded_frames().map(|frames| json!(frames)),
        "served_streams" => return instance.served_streams().map(|count| json!(count)),
        "close" => {
            instance.close()?;
            *native = None;
        }
        _ => {
            return Err(error(
                "INVALID_ARGUMENT",
                "unsupported private media-worker command",
            ));
        }
    }
    Ok(Value::Null)
}

/// Re-entered only by the native executable's fixed private worker mode.
/// This loop never initializes AppState, the application HTTP Host or a shell.
pub fn run_worker() -> Result<(), Error> {
    watch_parent()?;
    let input = std::io::stdin();
    let output = std::io::stdout();
    let mut input = input.lock();
    let mut output = output.lock();
    let mut native = None;
    while let Some(line) = read_line(&mut input).map_err(|e| error("WORKER_PROTOCOL_FAILED", e))? {
        let request: Value = serde_json::from_slice(&line)
            .map_err(|e| error("WORKER_PROTOCOL_FAILED", e.to_string()))?;
        let id = request["id"].as_u64().filter(|id| *id > 0).ok_or_else(|| {
            error(
                "WORKER_PROTOCOL_FAILED",
                "private request identity is invalid",
            )
        })?;
        let command = request["command"].as_str().ok_or_else(|| {
            error(
                "WORKER_PROTOCOL_FAILED",
                "private request command is missing",
            )
        })?;
        let result = execute(&mut native, command, &request["arguments"]);
        let response = match result {
            Ok(data) => json!({"id": id, "ok": true, "data": data}),
            Err(failure) => json!({"id": id, "ok": false, "error": failure}),
        };
        let mut bytes = serde_json::to_vec(&response)
            .map_err(|e| error("WORKER_PROTOCOL_FAILED", e.to_string()))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_LINE_BYTES {
            return Err(error(
                "WORKER_PROTOCOL_FAILED",
                "media-worker response exceeds 64 KiB",
            ));
        }
        output
            .write_all(&bytes)
            .and_then(|()| output.flush())
            .map_err(|e| error("WORKER_PIPE_FAILED", e.to_string()))?;
        if command == "close" {
            break;
        }
    }
    // EOF also synchronously destroys the native instance. A hung destructor
    // is bounded by the parent's close deadline/process termination.
    drop(native);
    Ok(())
}

#[cfg(not(windows))]
fn watch_parent() -> Result<(), Error> {
    Ok(())
}

#[cfg(windows)]
fn watch_parent() -> Result<(), Error> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    let Some(parent) = std::env::var_os("BILIKARA_SHOW_WORKER_PARENT_PID") else {
        return Ok(());
    };
    let parent = parent
        .to_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0 && *value != std::process::id())
        .ok_or_else(|| error("INIT_FAILED", "invalid Show media-worker parent identity"))?;
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, parent) };
    if handle.is_null() {
        return Err(error(
            "INIT_FAILED",
            "Show media-worker parent has exited or is unavailable",
        ));
    }
    let raw = handle as isize;
    if let Err(e) = thread::Builder::new()
        .name("show-host-parent-watch".into())
        .spawn(move || {
            let handle = raw as windows_sys::Win32::Foundation::HANDLE;
            let result = unsafe { WaitForSingleObject(handle, INFINITE) };
            unsafe { CloseHandle(handle) };
            // Process termination deliberately bypasses a possibly hung DLL
            // destructor. Windows reclaims its handles, ports, threads and files.
            std::process::exit(if result == WAIT_OBJECT_0 { 0 } else { 1 });
        })
    {
        unsafe { CloseHandle(handle) };
        return Err(error(
            "INIT_FAILED",
            format!("cannot watch Show media-worker parent: {e}"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn protocol_lines_are_bounded_before_json_allocation() {
        assert!(
            read_line(&mut Cursor::new(Vec::<u8>::new()))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            read_line(&mut Cursor::new(b"{}\n{}\n")).unwrap().unwrap(),
            b"{}\n"
        );
        let mut exact = vec![b' '; MAX_LINE_BYTES - 1];
        exact.push(b'\n');
        assert_eq!(
            read_line(&mut Cursor::new(exact)).unwrap().unwrap().len(),
            MAX_LINE_BYTES
        );
        assert!(read_line(&mut Cursor::new(vec![b' '; MAX_LINE_BYTES + 1])).is_err());
        assert!(read_line(&mut Cursor::new(b"{}".as_slice())).is_err());
    }

    #[test]
    fn worker_status_cannot_smuggle_invalid_native_values() {
        assert_eq!(
            decode_status(json!({"state":1,"position":2.5,"duration":30,"buffering":false}))
                .unwrap()
                .position,
            2.5
        );
        for value in [
            json!({}),
            json!({"state":4,"position":0,"duration":0,"buffering":false}),
            json!({"state":1,"position":-1,"duration":0,"buffering":false}),
            json!({"state":1,"position":0,"duration":-1,"buffering":false}),
            json!({"state":1,"position":0,"duration":1,"buffering":"false"}),
        ] {
            assert_eq!(
                decode_status(value).unwrap_err().code,
                "NATIVE_OUTPUT_INVALID"
            );
        }
    }
}
