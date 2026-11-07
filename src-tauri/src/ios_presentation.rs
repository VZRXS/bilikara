//! UIKit external scenes render the shared, muted audience compositor. The
//! original Host retains audio, playback authority and all business state.
use crate::ios_bridge_policy::{DocumentSession, HostFramePolicy};
use crate::ios_platform::HostWebView;
use crate::ios_presentation_policy::{
    EXTERNAL_ROLES, IdentifierOptions, Request, Role, Session, identifier_frame,
};
use crate::ios_scene_accessory::{Accessory, TARGET};
use block2::{DynBlock, RcBlock};
use objc2::{
    DeclaredClass, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyClass, AnyObject, Bool, NSObject, ProtocolObject},
};
use objc2_foundation::{
    MainThreadMarker, NSError, NSNotificationCenter, NSObjectProtocol, NSOperationQueue,
    NSPoint as CGPoint, NSRect as CGRect, NSSize as CGSize, NSString, NSTimer, NSURL, NSURLRequest,
    NSUserDefaults, ns_string,
};
use objc2_ui_kit::{
    NSTextAlignment, UIApplication, UIApplicationState, UIColor, UICoordinateSpace, UIFont,
    UILabel, UIScreen, UIView, UIViewAutoresizing, UIViewController, UIWindow, UIWindowScene,
};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKScriptMessage,
    WKScriptMessageHandler, WKUserContentController, WKUserScript, WKUserScriptInjectionTime,
    WKWebViewConfiguration,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    time::{Duration, Instant},
};

thread_local! { static OUTPUT: RefCell<Option<Presentation>> = const { RefCell::new(None) }; }

fn with_output<T>(f: impl FnOnce(&mut Presentation) -> T) -> Option<T> {
    OUTPUT.with(|cell| cell.try_borrow_mut().ok()?.as_mut().map(f))
}

fn main_scene(mtm: MainThreadMarker) -> Option<Retained<UIWindowScene>> {
    UIApplication::sharedApplication(mtm)
        .connectedScenes()
        .iter()
        .find_map(|scene| {
            (scene.session().role().to_string() == "UIWindowSceneSessionRoleApplication")
                .then(|| scene.downcast_ref::<UIWindowScene>().map(|s| s.retain()))
                .flatten()
        })
}

pub(crate) fn bound(view: &HostWebView) -> bool {
    with_output(|p| p.host.load().is_some_and(|host| std::ptr::eq(&*host, view))).unwrap_or(false)
}

fn reply(view: &HostWebView, document: &str, payload: &Value) {
    let script = format!(
        "globalThis.BilikaraIosPresentationReceiver?.reply({},{payload})",
        json!(document)
    );
    unsafe {
        view.evaluate_script(&NSString::from_str(&script), None);
    }
}

pub(crate) fn main_scene_available() -> bool {
    MainThreadMarker::new().is_some_and(|mtm| main_scene(mtm).is_some())
}

// Tao can enumerate an empty external scene first. Never let that decision
// place the controller there: build hidden and attach explicitly to the app
// scene before making the main window visible. Never create a second Host.
pub(crate) fn attach_main(view: &HostWebView, mtm: MainThreadMarker) -> bool {
    let Some(scene) = main_scene(mtm) else {
        return false;
    };
    let Some(window) = view.window() else {
        return false;
    };
    window.setWindowScene(Some(&scene));
    #[allow(deprecated)]
    window.setFrame(scene.coordinateSpace().bounds());
    window.makeKeyAndVisible();
    true
}

fn scenes(mtm: MainThreadMarker) -> Vec<(String, Retained<UIWindowScene>)> {
    let controller = main_scene(mtm).map(|s| s.screen());
    let mut scenes: Vec<_> = UIApplication::sharedApplication(mtm)
        .connectedScenes()
        .iter()
        .filter_map(|scene| {
            if !EXTERNAL_ROLES.contains(&scene.session().role().to_string().as_str()) {
                return None;
            }
            scene
                .downcast_ref::<UIWindowScene>()
                .filter(|window| {
                    !controller
                        .as_ref()
                        .is_some_and(|screen| std::ptr::eq(&**screen, &*window.screen()))
                })
                .map(|window| {
                    (
                        scene.session().persistentIdentifier().to_string(),
                        window.retain(),
                    )
                })
        })
        .collect();
    scenes.sort_by(|a, b| a.0.cmp(&b.0));
    scenes.truncate(16);
    scenes
}

pub(crate) fn initialization_script(policy: &HostFramePolicy, generation: u64) -> String {
    include_str!("../../static/ios-presentation.js")
        .replace(
            "\"__BILIKARA_PRESENTATION_ORIGIN__\"",
            &json!(policy.origin()).to_string(),
        )
        .replace(
            "__BILIKARA_PRESENTATION_GENERATION__",
            &generation.to_string(),
        )
}

struct IdentifierWindow {
    scene_id: String,
    window: Retained<UIWindow>,
}
struct IdentifierRequest {
    document: String,
    id: String,
    options: IdentifierOptions,
    started: Instant,
    shown_at: Option<Instant>,
    enabled_accessory: bool,
}

