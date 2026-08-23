//! Lectura del consumo real del plan del usuario.
//!
//! Cuando alguien conecta su cuenta de ChatGPT, Grok, Claude u otro proveedor,
//! el limite lo impone el propio proveedor: ventanas de horas, semanales o
//! mensuales segun el plan contratado. Aqui solo se lee lo que el proveedor
//! publica en cada respuesta. Si un proveedor no informa de nada, no se guarda
//! ninguna ventana y la interfaz mostrara "sin datos" en vez de inventar cifras.

use std::{collections::HashMap, sync::Mutex};

use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::providers::{http::now_secs, types::ProviderId};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Etiqueta legible de la ventana: "5 h", "Semana", "Mes"...
    pub label: String,
    pub used_percent: Option<f64>,
    pub limit: Option<u64>,
    pub remaining: Option<u64>,
    /// Momento del reset en segundos epoch.
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider: String,
    pub provider_name: String,
    /// "oauth" para cuentas de suscripcion, "api_key" para llaves sueltas.
    pub plan_mode: String,
    pub windows: Vec<UsageWindow>,
    pub captured_at: u64,
    /// Segundos que el proveedor pide esperar tras un 429.
    pub retry_after: Option<u64>,
    pub exhausted: bool,
}

impl UsageSnapshot {
    fn new(provider: ProviderId, plan_mode: &str) -> Self {
        Self {
            provider: provider.as_str().to_string(),
            provider_name: provider.display_name().to_string(),
            plan_mode: plan_mode.to_string(),
            windows: Vec::new(),
            captured_at: now_secs(),
            retry_after: None,
            exhausted: false,
        }
    }

    fn has_data(&self) -> bool {
        !self.windows.is_empty() || self.retry_after.is_some()
    }
}

static USAGE: Mutex<Option<HashMap<String, UsageSnapshot>>> = Mutex::new(None);

fn store(snapshot: UsageSnapshot) {
    if let Ok(mut guard) = USAGE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(snapshot.provider.clone(), snapshot);
    }
}

pub fn snapshot(provider: ProviderId) -> Option<UsageSnapshot> {
    USAGE
        .lock()
        .ok()?
        .as_ref()?
        .get(provider.as_str())
        .cloned()
}

pub fn all() -> Vec<UsageSnapshot> {
    let Ok(guard) = USAGE.lock() else {
        return Vec::new();
    };
    let Some(map) = guard.as_ref() else {
        return Vec::new();
    };
    let mut list: Vec<UsageSnapshot> = map.values().cloned().collect();
    list.sort_by(|left, right| left.provider.cmp(&right.provider));
    list
}

/// Rehidrata lo ultimo que se leyo en una sesion anterior, para que la interfaz
/// muestre algo antes de la primera llamada del dia.
pub fn restore(snapshots: Vec<UsageSnapshot>) {
    if let Ok(mut guard) = USAGE.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        for snapshot in snapshots {
            map.entry(snapshot.provider.clone()).or_insert(snapshot);
        }
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn header_f64(headers: &HeaderMap, name: &str) -> Option<f64> {
    header(headers, name)?.trim().parse().ok()
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    header(headers, name)?.trim().parse().ok()
}

/// Etiqueta la ventana a partir de su duracion en minutos.
fn window_label(minutes: u64) -> String {
    match minutes {
        0 => "Ventana".to_string(),
        m if m >= 40_320 => "Mes".to_string(),
        m if m >= 10_080 => "Semana".to_string(),
        m if m >= 1_440 => format!("{} d", m / 1_440),
        m if m >= 60 => format!("{} h", m / 60),
        m => format!("{m} min"),
    }
}

/// Convierte duraciones tipo "6m0s", "1h2m3s" o "500ms" en segundos.
fn parse_duration_secs(value: &str) -> Option<u64> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(plain) = text.parse::<f64>() {
        return Some(plain.max(0.0).round() as u64);
    }
    let mut total = 0f64;
    let mut number = String::new();
    let mut unit = String::new();
    let mut matched = false;
    for character in text.chars() {
        if character.is_ascii_digit() || character == '.' {
            if !unit.is_empty() {
                total += apply_unit(&number, &unit)?;
                number.clear();
                unit.clear();
                matched = true;
            }
            number.push(character);
        } else if character.is_ascii_alphabetic() {
            unit.push(character);
        }
    }
    if !number.is_empty() && !unit.is_empty() {
        total += apply_unit(&number, &unit)?;
        matched = true;
    }
    if matched {
        Some(total.max(0.0).round() as u64)
    } else {
        None
    }
}

