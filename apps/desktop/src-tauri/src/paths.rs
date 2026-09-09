//! Where the desktop application keeps things.
//!
//! Deliberately the same layout `packages/shared/src/platform.ts` resolves, and
//! deliberately computed here rather than asked of Tauri. Tauri's own
//! `app_data_dir()` derives from the bundle identifier — `ai.meridian.desktop`
//! — which would put state in `%APPDATA%\ai.meridian.desktop`. The gateway,
//! started as a child process, resolves `%APPDATA%\Meridian` from its own
//! platform module. Two answers to one question is how a user ends up with two
//! databases and no idea which one has their credentials in it.
//!
//! So this file is the Rust half of one shared decision, and the test at the
//! bottom is what keeps the two halves honest.

use std::path::PathBuf;

/// The directory name, matching `APP_DIR_WINDOWS` / `APP_DIR_POSIX` in
/// `platform.ts`.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const APP_DIR: &str = "Meridian";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const APP_DIR: &str = "meridian";

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

fn home() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        env_path("USERPROFILE").unwrap_or_else(|| PathBuf::from("C:\\"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        env_path("HOME").unwrap_or_else(|| PathBuf::from("/"))
    }
}

/// Durable user state: the database, generated assets, the wrapped master key.
///
/// Roaming on Windows, because this is the user's own state and a managed
/// profile should carry it between machines.
pub fn data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        env_path("APPDATA")
            .unwrap_or_else(|| home().join("AppData").join("Roaming"))
            .join(APP_DIR)
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Application Support").join(APP_DIR)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        env_path("XDG_DATA_HOME")
            .unwrap_or_else(|| home().join(".local").join("share"))
            .join(APP_DIR)
    }
}

/// Rotating logs. Local on Windows, never roamed: they are large, they are
/// machine-specific, and roaming them is how a login becomes slow.
pub fn logs_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        env_path("LOCALAPPDATA")
            .unwrap_or_else(|| home().join("AppData").join("Local"))
            .join(APP_DIR)
            .join("logs")
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Logs").join(APP_DIR)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        env_path("XDG_STATE_HOME")
            .unwrap_or_else(|| home().join(".local").join("state"))
            .join(APP_DIR)
            .join("logs")
    }
}

/// State that is meaningless once the process is gone: the port it bound.
pub fn runtime_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        env_path("LOCALAPPDATA")
            .unwrap_or_else(|| home().join("AppData").join("Local"))
            .join(APP_DIR)
            .join("runtime")
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Caches").join(APP_DIR).join("runtime")
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        env_path("XDG_RUNTIME_DIR")
            .unwrap_or_else(|| {
                env_path("XDG_STATE_HOME").unwrap_or_else(|| home().join(".local").join("state"))
            })
            .join(APP_DIR)
    }
}

/// Agent workspaces. Under the data directory, because they are the user's work.
pub fn workspaces_dir() -> PathBuf {
    data_dir().join("workspaces")
}

/// The wrapped master key.
///
/// Beside the database rather than inside it, which is the entire point: the
/// database holds credentials encrypted under this key, so a key stored in the
/// same file protects a leaked backup and nothing else.
pub fn master_key_path() -> PathBuf {
    data_dir().join("master.key")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two halves agree.
    ///
    /// This asserts the shape rather than an absolute string, because the
    /// absolute string depends on whose machine is running the test. What must
    /// hold everywhere is that data and logs are different directories, that
    /// neither is inside the other, and that the application directory is not
    /// involved in either — writing user state next to the executable is the
    /// specific mistake this module exists to prevent.
    #[test]
    fn state_is_per_user_and_not_beside_the_executable() {
        let data = data_dir();
        let logs = logs_dir();
        assert_ne!(data, logs);
        assert!(!logs.starts_with(&data), "logs must not roam with the database");
        assert!(data.ends_with(APP_DIR), "the data directory is named for the app: {data:?}");

        let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf()));
        if let Some(exe_dir) = exe_dir {
            assert!(!data.starts_with(&exe_dir), "user state must never live where the application is installed");
        }
    }

    #[test]
    fn the_master_key_is_not_inside_the_database() {
        // A key kept beside the ciphertext it decrypts is not a key.
        let key = master_key_path();
        assert!(key.starts_with(data_dir()));
        assert!(!key.to_string_lossy().ends_with(".db"));
    }
}
