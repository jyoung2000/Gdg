//! The supervisor: starting, watching and stopping the local gateway.
//!
//! This is the part that makes Meridian an application rather than a server
//! somebody has to remember to run. It owns one child process and answers one
//! question for the rest of the shell — what state is Meridian in — as a value
//! the window can render rather than as a guess.
//!
//! Two things here are not obvious and are load-bearing.
//!
//! **It waits for liveness, not readiness.** `/api/system/ready` answers 503 on
//! a fresh install, correctly: there are no providers configured, so there are
//! no models, so there is nothing to route to. Gating the window on that would
//! leave a new user watching a splash screen until they configured something
//! they could not reach. `/api/system/health` answers 200 as soon as the
//! process is serving, which is the question actually being asked.
//!
//! **It stops the child over stdin.** Windows has no SIGTERM; a parent that
//! wants a child gone calls TerminateProcess, which is `kill -9` with no
//! handler and no chance to close the database. The gateway listens for a line
//! on stdin and shuts down properly, and it treats stdin closing as its own
//! shutdown signal — so if this process dies, the gateway follows rather than
//! surviving as something the user cannot find to kill.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::logs::LogFile;

/// Every state the application can be in, and no others.
///
/// A single enum rather than a set of booleans, because "starting and also
/// unavailable" is not a state and should not be representable.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// The shell is up; nothing has been started yet.
    Starting,
    /// The child process has been spawned and has not answered yet.
    StartingGateway,
    /// The gateway is serving HTTP. Not the same as having models.
    GatewayReady,
    /// The window is showing the product.
    Ready,
    /// Serving, but something a user should know about is wrong.
    Degraded,
    /// It did not start, or it stopped and did not come back.
    GatewayUnavailable,
    /// On the way out.
    ShuttingDown,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Status {
    pub phase: Phase,
    /// One sentence a person can act on. Never a stack trace.
    pub detail: String,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    /// The tail of the gateway's own output, for the diagnostics screen.
    pub recent: Vec<String>,
    pub log_path: String,
    pub data_dir: String,
    /// How the master key is protected on this machine.
    pub key_protection: String,
    /// Set when the preferred port was busy, so the UI can say so plainly.
    pub moved_from_preferred_port: bool,
}

/// What the supervisor needs to start a gateway.
pub struct Plan {
    /// The bundled Node binary.
    pub node: PathBuf,
    /// The gateway bundle.
    pub entry: PathBuf,
    /// The built web client.
    pub web_root: PathBuf,
    /// The .sql migrations.
    pub migrations: PathBuf,
    pub data_dir: PathBuf,
    pub workspaces_dir: PathBuf,
    pub runtime_state: PathBuf,
    pub master_key: String,
    pub key_protection: String,
    pub port: u16,
}

pub struct Supervisor {
    status: Arc<Mutex<Status>>,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    log: Arc<LogFile>,
}

/// How long to wait for the gateway to answer before calling it a failure.
///
/// Generous, because the first run applies every migration and probes for local
/// inference servers on a machine that may be busy installing things. A user who
/// waits 90 seconds is unhappy; a user told "it failed" at 10 seconds when it
/// would have worked at 15 is worse off, because they will try again and wait
/// again.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);

impl Supervisor {
    pub fn new(log: Arc<LogFile>, data_dir: &std::path::Path, key_protection: String) -> Supervisor {
        Supervisor {
            status: Arc::new(Mutex::new(Status {
                phase: Phase::Starting,
                detail: "Starting Meridian".to_string(),
                url: None,
                port: None,
                pid: None,
                recent: Vec::new(),
                log_path: log.path().display().to_string(),
                data_dir: data_dir.display().to_string(),
                key_protection,
                moved_from_preferred_port: false,
            })),
            child: Arc::new(Mutex::new(None)),
            stdin: Arc::new(Mutex::new(None)),
            log,
        }
    }

    pub fn status(&self) -> Status {
        self.status.lock().map(|s| s.clone()).unwrap_or_else(|p| p.into_inner().clone())
    }

    fn set(&self, phase: Phase, detail: impl Into<String>) {
        if let Ok(mut s) = self.status.lock() {
            s.phase = phase;
            s.detail = detail.into();
        }
    }

    fn note(&self, line: &str) {
        if let Ok(mut s) = self.status.lock() {
            // A bounded tail: enough for a diagnostics screen, not a second log.
            if s.recent.len() >= 60 {
                s.recent.remove(0);
            }
            s.recent.push(line.to_string());
        }
    }

