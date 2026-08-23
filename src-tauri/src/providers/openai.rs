use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use crate::providers::{
    http::{
        generate_pkce, http_client, json_tools, jwt_account_label, jwt_claims, now_secs,
        openai_reasoning, openai_reasoning_effort_field, random_state, response_error,
    },
    loopback,
    types::{ProviderId, StoredProviderCredentials},
    usage,
};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const DEVICE_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const SCOPE: &str = "openid profile email offline_access";

#[derive(Debug, Clone)]
pub struct OpenaiPkceStart {
    pub authorize_url: String,
    pub verifier: String,
    pub _state: String,
    pub code_slot: Arc<Mutex<Option<Result<StoredProviderCredentials, String>>>>,
}

pub fn start_pkce() -> Result<OpenaiPkceStart, String> {
    let (verifier, challenge) = generate_pkce();
    let state = random_state();
    let code_slot = Arc::new(Mutex::new(None));
    let listeners = loopback::bind_loopback(1455)?;
    let expected_state = state.clone();
    let slot = Arc::clone(&code_slot);
    let verifier_for_exchange = verifier.clone();
    loopback::spawn_oauth_listener(
        listeners,
        expected_state,
        parse_callback,
        "<!doctype html><html><body style='font-family:sans-serif;background:#111;color:#eee;padding:40px'><h1>ChatGPT conectado</h1><p>Ya puedes volver a ComesADE. La app detecta la cuenta sola.</p></body></html>",
        move |code| exchange_pkce(&code, &verifier_for_exchange),
        slot,
    );

    let authorize_url = format!(
        "{AUTHORIZE_URL}?response_type=code&client_id={CLIENT_ID}&redirect_uri={}&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs",
        urlencoding::encode(REDIRECT_URI),
        urlencoding::encode(SCOPE),
    );
    Ok(OpenaiPkceStart {
        authorize_url,
        verifier,
        _state: state.clone(),
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
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(format!("ChatGPT rechazo el acceso: {error}"));
    }
    if state.as_deref() != Some(expected_state) {
        return Err("El callback de ChatGPT no coincide con el estado OAuth.".into());
    }
    code.filter(|value| !value.is_empty())
        .ok_or_else(|| "ChatGPT no devolvio un codigo de autorizacion.".into())
}

pub fn exchange_pkce(code: &str, verifier: &str) -> Result<StoredProviderCredentials, String> {
    let client = http_client()?;
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .map_err(|error| format!("No se pudo intercambiar el codigo de ChatGPT: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "ChatGPT rechazo el intercambio OAuth"));
    }
    parse_token_response(response.json().unwrap_or(json!({})))
}

pub fn start_device() -> Result<(String, String, String, u64, u64), String> {
    let client = http_client()?;
    let response = client
        .post(DEVICE_CODE_URL)
        .form(&[("client_id", CLIENT_ID)])
        .send()
        .map_err(|error| format!("No se pudo iniciar el device code de ChatGPT: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "ChatGPT rechazo el device code"));
    }
    let value: Value = response.json().unwrap_or(json!({}));
    let device_code = value
        .get("device_code")
        .and_then(Value::as_str)
        .ok_or("ChatGPT no envio device_code")?
        .to_string();
    let user_code = value
        .get("user_code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let verification_uri = value
        .get("verification_uri")
        .or_else(|| value.get("verification_uri_complete"))
        .and_then(Value::as_str)
        .unwrap_or("https://auth.openai.com/codex/device")
        .to_string();
    let interval = value.get("interval").and_then(Value::as_u64).unwrap_or(5);
    let expires_in = value.get("expires_in").and_then(Value::as_u64).unwrap_or(900);
    Ok((device_code, user_code, verification_uri, interval, expires_in))
}

pub fn poll_device(device_code: &str) -> Result<Option<StoredProviderCredentials>, String> {
    let client = http_client()?;
    let response = client
        .post(DEVICE_TOKEN_URL)
        .form(&[
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .map_err(|error| format!("No se pudo consultar ChatGPT: {error}"))?;
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
        return Err(format!("ChatGPT device token fallo ({status})"));
    }
    parse_token_response(value).map(Some)
}

pub fn refresh(credentials: &StoredProviderCredentials) -> Result<StoredProviderCredentials, String> {
    let refresh_token = credentials
        .refresh_token
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or("ChatGPT requiere volver a iniciar sesion.")?;
    let client = http_client()?;
    let response = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .map_err(|error| format!("No se pudo renovar ChatGPT: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response, "ChatGPT rechazo el refresh"));
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
        .or_else(|| value.get("id_token").and_then(Value::as_str))
        .ok_or_else(|| {
            let keys = value
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            format!("ChatGPT no devolvio access_token{}.", if keys.is_empty() { String::new() } else { format!(" (campos: {keys})") })
        })?
        .to_string();
    let expires_in = value.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
    let id_token = value.get("id_token").and_then(Value::as_str);
    // El backend de ChatGPT exige la cuenta a la que pertenece la suscripcion.
    let account_id = id_token.and_then(chatgpt_account_id);
    Ok(StoredProviderCredentials {
        auth_mode: "oauth".into(),
        access_token: Some(access_token.clone()),
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        api_key: None,
        access_token_expires_at: Some(now_secs().saturating_add(expires_in)),
        account_label: id_token.and_then(jwt_account_label),
        plan: Some("ChatGPT".into()),
        extra: account_id.map(|id| json!({ "chatgpt_account_id": id })),
    })
}

fn chatgpt_account_id(id_token: &str) -> Option<String> {
    let claims = jwt_claims(id_token)?;
    claims
        .get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_string)
}

fn stored_account_id(credentials: &StoredProviderCredentials) -> Option<String> {
    credentials
        .extra
        .as_ref()?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_string)
}

/// Las herramientas de la Responses API van planas, no anidadas bajo "function".
fn responses_tools() -> Value {
    let tools = json_tools();
    let list = tools.as_array().cloned().unwrap_or_default();
    Value::Array(
        list.into_iter()
            .filter_map(|tool| {
                let function = tool.get("function")?;
                Some(json!({
                    "type": "function",
                    "name": function.get("name")?,
                    "description": function.get("description").cloned().unwrap_or(Value::Null),
                    "strict": false,
                    "parameters": function.get("parameters").cloned().unwrap_or(json!({
                        "type": "object",
                        "properties": {}
                    })),
                }))
            })
            .collect(),
    )
}

/// Traduce el historial estilo chat/completions al formato de la Responses API,
/// separando el mensaje de sistema, que alli viaja como "instructions".
fn message_text(message: &Value) -> String {
    if let Some(text) = message.get("content").and_then(Value::as_str) {
        return text.to_string();
    }
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn responses_user_parts(message: &Value) -> Vec<Value> {
    match message.get("content") {
        Some(Value::Array(items)) => {
            let mut parts = Vec::new();
            for item in items {
                match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "image_url" => {
                        if let Some(url) = item.pointer("/image_url/url").and_then(Value::as_str) {
                            parts.push(json!({
                                "type": "input_image",
                                "image_url": url,
                                "detail": "high"
                            }));
                        }
                    }
                    _ => {
                        let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.is_empty() {
                            parts.push(json!({ "type": "input_text", "text": text }));
                        }
                    }
                }
            }
            if parts.is_empty() {
                parts.push(json!({ "type": "input_text", "text": "" }));
            }
            parts
        }
        _ => vec![json!({ "type": "input_text", "text": message_text(message) })],
    }
}

fn to_responses_input(messages: &[Value]) -> (Option<String>, Vec<Value>) {
    let mut instructions = None;
    let mut input = Vec::new();
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = message_text(message);
        match role {
            "system" => {
                if instructions.is_none() {
                    instructions = Some(content.to_string());
                }
            }
            "tool" => {
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": message.get("tool_call_id").and_then(Value::as_str).unwrap_or("tool"),
                    "output": content,
                }));
            }
            "assistant" => {
                if !content.is_empty() {
                    input.push(json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": content }],
                    }));
                }
                for call in message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    let function = call.get("function").cloned().unwrap_or(json!({}));
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.get("id").and_then(Value::as_str).unwrap_or("tool"),
                        "name": function.get("name").and_then(Value::as_str).unwrap_or(""),
                        "arguments": function.get("arguments").and_then(Value::as_str).unwrap_or("{}"),
                    }));
                }
            }
            _ => {
                input.push(json!({
                    "type": "message",
                    "role": "user",
                    "content": responses_user_parts(message),
                }));
            }
        }
    }
    (instructions, input)
}

