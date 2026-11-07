//! Shell presentation leases only. Playback and application state stay in the
//! Host; this adapter forwards the shared compositor's versioned envelope.
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct IdentifierColors {
    pub fill: [u8; 4],
    pub ink: [u8; 4],
    pub muted: [u8; 4],
    pub accent: [u8; 4],
    pub outline: [u8; 4],
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IdentifierOptions {
    pub display_ids: Vec<String>,
    pub display_numbers: BTreeMap<String, u8>,
    pub theme: String,
    pub language: String,
    pub colors: IdentifierColors,
    pub reduce_motion: bool,
}
impl IdentifierOptions {
    pub fn parse(value: &Value) -> Result<Self, &'static str> {
        let options: Self = serde_json::from_value(value.clone()).map_err(|_| "display_request")?;
        let ids: BTreeSet<_> = options.display_ids.iter().collect();
        let numbers: BTreeSet<_> = options.display_numbers.values().collect();
        if ids.is_empty()
            || ids.len() > 16
            || ids.len() != options.display_ids.len()
            || options.display_numbers.len() != ids.len()
            || numbers.len() != ids.len()
            || options.display_ids.iter().any(|id| {
                id.is_empty()
                    || id.len() > 256
                    || id.chars().any(char::is_control)
                    || !options
                        .display_numbers
                        .get(id)
                        .is_some_and(|n| (1..=99).contains(n))
            })
            || !["light", "dark", "blue"].contains(&options.theme.as_str())
            || !["zh", "en", "ja"].contains(&options.language.as_str())
        {
            return Err("display_request");
        }
        Ok(options)
    }
    pub fn role_label(&self, host: bool) -> &'static str {
        match (self.language.as_str(), host) {
            ("en", true) => "Current Host",
            ("en", false) => "Audience display",
            ("ja", true) => "現在の Host",
            ("ja", false) => "観客用画面",
            (_, true) => "当前 Host",
            (_, false) => "可选观众屏",
        }
    }
}

/// Scene coordinates and its own safe area, never the phone screen/DPR.
pub(crate) fn identifier_frame(bounds: [f64; 4], safe: [f64; 4]) -> Option<[f64; 4]> {
    if !bounds.into_iter().chain(safe).all(f64::is_finite)
        || bounds[2] <= 0.
        || bounds[3] <= 0.
        || safe.into_iter().any(|v| v < 0.)
    {
        return None;
    }
    let size = 128_f64
        .min(bounds[2] - safe[1] - safe[3] - 48.)
        .min(bounds[3] - safe[0] - safe[2] - 48.);
    (size >= 112.).then_some([
        bounds[0] + safe[3] + 24.,
        bounds[1] + safe[0] + 24.,
        size,
        size,
    ])
}

pub(crate) const EXTERNAL_ROLES: [&str; 2] = [
    "UIWindowSceneSessionRoleExternalDisplayNonInteractive",
    "UIWindowSceneSessionRoleExternalDisplay",
];

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Role {
    Host,
    Audience(u64),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub schema_version: u32,
    pub document_id: String,
    pub id: Option<String>,
    pub command: String,
    pub args: Value,
}

impl Request {
    pub fn parse(text: &str, role: Role) -> Result<Self, &'static str> {
        if text.len() > 2 * 1024 * 1024 {
            return Err("display_request");
        }
        let r: Self = serde_json::from_str(text).map_err(|_| "display_request")?;
        let common = matches!(
            r.command.as_str(),
            "document" | "retire" | "get_presentation_session" | "deactivate_local_presentation"
        );
        let allowed = common
            || match role {
                Role::Audience(_) => matches!(
                    r.command.as_str(),
                    "mark_presentation_controller_ready" | "output-diagnostics"
                ),
                Role::Host => matches!(
                    r.command.as_str(),
                    "get_presentation_displays"
                        | "activate_local_presentation"
                        | "mark_presentation_host_ready"
                        | "publish_presentation_playback_state"
                        | "master-state"
                        | "diagnostics"
                        | "show_presentation_display_identifiers"
                        | "dismiss_presentation_display_identifiers"
                        | "get_playback_restart_hint_seen"
                        | "mark_playback_restart_hint_seen"
                ),
            };
        let event = matches!(
            r.command.as_str(),
            "document" | "retire" | "master-state" | "output-diagnostics"
        );
        if r.schema_version != 1
            || (event && r.id.is_some())
            || !allowed
            || !r.args.is_object()
            || r.document_id.len() != 32
            || !r.document_id.bytes().all(|b| b.is_ascii_hexdigit())
            || (!event
                && !r.id.as_ref().is_some_and(|id| {
                    !id.is_empty()
                        && id.len() <= 64
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                }))
            || (r.command != "master-state" && text.len() > 8192)
        {
            return Err("display_request");
        }
        Ok(r)
    }
}