    /// Start the gateway and block until it is serving or has failed.
    ///
    /// Blocking is deliberate — the caller runs this on its own thread and
    /// reports through `status()`. Making it async would need a runtime this
    /// application otherwise does not have, to save a thread it can afford.
    pub fn start(&self, plan: &Plan) -> Result<(), String> {
        self.stop();
        self.set(Phase::StartingGateway, "Starting the local gateway");

        let mut command = Command::new(&plan.node);
        command
            .arg(&plan.entry)
            // Not the installation directory: the gateway must never be able to
            // write beside the application, and a working directory inside
            // Program Files is how that accident happens.
            .current_dir(&plan.data_dir)
            .env_clear()
            .env("MERIDIAN_DESKTOP", "1")
            .env("MERIDIAN_DATA_DIR", &plan.data_dir)
            .env("MERIDIAN_WORKSPACE_ROOT", &plan.workspaces_dir)
            .env("MERIDIAN_WEB_ROOT", &plan.web_root)
            .env("MERIDIAN_MIGRATIONS_DIR", &plan.migrations)
            .env("MERIDIAN_RUNTIME_STATE", &plan.runtime_state)
            // Through the environment, never argv: on Windows another user can
            // read a process's command line through WMI, and cannot read its
            // environment block.
            .env("MERIDIAN_MASTER_KEY", &plan.master_key)
            .env("PORT", plan.port.to_string())
            .env("MERIDIAN_LOG_FORMAT", "json")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // A few environment variables the OS itself needs. `env_clear` above is
        // the right default — inheriting a developer's shell would let a stray
        // `OPENAI_API_KEY` become a credential the user never configured and
        // cannot see — but a process with no PATH and no TEMP is not a process.
        for key in ["PATH", "SystemRoot", "SystemDrive", "TEMP", "TMP", "windir", "USERPROFILE", "HOME", "LANG"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }

        // No console window. Without this every launch flashes a black box, and
        // on some machines leaves one behind.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|e| {
            format!("could not start the bundled runtime at {}: {e}", plan.node.display())
        })?;

        let pid = child.id();
        if let Ok(mut s) = self.status.lock() {
            s.pid = Some(pid);
        }
        self.log.line("shell", &format!("started the gateway, pid {pid}, requested port {}", plan.port));

        let stdout = child.stdout.take().ok_or("the gateway produced no stdout")?;
        let stderr = child.stderr.take().ok_or("the gateway produced no stderr")?;
        if let Ok(mut guard) = self.stdin.lock() {
            *guard = child.stdin.take();
        }
        if let Ok(mut guard) = self.child.lock() {
            *guard = Some(child);
        }

        // stderr is drained on its own thread. A child whose pipe fills up
        // blocks forever, and a gateway that hangs at 64 KB of warnings would
        // look exactly like a gateway that failed to start.
        {
            let log = Arc::clone(&self.log);
            let status = Arc::clone(&self.status);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log.line("gateway:err", &line);
                    if let Ok(mut s) = status.lock() {
                        if s.recent.len() >= 60 {
                            s.recent.remove(0);
                        }
                        s.recent.push(crate::logs::redact(&line));
                    }
                }
            });
        }

        // stdout carries the announce line, which is how the shell learns the
        // port the gateway actually bound — which may not be the one it asked
        // for, because between "this port is free" and "the gateway bound it"
        // another process can take it.
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut reader = BufReader::new(stdout);
        let mut announced: Option<serde_json::Value> = None;
        let mut line = String::new();

        while Instant::now() < deadline {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // The process closed stdout: it is gone.
                Ok(_) => {}
                Err(e) => {
                    self.log.line("shell", &format!("stopped reading the gateway's output: {e}"));
                    break;
                }
            }
            let trimmed = line.trim_end();
            self.log.line("gateway", trimmed);
            self.note(&crate::logs::redact(trimmed));
            if let Some(rest) = trimmed.strip_prefix("meridian-ready ") {
                announced = serde_json::from_str(rest).ok();
                break;
            }
        }

        // Keep draining stdout for the life of the process, for the log.
        {
            let log = Arc::clone(&self.log);
            let status = Arc::clone(&self.status);
            std::thread::spawn(move || {
                for line in reader.lines().map_while(Result::ok) {
                    log.line("gateway", &line);
                    if let Ok(mut s) = status.lock() {
                        if s.recent.len() >= 60 {
                            s.recent.remove(0);
                        }
                        s.recent.push(crate::logs::redact(&line));
                    }
                }
            });
        }

        let Some(state) = announced else {
            let detail = self.explain_failure();
            self.set(Phase::GatewayUnavailable, detail.clone());
            return Err(detail);
        };

        let port = state.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
        let url = state
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));

        // Serving, or merely announcing? The announce line is written after
        // listen() returns, so this should be immediate — but "should be" is
        // not a thing to navigate a window on.
        if !wait_for_health(&url, deadline) {
            let detail = format!("the gateway started on {url} but never answered a health check");
            self.set(Phase::GatewayUnavailable, detail.clone());
            return Err(detail);
        }

        if let Ok(mut s) = self.status.lock() {
            s.port = Some(port);
            s.url = Some(url.clone());
            s.moved_from_preferred_port = plan.port != 0 && port != plan.port;
        }
        self.set(Phase::GatewayReady, format!("Meridian is serving on {url}"));
        self.log.line("shell", &format!("the gateway is serving on {url}"));
        Ok(())
    }

    /// Why did it not start? Answered from what the child actually said.
    fn explain_failure(&self) -> String {
        let recent = self.status().recent;
        let tail = recent.iter().rev().take(12).cloned().collect::<Vec<_>>();

        // The failures a user can actually do something about, named. Anything
        // else gets the last line the gateway printed, which is more useful
        // than a generic sentence and is already redacted.
        for line in &tail {
            if line.contains("EADDRINUSE") {
                return "Another program is using Meridian's port and it could not move to a free one.".to_string();
            }
            if line.contains("SQLITE_") || line.contains("database is locked") {
                return "Meridian could not open its database. Another copy may still be running.".to_string();
            }
            if line.contains("Could not locate database/migrations") {
                return "This installation is incomplete: its database schema files are missing.".to_string();
            }
            if line.contains("EACCES") || line.contains("EPERM") {
                return "Meridian was not allowed to write to its data folder.".to_string();
            }
        }
        match tail.iter().rev().find(|l| !l.trim().is_empty()) {
            Some(last) => format!("Meridian's gateway did not start. It last said: {last}"),
            None => "Meridian's gateway did not start, and produced no output.".to_string(),
        }
    }

    /// Ask the gateway to stop, and make sure it did.
    pub fn stop(&self) {
        // The polite ask first. This is the only graceful stop available on
        // Windows, and it is what closes the database cleanly.
        if let Ok(mut guard) = self.stdin.lock() {
            if let Some(stdin) = guard.as_mut() {
                let _ = stdin.write_all(b"shutdown\n");
                let _ = stdin.flush();
            }
            // Dropping the handle closes the pipe, which the gateway also
            // treats as a shutdown signal — so this works even if the write
            // above did not land.
            *guard = None;
        }

        let Ok(mut guard) = self.child.lock() else { return };
        let Some(child) = guard.as_mut() else { return };

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
                _ => {
                    // It would not go. Killing it risks the database, which is
                    // why it is the last resort and not the first: an orphaned
                    // gateway holding the port and the data directory is worse
                    // for the next launch than an unclean shutdown SQLite's
                    // journal can recover from.
                    self.log.line("shell", "the gateway did not stop when asked; terminating it");
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
        *guard = None;
        if let Ok(mut s) = self.status.lock() {
            s.pid = None;
            s.url = None;
            s.port = None;
        }
    }

    /// Has the child exited without being asked to?
    pub fn exited(&self) -> Option<Option<i32>> {
        let mut guard = self.child.lock().ok()?;
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            _ => None,
        }
    }

    pub fn mark(&self, phase: Phase, detail: impl Into<String>) {
        self.set(phase, detail);
    }
}

