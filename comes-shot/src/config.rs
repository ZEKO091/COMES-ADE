//! Settings stored as TOML in %APPDATA%\ComesShot\config.toml.

use std::cell::RefCell;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
};
use windows::Win32::UI::Shell::{FOLDERID_Pictures, FOLDERID_Screenshots, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Config {
    /// Folder where captures are saved.
    pub save_dir: String,
    /// "png" (lossless, recommended) or "jpg".
    pub format: String,
    /// JPG quality 1-100.
    pub jpg_quality: u8,
    pub copy_to_clipboard: bool,
    pub auto_save: bool,
    pub quick_access: bool,
    /// Seconds before the quick access thumbnail closes by itself. 0 = never.
    pub quick_access_autoclose_secs: u32,
    pub sound: bool,
    /// Full screen capture grabs every display instead of the one under the cursor.
    pub fullscreen_all_displays: bool,
    pub magnifier: bool,
    pub crosshair: bool,
    /// Interface language: "auto" (follows Windows), "es", "en", "pt", "fr" or "de".
    pub language: String,
    pub hotkeys: Hotkeys,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Hotkeys {
    pub area: String,
    pub window: String,
    pub fullscreen: String,
    pub previous: String,
    pub text: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            area: "F4".into(),
            window: "F5".into(),
            fullscreen: "F3".into(),
            previous: "F6".into(),
            text: "F2".into(),
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            save_dir: default_save_dir().to_string_lossy().into_owned(),
            format: "png".into(),
            jpg_quality: 95,
            copy_to_clipboard: true,
            auto_save: true,
            quick_access: true,
            quick_access_autoclose_secs: 0,
            sound: true,
            fullscreen_all_displays: false,
            magnifier: true,
            crosshair: true,
            language: "auto".into(),
            hotkeys: Hotkeys::default(),
        }
    }
}

impl Config {
    pub fn extension(&self) -> &'static str {
        if self.format.eq_ignore_ascii_case("jpg") || self.format.eq_ignore_ascii_case("jpeg") {
            "jpg"
        } else {
            "png"
        }
    }
}

thread_local! {
    static CONFIG: RefCell<Config> = RefCell::new(Config::default());
}

pub fn get() -> Config {
    CONFIG.with(|c| c.borrow().clone())
}

pub fn set(cfg: Config) {
    let _ = save(&cfg);
    CONFIG.with(|c| *c.borrow_mut() = cfg);
}

pub fn update(f: impl FnOnce(&mut Config)) {
    let mut cfg = get();
    f(&mut cfg);
    set(cfg);
}

pub fn app_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("ComesShot")
}

pub fn path() -> PathBuf {
    app_dir().join("config.toml")
}

/// Loads the config file (creating it with defaults the first time).
pub fn load() -> Config {
    let p = path();
    let cfg = match std::fs::read_to_string(&p) {
        Ok(s) => {
            let mut cfg = toml::from_str::<Config>(&s).unwrap_or_default();
            // Move users still on the old default folder to the Screenshots folder;
            // a folder the user picked themselves is left alone.
            if legacy_save_dir().is_some_and(|old| PathBuf::from(&cfg.save_dir) == old) {
                cfg.save_dir = default_save_dir().to_string_lossy().into_owned();
                let _ = save(&cfg);
            }
            cfg
        }
        Err(_) => {
            let cfg = Config::default();
            let _ = save(&cfg);
            cfg
        }
    };
    CONFIG.with(|c| *c.borrow_mut() = cfg.clone());
    cfg
}

pub fn reload_if_changed(last: &mut Option<std::time::SystemTime>) -> bool {
    let m = std::fs::metadata(path()).and_then(|m| m.modified()).ok();
    if m.is_some() && *last != m {
        let first = last.is_none();
        *last = m;
        if !first {
            load();
            return true;
        }
    }
    false
}

