//! Selection overlay: a frozen copy of the desktop covering every monitor.
//! Drag to select an area, click to take the window under the cursor.
//! Coordinates are physical pixels, so what you select is exactly what you get.

use std::sync::Arc;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct2D::{
    ID2D1HwndRenderTarget, ID2D1RenderTarget, D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
    D2D1_PRESENT_OPTIONS_IMMEDIATELY, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE,
};
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetCapture, SetFocus, VK_DOWN, VK_ESCAPE, VK_LEFT, VK_RETURN,
    VK_RIGHT, VK_SHIFT, VK_SPACE, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    LoadCursorW, SetCursor, SetCursorPos, SetForegroundWindow, ShowWindow, IDC_CROSS, SW_HIDE,
    SW_SHOW, WA_INACTIVE, WM_ACTIVATE, WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_PAINT, WM_RBUTTONUP, WM_SETCURSOR, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use crate::app::{self, AppEvent};
use crate::capture::{Monitor, Snapshot};
use crate::gfx::{self, brush, rf, rounded, rxywh, v2, TiledBitmap};
use crate::i18n::{t, tf};
use crate::image::Image;
use crate::theme;
use crate::util::{self, lparam_xy, Rect};
use crate::window::{self, Handler};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Area,
    Window,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Purpose {
    Capture,
    Text,
}

pub struct OverlayResult {
    pub image: Image,
    /// Selection in virtual-screen coordinates.
    pub rect: Rect,
    pub monitor: Monitor,
    pub purpose: Purpose,
}

struct Overlay {
    snap: Arc<Snapshot>,
    mode: Mode,
    purpose: Purpose,
    magnifier: bool,
    crosshair: bool,
    rt: Option<ID2D1HwndRenderTarget>,
    tiles: Option<TiledBitmap>,
    /// Cursor in client (= snapshot image) coordinates.
    cursor: (i32, i32),
    down: Option<(i32, i32)>,
    dragging: bool,
    square: bool,
    finished: bool,
    was_active: bool,
}

pub fn open(snap: Snapshot, mode: Mode, purpose: Purpose) -> Option<HWND> {
    let cfg = crate::config::get();
    let vr = Rect::new(snap.origin.0, snap.origin.1, snap.image.width as i32, snap.image.height as i32);
    let (cx, cy) = util::cursor_pos();
    let ov = Overlay {
        cursor: (cx - vr.x, cy - vr.y),
        snap: Arc::new(snap),
        mode,
        purpose,
        magnifier: cfg.magnifier,
        crosshair: cfg.crosshair,
        rt: None,
        tiles: None,
        down: None,
        dragging: false,
        square: false,
        finished: false,
        was_active: false,
    };
    let hwnd = window::create(
        "ComesShot.Overlay",
        "Comes Shot",
        WS_POPUP,
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
        vr,
        false,
        Box::new(ov),
    )
    .ok()?;
    unsafe {
        // Cloaked until the first frame is drawn, so there is no flash.
        window::dwm_set(hwnd, window::DWMWA_CLOAK, 1i32);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = windows::Win32::Graphics::Gdi::UpdateWindow(hwnd);
        window::dwm_set(hwnd, window::DWMWA_CLOAK, 0i32);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
    }
    Some(hwnd)
}

impl Overlay {
    fn size(&self) -> (i32, i32) {
        (self.snap.image.width as i32, self.snap.image.height as i32)
    }

    /// Monitor under a client point, in client coordinates.
    fn monitor_client(&self, x: i32, y: i32) -> (Rect, f32) {
        let o = self.snap.origin;
        let m = self.snap.monitor_at(x + o.0, y + o.1);
        (m.rect.offset(-o.0, -o.1), m.scale())
    }

    fn selection(&self) -> Option<Rect> {
        let d = self.down?;
        if !self.dragging {
            return None;
        }
        let (mut cx, mut cy) = self.cursor;
        if self.square {
            let side = (cx - d.0).abs().max((cy - d.1).abs());
            cx = d.0 + side * (cx - d.0).signum();
            cy = d.1 + side * (cy - d.1).signum();
        }
        let (w, h) = self.size();
        let r = Rect::from_points(d, (cx, cy));
        r.intersect(&Rect::new(0, 0, w, h))
    }

