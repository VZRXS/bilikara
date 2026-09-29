//! Windows fullscreen shell adaptation. Tao's undecorated maximized window
//! otherwise calculates its client area from rcWork. Keep every fullscreen
//! resize at rcMonitor and restore the placement captured before changing flags.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Placement {
    flags: u32,
    show: u32,
    minimum: [i32; 2],
    maximum: [i32; 2],
    normal: [i32; 4],
}

pub(crate) trait Window {
    fn is_fullscreen(&self) -> Result<bool, String>;
    fn placement(&self) -> Result<Placement, String>;
    fn set_fullscreen_frame(&self, enabled: bool) -> Result<(), String>;
    fn set_fullscreen(&self, enabled: bool) -> Result<(), String>;
    fn restore_placement(&self, placement: Placement) -> Result<(), String>;
}

#[derive(Default)]
pub(crate) struct FullscreenState {
    restore: Option<Placement>,
}

impl FullscreenState {
    pub(crate) fn set(&mut self, window: &impl Window, enabled: bool) -> Result<(), String> {
        if enabled {
            if window.is_fullscreen()? {
                return Ok(());
            }
            // A failed exit may have left placement restoration pending. Finish
            // it before capturing another entry, rather than saving fullscreen bounds.
            if self.restore.is_some() {
                self.set(window, false)?;
            }
            let placement = window.placement()?;
            window.set_fullscreen_frame(true)?;
            self.restore = Some(placement);
            if let Err(error) = window.set_fullscreen(true) {
                window
                    .set_fullscreen_frame(false)
                    .map_err(|restore_error| {
                        format!("{error}; failed to restore window frame: {restore_error}")
                    })?;
                window
                    .restore_placement(placement)
                    .map_err(|restore_error| {
                        format!("{error}; failed to restore window placement: {restore_error}")
                    })?;
                self.restore = None;
                return Err(error);
            }
        } else {
            window.set_fullscreen_frame(false)?;
            if let Err(error) = window.set_fullscreen(false) {
                window.set_fullscreen_frame(true).map_err(|restore_error| {
                    format!("{error}; failed to retain fullscreen frame: {restore_error}")
                })?;
                return Err(error);
            }
            if let Some(placement) = self.restore {
                window.restore_placement(placement)?;
                self.restore = None;
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Window for tauri::WebviewWindow {
    fn is_fullscreen(&self) -> Result<bool, String> {
        self.is_fullscreen().map_err(|error| error.to_string())
    }
    fn placement(&self) -> Result<Placement, String> {
        native::placement(self.hwnd().map_err(|error| error.to_string())?.0)
    }
    fn set_fullscreen_frame(&self, enabled: bool) -> Result<(), String> {
        native::set_frame(self.hwnd().map_err(|error| error.to_string())?.0, enabled)
    }
    fn set_fullscreen(&self, enabled: bool) -> Result<(), String> {
        self.set_fullscreen(enabled)
            .map_err(|error| error.to_string())
    }
    fn restore_placement(&self, placement: Placement) -> Result<(), String> {
        native::restore(self.hwnd().map_err(|error| error.to_string())?.0, placement)
    }
}

#[cfg(target_os = "windows")]
pub(crate) mod native {
    use super::Placement;
    use std::ffi::c_void;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::{
            Dwm::{DWMWA_TRANSITIONS_FORCEDISABLED, DwmFlush, DwmSetWindowAttribute},
            Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow},
        },
        UI::Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        UI::WindowsAndMessaging::{
            GetWindowPlacement, SWP_NOMOVE, SWP_NOSIZE, SetWindowPlacement, WINDOWPLACEMENT,
            WINDOWPOS, WM_NCCALCSIZE, WM_NCDESTROY, WM_WINDOWPOSCHANGING,
        },
    };

    const SUBCLASS: usize = 0x424b4653;

    fn last_error(operation: &str) -> String {
        format!("{operation}: {}", std::io::Error::last_os_error())
    }

    pub(super) fn placement(hwnd: HWND) -> Result<Placement, String> {
        let mut value: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
        value.length = std::mem::size_of_val(&value) as u32;
        if unsafe { GetWindowPlacement(hwnd, &mut value) } == 0 {
            return Err(last_error("GetWindowPlacement"));
        }
        Ok(Placement {
            flags: value.flags,
            show: value.showCmd,
            minimum: [value.ptMinPosition.x, value.ptMinPosition.y],
            maximum: [value.ptMaxPosition.x, value.ptMaxPosition.y],
            normal: [
                value.rcNormalPosition.left,
                value.rcNormalPosition.top,
                value.rcNormalPosition.right,
                value.rcNormalPosition.bottom,
            ],
        })
    }

    pub(super) fn restore(hwnd: HWND, value: Placement) -> Result<(), String> {
        let placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            flags: value.flags,
            showCmd: value.show,
            ptMinPosition: POINT {
                x: value.minimum[0],
                y: value.minimum[1],
            },
            ptMaxPosition: POINT {
                x: value.maximum[0],
                y: value.maximum[1],
            },
            rcNormalPosition: RECT {
                left: value.normal[0],
                top: value.normal[1],
                right: value.normal[2],
                bottom: value.normal[3],
            },
        };
        if unsafe { SetWindowPlacement(hwnd, &placement) } == 0 {
            return Err(last_error("SetWindowPlacement"));
        }
        Ok(())
    }

    pub(super) fn set_frame(hwnd: HWND, enabled: bool) -> Result<(), String> {
        let mut data = 0;
        let installed =
            unsafe { GetWindowSubclass(hwnd, Some(frame_proc), SUBCLASS, &mut data) } != 0;
        if enabled {
            if installed {
                return Ok(());
            }
            let mut monitor: MONITORINFO = unsafe { std::mem::zeroed() };
            monitor.cbSize = std::mem::size_of_val(&monitor) as u32;
            if unsafe {
                GetMonitorInfoW(
                    MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
                    &mut monitor,
                )
            } == 0
            {
                return Err(last_error("GetMonitorInfoW"));
            }
            let bounds = Box::into_raw(Box::new(monitor.rcMonitor));
            if unsafe { SetWindowSubclass(hwnd, Some(frame_proc), SUBCLASS, bounds as usize) } == 0
            {
                unsafe {
                    drop(Box::from_raw(bounds));
                }
                return Err(last_error("SetWindowSubclass"));
            }
        } else if installed {
            if unsafe { RemoveWindowSubclass(hwnd, Some(frame_proc), SUBCLASS) } == 0 {
                return Err(last_error("RemoveWindowSubclass"));
            }
            unsafe {
                drop(Box::from_raw(data as *mut RECT));
            }
        }
        Ok(())
    }

    unsafe extern "system" fn frame_proc(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        // SAFETY: this subclass is installed/removed only on the window thread.
        // Its owned monitor rectangle stays alive until removal/WM_NCDESTROY.
        unsafe {
            if message == WM_NCCALCSIZE && wp != 0 {
                // Preserve the proposed whole-window rectangle as the client
                // rectangle; bypass Tao's maximized rcWork/taskbar calculation.
                return 0;
            }
            if message == WM_WINDOWPOSCHANGING {
                let result = DefSubclassProc(hwnd, message, wp, lp);
                let bounds = &*(data as *const RECT);
                let position = &mut *(lp as *mut WINDOWPOS);
                // Apply after default min/max sizing. Even library frame/shadow
                // updates must not expose a temporary work-area/maximized size.
                position.x = bounds.left;
                position.y = bounds.top;
                position.cx = bounds.right - bounds.left;
                position.cy = bounds.bottom - bounds.top;
                position.flags &= !(SWP_NOMOVE | SWP_NOSIZE);
                return result;
            }
            if message == WM_NCDESTROY {
                RemoveWindowSubclass(hwnd, Some(frame_proc), id);
                drop(Box::from_raw(data as *mut RECT));
            }
            DefSubclassProc(hwnd, message, wp, lp)
        }
    }

    /// Keep all style/placement changes in a single unanimated DWM transition.
    /// This shell owns the attribute and restores its normal (not forced-off)
    /// policy on every exit, including errors. System reduced motion still applies.
    pub(crate) struct AnimationGuard {
        hwnd: HWND,
    }
    impl AnimationGuard {
        pub(crate) fn new(hwnd: HWND) -> Result<Self, String> {
            let size = std::mem::size_of::<i32>() as u32;
            let disabled = 1i32;
            let result = unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_TRANSITIONS_FORCEDISABLED as u32,
                    (&disabled as *const i32).cast::<c_void>(),
                    size,
                )
            };
            if result < 0 {
                return Err(format!(
                    "DWM transition suppression failed: 0x{:08X}",
                    result as u32
                ));
            }
            Ok(Self { hwnd })
        }
    }
    impl Drop for AnimationGuard {
        fn drop(&mut self) {
            let normal = 0i32;
            unsafe {
                // Present final bounds before restoring system transitions.
                DwmFlush();
                DwmSetWindowAttribute(
                    self.hwnd,
                    DWMWA_TRANSITIONS_FORCEDISABLED as u32,
                    (&normal as *const i32).cast::<c_void>(),
                    std::mem::size_of::<i32>() as u32,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct FakeWindow {
        placement: Cell<Placement>,
        fullscreen: Cell<bool>,
        frame: Cell<bool>,
        fail_next: Cell<Option<&'static str>>,
        calls: RefCell<Vec<&'static str>>,
    }
    impl FakeWindow {
        fn new(maximized: bool) -> Self {
            Self {
                placement: Cell::new(Placement {
                    flags: 0,
                    show: if maximized { 3 } else { 1 },
                    minimum: [-1, -1],
                    maximum: [-1, -1],
                    normal: [50, 70, 950, 670],
                }),
                fullscreen: Cell::new(false),
                frame: Cell::new(false),
                fail_next: Cell::new(None),
                calls: RefCell::new(Vec::new()),
            }
        }
        fn call(&self, name: &'static str) -> Result<(), String> {
            self.calls.borrow_mut().push(name);
            if self.fail_next.get() == Some(name) {
                self.fail_next.set(None);
                return Err(format!("{name} failed"));
            }
            Ok(())
        }
    }
    impl Window for FakeWindow {
        fn is_fullscreen(&self) -> Result<bool, String> {
            Ok(self.fullscreen.get())
        }
        fn placement(&self) -> Result<Placement, String> {
            self.call("capture")?;
            Ok(self.placement.get())
        }
        fn set_fullscreen_frame(&self, enabled: bool) -> Result<(), String> {
            self.call(if enabled { "frame-on" } else { "frame-off" })?;
            self.frame.set(enabled);
            Ok(())
        }
        fn set_fullscreen(&self, enabled: bool) -> Result<(), String> {
            self.call(if enabled { "enter" } else { "exit" })?;
            assert_eq!(
                self.frame.get(),
                enabled,
                "monitor bounds must own the full client area"
            );
            self.fullscreen.set(enabled);
            // Simulate the library saving placement after changing frame flags.
            let mut placement = self.placement.get();
            placement.normal = [0, 0, 1920, 1080];
            self.placement.set(placement);
            Ok(())
        }
        fn restore_placement(&self, placement: Placement) -> Result<(), String> {
            self.call("restore")?;
            self.placement.set(placement);
            Ok(())
        }
    }

    #[test]
    fn maximized_round_trip_and_duplicate_entry_preserve_restore_state() {
        let window = FakeWindow::new(true);
        let original = window.placement.get();
        let mut state = FullscreenState::default();
        state.set(&window, true).unwrap();
        assert_eq!(window.placement.get().show, original.show);
        state.set(&window, true).unwrap();
        state.set(&window, false).unwrap();
        assert_eq!(window.placement.get(), original);
        assert!(!window.fullscreen.get());
        assert_eq!(
            *window.calls.borrow(),
            [
                "capture",
                "frame-on",
                "enter",
                "frame-off",
                "exit",
                "restore"
            ]
        );
    }
    #[test]
    fn normal_window_round_trip_does_not_maximize() {
        let window = FakeWindow::new(false);
        let original = window.placement.get();
        let mut state = FullscreenState::default();
        state.set(&window, true).unwrap();
        assert_eq!(window.placement.get().show, 1);
        state.set(&window, false).unwrap();
        assert_eq!(window.placement.get(), original);
        assert!(!window.fullscreen.get());
    }
    #[test]
    fn failed_entry_restores_maximized_window() {
        let window = FakeWindow::new(true);
        let original = window.placement.get();
        window.fail_next.set(Some("enter"));
        let mut state = FullscreenState::default();
        assert!(state.set(&window, true).is_err());
        assert_eq!(window.placement.get(), original);
        assert!(!window.fullscreen.get());
        assert!(!window.frame.get());
        assert!(state.restore.is_none());
    }
    #[test]
    fn failed_exit_or_restore_can_be_retried() {
        for failure in ["exit", "restore"] {
            let window = FakeWindow::new(true);
            let original = window.placement.get();
            let mut state = FullscreenState::default();
            state.set(&window, true).unwrap();
            window.fail_next.set(Some(failure));
            assert!(state.set(&window, false).is_err());
            assert_eq!(state.restore, Some(original));
            assert_eq!(window.frame.get(), window.fullscreen.get());
            state.set(&window, false).unwrap();
            assert_eq!(window.placement.get(), original);
            assert!(!window.fullscreen.get());
        }
    }
    #[test]
    fn failed_frame_preparation_does_not_enter_fullscreen() {
        let window = FakeWindow::new(true);
        window.fail_next.set(Some("frame-on"));
        assert!(FullscreenState::default().set(&window, true).is_err());
        assert_eq!(*window.calls.borrow(), ["capture", "frame-on"]);
        assert!(!window.fullscreen.get());
        assert!(!window.frame.get());
    }
    #[test]
    fn failed_placement_capture_does_not_change_frame() {
        let window = FakeWindow::new(false);
        window.fail_next.set(Some("capture"));
        assert!(FullscreenState::default().set(&window, true).is_err());
        assert_eq!(*window.calls.borrow(), ["capture"]);
    }
    #[test]
    fn failed_frame_removal_retains_fullscreen_and_original_placement() {
        let window = FakeWindow::new(true);
        let original = window.placement.get();
        let mut state = FullscreenState::default();
        state.set(&window, true).unwrap();
        window.fail_next.set(Some("frame-off"));
        assert!(state.set(&window, false).is_err());
        assert!(window.fullscreen.get());
        assert!(window.frame.get());
        assert_eq!(state.restore, Some(original));
        state.set(&window, false).unwrap();
        assert_eq!(window.placement.get(), original);
    }

    #[test]
    fn reentry_after_failed_restore_keeps_the_original_placement() {
        let window = FakeWindow::new(true);
        let original = window.placement.get();
        let mut state = FullscreenState::default();
        state.set(&window, true).unwrap();
        window.fail_next.set(Some("restore"));
        assert!(state.set(&window, false).is_err());
        state.set(&window, true).unwrap();
        state.set(&window, false).unwrap();
        assert_eq!(window.placement.get(), original);
        assert!(state.restore.is_none());
    }
}

#[cfg(all(test, target_os = "windows"))]
#[path = "windows_fullscreen_tests.rs"]
mod native_tests;
