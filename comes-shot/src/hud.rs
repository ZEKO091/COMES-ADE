//! A small toast that confirms actions ("Texto copiado") and fades away.

use std::cell::RefCell;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct2D::{
    ID2D1HwndRenderTarget, ID2D1RenderTarget, D2D1_PRESENT_OPTIONS_NONE,
};
use windows::Win32::Graphics::Gdi::ValidateRect;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyWindow, KillTimer, SetLayeredWindowAttributes, SetTimer, SetWindowPos, ShowWindow,
    HWND_TOPMOST, LWA_ALPHA, SWP_NOACTIVATE, SW_SHOWNOACTIVATE, WM_ERASEBKGND, WM_NCHITTEST,
    WM_PAINT, WM_TIMER, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};

use crate::capture;
use crate::gfx::{self, brush, rounded, rxywh};
use crate::theme;
use crate::util::{self, Rect};
use crate::window::{self, Handler};

thread_local! {
    static HUD: RefCell<Option<HWND>> = const { RefCell::new(None) };
}

struct Hud {
    text: String,
    k: f32,
    started: u64,
    rt: Option<ID2D1HwndRenderTarget>,
    size: (i32, i32),
}

const FADE_IN: u64 = 120;
const HOLD: u64 = 1700;
const FADE_OUT: u64 = 260;
const HTTRANSPARENT: isize = -1;

fn layout(text: &str) -> (Rect, f32) {
    let (cx, cy) = util::cursor_pos();
    let mon = capture::monitor_at(cx, cy);
    let k = mon.scale();
    let fmt = gfx::ui_left(14.0 * k, gfx::W_MEDIUM);
    let (tw, th) = gfx::measure(text, &fmt);
    let w = (tw + 64.0 * k).ceil() as i32;
    let h = (th + 26.0 * k).ceil().max(44.0 * k) as i32;
    let x = mon.work.x + (mon.work.w - w) / 2;
    let y = mon.work.bottom() - h - (96.0 * k) as i32;
    (Rect::new(x, y, w, h), k)
}

pub fn show(text: &str) {
    let (r, k) = layout(text);
    let existing = HUD.with(|h| *h.borrow());
    if let Some(hwnd) = existing {
        // Reuse the visible toast: new text, timer restarts.
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
    }
    let hud = Hud { text: text.to_string(), k, started: util::now_ms(), rt: None, size: (r.w, r.h) };
    let Ok(hwnd) = window::create(
        "ComesShot.Hud",
        "Comes Shot",
        WS_POPUP,
        WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
        r,
        false,
        Box::new(hud),
    ) else {
        return;
    };
    window::round_corners(hwnd, false);
    unsafe {
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), r.x, r.y, r.w, r.h, SWP_NOACTIVATE);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetTimer(Some(hwnd), 1, 15, None);
    }
    HUD.with(|h| *h.borrow_mut() = Some(hwnd));
}

/// Removes the toast right away. Returns true if one was visible.
pub fn hide() -> bool {
    let existing = HUD.with(|h| h.borrow_mut().take());
    if let Some(hwnd) = existing {
        unsafe {
            let _ = DestroyWindow(hwnd);
        }
        true
    } else {
        false
    }
}

impl Hud {
    fn render(&mut self, hwnd: HWND) {
        if self.rt.is_none() {
            self.rt = gfx::hwnd_target(hwnd, self.size.0 as u32, self.size.1 as u32, D2D1_PRESENT_OPTIONS_NONE).ok();
        }
        let Some(hrt) = self.rt.clone() else { return };
        let rt: ID2D1RenderTarget = hrt.into();
        let k = self.k;
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        unsafe {
            rt.BeginDraw();
            rt.Clear(Some(&gfx::col(theme::PANEL, 1.0)));
            rt.DrawRoundedRectangle(&rounded(rxywh(0.5, 0.5, w - 1.0, h - 1.0), 8.0 * k), &brush(&rt, theme::WHITE, 0.10), 1.0, None);
            // Blue check badge.
            let cx = 24.0 * k;
            let cy = h / 2.0;
            let r = 9.0 * k;
            rt.FillEllipse(&gfx::ellipse(cx, cy, r, r), &brush(&rt, theme::BLUE, 1.0));
            let pts = [gfx::v2(cx - 4.0 * k, cy + 0.2 * k), gfx::v2(cx - 1.2 * k, cy + 3.0 * k), gfx::v2(cx + 4.2 * k, cy - 3.0 * k)];
            if let Some(g) = gfx::polyline(&pts, false) {
                rt.DrawGeometry(&g, &brush(&rt, theme::WHITE, 1.0), 1.8 * k, &gfx::stroke_round(0));
            }
            let fmt = gfx::ui_left(14.0 * k, gfx::W_MEDIUM);
            gfx::draw_text(&rt, &self.text, &fmt, rxywh(44.0 * k, 0.0, w - 52.0 * k, h), &brush(&rt, theme::TEXT, 1.0));
            if rt.EndDraw(None, None).is_err() {
                self.rt = None;
            }
        }
    }
}

impl Handler for Hud {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, _lp: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_NCHITTEST => Some(LRESULT(HTTRANSPARENT)),
            WM_ERASEBKGND => Some(LRESULT(1)),
            WM_PAINT => {
                self.render(hwnd);
                unsafe {
                    let _ = ValidateRect(Some(hwnd), None);
                }
                Some(LRESULT(0))
            }
            WM_TIMER if wp.0 == 1 => {
                let t = util::now_ms().saturating_sub(self.started);
                let a = if t < FADE_IN {
                    t as f32 / FADE_IN as f32
                } else if t < FADE_IN + HOLD {
                    1.0
                } else if t < FADE_IN + HOLD + FADE_OUT {
                    1.0 - (t - FADE_IN - HOLD) as f32 / FADE_OUT as f32
                } else {
                    unsafe {
                        let _ = KillTimer(Some(hwnd), 1);
                    }
                    HUD.with(|h| {
                        let mut h = h.borrow_mut();
                        if *h == Some(hwnd) {
                            *h = None;
                        }
                    });
                    util::post_close(hwnd);
                    return Some(LRESULT(0));
                };
                unsafe {
                    let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), (a.clamp(0.0, 1.0) * 255.0) as u8, LWA_ALPHA);
                }
                Some(LRESULT(0))
            }
            _ => None,
        }
    }
}
