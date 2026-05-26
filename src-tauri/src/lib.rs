// objc 0.2's sel_impl macro uses #[cfg(cargo-clippy)] internally which
// triggers unexpected_cfgs in Rust 1.80+. Allow it crate-wide.
#![allow(unexpected_cfgs)]

use std::sync::Mutex;
use base64::{Engine as _, engine::general_purpose};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

// ── State ─────────────────────────────────────────────────────────────────────

pub struct AppState {
    pub screen_snapshot: Mutex<Option<ScreenSnapshot>>,
    pub capture_data: Mutex<Option<String>>,
    pub hotkey_config: Mutex<HotkeyConfig>,
    pub preselect_all: Mutex<bool>,
    pub window_list: Mutex<Vec<WindowInfo>>,
    pub settings: Mutex<AppSettings>,
    pub screenshot_history: Mutex<Vec<ScreenshotRecord>>,
}

/// A visible on-screen window, with bounds in logical (CSS) pixels,
/// top-left origin matching the overlay coordinate system.
#[derive(serde::Serialize, Clone)]
pub struct WindowInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub title: String,
    pub app_name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ScreenSnapshot {
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct HotkeyConfig {
    pub region: String,
    pub fullscreen: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        HotkeyConfig {
            region: "CommandOrControl+Shift+A".into(),
            fullscreen: "CommandOrControl+Shift+F".into(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AppSettings {
    pub save_path: String,    // "" = prompt every time
    pub format: String,       // "png" | "jpg"
    pub auto_save: bool,
    pub keep_history: bool,
    pub history_limit: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            save_path: String::new(),
            format: "png".into(),
            auto_save: false,
            keep_history: true,
            history_limit: 30,
        }
    }
}

/// One entry in screenshot history. `thumb` is a 160-px-wide JPEG thumbnail (base64).
/// Full-resolution screenshots are cached separately in `app_data_dir/history/<id>.png`.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ScreenshotRecord {
    pub id: String,
    pub created_at: u64,   // Unix timestamp (seconds)
    pub width: u32,
    pub height: u32,
    pub thumb: String,     // base64 JPEG thumbnail (~160 px wide)
    pub file_path: String, // path if auto-saved, otherwise ""
}

// ── macOS: raise overlay window above Dock ────────────────────────────────────

/// On macOS, always_on_top(true) only reaches NSFloatingWindowLevel (3), which is
/// below the Dock (NSWindowLevel 20) and menu bar (24). The Dock therefore renders
/// on top of our overlay and intercepts mouse events in that area.
/// Fix: after window creation, use the ObjC runtime to raise the level to
/// NSScreenSaverWindowLevel (1000), making the overlay appear above everything.
#[cfg(target_os = "macos")]
fn raise_overlay_window_level(window: &tauri::WebviewWindow) {
    use objc::{msg_send, sel, sel_impl, runtime::Object};
    let ptr = match window.ns_window() {
        Ok(p) => p,
        Err(_) => return,
    };
    // Convert to usize so it can be sent across threads (raw ptr is not Send)
    let ptr_usize = ptr as usize;
    if ptr_usize == 0 { return; }
    // setLevel: MUST run on the main thread — calling it from a Tokio worker
    // thread crashes with EXC_BAD_INSTRUCTION inside WindowServer.
    let _ = window.run_on_main_thread(move || {
        let ns_win = ptr_usize as *mut Object;
        unsafe {
            // NSScreenSaverWindowLevel = 1000 — above Dock (20) and menu bar (24)
            let _: () = msg_send![ns_win, setLevel: 1000_i64];
            // NSWindowCollectionBehaviorCanJoinAllSpaces(1) | Transient(4) | IgnoresCycle(64)
            let _: () = msg_send![ns_win, setCollectionBehavior: 69_u64];
        }
    });
}

// ── macOS screen-capture permission ──────────────────────────────────────────

#[cfg(target_os = "macos")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

fn has_screen_capture_permission() -> bool {
    #[cfg(target_os = "macos")]
    { unsafe { CGPreflightScreenCaptureAccess() } }
    #[cfg(not(target_os = "macos"))]
    { true }
}

#[tauri::command]
fn check_screen_capture_permission() -> bool {
    has_screen_capture_permission()
}

#[tauri::command]
async fn request_screen_capture_permission(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let granted = unsafe { CGRequestScreenCaptureAccess() };
        if !granted {
            // Open System Settings > Privacy & Security > Screen Recording
            let _ = app.opener().open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                None::<&str>,
            );
        }
        granted
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; true }
}

