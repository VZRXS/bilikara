//! In-app immersive UI only. Tao owns its existing UIViewController; we use
//! the pinned shell's status-bar setters and restore their previous values.
use crate::ios_platform::HostWebView;
use block2::RcBlock;
use objc2::{
    msg_send,
    rc::{Retained, Weak},
    runtime::{AnyClass, AnyObject, Bool},
    sel,
};
use objc2_foundation::{NSError, NSObjectProtocol};
use objc2_ui_kit::UIViewController;

pub(crate) struct Fullscreen {
    document: String,
    request_id: u32,
    controller: Weak<UIViewController>,
    status_bar_hidden: bool,
    home_hidden: Option<bool>,
    orientations: usize,
}

pub(crate) fn restore(state: &mut Option<Fullscreen>) {
    drop(state.take());
}

impl Drop for Fullscreen {
    fn drop(&mut self) {
        let Some(controller) = self.controller.load() else {
            return;
        };
        // SAFETY: setters were checked on this exact Tao controller when entering.
        // Calls run only in the main-thread WK handler; no global UIApplication
        // status-bar mutation or private Apple selector is used.
        set_orientations(&controller, self.orientations);
        unsafe {
            let _: () = msg_send![&*controller, setPrefersStatusBarHidden: Bool::new(self.status_bar_hidden)];
            if let Some(hidden) = self.home_hidden {
                let _: () =
                    msg_send![&*controller, setPrefersHomeIndicatorAutoHidden: Bool::new(hidden)];
            }
        }
    }
}

// The pinned Tao controller exposes a supported-orientation setter. Keep its
// mask scoped to fullscreen; no controller replacement or private UIDevice KVC.
pub(crate) fn set_orientations(controller: &UIViewController, mask: usize) {
    if !controller.respondsToSelector(sel!(setSupportedInterfaceOrientations:)) {
        return;
    }
    unsafe {
        let _: () = msg_send![controller, setSupportedInterfaceOrientations: mask];
        if controller.respondsToSelector(sel!(setNeedsUpdateOfSupportedInterfaceOrientations)) {
            let _: () = msg_send![controller, setNeedsUpdateOfSupportedInterfaceOrientations];
        }
        let Some(scene) = controller
            .view()
            .and_then(|v| v.window())
            .and_then(|w| w.windowScene())
        else {
            return;
        };
        let Some(class) = AnyClass::get(c"UIWindowSceneGeometryPreferencesIOS") else {
            return;
        };
        if !scene.respondsToSelector(sel!(requestGeometryUpdateWithPreferences:errorHandler:)) {
            return;
        }
        let preferences: Retained<AnyObject> = msg_send![class, new];
        let _: () = msg_send![&*preferences, setInterfaceOrientations: mask];
        let failed = RcBlock::new(|error: *mut NSError| {
            // Bound the diagnostic to the numeric UIKit code, never error text.
            if let Some(error) = error.as_ref() {
                eprintln!("ios_orientation_geometry_rejected:{}", error.code());
            }
        });
        let _: () = msg_send![&*scene, requestGeometryUpdateWithPreferences: &*preferences, errorHandler: &*failed];
    }
}

// objc2 0.3.2 propagates this getter's visionOS-only deprecation to iOS.
// It is the documented, supported iOS appearance query on our Tao controller.
#[allow(deprecated)]
fn status_bar_hidden(controller: &UIViewController) -> bool {
    controller.prefersStatusBarHidden()
}

pub(crate) fn reconcile(state: &mut Option<Fullscreen>, document: &str, retire: bool) {
    if state
        .as_ref()
        .is_some_and(|old| (old.document == document) == retire)
    {
        restore(state);
    }
}

pub(crate) fn cancel(state: &mut Option<Fullscreen>, document: &str, request_id: u32) {
    if state
        .as_ref()
        .is_some_and(|old| old.document == document && old.request_id == request_id)
    {
        restore(state);
    }
}

pub(crate) fn set(
    state: &mut Option<Fullscreen>,
    view: &HostWebView,
    document: &str,
    request_id: u32,
    active: bool,
) -> bool {
    if !active {
        restore(state);
        return true;
    }
    if state
        .as_ref()
        .is_some_and(|old| old.document == document && old.controller.load().is_some())
    {
        state.as_mut().unwrap().request_id = request_id;
        return true;
    }
    restore(state);
    // This view's scene/window identifies the controller. Never use the
    // deprecated global keyWindow, which could select another iPad scene.
    let Some(controller) = view.window().and_then(|window| window.rootViewController()) else {
        return false;
    };
    if !controller.respondsToSelector(sel!(setPrefersStatusBarHidden:)) {
        return false;
    }
    let old = Fullscreen {
        document: document.to_owned(),
        request_id,
        controller: Weak::new(&*controller),
        status_bar_hidden: status_bar_hidden(&controller),
        orientations: unsafe { msg_send![&*controller, supportedInterfaceOrientations] },
        home_hidden: controller
            .respondsToSelector(sel!(setPrefersHomeIndicatorAutoHidden:))
            .then(|| controller.prefersHomeIndicatorAutoHidden()),
    };
    // SAFETY: the Tao setters above are supported by the retained, pinned
    // controller. They request UIKit appearance updates on the main thread.
    unsafe {
        let _: () = msg_send![&*controller, setPrefersStatusBarHidden: Bool::YES];
        if old.home_hidden.is_some() {
            let _: () = msg_send![&*controller, setPrefersHomeIndicatorAutoHidden: Bool::YES];
        }
    }
    // Portrait + both landscapes; iPad retains its existing system/window mask.
    set_orientations(&controller, old.orientations | 2 | 8 | 16);
    *state = Some(old);
    let entered = status_bar_hidden(&controller);
    if !entered {
        restore(state);
    }
    entered
}
