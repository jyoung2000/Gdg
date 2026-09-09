// A GUI application must not open a console window on Windows. Without this
// every launch flashes a black box behind the splash screen.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Meridian, as a desktop application.
//!
//! The shell owns one child process — the gateway — and gives it a window, a
//! tray icon and a lifetime. Everything a user thinks of as Meridian is served
//! by that gateway; everything this program does is make it start when they
//! open the app, stop when they quit it, and explain itself when it cannot.
//!
//! Two decisions here are worth stating because they are the ones a reader will
//! question.
//!
//! **The window loads a local page first, then navigates to the gateway.** The
//! obvious alternative — point the webview at `http://127.0.0.1:PORT` and be
//! done — cannot render anything when the gateway is the thing that failed,
//! which is precisely when a user needs to be told something. The local page is
//! the splash, the progress and the diagnostics screen, and it is available
//! before there is a server and after one has died.
//!
//! **The product itself is then served over loopback rather than bundled into
//! the webview.** The web client uses relative URLs and `location.host` for its
//! event stream, so serving it from the gateway keeps it same-origin. The
//! alternative would mean widening CORS to a webview origin and loosening the
//! gateway's Content-Security-Policy for every deployment — paying a real
//! security cost, in the server, to move files that are already local from one
//! local place to another.
//!
//! **Closing the window does not quit.** Other things talk to this gateway: the
//! `uag` CLI, an editor pointed at the OpenAI-compatible API, anything the user
//! configured. Killing the server because a window was closed would break all
//! of them silently. The window hides, the tray icon stays, and quitting is a
//! deliberate act from the tray.

mod gateway;
mod logs;
mod paths;
mod ports;
mod secret;

use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use gateway::{Phase, Plan, Status, Supervisor};

/// Everything the commands and the tray need to reach.
struct Shell {
    supervisor: Arc<Supervisor>,
    plan: Mutex<Plan>,
    /// Set once the user has been told the app keeps running in the tray, so
    /// they are told once rather than every time they close the window.
    warned_about_tray: Mutex<bool>,
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn status(shell: tauri::State<'_, Shell>) -> Status {
    shell.supervisor.status()
}

/// Start the gateway again after a failure.
///
/// The retry button on the diagnostics screen, and the tray's Restart. Runs on
/// its own thread so the window keeps painting; the UI follows through the
/// status event rather than waiting on a reply.
#[tauri::command]
fn retry(app: AppHandle) {
    std::thread::spawn(move || start_gateway(&app));
}

#[tauri::command]
fn open_logs(app: AppHandle, shell: tauri::State<'_, Shell>) -> Result<(), String> {
    let path = shell.supervisor.status().log_path;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_data_dir(app: AppHandle, shell: tauri::State<'_, Shell>) -> Result<(), String> {
    let path = shell.supervisor.status().data_dir;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Open a link in the user's own browser.
///
/// The webview is for Meridian. A provider's documentation, a signup page, an
/// OAuth flow — those belong in a real browser with the user's own session,
/// password manager and extensions, and letting them navigate this window would
/// replace the application with somebody else's website.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::parse(&url).ok_or_else(|| "not a URL".to_string())?;
    if parsed.0 != "https" && parsed.0 != "http" {
        // No `file:`, no custom schemes. A link is a link.
        return Err("only http and https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(app: AppHandle) {
    shutdown(&app);
    app.exit(0);
}

/// The smallest URL parse that answers the only question asked of it.
mod url {
    /// Returns (scheme, rest) for a well-formed absolute URL.
    pub fn parse(input: &str) -> Option<(String, String)> {
        let i = input.find("://")?;
        let scheme = input[..i].to_ascii_lowercase();
        if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return None;
        }
        Some((scheme, input[i + 3..].to_string()))
    }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

fn start_gateway(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let plan = match shell.plan.lock() {
        Ok(p) => Plan {
            node: p.node.clone(),
            entry: p.entry.clone(),
            web_root: p.web_root.clone(),
            migrations: p.migrations.clone(),
            data_dir: p.data_dir.clone(),
            workspaces_dir: p.workspaces_dir.clone(),
            runtime_state: p.runtime_state.clone(),
            master_key: p.master_key.clone(),
            key_protection: p.key_protection.clone(),
            // A fresh port every attempt: whatever was holding the last one may
            // still be holding it, and retrying into the same collision is not
            // a retry.
            port: ports::choose(),
        },
        Err(_) => return,
    };

    let supervisor = Arc::clone(&shell.supervisor);
    emit_status(app, &supervisor.status());

    match supervisor.start(&plan) {
        Ok(()) => {
            let url = supervisor.status().url.unwrap_or_default();
            emit_status(app, &supervisor.status());
            if let Some(window) = app.get_webview_window("main") {
                // Hand the window to the product. Everything from here is
                // Meridian's own UI, served same-origin by the gateway.
                if let Err(e) = window.navigate(url.parse().expect("the gateway's own URL should parse")) {
                    supervisor.mark(Phase::Degraded, format!("Meridian is running at {url} but the window could not open it: {e}"));
                } else {
                    supervisor.mark(Phase::Ready, format!("Meridian is running at {url}"));
                }
                let _ = window.show();
            }
            emit_status(app, &supervisor.status());
            watch_for_exit(app.clone());
        }
        Err(detail) => {
            // The window is already showing the local page, which now renders
            // the diagnostics rather than a blank rectangle.
            emit_status(app, &supervisor.status());
            eprintln!("meridian: {detail}");
        }
    }
}

/// Notice if the gateway dies on its own.
///
/// Without this the window would keep showing a page that no longer has a
/// server behind it, and every click would fail with a network error the user
/// has no way to interpret.
fn watch_for_exit(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let Some(shell) = app.try_state::<Shell>() else { return };
        let supervisor = Arc::clone(&shell.supervisor);
        if matches!(supervisor.status().phase, Phase::ShuttingDown) {
            return;
        }
        if let Some(code) = supervisor.exited() {
            supervisor.mark(
                Phase::GatewayUnavailable,
                match code {
                    Some(c) => format!("Meridian's gateway stopped unexpectedly (exit code {c})."),
                    None => "Meridian's gateway stopped unexpectedly.".to_string(),
                },
            );
            emit_status(&app, &supervisor.status());
            // Back to the local page, which can explain itself. Staying on a
            // dead server's last render would be worse than a blank window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                if let Ok(url) = "tauri://localhost/index.html".parse() {
                    let _ = window.navigate(url);
                }
            }
            return;
        }
    });
}

