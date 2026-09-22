//! Explicit administrator-only monthly catalog refresh. No Python process,
//! automatic startup scan, or mutation of the user's configured local library.
use super::*;
use crate::bilibili_service::BilibiliHttpClient;
use crate::cloudflare_service::{
    CloudflareOperation, CloudflareServiceRequest, execute_cloudflare,
};
use crate::gatcha_refresh::RefreshControl;
use crate::shared_catalog::{CatalogOperation, CatalogRequest, execute_catalog};
use std::collections::{BTreeSet, HashSet};
use std::io::Write;

#[derive(Default, Debug, serde::Serialize)]
struct Summary {
    checked: usize,
    refreshed: usize,
    skipped: usize,
    failed: usize,
    uploaded: usize,
}

struct Page {
    entries: Vec<Value>,
    visible_total: usize,
    raw_count: usize,
}

trait Source {
    fn export(&self) -> Result<Vec<Value>, ApiError>;
    fn page(&self, uid: &str, page: usize) -> Result<Page, ApiError>;
    fn upload(&self, entries: &[Value]) -> Result<(), ApiError>;
    fn pause(&self, seconds: u64) -> Result<(), ApiError>;
    fn report(&self, summary: &Summary);
}

fn uid(value: &Value) -> Option<String> {
    let text = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|n| n.to_string()))?;
    let text = text.trim().trim_start_matches('0');
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())).then(|| text.to_owned())
}

fn bvid(entry: &Value) -> Option<&str> {
    entry["bvid"].as_str().filter(|b| {
        b.len() == 12 && b.starts_with("BV") && b[2..].bytes().all(|c| c.is_ascii_alphanumeric())
    })
}

fn page_with_retry(source: &impl Source, uid: &str, number: usize) -> Result<Page, ApiError> {
    for attempt in 0..=3 {
        source.pause(0)?;
        match source.page(uid, number) {
            Ok(page) => return Ok(page),
            Err(error) if error.code == "cancelled" || attempt == 3 => return Err(error),
            Err(_) => source.pause(5)?,
        }
    }
    unreachable!()
}

fn run(source: &impl Source, local_uids: Vec<String>) -> Result<Summary, ApiError> {
    source.pause(0)?;
    let records = source.export()?;
    let mut known: HashSet<String> = records.iter().filter_map(bvid).map(str::to_owned).collect();
    let mut seen = HashSet::new();
    let mut uids: Vec<_> = local_uids
        .into_iter()
        .filter_map(|v| uid(&json!(v)))
        .filter(|v| seen.insert(v.clone()))
        .collect();
    let mut exported: Vec<_> = records
        .iter()
        .filter_map(|r| uid(&r["mid"]))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    exported.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
    uids.extend(exported.into_iter().filter(|v| seen.insert(v.clone())));
    let mut summary = Summary::default();
    for (index, mid) in uids.iter().enumerate() {
        if index > 0 {
            source.pause(2)?;
        }
        let result = refresh_uid(source, mid, &mut known);
        match result {
            Ok(None) => summary.skipped += 1,
            Ok(Some(uploaded)) => {
                summary.refreshed += 1;
                summary.uploaded += uploaded;
            }
            Err(error) if error.code == "cancelled" => return Err(error),
            Err(_) => summary.failed += 1,
        }
        summary.checked += 1;
        source.report(&summary);
    }
    Ok(summary)
}

fn refresh_uid(
    source: &impl Source,
    mid: &str,
    known: &mut HashSet<String>,
) -> Result<Option<usize>, ApiError> {
    let first = page_with_retry(source, mid, 1)?;
    if first.visible_total > 8000
        || !first
            .entries
            .iter()
            .filter_map(bvid)
            .any(|bv| !known.contains(bv))
    {
        return Ok(None);
    }
    // Reuse the probe page. Continue based on raw submissions, not the number
    // left after karaoke filtering (a sparse first page is not the last page).
    let mut visible_total = first.visible_total;
    let mut raw_count = first.raw_count;
    let mut entries = first.entries;
    let mut page = 1;
    while raw_count >= 50 && (visible_total == 0 || page * 50 < visible_total) {
        if page >= 160 {
            return Err(ApiError::new(
                502,
                "monthly_page_limit",
                "UP 主稿件数量在刷新过程中超出上限",
            ));
        }
        source.pause(5)?;
        page += 1;
        let next = page_with_retry(source, mid, page)?;
        if next.visible_total > 8000 {
            return Ok(None);
        }
        visible_total = next.visible_total;
        raw_count = next.raw_count;
        entries.extend(next.entries);
    }
    let mut seen = HashSet::new();
    entries.retain(|entry| {
        bvid(entry).is_some_and(|bv| !known.contains(bv) && seen.insert(bv.to_owned()))
    });
    let mut uploaded = 0;
    for chunk in entries.chunks(500) {
        source.pause(0)?;
        source.upload(chunk)?;
        // Only confirmed uploads advance the local known set.
        known.extend(chunk.iter().filter_map(bvid).map(str::to_owned));
        uploaded += chunk.len();
    }
    Ok(Some(uploaded))
}

