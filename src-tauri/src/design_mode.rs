use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy)]
pub struct DesignBridgePort(pub u16);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignBridgeInfo {
    pub port: u16,
}

pub fn start(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("No se pudo abrir el puente de Design Mode: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("No se pudo leer el puerto de Design Mode: {error}"))?
        .port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buf = vec![0_u8; 262_144];
            let read = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..read]);
            if request.starts_with("OPTIONS ") {
                let _ = stream.write_all(
                    b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nConnection: close\r\n\r\n",
                );
                continue;
            }
            let body = request.split("\r\n\r\n").nth(1).unwrap_or("").trim();
            if !body.is_empty() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
                    let _ = app.emit("design-pick", value);
                }
            }
            let _ = stream.write_all(
                b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
            );
        }
    });
    Ok(port)
}

#[tauri::command]
pub fn design_bridge_port(port: tauri::State<DesignBridgePort>) -> DesignBridgeInfo {
    DesignBridgeInfo { port: port.0 }
}

#[tauri::command]
pub fn webview_eval(app: AppHandle, label: String, script: String) -> Result<(), String> {
    app.get_webview(&label)
        .ok_or_else(|| format!("No hay un preview activo ({label})."))?
        .eval(&script)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn capture_webview_region(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    dpr: f64,
) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("No hay un preview activo ({label})."))?;
    if !x.is_finite()
        || !y.is_finite()
        || !w.is_finite()
        || !h.is_finite()
        || !dpr.is_finite()
        || w <= 0.0
        || h <= 0.0
        || dpr <= 0.0
        || dpr > 4.0
    {
        return Err("La zona de captura no es valida.".into());
    }
    let scale = if dpr > 0.1 { dpr } else { 1.0 };
    let px = (x * scale).floor();
    let py = (y * scale).floor();
    let pw = (w * scale).ceil();
    let ph = (h * scale).ceil();
    if !px.is_finite()
        || !py.is_finite()
        || !pw.is_finite()
        || !ph.is_finite()
        || pw < 2.0
        || ph < 2.0
        || pw > 8192.0
        || ph > 8192.0
        || pw * ph > 16_000_000.0
    {
        return Err("La zona de captura es demasiado grande.".into());
    }
    let px = px as i32;
    let py = py as i32;
    let pw = pw as i32;
    let ph = ph as i32;
    if pw < 2 || ph < 2 {
        return Err("La zona seleccionada es demasiado pequeña.".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, px, py, pw, ph);
        return Err("Design capture solo esta disponible en Windows.".into());
    }
    #[cfg(windows)]
    {
        let window_pos = webview
            .window()
            .inner_position()
            .map_err(|error| format!("No se pudo leer la ventana: {error}"))?;
        let web_pos = webview
            .position()
            .map_err(|error| format!("No se pudo leer el preview: {error}"))?;
        let png = unsafe {
            capture_screen_region(window_pos.x + web_pos.x + px, window_pos.y + web_pos.y + py, pw, ph)?
        };
        Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
    }
}

#[cfg(windows)]
fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut encoder = png::Encoder::new(&mut buf, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .and_then(|mut writer| writer.write_image_data(rgba))
        .map_err(|error| format!("No se pudo codificar la captura: {error}"))?;
    Ok(buf)
}

#[cfg(windows)]
unsafe fn capture_screen_region(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        SRCCOPY,
    };

    const CAPTUREBLT: u32 = 0x4000_0000;

    let screen = GetDC(std::ptr::null_mut());
    if screen.is_null() {
        return Err("No se pudo leer la pantalla.".into());
    }
    let mem_dc = CreateCompatibleDC(screen);
    if mem_dc.is_null() {
        ReleaseDC(std::ptr::null_mut(), screen);
        return Err("No se pudo crear el buffer de captura.".into());
    }
    let bmp = CreateCompatibleBitmap(screen, w, h);
    if bmp.is_null() {
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen);
        return Err("No se pudo crear el buffer de captura.".into());
    }
    let old = SelectObject(mem_dc, bmp);
    if BitBlt(mem_dc, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT) == 0 {
        SelectObject(mem_dc, old);
        DeleteObject(bmp);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen);
        return Err("No se pudo copiar la zona de la pantalla.".into());
    }

    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let mut bgra = vec![0_u8; (w * h * 4) as usize];
    let copied = GetDIBits(
        mem_dc,
        bmp,
        0,
        h as u32,
        bgra.as_mut_ptr() as *mut _,
        &mut info,
        DIB_RGB_COLORS,
    );
    SelectObject(mem_dc, old);
    DeleteObject(bmp);
    DeleteDC(mem_dc);
    ReleaseDC(std::ptr::null_mut(), screen);
    if copied == 0 {
        return Err("No se pudieron leer los pixeles del preview.".into());
    }
    let mut rgba = vec![0_u8; bgra.len()];
    for (src, dest) in bgra.chunks_exact(4).zip(rgba.chunks_exact_mut(4)) {
        dest[0] = src[2];
        dest[1] = src[1];
        dest[2] = src[0];
        dest[3] = 255;
    }
    encode_png_rgba(w as u32, h as u32, &rgba)
}
