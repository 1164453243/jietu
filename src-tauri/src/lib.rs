use std::sync::Mutex;
use base64::{Engine as _, engine::general_purpose};
use image::GenericImageView;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

// ── State ─────────────────────────────────────────────────────────────────────

pub struct AppState {
    pub screen_snapshot: Mutex<Option<ScreenSnapshot>>,
    pub capture_data: Mutex<Option<String>>,
    pub hotkey_config: Mutex<HotkeyConfig>,
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

// ── Screenshot helpers ────────────────────────────────────────────────────────

fn capture_primary_monitor() -> Result<ScreenSnapshot, String> {
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

fn crop_snapshot(snapshot: &ScreenSnapshot, x: i32, y: i32, w: u32, h: u32) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(&snapshot.data)
        .map_err(|e| e.to_string())?;
    let dynamic = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;

    let px = ((x - snapshot.x) as f64 * snapshot.scale).max(0.0) as u32;
    let py = ((y - snapshot.y) as f64 * snapshot.scale).max(0.0) as u32;
    let pw = ((w as f64) * snapshot.scale) as u32;
    let ph = ((h as f64) * snapshot.scale) as u32;

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

fn open_overlay_window(app: &AppHandle, snapshot: &ScreenSnapshot) -> Result<(), String> {
    close_window(app, "overlay");
    let lw = snapshot.width as f64 / snapshot.scale;
    let lh = snapshot.height as f64 / snapshot.scale;
    let lx = snapshot.x as f64;
    let ly = snapshot.y as f64;

    let w = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("index.html#overlay".into()))
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(lw, lh)
        .position(lx, ly)
        .build()
        .map_err(|e| e.to_string())?;

    w.show().map_err(|e| e.to_string())?;
    Ok(())
}

fn open_editor_window(app: &AppHandle) -> Result<(), String> {
    close_window(app, "editor");
    WebviewWindowBuilder::new(app, "editor", WebviewUrl::App("index.html#editor".into()))
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

// ── Commands: capture ─────────────────────────────────────────────────────────

#[tauri::command]
async fn start_region_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let snapshot = capture_primary_monitor()?;
    open_overlay_window(&app, &snapshot)?;
    *state.screen_snapshot.lock().unwrap() = Some(snapshot);
    Ok(())
}

#[tauri::command]
async fn start_fullscreen_capture(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let snapshot = capture_primary_monitor()?;
    *state.capture_data.lock().unwrap() = Some(snapshot.data.clone());
    *state.screen_snapshot.lock().unwrap() = Some(snapshot);
    open_editor_window(&app)?;
    Ok(())
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
    close_window(&app, "overlay");
    std::thread::sleep(std::time::Duration::from_millis(80));

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
    Ok(())
}

#[tauri::command]
async fn save_image(path: String, data: String) -> Result<(), String> {
    let bytes = general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Commands: pin window ──────────────────────────────────────────────────────

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

    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html#pin".into()))
        .inner_size(win_w, win_h)
        .min_inner_size(80.0, 60.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(false)
        .build()
        .map_err(|e| e.to_string())?;

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
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html#settings".into()))
        .inner_size(480.0, 400.0)
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
        })
        .invoke_handler(tauri::generate_handler![
            start_region_capture,
            start_fullscreen_capture,
            do_region_capture,
            get_screen_snapshot,
            get_capture_data,
            close_overlay,
            save_image,
            open_pin_window,
            open_settings,
            get_hotkey_config,
            check_shortcut_conflict,
            save_hotkey_config,
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

    // Register global hotkeys
    register_shortcuts(app.handle(), &config)?;

    // ── System Tray ───────────────────────────────────────────────────────────
    let region_item  = MenuItem::with_id(app, "region",     "区域截图", true, None::<&str>)?;
    let full_item    = MenuItem::with_id(app, "fullscreen", "全屏截图", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings",  "设置",     true, None::<&str>)?;
    let quit_item    = MenuItem::with_id(app, "quit",       "退出",     true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&region_item, &full_item, &settings_item, &quit_item])?;

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
                "settings" => {
                    tauri::async_runtime::spawn(async move {
                        let _ = open_settings(app).await;
                    });
                }
                "quit" => std::process::exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {}
        })
        .build(app)?;

    Ok(())
}