fn emit_status(app: &AppHandle, status: &Status) {
    let _ = app.emit("meridian://status", status);
}

fn shutdown(app: &AppHandle) {
    if let Some(shell) = app.try_state::<Shell>() {
        shell.supervisor.mark(Phase::ShuttingDown, "Stopping Meridian");
        shell.supervisor.stop();
    }
}

/* ------------------------------------------------------------------ */
/* Tray                                                                */
/* ------------------------------------------------------------------ */

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Meridian", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart the gateway", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open logs", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "Open data folder", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Meridian", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &restart,
            &logs,
            &data,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().ok_or_else(|| tauri::Error::InvalidIcon(std::io::Error::other("no window icon")))?)
        .tooltip("Meridian")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "restart" => {
                let app = app.clone();
                std::thread::spawn(move || start_gateway(&app));
            }
            "logs" => {
                if let Some(shell) = app.try_state::<Shell>() {
                    let _ = app.opener().open_path(shell.supervisor.status().log_path, None::<&str>);
                }
            }
            "data" => {
                if let Some(shell) = app.try_state::<Shell>() {
                    let _ = app.opener().open_path(shell.supervisor.status().data_dir, None::<&str>);
                }
            }
            "quit" => {
                shutdown(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // A left click opens the window, which is what every tray
            // application does and what people try first.
            if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

/// The runtime binary's name, which is the platform's.
const NODE_BIN: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Where the payload is, across the layouts this application actually ships in.
///
/// An installed application keeps its resources where the bundler put them,
/// which is what `resource_dir()` answers and is the only case on Windows. A
/// portable build is a folder someone unzipped, where everything sits beside
/// the executable. Both are supported deliberately — a portable artefact that
/// could not find its own payload would be a download that does nothing.
///
/// Each candidate is checked for the files rather than for existence, because
/// a directory that happens to be there and is empty is not the payload, and
/// picking it would produce a worse error further away from the cause.
fn find_payload(app: &AppHandle, log: &logs::LogFile) -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
            // A macOS .app puts resources one level over from MacOS/.
            candidates.push(dir.join("..").join("Resources"));
        }
    }
    for dir in candidates {
        if dir.join("runtime").join(NODE_BIN).exists() && dir.join("server").join("gateway").join("main.js").exists() {
            log.line("shell", &format!("payload found at {}", dir.display()));
            return Some(dir);
        }
        log.line("shell", &format!("no payload at {}", dir.display()));
    }
    None
}

