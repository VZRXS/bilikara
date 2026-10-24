//! Experimental room authorization / discovery, owned by the Rust AppState.
//! P1 media output is explicitly experimental; hardware qualification is separate.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    io::Read,
    net::{Ipv4Addr, UdpSocket},
    time::Instant,
};
use url::Url;
mod capabilities;
pub(crate) mod controller;
mod output;
mod protocol;
mod renderer;
mod stream;
use protocol::{Renderer, Room};
#[cfg(test)]
mod tests;

#[derive(Clone)]
struct Connection {
    room: Room,
    renderer: Renderer,
    local: Ipv4Addr,
    target_room_id: String,
}
#[derive(Default)]
pub(crate) struct RoomState {
    pub(crate) program_epoch: u64,
    pub(crate) controller: controller::Controller,
    pub auto_discovery: bool,
    generation: u64,
    busy: bool,
    room: Option<Room>,
    connected: Option<Connection>,
    discovered: Vec<String>,
    error: Option<String>,
    output: renderer::OutputSession,
}
impl RoomState {
    #[cfg(target_os = "android")]
    pub(crate) fn interrupt_output(&mut self, code: &str) {
        if self.controller.owns_playback {
            self.controller.platform_failure(code);
        }
        if let Some(r) = &self.output.running {
            r.cancel();
        }
    }
    pub fn snapshot(&self) -> Value {
        json!({"auto_discovery":self.auto_discovery,"busy":self.busy,
            "connected":self.connected.is_some(),"room_name":self.room.as_ref().map(|r| &r.name),
            "connection_type":self.room.as_ref().map(Room::connection_type),
            "discovered":self.discovered,"error_code":self.error,
            "capabilities":{"dlna_sender":false,"airplay":"system"},
            "output":self.output.snapshot()})
    }
}
pub(crate) fn snapshot(session: &crate::app_state::native_session::NativeSession) -> Value {
    let mut value = session.purek.snapshot();
    value["revision"] = json!(session.revision);
    value["state_epoch"] = json!(session.state_epoch);
    value
}
fn failure(status: u16, code: &str, message: &str) -> ApiError {
    ApiError::new(status, &format!("purek_{code}"), message)
}
fn busy() -> ApiError {
    failure(409, "busy", "房间操作正在进行，请稍后重试")
}
fn network_error() -> ApiError {
    failure(502, "network", "无法连接房台，请检查房间 Wi-Fi 和官方授权")
}
fn client(local: Option<Ipv4Addr>) -> Result<reqwest::blocking::Client, ApiError> {
    let mut builder = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4));
    if let Some(ip) = local {
        builder = builder.local_address(std::net::IpAddr::V4(ip));
    }
    builder.build().map_err(|_| network_error())
}
fn response(response: reqwest::blocking::Response) -> Result<String, ApiError> {
    if response.status() != 200 {
        return Err(failure(502, "http", "房台请求失败，请确认官方授权后重试"));
    }
    // Reject an advertised oversized reply before waiting for its body. Keep
    // the streaming limit below for chunked/missing/dishonest length headers.
    if response
        .content_length()
        .is_some_and(|size| size > 1024 * 1024)
    {
        return Err(failure(502, "protocol", "房台响应过大"));
    }
    let mut bytes = Vec::new();
    response
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| network_error())?;
    if bytes.len() > 1024 * 1024 {
        return Err(failure(502, "protocol", "房台响应过大"));
    }
    String::from_utf8(bytes).map_err(|_| failure(502, "protocol", "房台响应格式无效"))
}
fn probe(room: &Room, local: Ipv4Addr) -> Result<Renderer, ApiError> {
    protocol::local_address(&room.description)?;
    let text = response(
        client(Some(local))?
            .get(room.description.clone())
            .send()
            .map_err(|_| network_error())?,
    )?;
    Renderer::parse(&text, &room.description)
}
fn route_address(room: &Room) -> Result<Ipv4Addr, ApiError> {
    let destination = protocol::local_address(&room.description)?;
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|_| network_error())?;
    // UDP connect selects a route without sending a packet. DNS and proxies are
    // excluded: the QR must name a literal private IPv4 destination.
    socket
        .connect((
            destination,
            room.description.port_or_known_default().unwrap_or(80),
        ))
        .map_err(|_| network_error())?;
    match socket.local_addr().map_err(|_| network_error())?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_unspecified() => Ok(ip),
        _ => Err(network_error()),
    }
}
fn register(connection: &Connection, enable: bool) -> Result<(), ApiError> {
    let Some(authorization) = &connection.room.authorization else {
        return Ok(());
    };
    let result = client(Some(connection.local))?
        .post(connection.renderer.control.clone())
        .header("Content-Type", "text/xml; charset=utf-8")
        .header(
            "SOAPAction",
            format!("\"{}#SetDeviceAuthorization\"", connection.renderer.service),
        )
        .body(protocol::authorization(
            authorization,
            &connection.renderer,
            connection.local,
            enable,
        ))
        .send()
        .map_err(|_| network_error())?;
    protocol::authorization_result(&response(result)?, &connection.renderer.service)
}
fn announce(connection: &Connection, alive: bool) -> Result<(), ApiError> {
    // A standard control point does not impersonate the receiver's SSDP identity.
    if connection.room.authorization.is_none() {
        return Ok(());
    }
    let socket = UdpSocket::bind((connection.local, 0)).map_err(|_| network_error())?;
    socket
        .set_multicast_ttl_v4(2)
        .map_err(|_| network_error())?;
    socket2::SockRef::from(&socket)
        .set_multicast_if_v4(&connection.local)
        .map_err(|_| network_error())?;
    socket
        .set_write_timeout(Some(Duration::from_millis(100)))
        .map_err(|_| network_error())?;
    let deadline = Instant::now() + Duration::from_secs(1);
    for identity in &connection.renderer.identities {
        if Instant::now() >= deadline {
            return Err(network_error());
        }
        socket
            .send_to(
                &protocol::advertisement(&connection.room, &connection.renderer, identity, alive),
                (Ipv4Addr::new(239, 255, 255, 250), 1900),
            )
            .map_err(|_| network_error())?;
    }
    Ok(())
}
fn release(connection: &Connection) -> Result<(), ApiError> {
    let _ = announce(connection, false);
    // Bound to the originally registered IP even after a Wi-Fi/route change.
    register(connection, false)
}
fn connect(room: Room) -> Result<Connection, ApiError> {
    connect_with(room, announce)
}
fn connect_with(
    mut room: Room,
    publish: impl Fn(&Connection, bool) -> Result<(), ApiError>,
) -> Result<Connection, ApiError> {
    let local = route_address(&room)?;
    let renderer = probe(&room, local)?;
    if room.authorization.is_some() && renderer.services.connection_manager.is_none() {
        return Err(failure(502, "renderer", "房台未提供可用的设备登记接口"));
    }
    if room.authorization.is_none()
        && !renderer.name.is_empty()
        && !renderer.name.chars().any(char::is_control)
    {
        room.name.clone_from(&renderer.name);
    }
    let mut id = [0u8; 16];
    getrandom::fill(&mut id).map_err(|_| failure(503, "random", "无法初始化房台会话，请重试"))?;
    let connection = Connection {
        room,
        renderer,
        local,
        target_room_id: id.iter().map(|b| format!("{b:02x}")).collect(),
    };
    if let Err(error) = register(&connection, true) {
        // A timed-out response may still have registered us remotely.
        let _ = register(&connection, false);
        return Err(error);
    }
    let verified = probe(&connection.room, local);
    if !verified.is_ok_and(|r| same_renderer(&r, &connection.renderer))
        || !route_address(&connection.room).is_ok_and(|address| address == local)
    {
        if connection.room.authorization.is_some() {
            let _ = publish(&connection, false);
        }
        let _ = register(&connection, false);
        return Err(failure(
            409,
            "identity_changed",
            "房台或网络发生变化，请重新识别房间",
        ));
    }
    if connection.room.authorization.is_some()
        && let Err(error) = publish(&connection, true)
    {
        let _ = publish(&connection, false);
        let _ = register(&connection, false);
        return Err(error);
    }
    Ok(connection)
}
fn same_renderer(a: &Renderer, b: &Renderer) -> bool {
    a.udn == b.udn && a.control == b.control && a.service == b.service && a.services == b.services
}

