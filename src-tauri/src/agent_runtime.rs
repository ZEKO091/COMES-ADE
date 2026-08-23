use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter};

use crate::provider_auth::{ensure_fresh, AgentChatRequest, AgentUiMessage};
use crate::providers::{anthropic, cli_agent, cursor, gemini, openai, openai_compat, types::ProviderId, xai};
use crate::{git_service, workspace_fs};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDelta {
    request_id: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentToolEvent {
    request_id: String,
    name: String,
    input: String,
    output: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDone {
    request_id: String,
    error: Option<String>,
}

static CANCELLED: Mutex<Option<(String, AtomicBool)>> = Mutex::new(None);

fn is_cancelled(request_id: &str) -> bool {
    CANCELLED
        .lock()
        .ok()
        .and_then(|guard| {
            guard.as_ref().and_then(|(id, flag)| {
                if id == request_id {
                    Some(flag.load(Ordering::Relaxed))
                } else {
                    None
                }
            })
        })
        .unwrap_or(false)
}

fn mark_running(request_id: &str) {
    if let Ok(mut guard) = CANCELLED.lock() {
        *guard = Some((request_id.to_string(), AtomicBool::new(false)));
    }
}

fn split_data_url(value: &str) -> Option<(&str, &str)> {
    let (header, data) = value.split_once(',')?;
    let media = header
        .strip_prefix("data:")?
        .split(';')
        .next()
        .filter(|item| !item.is_empty())?;
    Some((media, data))
}

fn openai_content(message: &AgentUiMessage) -> Value {
    if message.images.is_empty() {
        return json!(message.content);
    }
    let mut parts = vec![json!({ "type": "text", "text": message.content })];
    for image in &message.images {
        parts.push(json!({
            "type": "image_url",
            "image_url": { "url": image }
        }));
    }
    json!(parts)
}

fn anthropic_content(message: &AgentUiMessage) -> Value {
    if message.images.is_empty() {
        return json!(message.content);
    }
    let mut parts = Vec::new();
    for image in &message.images {
        if let Some((media, data)) = split_data_url(image) {
            parts.push(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media, "data": data }
            }));
        }
    }
    parts.push(json!({ "type": "text", "text": message.content }));
    json!(parts)
}

fn gemini_parts(message: &AgentUiMessage) -> Vec<Value> {
    let mut parts = vec![json!({ "text": message.content })];
    for image in &message.images {
        if let Some((media, data)) = split_data_url(image) {
            parts.push(json!({
                "inline_data": { "mime_type": media, "data": data }
            }));
        }
    }
    parts
}

fn execute_tool(workspace: &str, name: &str, input: &Value) -> String {
    match name {
        "list_files" => {
            let relative = input
                .get("relative")
                .and_then(Value::as_str)
                .map(str::to_string);
            match workspace_fs::list(workspace.to_string(), relative) {
                Ok(entries) => serde_json::to_string_pretty(&entries).unwrap_or_default(),
                Err(error) => error,
            }
        }
        "read_file" => {
            let relative = input.get("relative").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::read(workspace.to_string(), relative.to_string()) {
                Ok(content) => content.chars().take(80_000).collect(),
                Err(error) => error,
            }
        }
        "write_file" => {
            let relative = input.get("relative").and_then(Value::as_str).unwrap_or("");
            let content = input.get("content").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::write(workspace.to_string(), relative.to_string(), content.to_string()) {
                Ok(()) => format!("Escrito {relative}"),
                Err(error) => error,
            }
        }
        "search_code" => {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::search(
                workspace.to_string(),
                query.to_string(),
                Some(false),
                Some(false),
                Some(false),
                None,
            ) {
                Ok(matches) => serde_json::to_string_pretty(&matches.into_iter().take(80).collect::<Vec<_>>())
                    .unwrap_or_default(),
                Err(error) => error,
            }
        }
        "git_status" => match git_service::status(workspace.to_string()) {
            Ok(status) => serde_json::to_string_pretty(&status).unwrap_or_default(),
            Err(error) => error,
        },
        "run_command" => {
            let command = input.get("command").and_then(Value::as_str).unwrap_or("").trim();
            if command.is_empty() {
                return "Comando vacio.".into();
            }
            run_workspace_command(workspace, command)
        }
        other => format!("Herramienta desconocida: {other}"),
    }
}

fn run_workspace_command(workspace: &str, command: &str) -> String {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("powershell.exe");
        process.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        process
    };
    process.current_dir(workspace);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    match process.output() {
        Ok(output) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            if !output.stderr.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&String::from_utf8_lossy(&output.stderr));
            }
            if text.trim().is_empty() {
                text = format!("exit {}", output.status.code().unwrap_or(-1));
            }
            text.chars().take(20_000).collect()
        }
        Err(error) => format!("No se pudo ejecutar el comando: {error}"),
    }
}

fn emit_delta(app: &AppHandle, request_id: &str, text: &str) {
    let _ = app.emit(
        "agent-delta",
        AgentDelta {
            request_id: request_id.to_string(),
            text: text.to_string(),
        },
    );
}