// ── Screenshot helpers ────────────────────────────────────────────────────────

fn capture_primary_monitor() -> Result<ScreenSnapshot, String> {
    #[cfg(target_os = "macos")]
    {
        capture_macos_screencapture()
    }
    #[cfg(not(target_os = "macos"))]
    {
        capture_xcap()
    }
}

#[cfg(target_os = "macos")]
fn capture_macos_screencapture() -> Result<ScreenSnapshot, String> {
    use std::process::Command;

    // Use a temp file path unique to this process to avoid races
    let tmp = format!("/tmp/jietu_snap_{}.png", std::process::id());

    // -x: no sounds, -D 1: main display (display 1)
    let status = Command::new("screencapture")
        .args(["-x", "-D", "1", &tmp])
        .status()
        .map_err(|e| format!("screencapture failed: {}", e))?;
    if !status.success() {
        return Err(format!("screencapture exited with {}", status));
    }

    let png_bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);

    let dynamic = image::load_from_memory(&png_bytes).map_err(|e| e.to_string())?;
    let pw = dynamic.width();
    let ph = dynamic.height();

    let scale = {
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        monitors.iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .map(|m| m.scale_factor().unwrap_or(1.0) as f64)
            .unwrap_or(2.0)
    };

    let mut buf = Vec::new();
    dynamic.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    Ok(ScreenSnapshot {
        data: general_purpose::STANDARD.encode(&buf),
        width: pw,
        height: ph,
        x: 0,
        y: 0,
        scale,
    })
}

#[allow(dead_code)]
fn capture_xcap() -> Result<ScreenSnapshot, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| xcap::Monitor::all().ok()?.into_iter().next())
        .ok_or("No monitor found")?;

    let scale = monitor.scale_factor().map_err(|e| e.to_string())? as f64;
    let mx = monitor.x().map_err(|e| e.to_string())?;
    let my = monitor.y().map_err(|e| e.to_string())?;

    let rgba = monitor.capture_image().map_err(|e| e.to_string())?;
    let (w, h) = (rgba.width(), rgba.height());

    let dynamic = image::DynamicImage::ImageRgba8(rgba);
    let mut buf = Vec::new();
    dynamic
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    Ok(ScreenSnapshot {
        data: general_purpose::STANDARD.encode(&buf),
        width: w,
        height: h,
        x: mx,
        y: my,
        scale,
    })
}

/// x, y, w, h are canvas-relative LOGICAL pixel coords from the overlay window.
/// The overlay window covers the monitor exactly, so (0,0) == monitor physical (0,0).
/// Convert to physical by multiplying by scale_factor.
fn crop_snapshot(snapshot: &ScreenSnapshot, x: i32, y: i32, w: u32, h: u32) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(&snapshot.data)
        .map_err(|e| e.to_string())?;
    let dynamic = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;

    let px = ((x as f64) * snapshot.scale).max(0.0) as u32;
    let py = ((y as f64) * snapshot.scale).max(0.0) as u32;
    let pw = ((w as f64) * snapshot.scale).max(1.0) as u32;
    let ph = ((h as f64) * snapshot.scale).max(1.0) as u32;

    let px = px.min(dynamic.width().saturating_sub(1));
    let py = py.min(dynamic.height().saturating_sub(1));
    let pw = pw.min(dynamic.width().saturating_sub(px)).max(1);
    let ph = ph.min(dynamic.height().saturating_sub(py)).max(1);

    let cropped = dynamic.crop_imm(px, py, pw, ph);
    let mut buf = Vec::new();
    cropped
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;

    Ok(general_purpose::STANDARD.encode(&buf))
}

