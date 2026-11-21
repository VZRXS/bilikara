//! Narrow UIKit operations from this process's Host main WKWebView. No Tauri
//! remote IPC permission, arbitrary URL opener or parallel business authority.
use crate::ios_bridge_policy::{DocumentSession, HostFramePolicy, Request, login_url, qr_web_url, video_url};
use block2::RcBlock;
use objc2::{
    DeclaredClass, MainThreadOnly, define_class, extern_class, extern_conformance, extern_methods,
    msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, Bool, NSObject, ProtocolObject},
    sel,
};
use objc2_foundation::{
    MainThreadMarker, NSDictionary, NSError, NSObjectProtocol, NSString, NSURL, ns_string,
};
use objc2_ui_kit::{UIApplication, UIResponder, UIView};
use objc2_web_kit::{
    WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebViewConfiguration,
};
use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};

// objc2-web-kit 0.3.2 exports WKWebView only for AppKit. Bind only the public
// iOS selectors we use, with its actual UIKit superclass.
extern_class!(
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[name = "WKWebView"]
    #[thread_kind = MainThreadOnly]
    pub(crate) struct HostWebView;
);
extern_conformance!(
    unsafe impl NSObjectProtocol for HostWebView {}
);
impl HostWebView {
    extern_methods!(
        #[unsafe(method(configuration))]
        #[unsafe(method_family = none)]
        pub unsafe fn configuration(&self) -> Retained<WKWebViewConfiguration>;
        #[unsafe(method(URL))]
        #[unsafe(method_family = none)]
        pub unsafe fn url(&self) -> Option<Retained<NSURL>>;
        #[unsafe(method(evaluateJavaScript:completionHandler:))]
        #[unsafe(method_family = none)]
        pub unsafe fn evaluate_script(
            &self,
            script: &NSString,
            completion: Option<&block2::DynBlock<dyn Fn(*mut AnyObject, *mut NSError)>>,
        );
    );
}

