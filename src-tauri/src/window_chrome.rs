//! Native hit testing for the existing integrated Windows maximize button.
//! This is window-shell adaptation only; no playback or application-state policy.
use crate::{backend_process::BackendProcess, presentation};
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChromeTheme {
    Light,
    Dark,
    Blue,
}

fn is_css_hex(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

#[tauri::command]
pub(crate) async fn set_window_chrome_theme(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
    theme: ChromeTheme,
    background: String,
    foreground: String,
) -> Result<(), String> {
    presentation::authorize_window(&window, &backend, &["main"])?;
    if !is_css_hex(&background) || !is_css_hex(&foreground) {
        return Err("native chrome colors must be RGB hex values".into());
    }
    window
        .set_theme(Some(match theme {
            ChromeTheme::Light => tauri::Theme::Light,
            _ => tauri::Theme::Dark,
        }))
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let native_window = window.clone();
        window.run_on_main_thread(move || {
            use gtk::prelude::*;
            let result = (|| {
                let window = native_window.gtk_window().map_err(|error| error.to_string())?;
                if let Some(header) = window.titlebar() {
                    let context = header.style_context();
                    let provider = gtk::CssProvider::new();
                    let css = format!("#bilikara-native-titlebar {{ background-image: none; background-color: {background}; color: {foreground}; border: none; box-shadow: none; min-height: 32px; padding: 0 6px; }}");
                    provider.load_from_data(css.as_bytes()).map_err(|error| error.to_string())?;
                    // Replace the one provider instead of accumulating one on
                    // every theme change. Its lifetime follows the GTK header.
                    const KEY: &str = "bilikara-chrome-provider";
                    unsafe {
                        if let Some(previous) = header.steal_data::<gtk::CssProvider>(KEY) {
                            context.remove_provider(&previous);
                        }
                        context.add_provider(&provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
                        header.set_data(KEY, provider);
                    }
                }
                Ok::<(), String>(())
            })();
            let _ = sender.try_send(result);
        }).map_err(|error| error.to_string())?;
        return receiver
            .recv()
            .await
            .ok_or("window closed before updating chrome")?;
    }
    #[cfg(not(target_os = "linux"))]
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MaximizeRegion {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl MaximizeRegion {
    fn fits(self, width: u32, height: u32) -> bool {
        self.x >= 0
            && self.y >= 0
            && (1..=512).contains(&self.width)
            && (1..=256).contains(&self.height)
            && i64::from(self.x) + i64::from(self.width) <= i64::from(width)
            && i64::from(self.y) + i64::from(self.height) <= i64::from(height)
    }
}

#[tauri::command]
pub(crate) async fn set_window_maximize_region(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
    region: Option<MaximizeRegion>,
) -> Result<(), String> {
    presentation::authorize_window(&window, &backend, &["main"])?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    if region.is_some_and(|value| !value.fits(size.width, size.height)) {
        return Err("maximize region is outside the window".into());
    }
    #[cfg(windows)]
    {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        let native_window = window.clone();
        window
            .run_on_main_thread(move || {
                let result = native::update(&native_window, region);
                let _ = sender.try_send(result);
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv()
            .await
            .ok_or("window closed before updating maximize region")?
    }
    #[cfg(not(windows))]
    Err("native maximize hit testing is Windows-only".into())
}

#[cfg(windows)]
mod native {
    use super::MaximizeRegion;
    use std::ptr::null_mut;
    use tauri::Emitter;
    use windows_sys::{
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::Gdi::ValidateRect,
            UI::{
                Input::KeyboardAndMouse::{
                    TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
                },
                Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
                WindowsAndMessaging::*,
            },
        },
        w,
    };

    const SUBCLASS: usize = 0x424b4d58;
    const PROPERTY: *const u16 = w!("Bilikara.Maximize.HitArea");

    struct ButtonState {
        window: tauri::WebviewWindow,
        parent: HWND,
        hovered: bool,
        pressed: bool,
    }

    // All HWND operations and Box ownership transfers below run on the window
    // thread. The child owns exactly one state until its WM_NCDESTROY callback.
    pub(super) fn update(
        window: &tauri::WebviewWindow,
        region: Option<MaximizeRegion>,
    ) -> Result<(), String> {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
        let region = if window.is_fullscreen().map_err(|error| error.to_string())?
            || window.is_decorated().map_err(|error| error.to_string())?
        {
            None
        } else {
            region
        };
        unsafe {
            let existing = GetPropW(hwnd, PROPERTY) as HWND;
            let Some(region) = region else {
                if !existing.is_null() {
                    DestroyWindow(existing);
                }
                return Ok(());
            };
            let child = if existing.is_null() {
                // A non-painting native child above WebView2 provides real
                // HTMAXBUTTON hit testing; the original DOM still draws the UI.
                let child = CreateWindowExW(
                    WS_EX_TRANSPARENT | WS_EX_NOACTIVATE,
                    w!("STATIC"),
                    w!(""),
                    WS_CHILD,
                    0,
                    0,
                    0,
                    0,
                    hwnd,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                );
                if child.is_null() {
                    return Err("could not create maximize hit area".into());
                }
                let state = Box::into_raw(Box::new(ButtonState {
                    window: window.clone(),
                    parent: hwnd,
                    hovered: false,
                    pressed: false,
                }));
                if SetWindowSubclass(child, Some(button_proc), SUBCLASS, state as usize) == 0 {
                    drop(Box::from_raw(state));
                    DestroyWindow(child);
                    return Err("could not install maximize hit testing".into());
                }
                if SetPropW(hwnd, PROPERTY, child) == 0
                    || SetWindowSubclass(hwnd, Some(parent_proc), SUBCLASS, 0) == 0
                {
                    DestroyWindow(child);
                    return Err("could not track maximize hit area lifetime".into());
                }
                child
            } else {
                existing
            };
            if SetWindowPos(
                child,
                HWND_TOP,
                region.x,
                region.y,
                region.width,
                region.height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            ) == 0
            {
                DestroyWindow(child);
                return Err("could not position maximize hit area".into());
            }
        }
        Ok(())
    }

    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
        id: usize,
        _: usize,
    ) -> LRESULT {
        // SAFETY: Comctl32 calls this on the owning window thread, with live HWNDs.
        unsafe {
            if matches!(message, WM_SIZE | WM_DPICHANGED) {
                let child = GetPropW(hwnd, PROPERTY) as HWND;
                if !child.is_null() {
                    ShowWindow(child, SW_HIDE);
                }
            }
            if message == WM_NCDESTROY {
                RemovePropW(hwnd, PROPERTY);
                RemoveWindowSubclass(hwnd, Some(parent_proc), id);
            }
            DefSubclassProc(hwnd, message, wp, lp)
        }
    }

    unsafe extern "system" fn button_proc(
        hwnd: HWND,
        message: u32,
        wp: WPARAM,
        lp: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        // SAFETY: data was allocated in update and is released only after the
        // subclass is removed at WM_NCDESTROY. No synchronous parent messages or
        // user callbacks are invoked while borrowing its state.
        unsafe {
            let pointer = data as *mut ButtonState;
            if message == WM_NCDESTROY {
                RemoveWindowSubclass(hwnd, Some(button_proc), id);
                let state = Box::from_raw(pointer);
                if GetPropW(state.parent, PROPERTY) == hwnd {
                    RemovePropW(state.parent, PROPERTY);
                }
                let _ = state.window.emit("bilikara:maximize-hover", false);
                return DefSubclassProc(hwnd, message, wp, lp);
            }
            let state = &mut *pointer;
            match message {
                WM_NCHITTEST => return HTMAXBUTTON as LRESULT,
                WM_NCMOUSEMOVE => {
                    if !state.hovered {
                        state.hovered = true;
                        let _ = state.window.emit("bilikara:maximize-hover", true);
                        let mut tracking = TRACKMOUSEEVENT {
                            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE | TME_NONCLIENT,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        };
                        TrackMouseEvent(&mut tracking);
                    }
                }
                WM_NCMOUSELEAVE | WM_CANCELMODE => {
                    state.hovered = false;
                    state.pressed = false;
                    let _ = state.window.emit("bilikara:maximize-hover", false);
                }
                WM_SHOWWINDOW if wp == 0 => {
                    state.hovered = false;
                    state.pressed = false;
                    let _ = state.window.emit("bilikara:maximize-hover", false);
                }
                WM_NCLBUTTONDOWN if wp == HTMAXBUTTON as usize => {
                    state.pressed = true;
                    return 0;
                }
                WM_NCLBUTTONUP if wp == HTMAXBUTTON as usize => {
                    let pressed = std::mem::take(&mut state.pressed);
                    let mut bounds: RECT = std::mem::zeroed();
                    let point = POINT {
                        x: lp as i16 as i32,
                        y: (lp >> 16) as i16 as i32,
                    };
                    if pressed
                        && GetWindowRect(hwnd, &mut bounds) != 0
                        && point.x >= bounds.left
                        && point.x < bounds.right
                        && point.y >= bounds.top
                        && point.y < bounds.bottom
                    {
                        let command = if IsZoomed(state.parent) != 0 {
                            SC_RESTORE
                        } else {
                            SC_MAXIMIZE
                        };
                        PostMessageW(state.parent, WM_SYSCOMMAND, command as usize, 0);
                    }
                    return 0;
                }
                WM_PAINT => {
                    ValidateRect(hwnd, null_mut());
                    return 0;
                }
                WM_ERASEBKGND => return 1,
                _ => {}
            }
            DefSubclassProc(hwnd, message, wp, lp)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chrome_colors_cannot_inject_css() {
        assert!(is_css_hex("#f8f0e4"));
        assert!(is_css_hex("#00D2FF"));
        assert!(!is_css_hex("red; background: url(x)"));
        assert!(!is_css_hex("#fffffg"));
        assert!(!is_css_hex("#fff"));
    }
    #[test]
    fn native_region_is_bounded_in_physical_client_coordinates() {
        let region = MaximizeRegion {
            x: 908,
            y: 0,
            width: 46,
            height: 52,
        };
        assert!(region.fits(1000, 800));
        assert!(!region.fits(930, 800));
        assert!(!MaximizeRegion { x: -1, ..region }.fits(1000, 800));
        assert!(!MaximizeRegion { width: 0, ..region }.fits(1000, 800));
        assert!(
            !MaximizeRegion {
                x: i32::MAX,
                ..region
            }
            .fits(1000, 800)
        );
        assert!(
            !MaximizeRegion {
                width: 513,
                ..region
            }
            .fits(3000, 1600)
        );
        assert!(
            MaximizeRegion {
                x: 1362,
                y: 0,
                width: 69,
                height: 78
            }
            .fits(1500, 1200)
        );
    }
}