    /// Window (or whole monitor) under the cursor, in client coordinates.
    fn hover(&self) -> Option<Rect> {
        let o = self.snap.origin;
        let (x, y) = (self.cursor.0 + o.0, self.cursor.1 + o.1);
        if let Some(w) = self.snap.windows.iter().find(|w| w.rect.contains(x, y)) {
            return Some(w.rect.offset(-o.0, -o.1));
        }
        Some(self.monitor_client(self.cursor.0, self.cursor.1).0)
    }

    fn hover_title(&self) -> Option<&str> {
        let o = self.snap.origin;
        let (x, y) = (self.cursor.0 + o.0, self.cursor.1 + o.1);
        self.snap.windows.iter().find(|w| w.rect.contains(x, y)).map(|w| w.title.as_str())
    }

    fn finish(&mut self, hwnd: HWND, r: Rect) {
        if self.finished {
            return;
        }
        let (w, h) = self.size();
        let Some(r) = r.intersect(&Rect::new(0, 0, w, h)) else { return };
        self.finished = true;
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        let o = self.snap.origin;
        let virt = r.offset(o.0, o.1);
        let (mx, my) = virt.center();
        let result = OverlayResult {
            image: self.snap.image.crop(r),
            rect: virt,
            monitor: self.snap.monitor_at(mx, my).clone(),
            purpose: self.purpose,
        };
        app::post(AppEvent::OverlayDone(Some(result)));
        util::post_close(hwnd);
    }

    fn cancel(&mut self, hwnd: HWND) {
        if self.finished {
            return;
        }
        self.finished = true;
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
        app::post(AppEvent::OverlayDone(None));
        util::post_close(hwnd);
    }

    fn render(&mut self, hwnd: HWND) {
        if self.rt.is_none() {
            let (w, h) = self.size();
            self.rt = gfx::hwnd_target(hwnd, w as u32, h as u32, D2D1_PRESENT_OPTIONS_IMMEDIATELY).ok();
            self.tiles = None;
        }
        let Some(hrt) = self.rt.clone() else { return };
        let rt: ID2D1RenderTarget = hrt.into();
        if self.tiles.is_none() {
            self.tiles = TiledBitmap::new(&rt, &self.snap.image).ok();
        }
        unsafe {
            rt.BeginDraw();
            self.paint(&rt);
            if rt.EndDraw(None, None).is_err() {
                self.rt = None;
                self.tiles = None;
            }
        }
    }

    unsafe fn paint(&self, rt: &ID2D1RenderTarget) {
        let (w, h) = self.size();
        rt.SetTransform(&gfx::identity());
        rt.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        if let Some(t) = &self.tiles {
            t.draw(rt, D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR);
        }
        self.draw_ui(rt, w, h);
    }

