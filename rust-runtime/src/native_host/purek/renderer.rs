//! G0 probe transport and AppState-owned, versioned output projection.
use super::{
    capabilities::{self, Assessment, ProtocolInfo, SinkFormat, TsProtocol},
    *,
};

#[derive(Default, PartialEq, Eq)]
enum Status {
    Authorized,
    Probing,
    Unverified,
    Unsupported,
    Error,
    #[default]
    Stopped,
    Starting,
    Streaming,
    Paused,
}
impl Status {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Authorized => "authorized",
            Self::Probing => "probing",
            Self::Unverified => "unverified",
            Self::Unsupported => "unsupported",
            Self::Error => "error",
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Streaming => "streaming",
            Self::Paused => "paused",
        }
    }
}

#[derive(Default)]
enum ProbeState {
    #[default]
    NotChecked,
    Reported,
    Empty,
    Unavailable,
}
impl ProbeState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::NotChecked => "not_checked",
            Self::Reported => "reported",
            Self::Empty => "empty",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Default)]
pub(super) struct OutputSession {
    pub mode: bilikara_rust::output_audio::OffsetMode,
    generation: u64,
    target_room_id: Option<String>,
    status: Status,
    services: protocol::Services,
    formats: Vec<SinkFormat>,
    protocol_info_state: ProbeState,
    probe_error: Option<String>,
    last_error: Option<String>,
    pub(super) running: Option<Arc<super::stream::Running>>,
}
impl OutputSession {
    pub fn authorize(&mut self, generation: u64, target_room_id: String) {
        *self = Self {
            generation,
            target_room_id: Some(target_room_id),
            status: Status::Authorized,
            ..Default::default()
        };
    }
    pub fn probing(&mut self, generation: u64, services: protocol::Services) {
        self.generation = generation;
        self.status = Status::Probing;
        self.services = services;
        self.formats.clear();
        self.protocol_info_state = ProbeState::NotChecked;
        self.probe_error = None;
        self.last_error = None;
    }
    pub fn finish(&mut self, generation: u64, result: Result<ProtocolInfo, ApiError>) -> bool {
        if self.generation != generation || self.status != Status::Probing {
            return false;
        }
        match result {
            Ok(info) => {
                self.protocol_info_state = if info.empty {
                    ProbeState::Empty
                } else {
                    ProbeState::Reported
                };
                let formats = info.formats;
                let assessment =
                    capabilities::assess(self.services.av_transport.is_some(), &formats);
                self.status = if info.empty && self.services.av_transport.is_some() {
                    Status::Unverified
                } else if assessment == Assessment::RequiresHardwareValidation {
                    Status::Authorized
                } else {
                    Status::Unsupported
                };
                self.last_error = Some(
                    if self.status == Status::Unverified {
                        "purek_output_capabilities_unverified"
                    } else {
                        match assessment {
                            Assessment::MissingAvTransport => "purek_output_no_av_transport",
                            Assessment::MissingVideoFormat => "purek_output_no_video_format",
                            Assessment::RequiresHardwareValidation => {
                                "purek_output_validation_required"
                            }
                        }
                    }
                    .into(),
                );
                self.formats = formats;
            }
            Err(error) => {
                self.protocol_info_state = ProbeState::Unavailable;
                self.probe_error = Some(error.code.clone());
                self.status = if self.services.av_transport.is_some() {
                    Status::Unverified
                } else {
                    Status::Unsupported
                };
                self.last_error = Some(if self.services.av_transport.is_some() {
                    error.code
                } else {
                    "purek_output_no_av_transport".into()
                });
            }
        }
        true
    }
    pub fn stop(&mut self, generation: u64) {
        if let Some(running) = self.running.take() {
            running.cancel();
        }
        *self = Self {
            generation,
            status: Status::Stopped,
            ..Default::default()
        };
    }
    pub(super) fn begin(&mut self, generation: u64, running: Arc<super::stream::Running>) {
        self.generation = generation;
        self.status = Status::Starting;
        self.last_error = None;
        self.running = Some(running);
    }
    pub(super) fn streaming(&mut self, generation: u64) -> bool {
        if self.generation != generation || self.status != Status::Starting {
            return false;
        }
        self.status = Status::Streaming;
        true
    }
    pub(super) fn pipeline_error(&mut self) {
        self.status = Status::Error;
        self.last_error = Some("purek_output_pipeline".into());
    }
    pub(super) fn end(&mut self, generation: u64, paused: bool, error: Option<&str>) {
        if let Some(running) = self.running.take() {
            running.cancel();
        }
        self.generation = generation;
        self.status = if error.is_some() {
            Status::Error
        } else if paused {
            Status::Paused
        } else {
            Status::Stopped
        };
        self.last_error = error.map(str::to_owned);
    }
    pub(super) fn protocol(&self) -> Result<TsProtocol, ApiError> {
        if self.services.av_transport.is_none() {
            return Err(failure(
                409,
                "output_no_av_transport",
                "房台没有 AVTransport",
            ));
        }
        // GetProtocolInfo is advisory. An explicit experimental output request
        // may try our actual H.264/AAC TS when the receiver cannot report it.
        // No formats or supports_* facts are invented by this compatibility path.
        if matches!(
            self.protocol_info_state,
            ProbeState::Empty | ProbeState::Unavailable
        ) {
            return Ok(TsProtocol::Mp2t);
        }
        capabilities::ts_protocol(&self.formats).ok_or_else(|| {
            failure(
                409,
                "output_ts_aac_required",
                "设备声明的格式不支持当前 H.264/AAC MPEG-TS 输出",
            )
        })
    }
    pub fn snapshot(&self) -> Value {
        json!({"schema_version":1,"target_room_id":self.target_room_id,
            "generation":self.generation,"status":self.status.as_str(),
            "capabilities":{
                "has_av_transport":self.services.av_transport.is_some(),
                "has_rendering_control":self.services.rendering_control.is_some(),
                "has_connection_manager":self.services.connection_manager.is_some(),
                "protocol_info_state":self.protocol_info_state.as_str(),
                "protocol_info_error":self.probe_error,
                "supports_play":false,"supports_pause":false,"supports_seek":false,
                "supports_live_stream":false,"supports_midstream_param_change":false,
                "supports_runtime_av_offset":false,"supports_track_switch":false,"supports_pitch_shift":false,
                "sink_formats":self.formats.iter().map(|f|json!({"mime":f.mime,"profile":f.profile})).collect::<Vec<_>>()},
            "pipeline_level":self.running.as_ref().map(|r|r.level),"offset_mode":match self.mode {bilikara_rust::output_audio::OffsetMode::Splice=>"splice",bilikara_rust::output_audio::OffsetMode::Gradual=>"gradual"},"last_error":self.last_error,
            "measured_adjust_latency_ms":null})
    }
}