fn identifier_scene_frame(scene: &UIWindowScene) -> Result<CGRect, &'static str> {
    #[allow(deprecated)]
    let bounds = scene.coordinateSpace().bounds();
    let safe = scene
        .windows()
        .iter()
        .find(|w| !w.isHidden())
        .map(|w| w.safeAreaInsets());
    let inset = safe.map_or([0.; 4], |s| [s.top, s.right, s.bottom, s.left]);
    let [x, y, width, height] = identifier_frame(
        [
            bounds.origin.x,
            bounds.origin.y,
            bounds.size.width,
            bounds.size.height,
        ],
        inset,
    )
    .ok_or("display_unavailable")?;
    Ok(CGRect::new(CGPoint::new(x, y), CGSize::new(width, height)))
}
fn identifier_color(value: [u8; 4]) -> Retained<UIColor> {
    unsafe {
        UIColor::colorWithRed_green_blue_alpha(
            f64::from(value[0]) / 255.,
            f64::from(value[1]) / 255.,
            f64::from(value[2]) / 255.,
            f64::from(value[3]) / 255.,
        )
    }
}
fn system_version() -> Option<String> {
    let class = AnyClass::get(c"UIDevice")?;
    let version: Retained<NSString> = unsafe {
        let device: Retained<AnyObject> = msg_send![class, currentDevice];
        msg_send![&*device, systemVersion]
    };
    let value = version.to_string();
    (value.len() <= 32 && value.chars().all(|c| c.is_ascii_digit() || c == '.')).then_some(value)
}
fn identifier_card(
    scene: &UIWindowScene,
    number: u8,
    host: bool,
    options: &IdentifierOptions,
    mtm: MainThreadMarker,
) -> Result<Retained<UIWindow>, &'static str> {
    let frame = identifier_scene_frame(scene)?;
    let size = frame.size.width;
    let card = UIView::initWithFrame(
        UIView::alloc(mtm),
        CGRect::new(CGPoint::new(0., 0.), frame.size),
    );
    card.setBackgroundColor(Some(&identifier_color(options.colors.outline)));
    let fill = UIView::initWithFrame(
        UIView::alloc(mtm),
        CGRect::new(CGPoint::new(1., 1.), CGSize::new(size - 2., size - 2.)),
    );
    fill.setBackgroundColor(Some(&identifier_color(options.colors.fill)));
    unsafe {
        for (view, radius) in [(&card, 14_f64), (&fill, 13_f64)] {
            let layer: Retained<AnyObject> = msg_send![&**view, layer];
            let _: () = msg_send![&*layer, setCornerRadius:radius];
            let _: () = msg_send![&*layer, setMasksToBounds:Bool::YES];
        }
    }
    card.addSubview(&fill);
    let accent = UIView::initWithFrame(
        UIView::alloc(mtm),
        CGRect::new(CGPoint::new(16., 0.), CGSize::new(32., 3.)),
    );
    accent.setBackgroundColor(Some(&identifier_color(options.colors.accent)));
    fill.addSubview(&accent);
    let label = UILabel::initWithFrame(
        UILabel::alloc(mtm),
        CGRect::new(CGPoint::new(16., 10.), CGSize::new(size - 34., size - 48.)),
    );
    label.setText(Some(&NSString::from_str(&number.to_string())));
    label.setTextAlignment(NSTextAlignment::Left);
    unsafe {
        label.setFont(Some(&UIFont::boldSystemFontOfSize(
            (size * 0.48).clamp(52., 62.),
        )));
        label.setTextColor(Some(&identifier_color(options.colors.ink)));
    }
    fill.addSubview(&label);
    let role = UILabel::initWithFrame(
        UILabel::alloc(mtm),
        CGRect::new(CGPoint::new(16., size - 41.), CGSize::new(size - 34., 30.)),
    );
    role.setText(Some(&NSString::from_str(options.role_label(host))));
    role.setTextAlignment(NSTextAlignment::Left);
    unsafe {
        role.setFont(Some(&UIFont::boldSystemFontOfSize(12.)));
        role.setTextColor(Some(&identifier_color(options.colors.muted)));
        role.setNumberOfLines(2);
    }
    fill.addSubview(&role);
    let controller = UIViewController::new(mtm);
    controller.setView(Some(&card));
    let window = UIWindow::initWithWindowScene(UIWindow::alloc(mtm), scene);
    window.setBackgroundColor(Some(&UIColor::clearColor()));
    window.setFrame(frame);
    window.setRootViewController(Some(&controller));
    window.setUserInteractionEnabled(false);
    window.setAlpha(if options.reduce_motion { 1. } else { 0. });
    window.setHidden(false);
    Ok(window)
}

