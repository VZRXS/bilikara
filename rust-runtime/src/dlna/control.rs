// Ported from VZRXS/bilikara PR #120 by FMPeach (MIT), commit 297ae1de,
// rust-runtime/src/show_dlna.rs. SOAP/DIDL: Kirakara-App e449070 (MIT),
// lib/services/dlna/dlna_control_point.dart. See THIRD_PARTY_NOTICES.md.
//! Cancellable SOAP control, independent of the media producer and session store.

use super::*;
use dlna_policy::{
    AV_TRANSPORT, CONNECTION_MANAGER, FileMetadata, PositionInfo, RENDERING_CONTROL,
    ServiceEndpoint, TransportState, build_didl, choose_mpeg_ts_protocol_info, format_upnp_time,
    lan_url, lan_web_url, parse_position_info, parse_sink_protocol_info, parse_transport_info,
    service_version, soap_envelope, validate_route_source, validate_soap_response,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolInfoState {
    NotChecked,
    Reported,
    Empty,
    Unavailable,
}

#[derive(Clone, Debug)]
pub enum CapabilityQuery {
    Query,
    Skip,
    Known(Vec<String>),
}

pub struct StartRequest<'a> {
    pub uri: &'a str,
    pub title: &'a str,
    pub file: Option<FileMetadata>,
    pub capabilities: CapabilityQuery,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartResult {
    pub protocol_info: String,
    pub protocol_info_state: ProtocolInfoState,
}

pub struct ControlClient {
    renderer: Renderer,
    client: reqwest::Client,
    policy: NetworkPolicy,
}

impl ControlClient {
    pub fn new(renderer: Renderer) -> Result<Self, DlnaError> {
        Self::with_policy(
            renderer,
            &local_ipv4(NetworkPolicy::Lan),
            NetworkPolicy::Lan,
            HTTP_TIMEOUT,
        )
    }

    pub(super) fn with_policy(
        renderer: Renderer,
        interfaces: &[Ipv4Addr],
        policy: NetworkPolicy,
        timeout: Duration,
    ) -> Result<Self, DlnaError> {
        Self::with_route_lookup(
            renderer,
            interfaces,
            policy,
            timeout,
            super::discovery::system_route_source,
        )
    }

    fn with_route_lookup(
        mut renderer: Renderer,
        interfaces: &[Ipv4Addr],
        policy: NetworkPolicy,
        timeout: Duration,
        lookup: fn(Ipv4Addr) -> Result<Ipv4Addr, DlnaError>,
    ) -> Result<Self, DlnaError> {
        let (_, address) = lan_web_url(&renderer.description.location, policy)?;
        validate_route_source(renderer.local_address, interfaces, policy)?;
        // A valid interface fallback must survive VPN/TUN route changes.
        // Binding the chosen local source is the transport constraint.
        let routed = lookup(address).ok();
        let previous = renderer.context.route.take();
        renderer.context.route = Some(RouteFacts {
            selection: Some(
                previous
                    .as_ref()
                    .and_then(|r| r.selection)
                    .unwrap_or(LocalSourceKind::Explicit),
            ),
            routed_source_is_local: routed
                .map(|source| validate_route_source(source, interfaces, policy).is_ok()),
            route_matches_selected: routed.map(|source| source == renderer.local_address),
            route_matches_reply: previous.and_then(|r| r.route_matches_reply),
        });
        for (service, prefix) in [
            (Some(&renderer.description.av_transport), AV_TRANSPORT),
            (
                renderer.description.connection_manager.as_ref(),
                CONNECTION_MANAGER,
            ),
            (
                renderer.description.rendering_control.as_ref(),
                RENDERING_CONTROL,
            ),
        ] {
            if let Some(service) = service {
                if service_version(&service.service_type, prefix).is_none() {
                    return Err(PolicyError::InvalidService.into());
                }
                if lan_web_url(&service.control_url, policy)?.1 != address {
                    return Err(PolicyError::ExternalControl.into());
                }
            }
        }
        Ok(Self {
            client: http_client(renderer.local_address, timeout)?,
            renderer,
            policy,
        })
    }

    pub fn renderer(&self) -> &Renderer {
        &self.renderer
    }

    async fn invoke(
        &self,
        endpoint: Option<&ServiceEndpoint>,
        action: SoapAction,
        args: &[(&str, &str)],
        cancel: &CancellationToken,
    ) -> Operation<String> {
        let since = Instant::now();
        let mut status = None;
        let mut nonconforming_body = None;
        let result = async {
            if cancel.is_cancelled() {
                return Err(DlnaError::new(ErrorCode::Cancelled));
            }
            let endpoint = endpoint.ok_or_else(|| DlnaError::new(ErrorCode::Unavailable))?;
            let body = soap_envelope(&endpoint.service_type, action, args)?;
            let (url, _) = lan_web_url(&endpoint.control_url, self.policy)?;
            let reply = http_request(
                &self.client,
                url,
                Some((&endpoint.service_type, action.as_str(), body)),
                dlna_policy::MAX_SOAP_BYTES,
                cancel,
            )
            .await?;
            status = Some(reply.status);
            let parsed = validate_soap_response(&reply.body, action);
            if let Err(PolicyError::SoapFault(code)) = parsed {
                return Err(DlnaError::from(PolicyError::SoapFault(code)).status(reply.status));
            }
            if !(200..300).contains(&reply.status) {
                return Err(DlnaError::new(ErrorCode::HttpStatus).status(reply.status));
            }
            if let Err(error) = parsed {
                if matches!(
                    action,
                    SoapAction::GetProtocolInfo
                        | SoapAction::GetTransportInfo
                        | SoapAction::GetPositionInfo
                ) {
                    return Err(DlnaError::from(error).status(reply.status));
                }
                // Kirakara accepts any 2xx acknowledgement for no-value actions.
                // Parsing is still bounded, and a recognizable Fault wins above.
                nonconforming_body = Some(error);
            }
            Ok(reply.body)
        }
        .await;
        let mut stage = StageResult::new(Stage::Action(action), since, status, &result);
        stage.nonconforming_body = nonconforming_body;
        stage.context = Some(self.renderer.context.clone());
        Operation {
            result,
            stages: vec![stage],
            dropped_stages: 0,
        }
    }

    async fn transport(
        &self,
        action: SoapAction,
        args: &[(&str, &str)],
        cancel: &CancellationToken,
    ) -> Operation<String> {
        self.invoke(
            Some(&self.renderer.description.av_transport),
            action,
            args,
            cancel,
        )
        .await
    }

    /// GetProtocolInfo is advisory in all states, including not yet queried.
    pub async fn get_protocol_info(&self, cancel: &CancellationToken) -> Operation<Vec<String>> {
        parsed(
            self.invoke(
                self.renderer.description.connection_manager.as_ref(),
                SoapAction::GetProtocolInfo,
                &[],
                cancel,
            )
            .await,
            parse_sink_protocol_info,
        )
    }

    /// Stop errors are recorded and ignored here. Standalone stop still reports errors.
    pub async fn start(
        &self,
        request: StartRequest<'_>,
        cancel: &CancellationToken,
    ) -> Operation<StartResult> {
        let mut stages = Vec::new();
        let result = self.start_inner(request, cancel, &mut stages).await;
        Operation {
            result,
            stages,
            dropped_stages: 0,
        }
    }

    async fn start_inner(
        &self,
        request: StartRequest<'_>,
        cancel: &CancellationToken,
        stages: &mut Vec<StageResult>,
    ) -> Result<StartResult, DlnaError> {
        if cancel.is_cancelled() {
            return Err(DlnaError::new(ErrorCode::Cancelled));
        }
        if lan_url(request.uri, self.policy)?.1 != self.renderer.local_address {
            return Err(PolicyError::RouteNotLocal.into());
        }
        let (entries, protocol_info_state) = match request.capabilities {
            CapabilityQuery::Query => {
                let mut operation = self.get_protocol_info(cancel).await;
                if operation
                    .result
                    .as_ref()
                    .is_err_and(|error| !error.is_cancelled())
                {
                    operation.stages[0].disposition = Disposition::Ignored;
                }
                stages.extend(operation.stages);
                match operation.result {
                    Ok(entries) => {
                        let state = if entries.is_empty() {
                            ProtocolInfoState::Empty
                        } else {
                            ProtocolInfoState::Reported
                        };
                        (entries, state)
                    }
                    Err(error) if error.is_cancelled() => return Err(error),
                    Err(_) => (Vec::new(), ProtocolInfoState::Unavailable),
                }
            }
            CapabilityQuery::Skip => (Vec::new(), ProtocolInfoState::NotChecked),
            CapabilityQuery::Known(entries) => {
                let state = if entries.is_empty() {
                    ProtocolInfoState::Empty
                } else {
                    ProtocolInfoState::Reported
                };
                (entries, state)
            }
        };
        let protocol_info = choose_mpeg_ts_protocol_info(&entries);
        let mut stopping = self.stop(cancel).await;
        if let Err(error) = &stopping.result {
            if error.is_cancelled() {
                stages.extend(stopping.stages);
                return Err(error.clone());
            }
            stopping.stages[0].disposition = Disposition::Ignored;
        }
        stages.extend(stopping.stages);
        let metadata = build_didl(request.uri, request.title, &protocol_info, request.file);
        let mut setting = self.set_uri(request.uri, &metadata, cancel).await;
        let retry = setting
            .result
            .as_ref()
            .is_err_and(DlnaError::metadata_retry);
        if retry {
            setting.stages[0].disposition = Disposition::Retrying;
        }
        let set_result = setting.result;
        stages.extend(setting.stages);
        if retry {
            let mut fallback = self.set_uri(request.uri, "", cancel).await;
            fallback.stages[0].attempt = 2;
            stages.extend(fallback.stages);
            fallback.result?;
        } else {
            set_result?;
        }
        let mut playing = self.play(cancel).await;
        let retry = playing
            .result
            .as_ref()
            .is_err_and(|error| !error.is_cancelled());
        if retry {
            playing.stages[0].disposition = Disposition::Retrying;
        }
        let play_result = playing.result;
        stages.extend(playing.stages);
        if retry {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(DlnaError::new(ErrorCode::Cancelled)),
                _ = tokio::time::sleep(Duration::from_secs(1)) => {}
            }
            let mut playing = self.play(cancel).await;
            playing.stages[0].attempt = 2;
            stages.extend(playing.stages);
            playing.result?;
        } else {
            play_result?;
        }
        Ok(StartResult {
            protocol_info,
            protocol_info_state,
        })
    }

    pub async fn set_uri(
        &self,
        uri: &str,
        metadata: &str,
        cancel: &CancellationToken,
    ) -> Operation<()> {
        // Public commands enforce the same route as start, even outside its sequence.
        if let Err(error) =
            lan_url(uri, self.policy)
                .map_err(DlnaError::from)
                .and_then(|(_, address)| {
                    if address == self.renderer.local_address {
                        Ok(())
                    } else {
                        Err(PolicyError::RouteNotLocal.into())
                    }
                })
        {
            let result = Err(error);
            return Operation {
                stages: vec![
                    StageResult::new(
                        Stage::Action(SoapAction::SetAVTransportURI),
                        Instant::now(),
                        None,
                        &result,
                    )
                    .for_device(&self.renderer.context),
                ],
                result,
                dropped_stages: 0,
            };
        }
        unit(
            self.transport(
                SoapAction::SetAVTransportURI,
                &[
                    ("InstanceID", "0"),
                    ("CurrentURI", uri),
                    ("CurrentURIMetaData", metadata),
                ],
                cancel,
            )
            .await,
        )
    }

    pub async fn stop(&self, cancel: &CancellationToken) -> Operation<()> {
        unit(
            self.transport(SoapAction::Stop, &[("InstanceID", "0")], cancel)
                .await,
        )
    }
    pub async fn play(&self, cancel: &CancellationToken) -> Operation<()> {
        unit(
            self.transport(
                SoapAction::Play,
                &[("InstanceID", "0"), ("Speed", "1")],
                cancel,
            )
            .await,
        )
    }
    pub async fn pause(&self, cancel: &CancellationToken) -> Operation<()> {
        unit(
            self.transport(SoapAction::Pause, &[("InstanceID", "0")], cancel)
                .await,
        )
    }
    pub async fn seek(&self, position: Duration, cancel: &CancellationToken) -> Operation<()> {
        let target = format_upnp_time(position);
        unit(
            self.transport(
                SoapAction::Seek,
                &[
                    ("InstanceID", "0"),
                    ("Unit", "REL_TIME"),
                    ("Target", &target),
                ],
                cancel,
            )
            .await,
        )
    }
    pub async fn get_transport_info(
        &self,
        cancel: &CancellationToken,
    ) -> Operation<TransportState> {
        parsed(
            self.transport(SoapAction::GetTransportInfo, &[("InstanceID", "0")], cancel)
                .await,
            parse_transport_info,
        )
    }
    pub async fn get_position_info(&self, cancel: &CancellationToken) -> Operation<PositionInfo> {
        parsed(
            self.transport(SoapAction::GetPositionInfo, &[("InstanceID", "0")], cancel)
                .await,
            parse_position_info,
        )
    }
}