fn probe_output() -> Result<Value, ApiError> {
    let (generation, connection) = with_app(|app| {
        let session = app.native();
        let state = &mut session.purek;
        if state.busy {
            return Err(busy());
        }
        if state.output.running.is_some() {
            return Err(busy());
        }
        let connection = state
            .connected
            .clone()
            .ok_or_else(|| failure(409, "not_authorized", "请先授权房台"))?;
        state.busy = true;
        state.generation += 1;
        state
            .output
            .probing(state.generation, connection.renderer.services.clone());
        session.revision += 1;
        Ok((state.generation, connection))
    })?;
    finish_output_probe(generation, &connection)
}
fn finish_output_probe(generation: u64, connection: &Connection) -> Result<Value, ApiError> {
    let result = renderer::probe(connection);
    with_app(|app| {
        let session = app.native();
        if session.purek.generation != generation
            || !session.purek.output.finish(generation, result)
        {
            return Err(busy());
        }
        session.purek.busy = false;
        session.revision += 1;
        Ok(snapshot(session))
    })
}
fn decode(body: &Value) -> Result<String, ApiError> {
    let width = body["width"]
        .as_u64()
        .filter(|v| (32..=576).contains(v))
        .ok_or_else(|| failure(400, "qr_image", "二维码图片尺寸无效"))? as usize;
    let height = body["height"]
        .as_u64()
        .filter(|v| (32..=576).contains(v))
        .ok_or_else(|| failure(400, "qr_image", "二维码图片尺寸无效"))? as usize;
    let encoded = body["pixels"]
        .as_str()
        .filter(|v| v.len() <= 576 * 576 * 4 / 3 + 4)
        .ok_or_else(|| failure(400, "qr_image", "二维码图片过大"))?;
    let pixels = STANDARD
        .decode(encoded)
        .map_err(|_| failure(400, "qr_image", "二维码图片无效"))?;
    if pixels.len() != width * height {
        return Err(failure(400, "qr_image", "二维码图片尺寸不匹配"));
    }
    let mut decoder = quircs::Quirc::default();
    let values: Vec<_> = decoder
        .identify(width, height, &pixels)
        .filter_map(Result::ok)
        .filter_map(|q| q.decode().ok())
        .filter_map(|q| String::from_utf8(q.payload).ok())
        .filter(|s| Room::parse(s).is_ok())
        .collect();
    if values.len() != 1 {
        return Err(failure(
            400,
            "qr_image",
            "请使用只含一个房间投屏二维码的清晰图片",
        ));
    }
    Ok(values.into_iter().next().unwrap())
}
pub(super) fn route(
    context: &Arc<HostContext>,
    method: &Method,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    if method == Method::GET && path == "/api/purek/state" {
        return with_app(|app| Ok(snapshot(app.native())));
    }
    if method != Method::POST || !body.is_object() {
        return Err(ApiError::invalid("此接口需要 JSON POST"));
    }
    if path == "/api/purek/output/start" {
        return output::start(context, body);
    }
    if matches!(path, "/api/purek/output/stop" | "/api/purek/output/pause") {
        if !body.as_object().is_some_and(|v| v.is_empty()) {
            return Err(ApiError::invalid("empty object required"));
        }
        return output::stop(path.ends_with("/pause"), None);
    }
    if path == "/api/purek/output/set_offset_mode" {
        if body.as_object().is_none_or(|v| v.len() != 1) {
            return Err(ApiError::invalid("mode required"));
        }
        let mode = match body["mode"].as_str() {
            Some("splice") => bilikara_rust::output_audio::OffsetMode::Splice,
            Some("gradual") => bilikara_rust::output_audio::OffsetMode::Gradual,
            _ => return Err(ApiError::invalid("mode must be splice or gradual")),
        };
        return with_app(|app| {
            let session = app.native();
            if session.purek.busy {
                return Err(busy());
            }
            if mode == bilikara_rust::output_audio::OffsetMode::Gradual
                && session
                    .purek
                    .output
                    .running
                    .as_ref()
                    .is_some_and(|r| r.level == "L0")
            {
                return Err(failure(
                    409,
                    "output_l1_required",
                    "L0 不支持动态 offset 或渐进模式",
                ));
            }
            session.purek.output.mode = mode;
            session.revision += 1;
            Ok(snapshot(session))
        });
    }
    if path == "/api/purek/output/probe" {
        if !body.as_object().is_some_and(|m| m.is_empty()) {
            return Err(ApiError::invalid("empty object required"));
        }
        return probe_output();
    }
    if path == "/api/purek/preferences" {
        let automatic = body["auto_discovery"]
            .as_bool()
            .filter(|_| body.as_object().is_some_and(|m| m.len() == 1))
            .ok_or_else(|| ApiError::invalid("auto_discovery must be boolean"))?;
        return with_app(|app| {
            let session = app.native();
            preferences::save(
                &context.directory,
                &session.cache_policy,
                session.ui_language,
                automatic,
            )?;
            session.purek.auto_discovery = automatic;
            if !automatic {
                session.purek.discovered.clear();
            }
            session.revision += 1;
            Ok(snapshot(session))
        });
    }
    if matches!(path, "/api/purek/prepare" | "/api/purek/decode") {
        let room = if path.ends_with("/decode") {
            Room::parse(&decode(body)?)?
        } else if let Some(raw) = body.get("url") {
            if body.as_object().is_none_or(|v| v.len() != 1) {
                return Err(ApiError::invalid("url must be the only field"));
            }
            Room::from_input(
                raw.as_str()
                    .ok_or_else(|| ApiError::invalid("url required"))?,
            )?
        } else {
            Room::parse(
                body["qr_url"]
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("qr_url required"))?,
            )?
        };
        return with_app(|app| {
            let session = app.native();
            if session.purek.busy || session.purek.connected.is_some() {
                return Err(busy());
            }
            session.purek.generation += 1;
            session.purek.output.stop(session.purek.generation);
            session.purek.error = None;
            let value = json!({"room_name":room.name,"connection_type":room.connection_type(),
                "authorization_url":room.authorization.as_ref().map(|a| &a.url)});
            session.purek.room = Some(room);
            session.revision += 1;
            Ok(value)
        });
    }
    if !matches!(path, "/api/purek/connect" | "/api/purek/disconnect") {
        return Err(failure(404, "route", "房间接口不存在"));
    }
    let disconnect = path.ends_with("/disconnect");
    let (generation, room, previous, active) = with_app(|app| {
        let session = app.native();
        let state = &mut session.purek;
        if state.busy {
            return Err(busy());
        }
        if !disconnect && state.connected.is_some() {
            return Err(busy());
        }
        if !disconnect && state.room.is_none() {
            return Err(failure(409, "qr_required", "请先识别房间二维码"));
        }
        state.busy = true;
        state.generation += 1;
        if disconnect && let Some(running) = &state.output.running {
            running.cancel();
        }
        session.revision += 1;
        Ok((
            state.generation,
            state.room.clone(),
            state.connected.clone(),
            state.output.running.is_some(),
        ))
    })?;
    let result = if disconnect {
        let stopped = previous
            .as_ref()
            .filter(|_| active)
            .map(|c| renderer::transport(c, "Stop", ""))
            .transpose();
        let released = previous.as_ref().map(release).transpose();
        stopped.and(released).map(|_| None)
    } else {
        connect(room.unwrap()).map(Some)
    };
    let probe_connection = result.as_ref().ok().and_then(|c| c.clone());
    let result_snapshot = with_app(|app| {
        let session = app.native();
        if session.purek.generation != generation {
            return Err(busy());
        }
        session.purek.busy = probe_connection.is_some();
        session.purek.error = result.as_ref().err().map(|e| e.code.clone());
        match &result {
            Ok(connection) => {
                session.purek.connected = connection.clone();
                if let Some(connection) = connection {
                    session.purek.room = Some(connection.room.clone());
                    // An opaque, process-local label; never expose the receiver UDN.
                    session
                        .purek
                        .output
                        .authorize(generation, connection.target_room_id.clone());
                    session
                        .purek
                        .output
                        .probing(generation, connection.renderer.services.clone());
                }
            }
            Err(_) if disconnect => {
                session.purek.connected = None;
            }
            _ => {}
        }
        if disconnect {
            session.purek.room = None;
            session.purek.output.stop(generation);
        }
        session.revision += 1;
        result.map(|_| snapshot(session))
    })?;
    if let Some(connection) = probe_connection {
        finish_output_probe(generation, &connection)
    } else {
        Ok(result_snapshot)
    }
}