fn resolve_plan(app: &AppHandle, log: &logs::LogFile, master_key: String, key_protection: String) -> Result<Plan, String> {
    let resources = find_payload(app, log).ok_or_else(|| {
        "This installation is incomplete: Meridian's bundled runtime and gateway are missing. Reinstalling should fix it."
            .to_string()
    })?;

    let node = resources.join("runtime").join(NODE_BIN);
    let entry = resources.join("server").join("gateway").join("main.js");

    let data_dir = paths::data_dir();
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("could not create {}: {e}", data_dir.display()))?;
    let workspaces_dir = paths::workspaces_dir();
    std::fs::create_dir_all(&workspaces_dir).map_err(|e| format!("could not create {}: {e}", workspaces_dir.display()))?;
    let runtime_dir = paths::runtime_dir();
    std::fs::create_dir_all(&runtime_dir).ok();

    Ok(Plan {
        node,
        entry,
        web_root: resources.join("server").join("web"),
        migrations: resources.join("server").join("database").join("migrations"),
        data_dir,
        workspaces_dir,
        runtime_state: runtime_dir.join("instance.json"),
        master_key,
        key_protection,
        port: ports::choose(),
    })
}

fn main() {
    tauri::Builder::default()
        // First, so a second launch reaches the running instance before it
        // does anything else. Two gateways on one database would each hold the
        // port and the file, and the user would have no way to tell which
        // window belonged to which.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![status, retry, open_logs, open_data_dir, open_external, quit])
        .setup(|app| {
            let handle = app.handle().clone();
            let log = Arc::new(logs::LogFile::open(&paths::logs_dir(), "meridian.log"));
            log.line("shell", &format!("Meridian {} starting", env!("CARGO_PKG_VERSION")));

            // The master key before anything else: without it the gateway would
            // generate one into its own database, where it protects a leaked
            // backup and nothing more.
            let key = secret::load_or_create(&paths::master_key_path());
            let (master_key, protection, key_error) = match key {
                Ok(k) => {
                    if k.created {
                        log.line("shell", "created a new master key for this installation");
                    }
                    (k.value, format!("{:?}", k.protection).to_lowercase(), None)
                }
                Err(e) => {
                    log.line("shell", &format!("master key unavailable: {e}"));
                    (String::new(), "unavailable".to_string(), Some(e.to_string()))
                }
            };

            let supervisor = Arc::new(Supervisor::new(Arc::clone(&log), &paths::data_dir(), protection.clone()));

            match resolve_plan(&handle, &log, master_key, protection) {
                Ok(plan) => {
                    app.manage(Shell {
                        supervisor: Arc::clone(&supervisor),
                        plan: Mutex::new(plan),
                        warned_about_tray: Mutex::new(false),
                    });
                    if let Some(detail) = key_error {
                        // Refusing to start would be worse: the user can still
                        // read the diagnostics and open their data folder.
                        supervisor.mark(Phase::GatewayUnavailable, detail);
                    } else {
                        let handle = handle.clone();
                        std::thread::spawn(move || start_gateway(&handle));
                    }
                }
                Err(detail) => {
                    log.line("shell", &format!("cannot start: {detail}"));
                    // A broken installation. The window still opens and says so,
                    // which is the entire reason the shell page is local.
                    app.manage(Shell {
                        supervisor: Arc::clone(&supervisor),
                        plan: Mutex::new(Plan {
                            node: Default::default(),
                            entry: Default::default(),
                            web_root: Default::default(),
                            migrations: Default::default(),
                            data_dir: paths::data_dir(),
                            workspaces_dir: paths::workspaces_dir(),
                            runtime_state: paths::runtime_dir().join("instance.json"),
                            master_key: String::new(),
                            key_protection: "unavailable".into(),
                            port: 0,
                        }),
                        warned_about_tray: Mutex::new(false),
                    });
                    supervisor.mark(Phase::GatewayUnavailable, detail);
                }
            }

            build_tray(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide rather than quit. Other things are talking to this
                // gateway; closing a window is not a request to disconnect them.
                api.prevent_close();
                let _ = window.hide();
                if let Some(shell) = window.app_handle().try_state::<Shell>() {
                    if let Ok(mut warned) = shell.warned_about_tray.lock() {
                        if !*warned {
                            *warned = true;
                            // Said once, through the tray, where the answer is.
                            let _ = window.app_handle().emit("meridian://hidden-to-tray", ());
                        }
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Meridian could not start")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                shutdown(app);
            }
        });
}
