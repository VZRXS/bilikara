//! Recover only inaccessible main windows after a native display/work-area change.
//! This hook is independent of the WebView's maximize hit area and remains alive
//! while fullscreen hides the toolbar. Ordinary dragging never requests recovery.
use super::*;

#[cfg(test)]
fn offscreen_fixture_position(
    desktop: (i64, i64, i64, i64),
    size: (u32, u32),
) -> Option<(i32, i32)> {
    let (width, height) = (i64::from(size.0), i64::from(size.1));
    if width == 0 || height == 0 {
        return None;
    }
    // Native Windows positioning can clamp very large coordinates to signed
    // 16-bit values. Choose a whole test rectangle within that range, outside
    // the actual virtual desktop, rather than assuming a million-pixel move.
    [
        (desktop.2 + 64, 0),
        (desktop.0 - width - 64, 0),
        (0, desktop.3 + 64),
        (0, desktop.1 - height - 64),
    ]
    .into_iter()
    .find(|(x, y)| {
        *x >= i64::from(i16::MIN)
            && *y >= i64::from(i16::MIN)
            && *x + width <= i64::from(i16::MAX)
            && *y + height <= i64::from(i16::MAX)
    })
    .map(|(x, y)| (x as i32, y as i32))
}

fn recovery_geometry(
    monitors: &[MonitorWorkArea],
    primary: usize,
    rectangle: (i64, i64, i64, i64),
    frame: LogicalFrameSize,
    saved: Option<&StoredMainWindowGeometry>,
) -> Option<ResolvedMainWindowGeometry> {
    let width = rectangle.2 - rectangle.0;
    let height = rectangle.3 - rectangle.1;
    if width <= 0 || height <= 0 {
        return None;
    }
    // A title strip must be reachable too: a large visible lower half alone
    // does not let the user drag a window whose caption is above the screen.
    if monitors.iter().filter(|m| monitor_is_valid(m)).any(|m| {
        let work = monitor_rectangle(m);
        let visible_width = (rectangle.2.min(work.2) - rectangle.0.max(work.0)).max(0);
        let visible_height = (rectangle.3.min(work.3) - rectangle.1.max(work.1)).max(0);
        rectangle.1 >= work.1
            && rectangle.1 < work.3
            && visible_width as f64 >= (MIN_VISIBLE_WIDTH * m.scale_factor).min(width as f64)
            && visible_height as f64 >= (MIN_VISIBLE_HEIGHT * m.scale_factor).min(height as f64)
            && (visible_width as f64 * visible_height as f64) / (width as f64 * height as f64)
                >= MIN_VISIBLE_AREA_RATIO
    }) {
        return None;
    }
    let primary = safe_monitor_index(monitors, primary)?;
    let selected = monitors
        .iter()
        .enumerate()
        .filter(|(_, m)| monitor_is_valid(m))
        .map(|(i, m)| {
            (
                i,
                rectangle_intersection_area(rectangle, monitor_rectangle(m)),
            )
        })
        .filter(|(_, area)| *area > 0)
        .max_by_key(|(_, area)| *area)
        .map(|(i, _)| i)
        .unwrap_or(primary);
    let saved = saved.filter(|g| stored_geometry_is_valid(g));
    let monitor = &monitors[selected];
    Some(resolved_geometry(
        selected,
        monitor,
        frame,
        RequestedMainWindowGeometry {
            inner_width: saved.map_or(width as f64 / monitor.scale_factor - frame.width, |g| {
                g.normal.width
            }),
            inner_height: saved.map_or(height as f64 / monitor.scale_factor - frame.height, |g| {
                g.normal.height
            }),
            offset: None,
            maximized: saved.is_some_and(|g| g.maximized),
            used_saved_geometry: saved.is_some(),
        },
    ))
}

