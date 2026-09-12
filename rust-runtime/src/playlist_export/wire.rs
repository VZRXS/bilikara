//! JSON representation adaptation at the existing coarse Runtime boundary.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bilikara_rust::playlist_export::DEFAULT_PAGE_SIZE;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Csv {
        items: Vec<Value>,
        time_header: String,
    },
    Image {
        items: Vec<Value>,
        font_path: PathBuf,
        title: String,
        page_size: Value,
        app_version: String,
    },
    Prewarm {
        font_path: PathBuf,
    },
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.),
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}
fn text(value: &Value) -> Result<String, ExportError> {
    Ok(match value {
        v if !truthy(v) => String::new(),
        Value::String(v) => v.trim().to_owned(),
        Value::Number(v) => v.to_string(),
        Value::Bool(true) => "True".into(),
        _ => {
            return Err(ExportError::new(
                "invalid_request",
                "Export text fields must be scalar values",
            ));
        }
    })
}
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::String(v) => v.trim().parse().ok(),
        Value::Bool(v) => Some(u8::from(*v) as f64),
        _ => value.as_f64(),
    }
}
fn integer(value: &Value) -> Option<i64> {
    match value {
        Value::String(v) => v.trim().parse().ok(),
        _ => number(value)
            .filter(|v| v.is_finite() && *v >= i64::MIN as f64 && *v < i64::MAX as f64)
            .map(|v| v as i64),
    }
}
fn normalized_page_size(value: &Value) -> usize {
    // A large page size means one page, not a new quota or a reset to 80.
    if let Some(size) = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
    {
        return usize::try_from(size).unwrap_or(usize::MAX).max(1);
    }
    if value.is_number() && number(value).is_some_and(|v| v >= usize::MAX as f64) {
        return usize::MAX;
    }
    integer(value)
        .map(|v| v.max(1) as usize)
        .unwrap_or(DEFAULT_PAGE_SIZE)
}

fn entries(items: Vec<Value>, strict_time: bool) -> Result<Vec<ExportEntry>, ExportError> {
    items
        .into_iter()
        .map(|v| {
            if !v.is_object() {
                return Err(ExportError::new(
                    "invalid_request",
                    "Export items must be objects",
                ));
            }
            let time = if truthy(&v["requested_at"]) {
                &v["requested_at"]
            } else {
                &v["played_at"]
            };
            let timestamp = number(time);
            if timestamp.is_some_and(|v| !v.is_finite())
                || (strict_time && truthy(time) && timestamp.is_none())
            {
                return Err(ExportError::new(
                    "invalid_time",
                    "Export timestamp must be finite",
                ));
            }
            Ok(ExportEntry {
                title: text(&v["title"])?,
                display_title: text(if truthy(&v["display_title"]) {
                    &v["display_title"]
                } else {
                    &v["title"]
                })?,
                requester_name: text(&v["requester_name"])?,
                owner_name: text(&v["owner_name"])?,
                owner_mid: text(&v["owner_mid"])?,
                resolved_url: text(&v["resolved_url"])?,
                original_url: text(&v["original_url"])?,
                key: text(&v["key"])?,
                part_title: text(&v["part_title"])?,
                request_count: integer(&v["request_count"]),
                timestamp: timestamp.filter(|_| truthy(time)),
            })
        })
        .collect()
}
pub(crate) fn execute_export_wire(value: Value) -> Result<Value, ExportError> {
    let request = serde_json::from_value(value)
        .map_err(|_| ExportError::new("invalid_request", "Invalid playlist export request"))?;
    let artifact = match request {
        Request::Prewarm { font_path } => {
            prewarm_fonts(&font_path)?;
            return Ok(json!({"prewarmed": true}));
        }
        Request::Csv { items, time_header } => export_csv(&entries(items, false)?, &time_header)?,
        Request::Image {
            items,
            font_path,
            title,
            page_size,
            app_version,
        } => export_image(&ImageExportRequest {
            entries: entries(items, true)?,
            font_path,
            title,
            app_version,
            page_size: normalized_page_size(&page_size),
        })?,
    };
    Ok(
        json!({"data_base64": STANDARD.encode(artifact.bytes), "mime_type": artifact.mime_type,
        "filename": artifact.filename, "missing_glyphs": artifact.missing_glyphs}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_interpretation_and_page_size_contract() {
        let values = entries(
            vec![
                json!({"title":" Title ", "display_title":" ", "requested_at":0,
            "played_at":"100.5", "request_count":"3", "owner_mid":123}),
            ],
            false,
        )
        .unwrap();
        assert_eq!(values[0].display_title, "");
        assert_eq!(values[0].timestamp, Some(100.5));
        assert_eq!(values[0].request_count, Some(3));
        assert_eq!(values[0].owner_mid, "123");
        assert!(entries(vec![json!({"requested_at":"bad"})], true).is_err());
        assert!(entries(vec![json!({"requested_at":"nan"})], false).is_err());
        assert_eq!(
            entries(vec![json!({"requested_at":"bad"})], false).unwrap()[0].timestamp,
            None
        );
        for (value, expected) in [
            (json!(null), 80),
            (json!(0), 1),
            (json!(-4), 1),
            (json!("2"), 2),
            (json!(2.9), 2),
            (json!("bad"), 80),
            (json!(u64::MAX), usize::MAX),
        ] {
            assert_eq!(normalized_page_size(&value), expected);
        }
    }
}
