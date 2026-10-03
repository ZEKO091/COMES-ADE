//! Line icons drawn with Direct2D, so they stay sharp at every DPI.
//! Each function draws centred on (cx, cy) inside a box of size `s`.

use windows::Win32::Graphics::Direct2D::{ID2D1RenderTarget, ID2D1SolidColorBrush};

use crate::gfx::{self, ellipse, rounded, rxywh, v2};

fn sw(s: f32) -> f32 {
    (s * 0.115).max(1.4)
}

fn line(rt: &ID2D1RenderTarget, b: &ID2D1SolidColorBrush, w: f32, pts: &[(f32, f32)]) {
    let v: Vec<_> = pts.iter().map(|&(x, y)| v2(x, y)).collect();
    if let Some(g) = gfx::polyline(&v, false) {
        unsafe { rt.DrawGeometry(&g, b, w, &gfx::stroke_round(0)) };
    }
}

fn fill(rt: &ID2D1RenderTarget, b: &ID2D1SolidColorBrush, pts: &[(f32, f32)]) {
    let v: Vec<_> = pts.iter().map(|&(x, y)| v2(x, y)).collect();
    if let Some(g) = gfx::polyline(&v, true) {
        unsafe {
            rt.FillGeometry(&g, b, None);
            rt.DrawGeometry(&g, b, 0.8, &gfx::stroke_round(0));
        }
    }
}

pub fn close(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.32;
    line(rt, b, sw(s), &[(cx - r, cy - r), (cx + r, cy + r)]);
    line(rt, b, sw(s), &[(cx + r, cy - r), (cx - r, cy + r)]);
}

pub fn pencil(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    let w = s * 0.17;
    // Body along the diagonal from bottom-left to top-right.
    let (x0, y0) = (cx - r, cy + r);
    let (x1, y1) = (cx + r * 0.72, cy - r * 0.72);
    let (nx, ny) = (w * 0.7071, w * 0.7071);
    line(rt, b, sw(s), &[
        (x0, y0),
        (x0 + 0.0, y0 - w * 1.2),
        (x1 - nx, y1 - ny),
        (x1 + nx, y1 + ny),
        (x0 + w * 1.2, y0),
        (x0, y0),
    ]);
    line(rt, b, sw(s), &[(x1 - nx - w * 0.9, y1 - ny + w * 0.9), (x1 + nx - w * 0.9, y1 + ny + w * 0.9)]);
}

pub fn pin(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    // Push pin: head, body, needle.
    line(rt, b, sw(s), &[(cx - r * 0.55, cy - r), (cx + r * 0.55, cy - r)]);
    line(rt, b, sw(s), &[
        (cx - r * 0.35, cy - r),
        (cx - r * 0.35, cy - r * 0.15),
        (cx - r * 0.75, cy + r * 0.25),
        (cx + r * 0.75, cy + r * 0.25),
        (cx + r * 0.35, cy - r * 0.15),
        (cx + r * 0.35, cy - r),
    ]);
    line(rt, b, sw(s), &[(cx, cy + r * 0.25), (cx, cy + r)]);
}

pub fn cursor(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    let (x, y) = (cx - r * 0.6, cy - r);
    line(rt, b, sw(s), &[
        (x, y),
        (x, y + r * 1.75),
        (x + r * 0.45, y + r * 1.3),
        (x + r * 0.8, y + r * 2.0),
        (x + r * 1.08, y + r * 1.86),
        (x + r * 0.74, y + r * 1.18),
        (x + r * 1.35, y + r * 1.18),
        (x, y),
    ]);
}

pub fn arrow(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.4;
    line(rt, b, sw(s), &[(cx - r, cy + r), (cx + r * 0.9, cy - r * 0.9)]);
    line(rt, b, sw(s), &[(cx - r * 0.05, cy - r), (cx + r, cy - r), (cx + r, cy + r * 0.05)]);
}

pub fn rect(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.4;
    unsafe {
        rt.DrawRoundedRectangle(&rounded(rxywh(cx - r, cy - r * 0.8, r * 2.0, r * 1.6), s * 0.1), b, sw(s), None);
    }
}

pub fn ellipse_icon(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.4;
    unsafe {
        rt.DrawEllipse(&ellipse(cx, cy, r, r * 0.8), b, sw(s), None);
    }
}

