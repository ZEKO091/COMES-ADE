//! Main window: a camera viewfinder holding your last capture, next to the
//! capture modes with their keys drawn as real keycaps. Closing it quits.

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct2D::Common::D2D_SIZE_U;
use windows::Win32::Graphics::Direct2D::{
    ID2D1Bitmap, ID2D1HwndRenderTarget, ID2D1RenderTarget, ID2D1SolidColorBrush,
    D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, D2D1_PRESENT_OPTIONS_NONE, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE,
};
use windows::Win32::Graphics::DirectWrite::IDWriteTextFormat;
use windows::Win32::UI::Input::KeyboardAndMouse::{TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};

use crate::config::Config;
use crate::gfx::{self, brush, col, rf, rounded, rxywh, v2};
use crate::i18n::{t, tf};
use crate::icons;
use crate::image::Image;
use crate::ui::R;

/// Client size in logical pixels (scaled by the monitor DPI).
pub const SIZE: (f32, f32) = (640.0, 372.0);

// Palette: graphite surfaces, ComesADE blue as the only active colour.
const GRAPHITE: u32 = 0x17191D;
const WELL: u32 = 0x101215;
const SURFACE: u32 = 0x1F2228;
const LINE: u32 = 0x2E323A;
const INK: u32 = 0xE9ECF1;
const MUTED: u32 = 0x8A92A0;
const BLUE: u32 = 0x1A7DFF;
const BLUE_BRIGHT: u32 = 0x4C9BFF;
const KEYCAP: u32 = 0x2A2E36;
const KEYCAP_LIP: u32 = 0x0E1013;
const BLUE_LIP: u32 = 0x0C4DB0;

const TEXT_FONT: &str = "Segoe UI Variable Text";
const DISPLAY_FONT: &str = "Segoe UI Variable Display";

/// The frame colour behind the title bar, so it blends into the window.
pub const FRAME: u32 = GRAPHITE;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HomeBtn {
    Area,
    Window,
    Fullscreen,
    Text,
    Previous,
    Open,
    Folder,
    Options,
    /// Click the viewfinder: annotate the last capture.
    Viewfinder,
    Annotate,
    Copy,
    Pin,
}

struct Last {
    image: Image,
    at_ms: u64,
    /// Thumbnail at the size it was last drawn, plus its GPU bitmap.
    thumb: Option<(u32, u32, Image)>,
    bmp: Option<ID2D1Bitmap>,
}

pub struct Home {
    rt: Option<ID2D1HwndRenderTarget>,
    pub k: f32,
    pub client: (i32, i32),
    hot: Option<HomeBtn>,
    tracking: bool,
    last: Option<Last>,
}

fn fmt(family: &str, size: f32, weight: i32) -> IDWriteTextFormat {
    gfx::text_format(family, size, weight, 2)
}

fn fmt_center(family: &str, size: f32, weight: i32) -> IDWriteTextFormat {
    gfx::text_format(family, size, weight, 1)
}

impl Home {
    pub fn new(k: f32) -> Self {
        Self { rt: None, k, client: ((SIZE.0 * k) as i32, (SIZE.1 * k) as i32), hot: None, tracking: false, last: None }
    }

    /// Shows a new capture in the viewfinder.
    pub fn set_last(&mut self, image: &Image) {
        self.last = Some(Last { image: image.clone(), at_ms: crate::util::now_ms(), thumb: None, bmp: None });
    }

    pub fn has_last(&self) -> bool {
        self.last.is_some()
    }

    fn viewfinder(&self) -> R {
        let k = self.k;
        R::new(20.0 * k, 20.0 * k, 352.0 * k, 248.0 * k)
    }

    fn footer_top(&self) -> f32 {
        self.client.1 as f32 - 56.0 * self.k
    }