struct Pending {
    document: String,
    id: u32,
    deadline: Instant,
}
pub(crate) struct BridgeIvars {
    view: Weak<HostWebView>,
    exporter: Option<bilikara_runtime::native_host::NativePlaylistExporter>,
    export_cache: Option<std::path::PathBuf>,
    json_client: Option<bilikara_runtime::native_host::NativeJsonClient>,
    policy: HostFramePolicy,
    pending: Rc<RefCell<Option<Pending>>>,
    fullscreen: RefCell<Option<crate::ios_fullscreen::Fullscreen>>,
    document: RefCell<DocumentSession>,
    dock: RefCell<Option<crate::ios_dock::NativeDock>>,
    back: crate::ios_back_gesture::NativeBack,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BilikaraIosHostBridge"]
    #[thread_kind = MainThreadOnly]
    #[ivars = BridgeIvars]
    pub(crate) struct HostBridge;
    unsafe impl NSObjectProtocol for HostBridge {}
    unsafe impl WKScriptMessageHandler for HostBridge {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn received(&self, controller: &WKUserContentController, message: &WKScriptMessage) {
            // SAFETY: WK invokes its handler on the main thread. All retained
            // framework objects enclose this callback; source identity comes
            // from WKFrameInfo/WKScriptMessage, never JavaScript fields.
            unsafe {
                let ivars = self.ivars();
                let Some(view) = ivars.view.load() else {
                    return;
                };
                // objc2-web-kit 0.3.2 incorrectly gates the public iOS webView
                // accessor to macOS; dispatch that documented property directly.
                let sender: Option<Retained<HostWebView>> = msg_send![message, webView];
                let same = sender
                    .as_ref()
                    .is_some_and(|sender| std::ptr::eq(&**sender, &*view));
                let frame = message.frameInfo();
                let origin = frame.securityOrigin();
                let Some(source) = frame.request().URL().and_then(|url| url.absoluteString())
                else {
                    return;
                };
                let Some(current) = view.url().and_then(|url| url.absoluteString()) else {
                    return;
                };
                if !std::ptr::eq(&*view.configuration().userContentController(), controller)
                    || !ivars.policy.allows_origin(
                        &origin.protocol().to_string(),
                        &origin.host().to_string(),
                        origin.port() as i64,
                    )
                    || !ivars.policy.allows(
                        frame.isMainFrame(),
                        same,
                        &source.to_string(),
                        &current.to_string(),
                    )
                {
                    return;
                }
                let Ok(body) = message.body().downcast::<NSString>() else {
                    return;
                };
                if body.length() > 600 * 1024 {
                    return;
                }
                let Ok(request) = Request::parse(&body.to_string()) else {
                    return;
                };
                let repeated_document = request.action == "document"
                    && ivars.document.borrow().is_current(&request.document_id);
                if !ivars.document.borrow_mut().accept(&request) || repeated_document {
                    return;
                }
                crate::ios_fullscreen::reconcile(
                    &mut ivars.fullscreen.borrow_mut(),
                    &request.document_id,
                    request.action == "retire",
                );
                if matches!(request.action.as_str(), "document" | "retire") {
                    crate::ios_export::cancel(
                        &request.document_id,
                        None,
                        request.action == "retire",
                    );
                    crate::ios_http::cancel(&request.document_id, None, request.action == "retire");
                    ivars.back.retire();
                    if let Some(dock) = ivars.dock.borrow_mut().take() {
                        dock.remove();
                    }
                    let mut pending = ivars.pending.borrow_mut();
                    if pending.as_ref().is_some_and(|old| {
                        (old.document == request.document_id) == (request.action == "retire")
                    }) {
                        *pending = None;
                    }
                    return;
                }
                if request.action == "save-history" {
                    if ivars.pending.borrow().is_some() {
                        reply_data(&view, &request.document_id, request.id, None);
                    } else {
                        crate::ios_export::start(
                            &view,
                            ivars.policy.clone(),
                            request.document_id,
                            request.id,
                            request.export.unwrap(),
                            ivars.exporter.clone(),
                            ivars.export_cache.clone(),
                        );
                    }
                    return;
                }
                if request.action == "request-json" {
                    crate::ios_http::start(
                        &view,
                        ivars.policy.clone(),
                        request.document_id,
                        request.id,
                        request.json_request.unwrap(),
                        ivars.json_client.clone(),
                    );
                    return;
                }
                if request.action == "sync-dock" {
                    let height = crate::ios_dock::sync(
                        &mut ivars.dock.borrow_mut(),
                        &view,
                        &ivars.policy,
                        &request.document_id,
                        request.dock.as_ref().unwrap(),
                    );
                    ivars.back.sync(
                        &request.document_id,
                        request.dock.as_ref().unwrap(),
                        height.is_some(),
                    );
                    reply_data(
                        &view,
                        &request.document_id,
                        request.id,
                        height
                            .map(|height| serde_json::json!({"height":height,"native_back":true})),
                    );
                    return;
                }
                if request.action == "set-player-fullscreen" {
                    let active = request.active.unwrap(); // validated wire shape
                    let success = crate::ios_fullscreen::set(
                        &mut ivars.fullscreen.borrow_mut(),
                        &view,
                        &request.document_id,
                        request.id,
                        active,
                    );
                    if success
                        && active
                        && let Some(dock) = ivars.dock.borrow().as_ref()
                    {
                        dock.hide();
                    }
                    reply_data(
                        &view,
                        &request.document_id,
                        request.id,
                        success.then(|| serde_json::json!({"active":active})),
                    );
                    return;
                }
                let mut pending = ivars.pending.borrow_mut();
                if request.action == "cancel" {
                    crate::ios_export::cancel(&request.document_id, Some(request.id), false);
                    crate::ios_http::cancel(&request.document_id, Some(request.id), false);
                    crate::ios_fullscreen::cancel(
                        &mut ivars.fullscreen.borrow_mut(),
                        &request.document_id,
                        request.id,
                    );
                    if pending.as_ref().is_some_and(|old| {
                        old.document == request.document_id && old.id == request.id
                    }) {
                        *pending = None;
                    }
                    return;
                }
                // A new document or an expired callback can never block or
                // mutate a later page. Keep only one UIKit opener in flight.
                if pending.as_ref().is_some_and(|old| {
                    old.document != request.document_id || old.deadline <= Instant::now()
                }) {
                    *pending = None;
                }
                let url = request
                    .url
                    .as_deref()
                    .and_then(|value| match request.action.as_str() {
                        "open-bilibili-login" => login_url(value).ok(),
                        "open-bilibili-video" => video_url(value).ok(),
                        "open-qr-web-link" => qr_web_url(value),
                        _ => None,
                    });
                if pending.is_some() || crate::ios_export::busy() || url.is_none() {
                    drop(pending);
                    reply(&view, &request.document_id, request.id, false);
                    return;
                }
                let Some(url) =
                    NSURL::URLWithString(&NSString::from_str(url.as_ref().unwrap().as_str()))
                else {
                    drop(pending);
                    reply(&view, &request.document_id, request.id, false);
                    return;
                };
                *pending = Some(Pending {
                    document: request.document_id.clone(),
                    id: request.id,
                    deadline: Instant::now() + Duration::from_secs(15),
                });
                drop(pending);
                let state = ivars.pending.clone();
                let weak_view = ivars.view.clone();
                let policy = ivars.policy.clone();
                let document = request.document_id;
                let id = request.id;
                let completion = RcBlock::new(move |opened: Bool| {
                    // UIApplication delivers this completion on the main
                    // thread; reject unexpected execution rather than use UI
                    // objects from a foreign thread.
                    if MainThreadMarker::new().is_none() {
                        return;
                    }
                    let mut pending = state.borrow_mut();
                    if !pending
                        .as_ref()
                        .is_some_and(|old| old.document == document && old.id == id)
                    {
                        return;
                    }
                    let live = pending
                        .take()
                        .is_some_and(|old| old.deadline > Instant::now());
                    drop(pending);
                    let Some(view) = weak_view.load() else {
                        return;
                    };
                    let Some(current) = view.url().and_then(|url| url.absoluteString()) else {
                        return;
                    };
                    if live && policy.allows(true, true, &current.to_string(), &current.to_string())
                    {
                        reply(&view, &document, id, opened.as_bool());
                    }
                });
                UIApplication::sharedApplication(MainThreadMarker::from(self))
                    .openURL_options_completionHandler(
                        &url,
                        &NSDictionary::new(),
                        Some(&completion),
                    );
            }
        }
    }
);

