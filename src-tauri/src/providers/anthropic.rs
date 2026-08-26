use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use crate::providers::{
    http::{
        anthropic_thinking, anthropic_tools, generate_pkce, http_client, jwt_account_label,
        now_secs, random_state, response_error,
    },
    loopback,
    types::{ProviderId, StoredProviderCredentials},
    usage,
};

const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI: &str = "http://localhost:54545/callback";
const SCOPE: &str = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

#[derive(Debug, Clone)]
pub struct ClaudePkceStart {
    pub authorize_url: String,
    pub verifier: String,
    pub state: String,
    pub code_slot: Arc<Mutex<Option<Result<StoredProviderCredentials, String>>>>,
}

pub fn start_pkce() -> Result<ClaudePkceStart, String> {
    let (verifier, challenge) = generate_pkce();
    let state = random_state();
    let code_slot = Arc::new(Mutex::new(None));
    let listeners = loopback::bind_loopback(54545)?;
    let expected_state = state.clone();
    let slot = Arc::clone(&code_slot);
    let verifier_for_exchange = verifier.clone();
    let state_for_exchange = state.clone();
    loopback::spawn_oauth_listener(
        listeners,
        expected_state,
        parse_callback,
        "<!doctype html><html><body style='font-family:sans-serif;background:#111;color:#eee;padding:40px'><h1>Claude conectado</h1><p>Ya puedes volver a ComesADE. La app detecta la cuenta sola.</p></body></html>",
        move |code| exchange_pkce(&code, &verifier_for_exchange, &state_for_exchange),
        slot,
    );
    let authorize_url = format!(
        "{AUTHORIZE_URL}?code=true&response_type=code&client_id={CLIENT_ID}&redirect_uri={}&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}",
        urlencoding::encode(REDIRECT_URI),
        urlencoding::encode(SCOPE),
    );
    Ok(ClaudePkceStart {
        authorize_url,
        verifier,
        state,
        code_slot,
    })
}

fn parse_callback(request_line: &str, expected_state: &str) -> Result<String, String> {
    let path = request_line.split_whitespace().nth(1).unwrap_or_default();
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or_default();
        let value = urlencoding::decode(parts.next().unwrap_or_default())
            .unwrap_or_default()
            .into_owned();
        match key {
            "code" => code = Some(value.split('#').next().unwrap_or(&value).to_string()),
            "state" => state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(format!("Claude rechazo el acceso: {error}"));
    }
    if let Some(code) = code.filter(|value| !value.is_empty()) {
        if state.as_deref() != Some(expected_state) {
            return Err("El callback de Claude no coincide con el estado OAuth.".into());
        }
        return Ok(code);
    }
    Err("Claude no devolvio un codigo de autorizacion.".into())
}

pub fn exchange_pkce(code: &str, verifier: &str, state: &str) -> Result<StoredProviderCredentials, String> {
    let client = http_client()?;
    let response = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
            "state": state,
        }))
        .send()
        .map_err(|error| format!("No se pudo intercambiar el codigo de Claude: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "Claude rechazo el intercambio OAuth"));
    }
    parse_token_response(response.json().unwrap_or(json!({})))
}

pub fn refresh(credentials: &StoredProviderCredentials) -> Result<StoredProviderCredentials, String> {
    let refresh_token = credentials
        .refresh_token
        .as_deref()
        .ok_or("Claude requiere volver a iniciar sesion.")?;
    let client = http_client()?;
    let response = client
        .post(TOKEN_URL)
        .json(&json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .send()
        .map_err(|error| format!("No se pudo renovar Claude: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "Claude rechazo el refresh"));
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
        .ok_or("Claude no devolvio access_token")?
        .to_string();
    let expires_in = value.get("expires_in").and_then(Value::as_u64).unwrap_or(28800);
    Ok(StoredProviderCredentials {
        auth_mode: "oauth".into(),
        access_token: Some(access_token.clone()),
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        api_key: None,
        access_token_expires_at: Some(now_secs().saturating_add(expires_in)),
        account_label: jwt_account_label(&access_token).or(Some("Claude".into())),
        plan: Some("Claude".into()),
        extra: None,
    })
}

pub fn chat(
    credentials: &StoredProviderCredentials,
    anthropic_messages: &[Value],
    system: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Value, String> {
    let (max_tokens, thinking) = anthropic_thinking(effort);
    let mut payload = json!({
        "model": model.unwrap_or("claude-sonnet-4-5"),
        "max_tokens": max_tokens,
        "system": system.unwrap_or("Eres el agente de ComesADE. Usa las herramientas reales del workspace."),
        "messages": anthropic_messages,
        "tools": anthropic_tools(),
    });
    if let Some(thinking) = thinking {
        payload["thinking"] = thinking;
    }
    let client = http_client()?;
    let mut request = client
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14")
        .json(&payload);
    if let Some(key) = credentials.api_key.as_ref().filter(|value| !value.is_empty()) {
        request = request.header("x-api-key", key);
    } else if let Some(token) = credentials.access_token.as_ref() {
        request = request.bearer_auth(token);
    } else {
        return Err("No hay credencial de Claude.".into());
    }
    let response = request
        .send()
        .map_err(|error| format!("No se pudo hablar con Claude: {error}"))?;
    usage::capture(
        ProviderId::Anthropic,
        &credentials.auth_mode,
        response.status().as_u16(),
        response.headers(),
    );
    if !response.status().is_success() {
        return Err(response_error(response, "Claude rechazo la solicitud"));
    }
    response
        .json()
        .map_err(|error| format!("Respuesta invalida de Claude: {error}"))
}

pub fn launch_env(credentials: &StoredProviderCredentials) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(key) = credentials.api_key.as_ref().filter(|value| !value.is_empty()) {
        env.insert("ANTHROPIC_API_KEY".into(), key.clone());
    }
    if let Some(token) = credentials.access_token.as_ref().filter(|value| !value.is_empty()) {
        env.insert("CLAUDE_CODE_OAUTH_TOKEN".into(), token.clone());
    }
    env
}
