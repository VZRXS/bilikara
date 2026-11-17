// Adapted from bilikara-next 7750dca, native_host/purek.rs and purek/{protocol,
// health,trace}.rs (MIT), including dd88c12/3c8a129/0870f2b; ChunK-Helper
// 3b00533, PureK/ConnectionServices.cs (MIT). See THIRD_PARTY_NOTICES.md.
//! QR-directed Pure K authorization transport for the AppState-owned worker.
//!
//! No global state, persistence, UI, playback authority or background tasks.
//! Keep each Session under its admitted AppState generation. Run `maintain`
//! with that generation's cancellation token, or explicitly await `release`
//! on exit/replacement. Token and room values must never enter snapshots.
//! A command worker may instead schedule `poll_health` and `renew_announcement`
//! using `health_interval` and `announcement_delay`, keeping commands serialized.
//! T5 must await `Session::release` on application shutdown, generation
//! replacement and self-test cancellation before dropping the lease. Drop does
//! not perform network cleanup; cancelling `maintain` must also be awaited.

mod health;
mod protocol;
pub mod qr;
mod register;
#[cfg(test)]
mod tests;

pub use health::{HealthState, NORMAL_INTERVAL, RETRY_INTERVAL};
pub use protocol::{ServiceKind, ServiceSummary, ServiceSummaryEntry};
pub use qr::{AddressClass, QrFacts, Room};

use super::{
    CancellationToken, DeviceContext, DiscoverySource, Disposition, DlnaError, ErrorCode,
    HTTP_TIMEOUT, Renderer, RouteFacts, Stage, StageResult, dlna_policy, http_client, http_request,
    local_ipv4,
};
use dlna_policy::{NetworkPolicy, PolicyError, ServiceEndpoint, SoapAction, select_local_source};
use protocol::Description;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};
use url::Url;

pub const REVOKE_TIMEOUT: Duration = Duration::from_secs(3);
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PureKErrorCode {
    InvalidQr,
    AddressConfirmationRequired,
    AddressNotAllowed,
    Resolve,
    Route,
    Description,
    MissingRegistrationService,
    AuthorizationRejected,
    Http,
    IdentityChanged,
    RouteChanged,
    Unavailable,
    Cancelled,
}

impl PureKErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidQr => "cast_purek_qr_invalid",
            Self::AddressConfirmationRequired => "cast_purek_address_confirmation_required",
            Self::AddressNotAllowed => "cast_purek_address_not_allowed",
            Self::Resolve => "cast_purek_resolve",
            Self::Route => "cast_purek_route",
            Self::Description => "cast_purek_description",
            Self::MissingRegistrationService => "cast_purek_registration_unavailable",
            Self::AuthorizationRejected => "cast_purek_authorization_rejected",
            Self::Http => "cast_purek_http",
            Self::IdentityChanged => "cast_purek_identity_changed",
            Self::RouteChanged => "cast_purek_route_changed",
            Self::Unavailable => "cast_purek_unavailable",
            Self::Cancelled => "cast_purek_cancelled",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PureKError {
    pub code: PureKErrorCode,
    pub cause: DlnaError,
}

