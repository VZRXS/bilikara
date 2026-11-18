// Adapted from bilikara-next 7750dca, native_host/purek.rs (MIT), including
// 3c8a129, and ChunK-Helper 3b00533, PureK/{DeviceAuthorizationClient,
// ConnectionServices}.cs, Network/SsdpAdvertisement.cs (MIT). Rewritten for
// cancellable T2 transport. See THIRD_PARTY_NOTICES.md.

use super::*;
use dlna_policy::{lan_web_url, soap_envelope, validate_soap_response};

impl PureKClient {
    pub(super) async fn connect_inner(
        &self,
        room: Room,
        approval: AddressApproval,
        cancel: &CancellationToken,
        stages: &mut Vec<PhaseResult>,
    ) -> Result<Session, PureKError> {
        let mut session = self.prepare(room, approval, cancel, stages).await?;
        let (description, stage) = session
            .read_description(Phase::DescriptionBefore, cancel)
            .await;
        stages.push(stage);
        let description = description?;
        let manager = description.manager.clone();
        session.description = Some(description);
        let result = async {
            let endpoint = manager.ok_or_else(|| {
                PureKError::new(
                    PureKErrorCode::MissingRegistrationService,
                    DlnaError::new(ErrorCode::Unavailable),
                )
            });
            if let Err(error) = endpoint {
                stages.push(PhaseResult::new(
                    Phase::Register,
                    Instant::now(),
                    &Err::<(), _>(error.clone()),
                    Some(&session.context),
                ));
                return Err(error);
            }
            // Store the exact IP/endpoint before sending: timeout or cancellation
            // can occur after the receiver applied the registration.
            session.registration = Some(Registration {
                endpoint: endpoint?,
                local: session.local,
            });
            let registration = session.registration.as_ref().expect("stored registration");
            let (result, stage) = session
                .authorization(registration, true, cancel, self.timeout)
                .await;
            stages.push(stage);
            result?;
            session.confirm(cancel, stages).await?;
            cancelled(cancel)?;
            stages.push(session.announcement(true, cancel).await);
            cancelled(cancel)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            stages.extend(session.release().await.stages);
            return Err(error);
        }
        session.next_announcement = Instant::now() + ANNOUNCE_INTERVAL;
        Ok(session)
    }
}

impl Session {
    pub(super) async fn confirm(
        &mut self,
        cancel: &CancellationToken,
        stages: &mut Vec<PhaseResult>,
    ) -> Result<(), PureKError> {
        let before = self
            .description
            .as_ref()
            .expect("initial description")
            .clone();
        let mut reregistered = false;
        for attempt in 1..=health::FAILURE_LIMIT {
            let since = Instant::now();
            let local = self.client.route(self.target, &mut self.context, cancel);
            let mut stage = route_stage(
                since,
                &local,
                self.target,
                &self.context,
                self.client.policy,
            );
            stage.stage.attempt = attempt;
            self.local = match local {
                Ok(local) => {
                    stages.push(stage);
                    local
                }
                Err(error) => {
                    if attempt < health::FAILURE_LIMIT && !error.cause.is_cancelled() {
                        stage.stage.disposition = Disposition::Retrying;
                        stages.push(stage);
                        self.wait_confirmation_retry(cancel).await?;
                        continue;
                    }
                    stages.push(stage);
                    return Err(error);
                }
            };
            let (confirmed, mut stage) = self.read_description(Phase::Confirm, cancel).await;
            stage.stage.attempt = attempt;
            match confirmed {
                Ok(description) => {
                    let same = description.udn.eq_ignore_ascii_case(&before.udn);
                    stage.facts.udn_same = Some(same);
                    stage.facts.registration_endpoint_changed =
                        Some(description.manager != before.manager);
                    stage.facts.services_changed_after_auth =
                        Some(description.services_changed(&before));
                    if !same {
                        let error = PureKError::new(
                            PureKErrorCode::IdentityChanged,
                            DlnaError::new(ErrorCode::Unavailable),
                        );
                        fail_stage(&mut stage, &error);
                        stages.push(stage);
                        return Err(error);
                    }
                    let registration = self.registration.as_ref().expect("pending registration");
                    let changed_route = registration.local != self.local;
                    stage.facts.route_changed = Some(changed_route);
                    if changed_route && reregistered {
                        let error = PureKError::new(
                            PureKErrorCode::RouteChanged,
                            DlnaError::new(ErrorCode::RouteUnavailable),
                        );
                        fail_stage(&mut stage, &error);
                        stages.push(stage);
                        return Err(error);
                    }
                    stages.push(stage);
                    self.description = Some(description.clone());
                    if changed_route {
                        // Keep cleanup bound to the old IP even if that source
                        // disappeared. Failure there cannot prevent the new try.
                        let old = self.registration.take().expect("pending registration");
                        let (_, old_stage) = self
                            .authorization(&old, false, cancel, REVOKE_TIMEOUT)
                            .await;
                        stages.push(old_stage);
                        if cancel.is_cancelled() {
                            self.registration = Some(old);
                            return Err(cancel_error());
                        }
                        self.registration = Some(Registration {
                            endpoint: description.manager.unwrap_or(old.endpoint),
                            local: self.local,
                        });
                        let registration = self
                            .registration
                            .as_ref()
                            .expect("replacement registration");
                        let (result, mut stage) = self
                            .authorization(registration, true, cancel, self.client.timeout)
                            .await;
                        stage.stage.attempt = 2;
                        stages.push(stage);
                        result?;
                        reregistered = true;
                        continue;
                    }
                    return Ok(());
                }
                Err(error) => {
                    if attempt < health::FAILURE_LIMIT && !error.cause.is_cancelled() {
                        stage.stage.disposition = Disposition::Retrying;
                        stages.push(stage);
                        self.wait_confirmation_retry(cancel).await?;
                    } else {
                        stages.push(stage);
                        return Err(error);
                    }
                }
            }
        }
        Err(PureKError::new(
            PureKErrorCode::RouteChanged,
            DlnaError::new(ErrorCode::RouteUnavailable),
        ))
    }