// ── Window helpers ────────────────────────────────────────────────────────────

fn close_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.close();
    }
}

/// Build a WebviewUrl that works in both dev and release builds.
/// In release builds, Tauri's custom protocol serves from frontendDist.
/// In debug builds built with plain `cargo build` (not `cargo tauri dev`),
/// the custom protocol may not serve content; use the Vite dev server instead.
fn app_url() -> WebviewUrl {
    #[cfg(debug_assertions)]
    { WebviewUrl::External("http://localhost:1420/".parse().unwrap()) }
    #[cfg(not(debug_assertions))]
    { WebviewUrl::App("/".into()) }
}

fn open_overlay_window(app: &AppHandle, snapshot: &ScreenSnapshot) -> Result<(), String> {
    // Destroy any existing overlay before creating a new one.
    // close() is async; hide first so it's invisible, then close.
    if let Some(existing) = app.get_webview_window("overlay") {
        let _ = existing.hide();
        let _ = existing.destroy();
    }

    // Use logical pixels for Tauri window sizing (physical / scale = logical)
    let lw = snapshot.width as f64 / snapshot.scale;
    let lh = snapshot.height as f64 / snapshot.scale;
    let lx = snapshot.x as f64;
    let ly = snapshot.y as f64;

    let w = WebviewWindowBuilder::new(app, "overlay", app_url())
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(lw, lh)
        .position(lx, ly)
        .build()
        .map_err(|e| e.to_string())?;

    // macOS: put the overlay above the Dock so the Dock area can be selected
    #[cfg(target_os = "macos")]
    raise_overlay_window_level(&w);

    w.show().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn open_editor_window(app: &AppHandle) -> Result<(), String> {
    close_window(app, "editor");
    WebviewWindowBuilder::new(app, "editor", app_url())
        .inner_size(1000.0, 680.0)
        .min_inner_size(600.0, 400.0)
        .center()
        .title("截图编辑")
        .decorations(true)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Window list ───────────────────────────────────────────────────────────────

/// Collect metadata for all visible on-screen windows.
/// On macOS, xcap returns bounds via CGWindowListCopyWindowInfo in logical pixels
/// (screen points) with a top-left origin — the same system as CSS pixels in the
/// overlay — so no coordinate conversion is needed.
fn collect_window_list() -> Vec<WindowInfo> {
    xcap::Window::all()
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.is_minimized().unwrap_or(true))
        .filter_map(|w| {
            let width  = w.width().ok()?;
            let height = w.height().ok()?;
            if width == 0 || height == 0 { return None; }
            Some(WindowInfo {
                x:        w.x().ok()?,
                y:        w.y().ok()?,
                width,
                height,
                title:    w.title().unwrap_or_default(),
                app_name: w.app_name().unwrap_or_default(),
            })
        })
        .collect()
}

#[tauri::command]
fn get_window_list(state: State<'_, AppState>) -> Vec<WindowInfo> {
    state.window_list.lock().unwrap().clone()
}

// ── Commands: settings ────────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    *state.settings.lock().unwrap() = settings.clone();
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_string(&settings) {
            let _ = std::fs::write(dir.join("settings.json"), json);
        }
    }
    Ok(())
}

// ── Commands: screenshot history ──────────────────────────────────────────────