impl PureKError {
    fn new(code: PureKErrorCode, cause: DlnaError) -> Self {
        Self {
            code: if cause.is_cancelled() {
                PureKErrorCode::Cancelled
            } else {
                code
            },
            cause,
        }
    }
}
impl std::fmt::Display for PureKError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code.as_str())
    }
}
impl std::error::Error for PureKError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Parse,
    Resolve,
    Route,
    DescriptionBefore,
    Register,
    Confirm,
    Announcement,
    Health,
    Revoke,
}
impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parse => "purek_parse",
            Self::Resolve => "purek_resolve",
            Self::Route => "purek_route",
            Self::DescriptionBefore => "purek_description_before",
            Self::Register => "purek_register",
            Self::Confirm => "purek_confirm",
            Self::Announcement => "purek_announcement",
            Self::Health => "purek_health",
            Self::Revoke => "purek_revoke",
        }
    }
    fn stage(self) -> Stage {
        match self {
            Self::Parse | Self::Resolve | Self::Route => Stage::Route,
            Self::DescriptionBefore | Self::Confirm | Self::Health => Stage::Description,
            Self::Register | Self::Revoke => Stage::Action(SoapAction::SetDeviceAuthorization),
            Self::Announcement => Stage::Advertisement,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PhaseFacts {
    pub qr: Option<QrFacts>,
    pub address_class: Option<AddressClass>,
    pub local_address_class: Option<AddressClass>,
    pub same_subnet_24: Option<bool>,
    pub services: Option<ServiceSummary>,
    pub udn_same: Option<bool>,
    pub registration_endpoint_changed: Option<bool>,
    pub services_changed_after_auth: Option<bool>,
    pub route_changed: Option<bool>,
    pub unconfirmed_response: bool,
    pub alive: Option<bool>,
    pub announcements_sent: usize,
    pub consecutive_failures: u8,
    pub recent_delivery: bool,
}

/// Versioned, bounded and safe to forward directly to T7a. No raw wire text.
#[derive(Clone, Debug)]
pub struct PhaseResult {
    pub schema_version: u8,
    pub phase: Phase,
    pub stage: StageResult,
    pub error_code: Option<PureKErrorCode>,
    pub facts: PhaseFacts,
}

impl PhaseResult {
    fn new<T>(
        phase: Phase,
        since: Instant,
        result: &Result<T, PureKError>,
        context: Option<&DeviceContext>,
    ) -> Self {
        let cause = result
            .as_ref()
            .map(|_| ())
            .map_err(|error| error.cause.clone());
        Self {
            schema_version: 1,
            phase,
            stage: StageResult::new(phase.stage(), since, None, &cause),
            error_code: result.as_ref().err().map(|error| error.code),
            facts: PhaseFacts::default(),
        }
        .with_context(context)
    }
    fn with_context(mut self, context: Option<&DeviceContext>) -> Self {
        self.stage.context = context.cloned();
        self
    }
}

#[derive(Debug)]
pub struct PureKOperation<T> {
    pub result: Result<T, PureKError>,
    pub stages: Vec<PhaseResult>,
}

/// Hostname approval is explicit; it never authorizes public DNS results.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AddressApproval {
    #[default]
    LanLiteralOnly,
    ConfirmHostname,
}

#[derive(Clone)]
pub struct PureKClient {
    policy: NetworkPolicy,
    interfaces: Option<Vec<Ipv4Addr>>,
    timeout: Duration,
    retry_interval: Duration,
    route_lookup: fn(Ipv4Addr) -> Result<Ipv4Addr, DlnaError>,
    notify_destination: SocketAddr,
}

impl Default for PureKClient {
    fn default() -> Self {
        Self::new()
    }
}
impl PureKClient {
    pub fn new() -> Self {
        Self {
            policy: NetworkPolicy::Lan,
            interfaces: None,
            timeout: HTTP_TIMEOUT,
            retry_interval: RETRY_INTERVAL,
            route_lookup: super::discovery::system_route_source,
            notify_destination: (Ipv4Addr::new(239, 255, 255, 250), 1900).into(),
        }
    }
    fn interfaces(&self) -> Vec<Ipv4Addr> {
        self.interfaces
            .clone()
            .unwrap_or_else(|| local_ipv4(self.policy))
    }

    pub async fn connect(
        &self,
        raw: &str,
        approval: AddressApproval,
        cancel: &CancellationToken,
    ) -> PureKOperation<Session> {
        let since = Instant::now();
        let parsed = Room::parse_on(raw, self.policy);
        let mut parse = PhaseResult::new(Phase::Parse, since, &parsed, None);
        parse.facts.qr = parsed.as_ref().ok().map(|room| room.facts.clone());
        let room = match parsed {
            Ok(room) => room,
            Err(error) => {
                return PureKOperation {
                    result: Err(error),
                    stages: vec![parse],
                };
            }
        };
        let mut stages = vec![parse];
        let result = self
            .connect_inner(room, approval, cancel, &mut stages)
            .await;
        PureKOperation { result, stages }
    }

    /// S4/self-test fallback: read a QR-directed receiver without registration.
    /// The returned session has no registration and cannot publish NOTIFY.
    pub async fn inspect(
        &self,
        room: Room,
        approval: AddressApproval,
        cancel: &CancellationToken,
    ) -> PureKOperation<Session> {
        let mut stages = Vec::new();
        let result = async {
            let mut session = self.prepare(room, approval, cancel, &mut stages).await?;
            let (description, stage) = session
                .read_description(Phase::DescriptionBefore, cancel)
                .await;
            stages.push(stage);
            session.description = Some(description?);
            Ok(session)
        }
        .await;
        PureKOperation { result, stages }
    }

    async fn prepare(
        &self,
        room: Room,
        approval: AddressApproval,
        cancel: &CancellationToken,
        stages: &mut Vec<PhaseResult>,
    ) -> Result<Session, PureKError> {
        let mut salt = [0; 32];
        getrandom::fill(&mut salt).map_err(|_| {
            PureKError::new(
                PureKErrorCode::Unavailable,
                DlnaError::new(ErrorCode::Unavailable),
            )
        })?;
        let mut context = DeviceContext {
            device_key: salted_hash(&salt, room.description.as_str()),
            udn_hash: None,
            source: DiscoverySource::Manual,
            server: String::new(),
            route: None,
        };
        // Bind the parse record to the same per-attempt, salted diagnostic key.
        if let Some(parse) = stages.first_mut().filter(|step| step.phase == Phase::Parse) {
            parse.stage.context = Some(context.clone());
        }
        let since = Instant::now();
        let resolved = self.resolve(&room, approval, cancel).await;
        let mut stage = PhaseResult::new(Phase::Resolve, since, &resolved, Some(&context));
        stage.facts.address_class = resolved
            .as_ref()
            .ok()
            .and_then(|address| qr::address_class(*address, self.policy));
        stages.push(stage);
        let target = resolved?;
        let since = Instant::now();
        let local = self.route(target, &mut context, cancel);
        stages.push(route_stage(since, &local, target, &context, self.policy));
        let local = local?;
        let original_host = matches!(room.description.host(), Some(url::Host::Domain(_)))
            .then(|| room.description.host_str().unwrap_or_default().to_owned());
        let mut location = room.description.clone();
        // IPv4 pinning also makes the IP the TLS authority. DNS-only HTTPS
        // certificates are unsupported here; hostname-preserving pinning needs
        // coordinated support in this transport and T2 control. Verification
        // remains enabled.
        location.set_host(Some(&target.to_string())).map_err(|_| {
            PureKError::new(
                PureKErrorCode::AddressNotAllowed,
                PolicyError::InvalidUrl.into(),
            )
        })?;
        Ok(Session {
            client: self.clone(),
            room,
            salt,
            context,
            target,
            location,
            original_host,
            local,
            description: None,
            registration: None,
            closed: false,
            health: health::Checks::default(),
            next_announcement: Instant::now() + ANNOUNCE_INTERVAL,
        })
    }

    fn route(
        &self,
        target: Ipv4Addr,
        context: &mut DeviceContext,
        cancel: &CancellationToken,
    ) -> Result<Ipv4Addr, PureKError> {
        cancelled(cancel)?;
        let routed = (self.route_lookup)(target).ok();
        let interfaces = self.interfaces();
        let selected = select_local_source(target, routed, None, &interfaces, self.policy);
        context.route = Some(RouteFacts {
            selection: selected.as_ref().ok().map(|source| source.kind),
            routed_source_is_local: routed.map(|source| {
                dlna_policy::validate_route_source(source, &interfaces, self.policy).is_ok()
            }),
            route_matches_selected: routed
                .zip(selected.as_ref().ok())
                .map(|(route, source)| route == source.address),
            route_matches_reply: None,
        });
        selected
            .map(|source| source.address)
            .map_err(|error| PureKError::new(PureKErrorCode::Route, error.into()))
    }

    async fn resolve(
        &self,
        room: &Room,
        approval: AddressApproval,
        cancel: &CancellationToken,
    ) -> Result<Ipv4Addr, PureKError> {
        cancelled(cancel)?;
        if let Some(url::Host::Ipv4(address)) = room.description.host() {
            return Ok(address);
        }
        if approval != AddressApproval::ConfirmHostname {
            return Err(PureKError::new(
                PureKErrorCode::AddressConfirmationRequired,
                PolicyError::AddressNotAllowed.into(),
            ));
        }
        let host = room.description.host_str().unwrap_or_default();
        let port = room.description.port_or_known_default().unwrap_or(80);
        let addresses = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cancel_error()),
            result = tokio::time::timeout(self.timeout, tokio::net::lookup_host((host, port))) => {
                result.map_err(|_| PureKError::new(PureKErrorCode::Resolve, DlnaError::new(ErrorCode::Timeout)))?
                    .map_err(|_| PureKError::new(PureKErrorCode::Resolve, DlnaError::new(ErrorCode::Connect)))?
                    .map(|address| address.ip()).collect::<Vec<_>>()
            }
        };
        validated_resolution(&addresses, self.policy)
    }
}