pub fn line_icon(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.4;
    line(rt, b, sw(s), &[(cx - r, cy + r), (cx + r, cy - r)]);
}

pub fn pen(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    let pts: Vec<_> = (0..=16)
        .map(|i| {
            let t = i as f32 / 16.0;
            let x = cx - r + t * 2.0 * r;
            let y = cy + (t * std::f32::consts::PI * 2.0).sin() * r * 0.45 + (t - 0.5) * r * 0.3;
            v2(x, y)
        })
        .collect();
    if let Some(g) = gfx::polyline(&pts, false) {
        unsafe { rt.DrawGeometry(&g, b, sw(s), &gfx::stroke_round(0)) };
    }
}

pub fn highlighter(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    // Marker tip and a thick translucent stroke underneath.
    line(rt, b, sw(s), &[
        (cx - r * 0.2, cy + r * 0.25),
        (cx + r * 0.55, cy - r * 0.5),
        (cx + r * 0.95, cy - r * 0.1),
        (cx + r * 0.2, cy + r * 0.65),
        (cx - r * 0.2, cy + r * 0.25),
    ]);
    line(rt, b, sw(s), &[(cx - r * 0.2, cy + r * 0.25), (cx - r * 0.45, cy + r * 0.75), (cx - r * 0.05, cy + r * 0.75), (cx + r * 0.2, cy + r * 0.65)]);
    unsafe {
        let old = b.GetOpacity();
        b.SetOpacity(old * 0.45);
        rt.FillRectangle(&rxywh(cx - r, cy + r * 0.82, r * 2.0, r * 0.28), b);
        b.SetOpacity(old);
    }
}

pub fn text(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.4;
    line(rt, b, sw(s), &[(cx - r, cy - r * 0.75), (cx - r, cy - r), (cx + r, cy - r), (cx + r, cy - r * 0.75)]);
    line(rt, b, sw(s), &[(cx, cy - r), (cx, cy + r)]);
    line(rt, b, sw(s), &[(cx - r * 0.35, cy + r), (cx + r * 0.35, cy + r)]);
}

pub fn counter(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    unsafe {
        rt.DrawEllipse(&ellipse(cx, cy, r, r), b, sw(s), None);
    }
    let fmt = gfx::ui_center(s * 0.55, gfx::W_BOLD);
    gfx::draw_text_free(rt, "1", &fmt, rxywh(cx - r, cy - r - s * 0.03, r * 2.0, r * 2.0), b);
}

pub fn pixelate(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.4;
    let c = r * 2.0 / 3.0;
    unsafe {
        rt.DrawRectangle(&rxywh(cx - r, cy - r, r * 2.0, r * 2.0), b, sw(s) * 0.9, None);
        for (i, j) in [(0, 0), (2, 0), (1, 1), (0, 2), (2, 2)] {
            rt.FillRectangle(&rxywh(cx - r + i as f32 * c, cy - r + j as f32 * c, c, c), b);
        }
    }
}

pub fn crop(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    line(rt, b, sw(s), &[(cx - r * 0.55, cy - r), (cx - r * 0.55, cy + r * 0.55), (cx + r, cy + r * 0.55)]);
    line(rt, b, sw(s), &[(cx - r, cy - r * 0.55), (cx + r * 0.55, cy - r * 0.55), (cx + r * 0.55, cy + r)]);
}

fn curved_arrow(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush, dir: f32) {
    let r = s * 0.38;
    let pts: Vec<_> = (0..=14)
        .map(|i| {
            let a = std::f32::consts::PI * (1.05 - i as f32 / 14.0 * 1.15);
            v2(cx + dir * a.cos() * r, cy + r * 0.35 - a.sin() * r)
        })
        .collect();
    if let Some(g) = gfx::polyline(&pts, false) {
        unsafe { rt.DrawGeometry(&g, b, sw(s), &gfx::stroke_round(0)) };
    }
    let start = pts[0];
    line(rt, b, sw(s), &[(start.X + dir * r * 0.55, start.Y + r * 0.05), (start.X, start.Y), (start.X - dir * r * 0.05, start.Y - r * 0.6)]);
}

pub fn undo(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    curved_arrow(rt, cx, cy, s, b, 1.0);
}

pub fn redo(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    curved_arrow(rt, cx, cy, s, b, -1.0);
}