fn save(cfg: &Config) -> std::io::Result<()> {
    std::fs::create_dir_all(app_dir())?;
    let body = toml::to_string_pretty(cfg).map_err(std::io::Error::other)?;
    let header = "# Comes Shot — configuración\n\
# Atajos: combina Ctrl, Shift, Alt, Win con una tecla (A-Z, 0-9, F1-F24, PrintScreen).\n\
# La tecla Fn no llega a Windows: Fn+4 suele enviar F4, por eso los atajos son F2-F6.
# Ejemplo: area = \"PrintScreen\" o area = \"Ctrl+Shift+4\"   ·   Deja una cadena vacía para desactivar un atajo.\n\n";
    std::fs::write(path(), format!("{header}{body}"))
}

fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().unwrap_or_default();
        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _));
        (!s.is_empty()).then(|| PathBuf::from(s))
    }
}

/// Windows' own Screenshots folder for the current user (Pictures\Screenshots,
/// following OneDrive or any relocation), so every user gets theirs.
pub fn default_save_dir() -> PathBuf {
    known_folder(&FOLDERID_Screenshots)
        .or_else(|| known_folder(&FOLDERID_Pictures).map(|p| p.join("Screenshots")))
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Pictures").join("Screenshots")))
        .unwrap_or_else(|| PathBuf::from("Screenshots"))
}

/// The default used by earlier versions (Pictures\Comes Shot).
fn legacy_save_dir() -> Option<PathBuf> {
    known_folder(&FOLDERID_Pictures).map(|p| p.join("Comes Shot"))
}

/// Parses "Ctrl+Shift+4" into RegisterHotKey arguments.
pub fn parse_hotkey(s: &str) -> Option<(HOT_KEY_MODIFIERS, u32)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut mods = MOD_NOREPEAT;
    let mut vk: Option<u32> = None;
    for part in s.split('+').map(|p| p.trim()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "ctl" => mods |= MOD_CONTROL,
            "shift" | "mayús" | "mayus" => mods |= MOD_SHIFT,
            "alt" => mods |= MOD_ALT,
            "win" | "windows" | "super" => mods |= MOD_WIN,
            "printscreen" | "prtsc" | "print" | "imppnt" | "impr" => vk = Some(0x2C),
            "space" | "espacio" => vk = Some(0x20),
            k => {
                if k.len() == 1 {
                    let c = k.chars().next()?.to_ascii_uppercase();
                    if c.is_ascii_alphanumeric() {
                        vk = Some(c as u32);
                    } else {
                        return None;
                    }
                } else if let Some(n) = k.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
                    if (1..=24).contains(&n) {
                        vk = Some(0x70 + n - 1);
                    } else {
                        return None;
                    }
                } else {
                    return None;
                }
            }
        }
    }
    vk.map(|v| (mods, v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hotkeys() {
        let (m, vk) = parse_hotkey("Ctrl+Shift+4").unwrap();
        assert_eq!(vk, '4' as u32);
        assert!(m.contains(MOD_CONTROL) && m.contains(MOD_SHIFT));
        assert_eq!(parse_hotkey("PrintScreen").unwrap().1, 0x2C);
        assert_eq!(parse_hotkey("alt+f12").unwrap().1, 0x7B);
        // Plain function keys (what Fn+4 sends on compact keyboards).
        let (m, vk) = parse_hotkey("F4").unwrap();
        assert_eq!((m, vk), (MOD_NOREPEAT, 0x73));
        assert!(parse_hotkey("").is_none());
        assert!(parse_hotkey("Ctrl+Shift").is_none());
    }

    #[test]
    fn config_roundtrip() {
        let c = Config::default();
        let s = toml::to_string_pretty(&c).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        assert_eq!(c, back);
        // Partial files fall back to defaults for the missing keys.
        let partial: Config = toml::from_str("sound = false").unwrap();
        assert!(!partial.sound && partial.copy_to_clipboard);
    }
}
