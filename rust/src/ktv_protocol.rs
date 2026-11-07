//! Narrow Remote assistance messages. They never grant receiver-management rights.
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub enum KtvRequestV1 {
    #[serde(rename = "ktv.status.get")]
    Status {},
    #[serde(rename = "ktv.scan.request")]
    Request {},
    #[serde(rename = "ktv.authorization.resume.request")]
    Resume {},
    #[serde(rename = "ktv.scan.accept")]
    Accept {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "ktv.scan.decline")]
    Decline {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "ktv.scan.submit")]
    Submit {
        request_id: String,
        host_epoch: String,
        url: String,
    },
    #[serde(rename = "ktv.authorization.check")]
    Check {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "ktv.authorization.link.get")]
    Link {
        request_id: String,
        host_epoch: String,
    },
    #[serde(rename = "ktv.scan.cancel")]
    Cancel {
        request_id: String,
        host_epoch: String,
    },
}

// Protocol errors/debug output must never print credential-bearing URLs.
impl std::fmt::Debug for KtvRequestV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KtvRequestV1")
            .field("operation", &self.operation())
            .finish_non_exhaustive()
    }
}
impl KtvRequestV1 {
    pub const fn operation(&self) -> &'static str {
        match self {
            Self::Status {} => "ktv.status.get",
            Self::Request {} => "ktv.scan.request",
            Self::Resume {} => "ktv.authorization.resume.request",
            Self::Accept { .. } => "ktv.scan.accept",
            Self::Decline { .. } => "ktv.scan.decline",
            Self::Submit { .. } => "ktv.scan.submit",
            Self::Check { .. } => "ktv.authorization.check",
            Self::Link { .. } => "ktv.authorization.link.get",
            Self::Cancel { .. } => "ktv.scan.cancel",
        }
    }
    pub fn binding(&self) -> Option<(&str, &str)> {
        match self {
            Self::Status {} | Self::Request {} | Self::Resume {} => None,
            Self::Accept {
                request_id,
                host_epoch,
            }
            | Self::Decline {
                request_id,
                host_epoch,
            }
            | Self::Submit {
                request_id,
                host_epoch,
                ..
            }
            | Self::Check {
                request_id,
                host_epoch,
            }
            | Self::Link {
                request_id,
                host_epoch,
            }
            | Self::Cancel {
                request_id,
                host_epoch,
            } => Some((request_id, host_epoch)),
        }
    }
    pub fn valid(&self) -> bool {
        self.binding().is_none_or(|(id, epoch)| {
            id.len() == 64
                && id.bytes().all(|c| c.is_ascii_hexdigit())
                && !epoch.is_empty()
                && epoch.len() <= 128
                && epoch
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        }) && match self {
            Self::Submit { url, .. } => {
                !url.is_empty() && url.len() <= 12000 && !url.chars().any(char::is_control)
            }
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RemoteLane, RemoteProfile, RemoteValidationContext, decode_remote_request_v1};
    use serde_json::json;
    fn message(kind: &str, body: serde_json::Value) -> String {
        json!({"v":1,"lane":"control","epoch":"abcdefghijklmnopqrstuv","seq":1,"id":"123e4567-e89b-42d3-a456-426614174000","kind":kind,"body":body}).to_string()
    }
    fn decode(raw: &str, profile: RemoteProfile, last: Option<u64>) -> bool {
        decode_remote_request_v1(
            raw,
            RemoteValidationContext {
                expected_lane: RemoteLane::Control,
                expected_epoch: "abcdefghijklmnopqrstuv",
                last_sequence: last,
                profile,
            },
        )
        .is_ok()
    }
    #[test]
    fn assistance_is_a_narrow_controller_capability_with_replay_and_epoch_validation() {
        let body = json!({"request_id":"a".repeat(64),"host_epoch":"native-epoch","url":"https://wx.chunk.cn/projection/login?secret=synthetic"});
        let raw = message("ktv.scan.submit", body.clone());
        assert!(decode(&raw, RemoteProfile::Controller, None));
        assert!(!decode(&raw, RemoteProfile::Viewer, None));
        assert!(!decode(&raw, RemoteProfile::Controller, Some(1)));
        for (kind, body) in [
            ("ktv.authorization.resume.request", json!({})),
            (
                "ktv.authorization.link.get",
                json!({"request_id":"b".repeat(64),"host_epoch":"host-epoch"}),
            ),
        ] {
            let raw = message(kind, body);
            assert!(decode(&raw, RemoteProfile::Controller, None));
            assert!(!decode(&raw, RemoteProfile::Viewer, None));
            assert!(!decode(&raw, RemoteProfile::Controller, Some(1)));
        }
        assert!(!decode(
            &message(
                "ktv.authorization.resume.request",
                json!({"candidate_id":"forged"})
            ),
            RemoteProfile::Controller,
            None
        ));
        assert!(decode(
            &message("ktv.status.get", json!({})),
            RemoteProfile::Viewer,
            None
        ));
        for body in [
            json!({"request_id":"x","host_epoch":"epoch","url":"x"}),
            json!({"request_id":"a".repeat(64),"host_epoch":"epoch","url":"x","allow":true}),
            json!({"request_id":"a".repeat(64),"host_epoch":"epoch","url":"x".repeat(12001)}),
        ] {
            assert!(!decode(
                &message("ktv.scan.submit", body),
                RemoteProfile::Controller,
                None
            ));
        }
        for forbidden in [
            "ktv.scan.invite",
            "ktv.register",
            "ktv.disconnect",
            "ktv.output.start",
            "ktv.scan.approve",
        ] {
            assert!(!decode(
                &message(forbidden, json!({})),
                RemoteProfile::Controller,
                None
            ));
        }
        let parsed:KtvRequestV1=serde_json::from_value(json!({"operation":"ktv.scan.submit","request_id":"a".repeat(64),"host_epoch":"epoch","url":"synthetic-private"})).unwrap();
        assert!(!format!("{parsed:?}").contains("synthetic-private"));
    }
}