#[derive(Default)]
pub(crate) struct Session {
    pub generation: u64,
    pub target: Option<String>,
    pub host_ready: bool,
    pub output_ready: bool,
    pub reason: &'static str,
    pub last_sequence: u64,
}

impl Session {
    pub fn activate(&mut self, target: String) -> Result<u64, &'static str> {
        if target.is_empty() || target.len() > 1024 || target.chars().any(char::is_control) {
            return Err("display_unavailable");
        }
        if self.target.is_some() {
            return Err("display_busy");
        }
        self.generation = self
            .generation
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or("display_generation")?;
        self.target = Some(target);
        self.host_ready = false;
        self.output_ready = false;
        self.last_sequence = 0;
        self.reason = "";
        Ok(self.generation)
    }
    pub fn phase(&self) -> &'static str {
        if self.target.is_none() {
            "inactive"
        } else if self.host_ready && self.output_ready {
            "active"
        } else {
            "activating"
        }
    }
    pub fn check(&self, generation: u64) -> Result<(), &'static str> {
        if self.target.is_some() && generation == self.generation {
            Ok(())
        } else {
            Err("stale_generation")
        }
    }
    pub fn ready(
        &mut self,
        role: Role,
        generation: u64,
        composition: Option<&str>,
    ) -> Result<(), &'static str> {
        self.check(generation)?;
        match role {
            Role::Host if composition == Some("stageOnly") => self.host_ready = true,
            Role::Audience(lease) if lease == generation => self.output_ready = true,
            _ => return Err("invalid_composition"),
        }
        Ok(())
    }
    pub fn master(&mut self, value: &Value) -> Result<(), &'static str> {
        self.check(
            value["payload"]["scene"]["generation"]
                .as_u64()
                .ok_or("stale_generation")?,
        )?;
        let sequence = value["sequence"]
            .as_u64()
            .filter(|n| *n > self.last_sequence && *n <= 9_007_199_254_740_991)
            .ok_or("stale_sequence")?;
        if value["type"] != "master-state" || value["protocol"] != 1 {
            return Err("display_envelope");
        }
        self.last_sequence = sequence;
        Ok(())
    }
    pub fn stop(&mut self, reason: &'static str) {
        self.target = None;
        self.host_ready = false;
        self.output_ready = false;
        self.reason = reason;
        self.last_sequence = 0;
    }
    pub fn snapshot(&self) -> Value {
        json!({"mode":if self.target.is_some(){"localDualScreen"}else{"singleScreen"},
            "phase":self.phase(),"generation":self.generation,"hostReady":self.host_ready,"controllerReady":self.output_ready,
            "selectedOutputDisplayId":self.target.as_deref().unwrap_or(""),"controllerDisplayId":"ios-host",
            "lastAcceptedCommandSequence":0,"lastAppliedCommandSequence":0,"playbackAuthority":"host","mediaRendererOwner":"host","recoveryReason":self.reason})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifier_uses_scene_safe_edges_and_never_the_phone_resolution() {
        assert_eq!(
            identifier_frame([1920., 0., 1920., 1080.], [0.; 4]),
            Some([1944., 24., 128., 128.])
        );
        assert_eq!(
            identifier_frame([0., 0., 393., 852.], [47., 0., 34., 0.]),
            Some([24., 71., 128., 128.])
        );
        assert_eq!(
            identifier_frame([0., 0., 160., 160.], [0.; 4]),
            Some([24., 24., 112., 112.])
        );
        assert_eq!(identifier_frame([0., 0., 120., 120.], [0.; 4]), None);
        assert_eq!(identifier_frame([0., 0., f64::NAN, 1080.], [0.; 4]), None);
        assert_eq!(
            identifier_frame([0., 0., 1920., 1080.], [-1., 0., 0., 0.]),
            None
        );
    }
    #[test]
    fn identifier_validates_shared_colors_numbers_languages_and_motion() {
        let value = json!({"displayIds":["ios-host","external"],"displayNumbers":{"ios-host":2,"external":1},"theme":"blue","language":"en","reduceMotion":true,"colors":{"fill":[8,18,32,255],"ink":[229,246,255,255],"muted":[147,169,189,255],"accent":[56,189,248,255],"outline":[56,189,248,51]}});
        let options = IdentifierOptions::parse(&value).unwrap();
        assert_eq!(options.display_numbers["external"], 1);
        assert!(options.reduce_motion);
        assert_eq!(options.colors.fill, [8, 18, 32, 255]);
        assert_eq!(options.colors.ink, [229, 246, 255, 255]);
        assert_eq!(options.colors.muted, [147, 169, 189, 255]);
        assert_eq!(options.colors.accent, [56, 189, 248, 255]);
        assert_eq!(options.colors.outline, [56, 189, 248, 51]);
        for (language, host, label) in [
            ("en", true, "Current Host"),
            ("en", false, "Audience display"),
            ("zh", true, "当前 Host"),
            ("zh", false, "可选观众屏"),
            ("ja", true, "現在の Host"),
            ("ja", false, "観客用画面"),
        ] {
            let mut translated = options.clone();
            translated.language = language.into();
            assert_eq!(translated.role_label(host), label);
        }
        for (field, bad) in [
            ("displayIds", json!(["ios-host", "ios-host"])),
            ("displayNumbers", json!({"ios-host":1,"external":1})),
            ("theme", json!("unknown")),
            ("language", json!("unknown")),
            ("colors", json!({"fill":[-1,0,0,0]})),
        ] {
            let mut invalid = value.clone();
            invalid[field] = bad;
            assert!(IdentifierOptions::parse(&invalid).is_err());
        }
    }
    #[test]
    fn only_external_scene_roles_are_eligible() {
        assert!(!EXTERNAL_ROLES.contains(&"UIWindowSceneSessionRoleApplication"));
        assert!(!EXTERNAL_ROLES.contains(&"audio-route"));
        assert_eq!(EXTERNAL_ROLES.len(), 2);
    }
    #[test]
    fn output_frames_cannot_discover_activate_or_submit_host_commands() {
        for command in [
            "get_presentation_displays",
            "activate_local_presentation",
            "master-state",
            "open-bilibili-login",
            "publish_presentation_playback_state",
        ] {
            let value = json!({"schema_version":1,"document_id":"a".repeat(32),"id":"display-1","command":command,"args":{}}).to_string();
            assert!(Request::parse(&value, Role::Audience(1)).is_err());
        }
        let value = json!({"schema_version":1,"document_id":"a".repeat(32),"id":"display-1","command":"get_presentation_session","args":{}}).to_string();
        assert!(Request::parse(&value, Role::Audience(1)).is_ok());
        for bad in [
            value.replace("display-1", "bad id"),
            value.replace(&"a".repeat(32), "old"),
            value.replace("\"args\":{}", "\"args\":null"),
        ] {
            assert!(Request::parse(&bad, Role::Host).is_err());
        }
    }
    #[test]
    fn invalid_events_schema_and_packet_sizes_fail_closed() {
        let event = json!({"schema_version":1,"document_id":"b".repeat(32),"command":"master-state","args":{}});
        assert!(Request::parse(&event.to_string(), Role::Host).is_ok());
        for (key, value) in [
            ("id", json!("display-1")),
            ("schema_version", json!(2)),
            ("extra", json!(true)),
            ("args", Value::Null),
        ] {
            let mut bad = event.clone();
            bad[key] = value;
            assert!(Request::parse(&bad.to_string(), Role::Host).is_err());
        }
        let mut oversized = event.clone();
        oversized["args"]["data"] = json!("x".repeat(2 * 1024 * 1024));
        assert!(Request::parse(&oversized.to_string(), Role::Host).is_err());
        oversized["command"] = json!("diagnostics");
        oversized["id"] = json!("display-2");
        oversized["args"]["data"] = json!("x".repeat(8192));
        assert!(Request::parse(&oversized.to_string(), Role::Host).is_err());
    }
    #[test]
    fn invalid_targets_and_generation_exhaustion_do_not_create_a_lease() {
        let mut s = Session::default();
        for target in [String::new(), "display\n".into(), "x".repeat(1025)] {
            assert!(s.activate(target).is_err());
        }
        assert!(s.target.is_none());
        assert_eq!(s.generation, 0);
        s.generation = 9_007_199_254_740_991;
        assert!(s.activate("external".into()).is_err());
        assert!(s.target.is_none());
    }
    #[test]
    fn both_current_views_must_be_ready_and_old_audience_cannot_resume() {
        let mut s = Session::default();
        let first = s.activate("external-a".into()).unwrap();
        assert!(s.activate("external-b".into()).is_err());
        s.ready(Role::Host, first, Some("stageOnly")).unwrap();
        assert_eq!(s.phase(), "activating");
        assert!(s.ready(Role::Audience(first - 1), first, None).is_err());
        s.ready(Role::Audience(first), first, None).unwrap();
        assert_eq!(s.phase(), "active");
        s.stop("displayDisconnected");
        let second = s.activate("external-a".into()).unwrap();
        assert!(second > first);
        assert!(s.ready(Role::Audience(first), first, None).is_err());
        assert_eq!(s.phase(), "activating");
        assert_eq!(s.snapshot()["playbackAuthority"], "host");
    }
    #[test]
    fn master_envelope_rejects_old_generations_and_replays() {
        let mut s = Session::default();
        let generation = s.activate("external".into()).unwrap();
        let mut v = json!({"type":"master-state","protocol":1,"sequence":1,"payload":{"scene":{"generation":generation}}});
        s.master(&v).unwrap();
        assert!(s.master(&v).is_err());
        v["sequence"] = json!(2);
        v["payload"]["scene"]["generation"] = json!(generation + 1);
        assert!(s.master(&v).is_err());
        assert_eq!(s.last_sequence, 1);
    }
}