fn validated_resolution(
    addresses: &[IpAddr],
    policy: NetworkPolicy,
) -> Result<Ipv4Addr, PureKError> {
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !matches!(address, IpAddr::V4(address) if policy.allows(*address)))
    {
        return Err(PureKError::new(
            PureKErrorCode::AddressNotAllowed,
            PolicyError::AddressNotAllowed.into(),
        ));
    }
    match addresses[0] {
        IpAddr::V4(address) => Ok(address),
        _ => unreachable!(),
    }
}

#[derive(Clone)]
struct Registration {
    endpoint: ServiceEndpoint,
    local: Ipv4Addr,
}

/// Ephemeral I/O lease, owned by the AppState worker; never serialize it.
/// T5 must await [`Session::release`] before dropping an active lease on exit,
/// generation replacement or self-test cancellation. There is no async Drop.
#[must_use = "Run maintain or await release when the admitted worker exits"]
pub struct Session {
    client: PureKClient,
    room: Room,
    salt: [u8; 32],
    context: DeviceContext,
    target: Ipv4Addr,
    location: Url,
    original_host: Option<String>,
    local: Ipv4Addr,
    description: Option<Description>,
    registration: Option<Registration>,
    closed: bool,
    health: health::Checks,
    next_announcement: Instant,
}
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("context", &self.context)
            .field("qr", &self.room.facts)
            .field("registered", &self.registration.is_some())
            .field("closed", &self.closed)
            .finish_non_exhaustive()
    }
}
impl Session {
    pub fn context(&self) -> &DeviceContext {
        &self.context
    }
    pub fn is_registered(&self) -> bool {
        !self.closed && self.registration.is_some()
    }

