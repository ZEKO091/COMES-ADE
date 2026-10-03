//! Fast capture with DXGI Desktop Duplication: reads the frame the GPU has
//! already composed instead of asking GDI to copy the screen.
//!
//! The duplication objects are created once (at startup) and kept alive, and
//! each output keeps a GPU copy of its latest frame. A capture then costs one
//! GPU copy, one read-back of only the requested pixels and one memcpy —
//! a few milliseconds even for the whole desktop.

use std::cell::RefCell;
use std::time::Instant;

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_MODE_ROTATION_IDENTITY, DXGI_MODE_ROTATION_UNSPECIFIED, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource,
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};

use crate::image::Image;
use crate::util::Rect;

struct Output {
    /// Desktop coordinates (physical pixels).
    rect: Rect,
    output: IDXGIOutput1,
    dup: Option<IDXGIOutputDuplication>,
    /// GPU copy of the latest composed frame.
    frame: Option<ID3D11Texture2D>,
    /// CPU-readable texture, same size as the output.
    staging: Option<ID3D11Texture2D>,
}

struct Adapter {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    outputs: Vec<Output>,
}

struct Duplicator {
    adapters: Vec<Adapter>,
}

thread_local! {
    static DUP: RefCell<Option<Duplicator>> = const { RefCell::new(None) };
    /// Set when duplication is unavailable on this machine; GDI is used instead.
    static DISABLED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn log(msg: &str) {
    crate::capture::log(msg);
}

impl Duplicator {
    fn new() -> windows::core::Result<Self> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
        let mut adapters = Vec::new();
        let mut i = 0;
        while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
            i += 1;
            let outputs = Self::outputs(&adapter);
            if outputs.is_empty() {
                continue;
            }
            let mut device = None;
            let mut ctx = None;
            let levels = [D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0];
            let created = unsafe {
                D3D11CreateDevice(
                    &adapter,
                    D3D_DRIVER_TYPE_UNKNOWN,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut ctx),
                )
            };
            if let (Ok(()), Some(device), Some(ctx)) = (created, device, ctx) {
                adapters.push(Adapter { device, ctx, outputs });
            }
        }
        Ok(Self { adapters })
    }

    fn outputs(adapter: &IDXGIAdapter1) -> Vec<Output> {
        let mut v = Vec::new();
        let mut j = 0;
        while let Ok(out) = unsafe { adapter.EnumOutputs(j) } {
            j += 1;
            let Ok(desc) = (unsafe { out.GetDesc() }) else { continue };
            if !desc.AttachedToDesktop.as_bool() {
                continue;
            }
            // Rotated displays come back unrotated; leave those to GDI.
            if desc.Rotation != DXGI_MODE_ROTATION_IDENTITY && desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED {
                continue;
            }
            if let Ok(output) = out.cast::<IDXGIOutput1>() {
                v.push(Output { rect: Rect::from_win(&desc.DesktopCoordinates), output, dup: None, frame: None, staging: None });
            }
        }
        v
    }
}

fn texture(device: &ID3D11Device, w: u32, h: u32, staging: bool) -> windows::core::Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: if staging { D3D11_USAGE_STAGING } else { D3D11_USAGE_DEFAULT },
        BindFlags: 0,
        CPUAccessFlags: if staging { D3D11_CPU_ACCESS_READ.0 as u32 } else { 0 },
        MiscFlags: 0,
    };
    let mut tex = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex))? };
    tex.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
}

