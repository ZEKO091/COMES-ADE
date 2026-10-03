//! Quick access: a floating thumbnail after each capture. Hover for Copy /
//! Save, corner buttons to annotate, pin or close, drag it into any app.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct2D::{
    ID2D1Bitmap, ID2D1HwndRenderTarget, ID2D1RenderTarget, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR,
    D2D1_PRESENT_OPTIONS_NONE,
};
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyWindow, IsWindowVisible, KillTimer, LoadCursorW, SetCursor, SetTimer, SetWindowPos, ShowWindow,
    HWND_TOPMOST, IDC_ARROW, IDC_HAND, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE,
    WM_ERASEBKGND, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEMOVE,
    WM_NCDESTROY, WM_PAINT, WM_RBUTTONUP, WM_SETCURSOR, WM_TIMER, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_POPUP, MA_NOACTIVATE,
};

use crate::app;
use crate::capture::Monitor;
use crate::gfx::{self, brush, rf, rounded, rxywh, v2};
use crate::i18n::t;
use crate::image::Image;
use crate::theme;
use crate::ui::R;
use crate::util::{self, lparam_xy, Rect};
use crate::window::{self, Handler};
use crate::{config, editor, hud, icons, pin, shell};

const TIMER_ANIM: usize = 1;
const WM_MOUSELEAVE: u32 = 0x02A3;
const TIMER_AUTOCLOSE: usize = 2;

struct Item {
    hwnd: HWND,
    size: (i32, i32),
    work: Rect,
    k: f32,
}

thread_local! {
    static ITEMS: RefCell<Vec<Item>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Btn {
    None,
    Close,
    Edit,
    Pin,
    Copy,
    Save,
}

struct Quick {
    image: Image,
    thumb: Image,
    path: Option<PathBuf>,
    saved: bool,
    k: f32,
    size: (i32, i32),
    rt: Option<ID2D1HwndRenderTarget>,
    bmp: Option<ID2D1Bitmap>,
    hover: bool,
    hot: Btn,
    pressed: Option<(i32, i32)>,
    anim_from: (i32, i32),
    anim_to: (i32, i32),
    anim_start: u64,
    tracking: bool,
}

pub fn show(image: Image, path: Option<PathBuf>, mon: Monitor) {
    let k = mon.scale();
    // Thumbnail fits in 260x170 logical px, keeping the aspect ratio.
    let (max_w, max_h) = (260.0 * k, 170.0 * k);
    let (iw, ih) = (image.width as f32, image.height as f32);
    let s = (max_w / iw).min(max_h / ih).min(1.0);
    let (tw, th) = ((iw * s).round().max(1.0) as u32, (ih * s).round().max(1.0) as u32);
    let thumb = if s < 1.0 { gfx::scale_image(&image, tw, th).unwrap_or_else(|_| image.clone()) } else { image.clone() };
    let w = (tw as f32).max(200.0 * k).round() as i32;
    let h = (th as f32).max(112.0 * k).round() as i32;
    let margin = (18.0 * k) as i32;
    let target = (mon.work.x + margin, mon.work.bottom() - margin - h);
    let start = (mon.work.x - w - 8, target.1);
    let q = Quick {
        image,
        thumb,
        path,
        saved: false,
        k,
        size: (w, h),
        rt: None,
        bmp: None,
        hover: false,
        hot: Btn::None,
        pressed: None,
        anim_from: start,
        anim_to: target,
        anim_start: util::now_ms(),
        tracking: false,
    };
    let Ok(hwnd) = window::create(
        "ComesShot.Quick",
        "Comes Shot",
        WS_POPUP,
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        Rect::new(start.0, start.1, w, h),
        true,
        Box::new(q),
    ) else {
        return;
    };
    window::round_corners(hwnd, false);
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        items.push(Item { hwnd, size: (w, h), work: mon.work, k });
        // Keep at most five previews.
        while items.len() > 5 {
            let old = items.remove(0);
            util::post_close(old.hwnd);
        }
    });
    relayout(Some(hwnd));
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetTimer(Some(hwnd), TIMER_ANIM, 10, None);
        let secs = config::get().quick_access_autoclose_secs;
        if secs > 0 {
            SetTimer(Some(hwnd), TIMER_AUTOCLOSE, secs * 1000, None);
        }
    }
}

