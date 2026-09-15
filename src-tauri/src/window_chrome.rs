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

// Window-local pointer gesture; never application state. Capture release may
// arrive as a client message, and capture loss must cancel a pending click.
#[cfg(any(windows, test))]
#[derive(Default)]
struct CaptionClick {
    pressed: bool,
}

#[cfg(any(windows, test))]
impl CaptionClick {
    fn press(&mut self) {
        self.pressed = true;
    }
    fn cancel(&mut self) {
        self.pressed = false;
    }
    fn release(&mut self, inside: bool) -> bool {
        std::mem::take(&mut self.pressed) && inside
    }
}

#[cfg(windows)]
mod native {
    use super::{CaptionClick, MaximizeRegion};
    use std::ptr::null_mut;
    use tauri::Emitter;
    use windows_sys::{
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
            Graphics::{Dwm::DwmDefWindowProc, Gdi::ValidateRect},
            UI::{
                Input::KeyboardAndMouse::{
                    ReleaseCapture, SetCapture, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
                    TrackMouseEvent,
                },
                Shell::{
                    DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass,
                },
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
        click: CaptionClick,
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
                    click: CaptionClick::default(),
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
            let child = GetPropW(hwnd, PROPERTY) as HWND;
            let mut data = 0usize;
            if !child.is_null()
                && GetWindowSubclass(child, Some(button_proc), SUBCLASS, &mut data) != 0
            {
                if message == WM_NCHITTEST && IsWindowVisible(child) != 0 {
                    let mut rect: RECT = std::mem::zeroed();
                    let point = POINT {
                        x: lp as i16 as i32,
                        y: (lp >> 16) as i16 as i32,
                    };
                    if GetWindowRect(child, &mut rect) != 0
                        && point.x >= rect.left
                        && point.x < rect.right
                        && point.y >= rect.top
                        && point.y < rect.bottom
                    {
                        // The top-level HWND owns caption semantics. Windows 11
                        // can show Snap Layouts; earlier versions keep OS behavior.
                        return HTMAXBUTTON as LRESULT;
                    }
                }
                if message == WM_NCLBUTTONDOWN && wp == HTMAXBUTTON as usize {
                    return SendMessageW(child, message, wp, lp);
                }
                if matches!(message, WM_SIZE | WM_DPICHANGED) {
                    ShowWindow(child, SW_HIDE);
                }
            }
            // Let DWM and the standard top-level procedure implement native
            // hover and tooltips/Snap. The child handles captured click/release.
            if matches!(
                message,
                WM_NCMOUSEMOVE | WM_NCMOUSELEAVE | WM_NCLBUTTONDOWN | WM_NCLBUTTONUP
            ) {
                let mut result = 0;
                if DwmDefWindowProc(hwnd, message, wp, lp, &mut result) != 0 {
                    return result;
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
            match message {
                WM_NCHITTEST => return HTMAXBUTTON as LRESULT,
                WM_NCMOUSEMOVE => {
                    if !(*pointer).hovered {
                        (*pointer).hovered = true;
                        let _ = (*pointer).window.emit("bilikara:maximize-hover", true);
                        let mut tracking = TRACKMOUSEEVENT {
                            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE | TME_NONCLIENT,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        };
                        TrackMouseEvent(&mut tracking);
                    }
                    // DWM needs the top-level hover for Windows 11 Snap. The
                    // child owns leave tracking: tracking the parent flickers
                    // because the cursor is actually over this child HWND.
                    let parent = (*pointer).parent;
                    return SendMessageW(parent, message, wp, lp);
                }
                WM_NCMOUSELEAVE | WM_CANCELMODE | WM_CAPTURECHANGED => {
                    (*pointer).hovered = false;
                    if message != WM_NCMOUSELEAVE {
                        (*pointer).click.cancel();
                    }
                    let _ = (*pointer).window.emit("bilikara:maximize-hover", false);
                }
                WM_NCLBUTTONDOWN => {
                    (*pointer).click.press();
                    SetCapture(hwnd);
                    return 0;
                }
                WM_LBUTTONUP | WM_NCLBUTTONUP => {
                    // Capture converts non-client release into WM_LBUTTONUP.
                    // Copy state before releasing capture (synchronous reentry).
                    let parent = (*pointer).parent;
                    let mut point: POINT = std::mem::zeroed();
                    let mut rect: RECT = std::mem::zeroed();
                    let inside = GetCursorPos(&mut point) != 0
                        && GetWindowRect(hwnd, &mut rect) != 0
                        && point.x >= rect.left
                        && point.x < rect.right
                        && point.y >= rect.top
                        && point.y < rect.bottom;
                    let clicked = (*pointer).click.release(inside);
                    ReleaseCapture();
                    if clicked {
                        let command = if IsZoomed(parent) != 0 {
                            SC_RESTORE
                        } else {
                            SC_MAXIMIZE
                        };
                        PostMessageW(parent, WM_SYSCOMMAND, command as usize, 0);
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
    fn caption_click_requires_press_and_inside_release_and_cancels_on_capture_loss() {
        let mut click = CaptionClick::default();
        assert!(!click.release(true));
        click.press();
        assert!(!click.release(false));
        assert!(!click.release(true));
        click.press();
        click.cancel();
        assert!(!click.release(true));
        click.press();
        assert!(click.release(true));
        assert!(!click.release(true));
    }

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
