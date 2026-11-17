//! P5 QR and next KTV assistance adapter. T5 is the sole receiver authority.
use super::*;
use crate::dlna::purek as t9;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{net::Ipv4Addr, time::Instant};
use url::Url;
pub(crate) mod assistance;
mod room;
use super::cast_session::State as RoomState;
pub(crate) use room::Room;
fn failure(status: u16, code: &str, message: &str) -> ApiError {
    ApiError::new(status, &format!("purek_{code}"), message)
}
fn busy() -> ApiError {
    failure(409, "busy", "房间操作正在进行，请稍后重试")
}
pub(super) fn authorization_error(error: &t9::PureKError) -> ApiError {
    use crate::dlna::ErrorCode as Cause;
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
    // Use the perspective-aware QR reader for camera photos. Keep decoding
    // local, QR-only and bounded by the same grayscale input limits.
    let mut hints = rxing::DecodeHints {
        PossibleFormats: Some(std::collections::HashSet::from([
            rxing::BarcodeFormat::QR_CODE,
        ])),
        ..Default::default()
    };
    let values: Vec<_> = rxing::helpers::detect_multiple_in_luma_with_hints(
        pixels,
        width as u32,
        height as u32,
        &mut hints,
    )
    .unwrap_or_default()
    .into_iter()
    .map(|result| result.getText().to_owned())
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

pub(crate) fn snapshot(session: &crate::app_state::native_session::NativeSession) -> Value {
    let mut value = session.cast.room_snapshot();
    value["revision"] = json!(session.revision);
    value["state_epoch"] = json!(session.state_epoch);
    value
}
pub(super) fn route(
    _context: &Arc<HostContext>,
    method: &Method,
    path: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    if !matches!(path, "/api/purek/prepare" | "/api/purek/decode") {
        return Err(failure(410, "retired", "此接口已退役，请使用 /api/cast/*"));
    }
    if method != Method::POST || !body.is_object() {
        return Err(ApiError::invalid("此接口需要 JSON POST"));
    }
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
    with_app(|app| {
        let session = app.native();
        if session.cast.self_test.running
            || session.cast.room_busy
            || session.cast.connected
            || session.cast.pending.is_some()
            || session.local_output.controller.owns_playback
        {
            return Err(busy());
        }
        session.cast.room_generation += 1;
        session.cast.room_error = None;
        session.cast.error_code = None;
        session.cast.room_failure = None;
        let value = json!({"room_name":room.name,"connection_type":room.connection_type(),
                "authorization_url":room.authorization_url()});
        session.cast.room = Some(room);
        session.revision += 1;
        Ok(value)
    })
}
pub(super) fn assisted_connect(
    context: &Arc<HostContext>,
    remote: &str,
    binding: (&str, &str),
) -> Result<Value, ApiError> {
    with_app(|app| {
        assistance::refresh(app);
        assistance::validate_check(app, remote, binding)?;
        if app.native().cast.connected
            || app.native().cast.room_busy
            || app.native().cast.owns_playback
            || app.native().local_output.controller.owns_playback
        {
            return Err(busy());
        }
        let room = app.native().cast.room.clone().ok_or_else(busy)?;
        let output = crate::cast_platform::OutputLease::acquire()
            .map_err(|e| ApiError::new(409, e.code(), e.code()))?;
        assistance::begin_check(app, remote, binding)?;
        let generation = app.native().cast.room_generation + 1;
        app.native().cast.room_generation = generation;
        app.native().ktv.connecting = Some((generation, binding.1.to_owned()));
        let grant = super::cast_session::Assisted {
            remote: remote.to_owned(),
            request: binding.0.to_owned(),
            epoch: binding.1.to_owned(),
            generation,
        };
        if let Err(error) =
            super::cast_session::admit_prepared(app, context, room, output, false, Some(grant))
        {
            assistance::checked(app, remote, false, Some(error.code.clone()));
            assistance::release_io(app, generation, binding.1);
            return Err(error);
        }
        Ok(assistance::connection_frame(app, remote))
    })
}
pub(super) fn maintain(context: Arc<HostContext>) {
    let mut discovery = std::time::Instant::now() - Duration::from_secs(60);
    while !context.stop.load(Ordering::Acquire) {
        if discovery.elapsed() >= Duration::from_secs(60) {
            let _ = super::cast_session::auto_discover(&context);
            discovery = std::time::Instant::now();
        }
        let _ = with_app(|app| {
            assistance::refresh(app);
            Ok(())
        });
        thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests;