pub fn copy(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.38;
    unsafe {
        rt.DrawRoundedRectangle(&rounded(rxywh(cx - r * 0.55, cy - r * 0.55, r * 1.55, r * 1.55), s * 0.08), b, sw(s), None);
    }
    line(rt, b, sw(s), &[(cx - r, cy + r * 0.6), (cx - r, cy - r), (cx + r * 0.6, cy - r)]);
}

pub fn save(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.4;
    line(rt, b, sw(s), &[(cx, cy - r), (cx, cy + r * 0.35)]);
    line(rt, b, sw(s), &[(cx - r * 0.45, cy - r * 0.1), (cx, cy + r * 0.35), (cx + r * 0.45, cy - r * 0.1)]);
    line(rt, b, sw(s), &[(cx - r, cy + r * 0.25), (cx - r, cy + r), (cx + r, cy + r), (cx + r, cy + r * 0.25)]);
}

#[allow(dead_code)]
pub fn dot(rt: &ID2D1RenderTarget, cx: f32, cy: f32, r: f32, b: &ID2D1SolidColorBrush) {
    unsafe { rt.FillEllipse(&ellipse(cx, cy, r, r), b) };
}

#[allow(dead_code)]
fn _f(rt: &ID2D1RenderTarget, b: &ID2D1SolidColorBrush) {
    fill(rt, b, &[]);
}

/// Viewfinder corners: area capture.
pub fn area(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    let l = r * 0.6;
    for (x, y, dx, dy) in [(cx - r, cy - r, 1.0, 1.0), (cx + r, cy - r, -1.0, 1.0), (cx - r, cy + r, 1.0, -1.0), (cx + r, cy + r, -1.0, -1.0)] {
        line(rt, b, sw(s), &[(x + l * dx, y), (x, y), (x, y + l * dy)]);
    }
    unsafe { rt.FillEllipse(&ellipse(cx, cy, s * 0.07, s * 0.07), b) };
}

pub fn window_icon(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    unsafe {
        rt.DrawRoundedRectangle(&rounded(rxywh(cx - r, cy - r * 0.8, r * 2.0, r * 1.6), s * 0.08), b, sw(s), None);
    }
    line(rt, b, sw(s), &[(cx - r, cy - r * 0.3), (cx + r, cy - r * 0.3)]);
    for i in 0..3 {
        unsafe { rt.FillEllipse(&ellipse(cx - r * 0.65 + i as f32 * r * 0.28, cy - r * 0.55, s * 0.045, s * 0.045), b) };
    }
}

pub fn monitor(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    unsafe {
        rt.DrawRoundedRectangle(&rounded(rxywh(cx - r, cy - r * 0.85, r * 2.0, r * 1.35), s * 0.08), b, sw(s), None);
    }
    line(rt, b, sw(s), &[(cx, cy + r * 0.5), (cx, cy + r * 0.85)]);
    line(rt, b, sw(s), &[(cx - r * 0.45, cy + r * 0.88), (cx + r * 0.45, cy + r * 0.88)]);
}

pub fn image_icon(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    unsafe {
        rt.DrawRoundedRectangle(&rounded(rxywh(cx - r, cy - r * 0.8, r * 2.0, r * 1.6), s * 0.08), b, sw(s), None);
        rt.FillEllipse(&ellipse(cx + r * 0.4, cy - r * 0.3, s * 0.07, s * 0.07), b);
    }
    line(rt, b, sw(s), &[(cx - r, cy + r * 0.55), (cx - r * 0.35, cy - r * 0.05), (cx + r * 0.15, cy + r * 0.4), (cx + r * 0.45, cy + r * 0.15), (cx + r, cy + r * 0.6)]);
}

pub fn folder(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    let r = s * 0.42;
    line(rt, b, sw(s), &[
        (cx - r, cy + r * 0.75),
        (cx - r, cy - r * 0.75),
        (cx - r * 0.25, cy - r * 0.75),
        (cx, cy - r * 0.45),
        (cx + r, cy - r * 0.45),
        (cx + r, cy + r * 0.75),
        (cx - r, cy + r * 0.75),
    ]);
}

pub fn dots(rt: &ID2D1RenderTarget, cx: f32, cy: f32, s: f32, b: &ID2D1SolidColorBrush) {
    for i in -1..=1 {
        unsafe { rt.FillEllipse(&ellipse(cx + i as f32 * s * 0.3, cy, s * 0.08, s * 0.08), b) };
    }
}