/// Poll until the gateway answers, or the deadline passes.
///
/// Liveness, not readiness — see the module comment. Polling rather than
/// trusting the announce line because "the process wrote a line" and "a socket
/// accepts connections" are different facts, and the window is navigated on the
/// second one.
fn wait_for_health(url: &str, deadline: Instant) -> bool {
    let target = format!("{url}/api/system/health");
    while Instant::now() < deadline {
        if http_ok(&target) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

/// One GET, answered by hand.
///
/// A dependency-free HTTP/1.1 request against a known loopback address. Pulling
/// in an HTTP client to ask one local socket whether it is alive would add a
/// TLS stack and a async runtime to an application that needs neither.
fn http_ok(url: &str) -> bool {
    use std::io::Read;
    use std::net::TcpStream;

    let Some(rest) = url.strip_prefix("http://") else { return false };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };

    let Ok(mut stream) = TcpStream::connect(authority) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let request = format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else { return false };
    // "HTTP/1.1 200" — the status line is all that is being asked about.
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;

    #[test]
    fn http_ok_is_true_for_200_and_false_for_503() {
        for (status, expected) in [("200 OK", true), ("503 Service Unavailable", false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let status = status.to_string();
            let handle = std::thread::spawn(move || {
                if let Ok((mut socket, _)) = listener.accept() {
                    let _ = socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes());
                }
            });
            assert_eq!(http_ok(&format!("http://127.0.0.1:{port}/api/system/health")), expected);
            let _ = handle.join();
        }
    }

    #[test]
    fn http_ok_is_false_when_nothing_is_listening() {
        // Bind and release, so the port is almost certainly free.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!http_ok(&format!("http://127.0.0.1:{port}/api/system/health")));
    }

    #[test]
    fn a_failure_explanation_names_the_cause_a_user_can_act_on() {
        let log = Arc::new(LogFile::open(&std::env::temp_dir(), "meridian-test-explain.log"));
        let sup = Supervisor::new(log, &std::env::temp_dir(), "file-permissions".into());
        sup.note("Error: listen EADDRINUSE: address already in use 127.0.0.1:4639");
        let detail = sup.explain_failure();
        assert!(detail.contains("port"), "{detail}");
        assert!(!detail.contains("EADDRINUSE"), "a user should not be shown an errno: {detail}");
    }

    #[test]
    fn a_failure_with_no_output_still_says_something() {
        let log = Arc::new(LogFile::open(&std::env::temp_dir(), "meridian-test-silent.log"));
        let sup = Supervisor::new(log, &std::env::temp_dir(), "file-permissions".into());
        let detail = sup.explain_failure();
        assert!(!detail.is_empty());
        assert!(detail.contains("did not start"), "{detail}");
    }
}