/// Stacks previews upward from the bottom-left corner, newest at the bottom.
fn relayout(skip: Option<HWND>) {
    ITEMS.with(|items| {
        let items = items.borrow();
        let mut offsets: Vec<(Rect, i32)> = Vec::new();
        for it in items.iter().rev() {
            let gap = (12.0 * it.k) as i32;
            let margin = (18.0 * it.k) as i32;
            let used = offsets.iter_mut().find(|(w, _)| *w == it.work);
            let y_bottom = match used {
                Some((_, y)) => {
                    let yb = *y;
                    *y -= it.size.1 + gap;
                    yb
                }
                None => {
                    let yb = it.work.bottom() - margin;
                    offsets.push((it.work, yb - it.size.1 - gap));
                    yb
                }
            };
            if Some(it.hwnd) == skip {
                continue;
            }
            unsafe {
                let _ = SetWindowPos(
                    it.hwnd,
                    None,
                    it.work.x + margin,
                    y_bottom - it.size.1,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE,
                );
            }
        }
    });
}

/// Hides/shows every preview (so they never end up inside a capture).
/// Returns true if anything was visible.
pub fn set_visible(visible: bool) -> bool {
    ITEMS.with(|items| {
        let mut any = false;
        for it in items.borrow().iter() {
            unsafe {
                if visible {
                    let _ = ShowWindow(it.hwnd, SW_SHOWNOACTIVATE);
                    let _ = SetWindowPos(it.hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE | windows::Win32::UI::WindowsAndMessaging::SWP_NOMOVE);
                } else if IsWindowVisible(it.hwnd).as_bool() {
                    any = true;
                    let _ = ShowWindow(it.hwnd, SW_HIDE);
                }
            }
        }
        any
    })
}

/// Called when a background save finishes.
pub fn mark_saved(path: &Path) {
    let hwnds: Vec<HWND> = ITEMS.with(|i| i.borrow().iter().map(|it| it.hwnd).collect());
    for h in hwnds {
        unsafe {
            let _ = InvalidateRect(Some(h), None, false);
        }
    }
    SAVED.with(|s| s.borrow_mut().push(path.to_path_buf()));
}

thread_local! {
    static SAVED: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
}

fn is_saved(p: &Path) -> bool {
    SAVED.with(|s| s.borrow().iter().any(|x| x == p))
}

impl Quick {
    fn layout_buttons(&self) -> Vec<(Btn, R)> {
        let k = self.k;
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        let c = 26.0 * k;
        let m = 8.0 * k;
        let mut v = vec![
            (Btn::Close, R::new(m, m, c, c)),
            (Btn::Edit, R::new(w - m - c, m, c, c)),
            (Btn::Pin, R::new(w - m - c, h - m - c, c, c)),
        ];
        let bw = 104.0 * k;
        let bh = 30.0 * k;
        let gap = 8.0 * k;
        if h >= 130.0 * k {
            let y0 = h / 2.0 - bh - gap / 2.0;
            v.push((Btn::Copy, R::new((w - bw) / 2.0, y0, bw, bh)));
            v.push((Btn::Save, R::new((w - bw) / 2.0, y0 + bh + gap, bw, bh)));
        } else {
            let bw = 82.0 * k;
            let x0 = w / 2.0 - bw - gap / 2.0;
            v.push((Btn::Copy, R::new(x0, (h - bh) / 2.0, bw, bh)));
            v.push((Btn::Save, R::new(x0 + bw + gap, (h - bh) / 2.0, bw, bh)));
        }
        v
    }

    fn hit(&self, x: i32, y: i32) -> Btn {
        if !self.hover {
            return Btn::None;
        }
        self.layout_buttons()
            .into_iter()
            .find(|(_, r)| r.contains(x as f32, y as f32))
            .map(|(b, _)| b)
            .unwrap_or(Btn::None)
    }

    fn saved_path(&self) -> Option<&Path> {
        self.path.as_deref().filter(|p| self.saved || is_saved(p))
    }

    fn render(&mut self, hwnd: HWND) {
        if self.rt.is_none() {
            self.rt = gfx::hwnd_target(hwnd, self.size.0 as u32, self.size.1 as u32, D2D1_PRESENT_OPTIONS_NONE).ok();
            self.bmp = None;
        }
        let Some(hrt) = self.rt.clone() else { return };
        let rt: ID2D1RenderTarget = hrt.into();
        if self.bmp.is_none() {
            self.bmp = gfx::bitmap(&rt, &self.thumb).ok();
        }
        unsafe {
            rt.BeginDraw();
            self.paint(&rt);
            if rt.EndDraw(None, None).is_err() {
                self.rt = None;
            }
        }
    }

