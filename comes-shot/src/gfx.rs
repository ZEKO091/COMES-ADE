//! Direct2D / DirectWrite / WIC helpers shared by every window.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;

use windows::core::{Interface, Result, GUID, PCWSTR};
use windows::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, HWND};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_IGNORE, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_FIGURE_BEGIN_FILLED,
    D2D1_FIGURE_BEGIN_HOLLOW, D2D1_FIGURE_END_CLOSED, D2D1_FIGURE_END_OPEN, D2D1_PIXEL_FORMAT,
    D2D_RECT_F, D2D_SIZE_U,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1Bitmap, ID2D1Factory, ID2D1HwndRenderTarget, ID2D1PathGeometry,
    ID2D1RenderTarget, ID2D1SolidColorBrush, ID2D1StrokeStyle, D2D1_BITMAP_PROPERTIES,
    D2D1_CAP_STYLE_FLAT, D2D1_CAP_STYLE_ROUND, D2D1_DASH_STYLE_CUSTOM, D2D1_DASH_STYLE_SOLID,
    D2D1_DRAW_TEXT_OPTIONS_CLIP, D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_ELLIPSE,
    D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT,
    D2D1_HWND_RENDER_TARGET_PROPERTIES, D2D1_LINE_JOIN_ROUND, D2D1_PRESENT_OPTIONS,
    D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_DEFAULT,
    D2D1_RENDER_TARGET_TYPE_SOFTWARE, D2D1_RENDER_TARGET_USAGE_NONE, D2D1_ROUNDED_RECT,
    D2D1_STROKE_STYLE_PROPERTIES,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat, IDWriteTextLayout,
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT, DWRITE_MEASURING_MODE_NATURAL, DWRITE_PARAGRAPH_ALIGNMENT,
    DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT, DWRITE_TEXT_ALIGNMENT_CENTER,
    DWRITE_TEXT_METRICS, DWRITE_WORD_WRAPPING_NO_WRAP, DWRITE_WORD_WRAPPING_WRAP,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_ContainerFormatPng,
    GUID_WICPixelFormat24bppBGR, GUID_WICPixelFormat32bppBGR, GUID_WICPixelFormat32bppPBGRA,
    IWICBitmap, IWICBitmapSource, IWICImagingFactory, WICBitmapDitherTypeNone,
    WICBitmapEncoderNoCache, WICBitmapInterpolationModeHighQualityCubic,
    WICBitmapPaletteTypeMedianCut, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;
use windows_numerics::{Matrix3x2, Vector2};

use crate::image::Image;
use crate::util::{utf16, wide};

thread_local! {
    static D2D: ID2D1Factory = unsafe {
        D2D1CreateFactory::<ID2D1Factory>(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).expect("Direct2D")
    };
    static DWRITE: IDWriteFactory = unsafe {
        DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED).expect("DirectWrite")
    };
    static WIC: IWICImagingFactory = unsafe {
        CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).expect("WIC")
    };
    static FORMATS: RefCell<HashMap<(String, u32, i32, i32), IDWriteTextFormat>> = RefCell::new(HashMap::new());
    static STROKES: RefCell<HashMap<u32, ID2D1StrokeStyle>> = RefCell::new(HashMap::new());
}

pub fn d2d() -> ID2D1Factory {
    D2D.with(|f| f.clone())
}
pub fn dwrite() -> IDWriteFactory {
    DWRITE.with(|f| f.clone())
}
pub fn wic() -> IWICImagingFactory {
    WIC.with(|f| f.clone())
}

// ---------------------------------------------------------------- primitives

pub fn col(hex: u32, a: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        r: ((hex >> 16) & 0xFF) as f32 / 255.0,
        g: ((hex >> 8) & 0xFF) as f32 / 255.0,
        b: (hex & 0xFF) as f32 / 255.0,
        a,
    }
}

pub fn rf(l: f32, t: f32, r: f32, b: f32) -> D2D_RECT_F {
    D2D_RECT_F { left: l, top: t, right: r, bottom: b }
}

pub fn rxywh(x: f32, y: f32, w: f32, h: f32) -> D2D_RECT_F {
    rf(x, y, x + w, y + h)
}

pub fn v2(x: f32, y: f32) -> Vector2 {
    Vector2 { X: x, Y: y }
}