/// El backend de suscripcion responde en SSE. Se reconstruye una respuesta con
/// forma de chat/completions para no cambiar el bucle de herramientas.
fn parse_responses_stream(body: &str) -> Result<Value, String> {
    let mut text = String::new();
    let mut tool_calls = Vec::new();
    let mut failure = None;
    for line in body.lines() {
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str).unwrap_or_default() {
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    text.push_str(delta);
                }
            }
            "response.output_item.done" => {
                let Some(item) = event.get("item") else { continue };
                match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "function_call" => tool_calls.push(json!({
                        "id": item.get("call_id").and_then(Value::as_str).unwrap_or("tool"),
                        "type": "function",
                        "function": {
                            "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
                            "arguments": item.get("arguments").and_then(Value::as_str).unwrap_or("{}"),
                        }
                    })),
                    "message" if text.is_empty() => {
                        if let Some(parts) = item.get("content").and_then(Value::as_array) {
                            for part in parts {
                                if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                                    text.push_str(chunk);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            "response.failed" | "error" => {
                failure = event
                    .pointer("/response/error/message")
                    .or_else(|| event.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(failure);
            }
            _ => {}
        }
    }
    if text.is_empty() && tool_calls.is_empty() {
        return Err(failure.unwrap_or_else(|| {
            "ChatGPT no devolvio contenido. Vuelve a conectar la cuenta si el problema sigue.".into()
        }));
    }
    let mut message = json!({ "role": "assistant", "content": text });
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    Ok(json!({ "choices": [{ "message": message }] }))
}

/// Modelos que Codex acepta con sesion de ChatGPT (no IDs de la API de pago).
const CHATGPT_CODEX_MODELS: &[&str] = &[
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.6",
];

fn subscription_model(requested: Option<&str>) -> Vec<String> {
    let mut models = Vec::new();
    if let Some(model) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        models.push(model.to_string());
    }
    for candidate in CHATGPT_CODEX_MODELS {
        if !models.iter().any(|item| item == candidate) {
            models.push((*candidate).to_string());
        }
    }
    if models.is_empty() {
        models.push(CHATGPT_CODEX_MODELS[0].to_string());
    }
    models
}

fn model_unsupported(status: u16, body: &str) -> bool {
    status == 400
        && (body.contains("not supported") || body.contains("model_not_found") || body.contains("invalid_model"))
}

/// Chat con la suscripcion de ChatGPT del usuario. No hay reserva contra la API
/// de pago: si la suscripcion falla, se avisa en vez de gastar por otra via.
fn chat_with_subscription(
    credentials: &StoredProviderCredentials,
    messages: &[Value],
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Value, String> {
    let token = credentials
        .access_token
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or("No hay sesion de ChatGPT. Vuelve a conectar la cuenta.")?;
    let (instructions, input) = to_responses_input(messages);
    let mut last_error = "Tu plan de ChatGPT rechazo la solicitud.".to_string();
    for model_id in subscription_model(model) {
        let mut payload = json!({
            "model": model_id,
            "instructions": instructions.clone().unwrap_or_else(|| {
                "Eres el agente de ComesADE. Usa las herramientas reales del workspace.".into()
            }),
            "input": input.clone(),
            "tools": responses_tools(),
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "store": false,
            "stream": true,
        });
        if let Some(reasoning) = openai_reasoning(effort) {
            payload["reasoning"] = reasoning;
        }
        let mut request = http_client()?
            .post("https://chatgpt.com/backend-api/codex/responses")
            .bearer_auth(token)
            .header("OpenAI-Beta", "responses=experimental")
            .header("originator", "codex_cli_rs")
            .header("session_id", random_state())
            .header("Accept", "text/event-stream")
            .json(&payload);
        if let Some(account) = stored_account_id(credentials) {
            request = request.header("chatgpt-account-id", account);
        }
        let response = request
            .send()
            .map_err(|error| format!("No se pudo hablar con ChatGPT: {error}"))?;
        let status = response.status();
        usage::capture(
            ProviderId::Openai,
            &credentials.auth_mode,
            status.as_u16(),
            response.headers(),
        );
        if status.is_success() {
            let body = response
                .text()
                .map_err(|error| format!("Respuesta invalida de ChatGPT: {error}"))?;
            return parse_responses_stream(&body);
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!(
                "{} Vuelve a conectar ChatGPT para renovar la sesion de tu suscripcion.",
                response_error(response, "ChatGPT rechazo la sesion")
            ));
        }
        let error = response_error(response, "Tu plan de ChatGPT rechazo la solicitud");
        if model_unsupported(status.as_u16(), &error) {
            last_error = error;
            continue;
        }
        return Err(error);
    }
    Err(last_error)
}

pub fn chat(
    credentials: &StoredProviderCredentials,
    messages: &[Value],
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Value, String> {
    if credentials.auth_mode != "api_key" {
        return chat_with_subscription(credentials, messages, model, effort);
    }
    let token = credentials.bearer().ok_or("No hay credencial de ChatGPT.")?;
    let model_id = model.unwrap_or("gpt-4.1");
    let mut payload = json!({
        "model": model_id,
        "messages": messages,
        "tools": json_tools(),
    });
    if let Some(effort) = openai_reasoning_effort_field(effort) {
        payload["reasoning_effort"] = json!(effort);
    }
    let response = http_client()?
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(token)
        .json(&payload)
        .send()
        .map_err(|error| format!("No se pudo hablar con ChatGPT: {error}"))?;
    usage::capture(
        ProviderId::Openai,
        &credentials.auth_mode,
        response.status().as_u16(),
        response.headers(),
    );
    if !response.status().is_success() {
        return Err(response_error(response, "ChatGPT rechazo la solicitud"));
    }
    let value: Value = response
        .json()
        .map_err(|error| format!("Respuesta invalida de ChatGPT: {error}"))?;
    usage::capture_body(ProviderId::Openai, &credentials.auth_mode, &value);
    Ok(value)
}

pub fn launch_env(credentials: &StoredProviderCredentials) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(key) = credentials.api_key.as_ref().filter(|value| !value.is_empty()) {
        env.insert("OPENAI_API_KEY".into(), key.clone());
    }
    if let Some(token) = credentials.access_token.as_ref().filter(|value| !value.is_empty()) {
        env.insert("OPENAI_API_KEY".into(), token.clone());
    }
    env
}
