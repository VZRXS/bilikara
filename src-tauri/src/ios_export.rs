//! Save-only UIKit adapter. Rust owns selection/rendering; Files owns the
//! destination. No caller path, URL, cookie or record crosses the WK bridge.
use crate::{
    ios_bridge_policy::{ExportOptions, HostFramePolicy},
    ios_platform::{HostWebView, reply_data},
};
use bilikara_runtime::native_host::NativePlaylistExporter;
use block2::RcBlock;
use objc2::{
    DefinedClass, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{NSObject, ProtocolObject},
};
use objc2_foundation::{MainThreadMarker, NSArray, NSObjectProtocol, NSOperationQueue, NSURL};
use objc2_ui_kit::{UIDocumentPickerDelegate, UIDocumentPickerViewController};
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    sync::Mutex,
};

struct Output {
    directory: PathBuf,
    file: PathBuf,
}
impl Drop for Output {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
struct Job {
    document: String,
    id: u32,
    view: Weak<HostWebView>,
    policy: HostFramePolicy,
    picker: Option<Retained<UIDocumentPickerViewController>>,
    _delegate: Option<Retained<SaveDelegate>>,
    output: Option<Output>,
}
thread_local! { static JOB: RefCell<Option<Job>> = const { RefCell::new(None) }; }
struct DelegateIvars {
    document: String,
    id: u32,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BilikaraExportSaveDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    struct SaveDelegate;
    unsafe impl NSObjectProtocol for SaveDelegate {}
    unsafe impl UIDocumentPickerDelegate for SaveDelegate {
        #[unsafe(method(documentPicker:didPickDocumentsAtURLs:))]
        fn picked(&self, _picker: &UIDocumentPickerViewController, urls: &NSArray<NSURL>) {
            let _keep_alive = self.retain();
            finish(
                &self.ivars().document,
                self.ivars().id,
                if urls.count() > 0 { "saved" } else { "failed" },
                (urls.count() == 0).then_some("系统保存没有返回文件位置，请重试"),
            );
        }
        #[unsafe(method(documentPickerWasCancelled:))]
        fn cancelled(&self, _picker: &UIDocumentPickerViewController) {
            let _keep_alive = self.retain();
            finish(&self.ivars().document, self.ivars().id, "cancelled", None);
        }
    }
);

fn notify(job: &Job, status: &str, error: Option<&str>) {
    let Some(view) = job.view.load() else {
        return;
    };
    let Some(url) = (unsafe { view.url() }).and_then(|v| v.absoluteString()) else {
        return;
    };
    if job
        .policy
        .allows(true, true, &url.to_string(), &url.to_string())
    {
        reply_data(
            &view,
            &job.document,
            job.id,
            Some(serde_json::json!({
                "status": status, "errorCode": error.map(|_| "ios_export_failed"), "errorMessage": error
            })),
        );
    }
}
fn finish(document: &str, id: u32, status: &str, error: Option<&str>) {
    let job = JOB.with(|cell| {
        let mut slot = cell.borrow_mut();
        if !slot
            .as_ref()
            .is_some_and(|j| j.document == document && j.id == id)
        {
            return None;
        }
        slot.take()
    });
    if let Some(job) = job {
        notify(&job, status, error);
    }
}
pub(crate) fn busy() -> bool {
    JOB.with(|cell| cell.borrow().is_some())
}

fn owned_directory(name: &str) -> bool {
    name.strip_prefix("export-")
        .and_then(|n| n.split_once('-'))
        .is_some_and(|(doc, id)| {
            doc.len() == 32
                && doc.bytes().all(|b| b.is_ascii_hexdigit())
                && id.parse::<u32>().is_ok()
        })
}
pub(crate) fn clean_stale(cache: &Path) {
    let Ok(entries) = std::fs::read_dir(cache) else {
        return;
    };
    for entry in entries.flatten() {
        if owned_directory(&entry.file_name().to_string_lossy())
            && entry
                .file_type()
                .is_ok_and(|t| t.is_dir() && !t.is_symlink())
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
fn prepare(
    exporter: NativePlaylistExporter,
    cache: PathBuf,
    document: &str,
    id: u32,
    options: ExportOptions,
) -> Result<Output, String> {
    let prepared = exporter.prepare(&options.format, &options.source, options.page_size)?;
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let directory = cache.join(format!("export-{document}-{id}"));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let output = Output {
        file: directory.join(&prepared.filename),
        directory,
    };
    std::fs::copy(prepared.path(), &output.file).map_err(|e| e.to_string())?;
    Ok(output)
}

pub(crate) fn start(
    view: &HostWebView,
    policy: HostFramePolicy,
    document: String,
    id: u32,
    options: ExportOptions,
    exporter: Option<NativePlaylistExporter>,
    cache: Option<PathBuf>,
) {
    let (Some(exporter), Some(cache)) = (exporter, cache) else {
        reply_data(view, &document, id, None);
        return;
    };
    if busy() {
        reply_data(view, &document, id, None);
        return;
    }
    JOB.with(|cell| {
        *cell.borrow_mut() = Some(Job {
            document: document.clone(),
            id,
            view: Weak::new(view),
            policy,
            picker: None,
            _delegate: None,
            output: None,
        })
    });
    // No UIKit/ObjC objects leave the main thread. The result is handed back
    // through Foundation's main queue, then checked against the active document.
    let worker_document = document.clone();
    let spawned = std::thread::Builder::new()
        .name("bilikara-ios-export".into())
        .spawn(move || {
            let document = worker_document;
            let result = Mutex::new(Some(prepare(exporter, cache, &document, id, options)));
            let callback = RcBlock::new(move || {
                let result = result.lock().unwrap().take();
                if let Some(result) = result {
                    prepared(&document, id, result);
                }
            });
            unsafe {
                NSOperationQueue::mainQueue().addOperationWithBlock(&callback);
            }
        });
    if let Err(error) = spawned {
        finish(&document, id, "failed", Some(&error.to_string()));
    }
}

fn prepared(document: &str, id: u32, result: Result<Output, String>) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let output = match result {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[playlist-export] stage=ios_prepare status=failed error={error}");
            finish(document, id, "failed", Some(&error));
            return;
        }
    };
    let presenting = JOB.with(|cell| {
        let mut slot = cell.borrow_mut();
        let job = slot
            .as_mut()
            .filter(|j| j.document == document && j.id == id)?;
        let view = job.view.load()?;
        let url = unsafe { view.url() }?.absoluteString()?;
        if !job
            .policy
            .allows(true, true, &url.to_string(), &url.to_string())
        {
            return None;
        }
        let controller = view.window()?.rootViewController()?;
        if controller.presentedViewController().is_some() {
            return None;
        }
        let url =
            NSURL::fileURLWithPath(&objc2_foundation::NSString::from_str(output.file.to_str()?));
        let picker = UIDocumentPickerViewController::initForExportingURLs_asCopy(
            UIDocumentPickerViewController::alloc(mtm),
            &NSArray::from_retained_slice(&[url]),
            true,
        );
        let delegate = mtm.alloc::<SaveDelegate>().set_ivars(DelegateIvars {
            document: document.into(),
            id,
        });
        let delegate: Retained<SaveDelegate> = unsafe { msg_send![super(delegate), init] };
        picker.setModalInPresentation(true);
        picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        job.picker = Some(picker.clone());
        job._delegate = Some(delegate);
        job.output = Some(output);
        Some((controller, picker))
    });
    let Some((controller, picker)) = presenting else {
        finish(
            document,
            id,
            "failed",
            Some("无法打开系统文件保存窗口，请先关闭其他系统窗口后重试"),
        );
        return;
    };
    let doc = document.to_owned();
    let ready = RcBlock::new(move || {
        JOB.with(|cell| {
            if let Some(job) = cell
                .borrow()
                .as_ref()
                .filter(|j| j.document == doc && j.id == id)
            {
                notify(job, "choosing", None);
            }
        })
    });
    controller.presentViewController_animated_completion(&picker, true, Some(&ready));
}

pub(crate) fn cancel(document: &str, id: Option<u32>, retire: bool) {
    let job = JOB.with(|cell| {
        let mut slot = cell.borrow_mut();
        let matches = slot.as_ref().is_some_and(|j| {
            if let Some(id) = id {
                j.document == document && j.id == id
            } else {
                (j.document == document) == retire
            }
        });
        if matches { slot.take() } else { None }
    });
    if let Some(mut job) = job
        && let Some(picker) = job.picker.take()
    {
        picker.setDelegate(None);
        // Keep the temporary file until dismissal completes; a late worker's
        // result is dropped independently and cannot present in another page.
        let output = RefCell::new(job.output.take());
        let done = RcBlock::new(move || {
            output.borrow_mut().take();
        });
        picker.dismissViewControllerAnimated_completion(false, Some(&done));
    }
}
