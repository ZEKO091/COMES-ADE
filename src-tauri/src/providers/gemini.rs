use serde_json::{json, Value};
use std::collections::HashMap;

use crate::providers::{
    http::{gemini_thinking_budget, gemini_tools, http_client, response_error},
    types::{ProviderId, StoredProviderCredentials},
    usage,
};

pub const STUDIO_KEY_URL: &str = "https://aistudio.google.com/apikey";

pub fn chat(
    credentials: &StoredProviderCredentials,
    contents: &[Value],
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Value, String> {
    let key = credentials
        .api_key
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or("Gemini necesita una API key real de Google AI Studio.")?;
    let model_name = model.unwrap_or("gemini-2.5-flash");
    let client = http_client()?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={}",
        urlencoding::encode(key)
    );
    let mut payload = json!({
        "systemInstruction": { "parts": [{ "text": "Eres el agente de ComesADE. Usa las herramientas reales del workspace." }] },
        "contents": contents,
        "tools": gemini_tools(),
    });
    if let Some(budget) = gemini_thinking_budget(effort) {
        payload["generationConfig"] = json!({
            "thinkingConfig": { "thinkingBudget": budget }
        });
    }
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .map_err(|error| format!("No se pudo hablar con Gemini: {error}"))?;
    usage::capture(
        ProviderId::Gemini,
        &credentials.auth_mode,
        response.status().as_u16(),
        response.headers(),
    );
    if !response.status().is_success() {
        return Err(response_error(response, "Gemini rechazo la solicitud"));
    }
    response
        .json()
        .map_err(|error| format!("Respuesta invalida de Gemini: {error}"))
}

pub fn launch_env(credentials: &StoredProviderCredentials) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(key) = credentials.api_key.as_ref().filter(|value| !value.is_empty()) {
        env.insert("GEMINI_API_KEY".into(), key.clone());
        env.insert("GOOGLE_API_KEY".into(), key.clone());
    }
    env
}