struct NetworkSource {
    context: Arc<HostContext>,
    request: CatalogRequest,
    secret: String,
    client: BilibiliHttpClient,
    control: RefreshControl,
}

impl Source for NetworkSource {
    fn export(&self) -> Result<Vec<Value>, ApiError> {
        let result = execute_catalog(&CatalogRequest {
            operation: CatalogOperation::Export {
                secret: self.secret.clone(),
                limit: json!(5000),
            },
            ..self.request.clone()
        })
        .map_err(|e| ApiError::new(e.status_code, &e.kind, e.message))?;
        Ok(result["records"]
            .as_array()
            .ok_or_else(|| ApiError::new(502, "catalog_response", "曲库导出结果无效"))?
            .clone())
    }
    fn page(&self, uid: &str, page: usize) -> Result<Page, ApiError> {
        let (entries, visible_total, raw_count) = crate::gatcha_repository::catalog_uid_page(
            &self.client,
            uid,
            page,
            &self.request.review_keywords,
        )
        .map_err(|e| ApiError::new(502, &e.kind, "Bilibili 稿件列表拉取失败"))?;
        Ok(Page {
            entries,
            visible_total,
            raw_count,
        })
    }
    fn upload(&self, entries: &[Value]) -> Result<(), ApiError> {
        // Monthly imports retain the old authenticated batch-add contract;
        // ordinary per-request append is not an equivalent replacement.
        crate::shared_catalog::invalidate()
            .map_err(|e| ApiError::new(e.status_code, &e.kind, e.message))?;
        let result = execute_cloudflare(&CloudflareServiceRequest {
            schema_version: 1,
            base_url: self.request.base_url.clone(),
            user_agent: self.request.user_agent.clone(),
            timeout_ms: 120_000,
            operation: CloudflareOperation::Request {
                method: "POST".into(),
                path: "/batch-add?sync_google=1".into(),
                payload: Some(json!({"records":entries})),
                authorization: format!("Bearer {}", self.secret),
            },
        });
        let _ = crate::shared_catalog::invalidate();
        let result =
            result.map_err(|_| ApiError::new(502, "monthly_upload", "曲库批量写入失败"))?;
        if result["payload"]["success"] != true {
            return Err(ApiError::new(502, "monthly_upload", "曲库未确认批量写入"));
        }
        Ok(())
    }
    fn pause(&self, seconds: u64) -> Result<(), ApiError> {
        self.control
            .sleep(Duration::from_secs(seconds))
            .map_err(|_| ApiError::new(409, "cancelled", "维护任务已停止"))
    }
    fn report(&self, summary: &Summary) {
        record(&self.context, "progress", summary);
    }
}

fn record(context: &HostContext, event: &str, summary: &Summary) {
    let value = json!({"event":"monthly-d1-refresh","phase":event,"summary":summary});
    let _ = with_app(|app| {
        app.native_diagnostic(&value, now());
        Ok(())
    });
    let directory = context.directory.join("logs");
    if std::fs::create_dir_all(&directory).is_ok()
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("monthly-d1-refresh.log"))
    {
        let _ = writeln!(file, "{value}");
    }
}

struct Lease;
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = with_app(|app| {
            app.native().monthly_refresh_active = false;
            Ok(())
        });
    }
}