struct Presentation {
    host: Weak<HostWebView>,
    identifiers: Vec<IdentifierWindow>,
    identifier_reply: Option<IdentifierRequest>,
    policy: HostFramePolicy,
    host_document: Option<String>,
    stage_document: Option<String>,
    session: Session,
    window: Option<Retained<UIWindow>>,
    stage: Option<Retained<HostWebView>>,
    master: Option<Value>,
    diagnostics: Value,
    navigation_failure: Option<i64>,
    displays_key: String,
    foreground: bool,
    last_master: Instant,
    activation_at: Instant,
    accessory: Option<Accessory>,
    accessory_request: Option<(String, String, Instant)>,
    timer: Option<Retained<NSTimer>>,
    observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

impl Presentation {
    fn emit(&self, view: &HostWebView, document: Option<&str>, name: &str, value: &Value) {
        let Some(document) = document else {
            return;
        };
        let script = format!(
            "globalThis.BilikaraIosPresentationReceiver?.event({},{},{})",
            json!(document),
            json!(name),
            value
        );
        // Fixed JSON serialization only. Neither scene contents nor credentials
        // are interpolated into executable JavaScript or written to a log.
        unsafe {
            view.evaluate_script(&NSString::from_str(&script), None);
        }
    }
    fn host_event(&self, name: &str, value: &Value) {
        if let Some(host) = self.host.load() {
            self.emit(&host, self.host_document.as_deref(), name, value);
        }
    }
    fn stage_event(&self, name: &str, value: &Value) {
        if let Some(stage) = &self.stage {
            self.emit(stage, self.stage_document.as_deref(), name, value);
        }
    }
    fn notify(&self) {
        let value = json!({"session":self.session.snapshot()});
        self.host_event("bilikara-presentation-state", &value);
        self.stage_event("bilikara-presentation-state", &value);
    }
    fn close_identifiers(&mut self, error: Option<&str>) {
        for IdentifierWindow { window, .. } in self.identifiers.drain(..) {
            window.setHidden(true);
            window.setRootViewController(None);
            window.setWindowScene(None);
        }
        if let Some(request) = self.identifier_reply.take() {
            if request.enabled_accessory
                && self.session.target.is_none()
                && self.accessory_request.is_none()
                && let Some(accessory) = &self.accessory
            {
                accessory.enable(false);
            }
            self.diagnostics["identification"] = json!({"outcome":error.unwrap_or("shown"),"temporary_accessory":request.enabled_accessory,"theme":request.options.theme});
            if self.host_document.as_deref() != Some(&request.document) {
                return;
            }
            let Some(host) = self.host.load() else {
                return;
            };
            let id = request.id;
            let payload = match error {
                Some(code) => json!({"id":id,"ok":false,"error":code}),
                None => json!({"id":id,"ok":true,"data":null}),
            };
            reply(&host, &request.document, &payload);
        }
    }
    fn identify(
        &mut self,
        request: &Request,
        mtm: MainThreadMarker,
    ) -> Result<Value, &'static str> {
        if UIApplication::sharedApplication(mtm).applicationState() != UIApplicationState::Active {
            return Err("display_background");
        }
        if self.identifier_reply.is_some()
            || self.accessory_request.is_some()
            || self.session.target.is_some()
        {
            return Err("display_busy");
        }
        let options = IdentifierOptions::parse(&request.args)?;
        let external = scenes(mtm);
        let waiting = options.display_ids.iter().any(|id| id == TARGET) && external.is_empty();
        if options.display_ids.iter().any(|id| {
            id != "ios-host" && id != TARGET && !external.iter().any(|(key, _)| key == id)
        }) || (options.display_ids.iter().any(|id| id == TARGET) && external.len() > 1)
            || (waiting && !self.accessory.as_ref().is_some_and(Accessory::available))
        {
            return Err("display_unavailable");
        }
        self.identifier_reply = Some(IdentifierRequest {
            document: request.document_id.clone(),
            id: request.id.clone().ok_or("display_request")?,
            options,
            started: Instant::now(),
            shown_at: None,
            enabled_accessory: waiting,
        });
        if waiting {
            if let Some(accessory) = &self.accessory {
                accessory.enable(true);
            }
        } else if let Err(error) = self.show_identifiers(mtm) {
            self.close_identifiers(Some(error));
        }
        Ok(Value::Null)
    }
    fn show_identifiers(&mut self, mtm: MainThreadMarker) -> Result<(), &'static str> {
        let request = self.identifier_reply.as_ref().ok_or("display_request")?;
        let mut available = scenes(mtm);
        let external = available.first().map(|(id, _)| id.clone());
        if let Some(scene) = main_scene(mtm) {
            available.insert(0, ("ios-host".into(), scene));
        }
        for requested in &request.options.display_ids {
            let id = if requested == TARGET {
                external.as_deref().ok_or("display_unavailable")?
            } else {
                requested.as_str()
            };
            let scene = &available
                .iter()
                .find(|(key, _)| key == id)
                .ok_or("display_unavailable")?
                .1;
            let window = identifier_card(
                scene,
                request.options.display_numbers[requested],
                id == "ios-host",
                &request.options,
                mtm,
            )?;
            self.identifiers.push(IdentifierWindow {
                scene_id: id.to_owned(),
                window,
            });
        }
        self.identifier_reply.as_mut().unwrap().shown_at = Some(Instant::now());
        Ok(())
    }
    fn finish_accessory_request(&mut self, result: Result<Value, &'static str>) {
        if let Some((document, id, _)) = self.accessory_request.take()
            && self.host_document.as_deref() == Some(&document)
            && let Some(host) = self.host.load()
        {
            let payload = match result {
                Ok(value) => json!({"id":id,"ok":true,"data":value}),
                Err(error) => json!({"id":id,"ok":false,"error":error}),
            };
            reply(&host, &document, &payload);
        }
    }
    fn stop(&mut self, reason: &'static str) {
        self.close_identifiers(Some("display_operation_cancelled"));
        self.finish_accessory_request(Err("display_operation_cancelled"));
        if let Some(accessory) = &self.accessory {
            accessory.enable(false);
        }
        self.session.stop(reason);
        self.master = None;
        self.stage_document = None;
        if let Some(stage) = self.stage.take() {
            unsafe {
                let _: () = msg_send![&*stage, stopLoading];
            }
        }
        if let Some(window) = self.window.take() {
            window.setHidden(true);
            window.setRootViewController(None);
            window.setWindowScene(None);
        }
        self.notify();
    }
    fn displays(&self, mtm: MainThreadMarker) -> Value {
        let available = scenes(mtm);
        let mut list = Vec::new();
        if let Some(scene) = main_scene(mtm) {
            #[allow(deprecated)]
            let bounds = scene.coordinateSpace().bounds();
            list.push(json!({"id":"ios-host","name":"iOS","width":bounds.size.width,"height":bounds.size.height,
                "scaleFactor":scene.screen().scale(),"builtIn":true,"controller":true,"primary":true,
                "selectable":false,"mirrored":false,"identityStable":true,"identityQuality":"stable"}));
        }
        for (index, (id, scene)) in available.iter().enumerate() {
            #[allow(deprecated)]
            let bounds = scene.coordinateSpace().bounds();
            let screen = scene.screen();
            list.push(json!({"id":id,"replacesDisplayId":TARGET,"name":format!("External display {}", index + 1),
                "width":bounds.size.width,"height":bounds.size.height,"positionX":0,"positionY":0,"scaleFactor":screen.scale(),
                "builtIn":false,"controller":false,"primary":false,"selectable":true,"mirrored":false,"identityStable":true,"identityQuality":"stable"}));
        }
        if available.is_empty() && self.accessory.as_ref().is_some_and(Accessory::available) {
            // This is the system's available accessory capability, not a
            // fabricated connected Scene or an audio-route inference.
            list.push(json!({"id":TARGET,"name":"External display","width":0,"height":0,
                "builtIn":false,"controller":false,"primary":false,"selectable":true,"mirrored":false,
                "identityStable":false,"identityQuality":"pending","requiresConnection":true,"identifiable":false,"identificationRequiresConnection":true}));
        }
        // Extra screens alone do not prove an independent scene. Audio routes
        // are not used as display evidence at all.
        #[allow(deprecated)]
        let mirror = available.is_empty() && UIScreen::screens(mtm).len() > 1;
        let recommended = list
            .iter()
            .find(|v| v["selectable"] == true)
            .and_then(|v| v["id"].as_str());
        json!({"displays":list,"monitorCount":list.len(),"controllerDisplayId":"ios-host",
            "preferRecommendedOnDisconnect":true,
            "recommendedDisplayId":recommended,
            "discoveryStatus":if recommended.is_some(){"available"}else if objc2::available!(ios = 27.0) && self.accessory.is_none(){"failed"}else if mirror{"mirroring_only"}else{"no_targets"}})
    }
    fn tick(&mut self, mtm: MainThreadMarker) {
        if self.host.load().is_none() {
            self.stop("hostClosed");
            return;
        }
        let foreground =
            UIApplication::sharedApplication(mtm).applicationState() == UIApplicationState::Active;
        if self.foreground != foreground {
            self.foreground = foreground;
            if !foreground {
                self.close_identifiers(Some("display_background"));
            }
            self.last_master = Instant::now();
            let value = json!({"foreground":foreground});
            self.host_event("foreground", &value);
            self.stage_event("foreground", &value);
            if foreground {
                self.host_event(
                    "bilikara-presentation-output-request",
                    &json!({"generation":self.session.generation}),
                );
            }
        }
        if let Some(request) = &self.identifier_reply {
            if let Some(shown) = request.shown_at {
                if shown.elapsed() >= Duration::from_secs(3) {
                    self.close_identifiers(None);
                } else {
                    let age = shown.elapsed().as_secs_f64();
                    let alpha = if request.options.reduce_motion {
                        1.
                    } else {
                        (age / 0.2).min((3. - age) / 0.3).clamp(0., 1.)
                    };
                    for record in &self.identifiers {
                        if (record.window.alpha() - alpha).abs() > 0.001 {
                            record.window.setAlpha(alpha);
                        }
                    }
                }
            } else if !scenes(mtm).is_empty() {
                if let Err(error) = self.show_identifiers(mtm) {
                    self.close_identifiers(Some(error));
                }
            } else if request.started.elapsed() >= Duration::from_secs(5) {
                self.close_identifiers(Some("display_scene_timeout"));
            }
        }
        if self.accessory_request.is_some() {
            if let Some((id, _)) = scenes(mtm).first() {
                let result = self.activate(id, mtm);
                let failed = result.is_err();
                self.finish_accessory_request(result);
                if failed {
                    self.stop("outputCreateFailed");
                }
            } else if self
                .accessory_request
                .as_ref()
                .is_some_and(|(_, _, at)| at.elapsed() >= Duration::from_secs(10))
            {
                if let Some(accessory) = &self.accessory {
                    accessory.enable(false);
                }
                self.finish_accessory_request(Err("display_scene_timeout"));
            }
        }
        let displays = self.displays(mtm);
        let key = displays.to_string();
        if key != self.displays_key {
            self.displays_key = key;
            // Reuse the existing display-change boundary for geometry; an
            // identifier's lifetime/fade ticks do not poll/rewrite its layout.
            if self
                .identifier_reply
                .as_ref()
                .is_some_and(|r| r.shown_at.is_some())
            {
                let mut available = scenes(mtm);
                if let Some(scene) = main_scene(mtm) {
                    available.push(("ios-host".into(), scene));
                }
                let mut detached = false;
                for record in &self.identifiers {
                    if let Some((_, scene)) =
                        available.iter().find(|(id, _)| id == &record.scene_id)
                    {
                        if let Ok(frame) = identifier_scene_frame(scene) {
                            if record.window.frame() != frame {
                                record.window.setFrame(frame);
                            }
                        } else {
                            detached = true;
                        }
                    } else {
                        detached = true;
                    }
                }
                if detached {
                    self.close_identifiers(Some("displayDisconnected"));
                }
            }
            self.host_event("displays-changed", &displays);
        }
        if let Some(target) = &self.session.target {
            if !scenes(mtm).iter().any(|a| &a.0 == target) {
                self.stop("displayDisconnected");
            } else if self.session.phase() == "activating"
                && self.activation_at.elapsed() > Duration::from_secs(15)
            {
                self.stop("outputTimeout");
            } else if foreground
                && self.session.phase() == "active"
                && self.last_master.elapsed() > Duration::from_secs(5)
            {
                self.stop("outputHeartbeatLost");
            }
        }
    }
    fn activate(&mut self, id: &str, mtm: MainThreadMarker) -> Result<Value, &'static str> {
        self.foreground =
            UIApplication::sharedApplication(mtm).applicationState() == UIApplicationState::Active;
        if !self.foreground {
            return Err("display_background");
        }
        let scene = scenes(mtm)
            .into_iter()
            .find(|(key, _)| key == id)
            .ok_or("display_unavailable")?
            .1;
        // Reject any attachment to the physical controller display, even if
        // the OS unexpectedly supplies an external-role scene for it.
        if let Some(host) = self.host.load().and_then(|v| v.window())
            && std::ptr::eq(&*host.screen(), &*scene.screen())
        {
            return Err("display_is_controller");
        }
        let generation = self.session.activate(id.into())?;
        if let Some(accessory) = &self.accessory {
            accessory.enable(true);
        }
        self.activation_at = Instant::now();
        self.last_master = Instant::now();
        self.master = None;
        self.stage_document = None;
        let expected = format!(
            "{}/controller.html?presentationGeneration={generation}",
            self.policy.origin()
        );
        self.navigation_failure = None;
        // SAFETY: UIKit and WK objects are created/retained on the main thread.
        // Only the native-created local audience URL is loaded. This visible
        // external window is never used to manufacture discovery eligibility.
        unsafe {
            let config = WKWebViewConfiguration::new(mtm);
            // Share the Host's actual cookie store, including a nonpersistent
            // store, before the audience's first local request.
            let host = self.host.load().ok_or("host_closed")?;
            config.setWebsiteDataStore(&host.configuration().websiteDataStore());
            let _: () = msg_send![&*config, setAllowsInlineMediaPlayback: true];
            let _: () = msg_send![&*config, setAllowsPictureInPictureMediaPlayback: Bool::NO];
            config.setMediaTypesRequiringUserActionForPlayback(
                objc2_web_kit::WKAudiovisualMediaTypes::None,
            );
            config
                .preferences()
                .setJavaScriptCanOpenWindowsAutomatically(false);
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(mtm),
                &NSString::from_str(&initialization_script(&self.policy, generation)),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            );
            config.userContentController().addUserScript(&script);
            #[allow(deprecated)]
            let frame = scene.coordinateSpace().bounds();
            let stage: Retained<HostWebView> =
                msg_send![HostWebView::alloc(mtm), initWithFrame: frame, configuration: &*config];
            crate::ios_platform::constrain_owned_view(&stage);
            stage.setAutoresizingMask(
                UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
            );
            stage.setBackgroundColor(Some(&UIColor::blackColor()));
            stage.setUserInteractionEnabled(false);
            let handler = handler(&stage, self.policy.clone(), Role::Audience(generation), mtm);
            config.userContentController().addScriptMessageHandler_name(
                ProtocolObject::from_ref(&*handler),
                ns_string!("bilikaraPresentation"),
            );
            let delegate: &ProtocolObject<dyn WKNavigationDelegate> =
                ProtocolObject::from_ref(&*handler);
            let _: () = msg_send![&*stage, setNavigationDelegate: delegate];
            let controller = UIViewController::new(mtm);
            // UIKit sizes the root view in the external scene's coordinate
            // space. Adding an external-sized subview to a controller's
            // initially phone-sized default view applies the parent resize
            // delta a second time, cropping the page to its upper-left corner.
            controller.setView(Some(&stage));
            let window = UIWindow::initWithWindowScene(UIWindow::alloc(mtm), &scene);
            window.setFrame(frame);
            window.setRootViewController(Some(&controller));
            self.stage = Some(stage.clone());
            self.window = Some(window.clone());
            window.setHidden(false); // Audience must never become the key window.
            let url = NSURL::URLWithString(&NSString::from_str(&expected)).ok_or("display_url")?;
            let request = NSURLRequest::requestWithURL(&url);
            let _: Option<Retained<AnyObject>> = msg_send![&*stage, loadRequest: &*request];
        }
        self.notify();
        Ok(self.session.snapshot())
    }
    fn request(
        &mut self,
        request: &Request,
        role: Role,
        mtm: MainThreadMarker,
    ) -> Result<Value, &'static str> {
        if let Role::Audience(generation) = role {
            self.session.check(generation)?;
        }
        let a = &request.args;
        match request.command.as_str() {
            "get_presentation_displays" => Ok(self.displays(mtm)),
            "get_presentation_session" => Ok(self.session.snapshot()),
            "activate_local_presentation" => {
                if self.identifier_reply.is_some() {
                    return Err("display_busy");
                }
                if a["displayId"].as_str() == Some(TARGET) {
                    if self.accessory_request.is_some() || self.session.target.is_some() {
                        return Err("display_busy");
                    }
                    let accessory = self
                        .accessory
                        .as_ref()
                        .filter(|v| v.available())
                        .ok_or("display_unavailable")?;
                    self.accessory_request = Some((
                        request.document_id.clone(),
                        request.id.clone().ok_or("display_request")?,
                        Instant::now(),
                    ));
                    accessory.enable(true);
                    return Ok(Value::Null); // reply after Scene attachment, not before
                }
                let before = self.session.generation;
                let result = self.activate(a["displayId"].as_str().ok_or("display_request")?, mtm);
                if result.is_err() && self.session.generation != before {
                    self.stop("outputCreateFailed");
                }
                result
            }
            "deactivate_local_presentation" => {
                self.session
                    .check(a["generation"].as_u64().ok_or("stale_generation")?)?;
                self.stop("userStopped");
                Ok(self.session.snapshot())
            }
            "mark_presentation_host_ready" | "mark_presentation_controller_ready" => {
                self.session.ready(
                    role,
                    a["generation"].as_u64().ok_or("stale_generation")?,
                    a["composition"].as_str(),
                )?;
                self.notify();
                if role != Role::Host {
                    self.stage_event("foreground", &json!({"foreground":self.foreground}));
                    if let Some(master) = &self.master {
                        self.stage_event("master-state", master);
                    }
                    self.host_event(
                        "bilikara-presentation-output-request",
                        &json!({"generation":self.session.generation}),
                    );
                }
                Ok(self.session.snapshot())
            }
            "publish_presentation_playback_state" => {
                self.session
                    .check(a["generation"].as_u64().ok_or("stale_generation")?)?;
                Ok(Value::Null)
            }
            "master-state" => {
                self.session.master(a)?;
                self.last_master = Instant::now();
                self.master = Some(a.clone());
                if self.foreground && self.session.output_ready {
                    self.stage_event("master-state", a);
                }
                Ok(Value::Null)
            }
            "output-diagnostics" => {
                let mut value = serde_json::Map::new();
                for key in [
                    "drift_ms",
                    "current_time",
                    "ready_state",
                    "dropped_frames",
                    "total_frames",
                    "error_code",
                ] {
                    if let Some(n) = a[key].as_f64().filter(|n| n.is_finite()) {
                        value.insert(key.into(), json!(n));
                    }
                }
                for key in ["paused", "seeking", "stale"] {
                    if a[key].is_boolean() {
                        value.insert(key.into(), a[key].clone());
                    }
                }
                self.diagnostics = Value::Object(value);
                self.host_event("output-diagnostics", &self.diagnostics);
                if a["error_code"].as_u64().is_some_and(|n| n > 0) {
                    self.stop("outputMediaFailed");
                }
                Ok(Value::Null)
            }
            "get_playback_restart_hint_seen" => Ok(json!(
                NSUserDefaults::standardUserDefaults()
                    .boolForKey(ns_string!("playback-restart-v1"))
            )),
            "mark_playback_restart_hint_seen" => {
                NSUserDefaults::standardUserDefaults()
                    .setBool_forKey(true, ns_string!("playback-restart-v1"));
                Ok(json!(true))
            }
            "show_presentation_display_identifiers" => self.identify(request, mtm),
            "dismiss_presentation_display_identifiers" => {
                self.close_identifiers(None);
                Ok(Value::Null)
            }
            "diagnostics" => {
                #[allow(deprecated)]
                let screen_count = UIScreen::screens(mtm).len();
                Ok(
                    json!({"session":self.session.snapshot(),"foreground":self.foreground,"output":self.diagnostics,
                    "os_version":system_version(),"ui_screen_count":screen_count,
                    "navigation_failure_code":self.navigation_failure,
                    "accessory_supported":objc2::available!(ios = 27.0),"accessory_registered":self.accessory.is_some(),
                    "accessory_available":self.accessory.as_ref().is_some_and(Accessory::available),
                    "accessory_enabled":self.accessory.as_ref().is_some_and(Accessory::enabled),
                    "external_scene_count":scenes(mtm).len()}),
                )
            }
            _ => Err("unsupported_command"),
        }
    }
}

