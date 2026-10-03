//! `--preview DIR`: renders every surface offscreen over a synthetic desktop,
//! so the design can be checked without touching the real screen.

use std::path::Path;

use windows::Win32::Graphics::Direct2D::Common::D2D1_GRADIENT_STOP;
use windows::Win32::Graphics::Direct2D::{
    ID2D1RenderTarget, D2D1_EXTEND_MODE_CLAMP, D2D1_GAMMA_2_2, D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES,
};

use crate::capture::{Monitor, Snapshot, WinInfo};
use crate::gfx::{self, brush, col, rounded, rxywh};
use crate::image::Image;
use crate::overlay::{self, Mode};
use crate::util::Rect;
use crate::{editor, quick};

fn fake_window(rt: &ID2D1RenderTarget, r: Rect, title: &str, light: bool, k: f32) {
    let (x, y, w, h) = (r.x as f32, r.y as f32, r.w as f32, r.h as f32);
    unsafe {
        let bg = if light { 0xF6F7F9 } else { 0x1E1F24 };
        let bar = if light { 0xE9EBEF } else { 0x2A2C33 };
        let ink = if light { 0x1C1E22 } else { 0xD7DAE0 };
        rt.FillRoundedRectangle(&rounded(rxywh(x, y, w, h), 8.0 * k), &brush(rt, bg, 1.0));
        rt.FillRectangle(&rxywh(x, y + 8.0 * k, w, 30.0 * k), &brush(rt, bar, 1.0));
        rt.FillRoundedRectangle(&rounded(rxywh(x, y, w, 38.0 * k), 8.0 * k), &brush(rt, bar, 1.0));
        let fmt = gfx::ui_left(12.0 * k, gfx::W_MEDIUM);
        gfx::draw_text(rt, title, &fmt, rxywh(x + 14.0 * k, y, w, 38.0 * k), &brush(rt, ink, 1.0));
        let hfmt = gfx::ui_left(26.0 * k, gfx::W_BOLD);
        gfx::draw_text(rt, crate::plang::t("Informe trimestral"), &hfmt, rxywh(x + 32.0 * k, y + 60.0 * k, w, 40.0 * k), &brush(rt, ink, 1.0));
        let tfmt = gfx::ui_left(14.0 * k, gfx::W_REGULAR);
        let lines = [
            "Ventas totales: 128.400 €  ·  +12 % frente al trimestre anterior",
            "Clientes activos: 3.912",
            "Correo de contacto: ana.garcia@ejemplo.com",
            "Teléfono: +34 600 123 456",
        ];
        for (i, l) in lines.iter().enumerate() {
            gfx::draw_text(rt, crate::plang::t(*l), &tfmt, rxywh(x + 32.0 * k, y + (118.0 + i as f32 * 30.0) * k, w, 24.0 * k), &brush(rt, ink, 0.85));
        }
        // Bar chart.
        let base = y + h - 40.0 * k;
        for i in 0..8 {
            let bh = (60.0 + ((i * 37) % 140) as f32) * k;
            rt.FillRoundedRectangle(
                &rounded(rxywh(x + 32.0 * k + i as f32 * 46.0 * k, base - bh, 30.0 * k, bh), 4.0 * k),
                &brush(rt, if i == 5 { crate::theme::BLUE } else if light { 0xC9CED8 } else { 0x3A3D46 }, 1.0),
            );
        }
    }
}