/// Save a screenshot to history. `data` is base64 PNG.
/// Creates a 160-px thumbnail for display and caches the full image for later copy.
#[tauri::command]
async fn save_to_history(
    app: AppHandle,
    state: State<'_, AppState>,
    data: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();
    if !settings.keep_history { return Ok(()); }

    let bytes = general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;

    // Build thumbnail (160 px wide, JPEG)
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let thumb_w = 160u32;
    let thumb_h = (height as f64 * thumb_w as f64 / width.max(1) as f64).round() as u32;
    let thumb = img.resize(thumb_w, thumb_h.max(1), image::imageops::FilterType::Triangle);
    let mut thumb_buf = Vec::new();
    thumb.write_to(&mut std::io::Cursor::new(&mut thumb_buf), image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    let thumb_b64 = general_purpose::STANDARD.encode(&thumb_buf);

    // Create record
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let id = format!("shot_{now}_{:04}", (now % 10000));

    // Cache full screenshot to disk
    let mut file_path = String::new();
    if let Ok(dir) = app.path().app_data_dir() {
        let cache_dir = dir.join("history");
        let _ = std::fs::create_dir_all(&cache_dir);
        let cache_file = cache_dir.join(format!("{id}.png"));
        if std::fs::write(&cache_file, &bytes).is_ok() {
            file_path = cache_file.to_string_lossy().into_owned();
        }
    }

    // Auto-save to user's save path if configured
    if settings.auto_save && !settings.save_path.is_empty() {
        let ts = chrono_now_string();
        let ext = &settings.format;
        let dest = std::path::Path::new(&settings.save_path)
            .join(format!("截图_{ts}.{ext}"));
        if ext == "jpg" {
            // Re-encode as JPEG
            let mut jpg_buf = Vec::new();
            let _ = img.write_to(&mut std::io::Cursor::new(&mut jpg_buf), image::ImageFormat::Jpeg);
            let _ = std::fs::write(&dest, jpg_buf);
        } else {
            let _ = std::fs::write(&dest, &bytes);
        }
        if file_path.is_empty() {
            file_path = dest.to_string_lossy().into_owned();
        }
    }

    let record = ScreenshotRecord { id, created_at: now, width, height, thumb: thumb_b64, file_path };

    let mut history = state.screenshot_history.lock().unwrap();
    history.insert(0, record.clone());
    let limit = settings.history_limit as usize;
    if history.len() > limit { history.truncate(limit); }
    let snapshot = history.clone();
    drop(history);

    // Persist index
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(json) = serde_json::to_string(&snapshot) {
            let _ = std::fs::write(dir.join("history.json"), json);
        }
    }

    // Notify all windows so they can refresh their history list immediately
    let _ = app.emit("screenshot-saved", &record);
    Ok(())
}

#[tauri::command]
async fn delete_history_item(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut history = state.screenshot_history.lock().unwrap();
    history.retain(|r| r.id != id);
    let snapshot = history.clone();
    drop(history);

    // Remove cached full-res file
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(dir.join("history").join(format!("{id}.png")));
        if let Ok(json) = serde_json::to_string(&snapshot) {
            let _ = std::fs::write(dir.join("history.json"), json);
        }
    }
    let _ = app.emit("history-changed", ());
    Ok(())
}

fn chrono_now_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let s = secs % 86400;
    let h = s / 3600; let m = (s % 3600) / 60; let sec = s % 60;
    // Use day-of-epoch as date approximation (good enough for file names)
    let days = secs / 86400;
    format!("{days:05}{h:02}{m:02}{sec:02}")
}



#[tauri::command]
fn get_screenshot_history(state: State<'_, AppState>) -> Vec<ScreenshotRecord> {
    state.screenshot_history.lock().unwrap().clone()
}

