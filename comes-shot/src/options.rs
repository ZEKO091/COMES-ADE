//! Options panel: opens under the "Opciones" button. Every setting is visible
//! at once with its current state (switches, segmented choices) instead of
//! hiding behind submenus. Changes apply immediately.

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct2D::{
    ID2D1HwndRenderTarget, ID2D1RenderTarget, D2D1_PRESENT_OPTIONS_NONE, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE,
};
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::UI::Input::KeyboardAndMouse::{SetFocus, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT, VK_ESCAPE};
use windows::Win32::UI::WindowsAndMessaging::{
    LoadCursorW, SetCursor, SetForegroundWindow, ShowWindow, IDC_ARROW, IDC_HAND, SW_SHOW, WA_INACTIVE,
    WM_ACTIVATE, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_PAINT, WM_SETCURSOR, WS_EX_TOOLWINDOW,
    WS_POPUP,
};

use crate::app::{self, AppEvent};
use crate::config::{self, Config};
use crate::gfx::{self, brush, col, rf, rounded, rxywh, v2};
use crate::i18n::{self, t};
use crate::ui::R;
use crate::util::{self, lparam_xy, Rect};
use crate::window::{self, Handler};
use crate::{capture, shell};

const WM_MOUSELEAVE: u32 = 0x02A3;
const WIDTH: f32 = 312.0;

const PANEL: u32 = 0x1C1F24;
const HOVER: u32 = 0x262A31;
const LINE: u32 = 0x2E323A;
const INK: u32 = 0xE9ECF1;
const MUTED: u32 = 0x8A92A0;
const BLUE: u32 = 0x1A7DFF;
const OFF: u32 = 0x3A3F48;
const FONT: &str = "Segoe UI Variable Text";

/// Command ids understood by the app (`AppEvent::Command`).
pub mod cmd {
    pub const PICK_FOLDER: usize = 12;
    pub const COPY: usize = 20;
    pub const SAVE: usize = 21;
    pub const QUICK: usize = 22;
    pub const SOUND: usize = 23;
    pub const MAGNIFIER: usize = 24;
    pub const AUTOSTART: usize = 25;
    pub const PNG: usize = 26;
    pub const JPG: usize = 27;
    pub const ALL_DISPLAYS: usize = 28;
    pub const CROSSHAIR: usize = 29;
    pub const EDIT_CONFIG: usize = 30;
    pub const AUTO_UPDATE: usize = 31;
    /// 50 = automatic, 51.. = i18n::LANGS order.
    pub const LANG_AUTO: usize = 50;
}