fn reply(view: &HostWebView, document: &str, id: u32, opened: bool) {
    reply_data(
        view,
        document,
        id,
        opened.then(|| serde_json::json!({"opened":true})),
    );
}

pub(crate) fn reply_data(
    view: &HostWebView,
    document: &str,
    id: u32,
    data: Option<serde_json::Value>,
) {
    let payload = serde_json::json!({"schema_version":1,"document_id":document,"id":id,"ok":data.is_some(),"data":data});
    let script = format!("globalThis.BilikaraIosPlatform?._receive({payload})");
    // SAFETY: only the validated native-created WKWebView receives fixed
    // JSON-encoded facts. No URL, credentials or raw NSError is interpolated.
    unsafe {
        view.evaluate_script(&NSString::from_str(&script), None);
    }
}

pub(crate) fn initialization_script(policy: &HostFramePolicy) -> String {
    include_str!("../../static/ios-platform.js")
        .replace(
            "\"__BILIKARA_IOS_ORIGIN__\"",
            &serde_json::to_string(&policy.origin()).unwrap(),
        )
        .replace("\"__BILIKARA_IOS_HTTP__\"", "\"enabled\"")
}

// Live scroll-view policy applies to this owned main/audience view only.
// It preserves scrolling, system accessibility zoom and every other recognizer.
pub(crate) fn constrain_owned_view(view: &HostWebView) {
    unsafe {
        let scroll: Retained<AnyObject> = msg_send![view, scrollView];
        // iOS 26 adds a system scroll-edge shadow behind transparent content.
        // Hide only this owned view's top edge effect through public API;
        // older systems retain their existing behavior and native tab material.
        let available: Bool = msg_send![&*scroll, respondsToSelector: sel!(topEdgeEffect)];
        if available.as_bool() {
            let effect: Option<Retained<AnyObject>> = msg_send![&*scroll, topEdgeEffect];
            if let Some(effect) = effect {
                let _: () = msg_send![&*effect, setHidden: Bool::YES];
            }
        }
        let pinch: Option<Retained<AnyObject>> = msg_send![&*scroll, pinchGestureRecognizer];
        if let Some(pinch) = pinch {
            let _: () = msg_send![&*pinch, setEnabled: Bool::NO];
        }
        let _: () = msg_send![&*scroll, setMinimumZoomScale: 1.0f64];
        let _: () = msg_send![&*scroll, setMaximumZoomScale: 1.0f64];
    }
}

pub(crate) fn install(
    view: &HostWebView,
    policy: HostFramePolicy,
    exporter: Option<bilikara_runtime::native_host::NativePlaylistExporter>,
    export_cache: Option<std::path::PathBuf>,
    json_client: Option<bilikara_runtime::native_host::NativeJsonClient>,
    mtm: MainThreadMarker,
) {
    constrain_owned_view(view);
    if let Some(controller) = view.window().and_then(|window| window.rootViewController()) {
        let traits: Retained<AnyObject> = unsafe { msg_send![view, traitCollection] };
        let idiom: isize = unsafe { msg_send![&*traits, userInterfaceIdiom] };
        if idiom == 0 {
            crate::ios_fullscreen::set_orientations(&controller, 2);
        }
    }
    let bridge = mtm.alloc::<HostBridge>().set_ivars(BridgeIvars {
        view: Weak::new(view),
        exporter,
        export_cache,
        json_client,
        back: crate::ios_back_gesture::NativeBack::new(view, policy.clone(), mtm),
        policy,
        pending: Rc::new(RefCell::new(None)),
        fullscreen: RefCell::new(None),
        document: RefCell::new(DocumentSession::default()),
        dock: RefCell::new(None),
    });
    // SAFETY: NSObject initialization and a unique handler name on the new
    // main view's controller. The controller retains the delegate, which holds
    // only a weak WebView reference, so the view cannot retain itself.
    unsafe {
        let bridge: Retained<HostBridge> = msg_send![super(bridge), init];
        view.configuration()
            .userContentController()
            .addScriptMessageHandler_name(
                ProtocolObject::from_ref(&*bridge),
                ns_string!("bilikaraPlatform"),
            );
    }
}