#[cfg(windows)]
pub(super) fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("display recovery belongs to the main window".into());
    }
    let app = window.app_handle().clone();
    native::install(window.hwnd().map_err(|e| e.to_string())?.0, move || {
        let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            return true;
        };
        match native::recover(&window.as_ref().window()) {
            Ok(done) => done,
            Err(_) => {
                geometry_diagnostic("display_change", "error_ignored");
                false
            }
        }
    })
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{cell::Cell, rc::Rc};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect},
        UI::{
            Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{
                GWL_EXSTYLE, GetWindowLongPtrW, GetWindowPlacement, PostMessageW, SW_SHOWMAXIMIZED,
                SetWindowPlacement, WINDOWPLACEMENT, WM_APP, WM_DISPLAYCHANGE, WM_NCDESTROY,
                WM_SETTINGCHANGE, WM_SHOWWINDOW, WM_SIZE, WPF_RESTORETOMAXIMIZED, WS_EX_TOOLWINDOW,
            },
        },
    };

    const SUBCLASS: usize = 0x424b4443;
    const RECOVER: u32 = WM_APP + 0x4b;
    struct Notifications {
        dirty: Cell<bool>,
        queued: Cell<bool>,
        generation: Cell<u64>,
        recover: Box<dyn Fn() -> bool>,
    }

    pub(super) fn install(hwnd: HWND, recover: impl Fn() -> bool + 'static) -> Result<(), String> {
        let mut existing = 0;
        if unsafe { GetWindowSubclass(hwnd, Some(proc), SUBCLASS, &mut existing) } != 0 {
            return Ok(());
        }
        let state = Box::new(Rc::new(Notifications {
            dirty: Cell::new(false),
            queued: Cell::new(false),
            generation: Cell::new(0),
            recover: Box::new(recover),
        }));
        let pointer = Box::into_raw(state);
        if unsafe { SetWindowSubclass(hwnd, Some(proc), SUBCLASS, pointer as usize) } == 0 {
            unsafe {
                drop(Box::from_raw(pointer));
            }
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    fn queue(hwnd: HWND, state: &Notifications) {
        if state.dirty.get()
            && !state.queued.replace(true)
            && unsafe { PostMessageW(hwnd, RECOVER, 0, 0) } == 0
        {
            state.queued.set(false);
        }
    }

    unsafe extern "system" fn proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            // The native window thread owns this box until its final message.
            unsafe {
                RemoveWindowSubclass(hwnd, Some(proc), id);
                drop(Box::from_raw(data as *mut Rc<Notifications>));
                return DefSubclassProc(hwnd, message, wparam, lparam);
            }
        }
        // A placement operation can synchronously reenter the window procedure.
        // Retain the callback state even if a nested final message removes it.
        let state = unsafe { (&*(data as *const Rc<Notifications>)).clone() };
        if message == RECOVER {
            let generation = state.generation.get();
            if state.dirty.get() && (state.recover)() && state.generation.get() == generation {
                state.dirty.set(false);
            }
            state.queued.set(false);
            if state.generation.get() != generation {
                queue(hwnd, &state);
            }
            return 0;
        }
        if matches!(message, WM_DISPLAYCHANGE | WM_SETTINGCHANGE) {
            state.dirty.set(true);
            state.generation.set(state.generation.get().wrapping_add(1));
        }
        if matches!(
            message,
            WM_DISPLAYCHANGE | WM_SETTINGCHANGE | WM_SIZE | WM_SHOWWINDOW
        ) {
            queue(hwnd, &state);
        }
        // Recovery is posted, not performed during the system's display change
        // or a reentrant resize. No borrowed Windows message payload survives.
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    fn monitor_info(rectangle: &RECT) -> Result<MONITORINFO, String> {
        let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of_val(&info) as u32;
        if unsafe {
            GetMonitorInfoW(
                MonitorFromRect(rectangle, MONITOR_DEFAULTTONEAREST),
                &mut info,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(info)
    }

    fn workspace_offset(hwnd: HWND, rectangle: &RECT) -> Result<(i32, i32), String> {
        if unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_TOOLWINDOW as isize != 0 {
            return Ok((0, 0));
        }
        let info = monitor_info(rectangle)?;
        Ok((
            info.rcWork.left - info.rcMonitor.left,
            info.rcWork.top - info.rcMonitor.top,
        ))
    }

    fn place(hwnd: HWND, mut placement: WINDOWPLACEMENT, target: RECT) -> Result<(), String> {
        let (dx, dy) = workspace_offset(hwnd, &target)?;
        placement.rcNormalPosition = RECT {
            left: target.left - dx,
            top: target.top - dy,
            right: target.right - dx,
            bottom: target.bottom - dy,
        };
        // Preserve the native show state, flags and minimize/maximize restoration.
        // In particular, never show a minimized window just to repair its position.
        if unsafe { SetWindowPlacement(hwnd, &placement) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    pub(super) fn recover(window: &tauri::Window) -> Result<bool, String> {
        let Some(state) = window.try_state::<MainWindowGeometryState>() else {
            return Ok(false);
        };
        if state.restoring.load(Ordering::Acquire)
            || window.is_fullscreen().map_err(|e| e.to_string())?
        {
            // Keep the notification pending until restore/exit fullscreen.
            return Ok(false);
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0;
        let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
        placement.length = std::mem::size_of_val(&placement) as u32;
        if unsafe { GetWindowPlacement(hwnd, &mut placement) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // Normal placement is valid even when minimized/maximized. Windows stores
        // it in workspace coordinates; convert explicitly rather than persisting
        // the minimized icon position or maximized dimensions as normal geometry.
        let (dx, dy) = workspace_offset(hwnd, &placement.rcNormalPosition)?;
        let normal = placement.rcNormalPosition;
        let rectangle = (
            i64::from(normal.left) + i64::from(dx),
            i64::from(normal.top) + i64::from(dy),
            i64::from(normal.right) + i64::from(dx),
            i64::from(normal.bottom) + i64::from(dy),
        );
        let (monitors, _, primary) = available_work_areas(window).map_err(|e| e.to_string())?;
        if !monitors.iter().any(monitor_is_valid) {
            return Ok(false);
        }
        let frame = if window.is_minimized().map_err(|e| e.to_string())? {
            // A minimized icon's outer rectangle is not the normal window frame.
            LogicalFrameSize {
                width: DEFAULT_FRAME_WIDTH,
                height: DEFAULT_FRAME_HEIGHT,
            }
        } else {
            logical_frame_size(
                window.inner_size().map_err(|e| e.to_string())?,
                window.outer_size().map_err(|e| e.to_string())?,
                window.scale_factor().map_err(|e| e.to_string())?,
            )
        };
        let saved = state
            .cached
            .lock()
            .map_err(|_| "window preferences unavailable")?
            .clone();
        let Some(mut resolved) =
            recovery_geometry(&monitors, primary, rectangle, frame, saved.as_ref())
        else {
            refresh_main_window_minimum_height(window);
            return Ok(true);
        };
        resolved.maximized = placement.showCmd == SW_SHOWMAXIMIZED as u32
            || placement.flags & WPF_RESTORETOMAXIMIZED != 0;
        let target = RECT {
            left: resolved.physical_x,
            top: resolved.physical_y,
            right: resolved
                .physical_x
                .saturating_add(resolved.physical_inner_width as i32)
                .saturating_add(
                    (frame.width * monitors[resolved.monitor_index].scale_factor).round() as i32,
                ),
            bottom: resolved
                .physical_y
                .saturating_add(resolved.physical_inner_height as i32)
                .saturating_add(
                    (frame.height * monitors[resolved.monitor_index].scale_factor).round() as i32,
                ),
        };
        // No intermediate unmaximize or fullscreen mutation. Suppress geometry
        // capture during the reentrant resize/move notifications.
        state.restoring.store(true, Ordering::Release);
        // Lower the old monitor's height floor before resizing onto a shorter
        // work area; the OS must not constrain this move with a stale minimum.
        let result = set_main_window_minimum_height(window, &state, resolved.minimum_inner_height)
            .map_err(|e| e.to_string())
            .and_then(|()| place(hwnd, placement, target));
        state.restoring.store(false, Ordering::Release);
        result?;
        state.replace_cached(stored_from_resolved(
            resolved,
            &monitors[resolved.monitor_index],
        ));
        refresh_main_window_minimum_height(window);
        geometry_diagnostic("display_change", "recovered");
        Ok(true)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::{Win32::UI::WindowsAndMessaging::*, w};

        struct TestWindow(HWND);
        impl TestWindow {
            fn new() -> Self {
                let hwnd = unsafe {
                    CreateWindowExW(
                        0,
                        w!("STATIC"),
                        w!("bilikara display regression"),
                        WS_POPUP | WS_THICKFRAME | WS_MAXIMIZEBOX | WS_MINIMIZEBOX,
                        80,
                        80,
                        600,
                        400,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                assert!(
                    !hwnd.is_null(),
                    "CreateWindowExW: {}",
                    std::io::Error::last_os_error()
                );
                Self(hwnd)
            }
            fn drain(&self) {
                let mut message: MSG = unsafe { std::mem::zeroed() };
                for _ in 0..32 {
                    if unsafe { PeekMessageW(&mut message, self.0, RECOVER, RECOVER, PM_REMOVE) }
                        == 0
                    {
                        return;
                    }
                    unsafe {
                        DispatchMessageW(&message);
                    }
                }
                panic!("display recovery did not settle");
            }
        }
        impl Drop for TestWindow {
            fn drop(&mut self) {
                assert_ne!(unsafe { DestroyWindow(self.0) }, 0);
            }
        }

        #[test]
        fn native_display_messages_coalesce_and_defer_until_resize() {
            let window = TestWindow::new();
            let calls = Rc::new(Cell::new(0));
            let ready = Rc::new(Cell::new(false));
            let called = calls.clone();
            let can_recover = ready.clone();
            install(window.0, move || {
                called.set(called.get() + 1);
                can_recover.get()
            })
            .unwrap();
            // A duplicate setup must retain the existing callback, not leak it.
            install(window.0, || panic!("replaced installed callback")).unwrap();
            unsafe {
                SendMessageW(window.0, WM_SIZE, 0, 0);
                SendMessageW(window.0, WM_DISPLAYCHANGE, 32, 0);
                SendMessageW(window.0, WM_SETTINGCHANGE, 0, 0);
            }
            assert_eq!(calls.get(), 0, "never recover inside a system broadcast");
            window.drain();
            assert_eq!(calls.get(), 1);
            ready.set(true);
            unsafe {
                SendMessageW(window.0, WM_SIZE, 0, 0);
            }
            window.drain();
            assert_eq!(calls.get(), 2);
            unsafe {
                SendMessageW(window.0, WM_SIZE, 0, 0);
            }
            window.drain();
            assert_eq!(calls.get(), 2, "ordinary resize must not recover again");
            // Drop owns WM_NCDESTROY cleanup; no WebView or toolbar fixture needed.
        }

        #[test]
        fn native_reentrant_display_change_is_not_lost() {
            let window = TestWindow::new();
            let hwnd = window.0;
            let calls = Rc::new(Cell::new(0));
            let counted = calls.clone();
            install(hwnd, move || {
                counted.set(counted.get() + 1);
                if counted.get() == 1 {
                    unsafe {
                        SendMessageW(hwnd, WM_DISPLAYCHANGE, 32, 0);
                    }
                }
                true
            })
            .unwrap();
            unsafe {
                SendMessageW(hwnd, WM_DISPLAYCHANGE, 32, 0);
            }
            window.drain();
            assert_eq!(calls.get(), 2);
        }

        #[test]
        fn native_placement_recovery_preserves_normal_maximized_and_minimized_state() {
            for show in [SW_SHOWNOACTIVATE, SW_MAXIMIZE, SW_SHOWMINNOACTIVE] {
                let window = TestWindow::new();
                unsafe {
                    ShowWindow(window.0, show);
                }
                let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
                placement.length = std::mem::size_of_val(&placement) as u32;
                assert_ne!(unsafe { GetWindowPlacement(window.0, &mut placement) }, 0);
                let original_show = placement.showCmd;
                let original_flags = placement.flags;
                let bounds = monitor_info(&placement.rcNormalPosition).unwrap().rcWork;
                let target = RECT {
                    left: bounds.left + 24,
                    top: bounds.top + 24,
                    right: bounds.left + 624,
                    bottom: bounds.top + 424,
                };
                place(window.0, placement, target).unwrap();
                assert_ne!(unsafe { GetWindowPlacement(window.0, &mut placement) }, 0);
                assert_eq!(placement.showCmd, original_show);
                assert_eq!(placement.flags, original_flags);
                let (dx, dy) = workspace_offset(window.0, &placement.rcNormalPosition).unwrap();
                assert_eq!(
                    [
                        placement.rcNormalPosition.left + dx,
                        placement.rcNormalPosition.top + dy,
                        placement.rcNormalPosition.right + dx,
                        placement.rcNormalPosition.bottom + dy
                    ],
                    [target.left, target.top, target.right, target.bottom]
                );
            }
        }

        #[test]
        fn native_display_notification_recovers_an_actually_offscreen_window() {
            let window = TestWindow::new();
            let hwnd = window.0;
            let left = i64::from(unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) });
            let top = i64::from(unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) });
            let width = i64::from(unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) });
            let height = i64::from(unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) });
            assert!(
                width > 0 && height > 0,
                "fixture needs a real virtual desktop"
            );
            let (offscreen_x, offscreen_y) =
                offscreen_fixture_position((left, top, left + width, top + height), (600, 400))
                    .expect("virtual desktop must leave a representable offscreen test rectangle");
            let primary = monitor_info(&RECT {
                left: 0,
                top: 0,
                right: 1,
                bottom: 1,
            })
            .unwrap()
            .rcWork;
            let monitors = vec![MonitorWorkArea {
                name: None,
                x: primary.left,
                y: primary.top,
                width: (primary.right - primary.left) as u32,
                height: (primary.bottom - primary.top) as u32,
                scale_factor: 1.0,
            }];
            install(hwnd, move || {
                let mut actual: RECT = unsafe { std::mem::zeroed() };
                if unsafe { GetWindowRect(hwnd, &mut actual) } == 0 {
                    return false;
                }
                let rectangle = (
                    actual.left.into(),
                    actual.top.into(),
                    actual.right.into(),
                    actual.bottom.into(),
                );
                let Some(resolved) = recovery_geometry(
                    &monitors,
                    0,
                    rectangle,
                    LogicalFrameSize {
                        width: 0.0,
                        height: 0.0,
                    },
                    None,
                ) else {
                    return true;
                };
                let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
                placement.length = std::mem::size_of_val(&placement) as u32;
                if unsafe { GetWindowPlacement(hwnd, &mut placement) } == 0 {
                    return false;
                }
                place(
                    hwnd,
                    placement,
                    RECT {
                        left: resolved.physical_x,
                        top: resolved.physical_y,
                        right: resolved.physical_x + resolved.physical_inner_width as i32,
                        bottom: resolved.physical_y + resolved.physical_inner_height as i32,
                    },
                )
                .is_ok()
            })
            .unwrap();
            unsafe {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                assert_ne!(
                    SetWindowPos(
                        hwnd,
                        std::ptr::null_mut(),
                        offscreen_x,
                        offscreen_y,
                        600,
                        400,
                        SWP_NOACTIVATE | SWP_NOZORDER
                    ),
                    0
                );
            }
            let mut before: RECT = unsafe { std::mem::zeroed() };
            assert_ne!(unsafe { GetWindowRect(hwnd, &mut before) }, 0);
            assert_eq!(
                (before.left, before.top),
                (offscreen_x, offscreen_y),
                "native fixture must accept its bounded coordinates"
            );
            assert!(
                unsafe {
                    windows_sys::Win32::Graphics::Gdi::MonitorFromRect(
                        &before,
                        windows_sys::Win32::Graphics::Gdi::MONITOR_DEFAULTTONULL,
                    )
                }
                .is_null(),
                "fixture must be outside every real monitor before recovery"
            );
            unsafe {
                SendMessageW(hwnd, WM_DISPLAYCHANGE, 32, 0);
            }
            window.drain();
            let mut after: RECT = unsafe { std::mem::zeroed() };
            assert_ne!(unsafe { GetWindowRect(hwnd, &mut after) }, 0);
            assert!(after.left >= primary.left && after.top >= primary.top);
            assert!(after.right <= primary.right && after.bottom <= primary.bottom);
            unsafe {
                SendMessageW(hwnd, WM_DISPLAYCHANGE, 32, 0);
            }
            window.drain();
            let mut repeated: RECT = unsafe { std::mem::zeroed() };
            assert_ne!(unsafe { GetWindowRect(hwnd, &mut repeated) }, 0);
            assert_eq!(
                [repeated.left, repeated.top, repeated.right, repeated.bottom],
                [after.left, after.top, after.right, after.bottom]
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{FRAMELESS, monitor, saved_geometry};
    use super::*;

    #[test]
    fn offscreen_fixture_uses_desktop_bounds_and_windows_coordinate_range() {
        for (desktop, expected) in [
            ((0, 0, 1920, 1080), Some((1984, 0))),
            ((-1920, -600, 1920, 1080), Some((1984, 0))),
            ((0, 0, 32500, 1080), Some((-664, 0))),
            ((-32700, -600, 32700, 1080), Some((0, 1144))),
            ((-32700, -32700, 32700, 32700), None),
        ] {
            let actual = offscreen_fixture_position(desktop, (600, 400));
            assert_eq!(actual, expected);
            if let Some((x, y)) = actual {
                assert_eq!(
                    rectangle_intersection_area(
                        desktop,
                        (x.into(), y.into(), i64::from(x) + 600, i64::from(y) + 400)
                    ),
                    0
                );
                assert!(x >= i32::from(i16::MIN) && y >= i32::from(i16::MIN));
                assert!(i64::from(x) + 600 <= i64::from(i16::MAX));
                assert!(i64::from(y) + 400 <= i64::from(i16::MAX));
            }
        }
        assert!(offscreen_fixture_position((0, 0, 1920, 1080), (0, 400)).is_none());
    }

    #[test]
    fn removed_extended_display_and_mirror_collapse_recover_on_primary() {
        let primary = monitor("primary", 0, 0, 1920, 1040, 1.0);
        let external = monitor("external", 1920, 0, 2560, 1400, 1.0);
        let saved = saved_geometry(&external, 100.0, 80.0, 1000.0, 700.0, false);
        for monitors in [
            vec![primary.clone()],
            vec![primary.clone(), monitor("mirror", 0, 0, 1920, 1040, 1.0)],
        ] {
            let recovered =
                recovery_geometry(&monitors, 0, (2020, 80, 3020, 780), FRAMELESS, Some(&saved))
                    .unwrap();
            assert_eq!((recovered.physical_x, recovered.physical_y), (460, 170));
            assert_eq!(
                (recovered.inner_width, recovered.inner_height),
                (1000.0, 700.0)
            );
        }
    }

    #[test]
    fn visible_extended_or_partly_visible_window_does_not_move() {
        let monitors = [
            monitor("primary", 0, 0, 1920, 1040, 1.0),
            monitor("left", -1920, 0, 1920, 1040, 1.0),
        ];
        for rectangle in [
            (-1800, 80, -800, 780),
            (0, 0, 1000, 700),
            (1600, 80, 2600, 780),
        ] {
            assert!(recovery_geometry(&monitors, 0, rectangle, FRAMELESS, None).is_none());
        }
    }

    #[test]
    fn inaccessible_caption_and_tiny_visible_sliver_recover() {
        let monitors = [monitor("primary", 0, 0, 1920, 1040, 1.0)];
        for rectangle in [
            (1800, 80, 2800, 780),
            (100, -50, 1100, 650),
            (-1500, 100, -500, 800),
        ] {
            let recovered = recovery_geometry(&monitors, 0, rectangle, FRAMELESS, None).unwrap();
            assert_eq!((recovered.physical_x, recovered.physical_y), (460, 170));
        }
    }

    #[test]
    fn recovery_preserves_logical_size_and_maximized_preference_at_new_dpi() {
        let old = monitor("gone", 1920, 0, 1920, 1040, 1.0);
        let saved = saved_geometry(&old, 50.0, 50.0, 1000.0, 700.0, true);
        let monitors = [monitor("new primary", -2560, -100, 2560, 1440, 2.0)];
        let recovered =
            recovery_geometry(&monitors, 0, (1970, 50, 2970, 750), FRAMELESS, Some(&saved))
                .unwrap();
        assert_eq!(recovered.physical_x, -2280);
        assert_eq!(recovered.physical_y, -76);
        assert_eq!(recovered.physical_inner_width, 2000);
        assert!(recovered.maximized);
        assert_eq!(recovered.minimum_inner_height, 600.0);
    }

    #[test]
    fn missing_or_invalid_monitors_and_invalid_rectangles_do_not_guess() {
        assert!(recovery_geometry(&[], 0, (2000, 80, 3000, 780), FRAMELESS, None).is_none());
        let monitors = [monitor("invalid", 0, 0, 0, 0, 1.0)];
        assert!(recovery_geometry(&monitors, 0, (2000, 80, 3000, 780), FRAMELESS, None).is_none());
        let monitors = [monitor("valid", 0, 0, 1920, 1040, 1.0)];
        assert!(recovery_geometry(&monitors, 0, (0, 0, 0, 700), FRAMELESS, None).is_none());
    }
}
