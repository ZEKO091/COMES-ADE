//! Pinned screenshots: always-on-top image windows. Drag to move, wheel to
//! zoom, Ctrl+wheel for opacity, double-click or Esc to close.

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Direct2D::Common::D2D_SIZE_U;
use windows::Win32::Graphics::Direct2D::{
    ID2D1Bitmap, ID2D1HwndRenderTarget, ID2D1RenderTarget, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR,
    D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR, D2D1_PRESENT_OPTIONS_NONE,
};
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_ESCAPE};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetWindowRect, SetForegroundWindow, SetLayeredWindowAttributes,
    SetWindowPos, ShowWindow, TrackPopupMenu, HTCAPTION, LWA_ALPHA, MF_CHECKED, MF_POPUP, MF_SEPARATOR, MF_STRING,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_SHOW, TPM_RETURNCMD, TPM_RIGHTBUTTON, WA_INACTIVE, WM_ACTIVATE, WM_ERASEBKGND,
    WM_KEYDOWN, WM_MOUSEWHEEL, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCRBUTTONUP, WM_PAINT, WM_SIZE, WS_EX_LAYERED,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

use crate::gfx::{self, brush, rf, rxywh};
use crate::i18n::t;
use crate::image::Image;
use crate::theme;
use crate::util::{self, Rect, WStr};
use crate::window::{self, Handler};
use crate::{app, capture, config, editor, hud, shell};

struct Pin {
    image: Image,
    scale: f32,
    opacity: u8,
    active: bool,
    size: (i32, i32),
    rt: Option<ID2D1HwndRenderTarget>,
    bmp: Option<ID2D1Bitmap>,
}

pub fn open(image: Image, at: Option<(i32, i32)>) {
    let (cx, cy) = at.unwrap_or_else(util::cursor_pos);
    let mon = capture::monitor_at(cx, cy);
    let (iw, ih) = (image.width as f32, image.height as f32);
    let scale = (mon.work.w as f32 * 0.8 / iw).min(mon.work.h as f32 * 0.8 / ih).min(1.0);
    let (w, h) = ((iw * scale).round() as i32, (ih * scale).round() as i32);
    let x = (mon.work.x + (mon.work.w - w) / 2).max(mon.work.x);
    let y = (mon.work.y + (mon.work.h - h) / 2).max(mon.work.y);
    let pin = Pin { image, scale, opacity: 255, active: false, size: (w, h), rt: None, bmp: None };
    let Ok(hwnd) = window::create(
        "ComesShot.Pin",
        t("Comes Shot · Fijada"),
        WS_POPUP,
        WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
        Rect::new(x, y, w.max(8), h.max(8)),
        true,
        Box::new(pin),
    ) else {
        return;
    };
    unsafe {
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
    }
}

impl Pin {
    fn render(&mut self, hwnd: HWND) {
        if self.rt.is_none() {
            self.rt = gfx::hwnd_target(hwnd, self.size.0 as u32, self.size.1 as u32, D2D1_PRESENT_OPTIONS_NONE).ok();
            self.bmp = None;
        }
        let Some(hrt) = self.rt.clone() else { return };
        let rt: ID2D1RenderTarget = hrt.into();
        if self.bmp.is_none() {
            self.bmp = gfx::bitmap(&rt, &self.image).ok();
        }
        let (w, h) = (self.size.0 as f32, self.size.1 as f32);
        unsafe {
            rt.BeginDraw();
            rt.Clear(Some(&gfx::col(theme::PANEL, 1.0)));
            if let Some(b) = &self.bmp {
                let mode = if (self.scale - 1.0).abs() < 0.001 || self.scale > 2.0 {
                    D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR
                } else {
                    D2D1_BITMAP_INTERPOLATION_MODE_LINEAR
                };
                rt.DrawBitmap(b, Some(&rxywh(0.0, 0.0, w, h)), 1.0, mode, None);
            }
            let (c, a) = if self.active { (theme::BLUE, 1.0) } else { (theme::WHITE, 0.18) };
            rt.DrawRectangle(&rf(0.5, 0.5, w - 0.5, h - 0.5), &brush(&rt, c, a), 1.0, None);
            if rt.EndDraw(None, None).is_err() {
                self.rt = None;
            }
        }
    }

    fn set_scale(&mut self, hwnd: HWND, scale: f32, anchor: Option<(i32, i32)>) {
        let scale = scale.clamp(0.05, 8.0);
        let (iw, ih) = (self.image.width as f32, self.image.height as f32);
        let (nw, nh) = ((iw * scale).round().max(24.0) as i32, (ih * scale).round().max(24.0) as i32);
        let mut wr = windows::Win32::Foundation::RECT::default();
        unsafe {
            let _ = GetWindowRect(hwnd, &mut wr);
        }
        // Keep the point under the cursor in place.
        let (ax, ay) = anchor.unwrap_or(((wr.left + wr.right) / 2, (wr.top + wr.bottom) / 2));
        let fx = (ax - wr.left) as f32 / (wr.right - wr.left).max(1) as f32;
        let fy = (ay - wr.top) as f32 / (wr.bottom - wr.top).max(1) as f32;
        let nx = ax - (fx * nw as f32) as i32;
        let ny = ay - (fy * nh as f32) as i32;
        self.scale = scale;
        unsafe {
            let _ = SetWindowPos(hwnd, None, nx, ny, nw, nh, SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }

    fn set_opacity(&mut self, hwnd: HWND, a: u8) {
        self.opacity = a.max(40);
        unsafe {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), self.opacity, LWA_ALPHA);
        }
    }