pub fn rounded(r: D2D_RECT_F, radius: f32) -> D2D1_ROUNDED_RECT {
    D2D1_ROUNDED_RECT { rect: r, radiusX: radius, radiusY: radius }
}

pub fn ellipse(cx: f32, cy: f32, rx: f32, ry: f32) -> D2D1_ELLIPSE {
    D2D1_ELLIPSE { point: v2(cx, cy), radiusX: rx, radiusY: ry }
}

pub fn identity() -> Matrix3x2 {
    Matrix3x2 { M11: 1.0, M12: 0.0, M21: 0.0, M22: 1.0, M31: 0.0, M32: 0.0 }
}

pub fn transform(scale: f32, dx: f32, dy: f32) -> Matrix3x2 {
    Matrix3x2 { M11: scale, M12: 0.0, M21: 0.0, M22: scale, M31: dx, M32: dy }
}

pub fn brush(rt: &ID2D1RenderTarget, hex: u32, a: f32) -> ID2D1SolidColorBrush {
    unsafe { rt.CreateSolidColorBrush(&col(hex, a), None).expect("brush") }
}

/// Round-capped stroke style (cached). `dash` > 0 gives a dashed line.
pub fn stroke_round(dash: u32) -> ID2D1StrokeStyle {
    STROKES.with(|s| {
        s.borrow_mut()
            .entry(dash)
            .or_insert_with(|| unsafe {
                let props = D2D1_STROKE_STYLE_PROPERTIES {
                    startCap: if dash > 0 { D2D1_CAP_STYLE_FLAT } else { D2D1_CAP_STYLE_ROUND },
                    endCap: if dash > 0 { D2D1_CAP_STYLE_FLAT } else { D2D1_CAP_STYLE_ROUND },
                    dashCap: D2D1_CAP_STYLE_FLAT,
                    lineJoin: D2D1_LINE_JOIN_ROUND,
                    miterLimit: 10.0,
                    dashStyle: if dash > 0 { D2D1_DASH_STYLE_CUSTOM } else { D2D1_DASH_STYLE_SOLID },
                    dashOffset: 0.0,
                };
                let dashes = [dash as f32, dash as f32];
                d2d()
                    .CreateStrokeStyle(&props, if dash > 0 { Some(&dashes[..]) } else { None })
                    .expect("stroke")
            })
            .clone()
    })
}

/// Builds a path geometry from a polyline. `closed` fills it.
pub fn polyline(points: &[Vector2], closed: bool) -> Option<ID2D1PathGeometry> {
    if points.len() < 2 {
        return None;
    }
    unsafe {
        let geo = d2d().CreatePathGeometry().ok()?;
        let sink = geo.Open().ok()?;
        sink.BeginFigure(points[0], if closed { D2D1_FIGURE_BEGIN_FILLED } else { D2D1_FIGURE_BEGIN_HOLLOW });
        for p in &points[1..] {
            sink.AddLine(*p);
        }
        sink.EndFigure(if closed { D2D1_FIGURE_END_CLOSED } else { D2D1_FIGURE_END_OPEN });
        sink.Close().ok()?;
        Some(geo)
    }
}

/// Smooth freehand path: quadratic curves through the midpoints.
pub fn smooth_path(points: &[Vector2]) -> Option<ID2D1PathGeometry> {
    use windows::Win32::Graphics::Direct2D::D2D1_QUADRATIC_BEZIER_SEGMENT;
    if points.len() < 3 {
        return polyline(points, false);
    }
    unsafe {
        let geo = d2d().CreatePathGeometry().ok()?;
        let sink = geo.Open().ok()?;
        sink.BeginFigure(points[0], D2D1_FIGURE_BEGIN_HOLLOW);
        for i in 1..points.len() - 1 {
            let p = points[i];
            let n = points[i + 1];
            let mid = v2((p.X + n.X) / 2.0, (p.Y + n.Y) / 2.0);
            sink.AddQuadraticBezier(&D2D1_QUADRATIC_BEZIER_SEGMENT { point1: p, point2: mid });
        }
        sink.AddLine(*points.last().unwrap());
        sink.EndFigure(D2D1_FIGURE_END_OPEN);
        sink.Close().ok()?;
        Some(geo)
    }
}

// ---------------------------------------------------------------- targets

