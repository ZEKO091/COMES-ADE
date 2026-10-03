//! Comes Shot — capturas de pantalla rápidas y precisas para Windows.
//! Parte de la familia ComesADE.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod capture;
mod clipboard;
mod config;
mod dxgi;
mod editor;
mod gfx;
mod home;
mod hud;
mod i18n;
mod icon;
mod icons;
mod image;
mod net;
mod ocr;
mod options;
mod overlay;
mod pin;
mod plang;
mod preview;
mod quick;
mod shell;
mod sound;
mod theme;
mod ui;
mod update;
mod util;
mod window;

use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, LPARAM, WPARAM};
use windows::Win32::System::DataExchange::COPYDATASTRUCT;
use windows::Win32::System::Ole::OleInitialize;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SendMessageW, WM_COPYDATA};

use util::WStr;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Developer helpers.
    if let Some(i) = args.iter().position(|a| a == "--export-icon") {
        init_com();
        let out = args.get(i + 1).cloned().unwrap_or_else(|| "comesshot.ico".into());
        match icon::export_ico(std::path::Path::new(&out)) {
            Ok(()) => println!("icono escrito en {out}"),
            Err(e) => eprintln!("error: {e}"),
        }
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--preview") {
        init_dpi();
        init_com();
        let dir = args.get(i + 1).cloned().unwrap_or_else(|| "preview".into());
        if let Some(code) = args.iter().position(|a| a == "--lang").and_then(|j| args.get(j + 1)) {
            plang::set(code);
        }
        preview::run(std::path::Path::new(&dir));
        return;
    }
    if args.iter().any(|a| a == "--check-update") {
        // Diagnostic: what the updater would install (downloads and verifies, never installs).
        init_com();
        println!("versión actual: {}", env!("CARGO_PKG_VERSION"));
        match update::check() {
            Some(a) => match update::download(&a) {
                Ok(p) => println!("nueva versión {} descargada y verificada en {}", a.version, p.display()),
                Err(e) => println!("nueva versión {}: {e}", a.version),
            },
            None => println!("no hay una versión más nueva publicada"),
        }
        return;
    }
    if args.iter().any(|a| a == "--ip-country") {
        // Diagnostic: what automatic language sees.
        let ip = net::ip_country();
        let lang = i18n::resolve(i18n::device(), ip.as_ref().and_then(|(c, _)| i18n::locale_from_country(c)));
        println!("dispositivo: {:?} · IP: {:?} → {:?}", i18n::device(), ip, lang);
        return;
    }
    if args.iter().any(|a| a == "--bench") {
        init_dpi();
        init_com();
        bench();
        return;
    }

    init_dpi();
    let background = args.iter().any(|a| a == "--background");
    let action = args.iter().find_map(|a| app::Action::from_arg(a));
    // Started by the updater: the old version is still closing.
    let updated = args.iter().find_map(|a| a.strip_prefix("--updated=")).map(|v| v.to_string());

    // One instance only; later launches forward their command to it.
    let name = WStr::new(r"Local\ComesADE.ComesShot");
    let mut tries = if updated.is_some() { 100 } else { 1 };
    let _mutex = loop {
        let m = unsafe { CreateMutexW(None, true, name.p()) };
        if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            break m;
        }
        tries -= 1;
        if tries == 0 {
            forward(action.map(|a| a.name()).unwrap_or("show"));
            return;
        }
        if let Ok(h) = m {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(h);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };

    init_com();
    config::load();
    update::cleanup();
    app::run(action, background, updated);
}

fn init_dpi() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn init_com() {
    unsafe {
        let _ = OleInitialize(None);
    }
}

fn forward(cmd: &str) {
    let class = WStr::new(app::MAIN_CLASS);
    unsafe {
        if let Ok(hwnd) = FindWindowW(class.p(), windows::core::PCWSTR::null()) {
            let data = cmd.as_bytes();
            let cds = COPYDATASTRUCT { dwData: 1, cbData: data.len() as u32, lpData: data.as_ptr() as _ };
            SendMessageW(hwnd, WM_COPYDATA, Some(WPARAM(0)), Some(LPARAM(&cds as *const _ as isize)));
        }
    }
}

/// Measures capture and encode speed on this machine.
fn bench() {
    use std::time::Instant;
    let mons = capture::monitors();
    for m in &mons {
        println!("monitor {}x{} en ({}, {}) a {} dpi{}", m.rect.w, m.rect.h, m.rect.x, m.rect.y, m.dpi, if m.primary { " (principal)" } else { "" });
    }
    let vr = capture::virtual_rect();
    let t = Instant::now();
    dxgi::warm_up();
    println!("preparar DXGI (una vez, al arrancar): {:?}", t.elapsed());
    std::thread::sleep(std::time::Duration::from_millis(100));
    let mut times = Vec::new();
    for _ in 0..10 {
        let t = Instant::now();
        let img = dxgi::grab(vr).expect("DXGI no disponible");
        times.push(t.elapsed());
        assert_eq!((img.width, img.height), (vr.w as u32, vr.h as u32));
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    times.sort();
    println!(
        "DXGI escritorio completo {}x{}: mediana {:?}, peor {:?}",
        vr.w, vr.h, times[times.len() / 2], times[times.len() - 1]
    );
    let m = &mons[0];
    let t = Instant::now();
    let _ = dxgi::grab(m.rect).expect("DXGI");
    println!("DXGI un monitor {}x{}: {:?}", m.rect.w, m.rect.h, t.elapsed());
    let t = Instant::now();
    let gdi = capture::grab_gdi(vr).expect("GDI");
    println!("GDI escritorio completo (antes): {:?}", t.elapsed());
    // Both paths must produce the same pixels (screen permitting).
    let fast = dxgi::grab(vr).expect("DXGI");
    let same = fast.data.iter().zip(gdi.data.iter()).filter(|(a, b)| a == b).count();
    println!("coincidencia DXGI vs GDI: {:.2} % de bytes", same as f64 * 100.0 / gdi.data.len() as f64);
    let t = Instant::now();
    let snap = capture::snapshot().expect("snapshot");
    println!("snapshot (imagen + {} ventanas): {:?}", snap.windows.len(), t.elapsed());
    // Encode timing; the file holds the real screen, so it is deleted at once.
    let p = std::env::temp_dir().join("comesshot-bench.png");
    let t = Instant::now();
    gfx::save_image(&snap.image, &p, None).expect("png");
    println!("PNG guardado (en segundo plano en la app): {:?}", t.elapsed());
    let _ = std::fs::remove_file(&p);
}
