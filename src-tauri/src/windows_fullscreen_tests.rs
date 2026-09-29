//! These tests execute real HWND sizing on the Windows CI runner. They exercise
//! the adapter beneath Tauri, including intermediate work-area/maximize requests.
use super::{FullscreenState, Placement, Window, native};
use std::{
    cell::{Cell, RefCell},
    ptr::null_mut,
};
use windows_sys::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{
            GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow,
        },
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    },
    w,
};

struct NativeWindow {
    hwnd: HWND,
    fullscreen: Cell<bool>,
    changes: Box<RefCell<Vec<[i32; 4]>>>,
}

impl NativeWindow {
    fn new(maximized: bool) -> Self {
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                w!("STATIC"),
                w!("Bilikara fullscreen regression test"),
                WS_POPUP | WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX,
                100,
                100,
                400,
                300,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
            )
        };
        assert!(
            !hwnd.is_null(),
            "CreateWindowExW: {}",
            std::io::Error::last_os_error()
        );
        let window = Self {
            hwnd,
            fullscreen: Cell::new(false),
            changes: Box::default(),
        };
        unsafe {
            assert_ne!(
                SetWindowSubclass(
                    hwnd,
                    Some(record_changes),
                    1,
                    (&*window.changes as *const RefCell<Vec<[i32; 4]>>) as usize
                ),
                0
            );
            ShowWindow(
                hwnd,
                if maximized {
                    SW_MAXIMIZE
                } else {
                    SW_SHOWNOACTIVATE
                },
            );
        }
        window.changes.borrow_mut().clear();
        window
    }
    fn monitor(&self) -> RECT {
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of_val(&info) as u32;
        assert_ne!(
            unsafe {
                GetMonitorInfoW(
                    MonitorFromWindow(self.hwnd, MONITOR_DEFAULTTONEAREST),
                    &mut info,
                )
            },
            0
        );
        info.rcMonitor
    }
}
impl Drop for NativeWindow {
    fn drop(&mut self) {
        unsafe {
            RemoveWindowSubclass(self.hwnd, Some(record_changes), 1);
            DestroyWindow(self.hwnd);
        }
    }
}
unsafe extern "system" fn record_changes(
    hwnd: HWND,
    message: u32,
    wp: WPARAM,
    lp: LPARAM,
    _: usize,
    data: usize,
) -> LRESULT {
    unsafe {
        if message == WM_WINDOWPOSCHANGED {
            let mut rect: RECT = std::mem::zeroed();
            assert_ne!(GetWindowRect(hwnd, &mut rect), 0);
            (&*(data as *const RefCell<Vec<[i32; 4]>>))
                .borrow_mut()
                .push([rect.left, rect.top, rect.right, rect.bottom]);
        }
        DefSubclassProc(hwnd, message, wp, lp)
    }
}
impl Window for NativeWindow {
    fn is_fullscreen(&self) -> Result<bool, String> {
        Ok(self.fullscreen.get())
    }
    fn placement(&self) -> Result<Placement, String> {
        native::placement(self.hwnd)
    }
    fn set_fullscreen_frame(&self, enabled: bool) -> Result<(), String> {
        native::set_frame(self.hwnd, enabled)
    }
    fn set_fullscreen(&self, enabled: bool) -> Result<(), String> {
        let bounds = self.monitor();
        unsafe {
            if enabled {
                // Deliberately request the taskbar-excluding maximized size,
                // then an arbitrary frame resize, before the final monitor size.
                // The adapter must prevent both intermediate rectangles.
                ShowWindow(self.hwnd, SW_MAXIMIZE);
                assert_ne!(
                    SetWindowPos(self.hwnd, null_mut(), 100, 100, 500, 350, SWP_NOZORDER),
                    0
                );
                assert_ne!(
                    SetWindowPos(
                        self.hwnd,
                        null_mut(),
                        bounds.left,
                        bounds.top,
                        bounds.right - bounds.left,
                        bounds.bottom - bounds.top,
                        SWP_NOZORDER
                    ),
                    0
                );
            } else {
                ShowWindow(self.hwnd, SW_RESTORE);
            }
        }
        self.fullscreen.set(enabled);
        Ok(())
    }
    fn restore_placement(&self, placement: Placement) -> Result<(), String> {
        native::restore(self.hwnd, placement)
    }
}

#[test]
fn native_normal_and_maximized_fullscreen_cover_monitor_without_intermediate_geometry() {
    for maximized in [false, true] {
        let window = NativeWindow::new(maximized);
        let original = window.placement().unwrap();
        let bounds = window.monitor();
        let mut state = FullscreenState::default();
        {
            let _animation = native::AnimationGuard::new(window.hwnd).unwrap();
            state.set(&window, true).unwrap();
            let mut client: RECT = unsafe { std::mem::zeroed() };
            assert_ne!(unsafe { GetClientRect(window.hwnd, &mut client) }, 0);
            assert_eq!(
                [client.right, client.bottom],
                [bounds.right - bounds.left, bounds.bottom - bounds.top],
                "fullscreen client must include the taskbar area"
            );
            let changes = window.changes.borrow();
            assert!(
                !changes.is_empty(),
                "must observe native fullscreen resizing"
            );
            assert!(
                changes
                    .iter()
                    .all(|rect| *rect == [bounds.left, bounds.top, bounds.right, bounds.bottom]),
                "normal/maximized/work-area rectangles must not be exposed during entry: {changes:?}"
            );
        }
        {
            let _animation = native::AnimationGuard::new(window.hwnd).unwrap();
            state.set(&window, false).unwrap();
        }
        assert_eq!(
            window.placement().unwrap(),
            original,
            "restore original bounds and show state"
        );
        assert_eq!(unsafe { IsZoomed(window.hwnd) } != 0, maximized);
        assert!(!window.fullscreen.get());
    }
}