    unsafe fn draw_ui(&self, rt: &ID2D1RenderTarget, w: i32, h: i32) {
        let (wf, hf) = (w as f32, h as f32);
        let dim = brush(rt, theme::BLACK, 0.42);
        let sel = self.selection();
        let focus = sel.or_else(|| if self.dragging { None } else { self.hover() });
        let (mon, k) = self.monitor_client(self.cursor.0, self.cursor.1);

        // Dim everything except the focused rectangle.
        match focus {
            Some(f) => {
                let (l, t, r, b) = (f.x as f32, f.y as f32, f.right() as f32, f.bottom() as f32);
                rt.FillRectangle(&rf(0.0, 0.0, wf, t), &dim);
                rt.FillRectangle(&rf(0.0, b, wf, hf), &dim);
                rt.FillRectangle(&rf(0.0, t, l, b), &dim);
                rt.FillRectangle(&rf(r, t, wf, b), &dim);
            }
            None => rt.FillRectangle(&rf(0.0, 0.0, wf, hf), &dim),
        }

        if let Some(s) = sel {
            self.draw_selection(rt, s, true);
        } else if let Some(hv) = focus {
            self.draw_selection(rt, hv, false);
        }

        // Crosshair guides across the current monitor.
        if self.crosshair && self.mode == Mode::Area && !self.dragging {
            let (cx, cy) = (self.cursor.0 as f32 + 0.5, self.cursor.1 as f32 + 0.5);
            let dark = brush(rt, theme::BLACK, 0.28);
            let light = brush(rt, theme::WHITE, 0.62);
            let (ml, mt, mr, mb) = (mon.x as f32, mon.y as f32, mon.right() as f32, mon.bottom() as f32);
            rt.DrawLine(v2(ml, cy + 1.0), v2(mr, cy + 1.0), &dark, 1.0, None);
            rt.DrawLine(v2(cx + 1.0, mt), v2(cx + 1.0, mb), &dark, 1.0, None);
            rt.DrawLine(v2(ml, cy), v2(mr, cy), &light, 1.0, None);
            rt.DrawLine(v2(cx, mt), v2(cx, mb), &light, 1.0, None);
        }

        if self.magnifier {
            self.draw_magnifier(rt, mon, k);
        }
        if !self.dragging {
            self.draw_hint(rt, mon, k);
        }
    }

    unsafe fn draw_selection(&self, rt: &ID2D1RenderTarget, s: Rect, is_sel: bool) {
        let (_, k) = self.monitor_client(s.x + s.w / 2, s.y + s.h / 2);
        let (l, t, r, b) = (s.x as f32, s.y as f32, s.right() as f32, s.bottom() as f32);
        if is_sel {
            rt.DrawRectangle(&rf(l + 0.5, t + 0.5, r - 0.5, b - 0.5), &brush(rt, theme::WHITE, 0.9), 1.0, None);
        } else {
            let fill = brush(rt, theme::BLUE, 0.06);
            rt.FillRectangle(&rf(l, t, r, b), &fill);
            rt.DrawRectangle(&rf(l + 1.0, t + 1.0, r - 1.0, b - 1.0), &brush(rt, theme::BLUE, 0.95), 2.0, None);
        }
        // Viewfinder corners in ComesADE blue.
        if is_sel {
            let blue = brush(rt, theme::BLUE, 1.0);
            let len = (16.0 * k).min(s.w as f32 / 2.0).min(s.h as f32 / 2.0).max(4.0);
            let th = (3.0 * k).round().max(2.0);
            let o = th / 2.0;
            for (x, y, dx, dy) in [(l - o, t - o, 1.0, 1.0), (r + o, t - o, -1.0, 1.0), (l - o, b + o, 1.0, -1.0), (r + o, b + o, -1.0, -1.0)] {
                rt.DrawLine(v2(x - o * dx, y), v2(x + len * dx, y), &blue, th, None);
                rt.DrawLine(v2(x, y - o * dy), v2(x, y + len * dy), &blue, th, None);
            }
        }

        // Size label.
        let mut label = format!("{} × {}", s.w, s.h);
        if !is_sel {
            if let Some(title) = self.hover_title().filter(|t| !t.is_empty()) {
                let short: String = title.chars().take(48).collect();
                label = format!("{short}   {label}");
            }
        }
        let fmt = gfx::ui_center(12.5 * k, gfx::W_SEMIBOLD);
        let (tw, th) = gfx::measure(&label, &fmt);
        let (pw, ph) = (tw + 18.0 * k, th + 8.0 * k);
        let (mon, _) = self.monitor_client(s.x, s.bottom());
        let mut x = l;
        let mut y = b + 8.0 * k;
        if y + ph > mon.bottom() as f32 - 4.0 {
            y = if is_sel { b - ph - 8.0 * k } else { t + 8.0 * k };
            if !is_sel {
                x = l + 8.0 * k;
            }
        }
        x = x.min(mon.right() as f32 - pw - 4.0).max(mon.x as f32 + 4.0);
        let pill = rounded(rxywh(x, y, pw, ph), ph / 2.0);
        rt.FillRoundedRectangle(&pill, &brush(rt, theme::PANEL, 0.94));
        rt.DrawRoundedRectangle(&pill, &brush(rt, theme::WHITE, 0.10), 1.0, None);
        gfx::draw_text(rt, &label, &fmt, rxywh(x, y, pw, ph), &brush(rt, theme::TEXT, 1.0));
    }

