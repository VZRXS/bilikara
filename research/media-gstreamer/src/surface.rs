//! Linux/X11 output adapter for the isolated PoC. Domain commands use tokens;
//! native handles stay private here. No product or mobile Surface ABI is added.
use gstreamer::{self as gst, prelude::*};
use gstreamer_video::prelude::*;
use std::{
    ffi::c_void,
    os::raw::{c_char, c_int, c_uint, c_ulong},
};

#[link(name = "X11")]
unsafe extern "C" {
    fn XInitThreads() -> c_int;
    fn XOpenDisplay(name: *const c_char) -> *mut c_void;
    fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
    fn XCreateSimpleWindow(
        display: *mut c_void,
        parent: c_ulong,
        x: c_int,
        y: c_int,
        width: c_uint,
        height: c_uint,
        border: c_uint,
        border_pixel: c_ulong,
        background: c_ulong,
    ) -> c_ulong;
    fn XMapWindow(display: *mut c_void, window: c_ulong) -> c_int;
    fn XUnmapWindow(display: *mut c_void, window: c_ulong) -> c_int;
    fn XSync(display: *mut c_void, discard: c_int) -> c_int;
    fn XGetImage(
        display: *mut c_void,
        window: c_ulong,
        x: c_int,
        y: c_int,
        width: c_uint,
        height: c_uint,
        planes: c_ulong,
        format: c_int,
    ) -> *mut c_void;
    fn XGetPixel(image: *mut c_void, x: c_int, y: c_int) -> c_ulong;
    fn XDestroyImage(image: *mut c_void) -> c_int;
    fn XDestroyWindow(display: *mut c_void, window: c_ulong) -> c_int;
    fn XCloseDisplay(display: *mut c_void) -> c_int;
}
pub fn initialize_threads() {
    assert_ne!(unsafe { XInitThreads() }, 0, "X11 thread initialization");
}
pub struct Surfaces {
    display: *mut c_void,
    windows: [c_ulong; 2],
    current: usize,
}
impl Surfaces {
    pub fn new() -> Self {
        let display = unsafe { XOpenDisplay(std::ptr::null()) };
        assert!(!display.is_null(), "X11 display unavailable");
        let root = unsafe { XDefaultRootWindow(display) };
        let windows = [
            unsafe { XCreateSimpleWindow(display, root, 0, 0, 1280, 800, 0, 0, 0) },
            unsafe { XCreateSimpleWindow(display, root, 0, 0, 1920, 1080, 0, 0, 0) },
        ];
        assert!(windows.iter().all(|window| *window != 0));
        Self {
            display,
            windows,
            current: 1,
        }
    }
    pub fn attach(&mut self, sink: &gst::Element, token: &str) -> Option<(i32, i32)> {
        let index = match token {
            "host" => 0,
            "audience" => 1,
            _ => return None,
        };
        unsafe {
            XMapWindow(self.display, self.windows[index]);
            XSync(self.display, 0);
        }
        let overlay = sink
            .clone()
            .dynamic_cast::<gstreamer_video::VideoOverlay>()
            .expect("video sink overlay");
        // Windows already exist on this native control thread. No UI calls run
        // from a GStreamer streaming callback and audio state is never changed.
        unsafe {
            overlay.set_window_handle(self.windows[index] as usize);
        }
        if self.current != index {
            unsafe {
                XUnmapWindow(self.display, self.windows[self.current]);
            }
        }
        self.current = index;
        Some(if index == 1 {
            (1920, 1080)
        } else {
            (1280, 720)
        })
    }
    pub fn visible_colors(&self) -> usize {
        let (width, height) = if self.current == 1 {
            (1920, 1080)
        } else {
            (1280, 800)
        };
        let image = unsafe {
            XGetImage(
                self.display,
                // ximagesink may render into its own child drawable; inspect
                // the visible composited root, not the parent's background.
                XDefaultRootWindow(self.display),
                0,
                0,
                width,
                height,
                c_ulong::MAX,
                2,
            )
        };
        if image.is_null() {
            return 0;
        }
        let mut colors = std::collections::HashSet::new();
        for y in 1..10 {
            for x in 1..10 {
                colors.insert(unsafe {
                    XGetPixel(image, (width as i32 * x) / 10, (height as i32 * y) / 10)
                });
            }
        }
        unsafe {
            XDestroyImage(image);
        }
        colors.len()
    }
    /// Explicit synthetic 640x360 barcode fixture only. This reads composited
    /// X11 pixels, not a sink's decoded-but-not-presented input buffer.
    pub fn timecode_frame(&self) -> Option<u64> {
        let width = if self.current == 1 { 1920 } else { 1280 };
        let y = if self.current == 1 { 48 } else { 72 };
        // Host's 1280x720 video is vertically centered in its 800px window.
        let image = unsafe {
            XGetImage(
                self.display,
                XDefaultRootWindow(self.display),
                0,
                y,
                width,
                1,
                c_ulong::MAX,
                2,
            )
        };
        if image.is_null() {
            return None;
        }
        let mut frame = 0u64;
        for bit in 0..20 {
            let pixel = unsafe { XGetPixel(image, (bit * 2 + 1) * width as i32 / 40, 0) };
            if pixel & 0xff > 128 {
                frame |= 1 << bit;
            }
        }
        unsafe {
            XDestroyImage(image);
        }
        Some(frame)
    }
}
impl Drop for Surfaces {
    fn drop(&mut self) {
        unsafe {
            for window in self.windows {
                XDestroyWindow(self.display, window);
            }
            XCloseDisplay(self.display);
        }
    }
}
