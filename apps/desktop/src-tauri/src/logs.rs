//! Where the gateway's output goes, and what is removed from it first.
//!
//! A desktop application has no console. The gateway's stdout and stderr are the
//! only account of what happened when something goes wrong, and "Open logs" in
//! the tray is the whole of a user's ability to find out — so they are captured
//! to a file rather than dropped on the floor.
//!
//! Captured output is a place secrets leak. The gateway redacts its own
//! structured logs, but a provider is free to echo part of a key back in an
//! error string, and a stack trace can carry anything. This is the last gate
//! before that reaches a file someone will paste into an issue, so it runs its
//! own pass. Belt and braces, deliberately: the cost is a regex over log lines,
//! and the failure it prevents is a user publishing their own API key while
//! asking for help.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Roll at 4 MB, keep one previous file.
///
/// Small enough that a user can open it, large enough to hold a startup and a
/// session's worth of warnings. Keeping exactly one previous file means a crash
/// loop cannot fill a disk while still leaving the run before the current one
/// available, which is usually the interesting one.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

pub struct LogFile {
    path: PathBuf,
    handle: Mutex<Option<File>>,
}

impl LogFile {
    pub fn open(dir: &Path, name: &str) -> LogFile {
        let _ = fs::create_dir_all(dir);
        let path = dir.join(name);
        let handle = OpenOptions::new().create(true).append(true).open(&path).ok();
        LogFile { path, handle: Mutex::new(handle) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append one line, redacted, with a timestamp.
    pub fn line(&self, source: &str, text: &str) {
        let cleaned = redact(text);
        let stamped = format!("{} [{}] {}\n", stamp(), source, cleaned.trim_end());
        let mut guard = match self.handle.lock() {
            Ok(g) => g,
            // A poisoned mutex means another thread panicked while logging.
            // Losing a log line is not worth propagating a panic into the
            // supervisor, which is the thing keeping the application alive.
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(stamped.as_bytes());
            let _ = file.flush();
            if file.metadata().map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
                let _ = fs::rename(&self.path, self.path.with_extension("1.log"));
                *guard = OpenOptions::new().create(true).append(true).open(&self.path).ok();
            }
        }
    }
}

/// Seconds-resolution UTC, without pulling in a date library.
///
/// A log line needs enough to correlate two events and to say which run it came
/// from. Sub-second precision and local-time formatting are not worth a
/// dependency in a file whose job is to be boring.
fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let tod = secs % 86_400;
    // Civil-from-days, the standard algorithm, so the date is right rather than
    // approximately right.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Remove anything that looks like a credential.
///
/// Pattern-based rather than exhaustive, and that is the honest description: it
/// catches the shapes providers actually use — `sk-`, `sk-ant-`, `gsk_`, `hf_`,
/// bearer headers, `api_key=` in a URL — and it will not catch a secret that
/// looks like ordinary text. It is a reduction in blast radius, not a
/// guarantee, and the alternative of shipping raw provider errors into a file
/// people paste into public issues is worse in every case.
pub fn redact(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if let Some(len) = secret_at(input, i) {
            out.push_str("[redacted]");
            i += len;
            continue;
        }
        // Push one char, not one byte, or multi-byte text is corrupted.
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// If a secret starts at `i`, how long is it?
fn secret_at(input: &str, i: usize) -> Option<usize> {
    let rest = &input[i..];

    // Provider key prefixes, which are conventional and stable enough to match.
    for prefix in ["sk-ant-", "sk-", "gsk_", "hf_", "xai-", "pplx-", "r8_", "fal-", "AIza", "ghp_", "github_pat_"] {
        if rest.starts_with(prefix) {
            let len = prefix.len() + token_len(&rest[prefix.len()..]);
            // A bare prefix in prose is not a key.
            if len > prefix.len() + 8 {
                return Some(len);
            }
        }
    }

    // `Bearer <token>`, case-insensitively, as it appears in a logged header.
    //
    // `get(..n)` rather than `[..n]`: a byte index that lands inside a
    // multi-byte character panics, and a log line is exactly where non-ASCII
    // text arrives. A Windows machine with a Cyrillic or CJK locale would have
    // taken the whole log writer down with it.
    if let Some(head) = rest.get(..7) {
        if head.eq_ignore_ascii_case("bearer ") {
            let len = token_len(&rest[7..]);
            if len > 8 {
                return Some(7 + len);
            }
        }
    }

    // `api_key=...`, `apikey: ...`, `token=...` in a URL or a dumped object.
    for key in ["api_key", "apikey", "api-key", "access_token", "authorization", "password", "secret"] {
        let Some(head) = rest.get(..key.len()) else { continue };
        if head.eq_ignore_ascii_case(key) {
            let after = &rest[key.len()..];
            let sep = after.chars().take_while(|c| matches!(c, '=' | ':' | ' ' | '"' | '\'')).count();
            if sep > 0 {
                let len = token_len(&after[sep..]);
                if len > 8 {
                    return Some(key.len() + sep + len);
                }
            }
        }
    }
    None
}

/// How many characters of token-ish text start here.
fn token_len(s: &str) -> usize {
    s.chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/'))
        .map(|c| c.len_utf8())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_the_key_shapes_providers_actually_use() {
        for secret in [
            "sk-proj-abc123def456ghi789jkl",
            "sk-ant-api03-AAAABBBBCCCCDDDDEEEE",
            "gsk_1234567890abcdefghijklmn",
            "hf_aBcDeFgHiJkLmNoPqRsTuVwXyZ",
            "AIzaSyA1234567890abcdefghijklmno",
        ] {
            let line = format!("provider said: invalid key {secret} rejected");
            let cleaned = redact(&line);
            assert!(!cleaned.contains(secret), "leaked {secret} in {cleaned}");
            assert!(cleaned.contains("[redacted]"));
        }
    }

    #[test]
    fn removes_a_bearer_header_and_a_url_parameter() {
        let cleaned = redact("GET /v1/models Authorization: Bearer abcdef1234567890 failed");
        assert!(!cleaned.contains("abcdef1234567890"), "{cleaned}");

        let cleaned = redact("fetch https://api.example.com/v1?api_key=abcdef1234567890 failed");
        assert!(!cleaned.contains("abcdef1234567890"), "{cleaned}");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        // Over-redaction makes logs useless, which makes people turn them off.
        let line = "listening on http://127.0.0.1:4639 with 12 models from 3 providers";
        assert_eq!(redact(line), line);

        // A bare prefix in prose is not a key and must survive.
        let line = "keys for this provider start with sk- followed by the token";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn does_not_corrupt_text_that_is_not_ascii() {
        // This is not a politeness check. Slicing a &str on a byte index that
        // lands inside a multi-byte character panics, and a log line is exactly
        // where such text arrives — a provider error in Russian, a Windows
        // path with a CJK username. The first version of `secret_at` did
        // exactly that and took the log writer down with it.
        for line in [
            "не удалось: модель недоступна — 模型不可用",
            "C:\\Users\\Ольга\\AppData\\Roaming\\Meridian",
            "авторизация: не удалось",
            "秘密鍵が無効です",
            "→ ✓ ✗ — ‘quotes’ “and” …",
        ] {
            assert_eq!(redact(line), line, "redact altered or panicked on: {line}");
        }
    }

    #[test]
    fn still_finds_a_secret_next_to_text_that_is_not_ascii() {
        // The fix must not be "give up on any line containing non-ASCII".
        let line = "ошибка: ключ sk-proj-abc123def456ghi789 отклонён";
        let cleaned = redact(line);
        assert!(!cleaned.contains("sk-proj-abc123def456ghi789"), "{cleaned}");
        assert!(cleaned.contains("ошибка"), "the rest of the line must survive: {cleaned}");
    }

    #[test]
    fn the_timestamp_is_a_real_date() {
        let s = stamp();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.ends_with('Z'));
        let year: i32 = s[..4].parse().unwrap();
        assert!(year >= 2024 && year < 2100, "implausible year in {s}");
        let month: u32 = s[5..7].parse().unwrap();
        let day: u32 = s[8..10].parse().unwrap();
        assert!((1..=12).contains(&month), "{s}");
        assert!((1..=31).contains(&day), "{s}");
    }
}