    /// Raw device endpoints for T2 control only; never forward them to diagnostics.
    pub fn renderer(&self) -> Result<Renderer, DlnaError> {
        if self.closed {
            return Err(DlnaError::new(ErrorCode::Unavailable));
        }
        self.description
            .as_ref()
            .ok_or_else(|| DlnaError::new(ErrorCode::Unavailable))?
            .renderer(self.local, self.context.clone())
    }
    pub fn control_client(&self) -> Result<super::control::ControlClient, DlnaError> {
        super::control::ControlClient::with_policy(
            self.renderer()?,
            &self.client.interfaces(),
            self.client.policy,
            self.client.timeout,
        )
    }

    async fn read_description(
        &mut self,
        phase: Phase,
        cancel: &CancellationToken,
    ) -> (Result<Description, PureKError>, PhaseResult) {
        let since = Instant::now();
        let mut status = None;
        let result = async {
            let client = http_client(self.local, self.client.timeout)
                .map_err(|cause| PureKError::new(PureKErrorCode::Description, cause))?;
            let reply = http_request(
                &client,
                self.location.clone(),
                None,
                dlna_policy::MAX_DESCRIPTION_BYTES,
                cancel,
            )
            .await
            .map_err(|cause| PureKError::new(PureKErrorCode::Description, cause))?;
            status = Some(reply.status);
            if !(200..300).contains(&reply.status) {
                return Err(PureKError::new(
                    PureKErrorCode::Description,
                    DlnaError::new(ErrorCode::HttpStatus).status(reply.status),
                ));
            }
            Description::parse(
                &reply.body,
                &self.location,
                self.original_host.as_deref(),
                self.client.policy,
            )
            .map_err(|cause| {
                PureKError::new(
                    PureKErrorCode::Description,
                    DlnaError::from(cause).status(reply.status),
                )
            })
        }
        .await;
        if let Ok(description) = &result {
            // A changed identity is reported, never silently rebound to the lease.
            if self.context.udn_hash.is_none() {
                self.context.udn_hash = Some(salted_hash(&self.salt, &description.udn));
            }
        }
        let mut stage = PhaseResult::new(phase, since, &result, Some(&self.context));
        stage.stage.http_status = stage.stage.http_status.or(status);
        stage.facts.services = result
            .as_ref()
            .ok()
            .map(|description| description.summary(&self.salt));
        (result, stage)
    }
}

fn salted_hash(salt: &[u8; 32], value: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(salt);
    digest.update(value.as_bytes());
    digest.finalize()[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn cancel_error() -> PureKError {
    PureKError::new(
        PureKErrorCode::Cancelled,
        DlnaError::new(ErrorCode::Cancelled),
    )
}
fn cancelled(cancel: &CancellationToken) -> Result<(), PureKError> {
    if cancel.is_cancelled() {
        Err(cancel_error())
    } else {
        Ok(())
    }
}
fn route_stage(
    since: Instant,
    result: &Result<Ipv4Addr, PureKError>,
    target: Ipv4Addr,
    context: &DeviceContext,
    policy: NetworkPolicy,
) -> PhaseResult {
    let mut stage = PhaseResult::new(Phase::Route, since, result, Some(context));
    stage.facts.address_class = qr::address_class(target, policy);
    stage.facts.local_address_class = result
        .as_ref()
        .ok()
        .and_then(|local| qr::address_class(*local, policy));
    stage.facts.same_subnet_24 = result
        .as_ref()
        .ok()
        .map(|local| local.octets()[..3] == target.octets()[..3]);
    stage
}
