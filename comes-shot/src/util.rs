//! Small shared helpers: geometry, wide strings, Win32 message plumbing.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, PostMessageW, WM_CLOSE};

/// Integer rectangle in physical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
    pub fn from_ltrb(l: i32, t: i32, r: i32, b: i32) -> Self {
        Self { x: l, y: t, w: r - l, h: b - t }
    }
    pub fn from_points(a: (i32, i32), b: (i32, i32)) -> Self {
        Self::from_ltrb(a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1))
    }
    pub fn from_win(r: &RECT) -> Self {
        Self::from_ltrb(r.left, r.top, r.right, r.bottom)
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.right() && y < self.bottom()
    }
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
    pub fn offset(&self, dx: i32, dy: i32) -> Self {
        Self::new(self.x + dx, self.y + dy, self.w, self.h)
    }
    pub fn intersect(&self, o: &Rect) -> Option<Rect> {
        let l = self.x.max(o.x);
        let t = self.y.max(o.y);
        let r = self.right().min(o.right());
        let b = self.bottom().min(o.bottom());
        (r > l && b > t).then(|| Rect::from_ltrb(l, t, r, b))
    }
}

/// Null-terminated UTF-16 buffer.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// UTF-16 without terminator (DirectWrite wants exact lengths).
pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Keeps a wide string alive while handing out a PCWSTR.
pub struct WStr(Vec<u16>);
impl WStr {
    pub fn new(s: &str) -> Self {
        Self(wide(s))
    }
    pub fn p(&self) -> PCWSTR {
        PCWSTR(self.0.as_ptr())
    }
}

pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

pub fn lparam_xy(lp: LPARAM) -> (i32, i32) {
    let x = (lp.0 & 0xFFFF) as u16 as i16 as i32;
    let y = ((lp.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
    (x, y)
}

pub fn loword(v: usize) -> u32 {
    (v & 0xFFFF) as u32
}

pub fn hiword(v: usize) -> u32 {
    ((v >> 16) & 0xFFFF) as u32
}

/// Closes a window on the next message dispatch, so the caller can finish
/// using its state before the window is torn down.
pub fn post_close(hwnd: HWND) {
    unsafe {
        let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
    }
}

pub fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0) - 1.0;
    t * t * t + 1.0
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_math() {
        let a = Rect::new(0, 0, 100, 50);
        let b = Rect::new(80, 40, 50, 50);
        assert_eq!(a.intersect(&b), Some(Rect::new(80, 40, 20, 10)));
        assert_eq!(a.intersect(&Rect::new(200, 0, 5, 5)), None);
        assert_eq!(Rect::from_points((10, 20), (4, 2)), Rect::new(4, 2, 6, 18));
        assert!(a.contains(99, 49) && !a.contains(100, 49));
    }
}
