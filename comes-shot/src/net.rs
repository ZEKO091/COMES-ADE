//! Minimal HTTPS GET over WinHTTP (built into Windows, no extra crates).
//! Used only to learn the country of the public IP for automatic language,
//! the same way ComesADE does.

use windows::core::PCWSTR;
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetTimeouts,
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
};

use crate::util::wide;

struct Handle(*mut core::ffi::c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = WinHttpCloseHandle(self.0);
            }
        }
    }
}

/// GET https://{host}{path}; returns the body as text on HTTP 200.
pub fn get(host: &str, path: &str, timeout_ms: i32) -> Option<String> {
    String::from_utf8(get_bytes(host, path, timeout_ms, 64 * 1024)?).ok()
}

/// GET of a full https:// URL (redirects are followed), at most `max` bytes.
pub fn get_url(url: &str, timeout_ms: i32, max: usize) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("https://")?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    get_bytes(host, path, timeout_ms, max)
}

pub fn get_bytes(host: &str, path: &str, timeout_ms: i32, max: usize) -> Option<Vec<u8>> {
    unsafe {
        let agent = wide(concat!("ComesShot/", env!("CARGO_PKG_VERSION")));
        let session = Handle(WinHttpOpen(PCWSTR(agent.as_ptr()), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0));
        if session.0.is_null() {
            return None;
        }
        let _ = WinHttpSetTimeouts(session.0, timeout_ms, timeout_ms, timeout_ms, timeout_ms);
        let h = wide(host);
        let conn = Handle(WinHttpConnect(session.0, PCWSTR(h.as_ptr()), 443, 0));
        if conn.0.is_null() {
            return None;
        }
        let verb = wide("GET");
        let p = wide(path);
        let req = Handle(WinHttpOpenRequest(conn.0, PCWSTR(verb.as_ptr()), PCWSTR(p.as_ptr()), PCWSTR::null(), PCWSTR::null(), std::ptr::null(), WINHTTP_FLAG_SECURE));
        if req.0.is_null() {
            return None;
        }
        WinHttpSendRequest(req.0, None, None, 0, 0, 0).ok()?;
        WinHttpReceiveResponse(req.0, std::ptr::null_mut()).ok()?;
        let mut status = 0u32;
        let mut len = 4u32;
        WinHttpQueryHeaders(
            req.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as _),
            &mut len,
            std::ptr::null_mut(),
        )
        .ok()?;
        if status != 200 {
            return None;
        }
        let mut body = Vec::new();
        loop {
            let mut avail = 0u32;
            WinHttpQueryDataAvailable(req.0, &mut avail).ok()?;
            if avail == 0 {
                break;
            }
            if body.len() + avail as usize > max {
                return None;
            }
            let mut buf = vec![0u8; avail as usize];
            let mut read = 0u32;
            WinHttpReadData(req.0, buf.as_mut_ptr() as _, avail, &mut read).ok()?;
            body.extend_from_slice(&buf[..read as usize]);
        }
        Some(body)
    }
}

/// Country (ISO code, display name) of the public IP: ComesADE's API first,
/// then Cloudflare's trace, as ComesADE does.
pub fn ip_country() -> Option<(String, String)> {
    let valid = |c: &str| c.len() == 2 && c.chars().all(|ch| ch.is_ascii_alphabetic()) && c != "XX" && c != "T1";
    if let Some(body) = get("comesade-api.kingfrianfrian16.workers.dev", "/v1/locale", 3500) {
        if let Some(code) = json_str(&body, "country").map(|c| c.to_ascii_uppercase()).filter(|c| valid(c)) {
            let name = json_str(&body, "countryName").filter(|n| !n.is_empty()).unwrap_or_else(|| code.clone());
            return Some((code, name));
        }
    }
    let body = get("www.cloudflare.com", "/cdn-cgi/trace", 4500)?;
    let code = body.lines().find_map(|l| l.strip_prefix("loc="))?.trim().to_ascii_uppercase();
    valid(&code).then(|| (code.clone(), code))
}

/// Reads `"key":"value"` from a flat JSON object (enough for this API).
fn json_str(body: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\"");
    let rest = &body[body.find(&pat)? + pat.len()..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_json() {
        let b = r#"{"country":"DO","countryName":"Dominican Republic","x":1}"#;
        assert_eq!(super::json_str(b, "country").as_deref(), Some("DO"));
        assert_eq!(super::json_str(b, "countryName").as_deref(), Some("Dominican Republic"));
        assert_eq!(super::json_str(b, "missing"), None);
    }
}
