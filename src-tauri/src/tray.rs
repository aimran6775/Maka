//! The menu bar item: the Entrance Gate count as the title, the Away toggle, "Start at
//! login" (a LaunchAgent through tauri-plugin-autostart), the updater and Quit.
//!
//! Everything shown comes from the sidecar's `/api/state`, polled over loopback every
//! few seconds; when the sidecar is not answering the item says so instead of showing a
//! stale number. Toggling Away posts to `/api/away`, which emits `away.changed` like the
//! Peak card does, so the park and the tray agree.

use std::time::Duration;

use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::{local_http, show_main, ShellState};

pub const POLL_EVERY: Duration = Duration::from_secs(5);
const ID_GATE: &str = "gate";
const ID_AWAY: &str = "away";
const ID_OPEN: &str = "open";
const ID_LOGIN: &str = "login";
const ID_UPDATE: &str = "update";
const ID_QUIT: &str = "quit";

/// What the tray shows, derived from one `/api/state` answer (or none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayView {
    pub title: String,
    pub gate_line: String,
    pub away: bool,
    pub away_enabled: bool,
}

pub fn view_from_state(state: Option<&Value>) -> TrayView {
    match state {
        None => TrayView { title: "Maka · offline".into(), gate_line: "Sidecar not answering".into(), away: false, away_enabled: false },
        Some(s) => {
            let pending = s.pointer("/gate/pending").and_then(|p| p.as_array()).map(|a| a.len()).unwrap_or(0);
            let away = s.pointer("/away/away").and_then(|a| a.as_bool()).unwrap_or(false);
            let title = if pending > 0 { format!("Maka · {pending}") } else { "Maka".to_string() };
            let gate_line = match pending {
                0 => "Gate: nothing waiting".to_string(),
                1 => "Gate: 1 item waiting".to_string(),
                n => format!("Gate: {n} items waiting"),
            };
            TrayView { title, gate_line, away, away_enabled: true }
        }
    }
}

pub struct TrayHandles {
    pub tray: TrayIcon,
    pub gate: MenuItem<tauri::Wry>,
    pub away: CheckMenuItem<tauri::Wry>,
    pub login: CheckMenuItem<tauri::Wry>,
    pub update: MenuItem<tauri::Wry>,
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let gate = MenuItem::with_id(app, ID_GATE, "Gate: starting…", false, None::<&str>)?;
    let away = CheckMenuItem::with_id(app, ID_AWAY, "Away mode", false, false, None::<&str>)?;
    let open = MenuItem::with_id(app, ID_OPEN, "Open the park", true, None::<&str>)?;
    let login_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, ID_LOGIN, "Start at login", true, login_on, None::<&str>)?;
    let has_updater = app.config().plugins.0.contains_key("updater");
    let update = MenuItem::with_id(app, ID_UPDATE, if has_updater { "Checking for updates…" } else { "Updates: not configured in this build" }, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit Maka", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&gate, &away, &PredefinedMenuItem::separator(app)?, &open, &login, &update, &PredefinedMenuItem::separator(app)?, &quit])?;

    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Maka")
        .on_menu_event(|app, event| match event.id().as_ref() {
            ID_OPEN => show_main(app),
            ID_AWAY => toggle_away(app),
            ID_LOGIN => toggle_login(app),
            ID_UPDATE => install_update(app),
            ID_QUIT => app.exit(0),
            _ => {}
        })
        .build(app)?;
    let _ = tray.set_title(Some("Maka"));
    let handles = TrayHandles { tray, gate, away, login, update };
    app.manage(handles);
    spawn_poller(app.clone());
    if has_updater {
        check_for_updates(app.clone());
    }
    Ok(())
}

fn spawn_poller(app: AppHandle) {
    std::thread::Builder::new()
        .name("maka-tray".into())
        .spawn(move || loop {
            refresh(&app);
            std::thread::sleep(POLL_EVERY);
        })
        .expect("spawn the tray poller");
}

