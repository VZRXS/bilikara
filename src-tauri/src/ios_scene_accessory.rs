//! iOS 27 scene-accessory registration, scoped to the existing Host controller.
//! Public selectors are dynamically guarded because objc2's pinned SDK bindings
//! predate this API. Older systems keep the existing automatic Scene route.
use crate::ios_platform::HostWebView;
use objc2::{
    msg_send,
    rc::{Retained, Weak},
    runtime::{AnyClass, AnyObject, Bool},
    sel,
};
use objc2_foundation::{NSObjectProtocol, NSString};
use objc2_ui_kit::UIViewController;

pub(crate) const TARGET: &str = "ios-external-accessory";
pub(crate) struct Accessory {
    controller: Weak<UIViewController>,
    registration: Retained<AnyObject>,
}
impl Accessory {
    pub fn register(view: &HostWebView) -> Option<Self> {
        if !objc2::available!(ios = 27.0) {
            return None;
        }
        let controller = view.window()?.rootViewController()?;
        let class = AnyClass::get(c"UISceneAccessory")?;
        let configuration = AnyClass::get(c"UISceneConfiguration")?;
        if !controller.respondsToSelector(sel!(registerSceneAccessory:))
            || !controller.respondsToSelector(sel!(unregisterSceneAccessory:))
        {
            return None;
        }
        unsafe {
            let supported: Bool = msg_send![class, respondsToSelector: sel!(externalNonInteractiveSceneAccessoryWithConfiguration:)];
            if !supported.as_bool() {
                return None;
            }
            let config: Retained<AnyObject> = msg_send![configuration,
                configurationWithName: &*NSString::from_str("Audience"),
                sessionRole: &*NSString::from_str("UIWindowSceneSessionRoleExternalDisplayNonInteractive")];
            let accessory: Retained<AnyObject> =
                msg_send![class, externalNonInteractiveSceneAccessoryWithConfiguration: &*config];
            let registration: Retained<AnyObject> =
                msg_send![&*controller, registerSceneAccessory: &*accessory];
            let value = Self {
                controller: Weak::new(&*controller),
                registration,
            };
            // Discovery must not take over mirroring; only explicit activation
            // enables the registration. Availability is independent of enablement.
            value.enable(false);
            Some(value)
        }
    }
    pub fn available(&self) -> bool {
        unsafe {
            let value: Bool = msg_send![&*self.registration, isAvailable];
            value.as_bool()
        }
    }
    pub fn enabled(&self) -> bool {
        unsafe {
            let value: Bool = msg_send![&*self.registration, isEnabled];
            value.as_bool()
        }
    }
    pub fn enable(&self, value: bool) {
        unsafe {
            let _: () = msg_send![&*self.registration, setEnabled: Bool::new(value)];
        }
    }
}
impl Drop for Accessory {
    fn drop(&mut self) {
        if let Some(controller) = self.controller.load() {
            unsafe {
                let _: () = msg_send![&*controller, unregisterSceneAccessory: &*self.registration];
            }
        }
    }
}
