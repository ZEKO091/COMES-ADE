//! The Comes Shot app: its main window (shown in the taskbar while open),
//! global hotkeys, and the pipeline that runs after every capture (sound,
//! clipboard, save, preview). Closing the main window quits.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::Mutex;

use windows::core::{BOOL, PCSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, InvalidateRect, ValidateRect};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi;
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumThreadWindows, GetClassNameW, GetMessageW,
    IsIconic, IsWindow, IsWindowVisible, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage, SendMessageW,
    SetCursor, SetForegroundWindow, SetTimer, SetWindowPos, ShowWindow, TranslateMessage,
    IDC_ARROW, IDC_HAND, MSG, SWP_NOACTIVATE, SWP_NOZORDER, SW_RESTORE, SW_SHOW, SW_SHOWMINNOACTIVE, WM_APP,
    WM_CLOSE, WM_COPYDATA, WM_DESTROY, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_ERASEBKGND,
    WM_HOTKEY, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WM_SETCURSOR, WM_SIZE, WM_TIMER, WS_CAPTION,
    WS_EX_APPWINDOW, WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU,
};

use crate::capture::{self, Monitor};
use crate::config::{self, Config};
use crate::home::{self, Home, HomeBtn};
use crate::i18n::{t, tf};
use crate::image::Image;
use crate::overlay::{self, Mode, OverlayResult, Purpose};
use crate::util::{self, Rect, WStr};
use crate::window::{self, Handler};
use crate::{clipboard, editor, gfx, hud, i18n, ocr, pin, quick, shell, sound};

pub const WM_APP_EVENT: u32 = WM_APP + 1;
const WM_MOUSELEAVE: u32 = 0x02A3;
const TIMER_CONFIG: usize = 1;
/// Checks GitHub for a new Comes Shot release (first soon after start, then every 6 h).
const TIMER_UPDATE_FIRST: usize = 2;
const TIMER_UPDATE: usize = 3;
/// Retries installing a downloaded update once the app is idle.
const TIMER_APPLY: usize = 4;
pub const MAIN_CLASS: &str = "ComesShot.Main";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Area,
    Window,
    Fullscreen,
    Previous,
    Text,
    OpenImage,
    OpenFolder,
    Quit,
}

impl Action {
    pub fn from_arg(s: &str) -> Option<Action> {
        Some(match s.trim_start_matches('-').to_ascii_lowercase().as_str() {
            "area" | "region" => Action::Area,
            "window" | "ventana" => Action::Window,
            "fullscreen" | "full" | "pantalla" => Action::Fullscreen,
            "previous" | "anterior" => Action::Previous,
            "text" | "ocr" | "texto" => Action::Text,
            "open" | "abrir" => Action::OpenImage,
            "folder" | "carpeta" => Action::OpenFolder,
            "quit" | "salir" => Action::Quit,
            _ => return None,
        })
    }
    pub fn name(&self) -> &'static str {
        match self {
            Action::Area => "area",
            Action::Window => "window",
            Action::Fullscreen => "fullscreen",
            Action::Previous => "previous",
            Action::Text => "text",
            Action::OpenImage => "open",
            Action::OpenFolder => "folder",
            Action::Quit => "quit",
        }
    }
}

pub enum AppEvent {
    OverlayDone(Option<OverlayResult>),
    /// (text to copy, confirmation shown in the HUD)
    CopyText(String, String),
    Hud(String),
    Saved(Result<PathBuf, String>),
    OcrDone(Result<String, String>),
    Run(Action),
    /// A capture (or an edited image) becomes the "last capture".
    Last(Image, Option<PathBuf>),
    /// A setting changed in the options panel (`options::cmd`).
    Command(usize),
    /// Country of the public IP (for automatic language), or None if unknown.
    IpCountry(Option<String>),
    /// A verified update was downloaded: (exe path, version). None = nothing new.
    UpdateReady(Option<(PathBuf, String)>),
}