/// Window render target with 1 DIP = 1 physical pixel, so drawing is pixel exact.
pub fn hwnd_target(hwnd: HWND, w: u32, h: u32, present: D2D1_PRESENT_OPTIONS) -> Result<ID2D1HwndRenderTarget> {
    unsafe {
        let props = D2D1_RENDER_TARGET_PROPERTIES {
            r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
            pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_IGNORE },
            dpiX: 96.0,
            dpiY: 96.0,
            usage: D2D1_RENDER_TARGET_USAGE_NONE,
            minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
        };
        let hprops = D2D1_HWND_RENDER_TARGET_PROPERTIES {
            hwnd,
            pixelSize: D2D_SIZE_U { width: w.max(1), height: h.max(1) },
            presentOptions: present,
        };
        d2d().CreateHwndRenderTarget(&props, &hprops)
    }
}

/// Offscreen software target over a WIC bitmap (used for exporting at full resolution).
pub fn wic_target(w: u32, h: u32) -> Result<(IWICBitmap, ID2D1RenderTarget)> {
    unsafe {
        let bmp = wic().CreateBitmap(w, h, &GUID_WICPixelFormat32bppPBGRA, windows::Win32::Graphics::Imaging::WICBitmapCacheOnLoad)?;
        let props = D2D1_RENDER_TARGET_PROPERTIES {
            r#type: D2D1_RENDER_TARGET_TYPE_SOFTWARE,
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            usage: D2D1_RENDER_TARGET_USAGE_NONE,
            minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
        };
        let rt = d2d().CreateWicBitmapRenderTarget(&bmp, &props)?;
        Ok((bmp, rt))
    }
}

pub fn bitmap(rt: &ID2D1RenderTarget, img: &Image) -> Result<ID2D1Bitmap> {
    unsafe {
        let props = D2D1_BITMAP_PROPERTIES {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
        };
        rt.CreateBitmap(
            D2D_SIZE_U { width: img.width, height: img.height },
            Some(img.data.as_ptr() as _),
            img.stride(),
            &props,
        )
    }
}

/// Large images (e.g. three 4K displays side by side) can exceed the GPU
/// texture limit; such images are split into tiles.
pub struct TiledBitmap {
    pub tiles: Vec<(ID2D1Bitmap, crate::util::Rect)>,
}

impl TiledBitmap {
    pub fn new(rt: &ID2D1RenderTarget, img: &Image) -> Result<Self> {
        let max = unsafe { rt.GetMaximumBitmapSize() }.max(2048) as i32;
        let mut tiles = Vec::new();
        let (w, h) = (img.width as i32, img.height as i32);
        if w <= max && h <= max {
            tiles.push((bitmap(rt, img)?, img.bounds()));
            return Ok(Self { tiles });
        }
        let mut y = 0;
        while y < h {
            let mut x = 0;
            let th = max.min(h - y);
            while x < w {
                let tw = max.min(w - x);
                let r = crate::util::Rect::new(x, y, tw, th);
                tiles.push((bitmap(rt, &img.crop(r))?, r));
                x += tw;
            }
            y += th;
        }
        Ok(Self { tiles })
    }

    /// Draws the whole image 1:1 at the origin of the current transform.
    pub fn draw(&self, rt: &ID2D1RenderTarget, mode: windows::Win32::Graphics::Direct2D::D2D1_BITMAP_INTERPOLATION_MODE) {
        for (bmp, r) in &self.tiles {
            unsafe {
                rt.DrawBitmap(
                    bmp,
                    Some(&rxywh(r.x as f32, r.y as f32, r.w as f32, r.h as f32)),
                    1.0,
                    mode,
                    None,
                );
            }
        }
    }