impl Output {
    /// Makes `frame` hold the current desktop image of this output.
    fn refresh(&mut self, device: &ID3D11Device, ctx: &ID3D11DeviceContext) -> windows::core::Result<()> {
        for attempt in 0..2 {
            if self.dup.is_none() {
                self.dup = Some(unsafe { self.output.DuplicateOutput(device)? });
                self.frame = None;
            }
            let dup = self.dup.as_ref().unwrap();
            // A fresh duplication delivers its first frame on the next refresh.
            let timeout = if self.frame.is_none() { 200 } else { 0 };
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut res: Option<IDXGIResource> = None;
            match unsafe { dup.AcquireNextFrame(timeout, &mut info, &mut res) } {
                Ok(()) => {
                    let result = (|| {
                        // Mouse-only updates carry no new image.
                        if info.LastPresentTime != 0 || self.frame.is_none() {
                            let src: ID3D11Texture2D = res.as_ref().ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?.cast()?;
                            if self.frame.is_none() {
                                let mut d = D3D11_TEXTURE2D_DESC::default();
                                unsafe { src.GetDesc(&mut d) };
                                self.frame = Some(texture(device, d.Width, d.Height, false)?);
                            }
                            unsafe { ctx.CopyResource(self.frame.as_ref().unwrap(), &src) };
                        }
                        Ok(())
                    })();
                    unsafe {
                        let _ = dup.ReleaseFrame();
                    }
                    return result;
                }
                // Nothing changed since the last frame we copied: it is still current.
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT && self.frame.is_some() => return Ok(()),
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST && attempt == 0 => {
                    // Mode change, secure desktop, full-screen switch: start over.
                    self.dup = None;
                    self.frame = None;
                }
                Err(e) => return Err(e),
            }
        }
        Err(windows::core::Error::from(DXGI_ERROR_ACCESS_LOST))
    }

    /// Phase 1: queue the GPU copy of the part of `r` this output covers.
    /// Returns that part, or None if the output doesn't touch `r`.
    fn queue(&mut self, device: &ID3D11Device, ctx: &ID3D11DeviceContext, r: &Rect) -> windows::core::Result<Option<Rect>> {
        let Some(part) = self.rect.intersect(r) else { return Ok(None) };
        self.refresh(device, ctx)?;
        if self.staging.is_none() {
            self.staging = Some(texture(device, self.rect.w as u32, self.rect.h as u32, true)?);
        }
        let (lx, ly) = (part.x - self.rect.x, part.y - self.rect.y);
        let b = D3D11_BOX { left: lx as u32, top: ly as u32, front: 0, right: (lx + part.w) as u32, bottom: (ly + part.h) as u32, back: 1 };
        // Only the requested pixels travel back from the GPU.
        unsafe { ctx.CopySubresourceRegion(self.staging.as_ref().unwrap(), 0, 0, 0, 0, self.frame.as_ref().unwrap(), 0, Some(&b)) };
        Ok(Some(part))
    }

    /// Phase 2: read the queued pixels into `out` (r.w x r.h BGRA).
    fn read(&self, ctx: &ID3D11DeviceContext, part: Rect, r: &Rect, out: &mut [u8]) -> windows::core::Result<()> {
        let staging = self.staging.as_ref().unwrap();
        unsafe {
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            ctx.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
            let src = m.pData as *const u32;
            let pitch = (m.RowPitch / 4) as usize;
            let dst = out.as_mut_ptr() as *mut u32;
            let ox = (part.x - r.x) as usize;
            let oy = (part.y - r.y) as usize;
            let rw = r.w as usize;
            for y in 0..part.h as usize {
                let s = std::slice::from_raw_parts(src.add(y * pitch), part.w as usize);
                let d = std::slice::from_raw_parts_mut(dst.add((oy + y) * rw + ox), part.w as usize);
                // Copy and force opaque alpha in one pass.
                for (dp, sp) in d.iter_mut().zip(s) {
                    *dp = *sp | 0xFF00_0000;
                }
            }
            ctx.Unmap(staging, 0);
        }
        Ok(())
    }
}

/// Creates the duplication objects and grabs a first frame from each display,
/// so later captures are fast. Safe to call again after a display change.
pub fn init() {
    let t = Instant::now();
    DISABLED.with(|d| d.set(false));
    let dup = match Duplicator::new() {
        Ok(mut d) => {
            let mut ok = !d.adapters.is_empty();
            for a in &mut d.adapters {
                for o in &mut a.outputs {
                    if let Err(e) = o.refresh(&a.device, &a.ctx) {
                        log(&format!("duplicación no disponible: {e}"));
                        ok = false;
                    }
                }
            }
            ok.then_some(d)
        }
        Err(e) => {
            log(&format!("DXGI no disponible: {e}"));
            None
        }
    };
    if dup.is_none() {
        DISABLED.with(|d| d.set(true));
    }
    log(&format!("DXGI listo en {:?}", t.elapsed()));
    DUP.with(|d| *d.borrow_mut() = dup);
}

