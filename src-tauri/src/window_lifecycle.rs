use crate::backend_process::{self, BackendProcess};
use crate::desktop_diagnostics::append_desktop_diagnostic;
use crate::presentation;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use tauri::Manager;

const MAIN_WINDOW_LABEL: &str = "main";
const GEOMETRY_SCHEMA_VERSION: u8 = 1;
const GEOMETRY_FILENAME: &str = "main-window-geometry-v1.json";
const MAX_GEOMETRY_FILE_BYTES: u64 = 16 * 1024;

// The current Host keeps its two-column layout at 1120 logical pixels. The adaptive
// default prefers that amount of room when a monitor can provide it, but always yields
// to the usable work area on a smaller or portrait display.
const FIRST_LAUNCH_WIDTH_RATIO: f64 = 0.86;
const FIRST_LAUNCH_HEIGHT_RATIO: f64 = 0.88;
const FIRST_LAUNCH_MIN_WIDTH: f64 = 1120.0;
const FIRST_LAUNCH_MIN_HEIGHT: f64 = 680.0;
const FIRST_LAUNCH_MAX_WIDTH: f64 = 1680.0;
const FIRST_LAUNCH_MAX_HEIGHT: f64 = 1050.0;
const SAVED_MIN_WIDTH: f64 = 640.0;
const SAVED_MIN_HEIGHT: f64 = 480.0;
const SAVED_MAX_WIDTH: f64 = 3200.0;
const SAVED_MAX_HEIGHT: f64 = 2000.0;
const WORK_AREA_EDGE_MARGIN: f64 = 12.0;
const MIN_VISIBLE_WIDTH: f64 = 160.0;
const MIN_VISIBLE_HEIGHT: f64 = 80.0;
const MIN_VISIBLE_AREA_RATIO: f64 = 0.25;
const DEFAULT_FRAME_WIDTH: f64 = 16.0;
const DEFAULT_FRAME_HEIGHT: f64 = 40.0;
const MAX_FRAME_EXTENT: f64 = 160.0;
const APPLICATION_RUNNING: u8 = 0;
const APPLICATION_RESTARTING: u8 = 1;
const APPLICATION_EXITING: u8 = 2;

