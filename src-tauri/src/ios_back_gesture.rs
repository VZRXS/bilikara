//! Native edge input drives the existing shared Settings transition. No native
//! navigation stack, additional WebView, route owner or media reparenting.
use crate::{
    ios_bridge_policy::{Dock, HostFramePolicy},
    ios_platform::HostWebView,
};
use objc2::{
    DefinedClass, MainThreadOnly, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{NSObject, ProtocolObject},
    sel,
};
use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSString};
use objc2_ui_kit::{
    UIGestureRecognizer, UIGestureRecognizerDelegate, UIGestureRecognizerState, UIRectEdge,
    UIScreenEdgePanGestureRecognizer, UITouch,
};
use std::cell::RefCell;

struct InputFacts {
    document: String,
    enabled: bool,
    width: f64,
    exclusions: Vec<[f64; 4]>,
}
struct Ivars {
    view: Weak<HostWebView>,
    policy: HostFramePolicy,
    facts: RefCell<InputFacts>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BilikaraSettingsEdgeInput"]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct EdgeInput;
    unsafe impl NSObjectProtocol for EdgeInput {}
    unsafe impl UIGestureRecognizerDelegate for EdgeInput {
        #[unsafe(method(gestureRecognizer:shouldReceiveTouch:))]
        fn receive(&self, _gesture: &UIGestureRecognizer, touch: &UITouch) -> bool {
            self.ivars().view.load().is_some_and(|view| {
                let facts = self.ivars().facts.borrow();
                let scale = view.bounds().size.width / facts.width;
                if !facts.enabled || !scale.is_finite() || scale <= 0.0 {return false;}
                let point = touch.locationInView(Some(&view));
                let (x,y) = (point.x/scale,point.y/scale);
                x <= 24.0 && !facts.exclusions.iter().any(|[left,top,width,height]|
                    x >= *left && x <= left+width && y >= *top && y <= top+height)
            })
        }
    }
    impl EdgeInput {
        #[unsafe(method(progress:))]
        fn progress(&self, gesture: &UIScreenEdgePanGestureRecognizer) {
            let Some(view) = self.ivars().view.load() else {return;};
            let facts = self.ivars().facts.borrow();
            let phase = match gesture.state() {
                UIGestureRecognizerState::Began => "began",
                UIGestureRecognizerState::Changed => "changed",
                UIGestureRecognizerState::Ended => "ended",
                UIGestureRecognizerState::Cancelled | UIGestureRecognizerState::Failed => "cancelled",
                _ => return,
            };
            if !facts.enabled && phase != "cancelled" {return;}
            let url = unsafe {view.url()}.and_then(|url|url.absoluteString());
            if !url.is_some_and(|url| self.ivars().policy.allows(true,true,&url.to_string(),&url.to_string())) {return;}
            let width = view.bounds().size.width;
            if !width.is_finite() || width <= 0.0 {return;}
            let progress = (gesture.translationInView(Some(&view)).x/width).clamp(0.0,1.0);
            let velocity = gesture.velocityInView(Some(&view)).x * facts.width/width;
            if !progress.is_finite() || !velocity.is_finite() {return;}
            let data = serde_json::json!({"document_id":facts.document,"phase":phase,"progress":progress,"velocity":velocity.clamp(-10000.0,10000.0)});
            unsafe {view.evaluate_script(&NSString::from_str(&format!("globalThis.BilikaraIosPlatform?._backGesture({data})")),None);}
        }
    }
);

pub(crate) struct NativeBack {
    view: Weak<HostWebView>,
    gesture: Retained<UIScreenEdgePanGestureRecognizer>,
    input: Retained<EdgeInput>,
}
impl NativeBack {
    pub fn new(view: &HostWebView, policy: HostFramePolicy, mtm: MainThreadMarker) -> Self {
        let input = mtm.alloc::<EdgeInput>().set_ivars(Ivars {
            view: Weak::new(view),
            policy,
            facts: RefCell::new(InputFacts {
                document: String::new(),
                enabled: false,
                width: 1.0,
                exclusions: vec![],
            }),
        });
        let input: Retained<EdgeInput> = unsafe { msg_send![super(input), init] };
        let gesture = unsafe {
            UIScreenEdgePanGestureRecognizer::initWithTarget_action(
                UIScreenEdgePanGestureRecognizer::alloc(mtm),
                Some(&input),
                Some(sel!(progress:)),
            )
        };
        gesture.setEdges(UIRectEdge::Left);
        gesture.setMaximumNumberOfTouches(1);
        gesture.setDelegate(Some(ProtocolObject::from_ref(&*input)));
        gesture.setEnabled(false);
        view.addGestureRecognizer(&gesture);
        Self {
            view: Weak::new(view),
            gesture,
            input,
        }
    }
    pub fn sync(&self, document: &str, facts: &Dock, available: bool) {
        let enabled = available
            && facts.back_enabled
            && facts.visible
            && facts.interactive
            && !facts.modal_covered;
        // Disable first so a UIKit cancellation still carries the old document.
        if !enabled {
            self.gesture.setEnabled(false);
        }
        *self.input.ivars().facts.borrow_mut() = InputFacts {
            document: document.into(),
            enabled,
            width: facts.viewport_width,
            exclusions: facts.back_exclusions.clone(),
        };
        if enabled {
            self.gesture.setEnabled(true);
        }
    }
    pub fn retire(&self) {
        self.gesture.setEnabled(false);
        self.input.ivars().facts.borrow_mut().enabled = false;
    }
}
impl Drop for NativeBack {
    fn drop(&mut self) {
        self.gesture.setEnabled(false);
        self.gesture.setDelegate(None);
        if let Some(view) = self.view.load() {
            view.removeGestureRecognizer(&self.gesture);
        }
    }
}
