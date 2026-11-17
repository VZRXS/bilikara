//! Transitional next Host adapter for R1 T9 (bilikara b49e1ae, T9 121ef9d).
//! T9 owns QR policy, registration, confirmation, NOTIFY, health and revocation.
//! AppState still admits the worker; copies of Connection share one I/O lease.
//! P6 replaces the surrounding output/controller with the cast session worker.
use super::*;
use crate::dlna::{self, CancellationToken, purek as t9};
use std::sync::{Mutex, Weak};

pub(super) struct Lease {
    runtime: tokio::runtime::Runtime,
    session: t9::Session,
    next_health: Instant,
    output: Option<(Weak<trace::OutputTrace>, u64)>,
    delivered: u64,
}

pub(super) fn error(error: &t9::PureKError) -> ApiError {
    use dlna::ErrorCode as Cause;
    use t9::PureKErrorCode as Code;
    let (status, code) = match error.code {
        Code::InvalidQr | Code::AddressNotAllowed => (400, "qr_invalid"),
        Code::AddressConfirmationRequired => (409, "address_confirmation_required"),
        Code::IdentityChanged | Code::RouteChanged => (409, "identity_changed"),
        Code::MissingRegistrationService => (502, "renderer"),
        Code::AuthorizationRejected => (502, "authorization"),
        Code::Cancelled => (409, "cancelled"),
        Code::Unavailable => (503, "unavailable"),
        _ => match error.cause.code {
            Cause::HttpStatus => (502, "http"),
            Cause::Policy(_) | Cause::InvalidUtf8 => (502, "protocol"),
            _ => (502, "network"),
        },
    };
    let mut facts = json!({});
    if let Some(status) = error.cause.http_status {
        facts["http_status"] = json!(status);
    }
    if matches!(
        error.cause.code,
        Cause::Policy(bilikara_rust::dlna_policy::PolicyError::SoapFault(_))
    ) {
        facts["soap_fault"] = json!(true);
        facts["upnp_error"] = json!(error.cause.upnp_code);
    }
    if error.cause.is_network() {
        facts["transport"] = json!(error.cause.code.as_str());
    }
    failure(
        status,
        code,
        match code {
            "qr_invalid" => "请使用完整的纯 K 房间投屏二维码",
            "address_confirmation_required" => "设备主机名需要单独确认，请使用局域网 IPv4 地址",
            "authorization" => "房台未确认设备登记，请完成官方授权后重试",
            "identity_changed" => "房台或网络发生变化，请重新识别房间",
            "renderer" => "房台未提供可用的设备登记接口",
            _ => "无法完成房台操作，请检查房间 Wi-Fi 和官方授权",
        },
    )
    .with_diagnostic(facts)
}

fn client(room: &Room) -> t9::PureKClient {
    #[cfg(test)]
    if room
        .description
        .host_str()
        .is_some_and(|host| host.parse::<Ipv4Addr>().is_ok_and(|ip| ip.is_loopback()))
    {
        return t9::PureKClient::loopback_fixture((Ipv4Addr::LOCALHOST, 9).into());
    }
    let _ = room;
    t9::PureKClient::new()
}

pub(super) fn connect(
    room: Room,
    steps: &mut trace::ConnectTrace,
    cancel: &CancellationToken,
) -> Result<Connection, ApiError> {
    let client = client(&room);
    connect_with_client(room, steps, cancel, client)
}

pub(super) fn connect_with_client(
    room: Room,
    steps: &mut trace::ConnectTrace,
    cancel: &CancellationToken,
    client: t9::PureKClient,
) -> Result<Connection, ApiError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| failure(503, "unavailable", "房台连接服务不可用"))?;
    let operation = runtime.block_on(client.connect(
        room.authorization_url().expect("Pure K room"),
        t9::AddressApproval::LanLiteralOnly,
        cancel,
    ));
    steps.purek(&operation.stages);
    let mut session = operation.result.map_err(|cause| error(&cause))?;
    let result = metadata(&session).and_then(|(renderer, local)| {
        Ok(Connection {
            room,
            renderer,
            local,
            target_room_id: connection_id()?,
            lease: None,
        })
    });
    match result {
        Ok(mut connection) => {
            connection.lease = Some(Arc::new(Mutex::new(Lease {
                runtime,
                session,
                next_health: Instant::now() + t9::NORMAL_INTERVAL,
                output: None,
                delivered: 0,
            })));
            Ok(connection)
        }
        Err(error) => {
            steps.purek(&runtime.block_on(session.release()).stages);
            Err(error)
        }
    }
}