pub fn refresh(app: &AppHandle) {
    let shell = app.state::<ShellState>();
    let url = shell.url.lock().unwrap().clone();
    let state = url.and_then(|u| local_http::get(&format!("{u}/api/state"), Duration::from_secs(3)).ok()).and_then(|r| if r.status == 200 { serde_json::from_str::<Value>(&r.body).ok() } else { None });
    // The per-boot token rides along with the state (safety M4); keep the last one seen so
    // a toggle from the menu can prove itself.
    if let Some(t) = state.as_ref().and_then(token_from_state) {
        *shell.token.lock().unwrap() = Some(t);
    }
    let view = view_from_state(state.as_ref());
    let handles = app.state::<TrayHandles>();
    let _ = handles.tray.set_title(Some(view.title.as_str()));
    let _ = handles.tray.set_tooltip(Some(view.gate_line.as_str()));
    let _ = handles.gate.set_text(&view.gate_line);
    let _ = handles.away.set_checked(view.away);
    let _ = handles.away.set_enabled(view.away_enabled);
    let _ = handles.login.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
}

/// The per-boot token `/api/state` carries (safety M4), when the answer has one.
pub fn token_from_state(state: &Value) -> Option<String> {
    state.get("token").and_then(|t| t.as_str()).filter(|t| !t.is_empty()).map(|t| t.to_string())
}

fn toggle_away(app: &AppHandle) {
    let shell = app.state::<ShellState>();
    let Some(url) = shell.url.lock().unwrap().clone() else { return };
    let token = shell.token.lock().unwrap().clone();
    let handles = app.state::<TrayHandles>();
    let now = handles.away.is_checked().unwrap_or(false);
    // The check item already flipped in the UI; the sidecar's answer is the truth, so the
    // next refresh sets it from /api/state whatever happened here. Without a token (the
    // poll has not answered yet) the sidecar refuses the toggle, and the refresh shows the
    // true state.
    let body = format!("{{\"away\":{}}}", now);
    let _ = local_http::post_json(&format!("{url}/api/away"), &body, token.as_deref(), Duration::from_secs(5));
    refresh(app);
}

fn toggle_login(app: &AppHandle) {
    let auto = app.autolaunch();
    let on = auto.is_enabled().unwrap_or(false);
    let r = if on { auto.disable() } else { auto.enable() };
    if let Err(e) = r {
        eprintln!("maka: login item: {e}");
    }
    let handles = app.state::<TrayHandles>();
    let _ = handles.login.set_checked(auto.is_enabled().unwrap_or(false));
}

fn check_for_updates(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    tauri::async_runtime::spawn(async move {
        let text = match app.updater().map_err(|e| e.to_string()) {
            Err(e) => format!("Updates: {e}"),
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    app.manage(std::sync::Mutex::new(Some(update.clone())));
                    let handles = app.state::<TrayHandles>();
                    let _ = handles.update.set_enabled(true);
                    format!("Update to {} available: install and relaunch", update.version)
                }
                Ok(None) => format!("Up to date ({})", app.package_info().version),
                Err(e) => format!("Updates: check failed ({e})"),
            },
        };
        let handles = app.state::<TrayHandles>();
        let _ = handles.update.set_text(&text);
    });
}

fn install_update(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let update = app.try_state::<std::sync::Mutex<Option<tauri_plugin_updater::Update>>>().and_then(|m| m.lock().unwrap().clone());
        let Some(update) = update else { return };
        let handles = app.state::<TrayHandles>();
        let _ = handles.update.set_text("Downloading the update…");
        let _ = handles.update.set_enabled(false);
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => {
                // The sidecar is stopped by the Exit handler on the way out.
                app.restart();
            }
            Err(e) => {
                let _ = handles.update.set_text(&format!("Update failed: {e}"));
                let _ = handles.update.set_enabled(true);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_view_is_derived_from_the_state_only() {
        let off = view_from_state(None);
        assert_eq!(off.title, "Maka · offline");
        assert!(!off.away_enabled);
        let s: Value = serde_json::from_str(r#"{"gate":{"pending":[{},{}]},"away":{"away":true}}"#).unwrap();
        let v = view_from_state(Some(&s));
        assert_eq!(v, TrayView { title: "Maka · 2".into(), gate_line: "Gate: 2 items waiting".into(), away: true, away_enabled: true });
        let empty: Value = serde_json::from_str(r#"{"gate":{"pending":[]}}"#).unwrap();
        let e = view_from_state(Some(&empty));
        assert_eq!(e.title, "Maka");
        assert_eq!(e.gate_line, "Gate: nothing waiting");
        assert!(!e.away);
    }
}
