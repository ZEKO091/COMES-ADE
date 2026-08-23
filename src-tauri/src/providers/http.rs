use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

use crate::providers::types::{ProviderId, StoredProviderCredentials};

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(90))
        .user_agent("ComesADE/Desktop")
        .build()
        .map_err(|error| format!("No se pudo preparar la conexion HTTPS: {error}"))
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

pub fn generate_pkce() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn random_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn response_error(response: Response, fallback: &str) -> String {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| error.as_str().map(str::to_string))
                })
                .or_else(|| {
                    value
                        .get("error_description")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .or_else(|| value.get("message").and_then(Value::as_str).map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(280).collect());
    if detail.trim().is_empty() {
        format!("{fallback} ({status})")
    } else {
        format!("{fallback} ({status}): {detail}")
    }
}

/// Devuelve el cuerpo decodificado de un JWT, sin verificar la firma. Solo se
/// usa para leer datos de la propia cuenta que el proveedor acaba de emitir.
pub fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

pub fn jwt_account_label(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    value
        .get("email")
        .and_then(Value::as_str)
        .or_else(|| value.get("preferred_username").and_then(Value::as_str))
        .or_else(|| value.get("name").and_then(Value::as_str))
        .map(str::to_string)
}

pub fn json_tools() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "Lista archivos y carpetas del workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "relative": { "type": "string", "description": "Ruta relativa al workspace. Vacio = raiz." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Lee un archivo de texto del workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "relative": { "type": "string" }
                    },
                    "required": ["relative"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Escribe un archivo de texto en el workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "relative": { "type": "string" },
                        "content": { "type": "string" }
                    },
                    "required": ["relative", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_code",
                "description": "Busca texto en el workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_status",
                "description": "Muestra el estado Git real del workspace.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Ejecuta un comando de shell en el workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" }
                    },
                    "required": ["command"]
                }
            }
        }
    ])
}

pub fn anthropic_tools() -> Value {
    json!([
        {
            "name": "list_files",
            "description": "Lista archivos y carpetas del workspace.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "relative": { "type": "string" }
                }
            }
        },
        {
            "name": "read_file",
            "description": "Lee un archivo de texto del workspace.",
            "input_schema": {
                "type": "object",
                "properties": { "relative": { "type": "string" } },
                "required": ["relative"]
            }
        },
        {
            "name": "write_file",
            "description": "Escribe un archivo de texto en el workspace.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "relative": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["relative", "content"]
            }
        },
        {
            "name": "search_code",
            "description": "Busca texto en el workspace.",
            "input_schema": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }
        },
        {
            "name": "git_status",
            "description": "Muestra el estado Git real del workspace.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "run_command",
            "description": "Ejecuta un comando de shell en el workspace.",
            "input_schema": {
                "type": "object",
                "properties": { "command": { "type": "string" } },
                "required": ["command"]
            }
        }
    ])
}

pub fn gemini_tools() -> Value {
    json!([{
        "functionDeclarations": [
            { "name": "list_files", "description": "Lista archivos del workspace.", "parameters": { "type": "OBJECT", "properties": { "relative": { "type": "STRING" } } } },
            { "name": "read_file", "description": "Lee un archivo.", "parameters": { "type": "OBJECT", "properties": { "relative": { "type": "STRING" } }, "required": ["relative"] } },
            { "name": "write_file", "description": "Escribe un archivo.", "parameters": { "type": "OBJECT", "properties": { "relative": { "type": "STRING" }, "content": { "type": "STRING" } }, "required": ["relative", "content"] } },
            { "name": "search_code", "description": "Busca texto.", "parameters": { "type": "OBJECT", "properties": { "query": { "type": "STRING" } }, "required": ["query"] } },
            { "name": "git_status", "description": "Estado Git.", "parameters": { "type": "OBJECT", "properties": {} } },
            { "name": "run_command", "description": "Comando de shell.", "parameters": { "type": "OBJECT", "properties": { "command": { "type": "STRING" } }, "required": ["command"] } }
        ]
    }])
}

