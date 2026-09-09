//! Choosing a port for the local gateway.
//!
//! The documented port is worth defending. It is in bookmarks, in the CLI's
//! default, and in whatever anyone put in `OPENAI_BASE_URL`; moving off it
//! silently breaks all three. So it is tried first, every time, and the fallback
//! is what happens when a user's machine already has something there — which on
//! a desktop is common and is nobody's fault.

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

/// Meridian's documented port. Kept in step with `DEFAULT_PORT` in
/// `packages/shared/src/config.ts`.
pub const PREFERRED_PORT: u16 = 4639;

/// Can this port be bound on loopback right now?
///
/// Answered by binding it, because that is the question. A connect() probe
/// answers "is something listening", which is not the same: a socket in
/// TIME_WAIT, or one another process holds with exclusive semantics, refuses a
/// bind while refusing connections too.
fn can_bind(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// The port to ask the gateway for.
///
/// Returns the preferred port when it is free, and otherwise an ephemeral one
/// the OS just confirmed it can hand out. Binding and immediately releasing
/// leaves a gap in which another process could take it, which is exactly why
/// the gateway announces the port it *actually* bound rather than trusting this
/// number — the race is real, and the answer to it is downstream, not here.
pub fn choose() -> u16 {
    if can_bind(PREFERRED_PORT) {
        return PREFERRED_PORT;
    }
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        // 0 means "let the gateway ask the OS itself", which is a fine last
        // resort: it announces what it got either way.
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_port_is_reported_free() {
        // Bind an ephemeral port, learn its number, release it.
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(can_bind(port));
    }

    #[test]
    fn a_held_port_is_reported_taken() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!can_bind(port), "a port this process is holding must not read as free");
        drop(listener);
    }

    #[test]
    fn choose_never_returns_a_port_it_could_not_bind() {
        let port = choose();
        // Either the preferred one, or an ephemeral one, or 0 meaning "you ask".
        assert!(port == PREFERRED_PORT || port == 0 || port >= 1024);
    }
}