#[test]
fn tauri_native_fullscreen_preserves_normal_and_maximized_placement() {
    use std::sync::{Arc, Mutex};
    let outcome: Arc<Mutex<Option<Result<(), String>>>> = Arc::default();
    let captured = Arc::clone(&outcome);
    let profile = std::env::temp_dir().join(format!(
        "bilikara-fullscreen-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let test_profile = profile.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .any_thread()
        .setup(move |app| {
            let result = (|| {
                let window = tauri::WebviewWindowBuilder::new(
                    app,
                    "fullscreen-regression",
                    tauri::WebviewUrl::External("about:blank".parse().unwrap()),
                )
                .data_directory(test_profile.clone())
                .decorations(false)
                .transparent(true)
                .shadow(true)
                .visible(false)
                .inner_size(900.0, 600.0)
                .build()
                .map_err(|error| error.to_string())?;
                let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
                let changes: Box<RefCell<Vec<[i32; 4]>>> = Box::default();
                unsafe {
                    if SetWindowSubclass(
                        hwnd,
                        Some(record_changes),
                        1,
                        (&*changes as *const RefCell<Vec<[i32; 4]>>) as usize,
                    ) == 0
                    {
                        return Err("could not record Tauri window geometry".into());
                    }
                }
                let checks = (|| {
                    window.show().map_err(|error| error.to_string())?;
                    for maximized in [false, true] {
                        window.unmaximize().map_err(|error| error.to_string())?;
                        window
                            .set_size(tauri::Size::Logical(tauri::LogicalSize::new(900.0, 600.0)))
                            .map_err(|error| error.to_string())?;
                        if maximized {
                            window.maximize().map_err(|error| error.to_string())?;
                        }
                        let original = window.placement()?;
                        changes.borrow_mut().clear();
                        let mut state = FullscreenState::default();
                        {
                            let _animation = native::AnimationGuard::new(hwnd)?;
                            state.set(&window, true)?;
                            let _ = crate::platform::sync_windows_main_window_frame(
                                &window.as_ref().window(),
                            );
                            let mut monitor: MONITORINFO = unsafe { std::mem::zeroed() };
                            monitor.cbSize = std::mem::size_of_val(&monitor) as u32;
                            let mut client: RECT = unsafe { std::mem::zeroed() };
                            if unsafe {
                                GetMonitorInfoW(
                                    MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
                                    &mut monitor,
                                )
                            } == 0
                                || unsafe { GetClientRect(hwnd, &mut client) } == 0
                            {
                                return Err("could not measure native fullscreen".into());
                            }
                            let bounds = monitor.rcMonitor;
                            if [client.right, client.bottom]
                                != [bounds.right - bounds.left, bounds.bottom - bounds.top]
                            {
                                return Err(format!(
                                    "Tauri fullscreen reserves frame/taskbar space: {}x{}",
                                    client.right, client.bottom
                                ));
                            }
                            if changes.borrow().is_empty()
                                || changes.borrow().iter().any(|rect| {
                                    *rect != [bounds.left, bounds.top, bounds.right, bounds.bottom]
                                })
                            {
                                return Err(format!(
                                    "Tauri fullscreen exposes intermediate geometry: {:?}",
                                    changes.borrow()
                                ));
                            }
                            if !window.is_fullscreen().map_err(|error| error.to_string())? {
                                return Err("Tauri lost its fullscreen state".into());
                            }
                        }
                        {
                            let _animation = native::AnimationGuard::new(hwnd)?;
                            state.set(&window, false)?;
                            let _ = crate::platform::sync_windows_main_window_frame(
                                &window.as_ref().window(),
                            );
                        }
                        if window.placement()? != original
                            || window.is_maximized().map_err(|error| error.to_string())?
                                != maximized
                        {
                            return Err(format!(
                                "Tauri did not restore original placement: {:?} -> {:?}",
                                original,
                                window.placement()?
                            ));
                        }
                        if window.is_fullscreen().map_err(|error| error.to_string())? {
                            return Err("Tauri did not leave fullscreen".into());
                        }
                    }
                    Ok(())
                })();
                // Remove before releasing the recorder; closing a WebView may be deferred.
                unsafe {
                    RemoveWindowSubclass(hwnd, Some(record_changes), 1);
                }
                window.close().map_err(|error| error.to_string())?;
                checks
            })();
            *captured.lock().unwrap() = Some(result);
            app.handle().exit(0);
            Ok(())
        })
        .build(context)
        .expect("build native fullscreen test app");
    app.run_return(|_, _| {});
    let _ = std::fs::remove_dir_all(profile);
    outcome
        .lock()
        .unwrap()
        .take()
        .expect("native test setup must run")
        .unwrap();
}
