use serde_json::Value;
use std::{
    collections::HashMap,
    io::Write,
    process::{Command, Stdio},
    time::Duration,
};

use crate::providers::types::StoredProviderCredentials;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn cursor_binaries() -> [&'static str; 3] {
    ["cursor-agent", "agent", "cursor"]
}

pub fn resolve_cursor_cli() -> Result<String, String> {
    for name in cursor_binaries() {
        if let Ok(path) = crate::resolve_executable(name) {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    Err("No esta instalado el CLI oficial de Cursor (`cursor-agent` o `agent`). Instala Cursor CLI y vuelve a conectar.".into())
}

fn run_hidden(program: &str, args: &[&str], env: &[(&str, &str)]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("No se pudo ejecutar Cursor CLI: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

pub fn start_login() -> Result<String, String> {
    let binary = resolve_cursor_cli()?;
    std::thread::spawn(move || {
        let _ = run_hidden(&binary, &["login"], &[]);
    });
    Ok("Se abrio el login oficial de Cursor en el navegador. Pulsa Comprobar cuando termines.".into())
}

pub fn poll_status() -> Result<Option<StoredProviderCredentials>, String> {
    let binary = resolve_cursor_cli()?;
    let output = run_hidden(&binary, &["status", "--format", "json"], &[])
        .or_else(|_| run_hidden(&binary, &["status"], &[]))?;
    let disconnected = output.to_ascii_lowercase().contains("not authenticated")
        || output.to_ascii_lowercase().contains("unauthenticated");
    if disconnected {
        return Ok(None);
    }
    let label = serde_json::from_str::<Value>(&output)
        .ok()
        .and_then(|value| {
            value
                .get("email")
                .or_else(|| value.get("account"))
                .or_else(|| value.get("user"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            output
                .lines()
                .find(|line| line.contains('@'))
                .map(|line| line.trim().to_string())
        });
    if output.trim().is_empty() {
        return Ok(None);
    }
    if output.to_ascii_lowercase().contains("logged in")
        || output.to_ascii_lowercase().contains("authenticated")
        || label.as_ref().is_some_and(|value| value.contains('@'))
        || serde_json::from_str::<Value>(&output)
            .ok()
            .and_then(|value| value.get("authenticated").and_then(Value::as_bool))
            .unwrap_or(false)
    {
        return Ok(Some(StoredProviderCredentials {
            auth_mode: "cli_login".into(),
            access_token: None,
            refresh_token: None,
            api_key: None,
            access_token_expires_at: None,
            account_label: label.or(Some("Cursor".into())),
            plan: Some("Cursor".into()),
            extra: Some(serde_json::json!({ "status": output.chars().take(400).collect::<String>() })),
        }));
    }
    Ok(None)
}

pub fn chat(
    credentials: &StoredProviderCredentials,
    prompt: &str,
    workspace: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<String, String> {
    let binary = resolve_cursor_cli()?;
    let mut command = Command::new(&binary);
    command
        .current_dir(workspace)
        .arg("-p")
        .arg("--output-format")
        .arg("text")
        .arg("--force")
        .arg(prompt)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(model) = model {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = effort.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--reasoning-effort").arg(effort);
    }
    if let Some(key) = credentials.api_key.as_ref().filter(|value| !value.is_empty()) {
        command.env("CURSOR_API_KEY", key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("No se pudo ejecutar el agente de Cursor: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() {
            stdout
        } else {
            stderr
        })
    }
}

pub fn launch_env(credentials: &StoredProviderCredentials) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(key) = credentials.api_key.as_ref().filter(|value| !value.is_empty()) {
        env.insert("CURSOR_API_KEY".into(), key.clone());
    }
    env
}

#[allow(dead_code)]
pub fn write_prompt_stdin(program: &str, args: &[&str], prompt: &str) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("No se pudo iniciar Cursor: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Cursor no termino: {error}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[allow(dead_code)]
pub fn login_timeout() -> Duration {
    Duration::from_secs(180)
}