    pub fn layout(&self) -> Vec<(HomeBtn, R)> {
        let k = self.k;
        let w = self.client.0 as f32;
        let mut v = Vec::new();
        let vf = self.viewfinder();
        v.push((HomeBtn::Viewfinder, vf));

        // Actions under the viewfinder for the last capture.
        if self.last.is_some() {
            let y = vf.bottom() + 8.0 * k;
            let mut x = vf.right();
            for (b, label) in [(HomeBtn::Pin, t("Fijar")), (HomeBtn::Copy, t("Copiar")), (HomeBtn::Annotate, t("Anotar"))] {
                let (tw, _) = gfx::measure(label, &fmt(TEXT_FONT, 12.5 * k, gfx::W_MEDIUM));
                let bw = tw + 16.0 * k;
                x -= bw;
                v.push((b, R::new(x, y, bw, 26.0 * k)));
                x -= 2.0 * k;
            }
        }

        // Capture modes.
        let lx = vf.right() + 20.0 * k;
        let lw = w - lx - 20.0 * k;
        let rh = 40.0 * k;
        let mut y = vf.y;
        for b in [HomeBtn::Area, HomeBtn::Window, HomeBtn::Fullscreen, HomeBtn::Text, HomeBtn::Previous] {
            v.push((b, R::new(lx, y, lw, rh)));
            y += rh;
        }
        v.push((HomeBtn::Open, R::new(lx, y + 9.0 * k, lw, rh)));

        // Footer buttons, right aligned.
        let ft = self.footer_top();
        let bh = 32.0 * k;
        let by = ft + (56.0 * k - bh) / 2.0;
        let mut x = w - 20.0 * k;
        for (b, label) in [(HomeBtn::Options, t("Opciones")), (HomeBtn::Folder, t("Abrir carpeta"))] {
            let (tw, _) = gfx::measure(label, &fmt(TEXT_FONT, 13.0 * k, gfx::W_MEDIUM));
            let bw = tw + 26.0 * k + if b == HomeBtn::Options { 20.0 * k } else { 0.0 };
            x -= bw;
            v.push((b, R::new(x, by, bw, bh)));
            x -= 8.0 * k;
        }
        v
    }

    pub fn rect(&self, b: HomeBtn) -> Option<R> {
        self.layout().into_iter().find(|(x, _)| *x == b).map(|(_, r)| r)
    }

    pub fn hit(&self, x: i32, y: i32) -> Option<HomeBtn> {
        self.layout()
            .into_iter()
            .find(|(b, r)| r.contains(x as f32, y as f32) && (*b != HomeBtn::Viewfinder || self.last.is_some()))
            .map(|(b, _)| b)
    }

    pub fn is_hot(&self) -> bool {
        self.hot.is_some()
    }

    pub fn resize(&mut self, w: i32, h: i32) {
        self.client = (w.max(1), h.max(1));
        if let Some(rt) = &self.rt {
            unsafe {
                let _ = rt.Resize(&D2D_SIZE_U { width: w.max(1) as u32, height: h.max(1) as u32 });
            }
        }
    }