fn apply_unit(number: &str, unit: &str) -> Option<f64> {
    let amount: f64 = number.parse().ok()?;
    let factor = match unit {
        "ms" => 0.001,
        "s" => 1.0,
        "m" => 60.0,
        "h" => 3_600.0,
        "d" => 86_400.0,
        _ => return None,
    };
    Some(amount * factor)
}

/// Convierte una marca RFC3339 ("2026-08-22T14:03:05Z") en segundos epoch.
fn parse_rfc3339_epoch(value: &str) -> Option<u64> {
    let text = value.trim();
    let (date, rest) = text.split_once('T')?;
    let time: String = rest
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == ':')
        .collect();
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next().unwrap_or("0").parse().ok()?;
    let second: i64 = time_parts.next().unwrap_or("0").parse().ok()?;
    let days = days_from_civil(year, month, day);
    let epoch = days * 86_400 + hour * 3_600 + minute * 60 + second;
    u64::try_from(epoch).ok()
}

/// Algoritmo civil-a-dias de Howard Hinnant, sin dependencias externas.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn resets_at_from_seconds(seconds: u64) -> Option<u64> {
    Some(now_secs().saturating_add(seconds))
}

/// Ventanas del plan de ChatGPT que Codex publica como cabeceras propias.
fn codex_windows(headers: &HeaderMap) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    for prefix in ["primary", "secondary"] {
        let used = header_f64(headers, &format!("x-codex-{prefix}-used-percent"));
        let minutes = header_u64(headers, &format!("x-codex-{prefix}-window-minutes"));
        let resets = header_u64(headers, &format!("x-codex-{prefix}-reset-after-seconds"));
        if used.is_none() && minutes.is_none() && resets.is_none() {
            continue;
        }
        windows.push(UsageWindow {
            label: window_label(minutes.unwrap_or(0)),
            used_percent: used,
            limit: None,
            remaining: None,
            resets_at: resets.and_then(resets_at_from_seconds),
        });
    }
    windows
}

/// Cabeceras de limite de Anthropic, incluidas las del plan de Claude Code.
fn anthropic_windows(headers: &HeaderMap) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    for (prefix, label) in [
        ("anthropic-ratelimit-unified", "Plan"),
        ("anthropic-ratelimit-requests", "Peticiones"),
        ("anthropic-ratelimit-tokens", "Tokens"),
    ] {
        let limit = header_u64(headers, &format!("{prefix}-limit"));
        let remaining = header_u64(headers, &format!("{prefix}-remaining"));
        let resets_at = header(headers, &format!("{prefix}-reset"))
            .and_then(|value| {
                parse_rfc3339_epoch(value).or_else(|| parse_duration_secs(value).and_then(resets_at_from_seconds))
            });
        if limit.is_none() && remaining.is_none() && resets_at.is_none() {
            continue;
        }
        let used_percent = match (limit, remaining) {
            (Some(limit), Some(remaining)) if limit > 0 => {
                Some(((limit.saturating_sub(remaining)) as f64 / limit as f64) * 100.0)
            }
            _ => None,
        };
        windows.push(UsageWindow {
            label: label.to_string(),
            used_percent,
            limit,
            remaining,
            resets_at,
        });
    }
    windows
}