    unsafe fn paint(&self, rt: &ID2D1RenderTarget) {
        let k = self.k;
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        rt.Clear(Some(&gfx::col(theme::PANEL, 1.0)));
        if let Some(b) = &self.bmp {
            let (tw, th) = (self.thumb.width as f32, self.thumb.height as f32);
            let x = ((w - tw) / 2.0).round();
            let y = ((h - th) / 2.0).round();
            rt.DrawBitmap(b, Some(&rxywh(x, y, tw, th)), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, None);
        }
        if self.hover {
            rt.FillRectangle(&rf(0.0, 0.0, w, h), &brush(&rt, theme::BLACK, 0.52));
            let saved = self.saved_path().is_some();
            for (b, r) in self.layout_buttons() {
                let hot = self.hot == b;
                match b {
                    Btn::Copy | Btn::Save => {
                        let primary = b == Btn::Copy;
                        let rr = rounded(r.d2d(), r.h / 2.0);
                        let fill = if primary {
                            brush(&rt, if hot { theme::BLUE_HOVER } else { theme::BLUE }, 1.0)
                        } else {
                            brush(&rt, theme::WHITE, if hot { 0.26 } else { 0.16 })
                        };
                        rt.FillRoundedRectangle(&rr, &fill);
                        let label = match (b, saved) {
                            (Btn::Copy, _) => t("Copiar"),
                            (_, true) => t("Mostrar"),
                            _ => t("Guardar"),
                        };
                        let fmt = gfx::ui_center(13.0 * k, gfx::W_SEMIBOLD);
                        gfx::draw_text(&rt, label, &fmt, r.d2d(), &brush(&rt, theme::WHITE, 1.0));
                    }
                    _ => {
                        let (cx, cy) = r.center();
                        rt.FillEllipse(&gfx::ellipse(cx, cy, r.w / 2.0, r.h / 2.0), &brush(&rt, if hot { 0x3A3F48 } else { 0x23272E }, 0.95));
                        rt.DrawEllipse(&gfx::ellipse(cx, cy, r.w / 2.0 - 0.5, r.h / 2.0 - 0.5), &brush(&rt, theme::WHITE, 0.14), 1.0, None);
                        let ib = brush(&rt, theme::WHITE, 0.95);
                        let s = 12.0 * k;
                        match b {
                            Btn::Close => icons::close(&rt, cx, cy, s, &ib),
                            Btn::Edit => icons::pencil(&rt, cx, cy, s, &ib),
                            Btn::Pin => icons::pin(&rt, cx, cy, s, &ib),
                            _ => {}
                        }
                    }
                }
            }
        }
        rt.DrawRectangle(&rf(0.5, 0.5, w - 0.5, h - 0.5), &brush(&rt, theme::WHITE, 0.12), 1.0, None);
        let _ = v2;
    }