// Discovery only suggests clearly identified room receivers. It never guesses
// authorization credentials from an SSID or automatically registers a device.
fn discover() -> Result<Vec<String>, ApiError> {
    discover_at(std::net::SocketAddrV4::new(
        Ipv4Addr::new(239, 255, 255, 250),
        1900,
    ))
}
fn discover_at(destination: std::net::SocketAddrV4) -> Result<Vec<String>, ApiError> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|_| network_error())?;
    socket
        .set_multicast_ttl_v4(2)
        .map_err(|_| network_error())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(150)))
        .map_err(|_| network_error())?;
    socket.send_to(b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n", destination).map_err(|_| network_error())?;
    let start = Instant::now();
    let mut buffer = [0; 8192];
    let mut locations = Vec::new();
    while start.elapsed() < Duration::from_millis(1200) && locations.len() < 4 {
        let Ok((size, source)) = socket.recv_from(&mut buffer) else {
            continue;
        };
        let text = String::from_utf8_lossy(&buffer[..size]);
        for line in text.lines().skip(1) {
            if let Some((key, value)) = line.split_once(':')
                && key.eq_ignore_ascii_case("location")
                && let Ok(url) = Url::parse(value.trim())
                && protocol::local_address(&url).ok().map(std::net::IpAddr::V4) == Some(source.ip())
                && !locations.contains(&url)
            {
                locations.push(url);
            }
        }
    }
    let mut names = Vec::new();
    for location in locations {
        let Ok(text) = client(None).and_then(|c| {
            response(
                c.get(location.clone())
                    .send()
                    .map_err(|_| network_error())?,
            )
        }) else {
            continue;
        };
        // A generic television is not sufficient evidence for a Pure K prompt.
        if !["dolphinstar", "chunk.cn", "purek", "纯k"]
            .iter()
            .any(|s| text.to_lowercase().contains(s))
        {
            continue;
        }
        if let Ok(renderer) = Renderer::parse(&text, &location) {
            names.push(renderer.name);
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}
pub(super) fn maintain(context: Arc<HostContext>) {
    let mut last_health = Instant::now();
    let mut last_discovery = Instant::now() - Duration::from_secs(60);
    let mut was_automatic = false;
    while !context.stop.load(Ordering::Acquire) {
        thread::sleep(Duration::from_secs(1));
        let Ok((automatic, busy, generation, connected)) = with_app(|app| {
            let s = &app.native().purek;
            Ok((s.auto_discovery, s.busy, s.generation, s.connected.clone()))
        }) else {
            break;
        };
        if busy {
            continue;
        }
        if let Some(connection) =
            connected.filter(|_| last_health.elapsed() >= Duration::from_secs(20))
        {
            last_health = Instant::now();
            // Claim the same operation lease as interactive connection changes.
            let admitted = with_app(|app| {
                let s = &mut app.native().purek;
                if s.generation != generation || s.busy {
                    return Ok(false);
                }
                s.busy = true;
                app.native().revision += 1;
                Ok(true)
            })
            .unwrap_or(false);
            if !admitted {
                continue;
            }
            let healthy = route_address(&connection.room)
                .is_ok_and(|local| local == connection.local)
                && probe(&connection.room, connection.local)
                    .is_ok_and(|r| same_renderer(&r, &connection.renderer))
                && announce(&connection, true).is_ok();
            if !healthy {
                let _ = release(&connection);
            }
            let _ = with_app(|app| {
                let session = app.native();
                if session.purek.generation != generation {
                    return Ok(());
                }
                session.purek.busy = false;
                session.revision += 1;
                if !healthy {
                    session.purek.connected = None;
                    session.purek.generation += 1;
                    session.purek.output.stop(session.purek.generation);
                    session.purek.error = Some("purek_network".into());
                    session.revision += 1;
                }
                Ok(())
            });
        }
        if automatic && (!was_automatic || last_discovery.elapsed() >= Duration::from_secs(60)) {
            last_discovery = Instant::now();
            if let Ok(names) = discover() {
                let _ = with_app(|app| {
                    let session = app.native();
                    if session.purek.auto_discovery && session.purek.discovered != names {
                        session.purek.discovered = names;
                        session.revision += 1;
                    }
                    Ok(())
                });
            }
        }
        was_automatic = automatic;
    }
    if let Ok(Some(connection)) = with_app(|app| {
        let session = app.native();
        let connection = session.purek.connected.take();
        session.purek.generation += 1;
        session.purek.output.stop(session.purek.generation);
        session.purek.busy = false;
        session.revision += 1;
        Ok(connection)
    }) {
        let _ = release(&connection);
    }
}