/// Cabeceras `x-ratelimit-*` que usan OpenAI, xAI y los compatibles.
fn standard_windows(headers: &HeaderMap) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    for (suffix, label) in [("requests", "Peticiones"), ("tokens", "Tokens")] {
        let limit = header_u64(headers, &format!("x-ratelimit-limit-{suffix}"));
        let remaining = header_u64(headers, &format!("x-ratelimit-remaining-{suffix}"));
        let resets_at = header(headers, &format!("x-ratelimit-reset-{suffix}"))
            .and_then(parse_duration_secs)
            .and_then(resets_at_from_seconds);
        if limit.is_none() && remaining.is_none() && resets_at.is_none() {
            continue;
        }
        let used_percent = match (limit, remaining) {
            (Some(limit), Some(remaining)) if limit > 0 => {
                Some(((limit.saturating_sub(remaining)) as f64 / limit as f64) * 100.0)
            }
            _ => None,
        };
        windows.push(UsageWindow {
            label: label.to_string(),
            used_percent,
            limit,
            remaining,
            resets_at,
        });
    }
    windows
}

/// Lee el consumo de una respuesta real. Debe llamarse antes de consumir el
/// cuerpo, porque `json()` toma posesion de la respuesta.
pub fn capture(
    provider: ProviderId,
    plan_mode: &str,
    status: u16,
    headers: &HeaderMap,
) -> Option<UsageSnapshot> {
    let mut snapshot = UsageSnapshot::new(provider, plan_mode);

    snapshot.windows = match provider {
        ProviderId::Openai if plan_mode != "api_key" => {
            let codex = codex_windows(headers);
            if codex.is_empty() {
                standard_windows(headers)
            } else {
                codex
            }
        }
        ProviderId::Anthropic => {
            let anthropic = anthropic_windows(headers);
            if anthropic.is_empty() {
                standard_windows(headers)
            } else {
                anthropic
            }
        }
        _ => standard_windows(headers),
    };

    if status == 429 {
        snapshot.exhausted = true;
        snapshot.retry_after = header(headers, "retry-after")
            .and_then(parse_duration_secs)
            .or(Some(0));
    }
    snapshot.exhausted = snapshot.exhausted
        || snapshot
            .windows
            .iter()
            .any(|window| window.used_percent.is_some_and(|used| used >= 100.0));

    if !snapshot.has_data() {
        return None;
    }
    store(snapshot.clone());
    Some(snapshot)
}

/// Algunos backends de suscripcion mandan los limites dentro del cuerpo, no en
/// las cabeceras. Se fusiona sin pisar lo que ya se leyo de las cabeceras.
pub fn capture_body(provider: ProviderId, plan_mode: &str, body: &Value) -> Option<UsageSnapshot> {
    let limits = body.get("rate_limits")?;
    let mut windows = Vec::new();
    for key in ["primary", "secondary"] {
        let Some(window) = limits.get(key) else {
            continue;
        };
        let minutes = window
            .get("window_minutes")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let used_percent = window.get("used_percent").and_then(Value::as_f64);
        let resets_at = window
            .get("resets_in_seconds")
            .and_then(Value::as_u64)
            .and_then(resets_at_from_seconds);
        if used_percent.is_none() && resets_at.is_none() {
            continue;
        }
        windows.push(UsageWindow {
            label: window_label(minutes),
            used_percent,
            limit: None,
            remaining: None,
            resets_at,
        });
    }
    if windows.is_empty() {
        return None;
    }
    let mut snapshot = snapshot(provider).unwrap_or_else(|| UsageSnapshot::new(provider, plan_mode));
    snapshot.windows = windows;
    snapshot.captured_at = now_secs();
    snapshot.exhausted = snapshot
        .windows
        .iter()
        .any(|window| window.used_percent.is_some_and(|used| used >= 100.0));
    store(snapshot.clone());
    Some(snapshot)
}