    unsafe fn draw_magnifier(&self, rt: &ID2D1RenderTarget, mon: Rect, k: f32) {
        const N: i32 = 17;
        let cell = (7.0 * k).round().max(5.0);
        let size = cell * N as f32;
        let info_h = (42.0 * k).round();
        let gap = 22.0 * k;
        let (cx, cy) = self.cursor;
        let mut x = cx as f32 + gap;
        let mut y = cy as f32 + gap;
        if x + size > mon.right() as f32 - 4.0 {
            x = cx as f32 - gap - size;
        }
        if y + size + info_h > mon.bottom() as f32 - 4.0 {
            y = cy as f32 - gap - size - info_h;
        }
        let panel = rounded(rxywh(x - 4.0, y - 4.0, size + 8.0, size + info_h + 8.0), 10.0 * k);
        rt.FillRoundedRectangle(&panel, &brush(rt, theme::PANEL, 0.96));
        rt.DrawRoundedRectangle(&panel, &brush(rt, theme::WHITE, 0.12), 1.0, None);

        let box_r = rxywh(x, y, size, size);
        rt.FillRectangle(&box_r, &brush(rt, theme::BLACK, 1.0));
        let half = N / 2;
        let src = rf((cx - half) as f32, (cy - half) as f32, (cx + half + 1) as f32, (cy + half + 1) as f32);
        if let Some(t) = &self.tiles {
            rt.PushAxisAlignedClip(&box_r, windows::Win32::Graphics::Direct2D::D2D1_ANTIALIAS_MODE_ALIASED);
            t.draw_part(rt, src, box_r, D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR);
            // Pixel grid.
            let grid = brush(rt, theme::WHITE, 0.07);
            for i in 1..N {
                let o = i as f32 * cell;
                rt.DrawLine(v2(x + o, y), v2(x + o, y + size), &grid, 1.0, None);
                rt.DrawLine(v2(x, y + o), v2(x + size, y + o), &grid, 1.0, None);
            }
            rt.PopAxisAlignedClip();
        }
        let c = rxywh(x + half as f32 * cell, y + half as f32 * cell, cell, cell);
        rt.DrawRectangle(&rf(c.left - 1.0, c.top - 1.0, c.right + 1.0, c.bottom + 1.0), &brush(rt, theme::BLACK, 0.9), 1.0, None);
        rt.DrawRectangle(&c, &brush(rt, theme::WHITE, 1.0), 1.0, None);

        // Readout: position (relative to the monitor) or selection size, and colour.
        let fmt = gfx::ui_left(11.5 * k, gfx::W_MEDIUM);
        let text = brush(rt, theme::TEXT, 1.0);
        let muted = brush(rt, theme::MUTED, 1.0);
        let line1 = match self.selection() {
            Some(s) => format!("{} × {} px", s.w, s.h),
            None => format!("X {}   Y {}", cx - mon.x, cy - mon.y),
        };
        let lh = info_h / 2.0;
        gfx::draw_text(rt, &line1, &fmt, rxywh(x + 2.0, y + size + 2.0, size, lh), &text);
        if let Some((r, g, b)) = self.snap.image.rgb(cx, cy) {
            let hex = format!("#{r:02X}{g:02X}{b:02X}");
            let sw = 11.0 * k;
            let sy = y + size + lh + (lh - sw) / 2.0;
            let swatch = rounded(rxywh(x + 2.0, sy, sw, sw), 3.0 * k);
            rt.FillRoundedRectangle(&swatch, &rt.CreateSolidColorBrush(&gfx::col(((r as u32) << 16) | ((g as u32) << 8) | b as u32, 1.0), None).unwrap());
            rt.DrawRoundedRectangle(&swatch, &brush(rt, theme::WHITE, 0.3), 1.0, None);
            gfx::draw_text(rt, &hex, &fmt, rxywh(x + sw + 8.0 * k, y + size + lh, size, lh), &text);
            let kfmt = gfx::text_format(theme::FONT, 10.5 * k, gfx::W_REGULAR, 2);
            let copy = t("C copia");
            let (cw, _) = gfx::measure(copy, &kfmt);
            gfx::draw_text(rt, copy, &kfmt, rxywh(x + size - cw - 2.0, y + size + lh, cw + 2.0, lh), &muted);
        }
    }