fn emit_tool(app: &AppHandle, request_id: &str, name: &str, input: &Value, output: &str) {
    let _ = app.emit(
        "agent-tool",
        AgentToolEvent {
            request_id: request_id.to_string(),
            name: name.to_string(),
            input: input.to_string(),
            output: output.chars().take(4000).collect(),
        },
    );
}

/// Publica el consumo del plan que el proveedor acaba de reportar, para que la
/// interfaz refresque el medidor sin tener que preguntar.
fn emit_usage(app: &AppHandle, provider: ProviderId) {
    if let Some(snapshot) = crate::providers::usage::snapshot(provider) {
        let _ = app.emit("agent-usage", snapshot);
    }
}

fn emit_done(app: &AppHandle, request_id: &str, error: Option<String>) {
    let _ = app.emit(
        "agent-done",
        AgentDone {
            request_id: request_id.to_string(),
            error,
        },
    );
}

fn openai_style_loop(
    app: &AppHandle,
    request_id: &str,
    workspace: &str,
    credentials: &crate::providers::types::StoredProviderCredentials,
    provider: ProviderId,
    initial_messages: Vec<Value>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let mut messages = initial_messages;
    for _ in 0..8 {
        if is_cancelled(request_id) {
            return Err("Cancelado.".into());
        }
        let response = match provider {
            ProviderId::Openai => openai::chat(credentials, &messages, model.as_deref(), effort.as_deref())?,
            ProviderId::Xai => xai::chat(credentials, &messages, model.as_deref(), effort.as_deref())?,
            other if other.is_openai_compat() => {
                openai_compat::chat(other, credentials, &messages, model.as_deref(), effort.as_deref())?
            }
            _ => unreachable!(),
        };
        emit_usage(app, provider);
        let choice = response
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .cloned()
            .or_else(|| response.get("output").cloned())
            .ok_or("El proveedor no devolvio choices.")?;
        let message = choice.get("message").cloned().unwrap_or(choice);
        if let Some(text) = message.get("content").and_then(Value::as_str) {
            if !text.trim().is_empty() {
                emit_delta(app, request_id, text);
            }
        }
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if tool_calls.is_empty() {
            return Ok(());
        }
        messages.push(message);
        for call in tool_calls {
            let id = call.get("id").and_then(Value::as_str).unwrap_or("tool");
            let function = call.get("function").cloned().unwrap_or(json!({}));
            let name = function.get("name").and_then(Value::as_str).unwrap_or("");
            let args_raw = function.get("arguments").and_then(Value::as_str).unwrap_or("{}");
            let args: Value = serde_json::from_str(args_raw).unwrap_or(json!({}));
            let output = execute_tool(workspace, name, &args);
            emit_tool(app, request_id, name, &args, &output);
            messages.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": output,
            }));
        }
    }
    Ok(())
}

fn anthropic_loop(
    app: &AppHandle,
    request_id: &str,
    workspace: &str,
    credentials: &crate::providers::types::StoredProviderCredentials,
    initial: Vec<Value>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let mut messages = initial;
    for _ in 0..8 {
        if is_cancelled(request_id) {
            return Err("Cancelado.".into());
        }
        let response = anthropic::chat(credentials, &messages, None, model.as_deref(), effort.as_deref())?;
        let content = response
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut tool_uses = Vec::new();
        for block in &content {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    emit_delta(app, request_id, text);
                }
            }
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                tool_uses.push(block.clone());
            }
        }
        if tool_uses.is_empty() {
            return Ok(());
        }
        messages.push(json!({ "role": "assistant", "content": content }));
        let mut tool_results = Vec::new();
        for tool in tool_uses {
            let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
            let id = tool.get("id").and_then(Value::as_str).unwrap_or("tool");
            let input = tool.get("input").cloned().unwrap_or(json!({}));
            let output = execute_tool(workspace, name, &input);
            emit_tool(app, request_id, name, &input, &output);
            tool_results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": output,
            }));
        }
        messages.push(json!({ "role": "user", "content": tool_results }));
    }
    Ok(())
}

fn gemini_loop(
    app: &AppHandle,
    request_id: &str,
    workspace: &str,
    credentials: &crate::providers::types::StoredProviderCredentials,
    initial: Vec<Value>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    let mut contents = initial;
    for _ in 0..8 {
        if is_cancelled(request_id) {
            return Err("Cancelado.".into());
        }
        let response = gemini::chat(credentials, &contents, model.as_deref(), effort.as_deref())?;
        let candidate = response
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .cloned()
            .ok_or("Gemini no devolvio candidatos.")?;
        let parts = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut function_calls = Vec::new();
        for part in &parts {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                emit_delta(app, request_id, text);
            }
            if let Some(call) = part.get("functionCall") {
                function_calls.push(call.clone());
            }
        }
        if function_calls.is_empty() {
            return Ok(());
        }
        contents.push(json!({ "role": "model", "parts": parts }));
        let mut response_parts = Vec::new();
        for call in function_calls {
            let name = call.get("name").and_then(Value::as_str).unwrap_or("");
            let args = call.get("args").cloned().unwrap_or(json!({}));
            let output = execute_tool(workspace, name, &args);
            emit_tool(app, request_id, name, &args, &output);
            response_parts.push(json!({
                "functionResponse": {
                    "name": name,
                    "response": { "result": output }
                }
            }));
        }
        contents.push(json!({ "role": "user", "parts": response_parts }));
    }
    Ok(())
}

