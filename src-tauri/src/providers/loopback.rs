use std::{
    io::{ErrorKind, Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use crate::providers::types::StoredProviderCredentials;

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn bind_loopback(port: u16) -> Result<Vec<TcpListener>, String> {
    let mut listeners = Vec::new();
    for host in ["127.0.0.1", "[::1]"] {
        let addr = format!("{host}:{port}");
        if let Ok(listener) = TcpListener::bind(&addr) {
            let _ = listener.set_nonblocking(true);
            listeners.push(listener);
        }
    }
    if listeners.is_empty() {
        Err(format!(
            "No se pudo abrir el callback local en el puerto {port}."
        ))
    } else {
        Ok(listeners)
    }
}

pub fn spawn_oauth_listener<F>(
    listeners: Vec<TcpListener>,
    expected_state: String,
    parse: fn(&str, &str) -> Result<String, String>,
    success_html: &'static str,
    exchange: F,
    slot: Arc<Mutex<Option<Result<StoredProviderCredentials, String>>>>,
) where
    F: FnOnce(String) -> Result<StoredProviderCredentials, String> + Send + 'static,
{
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(600);
        let mut exchange = Some(exchange);
        while Instant::now() < deadline {
            for listener in &listeners {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
                        let mut buffer = [0u8; 8192];
                        let read = stream.read(&mut buffer).unwrap_or(0);
                        let request = String::from_utf8_lossy(&buffer[..read]);
                        let first_line = request.lines().next().unwrap_or_default();
                        match parse(first_line, &expected_state) {
                            Ok(code) => {
                                if let Some(exchange) = exchange.take() {
                                    let result = exchange(code);
                                    let (ok, body) = match &result {
                            Ok(_) => (true, success_html.to_string()),
                            Err(error) => (
                                false,
                                format!(
                                    "<!doctype html><html><body style='font-family:sans-serif;background:#111;color:#eee;padding:40px'><h1>No se pudo completar el acceso</h1><p>{}</p><p>Vuelve a ComesADE e intenta de nuevo.</p></body></html>",
                                    html_escape(error)
                                ),
                            ),
                                    };
                                    let _ = write!(
                                        stream,
                                        "HTTP/1.1 {} \r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                        if ok { "200 OK" } else { "400 Bad Request" },
                                        body.len(),
                                        body
                                    );
                                    if let Ok(mut guard) = slot.lock() {
                                        *guard = Some(result);
                                    }
                                }
                                return;
                            }
                            Err(error)
                                if error.contains("rechazo")
                                    || error.contains("estado OAuth") =>
                            {
                                let body = format!(
                                    "<!doctype html><html><body style='font-family:sans-serif;background:#111;color:#eee;padding:40px'><h1>Login cancelado</h1><p>{}</p></body></html>",
                                    html_escape(&error)
                                );
                                let _ = write!(
                                    stream,
                                    "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    body.len(),
                                    body
                                );
                                if let Ok(mut guard) = slot.lock() {
                                    *guard = Some(Err(error));
                                }
                                return;
                            }
                            Err(_) => {
                                let _ = write!(
                                    stream,
                                    "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                );
                            }
                        }
                    }
                    Err(error)
                        if error.kind() == ErrorKind::WouldBlock
                            || error.kind() == ErrorKind::TimedOut => {}
                    Err(_) => {}
                }
            }
            thread::sleep(Duration::from_millis(40));
        }
        if let Ok(mut guard) = slot.lock() {
            if guard.is_none() {
                *guard = Some(Err("El login expiro. Vuelve a conectar.".into()));
            }
        }
    });
}