    fn save_as(&self, hwnd: HWND) {
        let cfg = config::get();
        let name = app::next_capture_path(&cfg);
        let stem = name.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if let Some(p) = shell::save_dialog(Some(hwnd), std::path::Path::new(&cfg.save_dir), &stem, cfg.extension()) {
            app::save_async(self.image.clone(), p);
            hud::show(t("Imagen guardada"));
        }
    }

    fn menu(&mut self, hwnd: HWND) {
        unsafe {
            let Ok(m) = CreatePopupMenu() else { return };
            let add = |m: windows::Win32::UI::WindowsAndMessaging::HMENU, id: usize, label: &str, checked: bool| {
                let w = WStr::new(label);
                let _ = AppendMenuW(m, if checked { MF_STRING | MF_CHECKED } else { MF_STRING }, id, w.p());
            };
            add(m, 1, &format!("{}\tCtrl+C", t("Copiar")), false);
            add(m, 2, &format!("{}\tCtrl+S", t("Guardar como…")), false);
            add(m, 3, &format!("{}\tE", t("Anotar")), false);
            let _ = AppendMenuW(m, MF_SEPARATOR, 0, windows::core::PCWSTR::null());
            add(m, 4, &format!("{}\t1", t("Tamaño original (100 %)")), (self.scale - 1.0).abs() < 0.001);
            let op = CreatePopupMenu().unwrap_or_default();
            for (i, v) in [100u32, 80, 60, 40].iter().enumerate() {
                add(op, 10 + i, &format!("{v} %"), (self.opacity as u32 * 100 / 255).abs_diff(*v) <= 2);
            }
            let label = WStr::new(t("Opacidad"));
            let _ = AppendMenuW(m, MF_POPUP, op.0 as usize, label.p());
            let _ = AppendMenuW(m, MF_SEPARATOR, 0, windows::core::PCWSTR::null());
            add(m, 5, &format!("{}\tEsc", t("Cerrar")), false);
            let (x, y) = util::cursor_pos();
            let cmd = TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_RETURNCMD, x, y, None, hwnd, None).0;
            let _ = DestroyMenu(m);
            match cmd {
                1 => {
                    if app::copy_image(&self.image) {
                        hud::show(t("Copiado al portapapeles"));
                    }
                }
                2 => self.save_as(hwnd),
                3 => {
                    editor::open(self.image.clone(), None);
                    util::post_close(hwnd);
                }
                4 => self.set_scale(hwnd, 1.0, None),
                5 => util::post_close(hwnd),
                10..=13 => {
                    let v = [255u8, 204, 153, 102][(cmd - 10) as usize];
                    self.set_opacity(hwnd, v);
                }
                _ => {}
            }
        }
    }
}

impl Handler for Pin {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        match msg {
            WM_NCHITTEST => Some(LRESULT(HTCAPTION as isize)),
            WM_ERASEBKGND => Some(LRESULT(1)),
            WM_PAINT => {
                self.render(hwnd);
                unsafe {
                    let _ = ValidateRect(Some(hwnd), None);
                }
                Some(LRESULT(0))
            }
            WM_SIZE => {
                let (w, h) = (util::loword(lp.0 as usize) as i32, util::hiword(lp.0 as usize) as i32);
                self.size = (w.max(1), h.max(1));
                if let Some(rt) = &self.rt {
                    unsafe {
                        let _ = rt.Resize(&D2D_SIZE_U { width: w.max(1) as u32, height: h.max(1) as u32 });
                    }
                }
                unsafe {
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                Some(LRESULT(0))
            }
            WM_ACTIVATE => {
                self.active = util::loword(wp.0) != WA_INACTIVE;
                unsafe {
                    let _ = InvalidateRect(Some(hwnd), None, false);
                }
                None
            }
            WM_NCLBUTTONDBLCLK => {
                util::post_close(hwnd);
                Some(LRESULT(0))
            }
            WM_NCRBUTTONUP => {
                self.menu(hwnd);
                Some(LRESULT(0))
            }
            WM_MOUSEWHEEL => {
                let delta = (util::hiword(wp.0) as u16 as i16) as f32 / 120.0;
                let ctrl = unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0;
                if ctrl {
                    let a = (self.opacity as f32 + delta * 20.0).clamp(40.0, 255.0) as u8;
                    self.set_opacity(hwnd, a);
                } else {
                    let s = self.scale * 1.1f32.powf(delta);
                    self.set_scale(hwnd, s, Some(util::lparam_xy(lp)));
                }
                Some(LRESULT(0))
            }
            WM_KEYDOWN => {
                let ctrl = unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0;
                match wp.0 as u16 {
                    k if k == VK_ESCAPE.0 => util::post_close(hwnd),
                    k if k == b'C' as u16 && ctrl => {
                        if app::copy_image(&self.image) {
                            hud::show(t("Copiado al portapapeles"));
                        }
                    }
                    k if k == b'S' as u16 && ctrl => self.save_as(hwnd),
                    k if k == b'E' as u16 => {
                        editor::open(self.image.clone(), None);
                        util::post_close(hwnd);
                    }
                    k if k == b'1' as u16 => self.set_scale(hwnd, 1.0, None),
                    0xBB | 0x6B => self.set_scale(hwnd, self.scale * 1.1, None), // +
                    0xBD | 0x6D => self.set_scale(hwnd, self.scale / 1.1, None), // -
                    _ => {}
                }
                Some(LRESULT(0))
            }
            _ => None,
        }
    }
}
