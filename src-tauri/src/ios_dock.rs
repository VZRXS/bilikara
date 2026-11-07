//! A native presentation of the shared five-page navigation, never a second
//! controller/state machine. UIKit owns material, accessibility and hit testing.
use crate::{
    ios_bridge_policy::{Dock, HostFramePolicy},
    ios_platform::HostWebView,
};
use objc2::{
    DefinedClass, MainThreadOnly, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{Bool, NSObject, ProtocolObject},
};
use objc2_foundation::{
    MainThreadMarker, NSArray, NSObjectProtocol, NSPoint as CGPoint, NSRect as CGRect,
    NSSize as CGSize, NSString,
};
use objc2_ui_kit::{
    UIColor, UIImage, UITabBar, UITabBarDelegate, UITabBarItem, UIUserInterfaceStyle,
};

struct SelectionIvars {
    view: Weak<HostWebView>,
    document: String,
    policy: HostFramePolicy,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[name = "BilikaraDockSelection"]
    #[thread_kind = MainThreadOnly]
    #[ivars = SelectionIvars]
    struct Selection;
    unsafe impl NSObjectProtocol for Selection {}
    unsafe impl UITabBarDelegate for Selection {
        #[unsafe(method(tabBar:didSelectItem:))]
        fn selected(&self, bar: &UITabBar, item: &UITabBarItem) {
            if bar.isHidden() || !bar.isUserInteractionEnabled() || !(0..5).contains(&item.tag()) {
                return;
            }
            let Some(view) = self.ivars().view.load() else {
                return;
            };
            let Some(url) = (unsafe { view.url() }).and_then(|v| v.absoluteString()) else {
                return;
            };
            if !self
                .ivars()
                .policy
                .allows(true, true, &url.to_string(), &url.to_string())
            {
                return;
            }
            let payload =
                serde_json::json!({"document_id":self.ivars().document,"index":item.tag()});
            unsafe {
                view.evaluate_script(
                    &NSString::from_str(&format!(
                        "globalThis.BilikaraIosPlatform?._dockSelected({payload})"
                    )),
                    None,
                );
            }
        }
    }
);

pub(crate) struct NativeDock {
    bar: Retained<UITabBar>,
    _selection: Retained<Selection>,
    labels: Vec<String>,
    sequence: u32,
}
impl NativeDock {
    pub fn hide(&self) {
        self.bar.setHidden(true);
    }
    pub fn remove(self) {
        self.bar.setDelegate(None);
        self.bar.removeFromSuperview();
    }
}
pub(crate) fn sync(
    slot: &mut Option<NativeDock>,
    view: &HostWebView,
    policy: &HostFramePolicy,
    document: &str,
    facts: &Dock,
) -> Option<f64> {
    // Older systems retain the existing accessible Web dock, not fake Glass.
    if !objc2::available!(ios = 26.0) {
        return None;
    }
    let mtm = MainThreadMarker::from(view);
    let parent = view.superview()?;
    if slot.is_none() {
        let bar = UITabBar::new(mtm);
        bar.setHidden(true);
        let selection = mtm.alloc::<Selection>().set_ivars(SelectionIvars {
            view: Weak::new(view),
            document: document.into(),
            policy: policy.clone(),
        });
        let selection: Retained<Selection> = unsafe { msg_send![super(selection), init] };
        bar.setDelegate(Some(ProtocolObject::from_ref(&*selection)));
        parent.addSubview(&bar);
        *slot = Some(NativeDock {
            bar,
            _selection: selection,
            labels: vec![],
            sequence: 0,
        });
    }
    let native = slot.as_mut()?;
    let bar = &native.bar;
    if facts.sequence > 0 && facts.sequence < native.sequence {
        return None;
    }
    native.sequence = facts.sequence;
    if native.labels != facts.labels {
        let symbols = [
            "play.circle",
            "list.bullet",
            "magnifyingglass",
            "person.2",
            "person.crop.circle",
        ];
        let items: Vec<_> = facts
            .labels
            .iter()
            .zip(symbols)
            .enumerate()
            .map(|(index, (title, symbol))| {
                let image = UIImage::systemImageNamed(&NSString::from_str(symbol));
                UITabBarItem::initWithTitle_image_tag(
                    mtm.alloc(),
                    Some(&NSString::from_str(title)),
                    image.as_deref(),
                    index as isize,
                )
            })
            .collect();
        bar.setItems(Some(&NSArray::from_retained_slice(&items)));
        native.labels.clone_from(&facts.labels);
    }
    if let Some(items) = bar.items() {
        bar.setSelectedItem(Some(&items.objectAtIndex(facts.selected)));
    }
    bar.setOverrideUserInterfaceStyle(if facts.dark {
        UIUserInterfaceStyle::Dark
    } else {
        UIUserInterfaceStyle::Light
    });
    let [r, g, b] = facts.accent.map(|v| f64::from(v) / 255.0);
    // UIKit objects are main-thread retained; tint is a concrete UIColor.
    unsafe {
        bar.setTintColor(Some(&UIColor::colorWithRed_green_blue_alpha(r, g, b, 1.0)));
    }
    let bounds = view.bounds();
    let scale = bounds.size.width / facts.viewport_width;
    if !scale.is_finite() || scale <= 0.0 {
        native.hide();
        return None;
    }
    let height = bar
        .sizeThatFits(CGSize::new(bounds.size.width, 0.0))
        .height
        .max(49.0 + view.safeAreaInsets().bottom);
    if !(49.0..=160.0).contains(&height) {
        native.hide();
        return None;
    }
    let rect = CGRect::new(
        CGPoint::new(0.0, bounds.size.height - height),
        CGSize::new(bounds.size.width, height),
    );
    bar.setFrame(view.convertRect_toView(rect, Some(&parent)));
    bar.setUserInteractionEnabled(facts.interactive && facts.visible && !facts.modal_covered);
    unsafe {
        let _: () = msg_send![&**bar, setAccessibilityElementsHidden: Bool::new(facts.modal_covered || !facts.visible)];
    }
    bar.setAlpha(if facts.modal_covered { 0.45 } else { 1.0 });
    bar.setHidden(!facts.visible);
    Some(height / scale)
}