    unsafe fn draw_hint(&self, rt: &ID2D1RenderTarget, mon: Rect, k: f32) {
        let text = match (self.purpose, self.mode) {
            (Purpose::Text, _) => t("Selecciona el texto que quieres copiar   ·   Esc cancela"),
            (_, Mode::Window) => t("Clic en una ventana para capturarla   ·   Espacio: área   ·   Esc cancela"),
            (_, Mode::Area) => t("Arrastra para capturar   ·   Clic: ventana   ·   F: pantalla   ·   Flechas: 1 px   ·   Esc cancela"),
        };
        let fmt = gfx::ui_center(12.5 * k, gfx::W_MEDIUM);
        let (tw, th) = gfx::measure(text, &fmt);
        let (pw, ph) = (tw + 28.0 * k, th + 14.0 * k);
        let x = mon.x as f32 + (mon.w as f32 - pw) / 2.0;
        let y = mon.y as f32 + 22.0 * k;
        // Keep the hint out of the way when the cursor is right under it.
        let (cx, cy) = (self.cursor.0 as f32, self.cursor.1 as f32);
        let y = if cy < y + ph + 40.0 * k && cx > x - 40.0 * k && cx < x + pw + 40.0 * k {
            mon.bottom() as f32 - ph - 28.0 * k
        } else {
            y
        };
        let pill = rounded(rxywh(x, y, pw, ph), ph / 2.0);
        rt.FillRoundedRectangle(&pill, &brush(rt, theme::PANEL, 0.92));
        rt.DrawRoundedRectangle(&pill, &brush(rt, theme::WHITE, 0.10), 1.0, None);
        let dot = 3.0 * k;
        rt.FillEllipse(&gfx::ellipse(x + 15.0 * k, y + ph / 2.0, dot, dot), &brush(rt, theme::BLUE, 1.0));
        gfx::draw_text(rt, text, &fmt, rxywh(x + 6.0 * k, y, pw, ph), &brush(rt, theme::TEXT, 0.92));
    }

    fn invalidate(hwnd: HWND) {
        unsafe {
            let _ = InvalidateRect(Some(hwnd), None, false);
        }
    }

    fn nudge(&mut self, dx: i32, dy: i32) {
        let o = self.snap.origin;
        let (w, h) = self.size();
        let nx = (self.cursor.0 + dx).clamp(0, w - 1);
        let ny = (self.cursor.1 + dy).clamp(0, h - 1);
        unsafe {
            let _ = SetCursorPos(nx + o.0, ny + o.1);
        }
    }
}

