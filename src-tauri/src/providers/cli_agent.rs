use serde_json::Value;
use std::{
    collections::HashMap,
    process::{Command, Stdio},
};

use crate::providers::types::{ProviderId, StoredProviderCredentials};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct CliSpec {
    pub binaries: &'static [&'static str],
    pub login_args: &'static [&'static str],
    pub status_args: &'static [&'static str],
    pub exec_prefix: &'static [&'static str],
    pub missing: &'static str,
}

pub fn spec(provider: ProviderId) -> Option<CliSpec> {
    match provider {
        ProviderId::Droid => Some(CliSpec {
            binaries: &["droid"],
            login_args: &[],
            status_args: &["--version"],
            exec_prefix: &["exec", "--auto", "high"],
            missing: "No esta instalado el CLI `droid` de Factory.",
        }),
        ProviderId::Aider => Some(CliSpec {
            binaries: &["aider"],
            login_args: &[],
            status_args: &["--version"],
            exec_prefix: &["--yes", "--message"],
            missing: "No esta instalado `aider`.",
        }),
        ProviderId::Kilo => Some(CliSpec {
            binaries: &["kilo", "kilo-cli"],
            login_args: &["login"],
            status_args: &["status"],
            exec_prefix: &[],
            missing: "No esta instalado el CLI `kilo`.",
        }),
        ProviderId::Pi => Some(CliSpec {
            binaries: &["pi"],
            login_args: &["login"],
            status_args: &["status"],
            exec_prefix: &["-p"],
            missing: "No esta instalado el CLI `pi`.",
        }),
        ProviderId::Opencode => Some(CliSpec {
            binaries: &["opencode"],
            login_args: &["auth", "login"],
            status_args: &["auth", "list"],
            exec_prefix: &["run"],
            missing: "No esta instalado `opencode`.",
        }),
        ProviderId::Antigravity => Some(CliSpec {
            binaries: &["antigravity", "agy"],
            login_args: &["auth", "login"],
            status_args: &["auth", "status"],
            exec_prefix: &["run"],
            missing: "No esta instalado el CLI Antigravity (`antigravity` o `agy`).",
        }),
        _ => None,
    }
}

pub fn resolve_binary(provider: ProviderId) -> Result<String, String> {
    let spec = spec(provider).ok_or_else(|| format!("{} no es un CLI.", provider.display_name()))?;
    for name in spec.binaries {
        if let Ok(path) = crate::resolve_executable(name) {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    Err(spec.missing.to_string())
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
        .map_err(|error| format!("No se pudo ejecutar {program}: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else if !stdout.is_empty() || !stderr.is_empty() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(format!("{program} termino con error."))
    }
}

pub fn start_login(provider: ProviderId) -> Result<String, String> {
    let spec = spec(provider).ok_or_else(|| "CLI no soportado.".to_string())?;
    if spec.login_args.is_empty() {
        return Ok(format!(
            "Se abre la consola de {}. Pega una API key real o autentica el CLI instalado.",
            provider.display_name()
        ));
    }
    let binary = resolve_binary(provider)?;
    let args: Vec<String> = spec.login_args.iter().map(|value| (*value).to_string()).collect();
    std::thread::spawn(move || {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        let _ = run_hidden(&binary, &argv, &[]);
    });
    Ok(format!(
        "Se lanzo el login oficial de {}. Completalo en el navegador o en la terminal.",
        provider.display_name()
    ))
}

pub fn poll_status(provider: ProviderId) -> Result<Option<StoredProviderCredentials>, String> {
    let spec = spec(provider).ok_or_else(|| "CLI no soportado.".to_string())?;
    let binary = resolve_binary(provider)?;
    if spec.status_args.is_empty() {
        return Ok(None);
    }
    let output = run_hidden(&binary, spec.status_args, &[])?;
    let lower = output.to_ascii_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("unauthenticated")
        || lower.contains("not logged")
        || lower.contains("no auth")
    {
        return Ok(None);
    }
    if spec.login_args.is_empty() {
        return Ok(None);
    }
    let label = output
        .lines()
        .find(|line| line.contains('@'))
        .map(|line| line.trim().to_string())
        .or_else(|| {
            serde_json::from_str::<Value>(&output).ok().and_then(|value| {
                value
                    .get("email")
                    .or_else(|| value.get("account"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        });
    if lower.contains("logged in")
        || lower.contains("authenticated")
        || lower.contains("active")
        || label.as_ref().is_some_and(|value| value.contains('@'))
        || !output.trim().is_empty()
    {
        return Ok(Some(StoredProviderCredentials {
            auth_mode: "cli_login".into(),
            access_token: None,
            refresh_token: None,
            api_key: None,
            access_token_expires_at: None,
            account_label: label.or(Some(provider.display_name().into())),
            plan: Some(provider.display_name().into()),
            extra: Some(serde_json::json!({ "status": output.chars().take(400).collect::<String>() })),
        }));
    }
    Ok(None)
}

pub fn chat(
    provider: ProviderId,
    credentials: &StoredProviderCredentials,
    prompt: &str,
    workspace: &str,
    model: Option<&str>,
    _effort: Option<&str>,
) -> Result<String, String> {
    let spec = spec(provider).ok_or_else(|| "CLI no soportado.".to_string())?;
    let binary = resolve_binary(provider)?;
    let mut command = Command::new(&binary);
    command.current_dir(workspace).stdout(Stdio::piped()).stderr(Stdio::piped());
    if provider == ProviderId::Aider {
        if let Some(model) = model {
            command.arg("--model").arg(model);
        }
    }
    for arg in spec.exec_prefix {
        command.arg(arg);
    }
    if provider != ProviderId::Aider {
        if let Some(model) = model {
            command.arg("--model").arg(model);
        }
    }
    command.arg(prompt);
    if let Some(secret) = credentials.bearer() {
        command.env(provider.env_key_name(), secret);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| format!("No se pudo ejecutar {}: {error}", provider.display_name()))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if output.status.success() || !stdout.is_empty() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

pub fn launch_env(provider: ProviderId, credentials: &StoredProviderCredentials) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(secret) = credentials.bearer() {
        env.insert(provider.env_key_name().into(), secret.to_string());
    }
    env
}