pub(super) fn didl(uri: &str, protocol_info: &str) -> String {
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\"><dc:title>bilikara</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"{}\">{}</res></item></DIDL-Lite>",
        protocol::escape(protocol_info),
        protocol::escape(uri)
    )
}

pub(super) fn transport(
    connection: &Connection,
    action: &str,
    arguments: &str,
) -> Result<String, ApiError> {
    if !matches!(
        action,
        "Stop" | "SetAVTransportURI" | "Play" | "GetTransportInfo" | "GetPositionInfo"
    ) {
        return Err(protocol_error());
    }
    let service = connection
        .renderer
        .services
        .av_transport
        .as_ref()
        .ok_or_else(protocol_error)?;
    if !protocol::same_origin(&service.control, &connection.room.description) {
        return Err(protocol_error());
    }
    let reply = client(Some(connection.local))?.post(service.control.clone())
        .header("Content-Type","text/xml; charset=utf-8")
        .header("SOAPAction",format!("\"{}#{action}\"",service.service_type))
        .body(format!("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action} xmlns:u=\"{}\"><InstanceID>0</InstanceID>{arguments}</u:{action}></s:Body></s:Envelope>",service.service_type))
        .send().map_err(|_|network_error())?;
    let status = reply.status();
    if status != 200 && status != 500 {
        return Err(failure(502, "http", "房台媒体请求失败"));
    }
    let mut bytes = Vec::new();
    reply
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| network_error())?;
    if bytes.len() > 1024 * 1024 {
        return Err(protocol_error());
    }
    let text = String::from_utf8(bytes).map_err(|_| protocol_error())?;
    let doc = protocol::xml(&text).map_err(|_| protocol_error())?;
    let root = doc.root_element();
    let bodies: Vec<_> = root
        .children()
        .filter(|n| n.has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Body")))
        .collect();
    if !root.has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Envelope"))
        || bodies.len() != 1
    {
        return Err(protocol_error());
    }
    let replies: Vec<_> = bodies[0].children().filter(|n| n.is_element()).collect();
    if replies.len() != 1 {
        return Err(protocol_error());
    }
    if replies[0].has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Fault")) {
        return Err(failure(502, "receiver_fault", "房台拒绝媒体控制操作"));
    }
    if status != 200
        || !replies[0].has_tag_name((
            service.service_type.as_str(),
            format!("{action}Response").as_str(),
        ))
    {
        return Err(protocol_error());
    }
    Ok(text)
}
pub(super) fn start_transport(
    connection: &Connection,
    uri: &str,
    info: &str,
) -> Result<(), ApiError> {
    transport(connection, "Stop", "")?;
    let set = |metadata: &str| {
        transport(
            connection,
            "SetAVTransportURI",
            &format!(
                "<CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>",
                protocol::escape(uri),
                protocol::escape(metadata)
            ),
        )
    };
    if let Err(error) = set(&didl(uri, info)) {
        if error.code != "purek_receiver_fault" {
            return Err(error);
        }
        set("")?;
    }
    transport(connection, "Play", "<Speed>1</Speed>")?;
    Ok(())
}
pub(super) fn transport_state(connection: &Connection) -> Result<String, ApiError> {
    let text = transport(connection, "GetTransportInfo", "")?;
    let doc = protocol::xml(&text)?;
    let reply = doc
        .root_element()
        .children()
        .find(|n| n.has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Body")))
        .and_then(|body| body.children().find(|n| n.is_element()))
        .ok_or_else(protocol_error)?;
    let states: Vec<_> = reply
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "CurrentTransportState")
        .collect();
    if states.len() != 1
        || states[0].children().any(|n| n.is_element())
        || states[0]
            .tag_name()
            .namespace()
            .is_some_and(|s| s != reply.tag_name().namespace().unwrap_or_default())
    {
        return Err(protocol_error());
    }
    let state = states[0].text().unwrap_or_default().trim();
    if !matches!(
        state,
        "STOPPED" | "PLAYING" | "TRANSITIONING" | "PAUSED_PLAYBACK" | "NO_MEDIA_PRESENT"
    ) {
        return Err(protocol_error());
    }
    Ok(state.into())
}