pub(super) fn start(context: &Arc<HostContext>, secret: &str) -> Result<Value, ApiError> {
    with_app(|app| {
        if app.native().monthly_refresh_active {
            return Err(ApiError::new(
                409,
                "monthly_running",
                "月度曲库刷新正在本机运行",
            ));
        }
        app.native().monthly_refresh_active = true;
        Ok(())
    })?;
    let lease = Lease;
    let context_for_worker = context.clone();
    let secret = secret.to_owned();
    let instance = format!("local-monthly-{}", (now() * 1000.0) as u64);
    context
        .spawn("native-monthly-refresh", move || {
            let _lease = lease;
            let context = context_for_worker;
            let result = (|| {
                let cookie = with_app(|app| Ok(app.native().cookie.clone()))?;
                let control = RefreshControl::default();
                control.follow_host(context.stop.clone());
                let source = NetworkSource {
                    context: context.clone(),
                    request: CatalogRequest {
                        timeout_ms: 120_000,
                        ..CatalogRequest::for_host()
                    },
                    secret,
                    client: BilibiliHttpClient::new(
                        &cookie,
                        crate::native_video::USER_AGENT,
                        "https://www.bilibili.com/",
                        20_000,
                    )
                    .map_err(|_| ApiError::new(503, "monthly_client", "无法创建维护客户端"))?,
                    control,
                };
                let values = match std::fs::read(context.directory.join("gatcha_uids.json")) {
                    Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                        .map_err(|_| ApiError::invalid("本地 UP 主配置无效"))?,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        json!({"uids":[]})
                    }
                    Err(_) => {
                        return Err(ApiError::new(
                            503,
                            "monthly_config",
                            "无法读取本地 UP 主配置",
                        ));
                    }
                };
                let values = values.get("uids").unwrap_or(&values);
                let local = if let Some(map) = values.as_object() {
                    map.keys().cloned().collect()
                } else {
                    values
                        .as_array()
                        .ok_or_else(|| ApiError::invalid("本地 UP 主配置无效"))?
                        .iter()
                        .filter_map(uid)
                        .collect()
                };
                run(&source, local)
            })();
            match result {
                Ok(summary) => record(
                    &context,
                    if summary.failed == 0 {
                        "completed"
                    } else {
                        "completed-with-errors"
                    },
                    &summary,
                ),
                Err(error) => record(
                    &context,
                    if error.code == "cancelled" {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    &Summary::default(),
                ),
            }
        })
        .map_err(|_| ApiError::new(503, "monthly_start", "无法启动本地月度曲库刷新"))?;
    Ok(
        json!({"success":true,"job":"monthly-d1-refresh","instance_id":instance,"status":"running","runner":"local"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fixture {
        pages: RefCell<Vec<(String, usize)>>,
        uploads: RefCell<Vec<Vec<Value>>>,
        cancelled: bool,
        upload_fails: bool,
        bulk: bool,
    }
    fn entry(n: usize, mid: &str) -> Value {
        json!({"bvid":format!("BV{n:010}"),"mid":mid,"title":"卡拉 fixture"})
    }
    impl Source for Fixture {
        fn export(&self) -> Result<Vec<Value>, ApiError> {
            Ok(vec![entry(1, "1"), entry(2, "2")])
        }
        fn page(&self, uid: &str, number: usize) -> Result<Page, ApiError> {
            self.pages.borrow_mut().push((uid.into(), number));
            if uid == "4" {
                return Err(ApiError::new(502, "fixture", "page failed"));
            }
            if self.bulk && uid == "2" {
                return Ok(Page {
                    entries: ((number - 1) * 50 + 10..number * 50 + 10)
                        .map(|n| entry(n, "2"))
                        .collect(),
                    visible_total: 600,
                    raw_count: 50,
                });
            }
            let (entries, visible_total, raw_count) = match (uid, number) {
                ("1", _) => (vec![entry(1, "1")], 1, 1),
                ("2", 1) => (vec![entry(3, "2"), entry(2, "2")], 51, 50),
                ("2", 2) => (vec![entry(3, "2"), entry(4, "2")], 51, 1),
                ("3", _) => (vec![entry(5, "3")], 8001, 50),
                _ => panic!("unexpected page {uid}/{number}"),
            };
            Ok(Page {
                entries,
                visible_total,
                raw_count,
            })
        }
        fn upload(&self, entries: &[Value]) -> Result<(), ApiError> {
            if self.upload_fails {
                return Err(ApiError::new(502, "fixture", "upload failed"));
            }
            self.uploads.borrow_mut().push(entries.to_vec());
            Ok(())
        }
        fn pause(&self, _: u64) -> Result<(), ApiError> {
            if self.cancelled {
                Err(ApiError::new(409, "cancelled", "stopped"))
            } else {
                Ok(())
            }
        }
        fn report(&self, _: &Summary) {}
    }

    #[test]
    fn monthly_union_probe_sparse_pages_limits_and_retry_match_retained_job() {
        let fixture = Fixture::default();
        let result = run(
            &fixture,
            vec!["0002".into(), "3".into(), "4".into(), "2".into()],
        )
        .unwrap();
        assert_eq!(
            (
                result.checked,
                result.refreshed,
                result.skipped,
                result.failed,
                result.uploaded
            ),
            (4, 1, 2, 1, 2)
        );
        assert_eq!(
            fixture
                .pages
                .borrow()
                .iter()
                .filter(|(id, _)| id == "4")
                .count(),
            4
        );
        assert_eq!(
            fixture
                .pages
                .borrow()
                .iter()
                .filter(|(id, page)| id == "2" && *page == 1)
                .count(),
            1,
            "probe is reused"
        );
        assert_eq!(
            fixture.uploads.borrow().as_slice(),
            &[vec![entry(3, "2"), entry(4, "2")]]
        );
    }

    #[test]
    fn monthly_batches_and_failed_upload_do_not_mark_missing_records_as_present() {
        let fixture = Fixture {
            bulk: true,
            ..Fixture::default()
        };
        let result = run(&fixture, vec!["2".into()]).unwrap();
        assert_eq!(result.uploaded, 600);
        assert_eq!(
            fixture
                .uploads
                .borrow()
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            vec![500, 100]
        );
        let mut known = HashSet::from(["BV0000000002".into()]);
        let before = known.clone();
        let fixture = Fixture {
            upload_fails: true,
            ..Fixture::default()
        };
        assert!(refresh_uid(&fixture, "2", &mut known).is_err());
        assert_eq!(known, before);
    }

    #[test]
    fn monthly_stopped_host_does_not_begin_network_work() {
        let fixture = Fixture {
            cancelled: true,
            ..Fixture::default()
        };
        assert_eq!(
            run(&fixture, vec!["2".into()]).unwrap_err().code,
            "cancelled"
        );
        assert!(fixture.pages.borrow().is_empty());
        assert!(fixture.uploads.borrow().is_empty());
    }
}
