//! Automatic updates served by our own Cloudflare Worker (no GitHub).
//!
//! `https://comes-shot-updates.kingfrianfrian16.workers.dev/manifest.json`
//! says which version is current, where its exe is and its SHA-256. The app
//! downloads a newer exe, verifies the hash, swaps it in place of the running
//! exe and restarts. The manifest can pause a release or roll it out to a
//! percentage of installs.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const HOST: &str = "comes-shot-updates.kingfrianfrian16.workers.dev";
const MANIFEST: &str = "/manifest.json";
const MAX_EXE: usize = 64 * 1024 * 1024;

#[derive(Deserialize, Debug)]
struct Manifest {
    version: String,
    /// Path of the exe on the update host, e.g. "/releases/ComesShot-0.2.1.exe".
    path: String,
    sha256: String,
    /// Stops every install from taking this version (e.g. a bad release).
    #[serde(default)]
    paused: bool,
    /// Percentage of installs (0-100) that get this version.
    #[serde(default = "full")]
    rollout: u32,
}

fn full() -> u32 {
    100
}

#[derive(Clone, Debug)]
pub struct Available {
    pub version: String,
    path: String,
    sha256: String,
}

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut it = s.trim().trim_start_matches('v').split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next().unwrap_or(Some(0))?, it.next().unwrap_or(Some(0))?))
}

pub fn current() -> (u32, u32, u32) {
    parse_version(env!("CARGO_PKG_VERSION")).unwrap_or((0, 0, 0))
}

/// The published version, if it is newer than this build and meant for this install.
pub fn check() -> Option<Available> {
    let body = crate::net::get_bytes(HOST, MANIFEST, 15_000, 64 * 1024)?;
    let m: Manifest = serde_json::from_slice(&body).ok()?;
    evaluate(m, current(), install_bucket())
}

fn evaluate(m: Manifest, current: (u32, u32, u32), bucket: u32) -> Option<Available> {
    let v = parse_version(&m.version)?;
    if m.paused || v <= current || bucket >= m.rollout.min(100) {
        return None;
    }
    if m.sha256.len() != 64 || !m.path.starts_with('/') {
        return None;
    }
    Some(Available { version: format!("{}.{}.{}", v.0, v.1, v.2), path: m.path, sha256: m.sha256.to_ascii_lowercase() })
}

/// A stable number 0-99 for this install, used for gradual rollouts.
fn install_bucket() -> u32 {
    let path = crate::config::app_dir().join("install-id");
    let id = std::fs::read_to_string(&path).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or_else(|| {
        let id = Sha256::digest(format!("{:?}{}", std::time::SystemTime::now(), std::process::id()).as_bytes());
        let id = u64::from_le_bytes(id[..8].try_into().unwrap());
        let _ = std::fs::create_dir_all(crate::config::app_dir());
        let _ = std::fs::write(&path, id.to_string());
        id
    });
    (id % 100) as u32
}

fn update_dir() -> PathBuf {
    crate::config::app_dir().join("update")
}

/// Downloads and verifies the new exe. Returns its path, ready to install.
pub fn download(a: &Available) -> Result<PathBuf, String> {
    let bytes = crate::net::get_bytes(HOST, &a.path, 60_000, MAX_EXE).ok_or("no se pudo descargar la actualización")?;
    if hex(&Sha256::digest(&bytes)) != a.sha256 {
        return Err("la descarga no coincide con su huella SHA-256".into());
    }
    if !bytes.starts_with(b"MZ") {
        return Err("el archivo descargado no es un ejecutable".into());
    }
    let dir = update_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("ComesShot-{}.exe", a.version));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn old_path(exe: &Path) -> PathBuf {
    exe.with_extension("old.exe")
}

/// Replaces the running exe with `staged`. A running exe can be renamed but
/// not overwritten, so the current one moves aside first (and is restored if
/// anything fails).
pub fn install(staged: &Path) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let old = old_path(&exe);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("no se pudo reemplazar el programa: {e}"))?;
    if let Err(e) = std::fs::copy(staged, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("no se pudo instalar la actualización: {e}"));
    }
    let _ = std::fs::remove_file(staged);
    Ok(exe)
}

/// Removes the previous version left behind by `install`.
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(old_path(&exe));
    }
    let _ = std::fs::remove_dir_all(update_dir());
}

/// Starts the freshly installed exe; it waits for this process to exit.
pub fn relaunch(exe: &Path, minimized: bool, version: &str) -> bool {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(format!("--updated={version}"));
    if minimized {
        cmd.arg("--background");
    }
    cmd.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(version: &str, paused: bool, rollout: u32) -> Manifest {
        Manifest { version: version.into(), path: "/releases/x.exe".into(), sha256: "a".repeat(64), paused, rollout }
    }

    #[test]
    fn manifest_rules() {
        assert_eq!(evaluate(m("0.3.0", false, 100), (0, 2, 1), 50).unwrap().version, "0.3.0");
        assert!(evaluate(m("0.2.1", false, 100), (0, 2, 1), 50).is_none(), "same version");
        assert!(evaluate(m("0.3.0", true, 100), (0, 2, 1), 50).is_none(), "paused");
        assert!(evaluate(m("0.3.0", false, 20), (0, 2, 1), 50).is_none(), "outside rollout");
        assert!(evaluate(m("0.3.0", false, 20), (0, 2, 1), 10).is_some(), "inside rollout");
        let json = br#"{"version":"0.3.0","path":"/releases/ComesShot-0.3.0.exe","sha256":"AB","extra":1}"#;
        let parsed: Manifest = serde_json::from_slice(json).unwrap();
        assert_eq!(parsed.rollout, 100);
        assert!(evaluate(parsed, (0, 2, 1), 0).is_none(), "bad hash length");
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
    }

    #[test]
    fn sha256_hex() {
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
