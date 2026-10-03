//! Clipboard: images as CF_DIB (every app reads it) plus a PNG stream for
//! apps that prefer it, and plain Unicode text for OCR results.

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

use crate::image::Image;
use crate::util::wide;

const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;

fn open(owner: HWND) -> bool {
    for _ in 0..10 {
        if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    false
}

fn global_from(bytes: &[u8]) -> Option<HGLOBAL> {
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).ok()?;
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(Some(h));
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        Some(h)
    }
}

fn put(format: u32, bytes: &[u8]) -> bool {
    let Some(h) = global_from(bytes) else { return false };
    unsafe {
        if SetClipboardData(format, Some(HANDLE(h.0))).is_err() {
            let _ = GlobalFree(Some(h));
            return false;
        }
    }
    true
}

/// 32-bit bottom-up DIB, exact pixels.
pub fn dib_bytes(img: &Image) -> Vec<u8> {
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: img.width as i32,
        biHeight: img.height as i32,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: img.width * img.height * 4,
        ..Default::default()
    };
    let hsize = std::mem::size_of::<BITMAPINFOHEADER>();
    let mut out = Vec::with_capacity(hsize + img.data.len());
    out.extend_from_slice(unsafe { std::slice::from_raw_parts(&header as *const _ as *const u8, hsize) });
    let stride = img.stride() as usize;
    for y in (0..img.height as usize).rev() {
        out.extend_from_slice(&img.data[y * stride..(y + 1) * stride]);
    }
    out
}

pub fn set_image(owner: HWND, img: &Image, png: Option<&[u8]>) -> bool {
    let dib = dib_bytes(img);
    if !open(owner) {
        return false;
    }
    let ok = unsafe {
        let _ = EmptyClipboard();
        let ok = put(CF_DIB, &dib);
        if let Some(png) = png {
            let name = wide("PNG");
            let fmt = RegisterClipboardFormatW(windows::core::PCWSTR(name.as_ptr()));
            if fmt != 0 {
                put(fmt, png);
            }
        }
        ok
    };
    unsafe {
        let _ = CloseClipboard();
    }
    ok
}

pub fn set_text(owner: HWND, text: &str) -> bool {
    let mut w: Vec<u16> = text.replace("\r\n", "\n").replace('\n', "\r\n").encode_utf16().collect();
    w.push(0);
    let bytes = unsafe { std::slice::from_raw_parts(w.as_ptr() as *const u8, w.len() * 2) };
    if !open(owner) {
        return false;
    }
    let ok = unsafe {
        let _ = EmptyClipboard();
        put(CF_UNICODETEXT, bytes)
    };
    unsafe {
        let _ = CloseClipboard();
    }
    ok
}

pub fn get_text(owner: HWND) -> Option<String> {
    use windows::Win32::System::DataExchange::GetClipboardData;
    if !open(owner) {
        return None;
    }
    let out = unsafe {
        match GetClipboardData(CF_UNICODETEXT) {
            Ok(h) => {
                let g = HGLOBAL(h.0);
                let p = GlobalLock(g) as *const u16;
                let s = if p.is_null() {
                    None
                } else {
                    let mut len = 0;
                    while *p.add(len) != 0 {
                        len += 1;
                    }
                    Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, len)))
                };
                let _ = GlobalUnlock(g);
                s
            }
            Err(_) => None,
        }
    };
    unsafe {
        let _ = CloseClipboard();
    }
    out
}
