use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, LazyLock, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

use crate::provider_auth::{ensure_fresh, AgentChatRequest, AgentPermissionMode, AgentUiMessage};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTokenUsage {
    request_id: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPermissionRequest {
    permission_id: String,
    request_id: String,
    tool: String,
    summary: String,
}

#[derive(Debug)]
struct PendingPermission {
    decision: Mutex<Option<bool>>,
    wake: Condvar,
}

#[derive(Debug, Default)]
struct TokenUsageTotals {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: u64,
}

#[derive(Debug, Default)]
struct TokenUsageReading {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

fn usage_number(usage: &Value, names: &[&str]) -> Option<u64> {
    names.iter().find_map(|name| usage.get(*name).and_then(Value::as_u64))
}

/// Normaliza los formatos que devuelven los proveedores nativos:
/// OpenAI/xAI usan prompt_tokens/completion_tokens, Anthropic input_tokens/
/// output_tokens y Gemini promptTokenCount/candidatesTokenCount.
fn response_token_usage(response: &Value) -> Option<TokenUsageReading> {
    let usage = response
        .get("usage")
        .or_else(|| response.get("usageMetadata"))?;
    let reading = TokenUsageReading {
        input_tokens: usage_number(usage, &["prompt_tokens", "input_tokens", "promptTokenCount"]),
        output_tokens: usage_number(usage, &["completion_tokens", "output_tokens", "candidatesTokenCount"]),
        total_tokens: usage_number(usage, &["total_tokens", "totalTokenCount"]),
    };
    if reading.input_tokens.is_none() && reading.output_tokens.is_none() && reading.total_tokens.is_none() {
        return None;
    }
    Some(reading)
}

impl TokenUsageTotals {
    fn add(&mut self, reading: TokenUsageReading) {
        if let Some(value) = reading.input_tokens {
            self.input_tokens = Some(self.input_tokens.unwrap_or_default().saturating_add(value));
        }
        if let Some(value) = reading.output_tokens {
            self.output_tokens = Some(self.output_tokens.unwrap_or_default().saturating_add(value));
        }
        let total = reading.total_tokens.or_else(|| {
            Some(reading.input_tokens.unwrap_or_default().saturating_add(reading.output_tokens.unwrap_or_default()))
        });
        self.total_tokens = self.total_tokens.saturating_add(total.unwrap_or_default());
    }
}

static CANCELLED: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static PENDING_PERMISSIONS: LazyLock<Mutex<HashMap<String, Arc<PendingPermission>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_PERMISSION_ID: AtomicU64 = AtomicU64::new(1);

fn is_cancelled(request_id: &str) -> bool {
    CANCELLED
        .lock()
        .ok()
        .and_then(|guard| guard.get(request_id).cloned())
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
}

fn mark_running(request_id: &str) -> Result<(), String> {
    let mut guard = CANCELLED
        .lock()
        .map_err(|_| "El registro de agentes esta bloqueado.".to_string())?;
    if guard.contains_key(request_id) {
        return Err("Ya hay un agente usando ese identificador de solicitud.".to_string());
    }
    guard.insert(request_id.to_string(), Arc::new(AtomicBool::new(false)));
    Ok(())
}

fn clear_running(request_id: &str) {
    if let Ok(mut guard) = CANCELLED.lock() {
        guard.remove(request_id);
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

fn workspace_info(workspace: &str) -> String {
    let shell = if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "sh".to_string())
    };
    let command_shell = if cfg!(windows) {
        "PowerShell"
    } else {
        "POSIX shell"
    };
    let available_commands = [
        "git", "node", "npm", "pnpm", "yarn", "python", "python3", "cargo", "rustc", "go", "dotnet", "java",
    ]
    .into_iter()
    .filter_map(|name| {
        crate::resolve_executable(name).ok().map(|path| {
            json!({
                "name": name,
                "path": path.to_string_lossy(),
            })
        })
    })
    .collect::<Vec<_>>();
    let git = match git_service::status(workspace.to_string()) {
        Ok(status) => json!(status),
        Err(error) => json!({ "available": false, "error": error }),
    };
    serde_json::to_string_pretty(&json!({
        "workspace": workspace,
        "os": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "shell": shell,
        "commandShell": command_shell,
        "git": git,
        "availableCommands": available_commands,
        "accessScope": "workspace filesystem + local shell + Git",
    }))
    .unwrap_or_else(|_| "No se pudo inspeccionar el entorno local.".to_string())
}

fn start_workspace_process(workspace: &str, command: &str) -> String {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("powershell.exe");
        process.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        process
    };
    process
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(path) = crate::augmented_path() {
        process.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    match process.spawn() {
        Ok(child) => format!(
            "Proceso local iniciado en segundo plano. PID {}. Directorio: {workspace}",
            child.id()
        ),
        Err(error) => format!("No se pudo iniciar el proceso local: {error}"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolPermission {
    Allow,
    Deny,
    Ask,
}

fn tool_is_read_only(name: &str) -> bool {
    matches!(
        name,
        "workspace_info"
            | "list_files"
            | "read_file"
            | "search_code"
            | "git_status"
            | "git_diff"
            | "git_branches"
    )
}

fn tool_changes_workspace(name: &str) -> bool {
    matches!(
        name,
        "write_file"
            | "create_file"
            | "create_directory"
            | "rename_path"
            | "move_path"
            | "delete_path"
    )
}

fn tool_permission(mode: AgentPermissionMode, name: &str) -> ToolPermission {
    if mode == AgentPermissionMode::Full {
        return ToolPermission::Allow;
    }
    if tool_is_read_only(name) {
        return ToolPermission::Allow;
    }
    match mode {
        AgentPermissionMode::ReadOnly => ToolPermission::Deny,
        AgentPermissionMode::Approve if tool_changes_workspace(name) => ToolPermission::Allow,
        AgentPermissionMode::Approve | AgentPermissionMode::Ask => ToolPermission::Ask,
        AgentPermissionMode::Full => ToolPermission::Allow,
    }
}

fn permission_summary(name: &str, input: &Value) -> String {
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").trim();
    match name {
        "write_file" => {
            let relative = text("relative");
            let bytes = input.get("content").and_then(Value::as_str).map(str::len).unwrap_or(0);
            format!("Escribir {relative} ({bytes} bytes)")
        }
        "create_file" => format!("Crear archivo {}", text("relative")),
        "create_directory" => format!("Crear carpeta {}", text("relative")),
        "rename_path" => format!("Renombrar {} a {}", text("relative"), text("new_name")),
        "move_path" => format!("Mover {} a {}", text("relative"), text("destination")),
        "delete_path" => format!("Eliminar {}", text("relative")),
        "run_command" | "start_process" => {
            let command = text("command");
            let shortened = command.chars().take(700).collect::<String>();
            if shortened.len() < command.len() {
                format!("Ejecutar: {shortened}…")
            } else {
                format!("Ejecutar: {shortened}")
            }
        }
        _ => format!("Ejecutar la herramienta {name}"),
    }
}

fn request_permission(app: &AppHandle, request_id: &str, name: &str, input: &Value) -> bool {
    let permission_id = format!(
        "permission-{}",
        NEXT_PERMISSION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let pending = Arc::new(PendingPermission {
        decision: Mutex::new(None),
        wake: Condvar::new(),
    });
    if let Ok(mut guard) = PENDING_PERMISSIONS.lock() {
        guard.insert(permission_id.clone(), pending.clone());
    } else {
        return false;
    }

    let _ = app.emit(
        "agent-permission-request",
        AgentPermissionRequest {
            permission_id: permission_id.clone(),
            request_id: request_id.to_string(),
            tool: name.to_string(),
            summary: permission_summary(name, input),
        },
    );

    let deadline = Instant::now() + Duration::from_secs(300);
    let mut decision = false;
    if let Ok(mut state) = pending.decision.lock() {
        loop {
            if let Some(value) = *state {
                decision = value;
                break;
            }
            if is_cancelled(request_id) {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let wait_for = remaining.min(Duration::from_millis(500));
            match pending.wake.wait_timeout(state, wait_for) {
                Ok((next, _)) => state = next,
                Err(_) => break,
            }
        }
    }
    if let Ok(mut guard) = PENDING_PERMISSIONS.lock() {
        guard.remove(&permission_id);
    }
    decision
}

fn execute_tool(
    app: &AppHandle,
    request_id: &str,
    workspace: &str,
    permission_mode: AgentPermissionMode,
    name: &str,
    input: &Value,
) -> String {
    match tool_permission(permission_mode, name) {
        ToolPermission::Allow => {}
        ToolPermission::Deny => {
            return format!(
                "Error: Permiso denegado por el modo de acceso seleccionado para {name}."
            );
        }
        ToolPermission::Ask if !request_permission(app, request_id, name, input) => {
            return format!("Error: Permiso denegado o solicitud expirada para {name}.");
        }
        ToolPermission::Ask => {}
    }
    match name {
        "workspace_info" => workspace_info(workspace),
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
        "create_file" => {
            let relative = input.get("relative").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::create_file(workspace.to_string(), relative.to_string()) {
                Ok(()) => format!("Archivo creado: {relative}"),
                Err(error) => error,
            }
        }
        "create_directory" => {
            let relative = input.get("relative").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::create_directory(workspace.to_string(), relative.to_string()) {
                Ok(()) => format!("Carpeta creada: {relative}"),
                Err(error) => error,
            }
        }
        "rename_path" => {
            let relative = input.get("relative").and_then(Value::as_str).unwrap_or("");
            let new_name = input.get("new_name").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::rename(workspace.to_string(), relative.to_string(), new_name.to_string()) {
                Ok(()) => format!("Ruta renombrada: {relative} → {new_name}"),
                Err(error) => error,
            }
        }
        "move_path" => {
            let relative = input.get("relative").and_then(Value::as_str).unwrap_or("");
            let destination = input.get("destination").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::move_path(workspace.to_string(), relative.to_string(), destination.to_string()) {
                Ok(()) => format!("Ruta movida: {relative} → {destination}"),
                Err(error) => error,
            }
        }
        "delete_path" => {
            let relative = input.get("relative").and_then(Value::as_str).unwrap_or("");
            match workspace_fs::delete(workspace.to_string(), relative.to_string()) {
                Ok(()) => format!("Ruta eliminada: {relative}"),
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
        "git_diff" => {
            let staged = input.get("staged").and_then(Value::as_bool);
            let paths = input.get("paths").and_then(Value::as_array).map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            });
            match git_service::diff(workspace.to_string(), staged, paths) {
                Ok(diff) if diff.is_empty() => "No hay diff para los archivos solicitados.".to_string(),
                Ok(diff) => diff.chars().take(80_000).collect(),
                Err(error) => error,
            }
        }
        "git_branches" => match git_service::branches(workspace.to_string()) {
            Ok(branches) => serde_json::to_string_pretty(&branches).unwrap_or_default(),
            Err(error) => error,
        },
        "run_command" => {
            let command = input.get("command").and_then(Value::as_str).unwrap_or("").trim();
            if command.is_empty() {
                return "Comando vacio.".into();
            }
            let timeout_seconds = input
                .get("timeout_seconds")
                .or_else(|| input.get("timeoutSeconds"))
                .and_then(Value::as_u64)
                .unwrap_or(120)
                .clamp(1, 300);
            run_workspace_command(workspace, command, timeout_seconds)
        }
        "start_process" => {
            let command = input.get("command").and_then(Value::as_str).unwrap_or("").trim();
            if command.is_empty() {
                return "Comando vacio.".into();
            }
            start_workspace_process(workspace, command)
        }
        other => format!("Herramienta desconocida: {other}"),
    }
}

fn read_command_stream<R: Read>(mut stream: R) -> Vec<u8> {
    const MAX_OUTPUT_BYTES: usize = 256 * 1024;
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                if output.len() < MAX_OUTPUT_BYTES {
                    let remaining = MAX_OUTPUT_BYTES - output.len();
                    output.extend_from_slice(&buffer[..size.min(remaining)]);
                }
            }
        }
    }
    output
}

fn run_workspace_command(workspace: &str, command: &str, timeout_seconds: u64) -> String {
    let mut process = if cfg!(windows) {
        let mut process = Command::new("powershell.exe");
        process.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        process
    } else {
        let mut process = Command::new("sh");
        process.args(["-lc", command]);
        process
    };
    process
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = crate::augmented_path() {
        process.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return format!("No se pudo ejecutar el comando: {error}"),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_thread = thread::spawn(move || stdout.map(read_command_stream).unwrap_or_default());
    let stderr_thread = thread::spawn(move || stderr.map(read_command_stream).unwrap_or_default());

    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break None,
        }
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();
    let mut text = String::from_utf8_lossy(&stdout).into_owned();
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&stderr));
    }
    if timed_out {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("El comando excedio el limite de {timeout_seconds} segundos y fue detenido."));
    } else if text.trim().is_empty() {
        text = format!("exit {}", status.and_then(|value| value.code()).unwrap_or(-1));
    }
    text.chars().take(20_000).collect()
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

fn emit_token_usage(app: &AppHandle, request_id: &str, totals: &TokenUsageTotals) {
    let _ = app.emit(
        "agent-token-usage",
        AgentTokenUsage {
            request_id: request_id.to_string(),
            input_tokens: totals.input_tokens,
            output_tokens: totals.output_tokens,
            total_tokens: totals.total_tokens,
        },
    );
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
    permission_mode: AgentPermissionMode,
) -> Result<(), String> {
    let mut messages = initial_messages;
    let mut token_totals = TokenUsageTotals::default();
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
        if let Some(reading) = response_token_usage(&response) {
            token_totals.add(reading);
            emit_token_usage(app, request_id, &token_totals);
        }
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
            let output = execute_tool(app, request_id, workspace, permission_mode, name, &args);
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
    permission_mode: AgentPermissionMode,
) -> Result<(), String> {
    let mut messages = initial;
    let mut token_totals = TokenUsageTotals::default();
    for _ in 0..8 {
        if is_cancelled(request_id) {
            return Err("Cancelado.".into());
        }
        let response = anthropic::chat(credentials, &messages, None, model.as_deref(), effort.as_deref())?;
        emit_usage(app, ProviderId::Anthropic);
        if let Some(reading) = response_token_usage(&response) {
            token_totals.add(reading);
            emit_token_usage(app, request_id, &token_totals);
        }
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
            let output = execute_tool(app, request_id, workspace, permission_mode, name, &input);
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
    permission_mode: AgentPermissionMode,
) -> Result<(), String> {
    let mut contents = initial;
    let mut token_totals = TokenUsageTotals::default();
    for _ in 0..8 {
        if is_cancelled(request_id) {
            return Err("Cancelado.".into());
        }
        let response = gemini::chat(credentials, &contents, model.as_deref(), effort.as_deref())?;
        emit_usage(app, ProviderId::Gemini);
        if let Some(reading) = response_token_usage(&response) {
            token_totals.add(reading);
            emit_token_usage(app, request_id, &token_totals);
        }
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
            let output = execute_tool(app, request_id, workspace, permission_mode, name, &args);
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
    let workspace = request.workspace_path.trim().to_string();
    if is_cancelled(&request_id) {
        emit_done(&app, &request_id, Some("Cancelado.".into()));
        clear_running(&request_id);
        return;
    }
    let provider = match ProviderId::parse(&request.provider) {
        Ok(provider) => provider,
        Err(error) => {
            emit_done(&app, &request_id, Some(error));
            clear_running(&request_id);
            return;
        }
    };
    if provider.is_cli_agent() && request.permission_mode != AgentPermissionMode::Full {
        emit_done(
            &app,
            &request_id,
            Some(format!(
                "{} se ejecuta mediante un CLI externo que no expone a ComesADE un limite de herramientas controlable. Para usar este agente elige Acceso total; los modos restringidos solo se aplican a los agentes nativos de ComesADE.",
                provider.display_name()
            )),
        );
        clear_running(&request_id);
        return;
    }
    let credentials = match ensure_fresh(provider) {
        Ok(credentials) => credentials,
        Err(error) => {
            emit_done(&app, &request_id, Some(error));
            clear_running(&request_id);
            return;
        }
    };
    let system = "Eres el agente nativo de ComesADE. Corres en el dispositivo del usuario, sobre un workspace local real. ComesADE no ejecuta el agente en un servidor: las herramientas de archivos, Git, shell y procesos se resuelven en este PC. Tienes herramientas reales para inspeccionar el workspace, leer/escribir/crear/mover/renombrar/eliminar rutas dentro de él, consultar Git, ejecutar comandos PowerShell o shell y arrancar procesos locales en segundo plano. Usa workspace_info al principio si necesitas conocer el sistema y los runtimes instalados. Respeta el alcance del workspace; solo usa rutas fuera de él o acciones destructivas cuando la petición del usuario lo pida de forma clara. El modelo es la cuenta que el usuario conectó. No inventes archivos, resultados ni comandos ejecutados.";
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
                anthropic_loop(
                    &app,
                    &request_id,
                    &workspace,
                    &credentials,
                    messages,
                    request.model.clone(),
                    request.effort.clone(),
                    request.permission_mode,
                )
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
                gemini_loop(
                    &app,
                    &request_id,
                    &workspace,
                    &credentials,
                    contents,
                    request.model.clone(),
                    request.effort.clone(),
                    request.permission_mode,
                )
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
                    request.permission_mode,
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
                    request.permission_mode,
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
    clear_running(&request_id);
}

#[tauri::command]
pub fn agent_chat_start(app: AppHandle, request: AgentChatRequest) -> Result<String, String> {
    let request_id = request
        .request_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            format!(
                "agent-{}-{}",
                crate::providers::http::now_secs(),
                NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
            )
        });
    mark_running(&request_id)?;
    let mut request = request;
    request.request_id = Some(request_id.clone());
    thread::spawn(move || run_agent(app, request));
    Ok(request_id)
}

#[tauri::command]
pub fn agent_chat_cancel(request_id: String) -> Result<(), String> {
    if let Ok(guard) = CANCELLED.lock() {
        if let Some(flag) = guard.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn agent_permission_decide(permission_id: String, allowed: bool) -> Result<(), String> {
    let pending = PENDING_PERMISSIONS
        .lock()
        .map_err(|_| "El registro de permisos esta bloqueado.".to_string())?
        .get(&permission_id)
        .cloned()
        .ok_or_else(|| "La solicitud de permiso ya no esta activa.".to_string())?;
    let mut decision = pending
        .decision
        .lock()
        .map_err(|_| "La solicitud de permiso esta bloqueada.".to_string())?;
    *decision = Some(allowed);
    pending.wake.notify_all();
    Ok(())
}

#[allow(dead_code)]
pub fn debug_env() -> HashMap<String, String> {
    HashMap::new()
}