fn run_agent(app: AppHandle, request: AgentChatRequest) {
    let request_id = request
        .request_id
        .clone()
        .unwrap_or_else(|| format!("agent-{}", crate::providers::http::now_secs()));
    mark_running(&request_id);
    let workspace = request.workspace_path.trim().to_string();
    let provider = match ProviderId::parse(&request.provider) {
        Ok(provider) => provider,
        Err(error) => {
            emit_done(&app, &request_id, Some(error));
            return;
        }
    };
    let credentials = match ensure_fresh(provider) {
        Ok(credentials) => credentials,
        Err(error) => {
            emit_done(&app, &request_id, Some(error));
            return;
        }
    };
    let system = "Eres el agente nativo de ComesADE. Corres en el dispositivo del usuario, sobre un workspace local real. ComesADE no ejecuta el agente en un servidor: las herramientas de archivos, Git y terminal se resuelven en este PC. El modelo es la cuenta que el usuario conectó. No inventes archivos.";
    let result = (|| {
        match provider {
            ProviderId::Cursor => {
                let prompt = request
                    .messages
                    .last()
                    .map(|message| message.content.clone())
                    .unwrap_or_default();
                let text = cursor::chat(&credentials, &prompt, &workspace, request.model.as_deref(), request.effort.as_deref())?;
                emit_delta(&app, &request_id, &text);
                Ok(())
            }
            other if other.is_cli_agent() => {
                let prompt = request
                    .messages
                    .last()
                    .map(|message| message.content.clone())
                    .unwrap_or_default();
                let text = cli_agent::chat(other, &credentials, &prompt, &workspace, request.model.as_deref(), request.effort.as_deref())?;
                emit_delta(&app, &request_id, &text);
                Ok(())
            }
            ProviderId::Anthropic => {
                let messages = request
                    .messages
                    .iter()
                    .filter(|message| message.role != "system")
                    .map(|message| {
                        json!({
                            "role": if message.role == "assistant" { "assistant" } else { "user" },
                            "content": anthropic_content(message),
                        })
                    })
                    .collect::<Vec<_>>();
                anthropic_loop(&app, &request_id, &workspace, &credentials, messages, request.model.clone(), request.effort.clone())
            }
            ProviderId::Gemini => {
                let contents = request
                    .messages
                    .iter()
                    .filter(|message| message.role != "system")
                    .map(|message| {
                        json!({
                            "role": if message.role == "assistant" { "model" } else { "user" },
                            "parts": gemini_parts(message)
                        })
                    })
                    .collect::<Vec<_>>();
                gemini_loop(&app, &request_id, &workspace, &credentials, contents, request.model.clone(), request.effort.clone())
            }
            ProviderId::Openai | ProviderId::Xai => {
                let mut messages = vec![json!({ "role": "system", "content": system })];
                messages.extend(request.messages.iter().map(|message| {
                    json!({ "role": message.role, "content": openai_content(message) })
                }));
                openai_style_loop(
                    &app,
                    &request_id,
                    &workspace,
                    &credentials,
                    provider,
                    messages,
                    request.model.clone(),
                    request.effort.clone(),
                )
            }
            other if other.is_openai_compat() => {
                let mut messages = vec![json!({ "role": "system", "content": system })];
                messages.extend(request.messages.iter().map(|message| {
                    json!({ "role": message.role, "content": openai_content(message) })
                }));
                openai_style_loop(
                    &app,
                    &request_id,
                    &workspace,
                    &credentials,
                    other,
                    messages,
                    request.model.clone(),
                    request.effort.clone(),
                )
            }
            other => Err(format!("El proveedor {} no tiene runtime nativo todavia.", other.display_name())),
        }
    })();
    emit_usage(&app, provider);
    match result {
        Ok(()) => emit_done(&app, &request_id, None),
        Err(error) => emit_done(&app, &request_id, Some(error)),
    }
}

#[tauri::command]
pub fn agent_chat_start(app: AppHandle, request: AgentChatRequest) -> Result<String, String> {
    let request_id = request
        .request_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("agent-{}", crate::providers::http::now_secs()));
    let mut request = request;
    request.request_id = Some(request_id.clone());
    thread::spawn(move || run_agent(app, request));
    Ok(request_id)
}

#[tauri::command]
pub fn agent_chat_cancel(request_id: String) -> Result<(), String> {
    if let Ok(mut guard) = CANCELLED.lock() {
        if let Some((id, flag)) = guard.as_mut() {
            if id == &request_id {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
pub fn debug_env() -> HashMap<String, String> {
    HashMap::new()
}