impl Drop for Presentation {
    fn drop(&mut self) {
        unsafe {
            if let Some(timer) = &self.timer {
                timer.invalidate();
            }
            let center = NSNotificationCenter::defaultCenter();
            for token in &self.observers {
                center.removeObserver(AsRef::<AnyObject>::as_ref(&**token));
            }
        }
        self.stop("hostClosed");
    }
}

pub(crate) struct HandlerIvars {
    view: Weak<HostWebView>,
    policy: HostFramePolicy,
    role: Role,
    document: RefCell<DocumentSession>,
}

fn allowed_url(policy: &HostFramePolicy, role: Role, value: &str) -> bool {
    match role {
        Role::Host => policy.allows(true, true, value, value),
        Role::Audience(generation) => {
            value
                == format!(
                    "{}/controller.html?presentationGeneration={generation}",
                    policy.origin()
                )
        }
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BilikaraIosPresentationBridge"]
    #[thread_kind = MainThreadOnly]
    #[ivars = HandlerIvars]
    pub(crate) struct Handler;
    unsafe impl NSObjectProtocol for Handler {}
    unsafe impl WKScriptMessageHandler for Handler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn receive(&self, controller: &WKUserContentController, message: &WKScriptMessage) {
            let ivars = self.ivars();
            let Some(view) = ivars.view.load() else { return; };
            // WK's frame, WebView identity and security origin are native facts;
            // a packet's fields cannot authorize a Remote, iframe or old page.
            unsafe {
                let sender: Option<Retained<HostWebView>> = msg_send![message, webView];
                let frame = message.frameInfo();
                let origin = frame.securityOrigin();
                let source = frame.request().URL().and_then(|u|u.absoluteString());
                let current = view.url().and_then(|u|u.absoluteString());
                if !frame.isMainFrame() || !sender.is_some_and(|s|std::ptr::eq(&*s,&*view))
                    || !std::ptr::eq(&*view.configuration().userContentController(),controller)
                    || !ivars.policy.allows_origin(&origin.protocol().to_string(), &origin.host().to_string(), origin.port() as i64)
                    || !source.is_some_and(|s|allowed_url(&ivars.policy,ivars.role,&s.to_string()))
                    || !current.is_some_and(|s|allowed_url(&ivars.policy,ivars.role,&s.to_string())) { return; }
                let Ok(body) = message.body().downcast::<NSString>() else { return; };
                if body.length() > 2 * 1024 * 1024 { return; }
                let Ok(request) = Request::parse(&body.to_string(),ivars.role) else { return; };
                if !ivars.document.borrow_mut().accept_message(&request.document_id,&request.command) { return; }
                let result = with_output(|p| {
                    if request.command == "document" {
                        match ivars.role {
                            Role::Host => {
                                if p.host_document.as_ref().is_some_and(|d|d != &request.document_id) { p.stop("hostReloaded"); }
                                p.host_document = Some(request.document_id.clone());
                            }
                            Role::Audience(generation) => { p.session.check(generation)?; p.stage_document = Some(request.document_id.clone()); }
                        }
                        return Ok(Value::Null);
                    }
                    if request.command == "retire" {
                        if ivars.role == Role::Host { p.host_document = None; p.stop("hostReloaded"); }
                        else if let Role::Audience(generation) = ivars.role { p.session.check(generation)?; p.stop("outputReloaded"); }
                        return Ok(Value::Null);
                    }
                    p.request(&request,ivars.role,MainThreadMarker::from(self))
                });
                // The identify Promise resolves only after the native windows
                // close, so the shared UI busy guard tracks the real operation.
                if request.command == "show_presentation_display_identifiers" && matches!(result,Some(Ok(_))) { return; }
                if request.command == "activate_local_presentation" && matches!(result,Some(Ok(Value::Null))) { return; }
                if let Some(id) = request.id {
                    let payload = match result.unwrap_or(Err("display_busy")) {
                        Ok(value) => json!({"id":id,"ok":true,"data":value}),
                        Err(code) => json!({"id":id,"ok":false,"error":code}),
                    };
                    reply(&view, &request.document_id, &payload);
                }
            }
        }
    }
    unsafe impl WKNavigationDelegate for Handler {}
    impl Handler {
        // objc2-web-kit gates WKWebView delegate arguments to macOS. Bind the
        // documented UIKit selectors on our narrow HostWebView class instead.
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn navigate(&self, view: &HostWebView, action: &WKNavigationAction, decide: &DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
            let valid = self.ivars().view.load().is_some_and(|v|std::ptr::eq(&*v,view))
                && unsafe { action.request().URL().and_then(|u|u.absoluteString()) }.is_some_and(|url|allowed_url(&self.ivars().policy,self.ivars().role,&url.to_string()));
            decide.call((if valid {WKNavigationActionPolicy::Allow} else {WKNavigationActionPolicy::Cancel},));
        }
        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn failed(&self, _view: &HostWebView, _navigation: Option<&AnyObject>, error: &NSError) {
            if let Role::Audience(generation) = self.ivars().role { let _ = with_output(|p|if p.session.check(generation).is_ok(){
                // Numeric code only: no URL, receiver identity or NSError text.
                p.navigation_failure=Some(error.code() as i64);
                p.stop("outputLoadFailed")
            }); }
        }
        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn terminated(&self, _view: &HostWebView) {
            if let Role::Audience(generation) = self.ivars().role { let _ = with_output(|p|if p.session.check(generation).is_ok(){p.stop("outputRendererGone")}); }
        }
    }
);

