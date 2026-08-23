use serde_json::{json, Value};
use std::collections::HashMap;

use crate::providers::{
    http::{http_client, json_tools, openai_reasoning_effort_field, response_error},
    types::{ProviderId, StoredProviderCredentials},
    usage,
};

pub fn chat(
    provider: ProviderId,
    credentials: &StoredProviderCredentials,
    messages: &[Value],
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Value, String> {
    let url = provider
        .chat_completions_url()
        .ok_or_else(|| format!("{} no expone una API OpenAI-compatible.", provider.display_name()))?;
    let token = credentials
        .bearer()
        .ok_or_else(|| format!("No hay credencial de {}.", provider.display_name()))?;
    let mut payload = json!({
        "model": model.unwrap_or(provider.default_model()),
        "messages": messages,
        "tools": json_tools(),
    });
    if let Some(effort) = openai_reasoning_effort_field(effort) {
        payload["reasoning_effort"] = json!(effort);
    }
    let client = http_client()?;
    let mut request = client
        .post(url)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .json(&payload);
    if provider == ProviderId::Openrouter {
        request = request
            .header("HTTP-Referer", "https://comesade.app")
            .header("X-Title", "ComesADE");
    }
    if provider == ProviderId::Github {
        request = request.header("Accept", "application/vnd.github+json");
    }
    let response = request.send().map_err(|error| {
        format!("No se pudo hablar con {}: {error}", provider.display_name())
    })?;
    usage::capture(
        provider,
        &credentials.auth_mode,
        response.status().as_u16(),
        response.headers(),
    );
    if !response.status().is_success() {
        return Err(response_error(
            response,
            &format!("{} rechazo la solicitud", provider.display_name()),
        ));
    }
    response.json().map_err(|error| {
        format!("Respuesta invalida de {}: {error}", provider.display_name())
    })
}

pub fn launch_env(provider: ProviderId, credentials: &StoredProviderCredentials) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(secret) = credentials.bearer() {
        env.insert(provider.env_key_name().into(), secret.to_string());
        if provider == ProviderId::Glm {
            env.insert("GLM_API_KEY".into(), secret.to_string());
        }
        if provider == ProviderId::Kimi {
            env.insert("KIMI_API_KEY".into(), secret.to_string());
        }
        if provider == ProviderId::Github {
            env.insert("GH_TOKEN".into(), secret.to_string());
        }
    }
    env
}