fn metadata(session: &t9::Session) -> Result<(Renderer, Ipv4Addr), ApiError> {
    let info = session
        .connection_info()
        .ok_or_else(|| failure(409, "not_authorized", "请先授权房台"))?;
    let service = |endpoint: &bilikara_rust::dlna_policy::ServiceEndpoint| -> Result<protocol::Service, ApiError> {
        Ok(protocol::Service {
            control: Url::parse(&endpoint.control_url).map_err(|_| failure(502, "protocol", "房台服务地址无效"))?,
            service_type: endpoint.service_type.clone(),
        })
    };
    Ok((
        Renderer {
            udn: info.udn.to_owned(),
            name: info.name.to_owned(),
            services: protocol::Services {
                av_transport: info.av_transport.map(service).transpose()?,
                connection_manager: info.manager.map(service).transpose()?,
                rendering_control: info.rendering.map(service).transpose()?,
            },
        },
        info.local,
    ))
}

pub(super) fn release(connection: &Connection) -> Result<(), ApiError> {
    if let Some(lease) = &connection.lease {
        let mut lease = lease
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Lease {
            runtime, session, ..
        } = &mut *lease;
        // T9's idempotent cleanup uses an independent, bounded cancellation token.
        // A failed remote revoke is diagnostic only and never retains the lease.
        let operation = runtime.block_on(session.release());
        record_maintenance(connection, &operation.stages, true);
        operation.result.map_err(|cause| error(&cause))?;
    }
    Ok(())
}

fn record_maintenance(connection: &Connection, stages: &[t9::PhaseResult], released: bool) {
    if stages.is_empty() {
        return;
    }
    let mut steps = trace::ConnectTrace::new(&connection.room);
    steps.purek(stages);
    let mut entry = steps.finish(None);
    entry["result"] = json!(if released { "released" } else { "retained" });
    let _ = with_app(|app| {
        let state = &mut app.native().purek;
        if state
            .connected
            .as_ref()
            .is_some_and(|current| current.target_room_id == connection.target_room_id)
        {
            state.diagnostics.connection(entry);
        }
        Ok(())
    });
}

pub(super) fn maintain(
    connection: &mut Connection,
    output: Option<&Arc<trace::OutputTrace>>,
) -> bool {
    let shared = Arc::clone(connection.lease.as_ref().expect("Pure K lease"));
    let mut lease = shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(output) = output {
        let bytes = output.received_stream().2;
        let previous = lease
            .output
            .as_ref()
            .filter(|(old, _)| old.ptr_eq(&Arc::downgrade(output)))
            .map_or(0, |(_, bytes)| *bytes);
        lease.delivered = lease
            .delivered
            .saturating_add(bytes.saturating_sub(previous));
        lease.output = Some((Arc::downgrade(output), bytes));
    }
    let delivered = lease.delivered;
    lease.session.record_delivery(delivered);
    let cancel = CancellationToken::new();
    let Lease {
        runtime,
        session,
        next_health,
        ..
    } = &mut *lease;
    let mut stages: Vec<_> = runtime
        .block_on(session.renew_announcement(&cancel))
        .into_iter()
        .collect();
    let alive = if Instant::now() >= *next_health {
        let operation = runtime.block_on(session.poll_health(&cancel));
        stages.extend(operation.stages);
        *next_health = Instant::now() + session.health_interval();
        matches!(
            operation.result,
            Ok(t9::HealthState::Online | t9::HealthState::Suspect)
        )
    } else {
        session.is_registered()
    };
    if alive && let Ok((renderer, local)) = metadata(session) {
        connection.renderer = renderer;
        connection.local = local;
    }
    drop(lease);
    record_maintenance(connection, &stages, !alive);
    alive
}

#[cfg(test)]
pub(super) fn sample_now(connection: &mut Connection) -> bool {
    connection
        .lease
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .next_health = Instant::now();
    maintain(connection, None)
}