    async fn wait_confirmation_retry(&self, cancel: &CancellationToken) -> Result<(), PureKError> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(cancel_error()),
            _ = tokio::time::sleep(self.client.retry_interval) => Ok(()),
        }
    }

    pub(super) async fn authorization(
        &self,
        registration: &Registration,
        enable: bool,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> (Result<(), PureKError>, PhaseResult) {
        let since = Instant::now();
        let mut status = None;
        let mut nonconforming = None;
        let result = async {
            let endpoint = &registration.endpoint;
            let (url, address) = lan_web_url(&endpoint.control_url, self.client.policy)
                .map_err(|cause| PureKError::new(PureKErrorCode::Http, cause.into()))?;
            if address != self.target {
                return Err(PureKError::new(
                    PureKErrorCode::AddressNotAllowed,
                    PolicyError::ExternalControl.into(),
                ));
            }
            let local = registration.local.to_string();
            // Keep T2/Kirakara's XML declaration and quoted UTF-8 Content-Type
            // so authorization shares the tested SOAP transport. ChunK's
            // XDocument.ToString omits the declaration, and its StringContent
            // uses charset=utf-8 without quotes. This is an intentional wire
            // difference for T8 to record when investigating parser failures.
            let body = soap_envelope(
                &endpoint.service_type,
                SoapAction::SetDeviceAuthorization,
                &[
                    ("DeviceIP", &local),
                    ("Token", &self.room.token),
                    ("Enable", if enable { "1" } else { "0" }),
                ],
            )
            .map_err(|cause| PureKError::new(PureKErrorCode::Http, cause.into()))?;
            let client = http_client(registration.local, timeout)
                .map_err(|cause| PureKError::new(PureKErrorCode::Http, cause))?;
            let reply = http_request(
                &client,
                url,
                Some((
                    &endpoint.service_type,
                    SoapAction::SetDeviceAuthorization.as_str(),
                    body,
                )),
                dlna_policy::MAX_SOAP_BYTES,
                cancel,
            )
            .await
            .map_err(|cause| PureKError::new(PureKErrorCode::Http, cause))?;
            status = Some(reply.status);
            let parsed = validate_soap_response(&reply.body, SoapAction::SetDeviceAuthorization);
            if let Err(PolicyError::SoapFault(code)) = parsed {
                return Err(PureKError::new(
                    PureKErrorCode::AuthorizationRejected,
                    DlnaError::from(PolicyError::SoapFault(code)).status(reply.status),
                ));
            }
            if reply.status != 200 {
                return Err(PureKError::new(
                    PureKErrorCode::Http,
                    DlnaError::new(ErrorCode::HttpStatus).status(reply.status),
                ));
            }
            if let Err(error) = parsed {
                if matches!(error, PolicyError::TooDeep | PolicyError::TooLarge) {
                    return Err(PureKError::new(
                        PureKErrorCode::Http,
                        DlnaError::from(error).status(reply.status),
                    ));
                }
                // Empty or vendor acknowledgements are not a rejection. The
                // subsequent description and actual playback provide evidence.
                nonconforming = Some(error);
            }
            Ok(())
        }
        .await;
        let mut stage = PhaseResult::new(
            if enable {
                Phase::Register
            } else {
                Phase::Revoke
            },
            since,
            &result,
            Some(&self.context),
        );
        stage.stage.http_status = stage.stage.http_status.or(status);
        stage.stage.nonconforming_body = nonconforming;
        stage.facts.unconfirmed_response = nonconforming.is_some();
        if !enable && result.is_err() {
            stage.stage.disposition = Disposition::Ignored;
        }
        (result, stage)
    }

    pub(super) async fn announcement(
        &self,
        alive: bool,
        cancel: &CancellationToken,
    ) -> PhaseResult {
        let since = Instant::now();
        let mut sent = 0;
        let result = async {
            let Some(description) = &self.description else { return Ok(()); };
            let packets = description.advertisements(alive);
            let send = async {
                let socket = std::net::UdpSocket::bind((self.local, 0)).map_err(|_| DlnaError::new(ErrorCode::SocketBind))?;
                socket.set_nonblocking(true).map_err(|_| DlnaError::new(ErrorCode::Io))?;
                socket.set_multicast_ttl_v4(2).map_err(|_| DlnaError::new(ErrorCode::Io))?;
                socket2::SockRef::from(&socket).set_multicast_if_v4(&self.local).map_err(|_| DlnaError::new(ErrorCode::Io))?;
                let socket = tokio::net::UdpSocket::from_std(socket).map_err(|_| DlnaError::new(ErrorCode::Io))?;
                for packet in packets {
                    socket.send_to(&packet, self.client.notify_destination).await.map_err(|_| DlnaError::new(ErrorCode::Io))?;
                    sent += 1;
                }
                Ok::<_, DlnaError>(())
            };
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(cancel_error()),
                result = tokio::time::timeout(Duration::from_secs(1), send) => {
                    result.unwrap_or_else(|_| Err(DlnaError::new(ErrorCode::Timeout))).map_err(|cause| PureKError::new(PureKErrorCode::Unavailable, cause))
                }
            }
        }.await;
        let mut stage = PhaseResult::new(Phase::Announcement, since, &result, Some(&self.context));
        stage.facts.alive = Some(alive);
        stage.facts.announcements_sent = sent;
        if result.is_err() {
            stage.stage.disposition = Disposition::Ignored;
        }
        stage
    }

    /// Idempotent, bounded cleanup, independent of the cancelled work token.
    /// Cleanup failures remain in stages; they do not keep a local lease alive.
    /// T5 must await this on application shutdown, generation replacement and
    /// self-test cancellation. Dropping the lease alone sends no revocation.
    pub async fn release(&mut self) -> PureKOperation<()> {
        self.closed = true;
        let Some(registration) = self.registration.take() else {
            return PureKOperation {
                result: Ok(()),
                stages: Vec::new(),
            };
        };
        let cancel = CancellationToken::new();
        // Run both best-effort operations within the same three-second budget.
        let (announcement, (_, revoke)) = tokio::join!(
            self.announcement(false, &cancel),
            self.authorization(&registration, false, &cancel, REVOKE_TIMEOUT)
        );
        PureKOperation {
            result: Ok(()),
            stages: vec![announcement, revoke],
        }
    }
}

pub(super) fn fail_stage(stage: &mut PhaseResult, error: &PureKError) {
    stage.stage.result = Err(error.cause.clone());
    stage.error_code = Some(error.code);
}