    /// Returns true when the hovered control changed (needs a repaint).
    pub fn mouse_move(&mut self, hwnd: HWND, x: i32, y: i32) -> bool {
        if !self.tracking {
            let mut tme = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE,
                hwndTrack: hwnd,
                dwHoverTime: 0,
            };
            unsafe {
                let _ = TrackMouseEvent(&mut tme);
            }
            self.tracking = true;
        }
        let hot = self.hit(x, y);
        let changed = hot != self.hot;
        self.hot = hot;
        changed
    }

    pub fn mouse_leave(&mut self) -> bool {
        self.tracking = false;
        let changed = self.hot.is_some();
        self.hot = None;
        changed
    }

    pub fn render(&mut self, hwnd: HWND, cfg: &Config) {
        if self.rt.is_none() {
            self.rt = gfx::hwnd_target(hwnd, self.client.0 as u32, self.client.1 as u32, D2D1_PRESENT_OPTIONS_NONE).ok();
            if let Some(l) = &mut self.last {
                l.bmp = None;
            }
        }
        let Some(hrt) = self.rt.clone() else { return };
        let rt: ID2D1RenderTarget = hrt.into();
        unsafe {
            rt.BeginDraw();
            self.paint(&rt, cfg);
            if rt.EndDraw(None, None).is_err() {
                self.rt = None;
            }
        }
    }

    pub unsafe fn paint(&mut self, rt: &ID2D1RenderTarget, cfg: &Config) {
        let k = self.k;
        let (w, h) = (self.client.0 as f32, self.client.1 as f32);
        rt.SetTransform(&gfx::identity());
        rt.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        rt.Clear(Some(&col(GRAPHITE, 1.0)));

        self.paint_viewfinder(rt, cfg);

        let ink = brush(rt, INK, 1.0);
        let muted = brush(rt, MUTED, 1.0);
        let blue = brush(rt, BLUE, 1.0);
        let layout = self.layout();

        // Last capture: size and age on the left, actions on the right.
        if let Some(l) = &self.last {
            let vf = self.viewfinder();
            let y = vf.bottom() + 8.0 * k;
            let dims = format!("{} × {} px", l.image.width, l.image.height);
            let f = fmt(TEXT_FONT, 12.5 * k, gfx::W_SEMIBOLD);
            let (dw, _) = gfx::measure(&dims, &f);
            gfx::draw_text(rt, &dims, &f, rxywh(vf.x, y, dw + 2.0, 26.0 * k), &ink);
            // The age only shows when it fits before the action links.
            let links_x = layout
                .iter()
                .filter(|(b, _)| matches!(b, HomeBtn::Annotate | HomeBtn::Copy | HomeBtn::Pin))
                .map(|(_, r)| r.x)
                .fold(vf.right(), f32::min);
            let age = age_text(crate::util::now_ms().saturating_sub(l.at_ms));
            let af = fmt(TEXT_FONT, 12.5 * k, gfx::W_REGULAR);
            let ax = vf.x + dw + 10.0 * k;
            let (aw, _) = gfx::measure(&age, &af);
            if ax + aw + 12.0 * k <= links_x {
                gfx::draw_text(rt, &age, &af, rxywh(ax, y, aw + 2.0, 26.0 * k), &muted);
            }
        }

        for (b, r) in &layout {
            let hot = self.hot == Some(*b);
            match b {
                HomeBtn::Annotate | HomeBtn::Copy | HomeBtn::Pin => {
                    let label = match b {
                        HomeBtn::Annotate => t("Anotar"),
                        HomeBtn::Copy => t("Copiar"),
                        _ => t("Fijar"),
                    };
                    if hot {
                        rt.FillRoundedRectangle(&rounded(r.d2d(), 6.0 * k), &brush(rt, SURFACE, 1.0));
                    }
                    gfx::draw_text(rt, label, &fmt_center(TEXT_FONT, 12.5 * k, gfx::W_MEDIUM), r.d2d(), if hot { &ink } else { &blue });
                }
                HomeBtn::Area | HomeBtn::Window | HomeBtn::Fullscreen | HomeBtn::Text | HomeBtn::Previous | HomeBtn::Open => {
                    self.paint_row(rt, *b, r, hot, cfg, &ink, &muted, &blue);
                }
                _ => {}
            }
        }

        // Divider before "Open image".
        if let Some((_, r)) = layout.iter().find(|(b, _)| *b == HomeBtn::Open) {
            let y = (r.y - 5.0 * k).round() + 0.5;
            rt.DrawLine(v2(r.x + 10.0 * k, y), v2(r.right() - 10.0 * k, y), &brush(rt, LINE, 1.0), 1.0, None);
        }

        // Footer: where captures go, folder and options.
        let ft = self.footer_top();
        rt.FillRectangle(&rf(0.0, ft, w, h), &brush(rt, WELL, 0.55));
        rt.FillRectangle(&rf(0.0, ft, w, ft + 1.0), &brush(rt, LINE, 1.0));
        let first_btn_x = layout
            .iter()
            .filter(|(b, _)| matches!(b, HomeBtn::Folder | HomeBtn::Options))
            .map(|(_, r)| r.x)
            .fold(w, f32::min);
        let px = 20.0 * k;
        icons::folder(rt, px + 8.0 * k, ft + 28.0 * k, 16.0 * k, &muted);
        let pf = fmt(TEXT_FONT, 12.5 * k, gfx::W_REGULAR);
        let room = first_btn_x - px - 34.0 * k - 12.0 * k;
        let path = fit_path(&cfg.save_dir, &pf, room);
        gfx::draw_text(rt, &path, &pf, rxywh(px + 26.0 * k, ft, room, 56.0 * k), &muted);
        for (b, r) in layout.iter().filter(|(b, _)| matches!(b, HomeBtn::Folder | HomeBtn::Options)) {
            let hot = self.hot == Some(*b);
            let rr = rounded(r.d2d(), 8.0 * k);
            rt.FillRoundedRectangle(&rr, &brush(rt, if hot { 0x2A2E36 } else { SURFACE }, 1.0));
            rt.DrawRoundedRectangle(&rr, &brush(rt, LINE, 1.0), 1.0, None);
            let f = fmt(TEXT_FONT, 13.0 * k, gfx::W_MEDIUM);
            if *b == HomeBtn::Options {
                icons::dots(rt, r.x + 17.0 * k, r.y + r.h / 2.0, 14.0 * k, &ink);
                gfx::draw_text(rt, t("Opciones"), &f, rxywh(r.x + 30.0 * k, r.y, r.w - 30.0 * k, r.h), &ink);
            } else {
                gfx::draw_text(rt, t("Abrir carpeta"), &fmt_center(TEXT_FONT, 13.0 * k, gfx::W_MEDIUM), r.d2d(), &ink);
            }
        }
    }

    unsafe fn paint_viewfinder(&mut self, rt: &ID2D1RenderTarget, cfg: &Config) {
        let k = self.k;
        let vf = self.viewfinder();
        let hot = self.hot == Some(HomeBtn::Viewfinder);
        rt.FillRoundedRectangle(&rounded(vf.d2d(), 6.0 * k), &brush(rt, WELL, 1.0));

        let inner = R::new(vf.x + 18.0 * k, vf.y + 18.0 * k, vf.w - 36.0 * k, vf.h - 36.0 * k);
        if let Some(l) = &mut self.last {
            // Fit the capture, never enlarging it.
            let (iw, ih) = (l.image.width as f32, l.image.height as f32);
            let s = (inner.w / iw).min(inner.h / ih).min(1.0);
            let (tw, th) = ((iw * s).round().max(1.0) as u32, (ih * s).round().max(1.0) as u32);
            let stale = l.thumb.as_ref().map(|(w, h, _)| (*w, *h) != (tw, th)).unwrap_or(true);
            if stale {
                let img = if s < 1.0 { gfx::scale_image(&l.image, tw, th).unwrap_or_else(|_| l.image.clone()) } else { l.image.clone() };
                l.thumb = Some((tw, th, img));
                l.bmp = None;
            }
            if l.bmp.is_none() {
                l.bmp = l.thumb.as_ref().and_then(|(_, _, img)| gfx::bitmap(rt, img).ok());
            }
            let x = (inner.x + (inner.w - tw as f32) / 2.0).round();
            let y = (inner.y + (inner.h - th as f32) / 2.0).round();
            if let Some(b) = &l.bmp {
                rt.DrawBitmap(b, Some(&rxywh(x, y, tw as f32, th as f32)), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, None);
            }
            rt.DrawRectangle(&rf(x - 0.5, y - 0.5, x + tw as f32 + 0.5, y + th as f32 + 0.5), &brush(rt, 0xFFFFFF, 0.10), 1.0, None);
            if hot {
                let pill_f = fmt_center(TEXT_FONT, 12.5 * k, gfx::W_SEMIBOLD);
                let label = t("Abrir en el editor");
                let (lw, lh) = gfx::measure(label, &pill_f);
                let pr = rxywh(vf.x + (vf.w - lw - 24.0 * k) / 2.0, vf.bottom() - 18.0 * k - lh - 12.0 * k, lw + 24.0 * k, lh + 12.0 * k);
                rt.FillRoundedRectangle(&rounded(pr, (lh + 12.0 * k) / 2.0), &brush(rt, GRAPHITE, 0.92));
                gfx::draw_text(rt, label, &pill_f, pr, &brush(rt, INK, 1.0));
            }
        } else {
            // Empty: a centred crosshair and what to press.
            let (cx, cy) = (vf.x + vf.w / 2.0, vf.y + vf.h / 2.0 - 22.0 * k);
            let m = brush(rt, MUTED, 0.6);
            let a = 12.0 * k;
            rt.DrawLine(v2(cx - a, cy), v2(cx - 4.0 * k, cy), &m, 1.5 * k, None);
            rt.DrawLine(v2(cx + 4.0 * k, cy), v2(cx + a, cy), &m, 1.5 * k, None);
            rt.DrawLine(v2(cx, cy - a), v2(cx, cy - 4.0 * k), &m, 1.5 * k, None);
            rt.DrawLine(v2(cx, cy + 4.0 * k), v2(cx, cy + a), &m, 1.5 * k, None);
            let title = fmt_center(DISPLAY_FONT, 15.0 * k, gfx::W_SEMIBOLD);
            gfx::draw_text(rt, t("Aún no hay capturas"), &title, rxywh(vf.x, cy + 24.0 * k, vf.w, 24.0 * k), &brush(rt, INK, 1.0));
            let hint = if cfg.hotkeys.area.is_empty() {
                t("Elige un modo de captura a la derecha").to_string()
            } else {
                tf("Pulsa {} y arrastra sobre la pantalla", &[&cfg.hotkeys.area])
            };
            gfx::draw_text(rt, &hint, &fmt_center(TEXT_FONT, 12.5 * k, gfx::W_REGULAR), rxywh(vf.x, cy + 48.0 * k, vf.w, 20.0 * k), &brush(rt, MUTED, 1.0));
        }

        // Viewfinder corners: the one bold element.
        let c = brush(rt, if hot { BLUE_BRIGHT } else { BLUE }, 1.0);
        let len = 26.0 * k;
        let th = (2.5 * k).max(2.0);
        let o = th / 2.0;
        let (l, t_, r, b) = (vf.x + o, vf.y + o, vf.right() - o, vf.bottom() - o);
        let st = gfx::stroke_round(0);
        for (x, y, dx, dy) in [(l, t_, 1.0, 1.0), (r, t_, -1.0, 1.0), (l, b, 1.0, -1.0), (r, b, -1.0, -1.0)] {
            rt.DrawLine(v2(x, y), v2(x + len * dx, y), &c, th, &st);
            rt.DrawLine(v2(x, y), v2(x, y + len * dy), &c, th, &st);
        }
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn paint_row(
        &self,
        rt: &ID2D1RenderTarget,
        b: HomeBtn,
        r: &R,
        hot: bool,
        cfg: &Config,
        ink: &ID2D1SolidColorBrush,
        muted: &ID2D1SolidColorBrush,
        blue: &ID2D1SolidColorBrush,
    ) {
        let k = self.k;
        if hot {
            rt.FillRoundedRectangle(&rounded(r.d2d(), 8.0 * k), &brush(rt, SURFACE, 1.0));
        }
        let (label, key) = match b {
            HomeBtn::Area => (t("Capturar área"), cfg.hotkeys.area.as_str()),
            HomeBtn::Window => (t("Capturar ventana"), cfg.hotkeys.window.as_str()),
            HomeBtn::Fullscreen => (t("Pantalla completa"), cfg.hotkeys.fullscreen.as_str()),
            HomeBtn::Text => (t("Texto (OCR)"), cfg.hotkeys.text.as_str()),
            HomeBtn::Previous => (t("Repetir área"), cfg.hotkeys.previous.as_str()),
            _ => (t("Abrir imagen…"), ""),
        };
        let s = 18.0 * k;
        let (ix, iy) = (r.x + 12.0 * k + s / 2.0, r.y + r.h / 2.0);
        let ib = if hot || b == HomeBtn::Area { blue } else { muted };
        match b {
            HomeBtn::Area => icons::area(rt, ix, iy, s, ib),
            HomeBtn::Window => icons::window_icon(rt, ix, iy, s, ib),
            HomeBtn::Fullscreen => icons::monitor(rt, ix, iy, s, ib),
            HomeBtn::Text => icons::text(rt, ix, iy, s, ib),
            HomeBtn::Previous => icons::redo(rt, ix, iy, s, ib),
            _ => icons::image_icon(rt, ix, iy, s, ib),
        }
        let weight = if b == HomeBtn::Area { gfx::W_SEMIBOLD } else { gfx::W_MEDIUM };
        let key_w = if key.is_empty() { 0.0 } else { self.keycap(rt, key, r, b == HomeBtn::Area) };
        let tx = r.x + 12.0 * k + s + 12.0 * k;
        gfx::draw_text(rt, label, &fmt(TEXT_FONT, 14.0 * k, weight), rxywh(tx, r.y, r.right() - tx - key_w - 16.0 * k, r.h), ink);
    }

    /// A physical-looking key: cap with a darker lip under it. Returns its width.
    unsafe fn keycap(&self, rt: &ID2D1RenderTarget, key: &str, row: &R, primary: bool) -> f32 {
        let k = self.k;
        let f = fmt_center(TEXT_FONT, 12.0 * k, gfx::W_SEMIBOLD);
        let (tw, _) = gfx::measure(key, &f);
        let w = (tw + 16.0 * k).max(30.0 * k);
        let h = 24.0 * k;
        let lip = 2.0 * k;
        let x = row.right() - 10.0 * k - w;
        let y = row.y + (row.h - h - lip) / 2.0;
        let radius = 5.0 * k;
        let (cap, under, text) = if primary { (BLUE, BLUE_LIP, 0xFFFFFF) } else { (KEYCAP, KEYCAP_LIP, INK) };
        rt.FillRoundedRectangle(&rounded(rxywh(x, y + lip, w, h), radius), &brush(rt, under, 1.0));
        rt.FillRoundedRectangle(&rounded(rxywh(x, y, w, h), radius), &brush(rt, cap, 1.0));
        rt.DrawLine(v2(x + radius, y + 0.5), v2(x + w - radius, y + 0.5), &brush(rt, 0xFFFFFF, if primary { 0.25 } else { 0.08 }), 1.0, None);
        gfx::draw_text(rt, key, &f, rxywh(x, y, w, h), &brush(rt, text, if primary { 1.0 } else { 0.9 }));
        w
    }
}

