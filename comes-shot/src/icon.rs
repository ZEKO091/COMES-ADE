//! The Comes Shot mark, drawn in code at any size: the ComesADE C and bolt
//! inside a dark rounded tile, with viewfinder corners on larger sizes.

use windows::Win32::Graphics::Direct2D::{ID2D1RenderTarget, D2D1_ANTIALIAS_MODE_PER_PRIMITIVE};
use windows_numerics::Vector2;

use crate::gfx::{self, brush, col, rounded, rxywh, v2};
use crate::image::Image;
use crate::theme;

const C_SHAPE: [(f32, f32); 10] = [
    (470.0, 70.0),
    (970.0, 70.0),
    (834.0, 250.0),
    (545.0, 250.0),
    (345.0, 520.0),
    (551.0, 800.0),
    (790.0, 800.0),
    (660.0, 968.0),
    (480.0, 968.0),
    (150.0, 520.0),
];

const BOLT: [(f32, f32); 9] = [
    (1235.0, 70.0),
    (971.0, 420.0),
    (1300.0, 420.0),
    (1395.0, 490.0),
    (1010.0, 968.0),
    (745.0, 968.0),
    (1059.0, 560.0),
    (680.0, 560.0),
    (1050.0, 70.0),
];

/// Draws the mark (no tile) fitted in a square of `size` at (x, y).
pub fn draw_mark(rt: &ID2D1RenderTarget, x: f32, y: f32, size: f32) {
    let k = size / 1245.0;
    let oy = (size - 898.0 * k) / 2.0;
    let map = |pts: &[(f32, f32)]| -> Vec<Vector2> {
        pts.iter().map(|&(px, py)| v2(x + (px - 150.0) * k, y + oy + (py - 70.0) * k)).collect()
    };
    let round = gfx::stroke_round(0);
    unsafe {
        if let Some(g) = gfx::polyline(&map(&C_SHAPE), true) {
            let b = brush(rt, theme::WHITE, 1.0);
            rt.FillGeometry(&g, &b, None);
            rt.DrawGeometry(&g, &b, 28.0 * k, &round);
        }
        if let Some(g) = gfx::polyline(&map(&BOLT), true) {
            let b = brush(rt, theme::BLUE, 1.0);
            rt.FillGeometry(&g, &b, None);
            rt.DrawGeometry(&g, &b, 28.0 * k, &round);
        }
    }
}

/// Full app icon on a tile.
pub fn draw_icon(rt: &ID2D1RenderTarget, s: f32) {
    unsafe {
        rt.SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
        rt.Clear(Some(&col(0, 0.0)));
        let tile = rounded(rxywh(0.0, 0.0, s, s), s * 0.23);
        rt.FillRoundedRectangle(&tile, &brush(rt, 0x101318, 1.0));
        if s >= 32.0 {
            let inset = rounded(rxywh(0.5, 0.5, s - 1.0, s - 1.0), s * 0.23);
            rt.DrawRoundedRectangle(&inset, &brush(rt, 0x2B313B, 1.0), 1.0, None);
        }
        if s >= 48.0 {
            // Viewfinder corners: the "shot" in Comes Shot.
            let b = brush(rt, theme::BLUE, 0.9);
            let m = s * 0.13;
            let l = s * 0.12;
            let w = (s * 0.028).max(1.5);
            let st = gfx::stroke_round(0);
            for (cx, cy, dx, dy) in [(m, m, 1.0, 1.0), (s - m, m, -1.0, 1.0), (m, s - m, 1.0, -1.0), (s - m, s - m, -1.0, -1.0)] {
                rt.DrawLine(v2(cx, cy), v2(cx + l * dx, cy), &b, w, &st);
                rt.DrawLine(v2(cx, cy), v2(cx, cy + l * dy), &b, w, &st);
            }
        }
        let pad = if s >= 48.0 { s * 0.24 } else { s * 0.13 };
        draw_mark(rt, pad, pad, s - pad * 2.0);
    }
}

/// Renders the icon to straight-alpha BGRA pixels.
pub fn render(size: u32) -> Option<Image> {
    let (bmp, rt) = gfx::wic_target(size, size).ok()?;
    unsafe {
        rt.BeginDraw();
        draw_icon(&rt, size as f32);
        rt.EndDraw(None, None).ok()?;
    }
    let img = gfx::wic_bitmap_to_image(&bmp).ok()?;
    // Premultiplied -> straight alpha (what icons expect).
    let mut data = (*img.data).clone();
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a > 0 && a < 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    Some(Image::new(img.width, img.height, data))
}

/// Writes a multi-size .ico (PNG entries) — used to build the exe icon.
pub fn export_ico(path: &std::path::Path) -> std::io::Result<()> {
    let sizes = [16u32, 20, 24, 32, 40, 48, 64, 128, 256];
    let mut pngs = Vec::new();
    for &s in &sizes {
        let img = render(s).ok_or_else(|| std::io::Error::other("render"))?;
        let tmp = std::env::temp_dir().join(format!("comesshot-icon-{s}.png"));
        save_png_alpha(&img, &tmp).map_err(|e| std::io::Error::other(e.to_string()))?;
        pngs.push(std::fs::read(&tmp)?);
        let _ = std::fs::remove_file(&tmp);
    }
    let mut out = Vec::new();
    out.extend_from_slice(&[0, 0, 1, 0]);
    out.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * sizes.len() as u32;
    for (i, &s) in sizes.iter().enumerate() {
        let b = if s >= 256 { 0 } else { s as u8 };
        out.extend_from_slice(&[b, b, 0, 0]);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(pngs[i].len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += pngs[i].len() as u32;
    }
    for p in pngs {
        out.extend_from_slice(&p);
    }
    std::fs::write(path, out)
}

/// PNG with alpha (straight BGRA input).
pub fn save_png_alpha(img: &Image, path: &std::path::Path) -> windows::core::Result<()> {
    use windows::Win32::Foundation::GENERIC_WRITE;
    use windows::Win32::Graphics::Imaging::*;
    let f = gfx::wic();
    unsafe {
        let stream = f.CreateStream()?;
        let p = crate::util::wide(&path.to_string_lossy());
        stream.InitializeFromFilename(windows::core::PCWSTR(p.as_ptr()), GENERIC_WRITE.0)?;
        let enc = f.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
        enc.Initialize(&stream, WICBitmapEncoderNoCache)?;
        let mut frame = None;
        let mut bag = None;
        enc.CreateNewFrame(&mut frame, &mut bag)?;
        let frame = frame.unwrap();
        frame.Initialize(bag.as_ref())?;
        frame.SetSize(img.width, img.height)?;
        let mut fmt = GUID_WICPixelFormat32bppBGRA;
        frame.SetPixelFormat(&mut fmt)?;
        frame.WritePixels(img.height, img.stride(), &img.data)?;
        frame.Commit()?;
        enc.Commit()?;
    }
    Ok(())
}
