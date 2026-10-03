//! Minimal window framework: each window owns a boxed handler reached
//! through GWLP_USERDATA. One window procedure serves every class.

use std::collections::HashSet;
use std::cell::RefCell;

use windows::core::{Result, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetWindowLongPtrW, LoadCursorW, LoadIconW, RegisterClassExW,
    SetWindowLongPtrW, CREATESTRUCTW, CS_DBLCLKS, CS_DROPSHADOW, CS_HREDRAW, CS_VREDRAW,
    GWLP_USERDATA, HICON, IDC_ARROW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_NCCREATE, WM_NCDESTROY,
    WNDCLASSEXW,
};

use crate::util::{wide, Rect};

pub trait Handler {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT>;
}

thread_local! {
    static CLASSES: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    static PENDING: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub struct ClassOpts {
    pub shadow: bool,
}

fn ensure_class(name: &str, opts: &ClassOpts) {
    let known = CLASSES.with(|c| c.borrow().contains(name));
    if known {
        return;
    }
    unsafe {
        let hinst = GetModuleHandleW(None).unwrap_or_default();
        let cname = wide(name);
        let mut style = CS_DBLCLKS | CS_HREDRAW | CS_VREDRAW;
        if opts.shadow {
            style |= CS_DROPSHADOW;
        }
        let icon: HICON = LoadIconW(Some(hinst.into()), PCWSTR(1 as _)).unwrap_or_default();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style,
            lpfnWndProc: Some(wndproc),
            hInstance: hinst.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hIcon: icon,
            hIconSm: icon,
            hbrBackground: HBRUSH::default(),
            lpszClassName: PCWSTR(cname.as_ptr()),
            ..Default::default()
        };
        RegisterClassExW(&wc);
    }
    CLASSES.with(|c| c.borrow_mut().insert(name.to_string()));
}

/// Creates a window whose messages go to `handler`.
pub fn create(
    class: &str,
    title: &str,
    style: WINDOW_STYLE,
    ex_style: WINDOW_EX_STYLE,
    r: Rect,
    shadow: bool,
    handler: Box<dyn Handler>,
) -> Result<HWND> {
    create_owned(class, title, style, ex_style, r, shadow, None, handler)
}

/// Like `create`, with an owner window (the new window stays above it).
#[allow(clippy::too_many_arguments)]
pub fn create_owned(
    class: &str,
    title: &str,
    style: WINDOW_STYLE,
    ex_style: WINDOW_EX_STYLE,
    r: Rect,
    shadow: bool,
    owner: Option<HWND>,
    handler: Box<dyn Handler>,
) -> Result<HWND> {
    ensure_class(class, &ClassOpts { shadow });
    let cname = wide(class);
    let t = wide(title);
    let boxed: *mut Box<dyn Handler> = Box::into_raw(Box::new(handler));
    PENDING.with(|p| p.set(boxed as usize));
    unsafe {
        let hinst = GetModuleHandleW(None).unwrap_or_default();
        let res = CreateWindowExW(
            ex_style,
            PCWSTR(cname.as_ptr()),
            PCWSTR(t.as_ptr()),
            style,
            r.x,
            r.y,
            r.w,
            r.h,
            owner,
            None,
            Some(hinst.into()),
            Some(boxed as *const _),
        );
        // WM_NCCREATE claims the handler (and WM_NCDESTROY frees it); if the
        // window never got that far the handler is still ours to drop.
        if res.is_err() && PENDING.with(|p| p.replace(0)) == boxed as usize {
            drop(Box::from_raw(boxed));
        }
        PENDING.with(|p| p.set(0));
        res
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_NCCREATE {
        let cs = &*(lp.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize);
        PENDING.with(|p| {
            if p.get() == cs.lpCreateParams as usize {
                p.set(0);
            }
        });
    }
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Box<dyn Handler>;
    if ptr.is_null() {
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    if msg == WM_NCDESTROY {
        let _ = (*ptr).handle(hwnd, msg, wp, lp);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        drop(Box::from_raw(ptr));
        return DefWindowProcW(hwnd, msg, wp, lp);
    }
    match (*ptr).handle(hwnd, msg, wp, lp) {
        Some(r) => r,
        None => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

pub fn dwm_set<T>(hwnd: HWND, attr: i32, value: T) {
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(attr),
            &value as *const T as _,
            std::mem::size_of::<T>() as u32,
        );
    }
}

pub const DWMWA_USE_IMMERSIVE_DARK_MODE: i32 = 20;
pub const DWMWA_WINDOW_CORNER_PREFERENCE: i32 = 33;
pub const DWMWA_CAPTION_COLOR: i32 = 35;
pub const DWMWA_CLOAK: i32 = 13;
pub const DWMWCP_ROUND: u32 = 2;
pub const DWMWCP_ROUNDSMALL: u32 = 3;

/// COLORREF from 0xRRGGBB.
pub fn colorref(hex: u32) -> u32 {
    ((hex & 0xFF) << 16) | (hex & 0xFF00) | ((hex >> 16) & 0xFF)
}

pub fn dark_frame(hwnd: HWND, caption: u32) {
    dwm_set(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1i32);
    dwm_set(hwnd, DWMWA_CAPTION_COLOR, colorref(caption));
}

pub fn round_corners(hwnd: HWND, small: bool) {
    dwm_set(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, if small { DWMWCP_ROUNDSMALL } else { DWMWCP_ROUND });
}