    fn ensure_file(&mut self) -> Option<PathBuf> {
        if let Some(p) = &self.path {
            // The background save may still be running.
            for _ in 0..150 {
                if is_saved(p) || (p.exists() && !p.with_extension("comesshot-tmp").exists()) {
                    return Some(p.clone());
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        let cfg = config::get();
        let p = std::env::temp_dir().join("ComesShot").join(
            app::next_capture_path(&config::Config { save_dir: std::env::temp_dir().join("ComesShot").to_string_lossy().into(), ..cfg.clone() })
                .file_name()?,
        );
        let _ = std::fs::create_dir_all(p.parent()?);
        let q = (cfg.extension() == "jpg").then_some(cfg.jpg_quality);
        gfx::save_image(&self.image, &p, q).ok()?;
        Some(p)
    }

    fn click(&mut self, hwnd: HWND, b: Btn) {
        match b {
            Btn::Close => util::post_close(hwnd),
            Btn::Copy => {
                if app::copy_image(&self.image) {
                    hud::show(t("Copiado al portapapeles"));
                }
                util::post_close(hwnd);
            }
            Btn::Save => {
                if let Some(p) = self.saved_path().map(|p| p.to_path_buf()) {
                    shell::reveal(&p);
                    util::post_close(hwnd);
                } else {
                    let cfg = config::get();
                    let p = self.path.clone().unwrap_or_else(|| app::next_capture_path(&cfg));
                    app::save_async(self.image.clone(), p.clone());
                    self.path = Some(p);
                    hud::show(t("Captura guardada"));
                    util::post_close(hwnd);
                }
            }
            Btn::Edit => {
                editor::open(self.image.clone(), self.path.clone());
                util::post_close(hwnd);
            }
            Btn::Pin => {
                pin::open(self.image.clone(), None);
                util::post_close(hwnd);
            }
            Btn::None => {}
        }
    }
}

impl Handler for Quick {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_MOUSEACTIVATE => Some(LRESULT(MA_NOACTIVATE as isize)),
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
                    SetCursor(LoadCursorW(None, if self.hot != Btn::None { IDC_HAND } else { IDC_ARROW }).ok());
                }
                Some(LRESULT(1))
            }
            WM_TIMER if wp.0 == TIMER_ANIM => {
                let t = (util::now_ms() - self.anim_start) as f32 / 220.0;
                let e = util::ease_out_cubic(t);
                let x = self.anim_from.0 as f32 + (self.anim_to.0 - self.anim_from.0) as f32 * e;
                unsafe {
                    let _ = SetWindowPos(hwnd, None, x.round() as i32, self.anim_to.1, 0, 0, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE);
                    if t >= 1.0 {
                        let _ = KillTimer(Some(hwnd), TIMER_ANIM);
                        relayout(None);
                    }
                }
                Some(LRESULT(0))
            }
            WM_TIMER if wp.0 == TIMER_AUTOCLOSE => {
                if !self.hover {
                    util::post_close(hwnd);
                }
                Some(LRESULT(0))
            }
            WM_MOUSEMOVE => {
                let (x, y) = lparam_xy(lp);
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
                let was = (self.hover, self.hot);
                self.hover = true;
                self.hot = self.hit(x, y);
                if was != (self.hover, self.hot) {
                    unsafe {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                if let Some((px, py)) = self.pressed {
                    let th = (6.0 * self.k) as i32;
                    if (x - px).abs() > th || (y - py).abs() > th {
                        self.pressed = None;
                        unsafe {
                            let _ = ReleaseCapture();
                        }
                        if let Some(p) = self.ensure_file() {
                            let preview = self.thumb.clone();
                            let small = if preview.width > 220 {
                                let s = 220.0 / preview.width as f32;
                                gfx::scale_image(&preview, 220, ((preview.height as f32 * s) as u32).max(1)).ok()
                            } else {
                                Some(preview)
                            };
                            if shell::drag_file(&p, small.as_ref()) {
                                util::post_close(hwnd);
                            }
                        }
                    }
                }
                Some(LRESULT(0))
            }
            WM_MOUSELEAVE => {
                self.tracking = false;
                if self.pressed.is_none() {
                    self.hover = false;
                    self.hot = Btn::None;
                    unsafe {
                        let _ = InvalidateRect(Some(hwnd), None, false);
                    }
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONDOWN => {
                let (x, y) = lparam_xy(lp);
                if self.hit(x, y) == Btn::None {
                    self.pressed = Some((x, y));
                    unsafe {
                        SetCapture(hwnd);
                    }
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONUP => {
                let (x, y) = lparam_xy(lp);
                if self.pressed.take().is_some() {
                    unsafe {
                        let _ = ReleaseCapture();
                    }
                } else {
                    let b = self.hit(x, y);
                    self.click(hwnd, b);
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONDBLCLK => {
                self.click(hwnd, Btn::Edit);
                Some(LRESULT(0))
            }
            WM_RBUTTONUP => {
                util::post_close(hwnd);
                Some(LRESULT(0))
            }
            WM_NCDESTROY => {
                ITEMS.with(|items| items.borrow_mut().retain(|it| it.hwnd != hwnd));
                relayout(None);
                None
            }
            _ => None,
        }
    }
}

#[allow(dead_code)]
fn _destroy(h: HWND) {
    unsafe {
        let _ = DestroyWindow(h);
    }
}

/// Renders a quick access preview offscreen (`--preview`).
pub fn preview(image: Image, k: f32, hover: bool) -> Option<Image> {
    let (max_w, max_h) = (260.0 * k, 170.0 * k);
    let s = (max_w / image.width as f32).min(max_h / image.height as f32).min(1.0);
    let (tw, th) = ((image.width as f32 * s).round() as u32, (image.height as f32 * s).round() as u32);
    let thumb = gfx::scale_image(&image, tw, th).ok()?;
    let size = ((tw as f32).max(200.0 * k).round() as i32, (th as f32).max(112.0 * k).round() as i32);
    let mut q = Quick {
        image, thumb, path: None, saved: false, k, size, rt: None, bmp: None, hover,
        hot: if hover { Btn::Copy } else { Btn::None }, pressed: None,
        anim_from: (0, 0), anim_to: (0, 0), anim_start: 0, tracking: false,
    };
    let (bmp, rt) = gfx::wic_target(size.0 as u32, size.1 as u32).ok()?;
    q.bmp = gfx::bitmap(&rt, &q.thumb).ok();
    unsafe {
        rt.BeginDraw();
        q.paint(&rt);
        rt.EndDraw(None, None).ok()?;
    }
    gfx::wic_bitmap_to_image(&bmp).ok()
}