static GEOMETRY_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredMainWindowGeometry {
    schema_version: u8,
    normal: StoredNormalGeometry,
    maximized: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredNormalGeometry {
    // Position is stored as a logical offset from the monitor work area. Keeping
    // the size and offset logical lets a matching monitor change DPI without
    // changing the user's perceived window geometry.
    offset_x: f64,
    offset_y: f64,
    width: f64,
    height: f64,
    monitor: StoredMonitorWorkArea,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredMonitorWorkArea {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct MonitorWorkArea {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LogicalFrameSize {
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ResolvedMainWindowGeometry {
    monitor_index: usize,
    offset_x: f64,
    offset_y: f64,
    inner_width: f64,
    inner_height: f64,
    physical_x: i32,
    physical_y: i32,
    physical_inner_width: u32,
    physical_inner_height: u32,
    maximized: bool,
    used_saved_geometry: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct RequestedMainWindowGeometry {
    inner_width: f64,
    inner_height: f64,
    offset: Option<(f64, f64)>,
    maximized: bool,
    used_saved_geometry: bool,
}

struct MainWindowGeometryState {
    path: Option<PathBuf>,
    cached: Mutex<Option<StoredMainWindowGeometry>>,
    restoring: AtomicBool,
}

#[derive(Debug, Default)]
pub(crate) struct ApplicationLifecycleState {
    phase: AtomicU8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RestartClaim {
    Accepted,
    AlreadyAccepted,
    ShutdownInProgress,
}

impl ApplicationLifecycleState {
    fn claim_restart(&self) -> RestartClaim {
        match self.phase.compare_exchange(
            APPLICATION_RUNNING,
            APPLICATION_RESTARTING,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => RestartClaim::Accepted,
            Err(APPLICATION_RESTARTING) => RestartClaim::AlreadyAccepted,
            Err(_) => RestartClaim::ShutdownInProgress,
        }
    }

    fn claim_window_shutdown(&self) -> bool {
        self.phase
            .compare_exchange(
                APPLICATION_RUNNING,
                APPLICATION_EXITING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn restart_in_progress(&self) -> bool {
        self.phase.load(Ordering::Acquire) == APPLICATION_RESTARTING
    }

    fn release_restart_after_preparation_failure(&self) {
        let _ = self.phase.compare_exchange(
            APPLICATION_RESTARTING,
            APPLICATION_RUNNING,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

impl MainWindowGeometryState {
    fn new(path: Option<PathBuf>, cached: Option<StoredMainWindowGeometry>) -> Self {
        Self {
            path,
            cached: Mutex::new(cached),
            restoring: AtomicBool::new(false),
        }
    }

    fn replace_cached(&self, geometry: StoredMainWindowGeometry) {
        if let Ok(mut cached) = self.cached.lock() {
            *cached = Some(geometry);
        }
    }

    fn set_maximized(&self, maximized: bool) {
        if let Ok(mut cached) = self.cached.lock()
            && let Some(geometry) = cached.as_mut()
        {
            geometry.maximized = maximized;
        }
    }

    fn persist(&self) -> Result<(), String> {
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| "the app configuration directory is unavailable".to_string())?;
        let geometry = self
            .cached
            .lock()
            .map_err(|_| "the geometry cache is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "no valid normal geometry has been captured".to_string())?;
        if !stored_geometry_is_valid(&geometry) {
            return Err("the cached geometry is invalid".to_string());
        }
        atomic_write_geometry(path, &geometry).map_err(|error| error.to_string())
    }
}

fn finite_in_range(value: f64, minimum: f64, maximum: f64) -> bool {
    value.is_finite() && value >= minimum && value <= maximum
}

fn monitor_is_valid(monitor: &MonitorWorkArea) -> bool {
    finite_in_range(monitor.scale_factor, 0.5, 8.0)
        && monitor.width > 0
        && monitor.height > 0
        && f64::from(monitor.width) / monitor.scale_factor >= 320.0
        && f64::from(monitor.height) / monitor.scale_factor >= 240.0
}

fn stored_monitor_is_valid(monitor: &StoredMonitorWorkArea) -> bool {
    monitor
        .name
        .as_ref()
        .is_none_or(|name| !name.is_empty() && name.len() <= 256)
        && finite_in_range(monitor.scale_factor, 0.5, 8.0)
        && monitor.width > 0
        && monitor.height > 0
}

fn stored_geometry_is_valid(geometry: &StoredMainWindowGeometry) -> bool {
    geometry.schema_version == GEOMETRY_SCHEMA_VERSION
        && finite_in_range(geometry.normal.width, SAVED_MIN_WIDTH, SAVED_MAX_WIDTH)
        && finite_in_range(geometry.normal.height, SAVED_MIN_HEIGHT, SAVED_MAX_HEIGHT)
        && finite_in_range(geometry.normal.offset_x, -100_000.0, 100_000.0)
        && finite_in_range(geometry.normal.offset_y, -100_000.0, 100_000.0)
        && stored_monitor_is_valid(&geometry.normal.monitor)
}

fn logical_frame_size(
    inner: tauri::PhysicalSize<u32>,
    outer: tauri::PhysicalSize<u32>,
    scale: f64,
) -> LogicalFrameSize {
    let scale = if finite_in_range(scale, 0.5, 8.0) {
        scale
    } else {
        1.0
    };
    let measured_width = f64::from(outer.width.saturating_sub(inner.width)) / scale;
    let measured_height = f64::from(outer.height.saturating_sub(inner.height)) / scale;
    LogicalFrameSize {
        width: if measured_width > 0.0 && measured_width <= MAX_FRAME_EXTENT {
            measured_width
        } else {
            DEFAULT_FRAME_WIDTH
        },
        height: if measured_height > 0.0 && measured_height <= MAX_FRAME_EXTENT {
            measured_height
        } else {
            DEFAULT_FRAME_HEIGHT
        },
    }
}

fn rectangle_intersection_area(left: (i64, i64, i64, i64), right: (i64, i64, i64, i64)) -> i128 {
    let intersection_width = (left.2.min(right.2) - left.0.max(right.0)).max(0);
    let intersection_height = (left.3.min(right.3) - left.1.max(right.1)).max(0);
    i128::from(intersection_width) * i128::from(intersection_height)
}

fn monitor_rectangle(monitor: &MonitorWorkArea) -> (i64, i64, i64, i64) {
    (
        i64::from(monitor.x),
        i64::from(monitor.y),
        i64::from(monitor.x) + i64::from(monitor.width),
        i64::from(monitor.y) + i64::from(monitor.height),
    )
}

fn stored_monitor_rectangle(monitor: &StoredMonitorWorkArea) -> (i64, i64, i64, i64) {
    (
        i64::from(monitor.x),
        i64::from(monitor.y),
        i64::from(monitor.x) + i64::from(monitor.width),
        i64::from(monitor.y) + i64::from(monitor.height),
    )
}

fn saved_monitor_index(
    monitors: &[MonitorWorkArea],
    saved: &StoredMonitorWorkArea,
) -> Option<usize> {
    if let Some(saved_name) = saved.name.as_deref() {
        let mut matching_names = monitors
            .iter()
            .enumerate()
            .filter(|(_, monitor)| monitor.name.as_deref() == Some(saved_name));
        let first = matching_names.next().map(|(index, _)| index);
        if first.is_some() && matching_names.next().is_none() {
            return first;
        }
    }

    let saved_rectangle = stored_monitor_rectangle(saved);
    let saved_area = i128::from(saved.width) * i128::from(saved.height);
    monitors
        .iter()
        .enumerate()
        .filter_map(|(index, monitor)| {
            let intersection =
                rectangle_intersection_area(saved_rectangle, monitor_rectangle(monitor));
            let current_area = i128::from(monitor.width) * i128::from(monitor.height);
            let denominator = saved_area.min(current_area);
            (denominator > 0 && intersection * 2 >= denominator).then_some((index, intersection))
        })
        .max_by_key(|(_, intersection)| *intersection)
        .map(|(index, _)| index)
}

fn safe_monitor_index(monitors: &[MonitorWorkArea], requested: usize) -> Option<usize> {
    monitors
        .get(requested)
        .filter(|monitor| monitor_is_valid(monitor))
        .map(|_| requested)
        .or_else(|| monitors.iter().position(monitor_is_valid))
}

fn centered_offset(work_extent: f64, outer_extent: f64) -> f64 {
    ((work_extent - outer_extent) / 2.0).max(WORK_AREA_EDGE_MARGIN)
}

fn clamp_or_center_saved_offset(
    offset_x: f64,
    offset_y: f64,
    outer_width: f64,
    outer_height: f64,
    work_width: f64,
    work_height: f64,
) -> (f64, f64) {
    let visible_width = (offset_x + outer_width).min(work_width) - offset_x.max(0.0);
    let visible_height = (offset_y + outer_height).min(work_height) - offset_y.max(0.0);
    let visible_width = visible_width.max(0.0);
    let visible_height = visible_height.max(0.0);
    let visible_area = visible_width * visible_height;
    let outer_area = outer_width * outer_height;
    let substantially_visible = visible_width >= MIN_VISIBLE_WIDTH.min(outer_width)
        && visible_height >= MIN_VISIBLE_HEIGHT.min(outer_height)
        && outer_area > 0.0
        && visible_area / outer_area >= MIN_VISIBLE_AREA_RATIO;

    if !substantially_visible {
        return (
            centered_offset(work_width, outer_width),
            centered_offset(work_height, outer_height),
        );
    }

    let maximum_x = (work_width - WORK_AREA_EDGE_MARGIN - outer_width).max(WORK_AREA_EDGE_MARGIN);
    let maximum_y = (work_height - WORK_AREA_EDGE_MARGIN - outer_height).max(WORK_AREA_EDGE_MARGIN);
    (
        offset_x.clamp(WORK_AREA_EDGE_MARGIN, maximum_x),
        offset_y.clamp(WORK_AREA_EDGE_MARGIN, maximum_y),
    )
}

fn resolved_geometry(
    monitor_index: usize,
    monitor: &MonitorWorkArea,
    frame: LogicalFrameSize,
    requested: RequestedMainWindowGeometry,
) -> ResolvedMainWindowGeometry {
    let work_width = f64::from(monitor.width) / monitor.scale_factor;
    let work_height = f64::from(monitor.height) / monitor.scale_factor;
    let available_inner_width = (work_width - frame.width - (2.0 * WORK_AREA_EDGE_MARGIN)).max(1.0);
    let available_inner_height =
        (work_height - frame.height - (2.0 * WORK_AREA_EDGE_MARGIN)).max(1.0);
    let inner_width = requested.inner_width.min(available_inner_width).max(1.0);
    let inner_height = requested.inner_height.min(available_inner_height).max(1.0);
    let outer_width = inner_width + frame.width;
    let outer_height = inner_height + frame.height;
    let (offset_x, offset_y) = requested
        .offset
        .map(|(x, y)| {
            clamp_or_center_saved_offset(x, y, outer_width, outer_height, work_width, work_height)
        })
        .unwrap_or_else(|| {
            (
                centered_offset(work_width, outer_width),
                centered_offset(work_height, outer_height),
            )
        });

    let physical_x = (f64::from(monitor.x) + (offset_x * monitor.scale_factor))
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
    let physical_y = (f64::from(monitor.y) + (offset_y * monitor.scale_factor))
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32;
    let physical_inner_width = (inner_width * monitor.scale_factor)
        .floor()
        .clamp(1.0, f64::from(u32::MAX)) as u32;
    let physical_inner_height = (inner_height * monitor.scale_factor)
        .floor()
        .clamp(1.0, f64::from(u32::MAX)) as u32;

    ResolvedMainWindowGeometry {
        monitor_index,
        offset_x,
        offset_y,
        inner_width,
        inner_height,
        physical_x,
        physical_y,
        physical_inner_width,
        physical_inner_height,
        maximized: requested.maximized,
        used_saved_geometry: requested.used_saved_geometry,
    }
}

/// Resolves one complete main-window geometry decision without consulting the OS.
/// All ratios and limits operate on logical units; only the final result is converted
/// to the selected monitor's physical coordinate space.
fn resolve_main_window_geometry(
    monitors: &[MonitorWorkArea],
    preferred_monitor_index: usize,
    primary_monitor_index: usize,
    frame: LogicalFrameSize,
    saved: Option<&StoredMainWindowGeometry>,
) -> Option<ResolvedMainWindowGeometry> {
    let preferred_monitor_index = safe_monitor_index(monitors, preferred_monitor_index)?;
    let primary_monitor_index =
        safe_monitor_index(monitors, primary_monitor_index).unwrap_or(preferred_monitor_index);
    let frame = LogicalFrameSize {
        width: if finite_in_range(frame.width, 0.0, MAX_FRAME_EXTENT) {
            frame.width
        } else {
            DEFAULT_FRAME_WIDTH
        },
        height: if finite_in_range(frame.height, 0.0, MAX_FRAME_EXTENT) {
            frame.height
        } else {
            DEFAULT_FRAME_HEIGHT
        },
    };

    if let Some(saved) = saved.filter(|saved| stored_geometry_is_valid(saved)) {
        let matched_monitor_index = saved_monitor_index(monitors, &saved.normal.monitor)
            .filter(|index| monitor_is_valid(&monitors[*index]));
        let monitor_index = matched_monitor_index.unwrap_or(primary_monitor_index);
        let monitor = &monitors[monitor_index];
        return Some(resolved_geometry(
            monitor_index,
            monitor,
            frame,
            RequestedMainWindowGeometry {
                inner_width: saved.normal.width,
                inner_height: saved.normal.height,
                offset: matched_monitor_index
                    .map(|_| (saved.normal.offset_x, saved.normal.offset_y)),
                maximized: saved.maximized,
                used_saved_geometry: true,
            },
        ));
    }

    let monitor = &monitors[preferred_monitor_index];
    let work_width = f64::from(monitor.width) / monitor.scale_factor;
    let work_height = f64::from(monitor.height) / monitor.scale_factor;
    let requested_width = (work_width * FIRST_LAUNCH_WIDTH_RATIO)
        .clamp(FIRST_LAUNCH_MIN_WIDTH, FIRST_LAUNCH_MAX_WIDTH);
    let requested_height = (work_height * FIRST_LAUNCH_HEIGHT_RATIO)
        .clamp(FIRST_LAUNCH_MIN_HEIGHT, FIRST_LAUNCH_MAX_HEIGHT);
    Some(resolved_geometry(
        preferred_monitor_index,
        monitor,
        frame,
        RequestedMainWindowGeometry {
            inner_width: requested_width,
            inner_height: requested_height,
            offset: None,
            maximized: false,
            used_saved_geometry: false,
        },
    ))
}

fn monitor_work_area(monitor: &tauri::window::Monitor) -> MonitorWorkArea {
    let work_area = monitor.work_area();
    MonitorWorkArea {
        name: monitor.name().cloned(),
        x: work_area.position.x,
        y: work_area.position.y,
        width: work_area.size.width,
        height: work_area.size.height,
        scale_factor: monitor.scale_factor(),
    }
}

fn same_monitor(left: &MonitorWorkArea, right: &MonitorWorkArea) -> bool {
    left.name == right.name
        && left.x == right.x
        && left.y == right.y
        && left.width == right.width
        && left.height == right.height
        && (left.scale_factor - right.scale_factor).abs() < f64::EPSILON
}

fn monitor_index_for(
    monitors: &[MonitorWorkArea],
    monitor: Option<tauri::window::Monitor>,
) -> Option<usize> {
    let candidate = monitor.map(|monitor| monitor_work_area(&monitor))?;
    monitors
        .iter()
        .position(|monitor| same_monitor(monitor, &candidate))
}

fn available_work_areas(
    window: &tauri::Window,
) -> tauri::Result<(Vec<MonitorWorkArea>, usize, usize)> {
    let monitors: Vec<_> = window
        .available_monitors()?
        .iter()
        .map(monitor_work_area)
        .collect();
    let primary_index = monitor_index_for(&monitors, window.primary_monitor()?).unwrap_or(0);
    let preferred_index =
        monitor_index_for(&monitors, window.current_monitor()?).unwrap_or(primary_index);
    Ok((monitors, preferred_index, primary_index))
}

fn stored_from_resolved(
    resolved: ResolvedMainWindowGeometry,
    monitor: &MonitorWorkArea,
) -> StoredMainWindowGeometry {
    StoredMainWindowGeometry {
        schema_version: GEOMETRY_SCHEMA_VERSION,
        normal: StoredNormalGeometry {
            offset_x: resolved.offset_x,
            offset_y: resolved.offset_y,
            width: resolved.inner_width,
            height: resolved.inner_height,
            monitor: StoredMonitorWorkArea {
                name: monitor.name.clone(),
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                scale_factor: monitor.scale_factor,
            },
        },
        maximized: resolved.maximized,
    }
}

fn load_geometry(path: &Path) -> Result<Option<StoredMainWindowGeometry>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_GEOMETRY_FILE_BYTES {
        return Err("the geometry file exceeds the bounded size".to_string());
    }
    let mut encoded = Vec::new();
    file.take(MAX_GEOMETRY_FILE_BYTES + 1)
        .read_to_end(&mut encoded)
        .map_err(|error| error.to_string())?;
    if encoded.len() as u64 > MAX_GEOMETRY_FILE_BYTES {
        return Err("the geometry file exceeds the bounded size".to_string());
    }
    serde_json::from_slice(&encoded)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn atomic_write_geometry(path: &Path, geometry: &StoredMainWindowGeometry) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "geometry path has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let suffix = GEOMETRY_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{GEOMETRY_FILENAME}.{}.{}.tmp",
        std::process::id(),
        suffix
    ));
    let encoded = serde_json::to_vec_pretty(geometry).map_err(std::io::Error::other)?;
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        replace_geometry_file(&temporary, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(not(windows))]
fn replace_geometry_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_geometry_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: Both paths are valid, null-terminated UTF-16 buffers for this call.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn geometry_diagnostic(stage: &str, status: &str) {
    append_desktop_diagnostic(
        "main_window_geometry",
        format!("stage={stage} status={status}"),
    );
}

pub(crate) fn initialize_main_window_geometry(app: &tauri::App, window: &tauri::WebviewWindow) {
    if window.label() != MAIN_WINDOW_LABEL {
        geometry_diagnostic("initialize", "ignored_non_main");
        return;
    }

    // Configuration and the custom macOS builder both create `main` hidden. Keep
    // that invariant explicit at the geometry boundary; only backend readiness shows it.
    if window.hide().is_err() {
        geometry_diagnostic("hide_before_restore", "error_ignored");
    }

    let path = app
        .path()
        .app_config_dir()
        .map(|directory| directory.join(GEOMETRY_FILENAME))
        .map_err(|_| ())
        .ok();
    let saved = path.as_deref().and_then(|path| match load_geometry(path) {
        Ok(Some(geometry)) if stored_geometry_is_valid(&geometry) => Some(geometry),
        Ok(Some(_)) => {
            geometry_diagnostic("load", "invalid_ignored");
            None
        }
        Ok(None) => None,
        Err(_) => {
            geometry_diagnostic("load", "error_ignored");
            None
        }
    });

    let native_window = window.as_ref().window();
    let frame = native_window
        .inner_size()
        .and_then(|inner| native_window.outer_size().map(|outer| (inner, outer)))
        .map(|(inner, outer)| {
            logical_frame_size(inner, outer, native_window.scale_factor().unwrap_or(1.0))
        })
        .unwrap_or(LogicalFrameSize {
            width: DEFAULT_FRAME_WIDTH,
            height: DEFAULT_FRAME_HEIGHT,
        });
    let decision =
        available_work_areas(&native_window)
            .ok()
            .and_then(|(monitors, preferred, primary)| {
                resolve_main_window_geometry(&monitors, preferred, primary, frame, saved.as_ref())
                    .map(|resolved| {
                        let stored =
                            stored_from_resolved(resolved, &monitors[resolved.monitor_index]);
                        (resolved, stored)
                    })
            });

    let state =
        MainWindowGeometryState::new(path, decision.as_ref().map(|(_, stored)| stored.clone()));
    state.restoring.store(true, Ordering::Release);
    if !app.manage(state) {
        geometry_diagnostic("initialize", "state_already_managed");
        return;
    }

    let Some((resolved, _)) = decision else {
        geometry_diagnostic("resolve", "monitor_unavailable_fallback_center");
        let _ = window.center();
        if let Some(state) = app.try_state::<MainWindowGeometryState>() {
            state.restoring.store(false, Ordering::Release);
        }
        return;
    };

    let size_result = window.set_size(tauri::PhysicalSize::new(
        resolved.physical_inner_width,
        resolved.physical_inner_height,
    ));
    let position_result = window.set_position(tauri::PhysicalPosition::new(
        resolved.physical_x,
        resolved.physical_y,
    ));
    let maximize_result = if resolved.maximized {
        window.maximize()
    } else {
        window.unmaximize()
    };
    if let Some(state) = app.try_state::<MainWindowGeometryState>() {
        state.restoring.store(false, Ordering::Release);
    }
    if size_result.is_err() || position_result.is_err() || maximize_result.is_err() {
        geometry_diagnostic("apply", "error_ignored");
    } else if resolved.used_saved_geometry {
        geometry_diagnostic("apply", "restored");
    } else {
        geometry_diagnostic("apply", "adaptive_default");
    }
}

fn captured_normal_geometry(window: &tauri::Window) -> Option<StoredMainWindowGeometry> {
    let (monitors, _, _) = available_work_areas(window).ok()?;
    let position = window.outer_position().ok()?;
    let outer_size = window.outer_size().ok()?;
    let inner_size = window.inner_size().ok()?;
    let window_rectangle = (
        i64::from(position.x),
        i64::from(position.y),
        i64::from(position.x) + i64::from(outer_size.width),
        i64::from(position.y) + i64::from(outer_size.height),
    );
    let monitor_index = monitors
        .iter()
        .enumerate()
        .filter(|(_, monitor)| monitor_is_valid(monitor))
        .max_by_key(|(_, monitor)| {
            rectangle_intersection_area(window_rectangle, monitor_rectangle(monitor))
        })
        .map(|(index, _)| index)?;
    let monitor = &monitors[monitor_index];
    let normal = StoredNormalGeometry {
        offset_x: (i64::from(position.x) - i64::from(monitor.x)) as f64 / monitor.scale_factor,
        offset_y: (i64::from(position.y) - i64::from(monitor.y)) as f64 / monitor.scale_factor,
        width: f64::from(inner_size.width) / monitor.scale_factor,
        height: f64::from(inner_size.height) / monitor.scale_factor,
        monitor: StoredMonitorWorkArea {
            name: monitor.name.clone(),
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            scale_factor: monitor.scale_factor,
        },
    };
    let geometry = StoredMainWindowGeometry {
        schema_version: GEOMETRY_SCHEMA_VERSION,
        normal,
        maximized: false,
    };
    stored_geometry_is_valid(&geometry).then_some(geometry)
}

fn refresh_cached_main_window_geometry(window: &tauri::Window) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }
    let Some(state) = window.try_state::<MainWindowGeometryState>() else {
        return;
    };
    if state.restoring.load(Ordering::Acquire) || window.is_fullscreen().unwrap_or(true) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        state.set_maximized(true);
        return;
    }
    if window.is_minimized().unwrap_or(true) {
        return;
    }
    if let Some(geometry) = captured_normal_geometry(window) {
        state.replace_cached(geometry);
    }
}

pub(crate) fn save_main_window_geometry(window: &tauri::Window) -> Result<(), String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("only the main window owns remembered geometry".to_string());
    }
    refresh_cached_main_window_geometry(window);
    window
        .try_state::<MainWindowGeometryState>()
        .ok_or_else(|| "the main-window geometry state is unavailable".to_string())?
        .persist()
}

async fn prepare_application_restart_on_main_thread(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let app = app.clone();
    let window = window.clone();
    app.clone()
        .run_on_main_thread(move || {
            // GTK/AppKit window inspection and controller teardown belong on the
            // desktop main thread. Geometry failure remains intentionally non-fatal.
            let result = save_main_window_geometry(&window.as_ref().window());
            append_desktop_diagnostic(
                "application_restart",
                if result.is_ok() {
                    "stage=geometry_saved status=ok"
                } else {
                    "stage=geometry_saved status=error_ignored"
                },
            );
            presentation::prepare_app_shutdown(&app);
            append_desktop_diagnostic(
                "application_restart",
                "stage=presentation_shutdown_prepared",
            );
            let _ = sender.try_send(());
        })
        .map_err(|error| format!("failed to schedule application restart cleanup: {error}"))?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "application restart cleanup did not complete".to_string())
}

#[tauri::command]
pub(crate) async fn restart_application(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
    lifecycle: tauri::State<'_, ApplicationLifecycleState>,
) -> Result<(), String> {
    presentation::authorize_window(&window, &backend, &[MAIN_WINDOW_LABEL])?;
    match lifecycle.claim_restart() {
        RestartClaim::Accepted => {}
        RestartClaim::AlreadyAccepted => return Ok(()),
        RestartClaim::ShutdownInProgress => {
            return Err("application shutdown is already in progress".to_string());
        }
    }
    append_desktop_diagnostic("application_restart", "stage=accepted");

    if let Err(error) = prepare_application_restart_on_main_thread(&app, &window).await {
        lifecycle.release_restart_after_preparation_failure();
        append_desktop_diagnostic(
            "application_restart",
            "stage=main_thread_preparation status=failed",
        );
        return Err(error);
    }

    let backend = backend.inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        backend_process::shutdown(&backend);
        append_desktop_diagnostic("application_restart", "stage=backend_shutdown_finished");
        append_desktop_diagnostic("application_restart", "stage=restart_requested");
        // Locked Tauri 2.11.2 sets restart_on_exit, requests its restart
        // exit code, then runs App::run exit callbacks and Tauri cleanup
        // before the core relaunch. Its request-exit failure path performs
        // the same cleanup/core relaunch directly. Bilikara cleanup has
        // completed above in either case.
        app.request_restart();
    })
    .await
    .map_err(|error| format!("application restart worker failed: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn set_window_fullscreen(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, BackendProcess>,
    presentation: tauri::State<'_, presentation::PresentationState>,
    fullscreen: bool,
) -> Result<(), String> {
    presentation::authorize_window(&window, &backend, &[MAIN_WINDOW_LABEL])?;
    if !presentation.allows_manual_fullscreen() {
        return Err("presentation mode owns native fullscreen state".to_string());
    }
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())
}

pub(crate) fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == MAIN_WINDOW_LABEL {
        match event {
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                refresh_cached_main_window_geometry(window);
            }
            tauri::WindowEvent::CloseRequested { .. } => {
                let restart_in_progress = window
                    .try_state::<ApplicationLifecycleState>()
                    .is_some_and(|state| state.restart_in_progress());
                if restart_in_progress {
                    geometry_diagnostic("save_on_close", "restart_owned");
                } else if save_main_window_geometry(window).is_err() {
                    geometry_diagnostic("save_on_close", "error_ignored");
                } else {
                    geometry_diagnostic("save_on_close", "ok");
                }
            }
            _ => {}
        }
    }
    if window.label() == "controller"
        && let tauri::WindowEvent::Destroyed = event
    {
        append_desktop_diagnostic("presentation_window_destroyed", "window=controller");
        presentation::handle_controller_destroyed(window.app_handle());
    }
    if window.label() == "main"
        && let tauri::WindowEvent::Destroyed = event
        && window
            .try_state::<ApplicationLifecycleState>()
            .is_none_or(|lifecycle| lifecycle.claim_window_shutdown())
        && let Some(state) = window.try_state::<BackendProcess>()
    {
        append_desktop_diagnostic("presentation_window_destroyed", "window=main cleanup=begin");
        presentation::prepare_app_shutdown(window.app_handle());
        append_desktop_diagnostic("desktop_shutdown", "stage=presentation_shutdown_prepared");
        backend_process::shutdown(&state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const FRAMELESS: LogicalFrameSize = LogicalFrameSize {
        width: 0.0,
        height: 0.0,
    };

    fn monitor(
        name: &str,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        scale_factor: f64,
    ) -> MonitorWorkArea {
        MonitorWorkArea {
            name: Some(name.to_string()),
            x,
            y,
            width,
            height,
            scale_factor,
        }
    }

    fn saved_geometry(
        monitor: &MonitorWorkArea,
        offset_x: f64,
        offset_y: f64,
        width: f64,
        height: f64,
        maximized: bool,
    ) -> StoredMainWindowGeometry {
        StoredMainWindowGeometry {
            schema_version: GEOMETRY_SCHEMA_VERSION,
            normal: StoredNormalGeometry {
                offset_x,
                offset_y,
                width,
                height,
                monitor: StoredMonitorWorkArea {
                    name: monitor.name.clone(),
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                    scale_factor: monitor.scale_factor,
                },
            },
            maximized,
        }
    }

    fn resolved(
        monitors: &[MonitorWorkArea],
        preferred: usize,
        primary: usize,
        saved: Option<&StoredMainWindowGeometry>,
    ) -> ResolvedMainWindowGeometry {
        resolve_main_window_geometry(monitors, preferred, primary, FRAMELESS, saved)
            .expect("a valid monitor resolves geometry")
    }

    fn assert_centered(decision: ResolvedMainWindowGeometry, monitor: &MonitorWorkArea) {
        let work_width = f64::from(monitor.width) / monitor.scale_factor;
        let work_height = f64::from(monitor.height) / monitor.scale_factor;
        assert!((decision.offset_x - (work_width - decision.inner_width) / 2.0).abs() < 0.001);
        assert!((decision.offset_y - (work_height - decision.inner_height) / 2.0).abs() < 0.001);
    }

    fn assert_fully_inside(decision: ResolvedMainWindowGeometry, monitor: &MonitorWorkArea) {
        assert!(decision.physical_x >= monitor.x);
        assert!(decision.physical_y >= monitor.y);
        assert!(
            i64::from(decision.physical_x) + i64::from(decision.physical_inner_width)
                <= i64::from(monitor.x) + i64::from(monitor.width)
        );
        assert!(
            i64::from(decision.physical_y) + i64::from(decision.physical_inner_height)
                <= i64::from(monitor.y) + i64::from(monitor.height)
        );
    }

    #[test]
    fn first_launch_is_adaptive_centered_and_bounded_across_representative_work_areas() {
        let cases = [
            monitor("laptop", 0, 0, 1366, 728, 1.0),
            monitor("desktop", 0, 0, 1920, 1040, 1.0),
            monitor("large", 0, 0, 2560, 1400, 1.0),
            monitor("hidpi-4k", 0, 0, 3840, 2080, 2.0),
            monitor("portrait", 0, 0, 900, 1400, 1.0),
        ];

        for work_area in &cases {
            let decision = resolved(std::slice::from_ref(work_area), 0, 0, None);
            assert!(!decision.used_saved_geometry);
            assert!(!decision.maximized);
            assert_centered(decision, work_area);
            assert_fully_inside(decision, work_area);
            assert!(decision.inner_width <= FIRST_LAUNCH_MAX_WIDTH);
            assert!(decision.inner_height <= FIRST_LAUNCH_MAX_HEIGHT);
        }

        let laptop = &cases[0];
        let laptop_decision = resolved(std::slice::from_ref(laptop), 0, 0, None);
        assert!(laptop_decision.inner_width >= FIRST_LAUNCH_MIN_WIDTH);
        assert!(laptop_decision.inner_height >= FIRST_LAUNCH_MIN_HEIGHT);

        let portrait = &cases[4];
        let portrait_decision = resolved(std::slice::from_ref(portrait), 0, 0, None);
        assert!(portrait_decision.inner_width < FIRST_LAUNCH_MIN_WIDTH);
        assert_fully_inside(portrait_decision, portrait);
    }

    #[test]
    fn high_dpi_4k_uses_the_same_logical_default_as_a_1920_work_area() {
        let standard = monitor("standard", 0, 0, 1920, 1040, 1.0);
        let hidpi = monitor("hidpi", 0, 0, 3840, 2080, 2.0);
        let standard_decision = resolved(std::slice::from_ref(&standard), 0, 0, None);
        let hidpi_decision = resolved(std::slice::from_ref(&hidpi), 0, 0, None);

        assert!((standard_decision.inner_width - hidpi_decision.inner_width).abs() < 0.001);
        assert!((standard_decision.inner_height - hidpi_decision.inner_height).abs() < 0.001);
        assert_eq!(
            hidpi_decision.physical_inner_width,
            standard_decision.physical_inner_width * 2
        );
        assert_eq!(
            hidpi_decision.physical_inner_height,
            standard_decision.physical_inner_height * 2
        );
    }

    #[test]
    fn decorated_laptop_window_stays_inside_the_usable_work_area() {
        let work_area = monitor("laptop", 0, 0, 1366, 728, 1.0);
        let frame = LogicalFrameSize {
            width: DEFAULT_FRAME_WIDTH,
            height: DEFAULT_FRAME_HEIGHT,
        };
        let decision =
            resolve_main_window_geometry(std::slice::from_ref(&work_area), 0, 0, frame, None)
                .expect("resolve decorated laptop geometry");

        assert!(
            f64::from(decision.physical_x) + f64::from(decision.physical_inner_width) + frame.width
                <= f64::from(work_area.x) + f64::from(work_area.width)
        );
        assert!(
            f64::from(decision.physical_y)
                + f64::from(decision.physical_inner_height)
                + frame.height
                <= f64::from(work_area.y) + f64::from(work_area.height)
        );
    }

    #[test]
    fn valid_saved_normal_geometry_and_maximized_state_restore() {
        let work_area = monitor("desktop", 0, 0, 1920, 1040, 1.0);
        let saved = saved_geometry(&work_area, 100.0, 80.0, 1300.0, 800.0, true);
        let decision = resolved(std::slice::from_ref(&work_area), 0, 0, Some(&saved));

        assert!(decision.used_saved_geometry);
        assert!(decision.maximized);
        assert_eq!(decision.offset_x, 100.0);
        assert_eq!(decision.offset_y, 80.0);
        assert_eq!(decision.inner_width, 1300.0);
        assert_eq!(decision.inner_height, 800.0);
    }

    #[test]
    fn saved_negative_coordinate_secondary_monitor_restores_in_place() {
        let primary = monitor("primary", 0, 0, 1920, 1040, 1.0);
        let secondary = monitor("left", -2560, -120, 2560, 1400, 1.0);
        let monitors = [primary, secondary.clone()];
        let saved = saved_geometry(&secondary, 200.0, 100.0, 1400.0, 900.0, false);
        let decision = resolved(&monitors, 0, 0, Some(&saved));

        assert_eq!(decision.monitor_index, 1);
        assert_eq!(decision.physical_x, -2360);
        assert_eq!(decision.physical_y, -20);
        assert_fully_inside(decision, &secondary);
    }

    #[test]
    fn disconnected_saved_monitor_recenters_saved_size_on_primary() {
        let primary = monitor("primary", 0, 0, 1920, 1040, 1.0);
        let disconnected = monitor("removed", 1920, 0, 2560, 1400, 1.0);
        let saved = saved_geometry(&disconnected, 300.0, 200.0, 1300.0, 800.0, false);
        let decision = resolved(std::slice::from_ref(&primary), 0, 0, Some(&saved));

        assert!(decision.used_saved_geometry);
        assert_eq!(decision.monitor_index, 0);
        assert_eq!(decision.inner_width, 1300.0);
        assert_eq!(decision.inner_height, 800.0);
        assert_centered(decision, &primary);
        assert_fully_inside(decision, &primary);
    }

    #[test]
    fn partly_offscreen_saved_geometry_is_clamped_and_stranded_geometry_is_recentered() {
        let work_area = monitor("desktop", 0, 0, 1920, 1040, 1.0);
        let partly_offscreen = saved_geometry(&work_area, 1100.0, 500.0, 1000.0, 600.0, false);
        let clamped = resolved(
            std::slice::from_ref(&work_area),
            0,
            0,
            Some(&partly_offscreen),
        );
        assert_eq!(clamped.offset_x, 908.0);
        assert_eq!(clamped.offset_y, 428.0);
        assert_fully_inside(clamped, &work_area);

        let stranded = saved_geometry(&work_area, 5000.0, -5000.0, 1000.0, 600.0, false);
        let recentered = resolved(std::slice::from_ref(&work_area), 0, 0, Some(&stranded));
        assert_centered(recentered, &work_area);
        assert_fully_inside(recentered, &work_area);
    }

    #[test]
    fn monitor_dpi_resolution_and_work_area_changes_preserve_logical_geometry() {
        let old_monitor = monitor("display", -3840, 0, 3840, 2080, 2.0);
        let current_monitor = monitor("display", -2560, -80, 2560, 1400, 1.25);
        let saved = saved_geometry(&old_monitor, 120.0, 90.0, 1400.0, 800.0, false);
        let decision = resolved(std::slice::from_ref(&current_monitor), 0, 0, Some(&saved));

        assert_eq!(decision.monitor_index, 0);
        assert_eq!(decision.inner_width, 1400.0);
        assert_eq!(decision.inner_height, 800.0);
        assert_eq!(decision.physical_x, -2410);
        assert_eq!(decision.physical_y, 33);
        assert_fully_inside(decision, &current_monitor);
    }

    #[test]
    fn invalid_zero_nan_schema_and_oversized_saved_geometry_use_adaptive_default() {
        let work_area = monitor("desktop", 0, 0, 2560, 1400, 1.0);
        let base = saved_geometry(&work_area, 100.0, 100.0, 1200.0, 800.0, false);
        let mut invalid_cases = Vec::new();

        let mut zero = base.clone();
        zero.normal.width = 0.0;
        invalid_cases.push(zero);
        let mut nan = base.clone();
        nan.normal.offset_x = f64::NAN;
        invalid_cases.push(nan);
        let mut tiny = base.clone();
        tiny.normal.height = SAVED_MIN_HEIGHT - 1.0;
        invalid_cases.push(tiny);
        let mut infinite = base.clone();
        infinite.normal.height = f64::INFINITY;
        invalid_cases.push(infinite);
        let mut oversized = base.clone();
        oversized.normal.width = SAVED_MAX_WIDTH + 1.0;
        invalid_cases.push(oversized);
        let mut wrong_schema = base;
        wrong_schema.schema_version += 1;
        invalid_cases.push(wrong_schema);

        for invalid in invalid_cases {
            let decision = resolved(std::slice::from_ref(&work_area), 0, 0, Some(&invalid));
            assert!(!decision.used_saved_geometry);
            assert!(!decision.maximized);
            assert_centered(decision, &work_area);
        }
    }

    #[test]
    fn persisted_schema_contains_only_normal_geometry_and_maximized_state() {
        let work_area = monitor("desktop", 0, 0, 1920, 1040, 1.0);
        let geometry = saved_geometry(&work_area, 100.0, 80.0, 1300.0, 800.0, true);
        let value = serde_json::to_value(geometry).expect("serialize geometry");
        let object = value.as_object().expect("geometry object");

        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            ["maximized", "normal", "schema_version"]
        );
        let encoded = value.to_string();
        for forbidden in [
            "visible",
            "hidden",
            "minimized",
            "fullscreen",
            "decorations",
            "always_on_top",
        ] {
            assert!(!encoded.contains(forbidden), "must not persist {forbidden}");
        }
    }

    fn temporary_test_directory(test_name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "bilikara-window-geometry-{test_name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn corrupt_state_is_recoverable_and_live_cache_updates_do_not_write() {
        let directory = temporary_test_directory("persistence");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join(GEOMETRY_FILENAME);
        fs::write(&path, b"{corrupt geometry").expect("write corrupt state");
        assert!(load_geometry(&path).is_err());

        fs::remove_file(&path).expect("remove corrupt fixture");
        let work_area = monitor("desktop", 0, 0, 1920, 1040, 1.0);
        let state = MainWindowGeometryState::new(
            Some(path.clone()),
            Some(saved_geometry(
                &work_area, 100.0, 80.0, 1300.0, 800.0, false,
            )),
        );
        for offset in 0..1000 {
            state.replace_cached(saved_geometry(
                &work_area,
                f64::from(offset),
                80.0,
                1300.0,
                800.0,
                false,
            ));
        }
        assert!(
            !path.exists(),
            "move/resize cache updates must not touch disk"
        );

        state.persist().expect("bounded lifecycle save");
        let loaded = load_geometry(&path)
            .expect("read state")
            .expect("state exists");
        assert_eq!(loaded.normal.offset_x, 999.0);
        let entries = fs::read_dir(&directory)
            .expect("read test directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect directory");
        assert_eq!(entries.len(), 1, "atomic temporary file must be replaced");
        fs::remove_dir_all(&directory).expect("remove test directory");
    }

    #[test]
    fn accepted_application_restart_owns_shutdown_idempotently() {
        let lifecycle = ApplicationLifecycleState::default();

        assert_eq!(lifecycle.claim_restart(), RestartClaim::Accepted);
        assert_eq!(lifecycle.claim_restart(), RestartClaim::AlreadyAccepted);
        assert!(lifecycle.restart_in_progress());
        assert!(!lifecycle.claim_window_shutdown());
    }

    #[test]
    fn failed_main_thread_preparation_releases_restart_claim() {
        let lifecycle = ApplicationLifecycleState::default();

        assert_eq!(lifecycle.claim_restart(), RestartClaim::Accepted);
        lifecycle.release_restart_after_preparation_failure();
        assert_eq!(lifecycle.claim_restart(), RestartClaim::Accepted);
    }

    #[test]
    fn normal_window_shutdown_rejects_a_late_restart() {
        let lifecycle = ApplicationLifecycleState::default();

        assert!(lifecycle.claim_window_shutdown());
        assert!(!lifecycle.claim_window_shutdown());
        assert_eq!(lifecycle.claim_restart(), RestartClaim::ShutdownInProgress);
    }
}