/// Drops everything; the next capture re-initialises (display layout changed).
pub fn reset() {
    DUP.with(|d| *d.borrow_mut() = None);
    DISABLED.with(|d| d.set(false));
}

/// Captures a rectangle of the desktop, or None if duplication can't serve it
/// (the caller then falls back to GDI).
pub fn grab(r: Rect) -> Option<Image> {
    if DISABLED.with(|d| d.get()) {
        return None;
    }
    if DUP.with(|d| d.borrow().is_none()) {
        init();
    }
    DUP.with(|d| {
        let mut guard = d.borrow_mut();
        let dup = guard.as_mut()?;
        // Every pixel of the rectangle must come from a duplicated output.
        let covered: i64 = dup
            .adapters
            .iter()
            .flat_map(|a| a.outputs.iter())
            .filter_map(|o| o.rect.intersect(&r))
            .map(|p| p.w as i64 * p.h as i64)
            .sum();
        let monitors_area: i64 = crate::capture::monitors()
            .iter()
            .filter_map(|m| m.rect.intersect(&r))
            .map(|p| p.w as i64 * p.h as i64)
            .sum();
        if covered < monitors_area {
            return None;
        }
        let trace = std::env::var_os("COMESSHOT_TRACE").is_some();
        let t0 = Instant::now();
        // Phase 1: every output queues its GPU copy, so the copies overlap.
        let mut parts: Vec<(usize, usize, Rect)> = Vec::new();
        for (ai, a) in dup.adapters.iter_mut().enumerate() {
            for (oi, o) in a.outputs.iter_mut().enumerate() {
                match o.queue(&a.device, &a.ctx, &r) {
                    Ok(Some(part)) => parts.push((ai, oi, part)),
                    Ok(None) => {}
                    Err(e) => {
                        log(&format!("DXGI falló ({e}); uso GDI"));
                        o.dup = None;
                        o.frame = None;
                        return None;
                    }
                }
            }
            unsafe { a.ctx.Flush() };
        }
        let t1 = Instant::now();
        let len = (r.w * r.h * 4) as usize;
        let mut out = take_buffer(len);
        if covered < r.w as i64 * r.h as i64 {
            // Gaps between displays: opaque black.
            for px in out.chunks_exact_mut(4) {
                px.copy_from_slice(&[0, 0, 0, 255]);
            }
        }
        let t2 = Instant::now();
        // Phase 2: read back.
        for (ai, oi, part) in parts {
            let a = &dup.adapters[ai];
            if let Err(e) = a.outputs[oi].read(&a.ctx, part, &r, &mut out) {
                log(&format!("DXGI falló ({e}); uso GDI"));
                return None;
            }
        }
        if trace {
            eprintln!("  copias GPU {:?} · búfer {:?} · lectura {:?}", t1 - t0, t2 - t1, t2.elapsed());
        }
        refill_buffer(len);
        Some(Image::new(r.w as u32, r.h as u32, out))
    })
}

/// A pre-faulted buffer for the next capture: touching 16 MB of fresh memory
/// costs thousands of page faults, so it is done in the background instead.
static SPARE: std::sync::Mutex<Option<Vec<u8>>> = std::sync::Mutex::new(None);

fn take_buffer(len: usize) -> Vec<u8> {
    if let Some(v) = SPARE.lock().unwrap().take() {
        if v.len() == len {
            return v;
        }
    }
    vec![0u8; len]
}

fn refill_buffer(len: usize) {
    std::thread::spawn(move || {
        let mut v = vec![0u8; len];
        // Write one byte per page so the OS commits every page now.
        for i in (0..len).step_by(4096) {
            unsafe { std::ptr::write_volatile(v.as_mut_ptr().add(i), 0) };
        }
        *SPARE.lock().unwrap() = Some(v);
    });
}

/// Prepares duplication and a warm buffer for a full-desktop capture.
pub fn warm_up() {
    init();
    let vr = crate::capture::virtual_rect();
    refill_buffer((vr.w * vr.h * 4) as usize);
}
