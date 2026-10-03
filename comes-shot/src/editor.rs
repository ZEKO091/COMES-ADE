//! Annotation editor. Annotations live in image pixel coordinates and are
//! rendered with the same code on screen and on export, so the saved file is
//! exactly what you see, at the capture's full resolution.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Direct2D::Common::D2D_SIZE_U;
use windows::Win32::Graphics::Direct2D::{
    ID2D1Bitmap, ID2D1DeviceContext, ID2D1HwndRenderTarget, ID2D1RenderTarget,
    D2D1_ANTIALIAS_MODE_ALIASED, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR,
    D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR, D2D1_INTERPOLATION_MODE_HIGH_QUALITY_CUBIC,
    D2D1_PRESENT_OPTIONS_NONE, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE,
};
use windows::Win32::Graphics::DirectWrite::DWRITE_HIT_TEST_METRICS;
use windows::Win32::Graphics::Gdi::{InvalidateRect, ValidateRect};
use windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ReleaseCapture, SetCapture, VK_BACK, VK_CONTROL, VK_DELETE, VK_ESCAPE, VK_RETURN, VK_SHIFT,
    VK_SPACE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    KillTimer, LoadCursorW, MessageBoxW, SetCursor, SetForegroundWindow, SetTimer, SetWindowPos, ShowWindow,
    HCURSOR, IDCANCEL, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_IBEAM, IDC_SIZEALL, IDYES, MB_ICONQUESTION,
    MB_YESNOCANCEL, MINMAXINFO, SWP_NOACTIVATE, SWP_NOZORDER, SW_SHOW, WM_CHAR, WM_CLOSE, WM_DPICHANGED,
    WM_ERASEBKGND, WM_GETMINMAXINFO, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_PAINT, WM_SETCURSOR, WM_SIZE, WM_TIMER,
    WS_EX_APPWINDOW, WS_OVERLAPPEDWINDOW,
};

use crate::app::{self, AppEvent};
use crate::gfx::{self, brush, col, rf, rounded, rxywh, v2, TiledBitmap};
use crate::i18n::{t, tf};
use crate::image::Image;
use crate::theme;
use crate::ui::R;
use crate::util::{self, lparam_xy, Rect, WStr};
use crate::window::{self, Handler};
use crate::{capture, config, hud, icons, shell};

// ---------------------------------------------------------------- model

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tool {
    Select,
    Arrow,
    Rect,
    Ellipse,
    Line,
    Pen,
    Highlight,
    Text,
    Counter,
    Pixelate,
    Crop,
}

const TOOLS: [(Tool, &str, u8); 11] = [
    (Tool::Select, "Seleccionar y mover", b'V'),
    (Tool::Arrow, "Flecha", b'A'),
    (Tool::Rect, "Rectángulo", b'R'),
    (Tool::Ellipse, "Elipse", b'E'),
    (Tool::Line, "Línea", b'L'),
    (Tool::Pen, "Lápiz", b'P'),
    (Tool::Highlight, "Resaltador", b'H'),
    (Tool::Text, "Texto", b'T'),
    (Tool::Counter, "Contador de pasos", b'N'),
    (Tool::Pixelate, "Pixelar (ocultar datos)", b'X'),
    (Tool::Crop, "Recortar", b'C'),
];

/// Stroke widths in screen pixels at 100 %.
const WIDTHS: [f32; 3] = [3.0, 6.0, 10.0];
const FONT_SIZES: [f32; 3] = [18.0, 28.0, 44.0];

#[derive(Clone, Copy, Debug, PartialEq)]
struct P {
    x: f32,
    y: f32,
}

fn p(x: f32, y: f32) -> P {
    P { x, y }
}

#[derive(Clone, Debug)]
enum Shape {
    Arrow(P, P),
    Rect(P, P),
    Ellipse(P, P),
    Line(P, P),
    Pen(Vec<P>),
    Highlight(Vec<P>),
    Text { at: P, text: String },
    Counter { at: P, n: u32 },
    Pixelate(P, P),
}

#[derive(Clone, Debug)]
struct Annot {
    shape: Shape,
    color: u32,
    /// Stroke width / font size / counter radius / mosaic block, in image pixels.
    width: f32,
}

#[derive(Clone, Default)]
struct Doc {
    annots: Vec<Annot>,
    crop: Option<Rect>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Btn {
    Tool(usize),
    Color(usize),
    Width(usize),
    Undo,
    Redo,
    Copy,
    Save,
    Done,
    Zoom,
}

enum Drag {
    Create,
    Move { idx: usize, last: P, before: Doc, moved: bool },
    Crop { start: P, cur: P },
    Pan { from: (i32, i32), origin: (f32, f32) },
}

type PixKey = (i32, i32, i32, i32, i32);

struct Editor {
    image: Image,
    path: Option<PathBuf>,
    /// The file at `path` was written by Comes Shot and may be overwritten.
    owned: bool,
    dirty: bool,
    doc: Doc,
    undo: Vec<Doc>,
    redo: Vec<Doc>,
    tool: Tool,
    color: u32,
    width_idx: usize,
    // view
    k: f32,
    client: (i32, i32),
    fit: bool,
    zoom: f32,
    origin: (f32, f32),
    // rendering
    rt: Option<ID2D1HwndRenderTarget>,
    tiles: Option<TiledBitmap>,
    pix: RefCell<HashMap<PixKey, ID2D1Bitmap>>,
    // interaction
    mouse: (i32, i32),
    drag: Option<Drag>,
    preview: Option<Annot>,
    hot: Option<Btn>,
    selected: Option<usize>,
    editing: Option<usize>,
    caret: bool,
    space: bool,
}

/// Opens a Comes Shot capture (its file is updated in place on save).
pub fn open(image: Image, path: Option<PathBuf>) {
    open_with(image, path, true);
}

/// Opens any image; with `owned == false` the original file is never overwritten.
pub fn open_with(image: Image, path: Option<PathBuf>, owned: bool) {
    let (cx, cy) = util::cursor_pos();
    let mon = capture::monitor_at(cx, cy);
    let k = mon.scale();
    let chrome_h = (TOOLBAR_H + STATUS_H) * k;
    let min_w = MIN_W * k;
    // Show 1:1 when it fits in 88 % of the work area, otherwise fit.
    let max_w = mon.work.w as f32 * 0.88;
    let max_h = mon.work.h as f32 * 0.88 - chrome_h;
    let pad = 48.0 * k;
    let s = ((max_w - pad) / image.width as f32).min((max_h - pad) / image.height as f32).min(1.0);
    let cw = (image.width as f32 * s + pad).max(min_w).min(max_w);
    let ch = (image.height as f32 * s + pad + chrome_h).max(560.0 * k).min(mon.work.h as f32 * 0.92);
    let mut r = RECT { left: 0, top: 0, right: cw as i32, bottom: ch as i32 };
    unsafe {
        let _ = AdjustWindowRectExForDpi(&mut r, WS_OVERLAPPEDWINDOW, false, WS_EX_APPWINDOW, mon.dpi);
    }
    let (ww, wh) = (r.right - r.left, r.bottom - r.top);
    let x = mon.work.x + (mon.work.w - ww) / 2;
    let y = mon.work.y + ((mon.work.h - wh) / 2).max(0);
    let title = match &path {
        Some(p) => format!("{} — Comes Shot", p.file_name().map(|s| s.to_string_lossy()).unwrap_or_default()),
        None => t("Comes Shot — Editor").to_string(),
    };
    let ed = Editor::new(image, path, owned, k, (cw as i32, ch as i32));
    let Ok(hwnd) = window::create(
        "ComesShot.Editor",
        &title,
        WS_OVERLAPPEDWINDOW,
        WS_EX_APPWINDOW,
        Rect::new(x, y, ww, wh),
        false,
        Box::new(ed),
    ) else {
        return;
    };
    window::dark_frame(hwnd, theme::PANEL);
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
    }
}

const TOOLBAR_H: f32 = 54.0;
const STATUS_H: f32 = 30.0;
const MIN_W: f32 = 1060.0;

// ---------------------------------------------------------------- geometry helpers

fn dist_seg(q: P, a: P, b: P) -> f32 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((q.x - a.x) * dx + (q.y - a.y) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let (px, py) = (a.x + t * dx, a.y + t * dy);
    ((q.x - px).powi(2) + (q.y - py).powi(2)).sqrt()
}

fn norm_rect(a: P, b: P) -> (f32, f32, f32, f32) {
    (a.x.min(b.x), a.y.min(b.y), a.x.max(b.x), a.y.max(b.y))
}

/// Snaps b to 45° steps around a.
fn snap45(a: P, b: P) -> P {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len = (dx * dx + dy * dy).sqrt();
    let ang = dy.atan2(dx);
    let step = std::f32::consts::FRAC_PI_4;
    let s = (ang / step).round() * step;
    p(a.x + len * s.cos(), a.y + len * s.sin())
}