static QUEUE: Mutex<VecDeque<AppEvent>> = Mutex::new(VecDeque::new());
static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

pub fn main_hwnd() -> HWND {
    HWND(MAIN_HWND.load(Ordering::Relaxed) as *mut _)
}

/// Queues an event for the main window. Callable from any thread.
pub fn post(ev: AppEvent) {
    QUEUE.lock().unwrap().push_back(ev);
    unsafe {
        let _ = PostMessageW(Some(main_hwnd()), WM_APP_EVENT, WPARAM(0), LPARAM(0));
    }
}

/// Copies an image to the clipboard and reports it.
pub fn copy_image(img: &Image) -> bool {
    clipboard::set_image(main_hwnd(), img, None)
}

/// Saves an image in the background; the result comes back as `AppEvent::Saved`.
pub fn save_async(img: Image, path: PathBuf) {
    let cfg = config::get();
    let q = (path.extension().and_then(|e| e.to_str()).unwrap_or("png").eq_ignore_ascii_case("jpg")
        || path.extension().and_then(|e| e.to_str()).unwrap_or("").eq_ignore_ascii_case("jpeg"))
    .then_some(cfg.jpg_quality);
    std::thread::spawn(move || {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let t = std::time::Instant::now();
        let res = gfx::save_image(&img, &path, q).map(|_| path.clone()).map_err(|e| e.message().to_string());
        capture::log(&format!("saved {} in {:?}", path.display(), t.elapsed()));
        post(AppEvent::Saved(res));
    });
}

/// Next free file name in the captures folder.
pub fn next_capture_path(cfg: &Config) -> PathBuf {
    let dir = PathBuf::from(&cfg.save_dir);
    let _ = std::fs::create_dir_all(&dir);
    let now = unsafe { GetLocalTime() };
    let date = format!("{:04}-{:02}-{:02}", now.wYear, now.wMonth, now.wDay);
    let time = format!("{:02}.{:02}.{:02}", now.wHour, now.wMinute, now.wSecond);
    let base = tf("Comes Shot {} a las {}", &[&date, &time]);
    let ext = cfg.extension();
    let mut p = dir.join(format!("{base}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base} ({n}).{ext}"));
        n += 1;
    }
    p
}

// ---------------------------------------------------------------- the app

struct App {
    hwnd: HWND,
    home: Home,
    /// The main window was hidden so it doesn't end up in a capture.
    main_hidden: bool,
    overlay_open: bool,
    last_area: Option<Rect>,
    last: Option<(Image, Option<PathBuf>)>,
    failed_hotkeys: Vec<String>,
    update_checking: bool,
    pending_update: Option<(PathBuf, String)>,
    config_mtime: Option<std::time::SystemTime>,
}