    /// Draws a source sub-rectangle into a destination rectangle.
    pub fn draw_part(
        &self,
        rt: &ID2D1RenderTarget,
        src: D2D_RECT_F,
        dst: D2D_RECT_F,
        mode: windows::Win32::Graphics::Direct2D::D2D1_BITMAP_INTERPOLATION_MODE,
    ) {
        let sx = (dst.right - dst.left) / (src.right - src.left);
        let sy = (dst.bottom - dst.top) / (src.bottom - src.top);
        for (bmp, r) in &self.tiles {
            let l = src.left.max(r.x as f32);
            let t = src.top.max(r.y as f32);
            let rr = src.right.min(r.right() as f32);
            let b = src.bottom.min(r.bottom() as f32);
            if rr <= l || b <= t {
                continue;
            }
            let s = rf(l - r.x as f32, t - r.y as f32, rr - r.x as f32, b - r.y as f32);
            let d = rf(
                dst.left + (l - src.left) * sx,
                dst.top + (t - src.top) * sy,
                dst.left + (rr - src.left) * sx,
                dst.top + (b - src.top) * sy,
            );
            unsafe { rt.DrawBitmap(bmp, Some(&d), 1.0, mode, Some(&s)) };
        }
    }
}

// ---------------------------------------------------------------- text

pub const W_REGULAR: i32 = 400;
pub const W_MEDIUM: i32 = 500;
pub const W_SEMIBOLD: i32 = 600;
pub const W_BOLD: i32 = 700;

/// Cached text format. Size is in pixels.
pub fn text_format(family: &str, size: f32, weight: i32, align: i32) -> IDWriteTextFormat {
    let key = (family.to_string(), (size * 100.0) as u32, weight, align);
    FORMATS.with(|f| {
        f.borrow_mut()
            .entry(key)
            .or_insert_with(|| unsafe {
                let fam = wide(family);
                let loc = wide(crate::i18n::locale());
                let fmt = dwrite()
                    .CreateTextFormat(
                        PCWSTR(fam.as_ptr()),
                        None,
                        DWRITE_FONT_WEIGHT(weight),
                        DWRITE_FONT_STYLE_NORMAL,
                        DWRITE_FONT_STRETCH_NORMAL,
                        size,
                        PCWSTR(loc.as_ptr()),
                    )
                    .expect("text format");
                // align 4: left/top with word wrap (multi-line hints).
                let _ = fmt.SetWordWrapping(if align == 4 { DWRITE_WORD_WRAPPING_WRAP } else { DWRITE_WORD_WRAPPING_NO_WRAP });
                if align == 1 {
                    let _ = fmt.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_CENTER);
                    let _ = fmt.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
                } else if align == 2 {
                    let _ = fmt.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
                } else {
                    let _ = fmt.SetTextAlignment(DWRITE_TEXT_ALIGNMENT(0));
                    let _ = fmt.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT(0));
                }
                fmt
            })
            .clone()
    })
}

/// UI font at a size, centred both ways in the layout rect.
pub fn ui_center(size: f32, weight: i32) -> IDWriteTextFormat {
    text_format(crate::theme::FONT, size, weight, 1)
}
/// UI font at a size, left aligned and vertically centred.
pub fn ui_left(size: f32, weight: i32) -> IDWriteTextFormat {
    text_format(crate::theme::FONT, size, weight, 2)
}

pub fn draw_text(rt: &ID2D1RenderTarget, s: &str, fmt: &IDWriteTextFormat, r: D2D_RECT_F, b: &ID2D1SolidColorBrush) {
    let t = utf16(s);
    unsafe {
        rt.DrawText(&t, fmt, &r, b, D2D1_DRAW_TEXT_OPTIONS_CLIP, DWRITE_MEASURING_MODE_NATURAL);
    }
}

pub fn draw_text_free(rt: &ID2D1RenderTarget, s: &str, fmt: &IDWriteTextFormat, r: D2D_RECT_F, b: &ID2D1SolidColorBrush) {
    let t = utf16(s);
    unsafe {
        rt.DrawText(&t, fmt, &r, b, D2D1_DRAW_TEXT_OPTIONS_NONE, DWRITE_MEASURING_MODE_NATURAL);
    }
}

pub fn layout(s: &str, fmt: &IDWriteTextFormat, max_w: f32, max_h: f32) -> Option<IDWriteTextLayout> {
    let t = utf16(s);
    unsafe { dwrite().CreateTextLayout(&t, fmt, max_w, max_h).ok() }
}

/// (width, height) of a string.
pub fn measure(s: &str, fmt: &IDWriteTextFormat) -> (f32, f32) {
    let Some(l) = layout(s, fmt, 10000.0, 10000.0) else { return (0.0, 0.0) };
    let mut m = DWRITE_TEXT_METRICS::default();
    unsafe {
        let _ = l.GetMetrics(&mut m);
    }
    (m.widthIncludingTrailingWhitespace, m.height)
}