fn unit(operation: Operation<String>) -> Operation<()> {
    Operation {
        result: operation.result.map(|_| ()),
        stages: operation.stages,
        dropped_stages: operation.dropped_stages,
    }
}

fn parsed<T>(
    mut operation: Operation<String>,
    parse: fn(&str) -> Result<T, PolicyError>,
) -> Operation<T> {
    let result = operation.result.and_then(|body| {
        parse(&body).map_err(|error| {
            let mut error = DlnaError::from(error);
            if let Some(stage) = operation.stages.last_mut() {
                error.http_status = stage.http_status;
                stage.result = Err(error.clone());
            }
            error
        })
    });
    Operation {
        result,
        stages: operation.stages,
        dropped_stages: operation.dropped_stages,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MonitorDecision {
    Observed,
    TransientFailure,
    Disabled,
    Disconnected,
    Cancelled,
}

/// Per-worker observation bookkeeping, never playback or playlist authority.
/// Call every two seconds; stopped/no-media observations are returned to AppState
/// for duration-aware end-of-song handling, never treated as transport failures.
#[derive(Debug, Default)]
pub struct TransportMonitor {
    disabled: bool,
    network_failures: u8,
}

#[derive(Debug)]
pub struct MonitorSample {
    pub decision: MonitorDecision,
    pub state: Option<TransportState>,
    pub operation: Option<Operation<TransportState>>,
}

impl TransportMonitor {
    pub async fn poll(
        &mut self,
        client: &ControlClient,
        cancel: &CancellationToken,
    ) -> MonitorSample {
        if self.disabled {
            return MonitorSample {
                decision: MonitorDecision::Disabled,
                state: None,
                operation: None,
            };
        }
        let operation = client.get_transport_info(cancel).await;
        let (state, decision) = match &operation.result {
            Ok(TransportState::Unknown) => {
                self.network_failures = 0;
                self.disabled = true;
                (Some(TransportState::Unknown), MonitorDecision::Disabled)
            }
            Ok(state) => {
                self.network_failures = 0;
                (Some(*state), MonitorDecision::Observed)
            }
            Err(error) if error.is_cancelled() => (None, MonitorDecision::Cancelled),
            Err(error) if error.is_network() => {
                self.network_failures = self.network_failures.saturating_add(1);
                (
                    None,
                    if self.network_failures >= 3 {
                        MonitorDecision::Disconnected
                    } else {
                        MonitorDecision::TransientFailure
                    },
                )
            }
            Err(_) => {
                self.network_failures = 0;
                self.disabled = true;
                (None, MonitorDecision::Disabled)
            }
        };
        MonitorSample {
            decision,
            state,
            operation: Some(operation),
        }
    }
}

#[cfg(test)]
mod tests;