impl Handler for Overlay {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_SETCURSOR => {
                unsafe {
                    SetCursor(LoadCursorW(None, IDC_CROSS).ok());
                }
                Some(LRESULT(1))
            }
            WM_ERASEBKGND => Some(LRESULT(1)),
            WM_PAINT => {
                self.render(hwnd);
                unsafe {
                    let _ = ValidateRect(Some(hwnd), None);
                }
                Some(LRESULT(0))
            }
            WM_MOUSEMOVE => {
                let p = lparam_xy(lp);
                if p != self.cursor {
                    self.cursor = p;
                    self.square = wp.0 & 0x0004 != 0; // MK_SHIFT
                    if let Some(d) = self.down {
                        if self.mode == Mode::Area && !self.dragging && ((p.0 - d.0).abs() > 3 || (p.1 - d.1).abs() > 3) {
                            self.dragging = true;
                        }
                    }
                    Self::invalidate(hwnd);
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONDOWN => {
                self.cursor = lparam_xy(lp);
                self.down = Some(self.cursor);
                unsafe {
                    SetCapture(hwnd);
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONUP => {
                unsafe {
                    let _ = ReleaseCapture();
                }
                self.cursor = lparam_xy(lp);
                if self.dragging {
                    match self.selection() {
                        Some(s) if s.w >= 2 && s.h >= 2 => self.finish(hwnd, s),
                        _ => {
                            self.dragging = false;
                            self.down = None;
                            Self::invalidate(hwnd);
                        }
                    }
                } else if self.down.is_some() {
                    self.down = None;
                    if let Some(r) = self.hover() {
                        self.finish(hwnd, r);
                    }
                }
                Some(LRESULT(0))
            }
            WM_RBUTTONUP => {
                if self.dragging {
                    self.dragging = false;
                    self.down = None;
                    unsafe {
                        let _ = ReleaseCapture();
                    }
                    Self::invalidate(hwnd);
                } else {
                    self.cancel(hwnd);
                }
                Some(LRESULT(0))
            }
            WM_KEYDOWN => {
                let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
                let step = if shift { 10 } else { 1 };
                match wp.0 as u16 {
                    k if k == VK_ESCAPE.0 => {
                        if self.dragging {
                            self.dragging = false;
                            self.down = None;
                            unsafe {
                                let _ = ReleaseCapture();
                            }
                            Self::invalidate(hwnd);
                        } else {
                            self.cancel(hwnd);
                        }
                    }
                    k if k == VK_RETURN.0 => {
                        if let Some(r) = self.selection().or_else(|| self.hover()) {
                            self.finish(hwnd, r);
                        }
                    }
                    k if k == VK_LEFT.0 => self.nudge(-step, 0),
                    k if k == VK_RIGHT.0 => self.nudge(step, 0),
                    k if k == VK_UP.0 => self.nudge(0, -step),
                    k if k == VK_DOWN.0 => self.nudge(0, step),
                    k if k == VK_SPACE.0 => {
                        self.mode = if self.mode == Mode::Area { Mode::Window } else { Mode::Area };
                        self.dragging = false;
                        Self::invalidate(hwnd);
                    }
                    k if k == b'F' as u16 => {
                        let (m, _) = self.monitor_client(self.cursor.0, self.cursor.1);
                        self.finish(hwnd, m);
                    }
                    k if k == b'M' as u16 => {
                        self.magnifier = !self.magnifier;
                        Self::invalidate(hwnd);
                    }
                    k if k == b'C' as u16 => {
                        if let Some((r, g, b)) = self.snap.image.rgb(self.cursor.0, self.cursor.1) {
                            let hex = format!("#{r:02X}{g:02X}{b:02X}");
                            app::post(AppEvent::CopyText(hex.clone(), tf("Color {} copiado", &[&hex])));
                        }
                    }
                    _ => {}
                }
                Some(LRESULT(0))
            }
            WM_ACTIVATE => {
                if util::loword(wp.0) == WA_INACTIVE {
                    if self.was_active {
                        self.cancel(hwnd);
                    }
                } else {
                    self.was_active = true;
                }
                None
            }
            _ => None,
        }
    }
}


/// Renders the overlay offscreen (used by `--preview` to check the design).
pub fn preview(snap: Snapshot, cursor: (i32, i32), down: Option<(i32, i32)>, mode: Mode) -> Option<Image> {
    let (w, h) = (snap.image.width, snap.image.height);
    let mut ov = Overlay {
        snap: Arc::new(snap),
        mode,
        purpose: Purpose::Capture,
        magnifier: true,
        crosshair: true,
        rt: None,
        tiles: None,
        cursor,
        down,
        dragging: down.is_some(),
        square: false,
        finished: false,
        was_active: true,
    };
    let (bmp, rt) = gfx::wic_target(w, h).ok()?;
    ov.tiles = TiledBitmap::new(&rt, &ov.snap.image).ok();
    unsafe {
        rt.BeginDraw();
        ov.paint(&rt);
        rt.EndDraw(None, None).ok()?;
    }
    gfx::wic_bitmap_to_image(&bmp).ok()
}
