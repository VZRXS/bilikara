//! Ephemeral, one-time KTV assistance under the authoritative AppState lock.
//! Official URLs travel only in explicit, private connection/Host replies.
use super::*;
use crate::app_state::AppState;
use crate::app_state::native_session::NativeSession;
use bilikara_rust::KtvRequestV1;
use serde::Deserialize;
use std::collections::HashMap;

const MAX_CONNECTIONS: usize = 128;
const INVITATION_TTL: Duration = Duration::from_secs(60);
const ASSISTANCE_TTL: Duration = Duration::from_secs(300);
pub(crate) type RegisteredRemote = (String, String, u64);
pub(crate) type InternetPresence = (String, String, Option<RegisteredRemote>);

#[derive(Clone)]
enum Owner {
    Lan(Identity),
    Internet(String, String),
}
#[derive(Clone)]
struct Presence {
    id: String,
    owner: Owner,
    identity: Option<(String, String, u64)>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    PendingRemote,
    PendingHost,
    Accepted,
    AuthorizationPending,
    Connecting,
    Error,
    Completed,
    Declined,
    Canceled,
    Expired,
    Disconnected,
}
impl Phase {
    fn label(self) -> &'static str {
        match self {
            Self::PendingRemote => "pending",
            Self::PendingHost => "approval_pending",
            Self::Accepted => "accepted",
            Self::AuthorizationPending => "authorization_pending",
            Self::Connecting => "connecting",
            Self::Error => "error",
            Self::Completed => "completed",
            Self::Declined => "declined",
            Self::Canceled => "canceled",
            Self::Expired => "expired",
            Self::Disconnected => "disconnected",
        }
    }
    fn active(self) -> bool {
        matches!(
            self,
            Self::PendingRemote
                | Self::PendingHost
                | Self::Accepted
                | Self::AuthorizationPending
                | Self::Connecting
                | Self::Error
        )
    }
}
struct Session {
    id: String,
    connection: String,
    user: String,
    generation: u64,
    room_generation: u64,
    phase: Phase,
    deadline: Instant,
    error: Option<String>,
    replacing: bool,
    resume_candidate: Option<String>,
    // Survives presence removal: only Internet candidates support recovery.
    confidential: bool,
}
#[derive(Clone)]
struct CandidateBinding {
    request: String,
    connection: String,
    host_epoch: String,
    user: String,
    session_generation: u64,
    room_generation: u64,
}
impl CandidateBinding {
    fn new(session: &Session, epoch: &str) -> Self {
        Self {
            request: session.id.clone(),
            connection: session.connection.clone(),
            host_epoch: epoch.into(),
            user: session.user.clone(),
            session_generation: session.generation,
            room_generation: session.room_generation,
        }
    }
    fn matches(&self, session: &Session, epoch: &str) -> bool {
        self.request == session.id
            && self.connection == session.connection
            && self.host_epoch == epoch
            && self.user == session.user
            && self.session_generation == session.generation
            && self.room_generation == session.room_generation
    }
}
struct Candidate {
    id: String,
    origin: CandidateBinding,
    binding: CandidateBinding,
    deadline: Instant,
    recoverable: bool,
}
impl Candidate {
    fn current(&self, epoch: &str, room: &RoomState) -> bool {
        self.origin.host_epoch == epoch
            && self.binding.host_epoch == epoch
            && self.binding.room_generation == room.room_generation
            && room.room.is_some()
            && !room.connected
            && Instant::now() < self.deadline
    }
    fn owned(&self, session: &Session, epoch: &str, room: &RoomState) -> bool {
        !self.recoverable
            && session.phase.active()
            && self.binding.matches(session, epoch)
            && self.current(epoch, room)
    }
}
#[derive(Default)]
pub(crate) struct Assistance {
    connections: HashMap<String, Presence>,
    session: Option<Session>,
    candidate: Option<Candidate>,
    pub(crate) connecting: Option<(u64, String)>,
}
fn error(code: &str) -> ApiError {
    ApiError::new(
        409,
        &format!("ktv_{code}"),
        "KTV assistance request is no longer available",
    )
}
fn random_id() -> Result<String, ApiError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| error("entropy"))?;
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
impl Assistance {
    fn add(&mut self, owner: Owner) -> Result<String, ApiError> {
        if self.connections.len() >= MAX_CONNECTIONS {
            return Err(error("connection_limit"));
        }
        let id = random_id()?;
        self.connections.insert(
            id.clone(),
            Presence {
                id: id.clone(),
                owner,
                identity: None,
            },
        );
        Ok(id)
    }
    fn session_view(&self) -> Value {
        self.session.as_ref().map(|s|json!({"request_id":s.id,"connection_id":s.connection,
            "status":s.phase.label(),"kind":if s.resume_candidate.is_some(){"resume"}else{"scan"},"remaining_seconds":s.deadline.saturating_duration_since(Instant::now()).as_secs(),"error_code":s.error})).unwrap_or(Value::Null)
    }
    pub(crate) fn host_snapshot(&self) -> Value {
        let devices:Vec<_>=self.connections.values().filter_map(|p|p.identity.as_ref().map(|(name,_,_)|
            json!({"connection_id":p.id,"name":name,"transport":if matches!(p.owner,Owner::Lan(_)){"lan"}else{"internet"},"label":&p.id[..6],"scan_eligible":true}))).collect();
        let recovery = self
            .candidate
            .as_ref()
            .filter(|c| c.recoverable && Instant::now() < c.deadline);
        json!({"devices":devices,"session":self.session_view(),"recovery":{"available":recovery.is_some(),"source_label":recovery.map(|c|&c.origin.connection[..6]),"remaining_seconds":recovery.map(|c|c.deadline.saturating_duration_since(Instant::now()).as_secs())}})
    }
    fn private_snapshot(
        &self,
        connection: &str,
        epoch: &str,
        room: &RoomState,
        revision: u64,
    ) -> Value {
        let registered = self
            .connections
            .get(connection)
            .is_some_and(|p| p.identity.is_some());
        let available = !room.connected;
        let secure = self
            .connections
            .get(connection)
            .is_some_and(|p| matches!(p.owner, Owner::Internet(..)));
        let owned = self
            .session
            .as_ref()
            .filter(|s| s.connection == connection)
            .is_some_and(|s| {
                self.candidate
                    .as_ref()
                    .is_some_and(|c| c.owned(s, epoch, room))
            });
        let recovery = secure
            && registered
            && self
                .candidate
                .as_ref()
                .is_some_and(|c| c.recoverable && c.current(epoch, room));
        json!({"connection_id":connection,"host_epoch":epoch,"revision":revision,"confidential":secure,
            "transport":if secure{"internet"}else{"lan"},
            "capabilities":{"scan":registered&&available,"submit":registered&&available,"resume":secure&&registered&&available,"limitation":if !registered{json!("identity_required")}else if !available{json!("receiver_connected")}else{Value::Null}},
            "candidate_owned":owned,"recovery_available":recovery,
            "session":if self.session.as_ref().is_some_and(|s|s.connection==connection){self.session_view()}else{Value::Null},"room":room_status(room,self)})
    }
}
pub(crate) fn room_status(room: &RoomState, assistance: &Assistance) -> Value {
    let recovery = assistance
        .candidate
        .as_ref()
        .is_some_and(|c| c.recoverable && c.binding.room_generation == room.room_generation);
    let status = if room.connected && room.capability_unverified() {
        "capability_unverified"
    } else if room.connected {
        let output = &room.room_snapshot()["output"];
        match output["status"].as_str() {
            Some("unsupported") => "unsupported",
            Some("unverified" | "probing") => "capability_unverified",
            Some("error")
                if !output["last_error"]
                    .as_str()
                    .is_some_and(|code| code.starts_with("purek_output_")) =>
            {
                "capability_unverified"
            }
            Some("error") => "error",
            _ => "connected",
        }
    } else if room.room_busy && room.room.is_some() {
        "connecting"
    } else if room.room_error.is_some() {
        "error"
    } else if room.room.is_some() && !recovery {
        "authorization_pending"
    } else {
        "disconnected"
    };
    // Do not project names, addresses, UDNs, raw SOAP errors or authorization URLs.
    json!({"status":status,"connected":room.connected,"connection_type":room.room.as_ref().map(Room::connection_type)})
}
pub(crate) fn host_snapshot(state: &NativeSession) -> Value {
    let mut value = state.ktv.host_snapshot();
    value["host_epoch"] = json!(state.state_epoch);
    value["revision"] = json!(state.revision);
    let owned = state.ktv.session.as_ref().is_some_and(|session| {
        state
            .ktv
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.owned(session, &state.state_epoch, &state.cast))
    });
    value["candidate_owned"] = json!(owned);
    value["authorization_link_available"] = json!(
        owned
            && state
                .ktv
                .session
                .as_ref()
                .is_some_and(|s| matches!(s.phase, Phase::AuthorizationPending | Phase::Error))
            && state
                .cast
                .room
                .as_ref()
                .is_some_and(|room| room.authorization.is_some())
    );
    value
}
pub(crate) fn open_lan(app: &mut AppState, identity: &Identity) -> Result<String, ApiError> {
    if app.native_authorize(identity, false)? {
        return Err(error("remote_only"));
    }
    let id = app.native().ktv.add(Owner::Lan(identity.clone()))?;
    refresh(app);
    Ok(id)
}
pub(crate) fn close(app: &mut AppState, id: &str) {
    if app.native().ktv.connections.remove(id).is_some() {
        if app
            .native()
            .ktv
            .session
            .as_ref()
            .is_some_and(|s| s.connection == id && s.phase.active())
        {
            retire(app, Phase::Disconnected);
        }
        app.native().revision += 1;
    }
}
fn retire(app: &mut AppState, phase: Phase) {
    let state = app.native();
    if let Some(s) = &state.ktv.session {
        let owns = state
            .ktv
            .candidate
            .as_ref()
            .is_some_and(|c| c.binding.matches(s, &state.state_epoch));
        if owns {
            let keep = phase == Phase::Disconnected
                && s.confidential
                && s.phase != Phase::Connecting
                && !state.cast.room_busy
                && state
                    .ktv
                    .candidate
                    .as_ref()
                    .is_some_and(|c| c.current(&state.state_epoch, &state.cast));
            if keep {
                // This is an explicitly owned, bounded recovery record, not a
                // live authorization capability. Only approve_resume can rebind.
                state.ktv.candidate.as_mut().unwrap().recoverable = true;
                state.cast.room_error = None;
            } else {
                discard_candidate(state);
            }
        }
        let s = state.ktv.session.as_mut().unwrap();
        if s.phase == Phase::Connecting
            && !state.cast.connected
            && state
                .ktv
                .connecting
                .as_ref()
                .is_some_and(|(generation, epoch)| {
                    *generation == state.cast.room_generation && *epoch == state.state_epoch
                })
        {
            if let Some(cancel) = state.cast.connection_cancel.take() {
                cancel.cancel();
            }
            state.cast.room_generation += 1;
        }
        s.phase = phase;
        s.error = None;
        state.revision += 1;
    }
}
/// A room staged by a Remote assistance candidate was never checked or
/// adopted by the Host. When such a candidate still owns the current
/// unconnected room it is discarded together with that room; returns whether
/// this happened. Used before a room-generation change (disconnect) so the
/// Remote's credential can never outlive the candidate that staged it.
pub(crate) fn release_staged_room(state: &mut NativeSession) -> bool {
    let staged = state
        .ktv
        .candidate
        .as_ref()
        .is_some_and(|candidate| candidate.current(&state.state_epoch, &state.cast));
    if staged {
        discard_candidate(state);
        state.revision += 1;
    }
    staged
}