pub fn credential_needs_refresh(credentials: &StoredProviderCredentials) -> bool {
    if credentials.auth_mode == "api_key" {
        return false;
    }
    match credentials.access_token_expires_at {
        Some(expires) => expires.saturating_sub(90) <= now_secs(),
        None => false,
    }
}

pub fn provider_from_agent_type(agent_type: &str) -> Option<ProviderId> {
    let value = agent_type.trim().to_ascii_lowercase();
    if value.contains("claude") {
        Some(ProviderId::Anthropic)
    } else if value.contains("codex") || value.contains("openai") || value.contains("chatgpt") {
        Some(ProviderId::Openai)
    } else if value.contains("antigravity") || value == "agy" {
        Some(ProviderId::Antigravity)
    } else if value.contains("gemini") {
        Some(ProviderId::Gemini)
    } else if value.contains("cursor") || value == "agent" {
        Some(ProviderId::Cursor)
    } else if value.contains("grok") || value.contains("xai") {
        Some(ProviderId::Xai)
    } else if value.contains("deepseek") {
        Some(ProviderId::Deepseek)
    } else if value.contains("glm") || value.contains("zhipu") {
        Some(ProviderId::Glm)
    } else if value.contains("kimi") || value.contains("moonshot") {
        Some(ProviderId::Kimi)
    } else if value.contains("droid") || value.contains("factory") {
        Some(ProviderId::Droid)
    } else if value.contains("aider") {
        Some(ProviderId::Aider)
    } else if value.contains("kilo") {
        Some(ProviderId::Kilo)
    } else if value.contains("github") || value.contains("copilot") {
        Some(ProviderId::Github)
    } else if value == "pi" || value.starts_with("pi ") {
        Some(ProviderId::Pi)
    } else if value.contains("qwen") || value.contains("dashscope") {
        Some(ProviderId::Qwen)
    } else if value.contains("opencode") {
        Some(ProviderId::Opencode)
    } else if value.contains("openrouter") {
        Some(ProviderId::Openrouter)
    } else {
        None
    }
}

pub fn normalize_effort(effort: Option<&str>) -> Option<String> {
    let value = effort?.trim().to_ascii_lowercase();
    match value.as_str() {
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" => Some(value),
        "extra" | "extra-high" | "extra_high" | "extrahigh" => Some("xhigh".into()),
        _ => None,
    }
}

pub fn openai_reasoning(effort: Option<&str>) -> Option<Value> {
    normalize_effort(effort).map(|value| json!({ "effort": value }))
}

pub fn openai_reasoning_effort_field(effort: Option<&str>) -> Option<String> {
    match normalize_effort(effort)?.as_str() {
        "ultra" => Some("max".into()),
        value => Some(value.into()),
    }
}

pub fn xai_reasoning_effort(effort: Option<&str>) -> Option<&'static str> {
    match normalize_effort(effort)?.as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        _ => None,
    }
}

pub fn anthropic_thinking(effort: Option<&str>) -> (u32, Option<Value>) {
    let Some(value) = normalize_effort(effort) else {
        return (8192, None);
    };
    let budget = match value.as_str() {
        "low" => 2_048,
        "medium" => 8_192,
        "high" => 16_000,
        "xhigh" => 24_000,
        "max" => 32_000,
        "ultra" => 48_000,
        _ => 8_192,
    };
    (
        budget + 8_192,
        Some(json!({ "type": "enabled", "budget_tokens": budget })),
    )
}

pub fn gemini_thinking_budget(effort: Option<&str>) -> Option<i32> {
    match normalize_effort(effort)?.as_str() {
        "low" => Some(1_024),
        "medium" => Some(4_096),
        "high" => Some(8_192),
        "xhigh" => Some(16_384),
        "max" => Some(24_576),
        "ultra" => Some(-1),
        _ => Some(4_096),
    }
}
