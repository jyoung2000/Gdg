//! The master key that decrypts every stored provider credential.
//!
//! Meridian's gateway seals credentials with AES-256-GCM under a key derived
//! from a master secret. When no master secret is configured it generates one
//! and stores it in the settings table — in the same database file as the
//! ciphertext. The doc comment on `SecretBox` is honest about what that buys:
//! it protects a leaked backup and not read access to the live database. For a
//! server that is a deliberate trade an operator can improve by setting
//! `MERIDIAN_MASTER_KEY`. For a desktop install there is nobody to set it, so
//! the default is the deployment.
//!
//! So the shell owns the key instead. It generates one on first run, wraps it,
//! and hands it to the gateway. The database then holds ciphertext under a key
//! that is not in it.
//!
//! On Windows the wrapping is DPAPI (`CryptProtectData`), which binds the blob
//! to the user account: copied to another machine, or opened by another user on
//! the same machine, it does not unwrap. That is a real improvement over a key
//! sitting beside its own ciphertext, and it is the platform's own mechanism
//! rather than something invented here.
//!
//! Elsewhere the key is a file with owner-only permissions. That is weaker and
//! is not described as anything else.
//!
//! The key reaches the gateway through the environment, never through argv. On
//! Windows a process's command line is readable by other users through WMI;
//! its environment block is not. Both are readable by the same user, who could
//! equally unwrap the DPAPI blob — so the environment is the correct channel
//! and argv would be a real leak.

use std::fs;
use std::path::Path;

/// 32 bytes, base64 — the same shape `SecretBox` generates for itself, so
/// nothing downstream can tell the difference.
const KEY_BYTES: usize = 32;

#[derive(Debug)]
pub enum KeyError {
    Io(String),
    Protect(String),
    Corrupt(String),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::Io(m) => write!(f, "could not read or write the master key: {m}"),
            KeyError::Protect(m) => write!(f, "the operating system could not protect the master key: {m}"),
            KeyError::Corrupt(m) => write!(f, "the stored master key could not be read back: {m}"),
        }
    }
}

/// How the key on disk is protected. Reported to the user, because "encrypted"
/// and "encrypted, bound to your Windows account" are different promises.
///
/// Both variants are real; each is constructed on exactly one family of
/// platforms, so the other looks unused to the compiler on any single build.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protection {
    /// Windows DPAPI, scoped to the current user.
    WindowsDpapi,
    /// A file only this account can read. Weaker, and said so.
    FilePermissions,
}

pub struct MasterKey {
    pub value: String,
    pub protection: Protection,
    pub created: bool,
}

/// Load the master key, creating and protecting one on first run.
pub fn load_or_create(path: &Path) -> Result<MasterKey, KeyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| KeyError::Io(e.to_string()))?;
    }

    if path.exists() {
        let stored = fs::read(path).map_err(|e| KeyError::Io(e.to_string()))?;
        let value = unwrap_key(&stored)?;
        return Ok(MasterKey { value, protection: protection(), created: false });
    }

    let key = generate();
    let wrapped = wrap_key(key.as_bytes())?;
    write_private(path, &wrapped)?;
    Ok(MasterKey { value: key, protection: protection(), created: true })
}

fn protection() -> Protection {
    if cfg!(target_os = "windows") {
        Protection::WindowsDpapi
    } else {
        Protection::FilePermissions
    }
}

/// 32 bytes from the OS CSPRNG, base64-encoded.
///
/// `getrandom` on Linux, `BCryptGenRandom` on Windows — reached through the
/// standard library's own hasher seed would be wrong, so this reads the
/// platform source directly.
fn generate() -> String {
    let mut bytes = [0u8; KEY_BYTES];
    fill_random(&mut bytes);
    base64_encode(&bytes)
}

#[cfg(target_os = "windows")]
fn fill_random(out: &mut [u8]) {
    use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    // The system-preferred RNG needs no algorithm handle and is the documented
    // way to ask Windows for cryptographic randomness.
    let status = unsafe {
        BCryptGenRandom(std::ptr::null_mut(), out.as_mut_ptr(), out.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG)
    };
    assert!(status == 0, "BCryptGenRandom failed with status {status}");
}

