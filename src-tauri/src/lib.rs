//! The Maka macOS shell: a Tauri 2 host around the Node sidecar.
//!
//! What it does, and nothing more:
//!   * starts the bundled Node on the bundled `sidecar/index.js` (sidecar.rs), restarts it
//!     when it dies (three times a minute at most, then shows the error),
//!   * opens one window on the park once the sidecar answers,
//!   * keeps a menu bar item with the Entrance Gate count, the Away toggle, the login item
//!     and the updater (tray.rs),
//!   * owns the Keychain and hands the sidecar a session-scoped credential broker
//!     (credentials.rs, broker.rs; phase 3 step 2).
//! Closing the window hides it; the app keeps running (24/7 is the point) until Quit.

pub mod broker;
pub mod credentials;
pub mod local_http;
pub mod sidecar;
pub mod tray;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const MAIN_WINDOW: &str = "main";
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
pub const STOP_GRACE: Duration = Duration::from_secs(8);
pub const MAX_RESTARTS_PER_MINUTE: usize = 3;

/// Shared between the launcher thread, the tray and the exit handler.
#[derive(Default)]
pub struct Shell {
    pub sidecar: Mutex<Option<sidecar::Sidecar>>,
    pub url: Mutex<Option<String>>,
    /// The sidecar's per-boot token from `/api/state` (safety M4): every mutating request
    /// the shell sends carries it in `x-maka-token`. Refreshed by the tray poll.
    pub token: Mutex<Option<String>>,
    pub home: Mutex<Option<PathBuf>>,
    pub quitting: Mutex<bool>,
    /// The splash page's own URL (tauri://localhost/index.html), kept so an error can be shown
    /// after the window moved to the park.
    pub splash: Mutex<Option<String>>,
    /// The credential broker (step 2): one per session, closed on exit.
    pub broker: Mutex<Option<broker::Broker>>,
}

pub type ShellState = Arc<Shell>;

