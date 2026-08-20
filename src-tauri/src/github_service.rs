use std::{
    collections::HashMap,
    process::{Command, Output, Stdio},
};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAuthStatus {
    pub connected: bool,
    pub cli_available: bool,
    pub login: Option<String>,
    pub host: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubAuthPayload {
    hosts: HashMap<String, Vec<GithubHostAccount>>,
}

#[derive(Debug, Deserialize)]
struct GithubHostAccount {
    active: bool,
    host: String,
    login: String,
    state: String,
}

fn github_cli() -> Result<std::path::PathBuf, String> {
    crate::resolve_executable(if cfg!(windows) { "gh.exe" } else { "gh" })
        .map_err(|_| "GitHub CLI no esta instalado o no esta disponible en PATH.".to_string())
}

fn run_status_command(executable: &std::path::Path) -> Result<Output, String> {
    let mut command = Command::new(executable);
    command.args([
        "auth",
        "status",
        "--hostname",
        "github.com",
        "--json",
        "hosts",
    ]);
    if let Some(path) = crate::augmented_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(crate::CREATE_NO_WINDOW);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("No se pudo consultar GitHub CLI: {error}"))
}

fn status_from_output(output: &Output) -> GithubAuthStatus {
    let parsed = serde_json::from_slice::<GithubAuthPayload>(&output.stdout).ok();
    let account = parsed.as_ref().and_then(|payload| {
        payload
            .hosts
            .values()
            .flat_map(|accounts| accounts.iter())
            .find(|account| {
                account.active
                    && account.state.eq_ignore_ascii_case("success")
                    && account.host.eq_ignore_ascii_case("github.com")
            })
    });

    if let Some(account) = account {
        return GithubAuthStatus {
            connected: true,
            cli_available: true,
            login: Some(account.login.clone()),
            host: Some(account.host.clone()),
            error: None,
        };
    }

    GithubAuthStatus {
        connected: false,
        cli_available: true,
        login: None,
        host: None,
        error: if output.status.success() {
            Some("No hay una cuenta de GitHub activa.".to_string())
        } else {
            Some("Conecta una cuenta de GitHub para continuar.".to_string())
        },
    }
}

#[tauri::command]
pub fn github_auth_status() -> GithubAuthStatus {
    let executable = match github_cli() {
        Ok(executable) => executable,
        Err(error) => {
            return GithubAuthStatus {
                connected: false,
                cli_available: false,
                login: None,
                host: None,
                error: Some(error),
            };
        }
    };

    match run_status_command(&executable) {
        Ok(output) => status_from_output(&output),
        Err(error) => GithubAuthStatus {
            connected: false,
            cli_available: true,
            login: None,
            host: None,
            error: Some(error),
        },
    }
}

#[tauri::command]
pub fn github_auth_login() -> Result<GithubAuthStatus, String> {
    let executable = github_cli()?;
    let mut command = Command::new(executable);
    command.args([
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
    ]);
    if let Some(path) = crate::augmented_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(crate::CREATE_NO_WINDOW);
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("No se pudo iniciar la conexion con GitHub: {error}"))?;

    if !output.status.success() {
        return Err("La conexion con GitHub fue cancelada o no pudo completarse.".to_string());
    }

    let status = github_auth_status();
    if status.connected {
        Ok(status)
    } else {
        Err(status
            .error
            .unwrap_or_else(|| "GitHub no quedo conectado.".to_string()))
    }
}