/// "Ahora mismo", "Hace 3 min", "Hace 2 h".
fn age_text(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        t("Ahora mismo").to_string()
    } else if s < 3600 {
        tf("Hace {} min", &[&(s / 60)])
    } else {
        tf("Hace {} h", &[&(s / 3600)])
    }
}

/// Shortens a path from the left ("…\Imágenes\Screenshots") until it fits.
fn fit_path(path: &str, f: &IDWriteTextFormat, room: f32) -> String {
    if gfx::measure(path, f).0 <= room {
        return path.to_string();
    }
    let parts: Vec<&str> = path.split('\\').collect();
    for start in 1..parts.len() {
        let s = format!("…\\{}", parts[start..].join("\\"));
        if gfx::measure(&s, f).0 <= room {
            return s;
        }
    }
    parts.last().copied().unwrap_or(path).to_string()
}

/// Renders the main window offscreen (`--preview`).
pub fn preview(k: f32, hot: Option<HomeBtn>, last: Option<&Image>) -> Option<Image> {
    let mut h = Home::new(k);
    h.hot = hot;
    if let Some(img) = last {
        h.set_last(img);
        if let Some(l) = &mut h.last {
            l.at_ms = l.at_ms.saturating_sub(4 * 60 * 1000);
        }
    }
    let mut cfg = Config::default();
    cfg.save_dir = r"C:\Users\ana\OneDrive\Imágenes\Screenshots".into();
    let (bmp, rt) = gfx::wic_target(h.client.0 as u32, h.client.1 as u32).ok()?;
    unsafe {
        rt.BeginDraw();
        h.paint(&rt, &cfg);
        rt.EndDraw(None, None).ok()?;
    }
    gfx::wic_bitmap_to_image(&bmp).ok()
}