fn handler(
    view: &HostWebView,
    policy: HostFramePolicy,
    role: Role,
    mtm: MainThreadMarker,
) -> Retained<Handler> {
    let value = mtm.alloc::<Handler>().set_ivars(HandlerIvars {
        view: Weak::new(view),
        policy,
        role,
        document: RefCell::new(DocumentSession::default()),
    });
    unsafe { msg_send![super(value), init] }
}

pub(crate) fn install(view: &HostWebView, policy: HostFramePolicy, mtm: MainThreadMarker) {
    let handler = handler(view, policy.clone(), Role::Host, mtm);
    unsafe {
        view.configuration()
            .userContentController()
            .addScriptMessageHandler_name(
                ProtocolObject::from_ref(&*handler),
                ns_string!("bilikaraPresentation"),
            );
    }
    let mut manager = Presentation {
        host: Weak::new(view),
        identifiers: Vec::new(),
        identifier_reply: None,
        policy,
        host_document: None,
        stage_document: None,
        session: Session::default(),
        window: None,
        stage: None,
        master: None,
        diagnostics: json!({}),
        navigation_failure: None,
        displays_key: String::new(),
        foreground: true,
        last_master: Instant::now(),
        activation_at: Instant::now(),
        accessory: Accessory::register(view),
        accessory_request: None,
        timer: None,
        observers: Vec::new(),
    };
    let tick = RcBlock::new(|_| {
        if let Some(mtm) = MainThreadMarker::new() {
            let _ = with_output(|p| p.tick(mtm));
        }
    });
    // A health/lease timer, not a layout-measurement loop. Notifications below
    // handle attachment/background changes immediately; missed reentrant calls
    // are reconciled by this bounded check.
    manager.timer =
        Some(unsafe { NSTimer::scheduledTimerWithTimeInterval_repeats_block(1.0, true, &tick) });
    unsafe {
        for name in [
            "UISceneWillConnectNotification",
            "UISceneDidActivateNotification",
            "UISceneDidDisconnectNotification",
            "UISceneWillDeactivateNotification",
            "UIScreenDidConnectNotification",
            "UIScreenDidDisconnectNotification",
            "UIScreenModeDidChangeNotification",
            "UIApplicationDidBecomeActiveNotification",
            "UIApplicationWillResignActiveNotification",
            "UIApplicationDidEnterBackgroundNotification",
            "UIApplicationWillEnterForegroundNotification",
        ] {
            let block = RcBlock::new(|_| {
                if let Some(mtm) = MainThreadMarker::new() {
                    let _ = with_output(|p| p.tick(mtm));
                }
            });
            manager.observers.push(
                NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                    Some(&NSString::from_str(name)),
                    None,
                    Some(&NSOperationQueue::mainQueue()),
                    &block,
                ),
            );
        }
    }
    OUTPUT.with(|cell| *cell.borrow_mut() = Some(manager));
}

pub(crate) fn scene_changed() {
    if let Some(mtm) = MainThreadMarker::new() {
        let _ = with_output(|p| p.tick(mtm));
    }
}
