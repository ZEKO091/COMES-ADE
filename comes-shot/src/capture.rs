//! Screen capture. The process is per-monitor DPI aware (v2), so every
//! coordinate here is a physical pixel: a 4K display yields a 3840x2160 image.

use std::time::Instant;

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmFlush, DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GdiFlush, GetDC, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC, HMONITOR, MONITORINFO,
    MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetSystemMetrics, GetWindowLongW, GetWindowTextW,
    IsIconic, IsWindowVisible, GWL_EXSTYLE, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WS_EX_TRANSPARENT,
};

use crate::image::Image;
use crate::util::{from_wide, Rect};

#[derive(Clone, Debug)]
pub struct Monitor {
    pub rect: Rect,
    pub work: Rect,
    pub dpi: u32,
    pub primary: bool,
}

impl Monitor {
    pub fn scale(&self) -> f32 {
        self.dpi as f32 / 96.0
    }
}

#[derive(Clone, Debug)]
pub struct WinInfo {
    pub rect: Rect,
    pub title: String,
}

/// A frozen copy of the whole desktop plus the window layout at that instant.
pub struct Snapshot {
    /// Top-left of the virtual screen (can be negative with monitors left of the primary).
    pub origin: (i32, i32),
    pub image: Image,
    pub monitors: Vec<Monitor>,
    /// Visible top-level windows, front to back, in virtual-screen coordinates.
    pub windows: Vec<WinInfo>,
}

impl Snapshot {
    pub fn monitor_at(&self, x: i32, y: i32) -> &Monitor {
        self.monitors
            .iter()
            .find(|m| m.rect.contains(x, y))
            .or_else(|| self.monitors.iter().find(|m| m.primary))
            .unwrap_or(&self.monitors[0])
    }
}

pub fn virtual_rect() -> Rect {
    unsafe {
        Rect::new(
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

pub fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn proc(hmon: HMONITOR, _: HDC, _: *mut RECT, lp: LPARAM) -> BOOL {
        let list = &mut *(lp.0 as *mut Vec<Monitor>);
        if let Some(m) = monitor_info(hmon) {
            list.push(m);
        }
        BOOL(1)
    }
    let mut list: Vec<Monitor> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(proc), LPARAM(&mut list as *mut _ as isize));
    }
    if list.is_empty() {
        let r = virtual_rect();
        list.push(Monitor { rect: r, work: r, dpi: 96, primary: true });
    }
    list
}

fn monitor_info(hmon: HMONITOR) -> Option<Monitor> {
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(hmon, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
            return None;
        }
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        Some(Monitor {
            rect: Rect::from_win(&info.monitorInfo.rcMonitor),
            work: Rect::from_win(&info.monitorInfo.rcWork),
            dpi: dx.max(96),
            primary: info.monitorInfo.dwFlags & 1 != 0,
        })
    }
}

/// The monitor under a point (nearest one if the point is off-screen).
pub fn monitor_at(x: i32, y: i32) -> Monitor {
    unsafe {
        let hmon = MonitorFromPoint(windows::Win32::Foundation::POINT { x, y }, MONITOR_DEFAULTTONEAREST);
        monitor_info(hmon).unwrap_or_else(|| monitors().remove(0))
    }
}

/// Copies a rectangle of the screen (virtual-screen coordinates).
/// DXGI Desktop Duplication first (a few ms); GDI if it isn't available.
pub fn grab(r: Rect) -> windows::core::Result<Image> {
    let t = Instant::now();
    if let Some(img) = crate::dxgi::grab(r) {
        log(&format!("grab DXGI {}x{} in {:?}", r.w, r.h, t.elapsed()));
        return Ok(img);
    }
    grab_gdi(r)
}

/// GDI copy of the DWM-composed desktop, including layered windows.
pub fn grab_gdi(r: Rect) -> windows::core::Result<Image> {
    let t = Instant::now();
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: r.w,
                biHeight: -r.h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let dib = match CreateDIBSection(Some(mem), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(b) => b,
            Err(e) => {
                let _ = DeleteDC(mem);
                ReleaseDC(None, screen);
                return Err(e);
            }
        };
        let old = SelectObject(mem, dib.into());
        let res = BitBlt(mem, 0, 0, r.w, r.h, Some(screen), r.x, r.y, SRCCOPY | CAPTUREBLT);
        let _ = GdiFlush();
        let len = (r.w * r.h) as usize;
        let mut data = vec![0u8; len * 4];
        if res.is_ok() && !bits.is_null() {
            std::ptr::copy_nonoverlapping(bits as *const u8, data.as_mut_ptr(), len * 4);
        }
        SelectObject(mem, old);
        let _ = DeleteObject(dib.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        res?;
        // GDI leaves the alpha byte undefined; captures are always opaque.
        let (_, px, _) = data.align_to_mut::<u32>();
        for p in px {
            *p |= 0xFF00_0000;
        }
        log(&format!("grab GDI {}x{} in {:?}", r.w, r.h, t.elapsed()));
        Ok(Image::new(r.w as u32, r.h as u32, data))
    }
}

/// Waits for DWM to compose a frame (used after hiding our own windows).
pub fn flush_compositor() {
    unsafe {
        let _ = DwmFlush();
    }
}

pub fn snapshot() -> windows::core::Result<Snapshot> {
    let vr = virtual_rect();
    let windows = visible_windows(&vr);
    let image = grab(vr)?;
    Ok(Snapshot { origin: (vr.x, vr.y), image, monitors: monitors(), windows })
}

fn visible_windows(bounds: &Rect) -> Vec<WinInfo> {
    struct Ctx {
        list: Vec<WinInfo>,
        bounds: Rect,
    }
    unsafe extern "system" fn proc(hwnd: HWND, lp: LPARAM) -> BOOL {
        let ctx = &mut *(lp.0 as *mut Ctx);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TRANSPARENT.0 != 0 {
            return BOOL(1);
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as _, 4);
        if cloaked != 0 {
            return BOOL(1);
        }
        let mut class = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut class);
        let class = String::from_utf16_lossy(&class[..n.max(0) as usize]);
        // Our own transient surfaces are never capture targets; the editor
        // and pinned images are, like any other window.
        let ours = ["ComesShot.Overlay", "ComesShot.Quick", "ComesShot.Hud", "ComesShot.Main"];
        if class == "Progman" || class == "WorkerW" || ours.contains(&class.as_str()) {
            return BOOL(1);
        }
        let mut r = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as _,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_err()
        {
            return BOOL(1);
        }
        let rect = match Rect::from_win(&r).intersect(&ctx.bounds) {
            Some(r) if r.w > 4 && r.h > 4 => r,
            _ => return BOOL(1),
        };
        let mut title = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut title);
        ctx.list.push(WinInfo { rect, title: from_wide(&title[..len.max(0) as usize]) });
        BOOL(1)
    }
    let mut ctx = Ctx { list: Vec::new(), bounds: *bounds };
    unsafe {
        let _ = EnumWindows(Some(proc), LPARAM(&mut ctx as *mut Ctx as isize));
    }
    ctx.list
}

pub fn log(msg: &str) {
    if cfg!(debug_assertions) {
        eprintln!("[comes-shot] {msg}");
    }
}