pub fn desktop() -> Snapshot {
    let (w, h) = (3840u32, 1080u32);
    let (bmp, rt) = gfx::wic_target(w, h).expect("wic");
    let windows = vec![
        WinInfo { rect: Rect::new(180, 120, 980, 700), title: crate::plang::t("Informe — Navegador").into() },
        WinInfo { rect: Rect::new(2260, 160, 1200, 720), title: crate::plang::t("Panel de ventas").into() },
    ];
    unsafe {
        rt.BeginDraw();
        let stops = [
            D2D1_GRADIENT_STOP { position: 0.0, color: col(0x0E2A55, 1.0) },
            D2D1_GRADIENT_STOP { position: 0.55, color: col(0x1B4F8F, 1.0) },
            D2D1_GRADIENT_STOP { position: 1.0, color: col(0x0B1424, 1.0) },
        ];
        let coll = rt.CreateGradientStopCollection(&stops, D2D1_GAMMA_2_2, D2D1_EXTEND_MODE_CLAMP).unwrap();
        let g = rt
            .CreateLinearGradientBrush(
                &D2D1_LINEAR_GRADIENT_BRUSH_PROPERTIES {
                    startPoint: gfx::v2(0.0, 0.0),
                    endPoint: gfx::v2(w as f32, h as f32),
                },
                None,
                &coll,
            )
            .unwrap();
        rt.FillRectangle(&rxywh(0.0, 0.0, w as f32, h as f32), &g);
        fake_window(&rt, windows[0].rect, crate::plang::t("Informe — Navegador"), true, 1.0);
        fake_window(&rt, windows[1].rect, crate::plang::t("Panel de ventas"), false, 1.25);
        for (mx, k) in [(0.0f32, 1.0f32), (1920.0, 1.25)] {
            let th = 48.0 * k;
            rt.FillRectangle(&rxywh(mx, h as f32 - th, 1920.0, th), &brush(&rt, 0x15171C, 0.96));
        }
        rt.EndDraw(None, None).unwrap();
    }
    let image = gfx::wic_bitmap_to_image(&bmp).expect("image");
    let monitors = vec![
        Monitor { rect: Rect::new(0, 0, 1920, 1080), work: Rect::new(0, 0, 1920, 1032), dpi: 96, primary: true },
        Monitor { rect: Rect::new(1920, 0, 1920, 1080), work: Rect::new(1920, 0, 1920, 1020), dpi: 120, primary: false },
    ];
    Snapshot { origin: (0, 0), image, monitors, windows }
}

fn write(img: &Image, dir: &Path, name: &str) {
    let p = dir.join(name);
    match gfx::save_image(img, &p, None) {
        Ok(()) => println!("{}", p.display()),
        Err(e) => eprintln!("{name}: {e}"),
    }
}

pub fn run(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let d = desktop();
    write(&d.image, dir, "00-escritorio.png");
    let shot = d.image.crop(Rect::new(180, 120, 980, 700));

    // Area selection in progress on the 100 % monitor.
    if let Some(img) = overlay::preview(desktop(), (1010, 690), Some((300, 260)), Mode::Area) {
        write(&img.crop(Rect::new(0, 0, 1920, 1080)), dir, "01-seleccion-area.png");
    }
    // Hovering a window on the 125 % monitor.
    if let Some(img) = overlay::preview(desktop(), (2900, 520), None, Mode::Area) {
        write(&img.crop(Rect::new(1920, 0, 1920, 1080)), dir, "02-ventana-hover.png");
    }
    if let Some(img) = quick::preview(shot.clone(), 1.0, false) {
        write(&img, dir, "03-vista-rapida.png");
    }
    if let Some(img) = quick::preview(shot.clone(), 1.0, true) {
        write(&img, dir, "04-vista-rapida-hover.png");
    }
    if let Some(img) = editor::preview(shot.clone(), 1.0, (1280, 860)) {
        write(&img, dir, "05-editor.png");
    }
    // Main window: first run (empty viewfinder) and after a capture.
    if let Some(img) = crate::home::preview(1.0, None, None) {
        write(&img, dir, "06-inicio.png");
    }
    if let Some(img) = crate::home::preview(1.0, Some(crate::home::HomeBtn::Window), Some(&shot)) {
        write(&img, dir, "07-inicio-con-captura.png");
    }
    if let Some(img) = crate::options::preview(1.0, Some(crate::options::cmd::QUICK)) {
        write(&img, dir, "08-opciones.png");
    }
}
