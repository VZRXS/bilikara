//! Immutable playlist/history export interpretation. No host I/O or wire formats.
use crate::clean_display_title;
use regex::Regex;
use std::sync::OnceLock;

pub const DEFAULT_PAGE_SIZE: usize = 80;
pub const PROJECT_URL: &str = "https://github.com/VZRXS/bilikara";

#[derive(Clone, Debug, Default)]
pub struct ExportEntry {
    pub title: String,
    pub display_title: String,
    pub requester_name: String,
    pub owner_name: String,
    pub owner_mid: String,
    pub resolved_url: String,
    pub original_url: String,
    pub key: String,
    pub part_title: String,
    pub request_count: Option<i64>,
    pub timestamp: Option<f64>,
}

impl ExportEntry {
    pub fn image_title(&self) -> String {
        let title = clean_display_title(&self.title, &self.display_title, &self.part_title);
        if title.is_empty() {
            "未命名歌曲".into()
        } else {
            title
        }
    }

    pub fn video_id(&self) -> String {
        static BV: OnceLock<Regex> = OnceLock::new();
        static AV: OnceLock<Regex> = OnceLock::new();
        let bv = BV.get_or_init(|| Regex::new(r"(?i)BV[0-9A-Za-z]+").unwrap());
        let av = AV.get_or_init(|| Regex::new(r"(?i)av\d+").unwrap());
        for value in [&self.resolved_url, &self.original_url, &self.key] {
            if let Some(found) = bv.find(value).or_else(|| av.find(value)) {
                return found.as_str().into();
            }
        }
        String::new()
    }

    pub fn csv_fields(&self, number: usize, time: String) -> [String; 11] {
        [
            number.to_string(),
            self.display_title.clone(),
            self.video_id(),
            self.requester_name.clone(),
            self.owner_name.clone(),
            self.owner_mid.clone(),
            self.request_count.unwrap_or(1).max(1).to_string(),
            time,
            self.resolved_url.clone(),
            self.original_url.clone(),
            self.part_title.clone(),
        ]
    }
}

pub fn ordered_entries(entries: &[ExportEntry]) -> Vec<&ExportEntry> {
    let mut ordered: Vec<_> = entries.iter().collect();
    // Stable sort retains input order for ties and undated entries.
    ordered.sort_by(
        |a, b| match (valid_time(a.timestamp), valid_time(b.timestamp)) {
            (Some(a), Some(b)) => a.total_cmp(&b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        },
    );
    ordered
}

pub fn valid_time(time: Option<f64>) -> Option<f64> {
    time.filter(|value| value.is_finite() && *value > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordering_fields_and_title_contract() {
        let entries: Vec<_> = [None, Some(200.), Some(100.), Some(100.), Some(0.)]
            .into_iter()
            .enumerate()
            .map(|(i, timestamp)| ExportEntry {
                key: format!("av{}", i + 1),
                timestamp,
                ..Default::default()
            })
            .collect();
        assert_eq!(
            ordered_entries(&entries)
                .iter()
                .map(|e| e.video_id())
                .collect::<Vec<_>>(),
            ["av3", "av4", "av2", "av1", "av5"]
        );
        let entry = ExportEntry {
            title: "【ニコカラ】你好 [on vocal]".into(),
            display_title: "CSV title".into(),
            request_count: Some(-2),
            ..Default::default()
        };
        assert_eq!(entry.image_title(), "你好 [on vocal]");
        assert_eq!(entry.csv_fields(81, "local time".into())[0], "81");
        assert_eq!(entry.csv_fields(81, "local time".into())[1], "CSV title");
        assert_eq!(entry.csv_fields(81, "local time".into())[6], "1");
        assert_eq!(ExportEntry::default().image_title(), "未命名歌曲");
    }
}