fn square(a: P, b: P) -> P {
    let side = (b.x - a.x).abs().max((b.y - a.y).abs());
    p(a.x + side * (b.x - a.x).signum(), a.y + side * (b.y - a.y).signum())
}

fn luminance(hex: u32) -> f32 {
    let r = ((hex >> 16) & 255) as f32 / 255.0;
    let g = ((hex >> 8) & 255) as f32 / 255.0;
    let b = (hex & 255) as f32 / 255.0;
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

fn text_fmt(size: f32) -> windows::Win32::Graphics::DirectWrite::IDWriteTextFormat {
    gfx::text_format(theme::FONT, size.max(4.0), gfx::W_BOLD, 0)
}

impl Annot {
    fn translate(&mut self, dx: f32, dy: f32) {
        let mv = |q: &mut P| {
            q.x += dx;
            q.y += dy;
        };
        match &mut self.shape {
            Shape::Arrow(a, b) | Shape::Rect(a, b) | Shape::Ellipse(a, b) | Shape::Line(a, b) | Shape::Pixelate(a, b) => {
                mv(a);
                mv(b);
            }
            Shape::Pen(pts) | Shape::Highlight(pts) => pts.iter_mut().for_each(mv),
            Shape::Text { at, .. } | Shape::Counter { at, .. } => mv(at),
        }
    }

    fn text_size(&self) -> (f32, f32) {
        if let Shape::Text { text, .. } = &self.shape {
            let t = if text.is_empty() { " " } else { text.as_str() };
            let (w, h) = gfx::measure(t, &text_fmt(self.width));
            (w.max(self.width * 0.4), h)
        } else {
            (0.0, 0.0)
        }
    }

    /// Bounding box in image pixels (l, t, r, b).
    fn bounds(&self) -> (f32, f32, f32, f32) {
        let w = self.width;
        match &self.shape {
            Shape::Arrow(a, b) | Shape::Line(a, b) | Shape::Rect(a, b) | Shape::Ellipse(a, b) => {
                let (l, t, r, bt) = norm_rect(*a, *b);
                (l - w, t - w, r + w, bt + w)
            }
            Shape::Pixelate(a, b) => norm_rect(*a, *b),
            Shape::Pen(pts) | Shape::Highlight(pts) => {
                let ww = if matches!(self.shape, Shape::Highlight(_)) { w * 2.5 } else { w };
                let mut bb = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
                for q in pts {
                    bb = (bb.0.min(q.x), bb.1.min(q.y), bb.2.max(q.x), bb.3.max(q.y));
                }
                (bb.0 - ww, bb.1 - ww, bb.2 + ww, bb.3 + ww)
            }
            Shape::Text { at, .. } => {
                let (tw, th) = self.text_size();
                (at.x, at.y, at.x + tw, at.y + th)
            }
            Shape::Counter { at, .. } => (at.x - w, at.y - w, at.x + w, at.y + w),
        }
    }

    fn hit(&self, q: P, tol: f32) -> bool {
        let w = self.width;
        match &self.shape {
            Shape::Arrow(a, b) | Shape::Line(a, b) => dist_seg(q, *a, *b) <= w / 2.0 + tol + w,
            Shape::Rect(a, b) => {
                let (l, t, r, bt) = norm_rect(*a, *b);
                let e = w / 2.0 + tol;
                let inside_outer = q.x >= l - e && q.x <= r + e && q.y >= t - e && q.y <= bt + e;
                let inside_inner = q.x > l + e && q.x < r - e && q.y > t + e && q.y < bt - e;
                inside_outer && !inside_inner
            }
            Shape::Ellipse(a, b) => {
                let (l, t, r, bt) = norm_rect(*a, *b);
                let (cx, cy) = ((l + r) / 2.0, (t + bt) / 2.0);
                let (rx, ry) = (((r - l) / 2.0).max(1.0), ((bt - t) / 2.0).max(1.0));
                let d = (((q.x - cx) / rx).powi(2) + ((q.y - cy) / ry).powi(2)).sqrt();
                let e = (w / 2.0 + tol) / rx.min(ry);
                (d - 1.0).abs() <= e
            }
            Shape::Pen(pts) | Shape::Highlight(pts) => {
                let ww = if matches!(self.shape, Shape::Highlight(_)) { w * 2.5 } else { w / 2.0 };
                if pts.len() == 1 {
                    return dist_seg(q, pts[0], pts[0]) <= ww + tol;
                }
                pts.windows(2).any(|s| dist_seg(q, s[0], s[1]) <= ww + tol)
            }
            Shape::Pixelate(..) | Shape::Text { .. } | Shape::Counter { .. } => {
                let (l, t, r, b) = self.bounds();
                q.x >= l - tol && q.x <= r + tol && q.y >= t - tol && q.y <= b + tol
            }
        }
    }
}

// ---------------------------------------------------------------- drawing annotations

fn arrow_polygon(a: P, b: P, w: f32) -> Option<Vec<windows_numerics::Vector2>> {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1.0 {
        return None;
    }
    let (ux, uy) = (dx / len, dy / len);
    let (nx, ny) = (-uy, ux);
    let head_len = (w * 4.2 + 6.0).min(len * 0.7);
    let head_w = head_len * 0.58;
    let tail_w = (w * 0.22).max(0.6);
    let base_w = w * 0.62;
    let base = p(b.x - ux * head_len * 0.78, b.y - uy * head_len * 0.78);
    let wing = p(b.x - ux * head_len, b.y - uy * head_len);
    Some(vec![
        v2(a.x + nx * tail_w, a.y + ny * tail_w),
        v2(base.x + nx * base_w, base.y + ny * base_w),
        v2(wing.x + nx * head_w, wing.y + ny * head_w),
        v2(b.x, b.y),
        v2(wing.x - nx * head_w, wing.y - ny * head_w),
        v2(base.x - nx * base_w, base.y - ny * base_w),
        v2(a.x - nx * tail_w, a.y - ny * tail_w),
    ])
}

fn color_brush(rt: &ID2D1RenderTarget, hex: u32, a: f32) -> windows::Win32::Graphics::Direct2D::ID2D1SolidColorBrush {
    brush(rt, hex, a)
}

fn draw_annot(rt: &ID2D1RenderTarget, a: &Annot, img: &Image, cache: &RefCell<HashMap<PixKey, ID2D1Bitmap>>, caret: bool) {
    let w = a.width;
    let round = gfx::stroke_round(0);
    unsafe {
        match &a.shape {
            Shape::Arrow(s, e) => {
                if let Some(poly) = arrow_polygon(*s, *e, w) {
                    if let Some(g) = gfx::polyline(&poly, true) {
                        let b = color_brush(rt, a.color, 1.0);
                        rt.FillGeometry(&g, &b, None);
                        rt.DrawGeometry(&g, &b, (w * 0.18).max(0.5), &round);
                    }
                }
            }
            Shape::Line(s, e) => {
                rt.DrawLine(v2(s.x, s.y), v2(e.x, e.y), &color_brush(rt, a.color, 1.0), w, &round);
            }
            Shape::Rect(s, e) => {
                let (l, t, r, b) = norm_rect(*s, *e);
                let rr = rounded(rf(l, t, r, b), (w * 1.2).min((r - l) / 2.0).min((b - t) / 2.0));
                rt.DrawRoundedRectangle(&rr, &color_brush(rt, a.color, 1.0), w, &round);
            }
            Shape::Ellipse(s, e) => {
                let (l, t, r, b) = norm_rect(*s, *e);
                rt.DrawEllipse(&gfx::ellipse((l + r) / 2.0, (t + b) / 2.0, (r - l) / 2.0, (b - t) / 2.0), &color_brush(rt, a.color, 1.0), w, &round);
            }
            Shape::Pen(pts) => {
                let v: Vec<_> = pts.iter().map(|q| v2(q.x, q.y)).collect();
                let b = color_brush(rt, a.color, 1.0);
                if v.len() == 1 {
                    rt.FillEllipse(&gfx::ellipse(v[0].X, v[0].Y, w / 2.0, w / 2.0), &b);
                } else if let Some(g) = gfx::smooth_path(&v) {
                    rt.DrawGeometry(&g, &b, w, &round);
                }
            }
            Shape::Highlight(pts) => {
                let v: Vec<_> = pts.iter().map(|q| v2(q.x, q.y)).collect();
                let b = color_brush(rt, a.color, 0.38);
                if v.len() == 1 {
                    rt.FillEllipse(&gfx::ellipse(v[0].X, v[0].Y, w * 2.5, w * 2.5), &b);
                } else if let Some(g) = gfx::smooth_path(&v) {
                    rt.DrawGeometry(&g, &b, w * 5.0, &round);
                }
            }
            Shape::Text { at, text } => {
                let fmt = text_fmt(w);
                let lr = rf(at.x, at.y, at.x + 100_000.0, at.y + 100_000.0);
                if !text.is_empty() {
                    // Contrasting halo keeps text readable on any background.
                    let dark_text = luminance(a.color) < 0.55;
                    let halo = if dark_text { color_brush(rt, theme::WHITE, 0.92) } else { color_brush(rt, 0x000000, 0.55) };
                    let o = (w * 0.07).max(1.0);
                    for (dx, dy) in [(-o, 0.0), (o, 0.0), (0.0, -o), (0.0, o), (-o * 0.7, -o * 0.7), (o * 0.7, -o * 0.7), (-o * 0.7, o * 0.7), (o * 0.7, o * 0.7)] {
                        gfx::draw_text_free(rt, text, &fmt, rf(lr.left + dx, lr.top + dy, lr.right + dx, lr.bottom + dy), &halo);
                    }
                    gfx::draw_text_free(rt, text, &fmt, lr, &color_brush(rt, a.color, 1.0));
                }
                if caret {
                    let (cx, cy, ch) = caret_pos(text, &fmt, w);
                    let x = at.x + cx;
                    rt.DrawLine(v2(x, at.y + cy), v2(x, at.y + cy + ch), &color_brush(rt, theme::BLUE, 1.0), (w * 0.08).max(1.5), None);
                }
            }
            Shape::Counter { at, n } => {
                let r = w;
                rt.FillEllipse(&gfx::ellipse(at.x, at.y, r, r), &color_brush(rt, a.color, 1.0));
                rt.DrawEllipse(&gfx::ellipse(at.x, at.y, r, r), &color_brush(rt, theme::WHITE, 1.0), (r * 0.13).max(1.0), None);
                let fmt = gfx::ui_center(r * 1.05, gfx::W_BOLD);
                let fg = if luminance(a.color) > 0.6 { 0x111317 } else { theme::WHITE };
                gfx::draw_text_free(rt, &n.to_string(), &fmt, rf(at.x - r * 2.0, at.y - r * 1.06, at.x + r * 2.0, at.y + r * 0.94), &color_brush(rt, fg, 1.0));
            }
            Shape::Pixelate(s, e) => {
                let (l, t, r, b) = norm_rect(*s, *e);
                let rect = Rect::from_ltrb(l.round() as i32, t.round() as i32, r.round() as i32, b.round() as i32);
                let Some(rect) = rect.intersect(&img.bounds()) else { return };
                let block = w.round().max(2.0) as i32;
                let key = (rect.x, rect.y, rect.w, rect.h, block);
                let bmp = {
                    let mut c = cache.borrow_mut();
                    if !c.contains_key(&key) {
                        if c.len() > 64 {
                            c.clear();
                        }
                        if let Some(small) = img.pixelate(rect, block) {
                            if let Ok(b) = gfx::bitmap(rt, &small) {
                                c.insert(key, b);
                            }
                        }
                    }
                    c.get(&key).cloned()
                };
                if let Some(bmp) = bmp {
                    // Cells are exactly `block` pixels; the last row/column may be partial.
                    let sz = bmp.GetPixelSize();
                    let full_w = sz.width as f32 * block as f32;
                    let full_h = sz.height as f32 * block as f32;
                    rt.PushAxisAlignedClip(&rxywh(rect.x as f32, rect.y as f32, rect.w as f32, rect.h as f32), D2D1_ANTIALIAS_MODE_ALIASED);
                    rt.DrawBitmap(&bmp, Some(&rxywh(rect.x as f32, rect.y as f32, full_w, full_h)), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR, None);
                    rt.PopAxisAlignedClip();
                }
            }
        }
    }
}

/// Caret (x, y, height) at the end of the text, relative to the text origin.
fn caret_pos(text: &str, fmt: &windows::Win32::Graphics::DirectWrite::IDWriteTextFormat, size: f32) -> (f32, f32, f32) {
    let t = if text.is_empty() { "" } else { text };
    let Some(layout) = gfx::layout(t, fmt, 100_000.0, 100_000.0) else { return (0.0, 0.0, size * 1.3) };
    let (mut x, mut y) = (0.0f32, 0.0f32);
    let mut m = DWRITE_HIT_TEST_METRICS::default();
    let pos = t.encode_utf16().count() as u32;
    unsafe {
        if pos == 0 {
            let _ = layout.HitTestTextPosition(0, false, &mut x, &mut y, &mut m);
        } else {
            let _ = layout.HitTestTextPosition(pos - 1, true, &mut x, &mut y, &mut m);
        }
    }
    let h = if m.height > 0.0 { m.height } else { size * 1.33 };
    // A trailing newline puts the caret at the start of the next line.
    if text.ends_with('\n') {
        return (0.0, y + h, h);
    }
    (x, y, h)
}

// ---------------------------------------------------------------- editor

impl Editor {
    fn new(image: Image, path: Option<PathBuf>, owned: bool, k: f32, client: (i32, i32)) -> Self {
        Editor {
            image,
            path,
            owned,
            dirty: false,
            doc: Doc::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            tool: Tool::Arrow,
            color: theme::PALETTE[0],
            width_idx: 1,
            k,
            client,
            fit: true,
            zoom: 1.0,
            origin: (0.0, 0.0),
            rt: None,
            tiles: None,
            pix: RefCell::new(HashMap::new()),
            mouse: (0, 0),
            drag: None,
            preview: None,
            hot: None,
            selected: None,
            editing: None,
            caret: true,
            space: false,
        }
    }

    fn view_rect(&self) -> Rect {
        self.doc.crop.unwrap_or_else(|| self.image.bounds())
    }

    fn canvas(&self) -> R {
        let k = self.k;
        R::new(0.0, TOOLBAR_H * k, self.client.0 as f32, (self.client.1 as f32 - (TOOLBAR_H + STATUS_H) * k).max(1.0))
    }

    /// (zoom, origin): screen = (img - view.xy) * zoom + origin
    fn view(&self) -> (f32, (f32, f32)) {
        if !self.fit {
            return (self.zoom, self.origin);
        }
        let c = self.canvas();
        let v = self.view_rect();
        let pad = 28.0 * self.k;
        let z = ((c.w - pad * 2.0) / v.w as f32).min((c.h - pad * 2.0) / v.h as f32).min(1.0).max(0.02);
        let ox = (c.x + (c.w - v.w as f32 * z) / 2.0).round();
        let oy = (c.y + (c.h - v.h as f32 * z) / 2.0).round();
        (z, (ox, oy))
    }

    fn to_img(&self, sx: i32, sy: i32) -> P {
        let (z, o) = self.view();
        let v = self.view_rect();
        p((sx as f32 - o.0) / z + v.x as f32, (sy as f32 - o.1) / z + v.y as f32)
    }

    fn set_zoom(&mut self, z: f32, anchor: (i32, i32)) {
        let z = z.clamp(0.05, 16.0);
        let before = self.to_img(anchor.0, anchor.1);
        let v = self.view_rect();
        self.fit = false;
        self.zoom = z;
        self.origin = (anchor.0 as f32 - (before.x - v.x as f32) * z, anchor.1 as f32 - (before.y - v.y as f32) * z);
    }

    fn cur_width(&self) -> f32 {
        let (z, _) = self.view();
        let s = self.k / z;
        match self.tool {
            Tool::Text => FONT_SIZES[self.width_idx] * s,
            Tool::Counter => (WIDTHS[self.width_idx] * 1.4 + 9.0) * s,
            Tool::Pixelate => ((6.0 + self.width_idx as f32 * 5.0) * s).max(3.0),
            _ => WIDTHS[self.width_idx] * s,
        }
    }

    fn push_undo(&mut self) {
        self.undo.push(self.doc.clone());
        if self.undo.len() > 200 {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.dirty = true;
    }

    fn do_undo(&mut self) {
        self.commit_text();
        if let Some(d) = self.undo.pop() {
            self.redo.push(std::mem::replace(&mut self.doc, d));
            self.selected = None;
            self.dirty = true;
        }
    }

    fn do_redo(&mut self) {
        if let Some(d) = self.redo.pop() {
            self.undo.push(std::mem::replace(&mut self.doc, d));
            self.selected = None;
            self.dirty = true;
        }
    }

    fn next_counter(&self) -> u32 {
        self.doc
            .annots
            .iter()
            .filter_map(|a| if let Shape::Counter { n, .. } = a.shape { Some(n) } else { None })
            .max()
            .unwrap_or(0)
            + 1
    }

    fn commit_text(&mut self) {
        if let Some(i) = self.editing.take() {
            if let Some(Annot { shape: Shape::Text { text, .. }, .. }) = self.doc.annots.get(i) {
                if text.trim().is_empty() {
                    self.doc.annots.remove(i);
                    // Drop the undo step that created the empty box.
                    if let Some(prev) = self.undo.pop() {
                        if prev.annots.len() != self.doc.annots.len() {
                            self.undo.push(prev);
                        }
                    }
                    self.selected = None;
                }
            }
        }
    }

    fn set_tool(&mut self, t: Tool) {
        self.commit_text();
        self.tool = t;
        if t != Tool::Select {
            self.selected = None;
        }
    }

    // ----- export

    fn render_export(&self) -> Option<Image> {
        let v = self.view_rect();
        let (bmp, rt) = gfx::wic_target(v.w as u32, v.h as u32).ok()?;
        let cache = RefCell::new(HashMap::new());
        unsafe {
            rt.BeginDraw();
            rt.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            rt.Clear(Some(&col(0, 1.0)));
            rt.SetTransform(&gfx::transform(1.0, -v.x as f32, -v.y as f32));
            let tiles = TiledBitmap::new(&rt, &self.image).ok()?;
            tiles.draw(&rt, D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR);
            for a in &self.doc.annots {
                draw_annot(&rt, a, &self.image, &cache, false);
            }
            rt.EndDraw(None, None).ok()?;
        }
        gfx::wic_bitmap_to_image(&bmp).ok()
    }

    fn copy(&mut self) -> bool {
        self.commit_text();
        match self.render_export() {
            Some(img) => app::copy_image(&img),
            None => false,
        }
    }

    fn save(&mut self, hwnd: HWND, ask: bool) -> bool {
        self.commit_text();
        let Some(img) = self.render_export() else { return false };
        let cfg = config::get();
        let path = if ask {
            let suggested = self
                .path
                .as_ref()
                .and_then(|p| p.file_stem())
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| app::next_capture_path(&cfg).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
            let dir = self.path.as_ref().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_else(|| PathBuf::from(&cfg.save_dir));
            match shell::save_dialog(Some(hwnd), &dir, &suggested, cfg.extension()) {
                Some(p) => p,
                None => return false,
            }
        } else {
            match &self.path {
                // Captures made by Comes Shot are updated in place.
                Some(p) if self.owned => p.clone(),
                // Files opened from disk are never overwritten: save a copy beside them.
                Some(p) => {
                    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from(&cfg.save_dir));
                    let mut out = dir.join(format!("{stem} ({}).{}", t("anotada"), cfg.extension()));
                    let mut n = 2;
                    while out.exists() {
                        out = dir.join(format!("{stem} ({} {n}).{}", t("anotada"), cfg.extension()));
                        n += 1;
                    }
                    out
                }
                None => app::next_capture_path(&cfg),
            }
        };
        app::save_async(img.clone(), path.clone());
        app::post(AppEvent::Last(img, Some(path.clone())));
        self.path = Some(path);
        self.owned = true;
        self.dirty = false;
        true
    }

    fn done(&mut self, hwnd: HWND) {
        self.commit_text();
        let cfg = config::get();
        let copied = self.copy();
        let saved = if self.dirty || self.path.is_none() && cfg.auto_save { self.save(hwnd, false) } else { false };
        let msg = match (copied, saved) {
            (true, true) => t("Copiado y guardado"),
            (true, false) => t("Copiado al portapapeles"),
            (false, true) => t("Guardado"),
            _ => t("Listo"),
        };
        hud::show(msg);
        self.dirty = false;
        util::post_close(hwnd);
    }

    // ----- toolbar layout

    fn buttons(&self) -> Vec<(Btn, R)> {
        let k = self.k;
        let mut v = Vec::new();
        let th = TOOLBAR_H * k;
        let b = 36.0 * k;
        let y = (th - b) / 2.0;
        let mut x = 12.0 * k;
        for i in 0..TOOLS.len() {
            v.push((Btn::Tool(i), R::new(x, y, b, b)));
            x += b + 2.0 * k;
        }
        x += 14.0 * k;
        let sw = 24.0 * k;
        for i in 0..theme::PALETTE.len() {
            v.push((Btn::Color(i), R::new(x, (th - sw) / 2.0, sw, sw)));
            x += sw + 6.0 * k;
        }
        x += 12.0 * k;
        let wb = 30.0 * k;
        for i in 0..WIDTHS.len() {
            v.push((Btn::Width(i), R::new(x, y, wb, b)));
            x += wb + 2.0 * k;
        }
        // Right side.
        let w = self.client.0 as f32;
        let done_w = 82.0 * k;
        let mut rx = w - 12.0 * k - done_w;
        v.push((Btn::Done, R::new(rx, y, done_w, b)));
        rx -= 8.0 * k + b;
        v.push((Btn::Save, R::new(rx, y, b, b)));
        rx -= 2.0 * k + b;
        v.push((Btn::Copy, R::new(rx, y, b, b)));
        rx -= 14.0 * k + b;
        v.push((Btn::Redo, R::new(rx, y, b, b)));
        rx -= 2.0 * k + b;
        v.push((Btn::Undo, R::new(rx, y, b, b)));
        // Zoom label in the status bar.
        let sh = STATUS_H * k;
        v.push((Btn::Zoom, R::new(w - 86.0 * k, self.client.1 as f32 - sh, 80.0 * k, sh)));
        v
    }

    fn btn_at(&self, x: i32, y: i32) -> Option<Btn> {
        self.buttons().into_iter().find(|(_, r)| r.contains(x as f32, y as f32)).map(|(b, _)| b)
    }

    fn tooltip(&self, b: Btn) -> String {
        match b {
            Btn::Tool(i) => format!("{}  ({})", t(TOOLS[i].1), TOOLS[i].2 as char),
            Btn::Color(_) => t("Color").into(),
            Btn::Width(i) => [t("Fino"), t("Medio"), t("Grueso")][i].into(),
            Btn::Undo => t("Deshacer  (Ctrl+Z)").into(),
            Btn::Redo => t("Rehacer  (Ctrl+Y)").into(),
            Btn::Copy => t("Copiar  (Ctrl+C)").into(),
            Btn::Save => t("Guardar  (Ctrl+S) · Guardar como  (Ctrl+Mayús+S)").into(),
            Btn::Done => t("Copiar, guardar y cerrar  (Enter)").into(),
            Btn::Zoom => t("Ajustar / 100 %  (Ctrl+0 / Ctrl+1)").into(),
        }
    }

    fn press(&mut self, hwnd: HWND, b: Btn) {
        match b {
            Btn::Tool(i) => self.set_tool(TOOLS[i].0),
            Btn::Color(i) => {
                self.color = theme::PALETTE[i];
                self.apply_to_selection(|a, c, _| a.color = c);
            }
            Btn::Width(i) => {
                self.width_idx = i;
                let k = self.k;
                let (z, _) = self.view();
                self.apply_to_selection(move |a, _, idx| {
                    let s = k / z;
                    a.width = match a.shape {
                        Shape::Text { .. } => FONT_SIZES[idx] * s,
                        Shape::Counter { .. } => (WIDTHS[idx] * 1.4 + 9.0) * s,
                        Shape::Pixelate(..) => ((6.0 + idx as f32 * 5.0) * s).max(3.0),
                        _ => WIDTHS[idx] * s,
                    };
                });
            }
            Btn::Undo => self.do_undo(),
            Btn::Redo => self.do_redo(),
            Btn::Copy => {
                if self.copy() {
                    hud::show(t("Copiado al portapapeles"));
                }
            }
            Btn::Save => {
                let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
                if self.save(hwnd, shift) {
                    hud::show(t("Guardado"));
                }
            }
            Btn::Done => self.done(hwnd),
            Btn::Zoom => {
                if self.fit {
                    let c = self.canvas();
                    self.set_zoom(1.0, ((c.x + c.w / 2.0) as i32, (c.y + c.h / 2.0) as i32));
                } else {
                    self.fit = true;
                }
            }
        }
    }

    fn apply_to_selection(&mut self, f: impl Fn(&mut Annot, u32, usize)) {
        let target = self.editing.or(self.selected);
        if let Some(i) = target {
            if i < self.doc.annots.len() {
                self.push_undo();
                let (c, w) = (self.color, self.width_idx);
                f(&mut self.doc.annots[i], c, w);
            }
        }
    }

    // ----- painting

    fn render(&mut self, hwnd: HWND) {
        if self.rt.is_none() {
            self.rt = gfx::hwnd_target(hwnd, self.client.0 as u32, self.client.1 as u32, D2D1_PRESENT_OPTIONS_NONE).ok();
            self.tiles = None;
            self.pix.borrow_mut().clear();
        }
        let Some(hrt) = self.rt.clone() else { return };
        let rt: ID2D1RenderTarget = hrt.into();
        if self.tiles.is_none() {
            self.tiles = TiledBitmap::new(&rt, &self.image).ok();
        }
        unsafe {
            rt.BeginDraw();
            self.paint(&rt);
            if rt.EndDraw(None, None).is_err() {
                self.rt = None;
            }
        }
    }

    unsafe fn paint(&self, rt: &ID2D1RenderTarget) {
        rt.SetTransform(&gfx::identity());
        rt.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
        rt.Clear(Some(&col(theme::BG, 1.0)));
        self.draw_canvas(rt);
        rt.SetTransform(&gfx::identity());
        self.draw_toolbar(rt);
        self.draw_status(rt);
        if let Some(b) = self.hot {
            self.draw_tooltip(rt, b);
        }
    }

    unsafe fn draw_canvas(&self, rt: &ID2D1RenderTarget) {
        let c = self.canvas();
        let (z, o) = self.view();
        let v = self.view_rect();
        let (iw, ih) = (v.w as f32 * z, v.h as f32 * z);
        rt.PushAxisAlignedClip(&c.d2d(), D2D1_ANTIALIAS_MODE_ALIASED);
        // Soft shadow under the image.
        for i in 1..=6 {
            let e = i as f32 * 2.0 * self.k;
            rt.FillRoundedRectangle(&rounded(rxywh(o.0 - e, o.1 - e + 3.0 * self.k, iw + e * 2.0, ih + e * 2.0), e), &brush(rt, 0x000000, 0.07));
        }
        // Image: transform maps image px -> screen px.
        let m = gfx::transform(z, o.0 - v.x as f32 * z, o.1 - v.y as f32 * z);
        rt.SetTransform(&m);
        rt.PushAxisAlignedClip(&rxywh(v.x as f32, v.y as f32, v.w as f32, v.h as f32), D2D1_ANTIALIAS_MODE_ALIASED);
        if let Some(t) = &self.tiles {
            let dc: Option<ID2D1DeviceContext> = windows::core::Interface::cast(rt).ok();
            match (z < 0.999, dc) {
                (true, Some(dc)) => {
                    for (bmp, r) in &t.tiles {
                        dc.DrawBitmap(
                            bmp,
                            Some(&rxywh(r.x as f32, r.y as f32, r.w as f32, r.h as f32)),
                            1.0,
                            D2D1_INTERPOLATION_MODE_HIGH_QUALITY_CUBIC,
                            None,
                            None,
                        );
                    }
                }
                _ => t.draw(rt, if z >= 0.999 { D2D1_BITMAP_INTERPOLATION_MODE_NEAREST_NEIGHBOR } else { D2D1_BITMAP_INTERPOLATION_MODE_LINEAR }),
            }
        }
        for (i, a) in self.doc.annots.iter().enumerate() {
            draw_annot(rt, a, &self.image, &self.pix, self.editing == Some(i) && self.caret);
        }
        if let Some(pv) = &self.preview {
            draw_annot(rt, pv, &self.image, &self.pix, false);
        }
        rt.PopAxisAlignedClip();
        rt.SetTransform(&gfx::identity());

        // Selection box (screen space).
        let sel = self.editing.or(self.selected);
        if let Some(a) = sel.and_then(|i| self.doc.annots.get(i)) {
            let (l, t, r, b) = a.bounds();
            let to_s = |x: f32, y: f32| ((x - v.x as f32) * z + o.0, (y - v.y as f32) * z + o.1);
            let (sl, st) = to_s(l, t);
            let (sr, sb) = to_s(r, b);
            let pad = 4.0 * self.k;
            let dash = gfx::stroke_round((4.0 * self.k) as u32);
            rt.DrawRectangle(&rf(sl - pad, st - pad, sr + pad, sb + pad), &brush(rt, theme::BLUE, 1.0), 1.0 * self.k, &dash);
        }

        // Crop marquee.
        if let Some(Drag::Crop { start, cur }) = &self.drag {
            let to_s = |q: &P| ((q.x - v.x as f32) * z + o.0, (q.y - v.y as f32) * z + o.1);
            let (ax, ay) = to_s(start);
            let (bx, by) = to_s(cur);
            let (l, t, r, b) = (ax.min(bx), ay.min(by), ax.max(bx), ay.max(by));
            let dim = brush(rt, 0x000000, 0.55);
            let (il, it, ir, ib) = (o.0, o.1, o.0 + iw, o.1 + ih);
            rt.FillRectangle(&rf(il, it, ir, t), &dim);
            rt.FillRectangle(&rf(il, b, ir, ib), &dim);
            rt.FillRectangle(&rf(il, t, l, b), &dim);
            rt.FillRectangle(&rf(r, t, ir, b), &dim);
            rt.DrawRectangle(&rf(l, t, r, b), &brush(rt, theme::WHITE, 0.95), 1.0, None);
            let wpx = (cur.x - start.x).abs().round() as i32;
            let hpx = (cur.y - start.y).abs().round() as i32;
            let label = format!("{wpx} × {hpx}");
            let fmt = gfx::ui_center(12.0 * self.k, gfx::W_SEMIBOLD);
            let (tw, th) = gfx::measure(&label, &fmt);
            let pr = rxywh(l, b + 6.0 * self.k, tw + 16.0 * self.k, th + 6.0 * self.k);
            rt.FillRoundedRectangle(&rounded(pr, (th + 6.0 * self.k) / 2.0), &brush(rt, theme::PANEL, 0.95));
            gfx::draw_text(rt, &label, &fmt, pr, &brush(rt, theme::TEXT, 1.0));
        }
        rt.PopAxisAlignedClip();
    }

    unsafe fn draw_toolbar(&self, rt: &ID2D1RenderTarget) {
        let k = self.k;
        let w = self.client.0 as f32;
        let th = TOOLBAR_H * k;
        rt.FillRectangle(&rf(0.0, 0.0, w, th), &brush(rt, theme::PANEL, 1.0));
        rt.FillRectangle(&rf(0.0, th - 1.0, w, th), &brush(rt, theme::HAIRLINE, 1.0));
        let icon_s = 18.0 * k;
        let fg = brush(rt, theme::TEXT, 0.92);
        let muted = brush(rt, theme::MUTED, 1.0);
        let white = brush(rt, theme::WHITE, 1.0);
        let mut last_tool_right = 0.0f32;
        let mut first_color_x = None;
        let mut last_color_right = 0.0f32;
        let mut first_width_x = None;
        for (b, r) in self.buttons() {
            let hot = self.hot == Some(b);
            match b {
                Btn::Tool(i) => {
                    let active = TOOLS[i].0 == self.tool;
                    if active {
                        rt.FillRoundedRectangle(&rounded(r.d2d(), 8.0 * k), &brush(rt, theme::BLUE, 1.0));
                    } else if hot {
                        rt.FillRoundedRectangle(&rounded(r.d2d(), 8.0 * k), &brush(rt, theme::PANEL_3, 1.0));
                    }
                    let br = if active { &white } else { &fg };
                    let (cx, cy) = r.center();
                    match TOOLS[i].0 {
                        Tool::Select => icons::cursor(rt, cx, cy, icon_s, br),
                        Tool::Arrow => icons::arrow(rt, cx, cy, icon_s, br),
                        Tool::Rect => icons::rect(rt, cx, cy, icon_s, br),
                        Tool::Ellipse => icons::ellipse_icon(rt, cx, cy, icon_s, br),
                        Tool::Line => icons::line_icon(rt, cx, cy, icon_s, br),
                        Tool::Pen => icons::pen(rt, cx, cy, icon_s, br),
                        Tool::Highlight => icons::highlighter(rt, cx, cy, icon_s, br),
                        Tool::Text => icons::text(rt, cx, cy, icon_s, br),
                        Tool::Counter => icons::counter(rt, cx, cy, icon_s, br),
                        Tool::Pixelate => icons::pixelate(rt, cx, cy, icon_s, br),
                        Tool::Crop => icons::crop(rt, cx, cy, icon_s, br),
                    }
                    last_tool_right = r.right();
                }
                Btn::Color(i) => {
                    first_color_x.get_or_insert(r.x);
                    last_color_right = r.right();
                    let c = theme::PALETTE[i];
                    let (cx, cy) = r.center();
                    let rad = r.w / 2.0;
                    if c == self.color {
                        rt.DrawEllipse(&gfx::ellipse(cx, cy, rad + 1.5 * k, rad + 1.5 * k), &brush(rt, theme::WHITE, 0.9), 2.0 * k, None);
                    }
                    let inner = if c == self.color || hot { rad - 2.5 * k } else { rad - 4.0 * k };
                    rt.FillEllipse(&gfx::ellipse(cx, cy, inner, inner), &brush(rt, c, 1.0));
                    if c == 0x111317 {
                        rt.DrawEllipse(&gfx::ellipse(cx, cy, inner, inner), &brush(rt, theme::WHITE, 0.3), 1.0, None);
                    }
                }
                Btn::Width(i) => {
                    first_width_x.get_or_insert(r.x);
                    let active = i == self.width_idx;
                    if active || hot {
                        rt.FillRoundedRectangle(&rounded(r.d2d(), 8.0 * k), &brush(rt, if active { theme::PANEL_3 } else { theme::PANEL_2 }, 1.0));
                    }
                    let (cx, cy) = r.center();
                    let d = [2.5, 4.5, 7.0][i] * k;
                    rt.FillEllipse(&gfx::ellipse(cx, cy, d, d), if active { &white } else { &muted });
                }
                Btn::Undo | Btn::Redo | Btn::Copy | Btn::Save => {
                    let enabled = match b {
                        Btn::Undo => !self.undo.is_empty(),
                        Btn::Redo => !self.redo.is_empty(),
                        _ => true,
                    };
                    if hot && enabled {
                        rt.FillRoundedRectangle(&rounded(r.d2d(), 8.0 * k), &brush(rt, theme::PANEL_3, 1.0));
                    }
                    let br = if enabled { &fg } else { &muted };
                    let (cx, cy) = r.center();
                    match b {
                        Btn::Undo => icons::undo(rt, cx, cy, icon_s, br),
                        Btn::Redo => icons::redo(rt, cx, cy, icon_s, br),
                        Btn::Copy => icons::copy(rt, cx, cy, icon_s, br),
                        _ => icons::save(rt, cx, cy, icon_s, br),
                    }
                }
                Btn::Done => {
                    rt.FillRoundedRectangle(&rounded(r.d2d(), 8.0 * k), &brush(rt, if hot { theme::BLUE_HOVER } else { theme::BLUE }, 1.0));
                    let fmt = gfx::ui_center(13.5 * k, gfx::W_SEMIBOLD);
                    gfx::draw_text(rt, t("Listo"), &fmt, r.d2d(), &white);
                }
                Btn::Zoom => {}
            }
        }
        // Group separators.
        let sep = brush(rt, theme::HAIRLINE, 1.0);
        let (y0, y1) = (14.0 * k, th - 14.0 * k);
        if let Some(cx) = first_color_x {
            let x = ((last_tool_right + cx) / 2.0).round() + 0.5;
            rt.DrawLine(v2(x, y0), v2(x, y1), &sep, 1.0, None);
        }
        if let Some(wx) = first_width_x {
            let x = ((last_color_right + wx) / 2.0).round() + 0.5;
            rt.DrawLine(v2(x, y0), v2(x, y1), &sep, 1.0, None);
        }
    }

    unsafe fn draw_status(&self, rt: &ID2D1RenderTarget) {
        let k = self.k;
        let (w, h) = (self.client.0 as f32, self.client.1 as f32);
        let sh = STATUS_H * k;
        let top = h - sh;
        rt.FillRectangle(&rf(0.0, top, w, h), &brush(rt, theme::PANEL, 1.0));
        rt.FillRectangle(&rf(0.0, top, w, top + 1.0), &brush(rt, theme::HAIRLINE, 1.0));
        let fmt = gfx::ui_left(12.0 * k, gfx::W_REGULAR);
        let muted = brush(rt, theme::MUTED, 1.0);
        let text = brush(rt, theme::TEXT, 0.9);
        let v = self.view_rect();
        let mut left = format!("{} × {} px", v.w, v.h);
        if self.doc.crop.is_some() {
            left.push_str(&format!("   ·   {}", tf("recortado de {} × {}", &[&self.image.width, &self.image.height])));
        }
        gfx::draw_text(rt, &left, &fmt, rxywh(14.0 * k, top, w * 0.4, sh), &text);
        let hint = match self.tool {
            Tool::Select => t("Clic para seleccionar · arrastra para mover · Supr borra"),
            Tool::Arrow | Tool::Line => t("Arrastra para dibujar · Mayús: ángulos de 45°"),
            Tool::Rect | Tool::Ellipse => t("Arrastra para dibujar · Mayús: proporción 1:1"),
            Tool::Pen | Tool::Highlight => t("Dibuja a mano alzada · Mayús: línea recta"),
            Tool::Text => t("Clic para escribir · Enter termina · Mayús+Enter nueva línea"),
            Tool::Counter => t("Clic para numerar pasos"),
            Tool::Pixelate => t("Arrastra sobre datos sensibles para ocultarlos"),
            Tool::Crop => t("Arrastra el área a conservar · Ctrl+Z deshace"),
        };
        let hfmt = gfx::ui_center(12.0 * k, gfx::W_REGULAR);
        gfx::draw_text(rt, hint, &hfmt, rxywh(w * 0.25, top, w * 0.5, sh), &muted);
        let (z, _) = self.view();
        let zl = if self.fit { format!("{}% · {}", (z * 100.0).round(), t("ajustado")) } else { format!("{}%", (z * 100.0).round()) };
        let zfmt = text_format_right(12.0 * k);
        let hot = self.hot == Some(Btn::Zoom);
        gfx::draw_text(rt, &zl, &zfmt, rxywh(w - 200.0 * k, top, 186.0 * k, sh), if hot { &text } else { &muted });
    }

    unsafe fn draw_tooltip(&self, rt: &ID2D1RenderTarget, b: Btn) {
        let Some((_, r)) = self.buttons().into_iter().find(|(x, _)| *x == b) else { return };
        let k = self.k;
        let label = self.tooltip(b);
        let fmt = gfx::ui_center(12.0 * k, gfx::W_MEDIUM);
        let (tw, th) = gfx::measure(&label, &fmt);
        let (pw, ph) = (tw + 20.0 * k, th + 10.0 * k);
        let mut x = r.x + r.w / 2.0 - pw / 2.0;
        x = x.max(6.0 * k).min(self.client.0 as f32 - pw - 6.0 * k);
        let y = if b == Btn::Zoom { r.y - ph - 6.0 * k } else { r.bottom() + 8.0 * k };
        let rr = rounded(rxywh(x, y, pw, ph), 6.0 * k);
        rt.FillRoundedRectangle(&rr, &brush(rt, theme::PANEL_2, 0.98));
        rt.DrawRoundedRectangle(&rr, &brush(rt, theme::WHITE, 0.12), 1.0, None);
        gfx::draw_text(rt, &label, &fmt, rxywh(x, y, pw, ph), &brush(rt, theme::TEXT, 1.0));
    }

    fn invalidate(hwnd: HWND) {
        unsafe {
            let _ = InvalidateRect(Some(hwnd), None, false);
        }
    }

    // ----- mouse

    fn in_canvas(&self, x: i32, y: i32) -> bool {
        self.canvas().contains(x as f32, y as f32)
    }

    fn mouse_down(&mut self, hwnd: HWND, x: i32, y: i32, shift: bool) {
        if let Some(b) = self.btn_at(x, y) {
            self.press(hwnd, b);
            return;
        }
        if !self.in_canvas(x, y) {
            return;
        }
        unsafe {
            SetCapture(hwnd);
        }
        if self.space {
            let (z, o) = self.view();
            self.fit = false;
            self.zoom = z;
            self.origin = o;
            self.drag = Some(Drag::Pan { from: (x, y), origin: o });
            return;
        }
        let q = self.to_img(x, y);
        let (z, _) = self.view();
        let tol = 6.0 * self.k / z;
        match self.tool {
            Tool::Select => {
                self.commit_text();
                let hit = self.doc.annots.iter().rposition(|a| a.hit(q, tol));
                self.selected = hit;
                if let Some(idx) = hit {
                    self.drag = Some(Drag::Move { idx, last: q, before: self.doc.clone(), moved: false });
                }
            }
            Tool::Text => {
                // Clicking an existing text edits it.
                let hit = self
                    .doc
                    .annots
                    .iter()
                    .rposition(|a| matches!(a.shape, Shape::Text { .. }) && a.hit(q, tol));
                self.commit_text();
                match hit {
                    Some(i) => {
                        self.push_undo();
                        self.editing = Some(i);
                    }
                    None => {
                        self.push_undo();
                        let w = self.cur_width();
                        self.doc.annots.push(Annot {
                            shape: Shape::Text { at: p(q.x, q.y - w * 0.66), text: String::new() },
                            color: self.color,
                            width: w,
                        });
                        self.editing = Some(self.doc.annots.len() - 1);
                    }
                }
                self.caret = true;
                unsafe {
                    let _ = ReleaseCapture();
                }
            }
            Tool::Counter => {
                self.commit_text();
                self.push_undo();
                let n = self.next_counter();
                self.doc.annots.push(Annot { shape: Shape::Counter { at: q, n }, color: self.color, width: self.cur_width() });
                unsafe {
                    let _ = ReleaseCapture();
                }
            }
            Tool::Crop => {
                self.commit_text();
                self.drag = Some(Drag::Crop { start: self.clamp_to_view(q), cur: self.clamp_to_view(q) });
            }
            t => {
                self.commit_text();
                let w = self.cur_width();
                let shape = match t {
                    Tool::Arrow => Shape::Arrow(q, q),
                    Tool::Rect => Shape::Rect(q, q),
                    Tool::Ellipse => Shape::Ellipse(q, q),
                    Tool::Line => Shape::Line(q, q),
                    Tool::Pen => Shape::Pen(vec![q]),
                    Tool::Highlight => Shape::Highlight(vec![q]),
                    _ => Shape::Pixelate(q, q),
                };
                self.preview = Some(Annot { shape, color: self.color, width: w });
                self.drag = Some(Drag::Create);
                let _ = shift;
            }
        }
    }

    fn clamp_to_view(&self, q: P) -> P {
        let v = self.view_rect();
        p(q.x.clamp(v.x as f32, v.right() as f32), q.y.clamp(v.y as f32, v.bottom() as f32))
    }

    fn mouse_move(&mut self, x: i32, y: i32, shift: bool) -> bool {
        self.mouse = (x, y);
        let q = self.to_img(x, y);
        let v = self.view_rect();
        let mut redraw = false;
        match &mut self.drag {
            Some(Drag::Pan { from, origin }) => {
                self.origin = (origin.0 + (x - from.0) as f32, origin.1 + (y - from.1) as f32);
                redraw = true;
            }
            Some(Drag::Move { idx, last, moved, .. }) => {
                let (dx, dy) = (q.x - last.x, q.y - last.y);
                if let Some(a) = self.doc.annots.get_mut(*idx) {
                    a.translate(dx, dy);
                }
                *last = q;
                *moved = true;
                redraw = true;
            }
            Some(Drag::Crop { cur, .. }) => {
                *cur = p(q.x.clamp(v.x as f32, v.right() as f32), q.y.clamp(v.y as f32, v.bottom() as f32));
                redraw = true;
            }
            Some(Drag::Create) => {
                if let Some(pv) = &mut self.preview {
                    let is_hl = matches!(pv.shape, Shape::Highlight(_));
                    match &mut pv.shape {
                        Shape::Arrow(a, b) | Shape::Line(a, b) => *b = if shift { snap45(*a, q) } else { q },
                        Shape::Rect(a, b) | Shape::Ellipse(a, b) | Shape::Pixelate(a, b) => *b = if shift { square(*a, q) } else { q },
                        Shape::Pen(pts) | Shape::Highlight(pts) => {
                            if shift && !pts.is_empty() {
                                let first = pts[0];
                                pts.truncate(1);
                                pts.push(if is_hl { p(q.x, first.y) } else { snap45(first, q) });
                            } else {
                                let last = *pts.last().unwrap();
                                if (q.x - last.x).abs() + (q.y - last.y).abs() > 0.8 {
                                    pts.push(q);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                redraw = true;
            }
            None => {}
        }
        let hot = if self.drag.is_none() { self.btn_at(x, y) } else { None };
        if hot != self.hot {
            self.hot = hot;
            redraw = true;
        }
        redraw
    }

    fn mouse_up(&mut self, x: i32, y: i32) {
        unsafe {
            let _ = ReleaseCapture();
        }
        let _ = (x, y);
        match self.drag.take() {
            Some(Drag::Move { before, moved, .. }) => {
                if moved {
                    self.undo.push(before);
                    self.redo.clear();
                    self.dirty = true;
                }
            }
            Some(Drag::Crop { start, cur }) => {
                let (l, t, r, b) = norm_rect(start, cur);
                let rect = Rect::from_ltrb(l.round() as i32, t.round() as i32, r.round() as i32, b.round() as i32);
                if rect.w >= 4 && rect.h >= 4 {
                    if let Some(rect) = rect.intersect(&self.view_rect()) {
                        self.push_undo();
                        self.doc.crop = Some(rect);
                        self.fit = true;
                    }
                }
            }
            Some(Drag::Create) => {
                if let Some(pv) = self.preview.take() {
                    let (z, _) = self.view();
                    let min = 3.0 / z;
                    let valid = match &pv.shape {
                        Shape::Arrow(a, b) | Shape::Line(a, b) => dist_seg(*a, *b, *b) >= min * 2.0,
                        Shape::Rect(a, b) | Shape::Ellipse(a, b) | Shape::Pixelate(a, b) => (a.x - b.x).abs() >= min && (a.y - b.y).abs() >= min,
                        Shape::Pen(_) | Shape::Highlight(_) => true,
                        _ => true,
                    };
                    if valid {
                        self.push_undo();
                        self.doc.annots.push(pv);
                    }
                }
            }
            _ => {}
        }
    }

    fn cursor(&self) -> HCURSOR {
        let (x, y) = self.mouse;
        let id = if self.btn_at(x, y).is_some() {
            IDC_HAND
        } else if !self.in_canvas(x, y) {
            IDC_ARROW
        } else if self.space || matches!(self.drag, Some(Drag::Pan { .. })) {
            IDC_SIZEALL
        } else {
            match self.tool {
                Tool::Select => {
                    let q = self.to_img(x, y);
                    let (z, _) = self.view();
                    if self.doc.annots.iter().any(|a| a.hit(q, 6.0 * self.k / z)) {
                        IDC_SIZEALL
                    } else {
                        IDC_ARROW
                    }
                }
                Tool::Text => IDC_IBEAM,
                _ => IDC_CROSS,
            }
        };
        unsafe { LoadCursorW(None, id).unwrap_or_default() }
    }

    fn key(&mut self, hwnd: HWND, vk: u16) -> bool {
        let ctrl = unsafe { GetKeyState(VK_CONTROL.0 as i32) } < 0;
        let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
        if ctrl {
            match vk {
                k if k == b'Z' as u16 && shift => self.do_redo(),
                k if k == b'Z' as u16 => self.do_undo(),
                k if k == b'Y' as u16 => self.do_redo(),
                k if k == b'C' as u16 => {
                    if self.copy() {
                        hud::show(t("Copiado al portapapeles"));
                    }
                }
                k if k == b'S' as u16 => {
                    if self.save(hwnd, shift) {
                        hud::show(t("Guardado"));
                    }
                }
                k if k == b'V' as u16 && self.editing.is_some() => {
                    if let Some(t) = crate::clipboard::get_text(hwnd) {
                        self.type_text(&t);
                    }
                }
                k if k == b'0' as u16 => self.fit = true,
                k if k == b'1' as u16 => {
                    let c = self.canvas();
                    self.set_zoom(1.0, ((c.x + c.w / 2.0) as i32, (c.y + c.h / 2.0) as i32));
                }
                0xBB | 0x6B => {
                    let (z, _) = self.view();
                    let c = self.canvas();
                    self.set_zoom(z * 1.25, ((c.x + c.w / 2.0) as i32, (c.y + c.h / 2.0) as i32));
                }
                0xBD | 0x6D => {
                    let (z, _) = self.view();
                    let c = self.canvas();
                    self.set_zoom(z / 1.25, ((c.x + c.w / 2.0) as i32, (c.y + c.h / 2.0) as i32));
                }
                _ => return false,
            }
            return true;
        }
        if self.editing.is_some() {
            // Text editing keys arrive as WM_CHAR; Esc ends editing.
            if vk == VK_ESCAPE.0 {
                self.commit_text();
                return true;
            }
            return false;
        }
        match vk {
            k if k == VK_ESCAPE.0 => {
                if self.selected.is_some() {
                    self.selected = None;
                } else {
                    util::post_close(hwnd);
                }
            }
            k if k == VK_DELETE.0 || k == VK_BACK.0 => {
                if let Some(i) = self.selected.take() {
                    if i < self.doc.annots.len() {
                        self.push_undo();
                        self.doc.annots.remove(i);
                    }
                }
            }
            k if k == VK_RETURN.0 => self.done(hwnd),
            k if k == VK_SPACE.0 => self.space = true,
            k => {
                if let Some(i) = TOOLS.iter().position(|t| t.2 as u16 == k) {
                    self.set_tool(TOOLS[i].0);
                } else {
                    return false;
                }
            }
        }
        true
    }

    fn type_text(&mut self, s: &str) {
        let Some(i) = self.editing else { return };
        if let Some(Annot { shape: Shape::Text { text, .. }, .. }) = self.doc.annots.get_mut(i) {
            text.push_str(&s.replace("\r\n", "\n").replace('\r', "\n"));
            self.dirty = true;
        }
    }

    fn char(&mut self, c: u32) -> bool {
        let Some(i) = self.editing else { return false };
        let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
        match c {
            0x08 => {
                if let Some(Annot { shape: Shape::Text { text, .. }, .. }) = self.doc.annots.get_mut(i) {
                    text.pop();
                }
            }
            0x0D => {
                if shift {
                    self.type_text("\n");
                } else {
                    self.commit_text();
                }
            }
            0x1B => self.commit_text(),
            c if c >= 0x20 => {
                if let Some(ch) = char::from_u32(c) {
                    self.type_text(&ch.to_string());
                }
            }
            _ => return false,
        }
        self.caret = true;
        true
    }
}

fn text_format_right(size: f32) -> windows::Win32::Graphics::DirectWrite::IDWriteTextFormat {
    use windows::Win32::Graphics::DirectWrite::{DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_TRAILING};
    let f = gfx::text_format(theme::FONT, size, gfx::W_MEDIUM, 3);
    unsafe {
        let _ = f.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_TRAILING);
        let _ = f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
    }
    f
}

impl Handler for Editor {
    fn handle(&mut self, hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
        match msg {
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
                if w > 0 && h > 0 {
                    self.client = (w, h);
                    if let Some(rt) = &self.rt {
                        unsafe {
                            let _ = rt.Resize(&D2D_SIZE_U { width: w as u32, height: h as u32 });
                        }
                    }
                    Self::invalidate(hwnd);
                }
                Some(LRESULT(0))
            }
            WM_GETMINMAXINFO => {
                let mmi = unsafe { &mut *(lp.0 as *mut MINMAXINFO) };
                mmi.ptMinTrackSize.x = (MIN_W * self.k * 0.82) as i32;
                mmi.ptMinTrackSize.y = (420.0 * self.k) as i32;
                Some(LRESULT(0))
            }
            WM_DPICHANGED => {
                let dpi = util::loword(wp.0) as f32;
                self.k = dpi / 96.0;
                let r = unsafe { &*(lp.0 as *const RECT) };
                unsafe {
                    let _ = SetWindowPos(hwnd, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
                }
                Self::invalidate(hwnd);
                Some(LRESULT(0))
            }
            WM_SETCURSOR => {
                if util::loword(lp.0 as usize) == 1 {
                    unsafe {
                        SetCursor(Some(self.cursor()));
                    }
                    return Some(LRESULT(1));
                }
                None
            }
            WM_MOUSEMOVE => {
                let (x, y) = lparam_xy(lp);
                if self.mouse_move(x, y, wp.0 & 0x0004 != 0) {
                    Self::invalidate(hwnd);
                }
                Some(LRESULT(0))
            }
            WM_LBUTTONDOWN => {
                let (x, y) = lparam_xy(lp);
                self.mouse = (x, y);
                self.mouse_down(hwnd, x, y, wp.0 & 0x0004 != 0);
                if self.editing.is_some() {
                    unsafe {
                        SetTimer(Some(hwnd), 1, 530, None);
                    }
                }
                Self::invalidate(hwnd);
                Some(LRESULT(0))
            }
            WM_LBUTTONDBLCLK => {
                let (x, y) = lparam_xy(lp);
                // Double-click a text to edit it from any tool.
                if self.in_canvas(x, y) && self.editing.is_none() {
                    let q = self.to_img(x, y);
                    let (z, _) = self.view();
                    if let Some(i) = self.doc.annots.iter().rposition(|a| matches!(a.shape, Shape::Text { .. }) && a.hit(q, 6.0 * self.k / z)) {
                        self.push_undo();
                        self.editing = Some(i);
                        self.selected = None;
                        self.caret = true;
                        unsafe {
                            SetTimer(Some(hwnd), 1, 530, None);
                        }
                        Self::invalidate(hwnd);
                        return Some(LRESULT(0));
                    }
                }
                self.mouse_down(hwnd, x, y, false);
                Self::invalidate(hwnd);
                Some(LRESULT(0))
            }
            WM_LBUTTONUP => {
                let (x, y) = lparam_xy(lp);
                self.mouse_up(x, y);
                Self::invalidate(hwnd);
                Some(LRESULT(0))
            }
            WM_MBUTTONDOWN => {
                let (x, y) = lparam_xy(lp);
                let (z, o) = self.view();
                self.fit = false;
                self.zoom = z;
                self.origin = o;
                self.drag = Some(Drag::Pan { from: (x, y), origin: o });
                unsafe {
                    SetCapture(hwnd);
                }
                Some(LRESULT(0))
            }
            WM_MBUTTONUP => {
                self.drag = None;
                unsafe {
                    let _ = ReleaseCapture();
                }
                Some(LRESULT(0))
            }
            WM_MOUSEWHEEL => {
                let delta = (util::hiword(wp.0) as u16 as i16) as f32 / 120.0;
                let mut pt = windows::Win32::Foundation::POINT { x: util::lparam_xy(lp).0, y: util::lparam_xy(lp).1 };
                unsafe {
                    let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut pt);
                }
                let ctrl = wp.0 & 0x0008 != 0;
                let (z, o) = self.view();
                if ctrl || self.fit {
                    if ctrl {
                        self.set_zoom(z * 1.15f32.powf(delta), (pt.x, pt.y));
                    }
                } else {
                    let shift = wp.0 & 0x0004 != 0;
                    let step = 80.0 * self.k * delta;
                    self.origin = if shift { (o.0 + step, o.1) } else { (o.0, o.1 + step) };
                }
                Self::invalidate(hwnd);
                Some(LRESULT(0))
            }
            WM_KEYDOWN => {
                if self.key(hwnd, wp.0 as u16) {
                    Self::invalidate(hwnd);
                    Some(LRESULT(0))
                } else {
                    None
                }
            }
            WM_KEYUP => {
                if wp.0 as u16 == VK_SPACE.0 {
                    self.space = false;
                }
                None
            }
            WM_CHAR => {
                if self.char(wp.0 as u32) {
                    Self::invalidate(hwnd);
                    Some(LRESULT(0))
                } else {
                    None
                }
            }
            WM_TIMER if wp.0 == 1 => {
                if self.editing.is_some() {
                    self.caret = !self.caret;
                } else {
                    unsafe {
                        let _ = KillTimer(Some(hwnd), 1);
                    }
                }
                Self::invalidate(hwnd);
                Some(LRESULT(0))
            }
            WM_CLOSE => {
                self.commit_text();
                if self.dirty {
                    let text = WStr::new(t("¿Quieres guardar los cambios de esta captura?"));
                    let cap = WStr::new("Comes Shot");
                    let r = unsafe { MessageBoxW(Some(hwnd), text.p(), cap.p(), MB_YESNOCANCEL | MB_ICONQUESTION) };
                    if r == IDCANCEL {
                        return Some(LRESULT(0));
                    }
                    if r == IDYES && !self.save(hwnd, false) {
                        return Some(LRESULT(0));
                    }
                    self.dirty = false;
                }
                None
            }
            _ => None,
        }
    }
}


/// Renders the editor offscreen with sample annotations (`--preview`).
pub fn preview(image: Image, k: f32, client: (i32, i32)) -> Option<Image> {
    let mut ed = Editor::new(image, None, true, k, client);
    let (w, h) = (ed.image.width as f32, ed.image.height as f32);
    let s = 1.0;
    ed.doc.annots = vec![
        Annot { shape: Shape::Arrow(p(w * 0.62, h * 0.70), p(w * 0.40, h * 0.42)), color: theme::PALETTE[0], width: 7.0 * s },
        Annot { shape: Shape::Rect(p(w * 0.12, h * 0.16), p(w * 0.38, h * 0.36)), color: theme::PALETTE[4], width: 6.0 * s },
        Annot { shape: Shape::Text { at: p(w * 0.64, h * 0.70), text: crate::plang::t("Haz clic aquí").into() }, color: theme::PALETTE[0], width: 44.0 * s },
        Annot { shape: Shape::Counter { at: p(w * 0.12, h * 0.16), n: 1 }, color: theme::PALETTE[4], width: 20.0 * s },
        Annot { shape: Shape::Counter { at: p(w * 0.62, h * 0.70), n: 2 }, color: theme::PALETTE[0], width: 20.0 * s },
        Annot { shape: Shape::Highlight(vec![p(w * 0.10, h * 0.62), p(w * 0.32, h * 0.62)]), color: theme::PALETTE[2], width: 7.0 * s },
        Annot { shape: Shape::Pixelate(p(w * 0.72, h * 0.18), p(w * 0.92, h * 0.30)), color: 0, width: 14.0 },
        Annot { shape: Shape::Ellipse(p(w * 0.70, h * 0.42), p(w * 0.86, h * 0.56)), color: theme::PALETTE[3], width: 6.0 * s },
        Annot { shape: Shape::Pen((0..30).map(|i| { let t = i as f32 / 29.0; p(w * (0.40 + t * 0.2), h * (0.86 + (t * 9.0).sin() * 0.03)) }).collect()), color: theme::PALETTE[1], width: 6.0 * s },
    ];
    ed.selected = Some(1);
    ed.hot = Some(Btn::Tool(1));
    ed.undo.push(Doc::default());
    let (bmp, rt) = gfx::wic_target(client.0 as u32, client.1 as u32).ok()?;
    ed.tiles = TiledBitmap::new(&rt, &ed.image).ok();
    unsafe {
        rt.BeginDraw();
        ed.paint(&rt);
        rt.EndDraw(None, None).ok()?;
    }
    gfx::wic_bitmap_to_image(&bmp).ok()
}
