use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolPrepareFacts {
    pub override_exists: bool,
    pub installed_exists: bool,
    pub force_refresh: bool,
    pub version_metadata_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPrepareAction {
    UseOverride,
    UseInstalled,
    FetchInstallUpdate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolPrepareDecision {
    pub action: ToolPrepareAction,
    pub probe_installed_version: bool,
}

pub fn decide_tool_prepare(facts: ToolPrepareFacts) -> ToolPrepareDecision {
    if facts.override_exists {
        return ToolPrepareDecision {
            action: ToolPrepareAction::UseOverride,
            probe_installed_version: false,
        };
    }
    if facts.installed_exists && !facts.force_refresh {
        return ToolPrepareDecision {
            action: ToolPrepareAction::UseInstalled,
            probe_installed_version: !facts.version_metadata_present,
        };
    }
    ToolPrepareDecision {
        action: ToolPrepareAction::FetchInstallUpdate,
        probe_installed_version: false,
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    schema_version: u32,
    override_exists: bool,
    installed_exists: bool,
    force_refresh: bool,
    version_metadata_present: bool,
}

#[derive(Debug, Serialize)]
struct WireResponse {
    schema_version: u32,
    action: ToolPrepareAction,
    probe_installed_version: bool,
}

pub(crate) fn decide_tool_prepare_policy_json(request_json: &str) -> Option<String> {
    let request: WireRequest = serde_json::from_str(request_json).ok()?;
    if request.schema_version != SCHEMA_VERSION {
        return None;
    }
    let decision = decide_tool_prepare(ToolPrepareFacts {
        override_exists: request.override_exists,
        installed_exists: request.installed_exists,
        force_refresh: request.force_refresh,
        version_metadata_present: request.version_metadata_present,
    });
    serde_json::to_string(&WireResponse {
        schema_version: SCHEMA_VERSION,
        action: decision.action,
        probe_installed_version: decision.probe_installed_version,
    })
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(
        override_exists: bool,
        installed_exists: bool,
        force_refresh: bool,
        version_metadata_present: bool,
    ) -> ToolPrepareFacts {
        ToolPrepareFacts {
            override_exists,
            installed_exists,
            force_refresh,
            version_metadata_present,
        }
    }

    #[test]
    fn override_has_precedence() {
        assert_eq!(
            decide_tool_prepare(facts(true, true, true, false)),
            ToolPrepareDecision {
                action: ToolPrepareAction::UseOverride,
                probe_installed_version: false,
            }
        );
    }

    #[test]
    fn installed_normal_prepare_skips_fetch_and_probes_only_without_metadata() {
        assert_eq!(
            decide_tool_prepare(facts(false, true, false, true)),
            ToolPrepareDecision {
                action: ToolPrepareAction::UseInstalled,
                probe_installed_version: false,
            }
        );
        assert_eq!(
            decide_tool_prepare(facts(false, true, false, false)),
            ToolPrepareDecision {
                action: ToolPrepareAction::UseInstalled,
                probe_installed_version: true,
            }
        );
    }

    #[test]
    fn missing_or_forced_prepare_fetches() {
        assert_eq!(
            decide_tool_prepare(facts(false, false, false, false)).action,
            ToolPrepareAction::FetchInstallUpdate
        );
        assert_eq!(
            decide_tool_prepare(facts(false, true, true, true)).action,
            ToolPrepareAction::FetchInstallUpdate
        );
    }

    #[test]
    fn complete_prepare_matrix_has_independent_typed_and_wire_expectations() {
        use ToolPrepareAction::{FetchInstallUpdate, UseInstalled, UseOverride};
        for (override_exists, installed, force, metadata, action, label, probe) in [
            (
                false,
                false,
                false,
                false,
                FetchInstallUpdate,
                "fetch_install_update",
                false,
            ),
            (
                false,
                false,
                false,
                true,
                FetchInstallUpdate,
                "fetch_install_update",
                false,
            ),
            (
                false,
                false,
                true,
                false,
                FetchInstallUpdate,
                "fetch_install_update",
                false,
            ),
            (
                false,
                false,
                true,
                true,
                FetchInstallUpdate,
                "fetch_install_update",
                false,
            ),
            (
                false,
                true,
                false,
                false,
                UseInstalled,
                "use_installed",
                true,
            ),
            (
                false,
                true,
                false,
                true,
                UseInstalled,
                "use_installed",
                false,
            ),
            (
                false,
                true,
                true,
                false,
                FetchInstallUpdate,
                "fetch_install_update",
                false,
            ),
            (
                false,
                true,
                true,
                true,
                FetchInstallUpdate,
                "fetch_install_update",
                false,
            ),
            (
                true,
                false,
                false,
                false,
                UseOverride,
                "use_override",
                false,
            ),
            (true, false, false, true, UseOverride, "use_override", false),
            (true, false, true, false, UseOverride, "use_override", false),
            (true, false, true, true, UseOverride, "use_override", false),
            (true, true, false, false, UseOverride, "use_override", false),
            (true, true, false, true, UseOverride, "use_override", false),
            (true, true, true, false, UseOverride, "use_override", false),
            (true, true, true, true, UseOverride, "use_override", false),
        ] {
            let expected = ToolPrepareDecision {
                action,
                probe_installed_version: probe,
            };
            assert_eq!(
                decide_tool_prepare(facts(override_exists, installed, force, metadata)),
                expected
            );
            let request = serde_json::json!({"schema_version":1,"override_exists":override_exists,
                "installed_exists":installed,"force_refresh":force,"version_metadata_present":metadata});
            let result = decide_tool_prepare_policy_json(&request.to_string()).unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&result).unwrap(),
                serde_json::json!({"schema_version":1,"action":label,"probe_installed_version":probe})
            );
        }
    }

    #[test]
    fn wire_adapter_rejects_unknown_or_wrong_schema() {
        assert!(decide_tool_prepare_policy_json(
            r#"{"schema_version":1,"override_exists":false,"installed_exists":true,"force_refresh":false,"version_metadata_present":true}"#
        )
        .is_some());
        assert!(decide_tool_prepare_policy_json(
            r#"{"schema_version":2,"override_exists":false,"installed_exists":true,"force_refresh":false,"version_metadata_present":true}"#
        )
        .is_none());
        assert!(decide_tool_prepare_policy_json(
            r#"{"schema_version":1,"override_exists":false,"installed_exists":true,"force_refresh":false,"version_metadata_present":true,"extra":1}"#
        )
        .is_none());
    }
}