enum Item {
    Section(&'static str),
    Toggle(usize, &'static str, bool),
    /// PNG / JPG.
    Format(bool),
    Languages,
    Link(usize, &'static str),
    Divider,
    Version,
}

struct Options {
    k: f32,
    size: (i32, i32),
    rt: Option<ID2D1HwndRenderTarget>,
    autostart: bool,
    hot: Option<usize>,
    tracking: bool,
    closing: bool,
}

fn items(cfg: &Config, autostart: bool) -> Vec<Item> {
    use cmd::*;
    vec![
        Item::Section(t("Después de capturar")),
        Item::Toggle(COPY, t("Copiar al portapapeles"), cfg.copy_to_clipboard),
        Item::Toggle(SAVE, t("Guardar automáticamente"), cfg.auto_save),
        Item::Toggle(QUICK, t("Mostrar vista rápida"), cfg.quick_access),
        Item::Toggle(SOUND, t("Sonido al capturar (Chimes)"), cfg.sound),
        Item::Divider,
        Item::Section(t("Captura")),
        Item::Toggle(MAGNIFIER, t("Lupa de píxeles"), cfg.magnifier),
        Item::Toggle(CROSSHAIR, t("Guías en cruz"), cfg.crosshair),
        Item::Toggle(ALL_DISPLAYS, t("Pantalla completa: todos los monitores"), cfg.fullscreen_all_displays),
        Item::Format(cfg.extension() == "png"),
        Item::Divider,
        Item::Section(t("Idioma")),
        Item::Languages,
        Item::Divider,
        Item::Toggle(AUTOSTART, t("Iniciar con Windows"), autostart),
        Item::Toggle(AUTO_UPDATE, t("Actualizar automáticamente"), cfg.auto_update),
        Item::Link(PICK_FOLDER, t("Cambiar carpeta de capturas…")),
        Item::Link(EDIT_CONFIG, t("Editar atajos y ajustes…")),
        Item::Version,
    ]
}

fn item_height(it: &Item) -> f32 {
    match it {
        Item::Section(_) => 30.0,
        Item::Toggle(..) | Item::Link(..) => 36.0,
        Item::Format(_) => 40.0,
        Item::Languages => 82.0,
        Item::Divider => 13.0,
        Item::Version => 34.0,
    }
}

fn content_height() -> f32 {
    let cfg = config::get();
    8.0 + items(&cfg, false).iter().map(item_height).sum::<f32>() + 4.0
}

/// Opens the panel under `anchor` (screen rect of the Options button).
pub fn open(owner: HWND, anchor: Rect) {
    let mon = capture::monitor_at(anchor.x, anchor.y);
    let k = mon.scale();
    let (w, h) = ((WIDTH * k).round() as i32, (content_height() * k).round() as i32);
    // Right-aligned with the button, below it, or above if there is no room.
    let mut x = anchor.right() - w;
    let mut y = anchor.bottom() + (6.0 * k) as i32;
    if y + h > mon.work.bottom() {
        y = anchor.y - h - (6.0 * k) as i32;
    }
    x = x.clamp(mon.work.x + 4, (mon.work.right() - w - 4).max(mon.work.x));
    y = y.clamp(mon.work.y + 4, (mon.work.bottom() - h - 4).max(mon.work.y));
    let panel = Options { k, size: (w, h), rt: None, autostart: shell::autostart_enabled(), hot: None, tracking: false, closing: false };
    let Ok(hwnd) = window::create_owned("ComesShot.Options", "Comes Shot", WS_POPUP, WS_EX_TOOLWINDOW, Rect::new(x, y, w, h), true, Some(owner), Box::new(panel)) else {
        return;
    };
    window::round_corners(hwnd, false);
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
    }
}

/// Clickable targets: (command id, rect).
fn targets(cfg: &Config, autostart: bool, k: f32, w: f32) -> Vec<(usize, R)> {
    let mut v = Vec::new();
    let mut y = 8.0 * k;
    let pad = 8.0 * k;
    for it in items(cfg, autostart) {
        let h = item_height(&it) * k;
        match it {
            Item::Toggle(id, ..) | Item::Link(id, _) => v.push((id, R::new(pad, y, w - pad * 2.0, h))),
            Item::Format(_) => {
                let (seg, _) = format_segments(k, w, y);
                v.push((cmd::PNG, seg[0]));
                v.push((cmd::JPG, seg[1]));
            }
            Item::Languages => {
                for (i, r) in language_chips(k, w, y).into_iter().enumerate() {
                    v.push((cmd::LANG_AUTO + i, r));
                }
            }
            _ => {}
        }
        y += h;
    }
    v
}

fn format_segments(k: f32, w: f32, y: f32) -> ([R; 2], R) {
    let sw = 58.0 * k;
    let sh = 28.0 * k;
    let x = w - 16.0 * k - sw * 2.0;
    let yy = y + (40.0 * k - sh) / 2.0;
    let outer = R::new(x, yy, sw * 2.0, sh);
    ([R::new(x, yy, sw, sh), R::new(x + sw, yy, sw, sh)], outer)
}

fn language_chips(k: f32, w: f32, y: f32) -> Vec<R> {
    let n = i18n::LANGS.len() + 1;
    let pad = 16.0 * k;
    let gap = 4.0 * k;
    let cw = (w - pad * 2.0 - gap * (n as f32 - 1.0)) / n as f32;
    let ch = 30.0 * k;
    (0..n).map(|i| R::new(pad + i as f32 * (cw + gap), y + 4.0 * k, cw, ch)).collect()
}

impl Options {
    fn render(&mut self, hwnd: HWND) {
        if self.rt.is_none() {
            self.rt = gfx::hwnd_target(hwnd, self.size.0 as u32, self.size.1 as u32, D2D1_PRESENT_OPTIONS_NONE).ok();
        }
        let Some(hrt) = self.rt.clone() else { return };
        let rt: ID2D1RenderTarget = hrt.into();
        unsafe {
            rt.BeginDraw();
            self.paint(&rt, &config::get());
            if rt.EndDraw(None, None).is_err() {
                self.rt = None;
            }
        }
    }

    unsafe fn paint(&self, rt: &ID2D1RenderTarget, cfg: &Config) {
        let k = self.k;
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        rt.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        rt.Clear(Some(&col(PANEL, 1.0)));
        rt.DrawRectangle(&rf(0.5, 0.5, w - 0.5, h - 0.5), &brush(rt, 0xFFFFFF, 0.08), 1.0, None);
        let ink = brush(rt, INK, 1.0);
        let muted = brush(rt, MUTED, 1.0);
        let label_f = gfx::text_format(FONT, 13.5 * k, gfx::W_REGULAR, 2);
        let pad = 8.0 * k;
        let tx = 16.0 * k;
        let mut y = 8.0 * k;
        for it in items(cfg, self.autostart) {
            let ih = item_height(&it) * k;
            let row = R::new(pad, y, w - pad * 2.0, ih);
            match it {
                Item::Section(s) => {
                    let f = gfx::text_format(FONT, 12.0 * k, gfx::W_SEMIBOLD, 2);
                    gfx::draw_text(rt, s, &f, rxywh(tx, y + 6.0 * k, w - tx * 2.0, ih - 6.0 * k), &muted);
                }
                Item::Toggle(id, label, on) => {
                    if self.hot == Some(id) {
                        rt.FillRoundedRectangle(&rounded(row.d2d(), 6.0 * k), &brush(rt, HOVER, 1.0));
                    }
                    let sw = 34.0 * k;
                    gfx::draw_text(rt, label, &label_f, rxywh(tx, y, w - tx * 2.0 - sw - 8.0 * k, ih), &ink);
                    // Switch.
                    let sh = 20.0 * k;
                    let sx = w - tx - sw;
                    let sy = y + (ih - sh) / 2.0;
                    let track = rounded(rxywh(sx, sy, sw, sh), sh / 2.0);
                    rt.FillRoundedRectangle(&track, &brush(rt, if on { BLUE } else { OFF }, 1.0));
                    let kr = sh / 2.0 - 3.0 * k;
                    let kx = if on { sx + sw - sh / 2.0 } else { sx + sh / 2.0 };
                    rt.FillEllipse(&gfx::ellipse(kx, sy + sh / 2.0, kr, kr), &brush(rt, 0xFFFFFF, if on { 1.0 } else { 0.85 }));
                }
                Item::Format(png) => {
                    gfx::draw_text(rt, t("Formato"), &label_f, rxywh(tx, y, w / 2.0, ih), &ink);
                    let (seg, outer) = format_segments(k, w, y);
                    rt.FillRoundedRectangle(&rounded(outer.d2d(), 7.0 * k), &brush(rt, 0x14161A, 1.0));
                    for (i, r) in seg.iter().enumerate() {
                        let active = (i == 0) == png;
                        let id = if i == 0 { cmd::PNG } else { cmd::JPG };
                        if active {
                            rt.FillRoundedRectangle(&rounded(r.inset(2.0 * k).d2d(), 5.0 * k), &brush(rt, BLUE, 1.0));
                        } else if self.hot == Some(id) {
                            rt.FillRoundedRectangle(&rounded(r.inset(2.0 * k).d2d(), 5.0 * k), &brush(rt, HOVER, 1.0));
                        }
                        let f = gfx::text_format(FONT, 12.5 * k, gfx::W_SEMIBOLD, 1);
                        gfx::draw_text(rt, if i == 0 { "PNG" } else { "JPG" }, &f, r.d2d(), if active { &ink } else { &muted });
                    }
                }
                Item::Languages => {
                    let chips = language_chips(k, w, y);
                    let f = gfx::text_format(FONT, 12.5 * k, gfx::W_SEMIBOLD, 1);
                    for (i, r) in chips.iter().enumerate() {
                        let (label, active) = if i == 0 {
                            ("Auto", cfg.language == "auto")
                        } else {
                            let (code, _) = i18n::LANGS[i - 1];
                            (code, cfg.language == code)
                        };
                        let id = cmd::LANG_AUTO + i;
                        let rr = rounded(r.d2d(), 6.0 * k);
                        if active {
                            rt.FillRoundedRectangle(&rr, &brush(rt, BLUE, 1.0));
                        } else {
                            rt.FillRoundedRectangle(&rr, &brush(rt, if self.hot == Some(id) { HOVER } else { 0x14161A }, 1.0));
                        }
                        let text = if i == 0 { label.to_string() } else { label.to_uppercase() };
                        gfx::draw_text(rt, &text, &f, r.d2d(), if active { &ink } else { &muted });
                    }
                    // How the language was chosen, worded like ComesADE.
                    let hint = if cfg.language == "auto" {
                        let device = i18n::device().map(i18n::lang_name).unwrap_or(t("Desconocido"));
                        let ip = i18n::ip_country().unwrap_or_else(|| t("Desconocido").to_string());
                        i18n::tf("Dispositivo: {} · IP: {} → {}", &[&device, &ip, &i18n::lang_name(i18n::current())])
                    } else {
                        t("Idioma manual. El dispositivo y la IP se ignoran hasta que elijas Automático.").to_string()
                    };
                    let hf = gfx::text_format(FONT, 11.5 * k, gfx::W_REGULAR, 4);
                    gfx::draw_text(rt, &hint, &hf, rxywh(tx, y + 42.0 * k, w - tx * 2.0, 38.0 * k), &muted);
                }
                Item::Link(id, label) => {
                    if self.hot == Some(id) {
                        rt.FillRoundedRectangle(&rounded(row.d2d(), 6.0 * k), &brush(rt, HOVER, 1.0));
                    }
                    gfx::draw_text(rt, label, &label_f, rxywh(tx, y, w - tx * 2.0, ih), &ink);
                }
                Item::Divider => {
                    let yy = (y + ih / 2.0).round() + 0.5;
                    rt.DrawLine(v2(tx, yy), v2(w - tx, yy), &brush(rt, LINE, 1.0), 1.0, None);
                }
                Item::Version => {
                    let f = gfx::text_format(FONT, 11.5 * k, gfx::W_REGULAR, 2);
                    gfx::draw_text(rt, &format!("Comes Shot {}", env!("CARGO_PKG_VERSION")), &f, rxywh(tx, y, w - tx * 2.0, ih), &muted);
                }
            }
            y += ih;
        }
    }

    fn hit(&self, x: i32, y: i32) -> Option<usize> {
        let cfg = config::get();
        targets(&cfg, self.autostart, self.k, self.size.0 as f32)
            .into_iter()
            .find(|(_, r)| r.contains(x as f32, y as f32))
            .map(|(id, _)| id)
    }

    fn close(&mut self, hwnd: HWND) {
        if !self.closing {
            self.closing = true;
            util::post_close(hwnd);
        }
    }
}

impl Handler for Options {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_ERASEBKGND => Some(LRESULT(1)),
            WM_PAINT => {
                self.render(hwnd);
                unsafe {
                    let _ = ValidateRect(Some(hwnd), None);
                }
                Some(LRESULT(0))
            }
            WM_SETCURSOR => {
                unsafe {
                    SetCursor(LoadCursorW(None, if self.hot.is_some() { IDC_HAND } else { IDC_ARROW }).ok());
                }
                Some(LRESULT(1))
            }
            WM_MOUSEMOVE => {
                if !self.tracking {
                    let mut tme = TRACKMOUSEEVENT { cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE, hwndTrack: hwnd, dwHoverTime: 0 };
                    unsafe {
                        let _ = TrackMouseEvent(&mut tme);
                    }
                    self.tracking = true;
                }
                let (x, y) = lparam_xy(lp);
                let hot = self.hit(x, y);
                if hot != self.hot {
                    self.hot = hot;
                    unsafe {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                Some(LRESULT(0))
            }
            WM_MOUSELEAVE => {
                self.tracking = false;
                if self.hot.take().is_some() {
                    unsafe {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONUP => {
                let (x, y) = lparam_xy(lp);
                if let Some(id) = self.hit(x, y) {
                    match id {
                        // These open other windows: close the panel first.
                        cmd::PICK_FOLDER | cmd::EDIT_CONFIG => {
                            self.close(hwnd);
                            app::post(AppEvent::Command(id));
                        }
                        cmd::AUTOSTART => {
                            self.autostart = !self.autostart;
                            app::post(AppEvent::Command(id));
                        }
                        _ => app::post(AppEvent::Command(id)),
                    }
                    // Repaints after the app applied the change (paint has lowest priority).
                    unsafe {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                Some(LRESULT(0))
            }
            WM_KEYDOWN if wp.0 as u16 == VK_ESCAPE.0 => {
                self.close(hwnd);
                Some(LRESULT(0))
            }
            WM_ACTIVATE => {
                if util::loword(wp.0) == WA_INACTIVE {
                    self.close(hwnd);
                }
                None
            }
            _ => None,
        }
    }
}

/// Renders the panel offscreen (`--preview`).
pub fn preview(k: f32, hot: Option<usize>) -> Option<crate::image::Image> {
    let (w, h) = ((WIDTH * k).round() as i32, (content_height() * k).round() as i32);
    let mut p = Options { k, size: (w, h), rt: None, autostart: false, hot, tracking: false, closing: false };
    p.rt = None;
    let (bmp, rt) = gfx::wic_target(w as u32, h as u32).ok()?;
    unsafe {
        rt.BeginDraw();
        p.paint(&rt, &Config::default());
        rt.EndDraw(None, None).ok()?;
    }
    gfx::wic_bitmap_to_image(&bmp).ok()
}
