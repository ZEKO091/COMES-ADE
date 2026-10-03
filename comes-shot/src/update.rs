//! Automatic updates from GitHub releases of ZEKO091/COMES-ADE.
//!
//! Comes Shot releases are tagged `comes-shot-vX.Y.Z` and are never marked
//! "Latest" (ComesADE's own updater reads releases/latest). The app checks
//! them, downloads a newer `ComesShot.exe`, verifies its SHA-256 against the
//! digest GitHub reports, swaps it in place of the running exe and restarts.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const API_HOST: &str = "api.github.com";
const API_PATH: &str = "/repos/ZEKO091/COMES-ADE/releases?per_page=50";
pub const TAG_PREFIX: &str = "comes-shot-v";
const ASSET: &str = "ComesShot.exe";
const MAX_EXE: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    /// "sha256:<hex>", computed by GitHub when the asset was uploaded.
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Available {
    pub version: String,
    url: String,
    sha256: Option<String>,
    /// URL of a `ComesShot.exe.sha256` asset, used when GitHub gives no digest.
    sha_url: Option<String>,
}

pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut it = s.trim().trim_start_matches('v').split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next().unwrap_or(Some(0))?, it.next().unwrap_or(Some(0))?))
}

pub fn current() -> (u32, u32, u32) {
    parse_version(env!("CARGO_PKG_VERSION")).unwrap_or((0, 0, 0))
}

/// Newest published Comes Shot release that is newer than this build.
pub fn check() -> Option<Available> {
    let body = crate::net::get_bytes(API_HOST, API_PATH, 15_000, 4 * 1024 * 1024)?;
    let releases: Vec<Release> = serde_json::from_slice(&body).ok()?;
    newest(&releases, current())
}

fn newest(releases: &[Release], current: (u32, u32, u32)) -> Option<Available> {
    releases
        .iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let v = parse_version(r.tag_name.strip_prefix(TAG_PREFIX)?)?;
            let exe = r.assets.iter().find(|a| a.name == ASSET)?;
            let sha256 = exe.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")).map(|s| s.to_ascii_lowercase());
            let sha_url = r.assets.iter().find(|a| a.name == format!("{ASSET}.sha256")).map(|a| a.browser_download_url.clone());
            Some((v, Available { version: format!("{}.{}.{}", v.0, v.1, v.2), url: exe.browser_download_url.clone(), sha256, sha_url }))
        })
        .filter(|(v, _)| *v > current)
        .max_by_key(|(v, _)| *v)
        .map(|(_, a)| a)
}

fn update_dir() -> PathBuf {
    crate::config::app_dir().join("update")
}

/// Downloads and verifies the new exe. Returns its path, ready to install.
pub fn download(a: &Available) -> Result<PathBuf, String> {
    let expected = match &a.sha256 {
        Some(h) => h.clone(),
        None => {
            // Fall back to the checksum file published next to the exe.
            let url = a.sha_url.as_ref().ok_or("la versión no publica su huella SHA-256")?;
            let text = crate::net::get_url(url, 15_000, 4096).ok_or("no se pudo descargar la huella")?;
            String::from_utf8_lossy(&text).split_whitespace().next().unwrap_or("").to_ascii_lowercase()
        }
    };
    let bytes = crate::net::get_url(&a.url, 60_000, MAX_EXE).ok_or("no se pudo descargar la actualización")?;
    let got = hex(&Sha256::digest(&bytes));
    if got != expected {
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

    fn rel(tag: &str, digest: Option<&str>) -> Release {
        Release {
            tag_name: tag.into(),
            draft: false,
            prerelease: false,
            assets: vec![Asset { name: ASSET.into(), browser_download_url: format!("https://x/{tag}"), digest: digest.map(|d| d.into()) }],
        }
    }

    #[test]
    fn picks_newest_comes_shot_release_only() {
        let list = vec![
            rel("v1.0.3", Some("sha256:aa")), // ComesADE: ignored
            rel("comes-shot-v0.2.0", Some("sha256:bb")),
            rel("comes-shot-v0.10.1", Some("sha256:CC")),
            rel("comes-shot-v0.3.0", None),
        ];
        let a = newest(&list, (0, 2, 0)).unwrap();
        assert_eq!(a.version, "0.10.1");
        assert_eq!(a.sha256.as_deref(), Some("cc"));
        assert!(newest(&list, (0, 10, 1)).is_none());
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert!(parse_version("x").is_none());
    }

    #[test]
    fn sha256_hex() {
        assert_eq!(hex(&Sha256::digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