#[cfg(not(target_os = "windows"))]
fn fill_random(out: &mut [u8]) {
    use std::io::Read;
    // /dev/urandom is the correct source on every Unix this ships to, and
    // failing loudly is right: a master key from a degraded source is worse
    // than no application.
    let mut f = fs::File::open("/dev/urandom").expect("cannot open /dev/urandom for the master key");
    f.read_exact(out).expect("could not read randomness for the master key");
}

/* ------------------------------------------------------------------ */
/* Wrapping                                                            */
/* ------------------------------------------------------------------ */

#[cfg(target_os = "windows")]
fn wrap_key(plain: &[u8]) -> Result<Vec<u8>, KeyError> {
    dpapi(plain, true)
}

#[cfg(target_os = "windows")]
fn unwrap_key(stored: &[u8]) -> Result<String, KeyError> {
    let plain = dpapi(stored, false)?;
    String::from_utf8(plain).map_err(|e| KeyError::Corrupt(e.to_string()))
}

/// `CryptProtectData` / `CryptUnprotectData`, in one place because they differ
/// by one function pointer and sharing the buffer handling avoids two chances
/// to leak the same memory.
#[cfg(target_os = "windows")]
fn dpapi(input: &[u8], protect: bool) -> Result<Vec<u8>, KeyError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTOAPI_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let mut in_blob = CRYPTOAPI_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
    let mut out_blob = CRYPTOAPI_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

    // UI_FORBIDDEN because this runs during startup with no window yet; a
    // blocking prompt here would look like a hang.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &mut in_blob,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        } else {
            CryptUnprotectData(
                &mut in_blob,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        }
    };

    if ok == 0 {
        let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        return Err(if protect {
            KeyError::Protect(format!("CryptProtectData failed (0x{code:08x})"))
        } else {
            // The common cause is a key copied from another machine or another
            // user account — which is DPAPI working, not failing.
            KeyError::Corrupt(format!(
                "CryptUnprotectData failed (0x{code:08x}). This key was protected for a different Windows account or machine."
            ))
        });
    }

    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    unsafe { LocalFree(out_blob.pbData as *mut std::ffi::c_void) };
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
fn wrap_key(plain: &[u8]) -> Result<Vec<u8>, KeyError> {
    // No wrapping. The file mode is the whole protection, and the UI says so
    // rather than implying an encryption that is not happening.
    Ok(plain.to_vec())
}

#[cfg(not(target_os = "windows"))]
fn unwrap_key(stored: &[u8]) -> Result<String, KeyError> {
    String::from_utf8(stored.to_vec()).map_err(|e| KeyError::Corrupt(e.to_string()))
}

/// Write a file only this account can read.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), KeyError> {
    fs::write(path, bytes).map_err(|e| KeyError::Io(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| KeyError::Io(e.to_string()))?;
    }
    // On Windows the file inherits the ACL of a per-user AppData directory,
    // which already excludes other users, and the DPAPI wrapping means the
    // bytes are useless to them regardless.
    Ok(())
}

/* ------------------------------------------------------------------ */

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Base64, written out rather than pulled in.
///
/// One 20-line function against a dependency in the trust path of the master
/// key. The encoding is fixed by RFC 4648 and is not going to change.
fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_rfc_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn a_generated_key_is_32_bytes_of_entropy() {
        let a = generate();
        let b = generate();
        // 32 bytes base64 is 44 characters with one pad.
        assert_eq!(a.len(), 44);
        assert_ne!(a, b, "two keys from the same process must not match");
    }

    #[test]
    fn the_key_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("meridian-key-test-{}", std::process::id()));
        let path = dir.join("master.key");
        let _ = fs::remove_dir_all(&dir);

        let first = load_or_create(&path).expect("should create a key");
        assert!(first.created);
        assert_eq!(first.value.len(), 44);

        let second = load_or_create(&path).expect("should load the same key");
        assert!(!second.created, "a second run must not mint a new key");
        assert_eq!(first.value, second.value, "a new key every launch would orphan every stored credential");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_not_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("meridian-key-perm-{}", std::process::id()));
        let path = dir.join("master.key");
        let _ = fs::remove_dir_all(&dir);
        load_or_create(&path).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the master key must be readable only by its owner, got {mode:o}");
        let _ = fs::remove_dir_all(&dir);
    }
}