fn discard_candidate(state: &mut NativeSession) {
    let Some(candidate) = state.ktv.candidate.take() else {
        return;
    };
    let owned_io = state
        .ktv
        .connecting
        .as_ref()
        .is_some_and(|(generation, epoch)| {
            *generation == candidate.binding.room_generation
                && *epoch == candidate.binding.host_epoch
        });
    if candidate.binding.host_epoch == state.state_epoch
        && !state.cast.connected
        && state.cast.room_generation == candidate.binding.room_generation
        && (!state.cast.room_busy || owned_io)
    {
        if let Some(cancel) = state.cast.connection_cancel.take() {
            cancel.cancel();
        }
        state.cast.room = None;
        state.cast.room_error = None;
        state.cast.room_generation += 1;
    }
    // Never release busy/connecting here: a retired worker owns its rollback.
}
pub(crate) fn refresh(app: &mut AppState) {
    let peers = app.native_ktv_internet();
    let old: Vec<_> = app.native().ktv.connections.values().cloned().collect();
    for p in old {
        let identity = match &p.owner {
            Owner::Lan(identity) => app.native_ktv_identity(identity),
            Owner::Internet(peer, epoch) => {
                match peers.iter().find(|(id, e, _)| id == peer && e == epoch) {
                    Some((_, _, identity)) => identity.clone(),
                    None => {
                        close(app, &p.id);
                        continue;
                    }
                }
            }
        };
        if app.native().ktv.connections[&p.id].identity != identity {
            app.native()
                .ktv
                .connections
                .get_mut(&p.id)
                .unwrap()
                .identity = identity;
            app.native().revision += 1;
        }
    }
    for (peer, epoch, identity) in peers {
        if !app
            .native()
            .ktv
            .connections
            .values()
            .any(|p| matches!(&p.owner,Owner::Internet(id,e) if *id==peer&&*e==epoch))
            && let Ok(id) = app.native().ktv.add(Owner::Internet(peer, epoch))
        {
            app.native().ktv.connections.get_mut(&id).unwrap().identity = identity;
            app.native().revision += 1;
        }
    }
    let state = app.native();
    let invalid = state
        .ktv
        .session
        .as_ref()
        .filter(|s| s.phase.active())
        .and_then(|s| {
            if Instant::now() >= s.deadline {
                Some(Phase::Expired)
            } else if !state
                .ktv
                .connections
                .get(&s.connection)
                .and_then(|p| p.identity.as_ref())
                .is_some_and(|(_, id, g)| *id == s.user && *g == s.generation)
            {
                Some(Phase::Disconnected)
            } else if !s.replacing && s.room_generation != state.cast.room_generation {
                Some(Phase::Canceled)
            } else {
                None
            }
        });
    if let Some(phase) = invalid {
        retire(app, phase);
    }
    refresh_candidate(app);
}
fn refresh_candidate(app: &mut AppState) {
    let owner = app
        .native()
        .ktv
        .candidate
        .as_ref()
        .map(|c| (c.binding.user.clone(), c.binding.session_generation));
    let valid_user =
        owner.is_some_and(|(id, generation)| app.native_ktv_user_exists(&id, generation));
    let state = app.native();
    let Some(candidate) = &state.ktv.candidate else {
        return;
    };
    if valid_user && candidate.current(&state.state_epoch, &state.cast) {
        return;
    }
    let phase = if Instant::now() >= candidate.deadline {
        Phase::Expired
    } else {
        Phase::Canceled
    };
    let affected = state.ktv.session.as_ref().is_some_and(|s| {
        s.phase.active()
            && (candidate.binding.matches(s, &state.state_epoch)
                || s.resume_candidate.as_ref() == Some(&candidate.id))
    });
    discard_candidate(state);
    if affected {
        let session = state.ktv.session.as_mut().unwrap();
        session.phase = phase;
        session.error = None;
    }
    state.revision += 1;
}
pub(crate) fn connection_frame(app: &mut AppState, id: &str) -> Value {
    refresh(app);
    let state = app.native();
    state
        .ktv
        .private_snapshot(id, &state.state_epoch, &state.cast, state.revision)
}
pub(crate) fn internet_events(app: &mut AppState) -> Value {
    refresh(app);
    let state = app.native();
    json!(state.ktv.connections.values().filter_map(|p|match &p.owner {
        Owner::Internet(peer,epoch)=>Some(json!({"peer_id":peer,"peer_epoch":epoch,"data":state.ktv.private_snapshot(&p.id,&state.state_epoch,&state.cast,state.revision)})),_=>None,
    }).collect::<Vec<_>>())
}
fn start(app: &mut AppState, connection: &str, phase: Phase) -> Result<(), ApiError> {
    refresh(app);
    let state = app.native();
    if state.ktv.session.as_ref().is_some_and(|s| s.phase.active()) {
        return Err(error("busy"));
    }
    if state.cast.connected {
        return Err(error("receiver_connected"));
    }
    let presence = state
        .ktv
        .connections
        .get(connection)
        .ok_or_else(|| error("offline"))?;
    let confidential = matches!(presence.owner, Owner::Internet(..));
    if phase == Phase::PendingRemote && state.cast.room_busy {
        return Err(busy());
    }
    let (_, user, generation) = state
        .ktv
        .connections
        .get(connection)
        .and_then(|p| p.identity.clone())
        .ok_or_else(|| error("offline"))?;
    state.ktv.session = Some(Session {
        id: random_id()?,
        connection: connection.into(),
        user,
        generation,
        room_generation: state.cast.room_generation,
        phase,
        deadline: Instant::now() + INVITATION_TTL,
        error: None,
        replacing: false,
        resume_candidate: None,
        confidential,
    });
    state.revision += 1;
    Ok(())
}
fn permission<'a>(
    app: &'a mut AppState,
    connection: &str,
    binding: (&str, &str),
) -> Result<&'a mut Session, ApiError> {
    refresh(app);
    let state = app.native();
    if binding.1 != state.state_epoch {
        return Err(error("stale"));
    }
    state
        .ktv
        .session
        .as_mut()
        .filter(|s| s.connection == connection && s.id == binding.0 && s.phase.active())
        .ok_or_else(|| error("stale"))
}
fn accept(app: &mut AppState, connection: &str, binding: (&str, &str)) -> Result<(), ApiError> {
    let s = permission(app, connection, binding)?;
    if s.phase != Phase::PendingRemote {
        return Err(error("stale"));
    }
    s.phase = Phase::PendingHost;
    let room = &app.native().cast;
    if !room.connected && !room.room_busy && !room.owns_playback && !room.owns_playback {
        activate_scan(app.native());
    }
    app.native().revision += 1;
    Ok(())
}
fn secure_required() -> ApiError {
    ApiError::new(
        403,
        "ktv_secure_transport_required",
        "Cross-connection candidate recovery requires Internet Remote and a new Host approval",
    )
}
fn activate_scan(state: &mut NativeSession) {
    // Starting a freshly approved scan never inherits a previous candidate.
    discard_candidate(state);
    let session = state.ktv.session.as_mut().unwrap();
    session.room_generation = state.cast.room_generation;
    session.phase = Phase::Accepted;
    session.deadline = Instant::now() + ASSISTANCE_TTL;
}
fn request_resume(app: &mut AppState, connection: &str) -> Result<(), ApiError> {
    refresh(app);
    let candidate = app
        .native()
        .ktv
        .candidate
        .as_ref()
        .filter(|c| c.recoverable)
        .map(|c| c.id.clone())
        .ok_or_else(|| error("resume_unavailable"))?;
    start(app, connection, Phase::PendingHost)?;
    app.native().ktv.session.as_mut().unwrap().resume_candidate = Some(candidate);
    Ok(())
}
fn approve_resume(app: &mut AppState, binding: (&str, &str)) -> Result<Value, ApiError> {
    refresh(app);
    let connection = app
        .native()
        .ktv
        .session
        .as_ref()
        .map(|s| s.connection.clone())
        .ok_or_else(|| error("stale"))?;
    let session = permission(app, &connection, binding)?;
    if session.phase != Phase::PendingHost || session.resume_candidate.is_none() {
        return Err(error("stale"));
    }
    let state = app.native();
    if state.cast.room_busy || state.cast.connected || state.cast.owns_playback {
        return Err(busy());
    }
    let candidate = state
        .ktv
        .candidate
        .as_ref()
        .filter(|c| {
            c.recoverable
                && Some(&c.id)
                    == state
                        .ktv
                        .session
                        .as_ref()
                        .unwrap()
                        .resume_candidate
                        .as_ref()
                && c.current(&state.state_epoch, &state.cast)
        })
        .ok_or_else(|| error("resume_unavailable"))?;
    let deadline = candidate.deadline;
    state.cast.room_generation += 1;
    let session = state.ktv.session.as_mut().unwrap();
    session.room_generation = state.cast.room_generation;
    session.phase = Phase::AuthorizationPending;
    session.deadline = deadline.min(Instant::now() + ASSISTANCE_TTL);
    let new_binding = CandidateBinding::new(session, &state.state_epoch);
    let candidate = state.ktv.candidate.as_mut().unwrap();
    candidate.binding = new_binding;
    candidate.recoverable = false;
    state.revision += 1;
    Ok(host_snapshot(state))
}
#[derive(Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
enum HostRequest {
    #[serde(rename = "authorization_link")]
    AuthorizationLink {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "check")]
    Check {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "invite")]
    Invite { connection_id: String },
    #[serde(rename = "approve")]
    Approve {
        request_id: String,
        host_epoch: String,
        #[serde(default)]
        replace_connected: bool,
    },
    #[serde(rename = "approve_resume")]
    ApproveResume {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "decline")]
    Decline {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "cancel")]
    Cancel {
        request_id: String,
        host_epoch: String,
    },
}
pub(crate) fn host_route(
    context: &Arc<HostContext>,
    identity: &Identity,
    method: &Method,
    body: &Value,
) -> Result<Value, ApiError> {
    with_app(|app| app.native_authorize(identity, true))?;
    if method == Method::GET {
        return with_app(|app| {
            refresh(app);
            Ok(host_snapshot(app.native()))
        });
    }
    if method != Method::POST {
        return Err(ApiError::invalid("KTV commands require POST"));
    }
    let request: HostRequest = serde_json::from_value(body.clone())
        .map_err(|_| ApiError::invalid("Invalid KTV Host command"))?;
    if let HostRequest::AuthorizationLink {
        request_id,
        host_epoch,
    } = request
    {
        return with_app(|app| {
            host_candidate_connection(app, (&request_id, &host_epoch))?;
            let authorization = app
                .native()
                .cast
                .room
                .as_ref()
                .and_then(|room| room.authorization.as_ref())
                .ok_or_else(|| error("scan_required"))?;
            // Read-only: no deadline renewal, receiver I/O, event or persistence.
            Ok(json!({"authorization_url":authorization.authorization_url()}))
        });
    }
    if let HostRequest::Check {
        request_id,
        host_epoch,
    } = request
    {
        let connection =
            with_app(|app| host_candidate_connection(app, (&request_id, &host_epoch)))?;
        super::assisted_connect(context, &connection, (&request_id, &host_epoch))?;
        return with_app(|app| {
            refresh(app);
            Ok(host_snapshot(app.native()))
        });
    }
    if let HostRequest::ApproveResume {
        request_id,
        host_epoch,
    } = request
    {
        return with_app(|app| approve_resume(app, (&request_id, &host_epoch)));
    }
    if let HostRequest::Approve {
        request_id,
        host_epoch,
        replace_connected,
    } = request
    {
        let disconnect = with_app(|app| {
            refresh(app);
            let connection = app
                .native()
                .ktv
                .session
                .as_ref()
                .map(|s| s.connection.clone())
                .ok_or_else(|| error("stale"))?;
            let s = permission(app, &connection, (&request_id, &host_epoch))?;
            if s.phase != Phase::PendingHost {
                return Err(error("stale"));
            }
            if s.resume_candidate.is_some() {
                return Err(error("confirmation_required"));
            }
            if app.native().cast.room_busy {
                return Err(busy());
            }
            let room = &app.native().cast;
            let disconnect = room.connected || room.owns_playback;
            if disconnect && !replace_connected {
                return Err(error("confirmation_required"));
            }
            app.native().ktv.session.as_mut().unwrap().replacing = disconnect;
            Ok(disconnect)
        })?;
        if disconnect
            && let Err(error) = super::super::cast_session::route(
                context,
                identity,
                &Method::POST,
                "/api/cast/disconnect",
                &json!({}),
            )
        {
            with_app(|app| {
                retire(app, Phase::Canceled);
                Ok(())
            })?;
            return Err(error);
        }
        if disconnect {
            // T9 release owns a three-second budget; leave time for publication.
            let deadline = Instant::now() + Duration::from_secs(4);
            while with_app(|app| {
                Ok(app.native().cast.owns_playback
                    || app.native().cast.connected
                    || app.native().cast.pending.is_some())
            })? {
                if Instant::now() >= deadline {
                    return Err(busy());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        return with_app(|app| {
            // The safe disconnect advances the room generation; only this
            // explicit approval may rebase the still-pending grant afterward.
            let state = app.native();
            let s = state
                .ktv
                .session
                .as_mut()
                .filter(|s| {
                    s.id == request_id
                        && s.phase == Phase::PendingHost
                        && state.state_epoch == host_epoch
                })
                .ok_or_else(|| error("stale"))?;
            s.room_generation = state.cast.room_generation;
            s.replacing = false;
            refresh(app);
            let state = app.native();
            state
                .ktv
                .session
                .as_mut()
                .filter(|s| s.phase == Phase::PendingHost)
                .ok_or_else(|| error("stale"))?;
            activate_scan(state);
            state.revision += 1;
            Ok(host_snapshot(state))
        });
    }
    with_app(|app| {
        match request {
            HostRequest::Invite { connection_id } => {
                start(app, &connection_id, Phase::PendingRemote)?
            }
            HostRequest::Cancel {
                request_id,
                host_epoch,
            }
            | HostRequest::Decline {
                request_id,
                host_epoch,
            } => {
                let id = app
                    .native()
                    .ktv
                    .session
                    .as_ref()
                    .map(|s| s.connection.clone())
                    .ok_or_else(|| error("stale"))?;
                permission(app, &id, (&request_id, &host_epoch))?;
                retire(
                    app,
                    if body["operation"] == "decline" {
                        Phase::Declined
                    } else {
                        Phase::Canceled
                    },
                );
            }
            HostRequest::Approve { .. }
            | HostRequest::ApproveResume { .. }
            | HostRequest::AuthorizationLink { .. }
            | HostRequest::Check { .. } => unreachable!(),
        }
        Ok(host_snapshot(app.native()))
    })
}
fn host_candidate_connection(
    app: &mut AppState,
    binding: (&str, &str),
) -> Result<String, ApiError> {
    refresh(app);
    let connection = app
        .native()
        .ktv
        .session
        .as_ref()
        .map(|session| session.connection.clone())
        .ok_or_else(|| error("stale"))?;
    validate_check(app, &connection, binding)?;
    Ok(connection)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LanRequest {
    connection_id: String,
    request: KtvRequestV1,
}
pub(crate) fn lan_route(
    context: &Arc<HostContext>,
    identity: &Identity,
    body: &Value,
) -> Result<Value, ApiError> {
    let request: LanRequest = serde_json::from_value(body.clone())
        .map_err(|_| ApiError::invalid("Invalid KTV assistance request"))?;
    with_app(|app| {
        refresh(app);
        if !app
            .native()
            .ktv
            .connections
            .get(&request.connection_id)
            .is_some_and(|p| matches!(&p.owner,Owner::Lan(owner) if owner.token==identity.token))
        {
            return Err(error("offline"));
        }
        Ok(())
    })?;
    remote(context, &request.connection_id, request.request, false)
}
pub(crate) fn bind_internet(app: &mut AppState, peer: &str) -> Result<String, ApiError> {
    refresh(app);
    app.native()
        .ktv
        .connections
        .values()
        .find(|p| matches!(&p.owner,Owner::Internet(id,_) if id==peer))
        .map(|p| p.id.clone())
        .ok_or_else(|| error("offline"))
}
pub(crate) fn internet(
    context: &Arc<HostContext>,
    peer: &str,
    connection: &str,
    request: KtvRequestV1,
) -> Result<Value, ApiError> {
    let id = with_app(|app| {
        let id = bind_internet(app, peer)?;
        if id != connection {
            return Err(error("stale"));
        }
        Ok(id)
    })?;
    remote(context, &id, request, true)
}
fn remote(
    context: &Arc<HostContext>,
    connection: &str,
    request: KtvRequestV1,
    confidential: bool,
) -> Result<Value, ApiError> {
    if !request.valid() {
        return Err(ApiError::invalid("Invalid KTV assistance request"));
    }
    if !confidential && matches!(request, KtvRequestV1::Resume {}) {
        return Err(secure_required());
    }
    if matches!(request, KtvRequestV1::Check { .. }) {
        let binding = request.binding().unwrap();
        return super::assisted_connect(context, connection, binding);
    }
    with_app(|app| {
        refresh(app);
        if !matches!(request, KtvRequestV1::Status {})
            && app
                .native()
                .ktv
                .connections
                .get(connection)
                .and_then(|p| p.identity.as_ref())
                .is_none()
        {
            return Err(error("identity_required"));
        }
        match &request {
            KtvRequestV1::Status {} => {}
            KtvRequestV1::Request {} => start(app, connection, Phase::PendingHost)?,
            KtvRequestV1::Resume {} => request_resume(app, connection)?,
            KtvRequestV1::Link { .. } => {
                validate_check(app, connection, request.binding().unwrap())?;
                let state = app.native();
                return Ok(json!({"authorization_url":state.cast.room.as_ref()
                    .and_then(Room::authorization_url)}));
            }
            KtvRequestV1::Accept { .. } => {
                accept(app, connection, request.binding().unwrap())?;
            }
            KtvRequestV1::Decline { .. } | KtvRequestV1::Cancel { .. } => {
                permission(app, connection, request.binding().unwrap())?;
                retire(
                    app,
                    if matches!(request, KtvRequestV1::Decline { .. }) {
                        Phase::Declined
                    } else {
                        Phase::Canceled
                    },
                );
            }
            KtvRequestV1::Submit { url, .. } => {
                return stage_candidate(app, connection, request.binding().unwrap(), url);
            }
            KtvRequestV1::Check { .. } => unreachable!(),
        }
        let state = app.native();
        Ok(state
            .ktv
            .private_snapshot(connection, &state.state_epoch, &state.cast, state.revision))
    })
}
fn stage_candidate(
    app: &mut AppState,
    connection: &str,
    binding: (&str, &str),
    url: &str,
) -> Result<Value, ApiError> {
    if permission(app, connection, binding)?.phase != Phase::Accepted {
        return Err(error("stale"));
    }
    let room = Room::from_input(url)?;
    let candidate_id = random_id()?;
    let state = app.native();
    if state.cast.connected || state.cast.room_busy || state.cast.owns_playback {
        return Err(busy());
    }
    let authorization = room.authorization_url().map(str::to_owned);
    state.cast.room_generation += 1;
    state.cast.room_error = None;
    state.cast.room = Some(room);
    let session = state.ktv.session.as_mut().unwrap();
    session.room_generation = state.cast.room_generation;
    session.phase = Phase::AuthorizationPending;
    let owner = CandidateBinding::new(session, &state.state_epoch);
    state.ktv.candidate = Some(Candidate {
        id: candidate_id,
        origin: owner.clone(),
        binding: owner,
        deadline: session.deadline,
        recoverable: false,
    });
    state.revision += 1;
    let mut value =
        state
            .ktv
            .private_snapshot(connection, &state.state_epoch, &state.cast, state.revision);
    value["authorization_url"] = json!(authorization);
    Ok(value)
}
pub(super) fn validate_check(
    app: &mut AppState,
    connection: &str,
    binding: (&str, &str),
) -> Result<(), ApiError> {
    let s = permission(app, connection, binding)?;
    if s.phase == Phase::Accepted {
        return Err(error("scan_required"));
    }
    if !matches!(s.phase, Phase::AuthorizationPending | Phase::Error) {
        return Err(error("stale"));
    }
    validate_candidate(app, connection)
}
fn validate_candidate(app: &mut AppState, connection: &str) -> Result<(), ApiError> {
    let state = app.native();
    if state
        .ktv
        .session
        .as_ref()
        .filter(|s| s.connection == connection)
        .is_some_and(|s| {
            state
                .ktv
                .candidate
                .as_ref()
                .is_some_and(|c| c.owned(s, &state.state_epoch, &state.cast))
        })
    {
        Ok(())
    } else {
        Err(error("scan_required"))
    }
}
pub(super) fn begin_check(
    app: &mut AppState,
    connection: &str,
    binding: (&str, &str),
) -> Result<(), ApiError> {
    validate_check(app, connection, binding)?;
    let state = app.native();
    let s = state.ktv.session.as_mut().unwrap();
    s.phase = Phase::Connecting;
    s.error = None;
    state.cast.room_error = None;
    s.room_generation = state.cast.room_generation + 1;
    state
        .ktv
        .candidate
        .as_mut()
        .unwrap()
        .binding
        .room_generation = s.room_generation;
    state.revision += 1;
    Ok(())
}
pub(crate) fn check_current(
    app: &mut AppState,
    connection: &str,
    binding: (&str, &str),
) -> Result<(), ApiError> {
    if permission(app, connection, binding)?.phase != Phase::Connecting {
        return Err(error("stale"));
    }
    validate_candidate(app, connection)
}
pub(crate) fn checked(
    app: &mut AppState,
    connection: &str,
    success: bool,
    code: Option<String>,
) -> Value {
    let state = app.native();
    if let Some(s) = state
        .ktv
        .session
        .as_mut()
        .filter(|s| s.connection == connection && s.phase == Phase::Connecting)
    {
        s.phase = if success {
            Phase::Completed
        } else {
            Phase::Error
        };
        s.error = code;
        if success {
            // The connected receiver is now owned by RoomState, not a staged
            // assistance candidate. Retiring a grant must not disconnect it.
            state.ktv.candidate = None;
        }
        state.revision += 1;
    }
    state
        .ktv
        .private_snapshot(connection, &state.state_epoch, &state.cast, state.revision)
}
pub(crate) fn release_io(app: &mut AppState, generation: u64, epoch: &str) {
    let state = app.native();
    if state.state_epoch == epoch
        && state
            .ktv
            .connecting
            .as_ref()
            .is_some_and(|(g, e)| *g == generation && e == epoch)
    {
        state.ktv.connecting = None;
        state.cast.connection_cancel = None;
        state.cast.room_busy = false;
        state.revision += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_state::{AppStateRequest, AppStateSeed};
    fn setup() -> AppState {
        let mut app = AppState::default();
        let seed:AppStateSeed=serde_json::from_value(json!({"session_users":["Alice"],"session_started_at":1.0,"session_played_file":"native.json","updated_at":1.0})).unwrap();
        app.native_execute(AppStateRequest::Initialize {
            schema_version: 1,
            state: Box::new(seed),
        })
        .unwrap();
        app.native().state_epoch = "host-epoch".into();
        app
    }
    fn lan(app: &mut AppState, token: &str, registered: bool) -> (Identity, String) {
        let token = app.native_join_remote("", token.into()).unwrap();
        let identity = Identity {
            token,
            loopback: false,
            client: "fixture-tab".into(),
        };
        if registered {
            app.native_register(&identity, &json!({"name":"Alice","claim":true}), false, 2.0)
                .unwrap();
        }
        let id = open_lan(app, &identity).unwrap();
        (identity, id)
    }
    fn secure(app: &mut AppState, peer: &str) -> String {
        app.native_execute(AppStateRequest::OpenInternetRemotePeer {
            schema_version: 1,
            peer_id: peer.into(),
            epoch: "abcdefghijklmnopqrstuv".into(),
            profile: bilikara_rust::RemoteProfile::Controller,
        })
        .unwrap();
        app.native_execute(AppStateRequest::DispatchInternetRemoteMessage{schema_version:1,peer_id:peer.into(),lane:bilikara_rust::RemoteLane::Control,
            message:json!({"v":1,"lane":"control","epoch":"abcdefghijklmnopqrstuv","seq":1,"id":"123e4567-e89b-42d3-a456-426614174000","kind":"session.set_identity","body":{"name":"Alice"}}).to_string(),reset_av_delay:false,now:3.0}).unwrap();
        bind_internet(app, peer).unwrap()
    }
    fn staged(app: &mut AppState, id: &str) -> String {
        staged_url(app, id, "http://192.168.1.8/description.xml")
    }
    fn staged_url(app: &mut AppState, id: &str, url: &str) -> String {
        start(app, id, Phase::PendingRemote).unwrap();
        let request = app.native().ktv.session.as_ref().unwrap().id.clone();
        accept(app, id, (&request, "host-epoch")).unwrap();
        stage_candidate(app, id, (&request, "host-epoch"), url).unwrap();
        request
    }
    #[test]
    fn host_handoff_remains_bound_and_never_renews_the_candidate() {
        let mut inner = Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
        inner.query_pairs_mut().extend_pairs([
            ("url", "http://192.168.1.8"),
            ("token", "synthetic-handoff-token"),
            ("name", "Fixture room"),
        ]);
        let mut official = Url::parse("https://wx.chunk.cn/projection/login").unwrap();
        official
            .query_pairs_mut()
            .append_pair("place_code", "fixture");
        official.query_pairs_mut().append_pair(
            "projection_url",
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(inner.as_str()),
        );
        for internet in [false, true] {
            for invalidation in ["expiry", "epoch", "generation"] {
                let mut app = setup();
                let id = if internet {
                    secure(&mut app, "phone")
                } else {
                    lan(&mut app, "phone", true).1
                };
                let request = staged_url(&mut app, &id, official.as_str());
                let deadline = app.native().ktv.candidate.as_ref().unwrap().deadline;
                assert_eq!(
                    host_candidate_connection(&mut app, (&request, "host-epoch")).unwrap(),
                    id
                );
                assert!(host_candidate_connection(&mut app, (&request, "obsolete")).is_err());
                assert!(host_candidate_connection(&mut app, ("obsolete", "host-epoch")).is_err());
                assert_eq!(
                    app.native().ktv.candidate.as_ref().unwrap().deadline,
                    deadline
                );
                let view = host_snapshot(app.native());
                assert_eq!(view["authorization_link_available"], true);
                assert!(!view.to_string().contains("projection_url"));
                match invalidation {
                    "expiry" => {
                        app.native().ktv.candidate.as_mut().unwrap().deadline = Instant::now()
                    }
                    "epoch" => app.native().state_epoch = "new-host".into(),
                    "generation" => app.native().cast.room_generation += 1,
                    _ => unreachable!(),
                }
                assert_eq!(
                    host_snapshot(app.native())["authorization_link_available"],
                    false
                );
                assert!(host_candidate_connection(&mut app, (&request, "host-epoch")).is_err());
            }
        }
    }
    #[test]
    fn same_device_tabs_and_same_username_have_distinct_targeted_presence() {
        let mut app = setup();
        let (identity, first) = lan(&mut app, "first", true);
        let second = open_lan(&mut app, &identity).unwrap();
        let (_, third) = lan(&mut app, "third", true);
        let (_, unregistered) = lan(&mut app, "unregistered", false);
        assert_ne!(first, second);
        assert_ne!(second, third);
        assert_eq!(
            app.native().ktv.host_snapshot()["devices"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert!(start(&mut app, &unregistered, Phase::PendingRemote).is_err());
        let target = second.clone();
        start(&mut app, &target, Phase::PendingRemote).unwrap();
        assert_eq!(
            connection_frame(&mut app, &target)["session"]["status"],
            "pending"
        );
        assert!(connection_frame(&mut app, &third)["session"].is_null());
        assert_eq!(
            connection_frame(&mut app, &second)["capabilities"]["scan"],
            true
        );
        assert!(connection_frame(&mut app, &first)["session"].is_null());
        assert!(connection_frame(&mut app, &third)["session"].is_null());
        let public = app.native_snapshot(false).unwrap().to_string();
        assert!(!public.contains(&app.native().ktv.session.as_ref().unwrap().id));
        assert!(!public.contains("connection_id"));
        assert!(!public.contains("ktv_assistance"));
        close(&mut app, &first);
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::PendingRemote
        );
        close(&mut app, &target);
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::Disconnected
        );
    }
    #[test]
    fn lan_permission_is_independent_of_confidentiality_and_disconnect_discards_candidate() {
        let mut app = setup();
        let (_, id) = lan(&mut app, "phone", true);
        let (_, stranger) = lan(&mut app, "other", true);
        let (_, guest) = lan(&mut app, "guest", false);
        let view = connection_frame(&mut app, &id);
        assert_eq!(view["confidential"], false);
        assert_eq!(view["capabilities"]["scan"], true);
        assert_eq!(view["capabilities"]["submit"], true);
        assert_eq!(view["capabilities"]["resume"], false);
        assert_eq!(
            connection_frame(&mut app, &guest)["capabilities"]["scan"],
            false
        );
        start(&mut app, &id, Phase::PendingHost).unwrap();
        let request = app.native().ktv.session.as_ref().unwrap().id.clone();
        assert!(
            stage_candidate(
                &mut app,
                &id,
                (&request, "host-epoch"),
                "http://192.168.1.8/a.xml"
            )
            .is_err()
        );
        assert!(accept(&mut app, &stranger, (&request, "host-epoch")).is_err());
        retire(&mut app, Phase::Canceled);
        let request = staged(&mut app, &id);
        assert!(validate_check(&mut app, &stranger, (&request, "host-epoch")).is_err());
        app.native().ktv.session.as_mut().unwrap().deadline = Instant::now();
        assert!(validate_check(&mut app, &id, (&request, "host-epoch")).is_err());
        assert!(app.native().cast.room.is_none());
        staged(&mut app, &id);
        close(&mut app, &id);
        assert!(app.native().ktv.candidate.is_none());
        assert!(app.native().cast.room.is_none());
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::Disconnected
        );
        assert!(request_resume(&mut app, &stranger).is_err());
    }
    #[test]
    fn connected_receiver_closes_new_scan_grants_until_host_disconnects() {
        let mut app = setup();
        let (_, lan_id) = lan(&mut app, "phone", true);
        let internet_id = secure(&mut app, "internet-phone");
        let room = Room::from_input("http://192.168.1.8/description.xml").unwrap();
        app.native().cast.connected = true;
        app.native().cast.room = Some(room);
        for id in [&lan_id, &internet_id] {
            let view = connection_frame(&mut app, id);
            assert_eq!(view["room"]["connected"], true);
            assert_eq!(view["capabilities"]["scan"], false);
            assert_eq!(view["capabilities"]["submit"], false);
            assert_eq!(view["capabilities"]["resume"], false);
            assert_eq!(
                start(&mut app, id, Phase::PendingHost).unwrap_err().code,
                "ktv_receiver_connected"
            );
            assert_eq!(
                start(&mut app, id, Phase::PendingRemote).unwrap_err().code,
                "ktv_receiver_connected"
            );
        }
        app.native().cast.connected = false;
        for id in [&lan_id, &internet_id] {
            assert_eq!(connection_frame(&mut app, id)["capabilities"]["scan"], true);
        }
        start(&mut app, &lan_id, Phase::PendingHost).unwrap();
    }
    #[test]
    fn acceptance_is_one_time_and_has_a_separate_bounded_session_deadline() {
        let mut app = setup();
        let id = secure(&mut app, "phone");
        start(&mut app, &id, Phase::PendingRemote).unwrap();
        let request = app.native().ktv.session.as_ref().unwrap().id.clone();
        assert!(
            app.native().ktv.session.as_ref().unwrap().deadline <= Instant::now() + INVITATION_TTL
        );
        assert!(start(&mut app, &id, Phase::PendingRemote).is_err());
        assert!(accept(&mut app, &id, (&request, "another-host")).is_err());
        accept(&mut app, &id, (&request, "host-epoch")).unwrap();
        assert!(
            app.native().ktv.session.as_ref().unwrap().deadline
                > Instant::now() + Duration::from_secs(290)
        );
        assert!(accept(&mut app, &id, (&request, "host-epoch")).is_err());
        app.native().ktv.session.as_mut().unwrap().deadline =
            Instant::now() - Duration::from_secs(1);
        assert!(permission(&mut app, &id, (&request, "host-epoch")).is_err());
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::Expired
        );
        // A failed/waiting TV output can still own playback after connection
        // loss. Accepting an invitation must request explicit Host replacement.
        app.native().cast.owns_playback = true;
        start(&mut app, &id, Phase::PendingRemote).unwrap();
        let request = app.native().ktv.session.as_ref().unwrap().id.clone();
        accept(&mut app, &id, (&request, "host-epoch")).unwrap();
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::PendingHost
        );
        assert!(validate_check(&mut app, &id, (&request, "host-epoch")).is_err());
    }
    #[test]
    fn canceled_network_work_holds_io_lease_until_rollback_and_never_clears_a_new_host_lease() {
        let mut app = setup();
        let id = secure(&mut app, "phone");
        let request = staged(&mut app, &id);
        begin_check(&mut app, &id, (&request, "host-epoch")).unwrap();
        app.native().cast.room_generation += 1;
        app.native().cast.room_busy = true;
        let g = app.native().cast.room_generation;
        app.native().ktv.connecting = Some((g, "host-epoch".into()));
        let cancel = crate::dlna::CancellationToken::new();
        app.native().cast.connection_cancel = Some(cancel.clone());
        retire(&mut app, Phase::Canceled);
        assert!(
            cancel.is_cancelled(),
            "retiring the grant cancels its T9 registration"
        );
        assert!(app.native().ktv.candidate.is_none());
        assert!(app.native().cast.room.is_none());
        assert!(check_current(&mut app, &id, (&request, "host-epoch")).is_err());
        assert!(
            app.native().cast.room_busy,
            "no new receiver registration may race the retired rollback"
        );
        release_io(&mut app, g, "other-epoch");
        assert!(app.native().cast.room_busy);
        release_io(&mut app, g, "host-epoch");
        assert!(!app.native().cast.room_busy);
        assert!(!app.native().cast.connected);
    }
    #[test]
    fn room_generation_change_or_restart_revokes_the_old_permission() {
        let mut app = setup();
        let id = secure(&mut app, "phone");
        let request = staged(&mut app, &id);
        app.native().cast.room_generation += 1;
        app.native().cast.room = Some(Room::dlna("http://192.168.1.9/new.xml").unwrap());
        refresh(&mut app);
        assert!(app.native().ktv.candidate.is_none());
        assert_eq!(
            app.native()
                .cast
                .room
                .as_ref()
                .unwrap()
                .description
                .as_str(),
            "http://192.168.1.9/new.xml"
        );
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::Canceled
        );
        let mut restarted = setup();
        let replacement = secure(&mut restarted, "phone");
        assert_ne!(id, replacement);
        assert!(permission(&mut restarted, &id, (&request, "host-epoch")).is_err());
        let state = restarted.native();
        assert_eq!(
            room_status(&state.cast, &state.ktv)["status"],
            "disconnected"
        );
    }
    #[test]
    fn internet_presence_requires_identity_and_excludes_viewers_and_retired_epochs() {
        let mut app = setup();
        for (peer, profile) in [
            ("one", bilikara_rust::RemoteProfile::Controller),
            ("two", bilikara_rust::RemoteProfile::Controller),
            ("viewer", bilikara_rust::RemoteProfile::Viewer),
        ] {
            app.native_execute(AppStateRequest::OpenInternetRemotePeer {
                schema_version: 1,
                peer_id: peer.into(),
                epoch: "abcdefghijklmnopqrstuv".into(),
                profile,
            })
            .unwrap();
            if peer != "viewer" {
                app.native_execute(AppStateRequest::DispatchInternetRemoteMessage{schema_version:1,peer_id:peer.into(),lane:bilikara_rust::RemoteLane::Control,message:json!({"v":1,"lane":"control","epoch":"abcdefghijklmnopqrstuv","seq":1,"id":"123e4567-e89b-42d3-a456-426614174000","kind":"session.set_identity","body":{"name":"Alice"}}).to_string(),reset_av_delay:false,now:3.0}).unwrap();
            }
        }
        refresh(&mut app);
        let devices = app.native().ktv.host_snapshot()["devices"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(devices.len(), 2);
        assert!(
            devices
                .iter()
                .all(|p| p["name"] == "Alice" && p["transport"] == "internet")
        );
        let one = bind_internet(&mut app, "one").unwrap();
        start(&mut app, &one, Phase::Accepted).unwrap();
        app.native_execute(AppStateRequest::CloseInternetRemotePeer {
            schema_version: 1,
            peer_id: "one".into(),
        })
        .unwrap();
        refresh(&mut app);
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::Disconnected
        );
        assert!(bind_internet(&mut app, "one").is_err());
        assert!(bind_internet(&mut app, "two").is_ok());
        assert!(bind_internet(&mut app, "viewer").is_err());
    }
    #[test]
    fn connection_table_is_bounded_and_shared_status_never_projects_room_urls_or_tokens() {
        let mut app = setup();
        let (identity, _) = lan(&mut app, "phone", true);
        for _ in 1..MAX_CONNECTIONS {
            open_lan(&mut app, &identity).unwrap();
        }
        assert_eq!(
            open_lan(&mut app, &identity).unwrap_err().code,
            "ktv_connection_limit"
        );
        let inner = "https://conn.dolphinstar.cn/Remote?url=http%3A%2F%2F192.168.1.8&token=private-credential&name=Private";
        let raw = format!(
            "https://wx.chunk.cn/projection/login?place_code=fixture&projection_url={}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(inner)
        );
        app.native().cast.room = Some(Room::parse(&raw).unwrap());
        let public = app.native_snapshot(false).unwrap().to_string();
        for private in [
            "wx.chunk.cn",
            "projection_url",
            "private-credential",
            "192.168.1.8",
            "Private",
        ] {
            assert!(!public.contains(private));
        }
        let state = app.native();
        assert_eq!(
            room_status(&state.cast, &state.ktv)["status"],
            "authorization_pending"
        );
    }
    #[test]
    fn canceled_candidate_cannot_be_inherited_by_a_same_user_tab_or_fresh_scan_grant() {
        let mut app = setup();
        let a = secure(&mut app, "tab-a");
        let b = secure(&mut app, "tab-b");
        let original = staged(&mut app, &a);
        let room_generation = app.native().cast.room_generation;
        let candidate = app.native().ktv.candidate.as_ref().unwrap();
        assert_eq!(candidate.origin.request, original);
        assert_eq!(candidate.origin.connection, a);
        assert_eq!(candidate.origin.host_epoch, "host-epoch");
        assert_eq!(candidate.origin.room_generation, room_generation);
        assert!(validate_check(&mut app, &b, (&original, "host-epoch")).is_err());
        retire(&mut app, Phase::Canceled);
        assert!(app.native().cast.room.is_none());
        assert!(app.native().ktv.candidate.is_none());
        start(&mut app, &b, Phase::PendingRemote).unwrap();
        let next = app.native().ktv.session.as_ref().unwrap().id.clone();
        accept(&mut app, &b, (&next, "host-epoch")).unwrap();
        assert_eq!(
            validate_check(&mut app, &b, (&next, "host-epoch"))
                .unwrap_err()
                .code,
            "ktv_scan_required"
        );
        assert!(request_resume(&mut app, &b).is_err());
    }
    #[test]
    fn disconnected_candidate_requires_separate_host_resume_and_never_extends_its_deadline() {
        let mut app = setup();
        let a = secure(&mut app, "tab-a");
        let b = secure(&mut app, "tab-b");
        let original = staged(&mut app, &a);
        let deadline = app.native().ktv.candidate.as_ref().unwrap().deadline;
        retire(&mut app, Phase::Disconnected);
        assert!(app.native().ktv.candidate.as_ref().unwrap().recoverable);
        assert!(validate_check(&mut app, &a, (&original, "host-epoch")).is_err());
        assert_eq!(
            connection_frame(&mut app, &b)["room"]["status"],
            "disconnected"
        );
        assert_eq!(connection_frame(&mut app, &b)["candidate_owned"], false);
        request_resume(&mut app, &b).unwrap();
        let next = app.native().ktv.session.as_ref().unwrap().id.clone();
        assert!(validate_check(&mut app, &b, (&next, "host-epoch")).is_err());
        approve_resume(&mut app, (&next, "host-epoch")).unwrap();
        validate_check(&mut app, &b, (&next, "host-epoch")).unwrap();
        let candidate = app.native().ktv.candidate.as_ref().unwrap();
        assert_eq!(candidate.origin.request, original);
        assert_eq!(candidate.origin.connection, a);
        assert_eq!(candidate.binding.connection, b);
        assert_eq!(candidate.binding.request, next);
        assert_eq!(candidate.deadline, deadline);
        assert!(app.native().ktv.session.as_ref().unwrap().deadline <= deadline);
    }
    #[test]
    fn candidate_expiry_and_generation_change_clear_only_the_owned_staged_room() {
        let mut app = setup();
        let id = secure(&mut app, "phone");
        staged(&mut app, &id);
        app.native().ktv.candidate.as_mut().unwrap().deadline =
            Instant::now() - Duration::from_secs(1);
        refresh(&mut app);
        assert!(app.native().cast.room.is_none());
        assert!(app.native().ktv.candidate.is_none());
        assert_eq!(
            app.native().ktv.session.as_ref().unwrap().phase,
            Phase::Expired
        );
        staged(&mut app, &id);
        retire(&mut app, Phase::Disconnected);
        request_resume(&mut app, &id).unwrap();
        let request = app.native().ktv.session.as_ref().unwrap().id.clone();
        app.native().cast.room_generation += 1;
        app.native().cast.room = Some(Room::dlna("http://192.168.1.9/host-owned.xml").unwrap());
        refresh(&mut app);
        assert!(approve_resume(&mut app, (&request, "host-epoch")).is_err());
        assert_eq!(
            app.native()
                .cast
                .room
                .as_ref()
                .unwrap()
                .description
                .as_str(),
            "http://192.168.1.9/host-owned.xml"
        );
    }
    fn purek_qr() -> String {
        let mut inner = Url::parse("https://conn.dolphinstar.cn/Remote").unwrap();
        inner.query_pairs_mut().extend_pairs([
            ("url", "http://192.168.1.8"),
            ("token", "synthetic-retain-token"),
            ("name", "Fixture room"),
        ]);
        let mut official = Url::parse("https://wx.chunk.cn/projection/login").unwrap();
        official
            .query_pairs_mut()
            .append_pair("place_code", "fixture");
        official.query_pairs_mut().append_pair(
            "projection_url",
            &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(inner.as_str()),
        );
        official.to_string()
    }
    // v0.9 P1 (requirement 4.8): retaining the room for the device self-test
    // must never retain a Remote's staged, unchecked Pure K credential.
    #[test]
    fn retain_room_disconnect_releases_a_remote_staged_credential_with_its_candidate() {
        for internet in [false, true] {
            for phase in ["staged", "checking", "check-failed"] {
                let mut app = setup();
                let id = if internet {
                    secure(&mut app, "phone")
                } else {
                    lan(&mut app, "phone", true).1
                };
                let request = staged_url(&mut app, &id, &purek_qr());
                assert!(
                    app.native()
                        .cast
                        .room
                        .as_ref()
                        .unwrap()
                        .authorization
                        .is_some()
                );
                // Mirror purek::assisted_connect: the check takes the next room
                // generation and owns the receiver I/O under the same lock.
                let mut cancel = None;
                if phase != "staged" {
                    begin_check(&mut app, &id, (&request, "host-epoch")).unwrap();
                    app.native().cast.room_generation += 1;
                    app.native().cast.room_busy = true;
                    let g = app.native().cast.room_generation;
                    app.native().ktv.connecting = Some((g, "host-epoch".into()));
                    let token = crate::dlna::CancellationToken::new();
                    app.native().cast.connection_cancel = Some(token.clone());
                    cancel = Some(token);
                    if phase == "check-failed" {
                        app.native().cast.room_error = Some("purek_authorization".into());
                        checked(&mut app, &id, false, Some("purek_authorization".into()));
                        release_io(&mut app, g, "host-epoch");
                    }
                }
                // The Host starts a device self-test while the Remote's
                // credential is still staged.
                crate::native_host::cast_session::disconnect_room(app.native(), true);
                assert!(
                    app.native().cast.room.is_none(),
                    "{internet} {phase}: no orphaned credential"
                );
                assert!(
                    app.native().ktv.candidate.is_none(),
                    "{internet} {phase}: candidate released"
                );
                if phase == "checking" {
                    assert!(
                        cancel.as_ref().is_some_and(|c| c.is_cancelled()),
                        "{internet} {phase}: the in-flight check is canceled"
                    );
                }
                // The stale assistance session cannot keep control and the
                // Remote must scan again before any new staging.
                refresh(&mut app);
                let session = app.native().ktv.session.as_ref().unwrap();
                assert!(
                    !session.phase.active()
                        || session.room_generation == app.native().cast.room_generation
                );
                assert!(host_candidate_connection(&mut app, (&request, "host-epoch")).is_err());
                assert!(begin_check(&mut app, &id, (&request, "host-epoch")).is_err());
            }
        }
    }
    #[test]
    fn retain_room_keeps_host_prepared_or_adopted_credentials_only() {
        let mut app = setup();
        // Host-prepared room (no assistance candidate): kept for the self-test.
        app.native().cast.room = Some(Room::parse(&purek_qr()).unwrap());
        crate::native_host::cast_session::disconnect_room(app.native(), true);
        assert!(app.native().cast.room.is_some());
        // Without retain_room every room is forgotten.
        crate::native_host::cast_session::disconnect_room(app.native(), false);
        assert!(app.native().cast.room.is_none());
        // A recovery record for a disconnected Remote is a staged credential
        // as well; retaining the room releases it rather than adopting it.
        let id = secure(&mut app, "phone");
        staged_url(&mut app, &id, &purek_qr());
        retire(&mut app, Phase::Disconnected);
        assert!(
            app.native()
                .ktv
                .candidate
                .as_ref()
                .is_some_and(|c| c.recoverable)
        );
        crate::native_host::cast_session::disconnect_room(app.native(), true);
        assert!(app.native().cast.room.is_none());
        assert!(app.native().ktv.candidate.is_none());
        assert!(request_resume(&mut app, &id).is_ok() || app.native().ktv.candidate.is_none());
    }
    #[test]
    fn explicit_retry_clears_the_old_failure_without_replacing_candidate_ownership() {
        let mut app = setup();
        let id = secure(&mut app, "phone");
        let request = staged(&mut app, &id);
        let deadline = app.native().ktv.candidate.as_ref().unwrap().deadline;
        begin_check(&mut app, &id, (&request, "host-epoch")).unwrap();
        let state = app.native();
        state.cast.room_generation += 1;
        state.cast.room_error = Some("purek_authorization".into());
        checked(&mut app, &id, false, Some("purek_authorization".into()));
        assert!(app.native().ktv.session.as_ref().unwrap().error.is_some());
        begin_check(&mut app, &id, (&request, "host-epoch")).unwrap();
        let state = app.native();
        assert_eq!(state.ktv.session.as_ref().unwrap().phase, Phase::Connecting);
        assert!(state.ktv.session.as_ref().unwrap().error.is_none());
        assert!(state.cast.room_error.is_none());
        let candidate = state.ktv.candidate.as_ref().unwrap();
        assert_eq!(candidate.binding.connection, id);
        assert_eq!(candidate.binding.request, request);
        assert_eq!(candidate.deadline, deadline);
    }
}