pub fn run() {
    let shell: ShellState = Arc::new(Shell::default());
    tauri::Builder::default()
        .manage(shell.clone())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(move |app| {
            // The updater is registered only when the build carried an updater config
            // (release builds pass it; a dev build has none and says so in the tray).
            if app.config().plugins.0.contains_key("updater") {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .title("Maka")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .build()?;
            if let Ok(u) = window.url() {
                *shell.splash.lock().unwrap() = Some(u.to_string());
            }
            tray::install(app.handle())?;
            let handle = app.handle().clone();
            let shell2 = shell.clone();
            std::thread::Builder::new()
                .name("maka-sidecar".into())
                .spawn(move || supervise(handle, shell2))
                .expect("spawn the sidecar supervisor");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide, do not close: the crew keeps running; the tray reopens the park.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Maka shell")
        .run(|app, event| match event {
            RunEvent::ExitRequested { code: None, api, .. } => {
                // The last window closed (hidden, really): keep running for the tray.
                api.prevent_exit();
            }
            RunEvent::Exit => {
                let shell = app.state::<ShellState>();
                *shell.quitting.lock().unwrap() = true;
                let taken = shell.sidecar.lock().unwrap().take();
                if let Some(mut s) = taken {
                    s.stop(STOP_GRACE);
                }
                let taken = shell.broker.lock().unwrap().take();
                if let Some(b) = taken {
                    b.close();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Resolves where things are for this launch: Node, the repository and the data directory.
/// `MAKA_HOME` wins for the data directory (the smoke test and a dev checkout use it);
/// otherwise the OS app-data directory (`~/Library/Application Support/<identifier>`).
pub fn resolve_launch(app: &AppHandle) -> Result<sidecar::Launch, String> {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let node = sidecar::find_node(exe_dir.as_deref(), std::env::var("MAKA_NODE").ok().as_deref(), std::env::var("PATH").ok().as_deref())?;
    let resource_dir = app.path().resource_dir().ok();
    let repo = sidecar::find_repo(resource_dir.as_deref(), std::env::var("MAKA_REPO").ok().as_deref())?;
    let home = match std::env::var("MAKA_HOME").ok().filter(|s| !s.trim().is_empty()) {
        Some(h) => PathBuf::from(h),
        None => app.path().app_data_dir().map_err(|e| format!("no app data directory: {e}"))?,
    };
    let port = match std::env::var("MAKA_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
        Some(p) => p,
        None => sidecar::free_port().map_err(|e| format!("no free port: {e}"))?,
    };
    Ok(sidecar::Launch { node, repo, home, port, env: Vec::new() })
}

fn navigate(app: &AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if let Ok(u) = url.parse::<tauri::Url>() {
            let _ = w.navigate(u);
        }
    }
}

fn show_error(app: &AppHandle, shell: &Shell, message: &str, log: Option<&std::path::Path>) {
    eprintln!("maka: {message}");
    let splash = shell.splash.lock().unwrap().clone().unwrap_or_else(|| "tauri://localhost/index.html".into());
    let base = splash.split('#').next().unwrap_or(&splash).to_string();
    let mut q = format!("{base}#error={}", urlencode(message));
    if let Some(l) = log {
        q.push_str(&format!("&log={}", urlencode(&l.display().to_string())));
    }
    navigate(app, &q);
    show_main(app);
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Starts the sidecar, opens the park when it answers, and restarts it when it dies.
fn supervise(app: AppHandle, shell: ShellState) {
    let mut launch = match resolve_launch(&app) {
        Ok(l) => l,
        Err(e) => return show_error(&app, &shell, &e, None),
    };
    *shell.home.lock().unwrap() = Some(launch.home.clone());
    launch.env.extend(crate::session_env(&app, &shell, &launch));
    let mut recent: Vec<Instant> = Vec::new();
    loop {
        if *shell.quitting.lock().unwrap() {
            return;
        }
        let mut sc = match sidecar::spawn(&launch) {
            Ok(s) => s,
            Err(e) => return show_error(&app, &shell, &e, None),
        };
        println!("maka: sidecar pid {} at {} (log {})", sc.pid(), sc.url, sc.log_path.display());
        if let Err(e) = sidecar::wait_ready(&mut sc, READY_TIMEOUT) {
            let log = sc.log_path.clone();
            sc.stop(Duration::from_secs(2));
            return show_error(&app, &shell, &e, Some(&log));
        }
        *shell.url.lock().unwrap() = Some(sc.url.clone());
        navigate(&app, &format!("{}/", sc.url));
        println!("maka: park at {}/", sc.url);
        let log = sc.log_path.clone();
        *shell.sidecar.lock().unwrap() = Some(sc);
        // Wait for the process to end without holding the lock (Quit needs it).
        let code = loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut guard = shell.sidecar.lock().unwrap();
            match guard.as_mut() {
                None => return, // taken by the exit handler
                Some(s) => {
                    if let Some(code) = s.exited() {
                        guard.take();
                        break code;
                    }
                }
            }
        };
        if *shell.quitting.lock().unwrap() {
            return;
        }
        *shell.url.lock().unwrap() = None;
        let now = Instant::now();
        recent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        recent.push(now);
        let why = match code {
            Some(sidecar::EXIT_RESTART) => "asked to restart".to_string(),
            Some(c) => format!("exited with code {c}"),
            None => "was killed by a signal".to_string(),
        };
        eprintln!("maka: the sidecar {why}; restart {} of {}", recent.len(), MAX_RESTARTS_PER_MINUTE);
        if recent.len() > MAX_RESTARTS_PER_MINUTE {
            return show_error(&app, &shell, &format!("The sidecar {why} and kept dying ({} restarts in a minute). Quit Maka from the menu bar and read the log.", recent.len() - 1), Some(&log));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Environment the shell adds to every sidecar launch: the credential broker's socket and
/// session token (`MAKA_CREDENTIALS_SOCKET`, `MAKA_CREDENTIALS_TOKEN`). The broker is
/// started once per session over the platform store (the Keychain on macOS); when it
/// cannot start, the sidecar is told nothing and falls back to its dev keystore file,
/// and the reason goes to the shell's stderr.
pub fn session_env(_app: &AppHandle, shell: &Shell, launch: &sidecar::Launch) -> Vec<(String, String)> {
    let mut guard = shell.broker.lock().unwrap();
    if guard.is_none() {
        let store: Arc<dyn credentials::Store> = Arc::from(credentials::open(&launch.home));
        let base = std::env::temp_dir();
        match broker::start(store.clone(), &base) {
            Ok(b) => {
                println!("maka: credentials from {} via {}", store.describe(), b.socket.display());
                *guard = Some(b);
            }
            Err(e) => eprintln!("maka: credential broker not started ({e}); the sidecar uses its keystore file"),
        }
    }
    guard.as_ref().map(|b| b.env()).unwrap_or_default()
}