pub fn run(startup: Option<Action>, background: bool, updated: Option<String>) {
    let cfg = config::load();
    // Last known IP country, so the first frame is already in the right language.
    if let Some((code, _)) = cached_ip_country() {
        i18n::set_ip_country(Some(code));
    }
    i18n::apply(&cfg.language);
    allow_dark_menus();
    // Centre the main window on the monitor under the cursor, sized for its DPI.
    let (cx, cy) = util::cursor_pos();
    let mon = capture::monitor_at(cx, cy);
    let k = mon.scale();
    let style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    let mut wr = RECT { left: 0, top: 0, right: (home::SIZE.0 * k) as i32, bottom: (home::SIZE.1 * k) as i32 };
    unsafe {
        let _ = AdjustWindowRectExForDpi(&mut wr, style, false, WS_EX_APPWINDOW, mon.dpi);
    }
    let (ww, wh) = (wr.right - wr.left, wr.bottom - wr.top);
    let app = App {
        hwnd: HWND::default(),
        home: Home::new(k),
        main_hidden: false,
        overlay_open: false,
        last_area: None,
        last: None,
        failed_hotkeys: Vec::new(),
        update_checking: false,
        pending_update: None,
        config_mtime: None,
    };
    let hwnd = match window::create(
        MAIN_CLASS,
        "Comes Shot",
        style,
        WS_EX_APPWINDOW,
        Rect::new(mon.work.x + (mon.work.w - ww) / 2, mon.work.y + (mon.work.h - wh) / 2, ww, wh),
        false,
        Box::new(app),
    ) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("Comes Shot: no se pudo crear la ventana principal: {e}");
            return;
        }
    };
    MAIN_HWND.store(hwnd.0 as isize, Ordering::Relaxed);
    window::dark_frame(hwnd, home::FRAME);
    unsafe {
        // Started with Windows: sit minimized in the taskbar.
        let _ = ShowWindow(hwnd, if background { SW_SHOWMINNOACTIVE } else { SW_SHOW });
        let _ = PostMessageW(Some(hwnd), WM_APP_EVENT + 10, WPARAM(0), LPARAM(0));
    }
    if let Some(a) = startup {
        post(AppEvent::Run(a));
    }
    if let Some(v) = updated {
        post(AppEvent::Hud(tf("Comes Shot se actualizó a la versión {}", &[&v])));
    }

    unsafe {
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

impl App {
    fn init(&mut self, hwnd: HWND) {
        self.hwnd = hwnd;
        self.register_hotkeys();
        sound::preload();
        // Desktop Duplication ready before the first capture (~5 ms instead of ~40 ms).
        crate::dxgi::warm_up();
        detect_ip_country();
        unsafe {
            SetTimer(Some(hwnd), TIMER_UPDATE_FIRST, 15_000, None);
            SetTimer(Some(hwnd), TIMER_UPDATE, 6 * 3600 * 1000, None);
        }
        let _ = config::reload_if_changed(&mut self.config_mtime);
        unsafe {
            SetTimer(Some(hwnd), TIMER_CONFIG, 2000, None);
        }
        if !self.failed_hotkeys.is_empty() {
            post(AppEvent::Hud(tf("Atajo en uso por otra app: {}", &[&self.failed_hotkeys.join(", ")])));
        }
    }

    fn repaint(&self) {
        unsafe {
            let _ = InvalidateRect(Some(self.hwnd), None, false);
        }
    }

    /// Brings the main window to the front (e.g. when Comes Shot is launched again).
    fn show_main(&self) {
        unsafe {
            if IsIconic(self.hwnd).as_bool() {
                let _ = ShowWindow(self.hwnd, SW_RESTORE);
            } else {
                let _ = ShowWindow(self.hwnd, SW_SHOW);
            }
            let _ = SetForegroundWindow(self.hwnd);
        }
    }

    fn press(&mut self, b: HomeBtn) {
        match b {
            HomeBtn::Area => self.act(Action::Area),
            HomeBtn::Window => self.act(Action::Window),
            HomeBtn::Fullscreen => self.act(Action::Fullscreen),
            HomeBtn::Text => self.act(Action::Text),
            HomeBtn::Previous => self.act(Action::Previous),
            HomeBtn::Open => self.act(Action::OpenImage),
            HomeBtn::Folder => self.act(Action::OpenFolder),
            HomeBtn::Options => self.show_options(),
            HomeBtn::Viewfinder | HomeBtn::Annotate => {
                if let Some((img, path)) = self.last.clone() {
                    editor::open(img, path);
                }
            }
            HomeBtn::Copy => {
                if let Some((img, _)) = &self.last {
                    if copy_image(img) {
                        hud::show(t("Copiado al portapapeles"));
                    }
                }
            }
            HomeBtn::Pin => {
                if let Some((img, _)) = self.last.clone() {
                    pin::open(img, None);
                }
            }
        }
    }

    /// Open annotation editors.
    fn editors(&self) -> Vec<HWND> {
        unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> BOOL {
            let list = &mut *(lp.0 as *mut Vec<HWND>);
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class);
            if String::from_utf16_lossy(&class[..n.max(0) as usize]) == "ComesShot.Editor" {
                list.push(hwnd);
            }
            BOOL(1)
        }
        let mut editors: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumThreadWindows(GetCurrentThreadId(), Some(collect), LPARAM(&mut editors as *mut _ as isize));
        }
        editors
    }

    /// Asks open editors to close (they offer to save). False if one stayed open.
    fn close_editors(&self) -> bool {
        let editors = self.editors();
        unsafe {
            for &e in &editors {
                SendMessageW(e, WM_CLOSE, None, None);
            }
            editors.iter().all(|&e| !IsWindow(Some(e)).as_bool())
        }
    }

    /// Looks for a newer Comes Shot release and downloads it in the background.
    fn check_for_update(&mut self) {
        if !config::get().auto_update || self.update_checking || self.pending_update.is_some() {
            return;
        }
        self.update_checking = true;
        std::thread::spawn(|| {
            let found = crate::update::check().and_then(|a| match crate::update::download(&a) {
                Ok(path) => Some((path, a.version)),
                Err(e) => {
                    capture::log(&format!("actualización {}: {e}", a.version));
                    None
                }
            });
            post(AppEvent::UpdateReady(found));
        });
    }

    /// Installs a downloaded update and restarts, but never in the middle of
    /// something: while a capture or an editor is open it waits and retries.
    fn try_apply_update(&mut self) {
        let Some((path, version)) = self.pending_update.clone() else { return };
        if self.overlay_open || !self.editors().is_empty() {
            unsafe {
                SetTimer(Some(self.hwnd), TIMER_APPLY, 60_000, None);
            }
            return;
        }
        unsafe {
            let _ = KillTimer(Some(self.hwnd), TIMER_APPLY);
        }
        self.pending_update = None;
        match crate::update::install(&path) {
            Ok(exe) => {
                let minimized = unsafe { IsIconic(self.hwnd).as_bool() };
                if crate::update::relaunch(&exe, minimized, &version) {
                    // The new version waits for this one to exit.
                    unsafe {
                        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(self.hwnd);
                    }
                } else {
                    hud::show(&tf("Comes Shot {} se usará la próxima vez que lo abras", &[&version]));
                }
            }
            Err(e) => hud::show(&tf("No se pudo actualizar: {}", &[&e])),
        }
    }

    fn register_hotkeys(&mut self) {
        let cfg = config::get();
        self.failed_hotkeys.clear();
        let list = [
            (1, &cfg.hotkeys.area),
            (2, &cfg.hotkeys.window),
            (3, &cfg.hotkeys.fullscreen),
            (4, &cfg.hotkeys.previous),
            (5, &cfg.hotkeys.text),
        ];
        for (id, s) in list {
            unsafe {
                let _ = UnregisterHotKey(Some(self.hwnd), id);
            }
            if let Some((mods, vk)) = config::parse_hotkey(s) {
                let ok = unsafe { RegisterHotKey(Some(self.hwnd), id, mods, vk) }.is_ok();
                capture::log(&format!("atajo {s}: {}", if ok { "registrado" } else { "en uso" }));
                if !ok {
                    self.failed_hotkeys.push(s.clone());
                }
            }
        }
    }

    fn act(&mut self, a: Action) {
        match a {
            Action::Area => self.start_overlay(Mode::Area, Purpose::Capture),
            Action::Window => self.start_overlay(Mode::Window, Purpose::Capture),
            Action::Text => self.start_overlay(Mode::Area, Purpose::Text),
            Action::Fullscreen => self.capture_fullscreen(),
            Action::Previous => match self.last_area {
                Some(r) => self.capture_rect(r),
                None => self.start_overlay(Mode::Area, Purpose::Capture),
            },
            Action::OpenImage => {
                let cfg = config::get();
                if let Some(p) = shell::open_image_dialog(None, &PathBuf::from(&cfg.save_dir)) {
                    match gfx::load_image(&p) {
                        Ok(img) => editor::open_with(img, Some(p), false),
                        Err(_) => hud::show(t("No se pudo abrir la imagen")),
                    }
                }
            }
            Action::OpenFolder => {
                let dir = PathBuf::from(config::get().save_dir);
                let _ = std::fs::create_dir_all(&dir);
                shell::open_path(&dir);
            }
            // Through WM_CLOSE so open editors still get to offer saving.
            Action::Quit => unsafe {
                let _ = PostMessageW(Some(self.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            },
        }
    }

    /// Hides our own windows (main window, previews, toast) so they never
    /// appear in a capture.
    fn hide_own_windows(&mut self) {
        let mut hidden = quick::set_visible(false) | hud::hide();
        unsafe {
            if IsWindowVisible(self.hwnd).as_bool() && !IsIconic(self.hwnd).as_bool() {
                // Cloaking hides it instantly without changing focus or the taskbar.
                window::dwm_set(self.hwnd, window::DWMWA_CLOAK, 1i32);
                self.main_hidden = true;
                hidden = true;
            }
        }
        if hidden {
            capture::flush_compositor();
        }
    }

    fn show_own_windows(&mut self) {
        quick::set_visible(true);
        if self.main_hidden {
            window::dwm_set(self.hwnd, window::DWMWA_CLOAK, 0i32);
            self.main_hidden = false;
        }
    }

    fn start_overlay(&mut self, mode: Mode, purpose: Purpose) {
        if self.overlay_open {
            return;
        }
        self.hide_own_windows();
        match capture::snapshot() {
            Ok(snap) => {
                if overlay::open(snap, mode, purpose).is_some() {
                    self.overlay_open = true;
                } else {
                    self.show_own_windows();
                }
            }
            Err(_) => {
                self.show_own_windows();
                hud::show(t("No se pudo capturar la pantalla"));
            }
        }
    }

    fn capture_fullscreen(&mut self) {
        if self.overlay_open {
            return;
        }
        let cfg = config::get();
        let (cx, cy) = util::cursor_pos();
        let mon = capture::monitor_at(cx, cy);
        let r = if cfg.fullscreen_all_displays { capture::virtual_rect() } else { mon.rect };
        self.hide_own_windows();
        match capture::grab(r) {
            Ok(img) => {
                self.show_own_windows();
                self.deliver(img, mon);
            }
            Err(_) => {
                self.show_own_windows();
                hud::show(t("No se pudo capturar la pantalla"));
            }
        }
    }

    fn capture_rect(&mut self, r: Rect) {
        let Some(r) = r.intersect(&capture::virtual_rect()) else {
            self.start_overlay(Mode::Area, Purpose::Capture);
            return;
        };
        self.hide_own_windows();
        let (cx, cy) = r.center();
        let mon = capture::monitor_at(cx, cy);
        match capture::grab(r) {
            Ok(img) => {
                self.show_own_windows();
                self.deliver(img, mon);
            }
            Err(_) => {
                self.show_own_windows();
                hud::show(t("No se pudo capturar la pantalla"));
            }
        }
    }

    /// Everything that happens after pixels are captured.
    fn deliver(&mut self, img: Image, mon: Monitor) {
        let cfg = config::get();
        if cfg.sound {
            sound::capture();
        }
        if cfg.copy_to_clipboard {
            copy_image(&img);
        }
        let path = cfg.auto_save.then(|| next_capture_path(&cfg));
        if let Some(p) = &path {
            save_async(img.clone(), p.clone());
        }
        self.last = Some((img.clone(), path.clone()));
        self.home.set_last(&img);
        self.repaint();
        if cfg.quick_access {
            quick::show(img, path, mon);
        } else {
            let msg = match (cfg.copy_to_clipboard, cfg.auto_save) {
                (true, true) => t("Captura copiada y guardada"),
                (true, false) => t("Captura copiada"),
                (false, true) => t("Captura guardada"),
                _ => t("Captura lista"),
            };
            hud::show(msg);
        }
    }

    fn on_event(&mut self, ev: AppEvent) {
        match ev {
            AppEvent::OverlayDone(res) => {
                self.overlay_open = false;
                self.show_own_windows();
                let Some(res) = res else { return };
                match res.purpose {
                    Purpose::Capture => {
                        self.last_area = Some(res.rect);
                        self.deliver(res.image, res.monitor);
                    }
                    Purpose::Text => {
                        hud::show(t("Reconociendo texto…"));
                        let img = res.image;
                        std::thread::spawn(move || {
                            unsafe {
                                let _ = windows::Win32::System::Com::CoInitializeEx(
                                    None,
                                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                                );
                            }
                            post(AppEvent::OcrDone(ocr::recognize(&img)));
                        });
                    }
                }
            }
            AppEvent::CopyText(text, msg) => {
                if clipboard::set_text(self.hwnd, &text) {
                    hud::show(&msg);
                }
            }
            AppEvent::Hud(msg) => hud::show(&msg),
            AppEvent::Saved(res) => match res {
                Ok(p) => quick::mark_saved(&p),
                Err(e) => hud::show(&tf("No se pudo guardar: {}", &[&e])),
            },
            AppEvent::OcrDone(res) => match res {
                Ok(text) if !text.trim().is_empty() => {
                    clipboard::set_text(self.hwnd, &text);
                    let n = text.chars().filter(|c| !c.is_whitespace()).count();
                    hud::show(&tf("Texto copiado  ·  {} caracteres", &[&n]));
                }
                Ok(_) => hud::show(t("No se encontró texto en la selección")),
                Err(e) => hud::show(&tf("OCR no disponible: {}", &[&e])),
            },
            AppEvent::Run(a) => self.act(a),
            AppEvent::Command(id) => self.on_command(id),
            AppEvent::UpdateReady(found) => {
                self.update_checking = false;
                if let Some(found) = found {
                    self.pending_update = Some(found);
                    self.try_apply_update();
                }
            }
            AppEvent::IpCountry(code) => {
                i18n::set_ip_country(code);
                i18n::apply(&config::get().language);
                self.repaint();
            }
            AppEvent::Last(img, path) => {
                self.home.set_last(&img);
                self.last = Some((img, path));
                self.repaint();
            }
        }
    }

    /// Opens the options panel under the Options button.
    fn show_options(&self) {
        let Some(r) = self.home.rect(HomeBtn::Options) else { return };
        let mut tl = POINT { x: r.x as i32, y: r.y as i32 };
        let mut br = POINT { x: r.right() as i32, y: r.bottom() as i32 };
        unsafe {
            let _ = ClientToScreen(self.hwnd, &mut tl);
            let _ = ClientToScreen(self.hwnd, &mut br);
        }
        crate::options::open(self.hwnd, Rect::from_ltrb(tl.x, tl.y, br.x, br.y));
    }

    fn on_command(&mut self, id: usize) {
        match id {
            0 => {}
            1 => self.act(Action::Area),
            2 => self.act(Action::Window),
            3 => self.act(Action::Fullscreen),
            4 => self.act(Action::Previous),
            5 => self.act(Action::Text),
            10 => self.act(Action::OpenImage),
            11 => self.act(Action::OpenFolder),
            12 => {
                let cfg = config::get();
                if let Some(p) = shell::pick_folder(None, &PathBuf::from(&cfg.save_dir)) {
                    config::update(|c| c.save_dir = p.to_string_lossy().into_owned());
                    hud::show(t("Carpeta de capturas actualizada"));
                }
            }
            20 => config::update(|c| c.copy_to_clipboard = !c.copy_to_clipboard),
            21 => config::update(|c| c.auto_save = !c.auto_save),
            22 => config::update(|c| c.quick_access = !c.quick_access),
            23 => config::update(|c| c.sound = !c.sound),
            24 => config::update(|c| c.magnifier = !c.magnifier),
            25 => shell::set_autostart(!shell::autostart_enabled()),
            26 => config::update(|c| c.format = "png".into()),
            27 => config::update(|c| c.format = "jpg".into()),
            28 => config::update(|c| c.fullscreen_all_displays = !c.fullscreen_all_displays),
            29 => config::update(|c| c.crosshair = !c.crosshair),
            31 => {
                config::update(|c| c.auto_update = !c.auto_update);
                self.check_for_update();
            }
            30 => shell::open_in_notepad(&config::path()),
            50..=55 => {
                let code = if id == 50 { "auto" } else { i18n::LANGS[id - 51].0 };
                config::update(|c| c.language = code.into());
                i18n::apply(code);
            }
            40 => {
                if let Some((img, path)) = self.last.clone() {
                    editor::open(img, path);
                }
            }
            41 => {
                if let Some((img, _)) = self.last.clone() {
                    pin::open(img, None);
                }
            }
            99 => self.act(Action::Quit),
            _ => {}
        }
        // Remember the file's new timestamp so our own writes don't count as edits.
        let _ = config::reload_if_changed(&mut self.config_mtime);
        self.repaint();
    }
}

impl Handler for App {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        match msg {
            m if m == WM_APP_EVENT + 10 => {
                self.init(hwnd);
                Some(LRESULT(0))
            }
            WM_APP_EVENT => {
                loop {
                    let ev = QUEUE.lock().unwrap().pop_front();
                    match ev {
                        Some(ev) => self.on_event(ev),
                        None => break,
                    }
                }
                Some(LRESULT(0))
            }
            WM_DISPLAYCHANGE => {
                // Monitors or resolution changed: rebuild duplication for the new layout.
                crate::dxgi::reset();
                crate::dxgi::warm_up();
                None
            }
            WM_HOTKEY => {
                let a = match wp.0 {
                    1 => Action::Area,
                    2 => Action::Window,
                    3 => Action::Fullscreen,
                    4 => Action::Previous,
                    5 => Action::Text,
                    _ => return Some(LRESULT(0)),
                };
                self.act(a);
                Some(LRESULT(0))
            }
            WM_ERASEBKGND => Some(LRESULT(1)),
            WM_PAINT => {
                self.home.render(hwnd, &config::get());
                unsafe {
                    let _ = ValidateRect(Some(hwnd), None);
                }
                Some(LRESULT(0))
            }
            WM_SIZE => {
                let (w, h) = (util::loword(lp.0 as usize) as i32, util::hiword(lp.0 as usize) as i32);
                if w > 0 && h > 0 {
                    self.home.resize(w, h);
                    self.repaint();
                }
                Some(LRESULT(0))
            }
            WM_DPICHANGED => {
                self.home.k = util::loword(wp.0) as f32 / 96.0;
                let r = unsafe { &*(lp.0 as *const RECT) };
                unsafe {
                    let _ = SetWindowPos(hwnd, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
                }
                self.repaint();
                Some(LRESULT(0))
            }
            WM_SETCURSOR if util::loword(lp.0 as usize) == 1 => {
                unsafe {
                    SetCursor(LoadCursorW(None, if self.home.is_hot() { IDC_HAND } else { IDC_ARROW }).ok());
                }
                Some(LRESULT(1))
            }
            WM_MOUSEMOVE => {
                let (x, y) = util::lparam_xy(lp);
                if self.home.mouse_move(hwnd, x, y) {
                    self.repaint();
                }
                Some(LRESULT(0))
            }
            WM_MOUSELEAVE => {
                if self.home.mouse_leave() {
                    self.repaint();
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONUP => {
                let (x, y) = util::lparam_xy(lp);
                if let Some(b) = self.home.hit(x, y) {
                    self.press(b);
                }
                Some(LRESULT(0))
            }
            WM_CLOSE => {
                // Unsaved annotations get a chance to be saved before quitting.
                if self.close_editors() {
                    None
                } else {
                    Some(LRESULT(0))
                }
            }
            WM_TIMER if wp.0 == TIMER_UPDATE_FIRST || wp.0 == TIMER_UPDATE => {
                if wp.0 == TIMER_UPDATE_FIRST {
                    unsafe {
                        let _ = KillTimer(Some(hwnd), TIMER_UPDATE_FIRST);
                    }
                }
                self.check_for_update();
                Some(LRESULT(0))
            }
            WM_TIMER if wp.0 == TIMER_APPLY => {
                self.try_apply_update();
                Some(LRESULT(0))
            }
            WM_TIMER if wp.0 == TIMER_CONFIG => {
                // Keeps "Hace 3 min" under the viewfinder current.
                if self.home.has_last() {
                    self.repaint();
                }
                if config::reload_if_changed(&mut self.config_mtime) {
                    i18n::apply(&config::get().language);
                    self.repaint();
                    self.register_hotkeys();
                    if self.failed_hotkeys.is_empty() {
                        hud::show(t("Ajustes recargados"));
                    } else {
                        hud::show(&tf("Atajo en uso por otra app: {}", &[&self.failed_hotkeys.join(", ")]));
                    }
                }
                Some(LRESULT(0))
            }
            WM_COPYDATA => {
                let cds = unsafe { &*(lp.0 as *const COPYDATASTRUCT) };
                if !cds.lpData.is_null() && cds.cbData > 0 {
                    let bytes = unsafe { std::slice::from_raw_parts(cds.lpData as *const u8, cds.cbData as usize) };
                    match std::str::from_utf8(bytes).ok().and_then(Action::from_arg) {
                        Some(a) => post(AppEvent::Run(a)),
                        // Opened again: show the window that is already running.
                        None => self.show_main(),
                    }
                }
                Some(LRESULT(1))
            }
            WM_DESTROY => {
                unsafe {
                    let _ = KillTimer(Some(hwnd), TIMER_CONFIG);
                    for id in 1..=5 {
                        let _ = UnregisterHotKey(Some(hwnd), id);
                    }
                    PostQuitMessage(0);
                }
                Some(LRESULT(0))
            }
            _ => None,
        }
    }
}

const IP_CACHE_HOURS: u64 = 6;

fn ip_cache_path() -> PathBuf {
    config::app_dir().join("ip-country.txt")
}

/// (country code, saved at ms) if saved within the last 6 hours, like ComesADE.
fn cached_ip_country() -> Option<(String, u64)> {
    let text = std::fs::read_to_string(ip_cache_path()).ok()?;
    let mut lines = text.lines();
    let code = lines.next()?.trim().to_string();
    let at: u64 = lines.next()?.trim().parse().ok()?;
    let fresh = util::now_ms().saturating_sub(at) < IP_CACHE_HOURS * 3600 * 1000;
    (fresh && code.len() == 2).then_some((code, at))
}

/// Looks up the public IP's country in the background (automatic language
/// uses device + IP, the same as ComesADE). Skipped while the cache is fresh.
fn detect_ip_country() {
    if cached_ip_country().is_some() {
        return;
    }
    std::thread::spawn(|| {
        let found = crate::net::ip_country().map(|(code, _name)| code);
        if let Some(code) = &found {
            let _ = std::fs::create_dir_all(config::app_dir());
            let _ = std::fs::write(ip_cache_path(), format!("{code}\n{}\n", util::now_ms()));
        }
        post(AppEvent::IpCountry(found));
    });
}

/// Lets Win32 popup menus follow the system dark theme (uxtheme ordinal 135).
fn allow_dark_menus() {
    unsafe {
        let Ok(lib) = LoadLibraryW(WStr::new("uxtheme.dll").p()) else { return };
        if let Some(f) = GetProcAddress(lib, PCSTR(135 as *const u8)) {
            let set_mode: extern "system" fn(i32) -> i32 = std::mem::transmute(f);
            set_mode(1); // AllowDark
        }
        if let Some(f) = GetProcAddress(lib, PCSTR(136 as *const u8)) {
            let flush: extern "system" fn() = std::mem::transmute(f);
            flush();
        }
    }
}