#[tauri::command]
async fn copy_history_item(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let file_path = {
        let history = state.screenshot_history.lock().unwrap();
        history.iter().find(|r| r.id == id)
            .map(|r| r.file_path.clone())
            .ok_or("未找到截图")?
    };

    // Try to read from the cached file first; fall back to searching history cache dir
    let path = if !file_path.is_empty() && std::path::Path::new(&file_path).exists() {
        std::path::PathBuf::from(&file_path)
    } else if let Ok(dir) = app.path().app_data_dir() {
        dir.join("history").join(format!("{id}.png"))
    } else {
        return Err("找不到文件".into());
    };

    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());

    app.clipboard().write_image(
        &tauri::image::Image::new(rgba.as_raw(), w, h)
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn clear_screenshot_history(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut history = state.screenshot_history.lock().unwrap();
        history.clear();
    }
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::write(dir.join("history.json"), "[]");
        // Remove cached full-res images
        if let Ok(entries) = std::fs::read_dir(dir.join("history")) {
            for e in entries.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

// ── Commands: capture ─────────────────────────────────────────────────────────

#[tauri::command]
async fn start_region_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !has_screen_capture_permission() {
        return Err("no_permission".into());
    }
    // Hide main window so it doesn't appear in the screenshot
    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Capture window metadata and screenshot while screen is undisturbed
    let windows  = collect_window_list();
    let snapshot = match capture_primary_monitor() {
        Ok(s) => s,
        Err(e) => {
            // Restore main window so the app doesn't appear to have crashed
            if let Some(w) = app.get_webview_window("main") { let _ = w.show(); }
            return Err(e);
        }
    };

    *state.window_list.lock().unwrap()    = windows;
    *state.screen_snapshot.lock().unwrap() = Some(snapshot.clone());
    if let Err(e) = open_overlay_window(&app, &snapshot) {
        if let Some(w) = app.get_webview_window("main") { let _ = w.show(); }
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
async fn start_fullscreen_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !has_screen_capture_permission() {
        return Err("no_permission".into());
    }
    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let windows  = collect_window_list();
    let snapshot = match capture_primary_monitor() {
        Ok(s) => s,
        Err(e) => {
            if let Some(w) = app.get_webview_window("main") { let _ = w.show(); }
            return Err(e);
        }
    };

    *state.window_list.lock().unwrap()    = windows;
    *state.preselect_all.lock().unwrap()  = true;
    *state.screen_snapshot.lock().unwrap() = Some(snapshot.clone());
    if let Err(e) = open_overlay_window(&app, &snapshot) {
        if let Some(w) = app.get_webview_window("main") { let _ = w.show(); }
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
fn take_preselect_all(state: State<'_, AppState>) -> bool {
    let mut lock = state.preselect_all.lock().unwrap();
    let val = *lock;
    *lock = false;
    val
}

#[tauri::command]
async fn do_region_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Hide immediately so the overlay disappears the instant the user releases,
    // preventing them from seeing a stale selection or accidentally starting
    // another drag while the async close completes.
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
        let _ = w.close();
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let cropped = {
        let lock = state.screen_snapshot.lock().unwrap();
        let snapshot = lock.as_ref().ok_or("No screen snapshot")?;
        crop_snapshot(snapshot, x, y, width, height)?
    };

    *state.capture_data.lock().unwrap() = Some(cropped);
    open_editor_window(&app)?;
    Ok(())
}

#[tauri::command]
fn get_screen_snapshot(state: State<'_, AppState>) -> Result<Option<ScreenSnapshot>, String> {
    Ok(state.screen_snapshot.lock().unwrap().clone())
}

#[tauri::command]
fn get_capture_data(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(state.capture_data.lock().unwrap().clone())
}

#[tauri::command]
async fn close_overlay(app: AppHandle) -> Result<(), String> {
    close_window(&app, "overlay");
    // Always restore main window so the app doesn't appear to vanish
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn save_image(path: String, data: String) -> Result<(), String> {
    let bytes = general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
    let lower = path.to_lowercase();
    let out_bytes = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
            .map_err(|e| e.to_string())?;
        buf
    } else {
        bytes
    };
    std::fs::write(&path, out_bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Crop the stored screen snapshot at full physical resolution (scale factor applied).
/// Returns base64 PNG. Coordinates are in logical (CSS) pixels — same as the overlay canvas.
#[tauri::command]
fn crop_region(state: State<'_, AppState>, x: i32, y: i32, w: u32, h: u32) -> Result<String, String> {
    let lock = state.screen_snapshot.lock().unwrap();
    let snap = lock.as_ref().ok_or("No snapshot available")?;
    crop_snapshot(snap, x, y, w, h)
}

// ── Commands: pin window ──────────────────────────────────────────────────────

/// Copy a base64-encoded PNG directly to the clipboard.
/// Used by the pin window's context menu where each pin owns its own image data.
#[tauri::command]
async fn copy_image_data(app: AppHandle, data: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let bytes = general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    app.clipboard().write_image(
        &tauri::image::Image::new(rgba.as_raw(), w, h)
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Pin an image from the system clipboard as a floating pin window.
#[tauri::command]
async fn pin_from_clipboard(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let image = app.clipboard().read_image().map_err(|_| "剪贴板中没有图片".to_string())?;
    let (w, h) = (image.width(), image.height());
    let rgba = image.rgba().to_vec();
    // Encode RGBA pixels as PNG
    let mut png_buf = Vec::new();
    {
        use image::{ImageEncoder, codecs::png::PngEncoder};
        PngEncoder::new(&mut png_buf)
            .write_image(&rgba, w, h, image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?;
    }
    let b64 = general_purpose::STANDARD.encode(&png_buf);
    *state.capture_data.lock().unwrap() = Some(b64);
    open_pin_window(app, state).await
}

/// Called from the overlay toolbar — stores the annotated image and opens a pin window.
#[tauri::command]
async fn pin_from_overlay(
    app: AppHandle,
    state: State<'_, AppState>,
    data: String,
) -> Result<(), String> {
    *state.capture_data.lock().unwrap() = Some(data);
    // Close the overlay first, then open pin window
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
        let _ = w.close();
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    open_pin_window(app, state).await
}

#[tauri::command]
async fn open_pin_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Determine image dimensions for initial window size
    let (img_w, img_h) = {
        let lock = state.capture_data.lock().unwrap();
        let data = lock.as_ref().ok_or("No capture data")?;
        let bytes = general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
        let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        (img.width(), img.height())
    };

    // Scale down if too large
    let max_dim = 600.0_f64;
    let scale = (max_dim / img_w as f64).min(max_dim / img_h as f64).min(1.0);
    let win_w = (img_w as f64 * scale).round();
    let win_h = (img_h as f64 * scale).round();

    // Create a uniquely-labelled pin window (allows multiple pins)
    let label = format!("pin_{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());

    let win = WebviewWindowBuilder::new(&app, label, app_url())
        .inner_size(win_w, win_h)
        .min_inner_size(80.0, 60.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(false)
        .accept_first_mouse(true)
        .build()
        .map_err(|e| e.to_string())?;

    // macOS: allow mouseMoved events on this window even when it's not the key window.
    // Without this, hovering over a non-focused pin window produces no mousemove events,
    // so React's onMouseEnter never fires and the close button never appears.
    #[cfg(target_os = "macos")]
    setup_pin_window_macos(&win);

    Ok(())
}

#[cfg(target_os = "macos")]
fn setup_pin_window_macos(window: &tauri::WebviewWindow) {
    use objc::{msg_send, sel, sel_impl, runtime::Object};
    let ptr = match window.ns_window() {
        Ok(p) => p,
        Err(_) => return,
    };
    let ptr_usize = ptr as usize;
    if ptr_usize == 0 { return; }
    let _ = window.run_on_main_thread(move || {
        let ns_win = ptr_usize as *mut Object;
        unsafe {
            // Allow mouseMoved events even when this window is not the key window,
            // so React's onMouseEnter fires and the close button appears on hover.
            let _: () = msg_send![ns_win, setAcceptsMouseMovedEvents: true];
            // Native background drag — works even when the app is not frontmost.
            let _: () = msg_send![ns_win, setMovableByWindowBackground: true];
        }
    });
}

/// Enable or disable native background drag on a pin window.
/// Called from JS to disable drag while the opacity slider (in the context menu) is open,
/// preventing the slider thumb drag from also moving the window.
#[tauri::command]
async fn set_pin_movable(app: AppHandle, label: String, movable: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl, runtime::Object};
        if let Some(window) = app.get_webview_window(&label) {
            let ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
            if ptr == 0 { return Ok(()); }
            window.run_on_main_thread(move || {
                let ns_win = ptr as *mut Object;
                unsafe { let _: () = msg_send![ns_win, setMovableByWindowBackground: movable]; }
            }).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, label, movable); }
    Ok(())
}

// ── Commands: settings / hotkeys ──────────────────────────────────────────────

#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "settings", app_url())
        .inner_size(520.0, 480.0)
        .resizable(false)
        .center()
        .title("设置")
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_hotkey_config(state: State<'_, AppState>) -> Result<HotkeyConfig, String> {
    Ok(state.hotkey_config.lock().unwrap().clone())
}

/// Check whether `shortcut` conflicts with any currently registered shortcut.
/// Returns Some(description) if conflict, None if free.
#[tauri::command]
async fn check_shortcut_conflict(
    app: AppHandle,
    shortcut: String,
    ignore_key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let config = state.hotkey_config.lock().unwrap().clone();

    // Check against our own configured shortcuts (excluding the one being edited)
    let own_shortcuts = [
        ("region", config.region.as_str()),
        ("fullscreen", config.fullscreen.as_str()),
    ];
    for (key, val) in own_shortcuts {
        if key != ignore_key.as_str() && val == shortcut {
            let label = if key == "region" { "区域截图" } else { "全屏截图" };
            return Ok(Some(format!("与\"{}\"快捷键冲突", label)));
        }
    }

    // Check with the OS via the plugin
    let parsed = shortcut
        .parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| e.to_string())?;

    if app.global_shortcut().is_registered(parsed) {
        return Ok(Some("该快捷键已被系统或其他应用占用".into()));
    }

    Ok(None)
}

#[tauri::command]
async fn save_hotkey_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: HotkeyConfig,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt};

    let old_config = state.hotkey_config.lock().unwrap().clone();

    // Unregister old shortcuts
    let old_region = old_config.region.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| e.to_string())?;
    let old_full = old_config.fullscreen.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| e.to_string())?;
    let _ = app.global_shortcut().unregister(old_region);
    let _ = app.global_shortcut().unregister(old_full);

    // Register new shortcuts
    register_shortcuts(&app, &config)?;

    *state.hotkey_config.lock().unwrap() = config.clone();

    // Persist to disk
    if let Some(data_dir) = app.path().app_data_dir().ok() {
        let _ = std::fs::create_dir_all(&data_dir);
        let path = data_dir.join("hotkeys.json");
        let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
        let _ = std::fs::write(path, json);
    }

    Ok(())
}

fn register_shortcuts(app: &AppHandle, config: &HotkeyConfig) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutEvent, ShortcutState};

    let region_sc = config.region.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| e.to_string())?;
    let full_sc = config.fullscreen.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| e.to_string())?;

    let app_r = app.clone();
    app.global_shortcut()
        .on_shortcut(region_sc, move |_app, _sc, ev: ShortcutEvent| {
            if ev.state() != ShortcutState::Pressed { return; }
            let a = app_r.clone();
            tauri::async_runtime::spawn(async move {
                let state = a.state::<AppState>();
                if let Err(e) = start_region_capture(a.clone(), state).await {
                    eprintln!("region hotkey: {e}");
                }
            });
        })
        .map_err(|e| e.to_string())?;

    let app_f = app.clone();
    app.global_shortcut()
        .on_shortcut(full_sc, move |_app, _sc, ev: ShortcutEvent| {
            if ev.state() != ShortcutState::Pressed { return; }
            let a = app_f.clone();
            tauri::async_runtime::spawn(async move {
                let state = a.state::<AppState>();
                if let Err(e) = start_fullscreen_capture(a.clone(), state).await {
                    eprintln!("fullscreen hotkey: {e}");
                }
            });
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ── App Entry ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            screen_snapshot: Mutex::new(None),
            capture_data: Mutex::new(None),
            hotkey_config: Mutex::new(HotkeyConfig::default()),
            preselect_all: Mutex::new(false),
            window_list: Mutex::new(vec![]),
            settings: Mutex::new(AppSettings::default()),
            screenshot_history: Mutex::new(vec![]),
        })
        .on_window_event(|window, event| {
            match window.label() {
                "main" => {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                "overlay" => {
                    // When the overlay is destroyed (ESC, copy, save, or crash),
                    // always bring the main window back so the app isn't invisible.
                    if let tauri::WindowEvent::Destroyed = event {
                        if let Some(main) = window.app_handle().get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            check_screen_capture_permission,
            request_screen_capture_permission,
            start_region_capture,
            start_fullscreen_capture,
            do_region_capture,
            get_screen_snapshot,
            get_capture_data,
            close_overlay,
            save_image,
            pin_from_overlay,
            pin_from_clipboard,
            open_pin_window,
            set_pin_movable,
            open_settings,
            get_hotkey_config,
            check_shortcut_conflict,
            save_hotkey_config,
            take_preselect_all,
            get_window_list,
            get_settings,
            save_settings,
            save_to_history,
            get_screenshot_history,
            copy_history_item,
            copy_image_data,
            delete_history_item,
            clear_screenshot_history,
            crop_region,
        ])
        .setup(setup_app)
        .run(tauri::generate_context!())
        .expect("error while running jietu");
}

fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Load persisted hotkey config
    let config = if let Ok(data_dir) = app.path().app_data_dir() {
        let path = data_dir.join("hotkeys.json");
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<HotkeyConfig>(&s).ok())
            .unwrap_or_default()
    } else {
        HotkeyConfig::default()
    };
    *app.state::<AppState>().hotkey_config.lock().unwrap() = config.clone();

    // Load persisted app settings
    if let Ok(data_dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&data_dir);
        if let Some(settings) = std::fs::read_to_string(data_dir.join("settings.json"))
            .ok().and_then(|s| serde_json::from_str::<AppSettings>(&s).ok()) {
            *app.state::<AppState>().settings.lock().unwrap() = settings;
        }
        // Load history index
        if let Some(history) = std::fs::read_to_string(data_dir.join("history.json"))
            .ok().and_then(|s| serde_json::from_str::<Vec<ScreenshotRecord>>(&s).ok()) {
            *app.state::<AppState>().screenshot_history.lock().unwrap() = history;
        }
    }

    // Register global hotkeys
    if let Err(e) = register_shortcuts(app.handle(), &config) {
        eprintln!("[jietu] hotkey register failed: {e}");
    }

    // ── System Tray ───────────────────────────────────────────────────────────
    let region_item  = MenuItem::with_id(app, "region",      "区域截图",     true, None::<&str>)?;
    let full_item    = MenuItem::with_id(app, "fullscreen",  "全屏截图",     true, None::<&str>)?;
    let clip_pin_item = MenuItem::with_id(app, "clip_pin",  "剪贴板钉图",   true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings",  "设置",         true, None::<&str>)?;
    let quit_item    = MenuItem::with_id(app, "quit",        "退出",         true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&region_item, &full_item, &clip_pin_item, &settings_item, &quit_item])?;

    let ah = app.handle().clone();
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("截图工具")
        .on_menu_event(move |_tray, event| {
            let app = ah.clone();
            match event.id.as_ref() {
                "region" => {
                    tauri::async_runtime::spawn(async move {
                        let s = app.state::<AppState>();
                        let _ = start_region_capture(app.clone(), s).await;
                    });
                }
                "fullscreen" => {
                    tauri::async_runtime::spawn(async move {
                        let s = app.state::<AppState>();
                        let _ = start_fullscreen_capture(app.clone(), s).await;
                    });
                }
                "clip_pin" => {
                    tauri::async_runtime::spawn(async move {
                        let s = app.state::<AppState>();
                        let _ = pin_from_clipboard(app.clone(), s).await;
                    });
                }
                "settings" => {
                    tauri::async_runtime::spawn(async move {
                        let _ = open_settings(app).await;
                    });
                }
                "quit" => std::process::exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
