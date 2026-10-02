//! Announcement eligibility is installation-wide, not karaoke-session policy.
//! All clocks, version/platform facts and shown IDs are supplied by the caller.
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Release { version: String },
    Notice { starts_at: i64, ends_at: i64 },
}

#[derive(Clone, Debug)]
pub struct Announcement {
    pub id: String,
    pub kind: Kind,
    pub published_at: i64,
    pub platforms: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Entry {
    pub index: usize,
    pub expired: bool,
    pub unseen: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Active notices plus unseen notes for the installed version. Empty when
    /// the whole eligible batch has already been shown.
    pub automatic: Vec<usize>,
    /// Published, platform-applicable releases and currently active notices.
    pub history: Vec<Entry>,
}

pub fn plan(
    entries: &[Announcement],
    installed_version: &str,
    platform: &str,
    now: i64,
    shown: &BTreeSet<String>,
) -> Plan {
    let version = installed_version.trim();
    let version = version.strip_prefix('v').unwrap_or(version);
    let mut history: Vec<_> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            entry.published_at <= now
                && (entry.platforms.is_empty() || entry.platforms.iter().any(|p| p == platform))
                && match entry.kind {
                    Kind::Notice { starts_at, ends_at } => starts_at <= now && now < ends_at,
                    Kind::Release { .. } => true,
                }
        })
        .map(|(index, entry)| Entry {
            index,
            expired: matches!(entry.kind, Kind::Notice { ends_at, .. } if ends_at <= now),
            unseen: !shown.contains(&entry.id),
        })
        .collect();
    // Current notices first; release/history second. Stable ties use the ID,
    // independent of the publisher's input order.
    history.sort_by(|a, b| {
        let first = |e: &Entry| matches!(entries[e.index].kind, Kind::Notice { .. }) && !e.expired;
        first(b)
            .cmp(&first(a))
            .then_with(|| {
                entries[b.index]
                    .published_at
                    .cmp(&entries[a.index].published_at)
            })
            .then_with(|| entries[a.index].id.cmp(&entries[b.index].id))
    });
    let candidates: Vec<_> = history
        .iter()
        .filter(|entry| match &entries[entry.index].kind {
            Kind::Notice { .. } => !entry.expired,
            Kind::Release { version: target } => {
                entry.unseen
                    && !version.is_empty()
                    && target.strip_prefix('v').unwrap_or(target) == version
            }
        })
        .collect();
    let automatic = if candidates.iter().any(|entry| entry.unseen) {
        candidates.iter().map(|entry| entry.index).collect()
    } else {
        Vec::new()
    };
    Plan { automatic, history }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(id: &str, version: &str, at: i64) -> Announcement {
        Announcement {
            id: id.into(),
            kind: Kind::Release {
                version: version.into(),
            },
            published_at: at,
            platforms: vec![],
        }
    }
    fn notice(id: &str, at: i64, start: i64, end: i64) -> Announcement {
        Announcement {
            kind: Kind::Notice {
                starts_at: start,
                ends_at: end,
            },
            ..release(id, "", at)
        }
    }

    #[test]
    fn installed_version_not_latest_release_controls_popup() {
        let entries = [
            release("old", "0.7.0", 1),
            release("installed", "0.8.0", 2),
            release("new", "0.9.0", 3),
        ];
        let shown = BTreeSet::new();
        assert_eq!(
            plan(&entries, "v0.8.0", "android", 4, &shown).automatic,
            [1]
        );
        assert!(
            plan(&entries, "", "android", 4, &shown)
                .automatic
                .is_empty()
        );
        assert_eq!(
            plan(&entries, "0.8.0", "android", 4, &shown).history.len(),
            3
        );
    }

    #[test]
    fn release_version_normalization_removes_at_most_one_v() {
        for (installed, target, expected_match) in [
            ("0.8.0", "0.8.0", true),
            ("v0.8.0", "0.8.0", true),
            ("0.8.0", "v0.8.0", true),
            ("v0.8.0", "v0.8.0", true),
            (" \tv0.8.0\n", "0.8.0", true),
            ("0.8.0-preview.1", "v0.8.0-preview.1", true),
            ("v0.8.0-preview.1", "0.8.0-preview.1", true),
            ("0.8.0-preview.1", "0.8.0", false),
            ("vv0.8.0", "0.8.0", false),
            ("0.8.0", "vv0.8.0", false),
            ("vv0.8.0", "v0.8.0", false),
            ("v0.8.0", "vv0.8.0", false),
            ("vvv0.8.0", "0.8.0", false),
            ("0.8.0", "vvv0.8.0", false),
            (" \tvv0.8.0\n", "0.8.0", false),
            ("vv0.8.0-preview.1", "0.8.0-preview.1", false),
            ("0.8.0-preview.1", "vv0.8.0-preview.1", false),
            ("", "", false),
            ("v", "v", false),
        ] {
            let entries = [release("release", target, 1)];
            let result = plan(&entries, installed, "android", 2, &BTreeSet::new());
            assert_eq!(
                result.automatic == [0],
                expected_match,
                "installed={installed:?}, target={target:?}",
            );
            // A non-matching release remains available in manual history.
            assert_eq!(result.history.len(), 1);
        }
    }

    #[test]
    fn time_boundaries_and_scheduled_entries() {
        let entries = [
            notice("active", 1, 10, 20),
            notice("future", 30, 10, 40),
            notice("bad", 1, 20, 10),
        ];
        let shown = BTreeSet::new();
        assert!(plan(&entries, "", "android", 9, &shown).history.is_empty());
        assert_eq!(plan(&entries, "", "android", 10, &shown).automatic, [0]);
        let ended = plan(&entries, "", "android", 20, &shown);
        assert!(ended.automatic.is_empty());
        assert!(ended.history.is_empty());
        assert!(plan(&entries, "", "android", 21, &shown).history.is_empty());
    }

    #[test]
    fn expired_notices_are_absent_from_manual_history_without_hiding_releases() {
        let entries = [
            notice("expired-unseen", 9, 0, 10),
            notice("expired-shown", 8, 0, 10),
            notice("active-shown", 1, 0, 20),
            release("old", "0.7.0", 2),
            release("installed", "0.8.0", 3),
        ];
        let shown = BTreeSet::from([
            "expired-shown".into(),
            "active-shown".into(),
            "installed".into(),
        ]);
        for platform in ["windows", "macos", "linux", "android"] {
            let result = plan(&entries, "0.8.0", platform, 10, &shown);
            assert!(result.automatic.is_empty());
            assert_eq!(
                result
                    .history
                    .iter()
                    .map(|entry| entry.index)
                    .collect::<Vec<_>>(),
                [2, 4, 3]
            );
            assert!(result.history.iter().all(|entry| !entry.expired));
        }
    }

    #[test]
    fn active_notice_priority_platform_and_once_per_id() {
        let mut entries = vec![
            release("release", "1", 9),
            notice("earlier", 1, 0, 20),
            notice("later", 2, 0, 20),
            notice("wrong-os", 3, 0, 20),
        ];
        entries[3].platforms = vec!["windows".into()];
        let mut shown = BTreeSet::new();
        let first = plan(&entries, "1", "android", 10, &shown);
        assert_eq!(first.automatic, [2, 1, 0]);
        shown.extend(
            first
                .automatic
                .iter()
                .map(|index| entries[*index].id.clone()),
        );
        assert!(
            plan(&entries, "1", "android", 11, &shown)
                .automatic
                .is_empty()
        );
        entries.push(notice("new-notice", 4, 0, 20));
        assert_eq!(
            plan(&entries, "1", "android", 11, &shown).automatic,
            [4, 2, 1]
        );
        // Session changes and publisher corrections to the same ID do not
        // reset installation-wide shown records.
        entries[0].published_at = 10;
        assert!(
            !plan(&entries, "1", "android", 11, &shown)
                .automatic
                .contains(&0)
        );
    }
}
