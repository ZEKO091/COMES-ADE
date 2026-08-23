use serde_json::{json, Value};
use std::collections::HashMap;

use crate::providers::{
    http::{http_client, jwt_account_label, json_tools, now_secs, response_error, xai_reasoning_effort},
    types::{ProviderId, StoredProviderCredentials},
    usage,
};

const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

pub fn start_device() -> Result<(String, String, String, u64, u64), String> {
    let client = http_client()?;
    let response = client
        .post(DEVICE_CODE_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("scope", SCOPE),
            ("referrer", "comesade"),
        ])
        .send()
        .map_err(|error| format!("No se pudo iniciar el login de Grok: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "xAI rechazo el device code"));
    }
    let value: Value = response.json().unwrap_or(json!({}));
    Ok((
        value
            .get("device_code")
            .and_then(Value::as_str)
            .ok_or("xAI no envio device_code")?
            .to_string(),
        value
            .get("user_code")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        value
            .get("verification_uri_complete")
            .or_else(|| value.get("verification_uri"))
            .and_then(Value::as_str)
            .unwrap_or("https://accounts.x.ai")
            .to_string(),
        value.get("interval").and_then(Value::as_u64).unwrap_or(5),
        value.get("expires_in").and_then(Value::as_u64).unwrap_or(900),
    ))
}

pub fn poll_device(device_code: &str) -> Result<Option<StoredProviderCredentials>, String> {
    let client = http_client()?;
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", DEVICE_GRANT),
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
        ])
        .send()
        .map_err(|error| format!("No se pudo consultar xAI: {error}"))?;
    let status = response.status();
    let value: Value = response.json().unwrap_or(json!({}));
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return match error {
            "authorization_pending" | "slow_down" => Ok(None),
            other => Err(value
                .get("error_description")
                .and_then(Value::as_str)
                .unwrap_or(other)
                .to_string()),
        };
    }
    if !status.is_success() {
        return Err(format!("xAI device token fallo ({status})"));
    }
    parse_token_response(value).map(Some)
}

pub fn refresh(credentials: &StoredProviderCredentials) -> Result<StoredProviderCredentials, String> {
    let refresh_token = credentials
        .refresh_token
        .as_deref()
        .ok_or("Grok requiere volver a iniciar sesion.")?;
    let client = http_client()?;
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .map_err(|error| format!("No se pudo renovar Grok: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "xAI rechazo el refresh"));
    }
    let mut next = parse_token_response(response.json().unwrap_or(json!({})))?;
    if next.refresh_token.is_none() {
        next.refresh_token = Some(refresh_token.to_string());
    }
    Ok(next)
}

fn parse_token_response(value: Value) -> Result<StoredProviderCredentials, String> {
    let access_token = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("xAI no devolvio access_token")?
        .to_string();
    let expires_in = value.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    Ok(StoredProviderCredentials {
        auth_mode: "oauth".into(),
        access_token: Some(access_token.clone()),
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        api_key: None,
        access_token_expires_at: Some(now_secs().saturating_add(expires_in)),
        account_label: value
            .get("id_token")
            .and_then(Value::as_str)
            .and_then(jwt_account_label)
            .or(Some("Grok".into())),
        plan: Some("SuperGrok / X Premium+".into()),
        extra: None,
    })
}

pub fn chat(
    credentials: &StoredProviderCredentials,
    messages: &[Value],
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Value, String> {
    let token = credentials.bearer().ok_or("No hay credencial de Grok.")?;
    let client = http_client()?;
    let url = if credentials.auth_mode == "oauth" {
        "https://api.x.ai/v1/chat/completions"
    } else {
        "https://api.x.ai/v1/chat/completions"
    };
    let mut payload = json!({
        "model": model.unwrap_or("grok-4.6"),
        "messages": messages,
        "tools": json_tools(),
    });
    if let Some(effort) = xai_reasoning_effort(effort) {
        payload["reasoning_effort"] = json!(effort);
    }
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .map_err(|error| format!("No se pudo hablar con Grok: {error}"))?;
    usage::capture(
        ProviderId::Xai,
        &credentials.auth_mode,
        response.status().as_u16(),
        response.headers(),
    );
    if response.status().as_u16() == 403 && credentials.auth_mode == "oauth" {
        return Err("xAI autentico la cuenta pero esta suscripcion no tiene acceso OAuth a la API. Usa una API key de console.x.ai.".into());
    }
    if !response.status().is_success() {
        return Err(response_error(response, "Grok rechazo la solicitud"));
    }
    response
        .json()
        .map_err(|error| format!("Respuesta invalida de Grok: {error}"))
}

pub fn launch_env(credentials: &StoredProviderCredentials) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(secret) = credentials.bearer() {
        env.insert("XAI_API_KEY".into(), secret.to_string());
    }
    env
}