fn protocol_error() -> ApiError {
    failure(502, "protocol_info", "无法确认房台支持的媒体格式")
}

pub(super) fn protocol_info(text: &str, service: &str) -> Result<ProtocolInfo, ApiError> {
    let doc = protocol::xml(text).map_err(|_| protocol_error())?;
    let root = doc.root_element();
    if !root.has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Envelope")) {
        return Err(protocol_error());
    }
    let bodies: Vec<_> = root
        .children()
        .filter(|n| n.has_tag_name(("http://schemas.xmlsoap.org/soap/envelope/", "Body")))
        .collect();
    if bodies.len() != 1 {
        return Err(protocol_error());
    }
    let replies: Vec<_> = bodies[0].children().filter(|n| n.is_element()).collect();
    if replies.len() != 1 || !replies[0].has_tag_name((service, "GetProtocolInfoResponse")) {
        return Err(protocol_error());
    }
    let fields: Vec<_> = replies[0].children().filter(|n| n.is_element()).collect();
    if fields.len() != 2
        || fields.iter().any(|n| {
            n.children().any(|c| c.is_element())
                || n.tag_name().namespace().is_some_and(|s| s != service)
        })
    {
        return Err(protocol_error());
    }
    let sources = fields
        .iter()
        .filter(|n| n.tag_name().name() == "Source")
        .count();
    let sinks: Vec<_> = fields
        .iter()
        .filter(|n| n.tag_name().name() == "Sink")
        .collect();
    if sources != 1 || sinks.len() != 1 {
        return Err(protocol_error());
    }
    ProtocolInfo::parse(sinks[0].text().unwrap_or_default()).map_err(|_| protocol_error())
}

pub(super) fn probe(connection: &Connection) -> Result<ProtocolInfo, ApiError> {
    let renderer = &connection.renderer;
    let service = renderer
        .services
        .connection_manager
        .as_ref()
        .ok_or_else(|| {
            failure(
                502,
                "output_no_connection_manager",
                "设备未提供媒体能力查询接口",
            )
        })?;
    // All endpoints came from the authorized receiver's validated description.
    // Check again here so a later caller cannot accidentally widen the boundary.
    protocol::local_address(&connection.room.description)?;
    if !protocol::same_origin(&service.control, &connection.room.description) {
        return Err(protocol_error());
    }
    let result = client(Some(connection.local))?
        .post(service.control.clone())
        .header("Content-Type", "text/xml; charset=utf-8")
        .header("SOAPAction", format!("\"{}#GetProtocolInfo\"", service.service_type))
        .body(format!("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetProtocolInfo xmlns:u=\"{}\"/></s:Body></s:Envelope>", service.service_type))
        .send().map_err(|_| network_error())?;
    protocol_info(&response(result)?, &service.service_type)
}