// ---------------------------------------------------------------- WIC

fn wic_from_image(f: &IWICImagingFactory, img: &Image, opaque: bool) -> Result<IWICBitmap> {
    unsafe {
        f.CreateBitmapFromMemory(
            img.width,
            img.height,
            if opaque { &GUID_WICPixelFormat32bppBGR } else { &GUID_WICPixelFormat32bppPBGRA },
            img.stride(),
            &img.data,
        )
    }
}

fn image_from_source(src: &IWICBitmapSource) -> Result<Image> {
    unsafe {
        let (mut w, mut h) = (0u32, 0u32);
        src.GetSize(&mut w, &mut h)?;
        let mut data = vec![0u8; (w * h * 4) as usize];
        src.CopyPixels(std::ptr::null(), w * 4, &mut data)?;
        Ok(Image::new(w, h, data))
    }
}

/// High-quality downscale (thumbnails).
pub fn scale_image(img: &Image, w: u32, h: u32) -> Result<Image> {
    let f = wic();
    unsafe {
        let src = wic_from_image(&f, img, false)?;
        let scaler = f.CreateBitmapScaler()?;
        scaler.Initialize(&src, w.max(1), h.max(1), WICBitmapInterpolationModeHighQualityCubic)?;
        image_from_source(&scaler.cast()?)
    }
}

/// Reads PNG/JPG/BMP/GIF/WebP... into a premultiplied BGRA image.
pub fn load_image(path: &Path) -> Result<Image> {
    let f = wic();
    unsafe {
        let p = wide(&path.to_string_lossy());
        let dec = f.CreateDecoderFromFilename(PCWSTR(p.as_ptr()), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)?;
        let frame = dec.GetFrame(0)?;
        let conv = f.CreateFormatConverter()?;
        conv.Initialize(&frame, &GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeMedianCut)?;
        image_from_source(&conv.cast()?)
    }
}

pub fn wic_bitmap_to_image(bmp: &IWICBitmap) -> Result<Image> {
    image_from_source(&bmp.cast()?)
}

/// Encodes to PNG (lossless, 24-bit) or JPG. Safe to call from any thread
/// that has initialised COM.
pub fn save_image(img: &Image, path: &Path, jpg_quality: Option<u8>) -> Result<()> {
    let f: IWICImagingFactory = unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)? };
    let tmp = path.with_extension("comesshot-tmp");
    let res = (|| unsafe {
        let stream = f.CreateStream()?;
        let p = wide(&tmp.to_string_lossy());
        stream.InitializeFromFilename(PCWSTR(p.as_ptr()), GENERIC_WRITE.0)?;
        let container: GUID = if jpg_quality.is_some() { GUID_ContainerFormatJpeg } else { GUID_ContainerFormatPng };
        let enc = f.CreateEncoder(&container, std::ptr::null())?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut bag: Option<IPropertyBag2> = None;
        enc.CreateNewFrame(&mut frame, &mut bag)?;
        let frame = frame.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        if let (Some(q), Some(bag)) = (jpg_quality, bag.as_ref()) {
            let name = wide("ImageQuality");
            let opt = PROPBAG2 { pstrName: windows::core::PWSTR(name.as_ptr() as *mut u16), ..Default::default() };
            let val = VARIANT::from(q.clamp(1, 100) as f32 / 100.0);
            let _ = bag.Write(1, &opt, &val);
        }
        frame.Initialize(bag.as_ref())?;
        frame.SetSize(img.width, img.height)?;
        let mut fmt = GUID_WICPixelFormat24bppBGR;
        frame.SetPixelFormat(&mut fmt)?;
        let src = wic_from_image(&f, img, true)?;
        frame.WriteSource(&src, std::ptr::null())?;
        frame.Commit()?;
        enc.Commit()?;
        stream.Commit(windows::Win32::System::Com::STGC_DEFAULT)?;
        Ok(())
    })();
    match res {
        Ok(()) => {
            let _ = std::fs::remove_file(path);
            std::fs::rename(&tmp, path).map_err(|_| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[allow(dead_code)]
pub fn as_rt<T: Interface>(t: &T) -> ID2D1RenderTarget {
    t.cast().expect("render target")
}
