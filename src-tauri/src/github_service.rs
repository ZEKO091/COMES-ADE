use std::{
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use keyring::{Entry, Error as KeyringError};
use reqwest::{
    blocking::{Client, Response},
    header::{ACCEPT, CONTENT_TYPE, USER_AGENT},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_API_VERSION: &str = "2022-11-28";
const GITHUB_KEYRING_SERVICE: &str = "com.comesade.desktop";
const GITHUB_KEYRING_ACCOUNT: &str = "github-user-credentials";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubAuthStatus {
    pub connected: bool,
    pub oauth_configured: bool,
    pub login: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub host: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubOAuthPoll {
    pub status: String,
    pub interval: u64,
    pub auth: Option<GithubAuthStatus>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub id: u64,
    pub name: String,
    pub full_name: String,
    pub owner_login: String,
    pub description: Option<String>,
    pub private: bool,
    pub fork: bool,
    pub archived: bool,
    pub visibility: Option<String>,
    pub html_url: String,
    pub clone_url: String,
    pub ssh_url: String,
    pub default_branch: Option<String>,
    pub updated_at: Option<String>,
    pub pushed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGithubCredentials {
    access_token: String,
    refresh_token: Option<String>,
    access_token_expires_at: Option<u64>,
    refresh_token_expires_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GithubDeviceAuthorizationPayload {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default = "default_poll_interval")]
    interval: u64,
}

#[derive(Debug, Deserialize)]
struct GithubTokenPayload {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token_expires_in: Option<u64>,
    interval: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubApiError {
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubUser {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubApiRepository {
    id: u64,
    name: String,
    full_name: String,
    owner: GithubApiOwner,
    description: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    archived: bool,
    visibility: Option<String>,
    html_url: String,
    clone_url: String,
    ssh_url: String,
    default_branch: Option<String>,
    updated_at: Option<String>,
    pushed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubApiOwner {
    login: String,
}

fn default_poll_interval() -> u64 {
    5
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn validate_client_id(client_id: &str) -> Result<String, String> {
    let client_id = client_id.trim();
    if client_id.is_empty() || client_id.chars().any(char::is_control) {
        return Err("ComesADE no tiene configurado un Client ID real de GitHub.".to_string());
    }
    Ok(client_id.to_string())
}

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(GITHUB_KEYRING_SERVICE, GITHUB_KEYRING_ACCOUNT)
        .map_err(|error| format!("No se pudo abrir el almacen seguro del sistema: {error}"))
}

fn load_credentials() -> Result<Option<StoredGithubCredentials>, String> {
    let entry = keyring_entry()?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "No se pudo leer la cuenta de GitHub del almacen seguro: {error}"
            ))
        }
    };
    if value.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|error| format!("La credencial guardada de GitHub no es valida: {error}"))
}

fn save_credentials(credentials: &StoredGithubCredentials) -> Result<(), String> {
    let entry = keyring_entry()?;
    let value = serde_json::to_string(credentials)
        .map_err(|error| format!("No se pudo serializar la cuenta de GitHub: {error}"))?;
    entry
        .set_password(&value)
        .map_err(|error| format!("No se pudo guardar GitHub en el almacen seguro: {error}"))
}

fn delete_credentials() -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "No se pudo quitar la cuenta de GitHub del almacen seguro: {error}"
        )),
    }
}

fn github_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent("ComesADE/Desktop")
        .build()
        .map_err(|error| format!("No se pudo preparar la conexion segura con GitHub: {error}"))
}

fn github_response_error(response: Response, fallback: &str) -> String {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let message = serde_json::from_str::<GithubApiError>(&body)
        .ok()
        .and_then(|payload| payload.message)
        .filter(|value| !value.trim().is_empty());
    match message {
        Some(message) => format!("{fallback} ({status}): {message}"),
        None => format!("{fallback} ({status})"),
    }
}

fn github_api_request(client: &Client, url: &str, access_token: &str) -> Result<Response, String> {
    client
        .get(url)
        .header(ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .header(USER_AGENT, "ComesADE/Desktop")
        .bearer_auth(access_token)
        .send()
        .map_err(|error| format!("No se pudo conectar con GitHub: {error}"))
}

fn github_json<T: DeserializeOwned>(
    client: &Client,
    url: &str,
    access_token: &str,
) -> Result<T, String> {
    let response = github_api_request(client, url, access_token)?;
    if !response.status().is_success() {
        return Err(github_response_error(
            response,
            "GitHub rechazo la solicitud",
        ));
    }
    response
        .json::<T>()
        .map_err(|error| format!("GitHub devolvio una respuesta invalida: {error}"))
}

fn oauth_response(response: Response) -> Result<GithubTokenPayload, String> {
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("No se pudo leer la respuesta OAuth de GitHub: {error}"))?;
    let payload = serde_json::from_str::<GithubTokenPayload>(&body).map_err(|error| {
        format!("GitHub devolvio una respuesta OAuth invalida ({status}): {error}")
    })?;
    if !status.is_success() && payload.error.is_none() {
        return Err(format!("GitHub rechazo la solicitud OAuth ({status})"));
    }
    Ok(payload)
}

fn token_error(payload: &GithubTokenPayload) -> Option<String> {
    payload.error.as_ref().map(|error| {
        payload
            .error_description
            .as_deref()
            .map(|description| format!("{error}: {description}"))
            .unwrap_or_else(|| error.clone())
    })
}

fn credentials_from_token_payload(
    payload: GithubTokenPayload,
    existing_refresh_token: Option<String>,
) -> Result<StoredGithubCredentials, String> {
    if let Some(error) = token_error(&payload) {
        return Err(error);
    }
    let access_token = payload
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "GitHub no devolvio un token de acceso.".to_string())?;
    let now = current_timestamp();
    Ok(StoredGithubCredentials {
        access_token,
        refresh_token: payload.refresh_token.or(existing_refresh_token),
        access_token_expires_at: payload
            .expires_in
            .map(|seconds| now.saturating_add(seconds)),
        refresh_token_expires_at: payload
            .refresh_token_expires_in
            .map(|seconds| now.saturating_add(seconds)),
    })
}

fn refresh_credentials(
    client: &Client,
    client_id: &str,
    credentials: StoredGithubCredentials,
) -> Result<StoredGithubCredentials, String> {
    let refresh_token = credentials
        .refresh_token
        .clone()
        .ok_or_else(|| "La sesion de GitHub expiro; vuelve a conectar la cuenta.".to_string())?;
    if credentials
        .refresh_token_expires_at
        .is_some_and(|expires_at| expires_at <= current_timestamp())
    {
        return Err(
            "La sesion renovable de GitHub expiro; vuelve a conectar la cuenta.".to_string(),
        );
    }
    let response = client
        .post(GITHUB_ACCESS_TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(USER_AGENT, "ComesADE/Desktop")
        .form(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .map_err(|error| format!("No se pudo renovar la sesion de GitHub: {error}"))?;
    let payload = oauth_response(response)?;
    credentials_from_token_payload(payload, credentials.refresh_token)
}

fn credentials_for_api(client_id: &str) -> Result<StoredGithubCredentials, String> {
    let client = github_client()?;
    let mut credentials = load_credentials()?.ok_or_else(|| {
        "Conecta una cuenta de GitHub antes de consultar sus repositorios.".to_string()
    })?;
    if credentials
        .access_token_expires_at
        .is_some_and(|expires_at| expires_at <= current_timestamp().saturating_add(60))
    {
        credentials = refresh_credentials(&client, client_id, credentials)?;
        save_credentials(&credentials)?;
    }
    Ok(credentials)
}

fn github_auth_status_for_client(client_id: &str) -> GithubAuthStatus {
    let oauth_configured = validate_client_id(client_id).is_ok();
    if !oauth_configured {
        return GithubAuthStatus {
            connected: false,
            oauth_configured: false,
            login: None,
            display_name: None,
            avatar_url: None,
            host: None,
            error: Some(
                "Configura VITE_GITHUB_CLIENT_ID con el Client ID real de tu GitHub App."
                    .to_string(),
            ),
        };
    }

    let client_id = client_id.trim();
    let mut credentials = match load_credentials() {
        Ok(Some(credentials)) => credentials,
        Ok(None) => {
            return GithubAuthStatus {
                connected: false,
                oauth_configured: true,
                login: None,
                display_name: None,
                avatar_url: None,
                host: None,
                error: Some(
                    "No hay una cuenta de GitHub conectada en este usuario de Windows.".to_string(),
                ),
            };
        }
        Err(error) => {
            return GithubAuthStatus {
                connected: false,
                oauth_configured: true,
                login: None,
                display_name: None,
                avatar_url: None,
                host: None,
                error: Some(error),
            };
        }
    };

    let client = match github_client() {
        Ok(client) => client,
        Err(error) => {
            return GithubAuthStatus {
                connected: false,
                oauth_configured: true,
                login: None,
                display_name: None,
                avatar_url: None,
                host: None,
                error: Some(error),
            };
        }
    };
    if credentials
        .access_token_expires_at
        .is_some_and(|expires_at| expires_at <= current_timestamp().saturating_add(60))
    {
        match refresh_credentials(&client, client_id, credentials) {
            Ok(refreshed) => {
                credentials = refreshed;
                if let Err(error) = save_credentials(&credentials) {
                    return GithubAuthStatus {
                        connected: false,
                        oauth_configured: true,
                        login: None,
                        display_name: None,
                        avatar_url: None,
                        host: None,
                        error: Some(error),
                    };
                }
            }
            Err(error) => {
                let _ = delete_credentials();
                return GithubAuthStatus {
                    connected: false,
                    oauth_configured: true,
                    login: None,
                    display_name: None,
                    avatar_url: None,
                    host: None,
                    error: Some(error),
                };
            }
        }
    }

    match github_json::<GithubUser>(
        &client,
        &format!("{GITHUB_API_BASE}/user"),
        &credentials.access_token,
    ) {
        Ok(user) => GithubAuthStatus {
            connected: true,
            oauth_configured: true,
            login: Some(user.login),
            display_name: user.name,
            avatar_url: user.avatar_url,
            host: Some("github.com".to_string()),
            error: None,
        },
        Err(error) => {
            if error.contains("401") || error.to_ascii_lowercase().contains("bad credentials") {
                let _ = delete_credentials();
            }
            GithubAuthStatus {
                connected: false,
                oauth_configured: true,
                login: None,
                display_name: None,
                avatar_url: None,
                host: None,
                error: Some(if error.contains("401") {
                    "La autorizacion de GitHub fue revocada o expiro; vuelve a conectar la cuenta."
                        .to_string()
                } else {
                    error
                }),
            }
        }
    }
}

#[tauri::command]
pub fn github_auth_status(client_id: String) -> GithubAuthStatus {
    github_auth_status_for_client(&client_id)
}

#[tauri::command]
pub fn github_oauth_start(client_id: String) -> Result<GithubDeviceAuthorization, String> {
    let client_id = validate_client_id(&client_id)?;
    let client = github_client()?;
    let response = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(USER_AGENT, "ComesADE/Desktop")
        .form(&[("client_id", client_id.as_str())])
        .send()
        .map_err(|error| format!("No se pudo iniciar la autorizacion de GitHub: {error}"))?;
    if !response.status().is_success() {
        return Err(github_response_error(
            response,
            "GitHub rechazo el inicio de autorizacion",
        ));
    }
    let payload = response
        .json::<GithubDeviceAuthorizationPayload>()
        .map_err(|error| {
            format!("GitHub devolvio una respuesta de autorizacion invalida: {error}")
        })?;
    Ok(GithubDeviceAuthorization {
        device_code: payload.device_code,
        user_code: payload.user_code,
        verification_uri: payload.verification_uri,
        interval: payload.interval.max(5),
        expires_in: payload.expires_in,
    })
}

#[tauri::command]
pub fn github_oauth_poll(
    client_id: String,
    device_code: String,
    interval: u64,
) -> Result<GithubOAuthPoll, String> {
    let client_id = validate_client_id(&client_id)?;
    let device_code = device_code.trim();
    if device_code.is_empty() || device_code.chars().any(char::is_control) {
        return Err("El codigo temporal de GitHub no es valido.".to_string());
    }
    let interval = interval.max(5);
    let client = github_client()?;
    let response = client
        .post(GITHUB_ACCESS_TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(USER_AGENT, "ComesADE/Desktop")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .map_err(|error| format!("No se pudo comprobar la autorizacion de GitHub: {error}"))?;
    let payload = oauth_response(response)?;
    if payload.access_token.is_some() {
        let credentials = credentials_from_token_payload(payload, None)?;
        save_credentials(&credentials)?;
        let auth = github_auth_status_for_client(&client_id);
        if auth.connected {
            return Ok(GithubOAuthPoll {
                status: "connected".to_string(),
                interval: 0,
                auth: Some(auth),
                error: None,
            });
        }
        return Ok(GithubOAuthPoll {
            status: "error".to_string(),
            interval: 0,
            error: auth.error.clone(),
            auth: Some(auth),
        });
    }

    match payload.error.as_deref() {
        Some("authorization_pending") => Ok(GithubOAuthPoll {
            status: "pending".to_string(),
            interval: payload.interval.unwrap_or(interval).max(5),
            auth: None,
            error: None,
        }),
        Some("slow_down") => Ok(GithubOAuthPoll {
            status: "pending".to_string(),
            interval: payload
                .interval
                .unwrap_or_else(|| interval.saturating_add(5))
                .max(5),
            auth: None,
            error: None,
        }),
        Some("access_denied") => Ok(GithubOAuthPoll {
            status: "error".to_string(),
            interval: 0,
            auth: None,
            error: Some("La autorizacion de GitHub fue cancelada por el usuario.".to_string()),
        }),
        Some("expired_token") | Some("token_expired") | Some("bad_verification_code") => {
            Ok(GithubOAuthPoll {
                status: "error".to_string(),
                interval: 0,
                auth: None,
                error: Some("El codigo de GitHub expiro; inicia la conexion de nuevo.".to_string()),
            })
        }
        Some("device_flow_disabled") => Ok(GithubOAuthPoll {
            status: "error".to_string(),
            interval: 0,
            auth: None,
            error: Some(
                "El Device Flow esta deshabilitado en la configuracion de la GitHub App."
                    .to_string(),
            ),
        }),
        Some(error) => Ok(GithubOAuthPoll {
            status: "error".to_string(),
            interval: 0,
            auth: None,
            error: Some(format!("GitHub no pudo completar la autorizacion: {error}")),
        }),
        None => Ok(GithubOAuthPoll {
            status: "error".to_string(),
            interval: 0,
            auth: None,
            error: Some("GitHub no devolvio un estado de autorizacion reconocible.".to_string()),
        }),
    }
}

#[tauri::command]
pub fn github_disconnect() -> Result<(), String> {
    delete_credentials()
}

#[tauri::command]
pub fn github_repositories(client_id: String) -> Result<Vec<GithubRepository>, String> {
    let credentials = credentials_for_api(&validate_client_id(&client_id)?)?;
    let client = github_client()?;
    let mut repositories = Vec::new();
    for page in 1..=100 {
        let url = format!(
            "{GITHUB_API_BASE}/user/repos?per_page=100&page={page}&affiliation=owner,collaborator,organization_member&sort=updated&direction=desc"
        );
        let page_repositories =
            github_json::<Vec<GithubApiRepository>>(&client, &url, &credentials.access_token)?;
        let page_size = page_repositories.len();
        repositories.extend(
            page_repositories
                .into_iter()
                .map(|repository| GithubRepository {
                    id: repository.id,
                    name: repository.name,
                    full_name: repository.full_name,
                    owner_login: repository.owner.login,
                    description: repository.description,
                    private: repository.private,
                    fork: repository.fork,
                    archived: repository.archived,
                    visibility: repository.visibility,
                    html_url: repository.html_url,
                    clone_url: repository.clone_url,
                    ssh_url: repository.ssh_url,
                    default_branch: repository.default_branch,
                    updated_at: repository.updated_at,
                    pushed_at: repository.pushed_at,
                }),
        );
        if page_size < 100 {
            break;
        }
    }
    Ok(repositories)
}

fn clone_destination(destination: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(destination.trim().trim_matches('"'));
    if target.as_os_str().is_empty() {
        return Err("El destino del clone es obligatorio.".to_string());
    }
    if target.exists() {
        if !target.is_dir() {
            return Err("El destino del clone ya existe y no es una carpeta.".to_string());
        }
        if std::fs::read_dir(&target)
            .map_err(|error| format!("No se pudo leer el destino: {error}"))?
            .next()
            .is_some()
        {
            return Err("El destino del clone debe estar vacio.".to_string());
        }
    } else if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("No se pudo crear el destino: {error}"))?;
    }
    Ok(target)
}

fn validate_repository_name(repository: &str) -> Result<&str, String> {
    let repository = repository.trim();
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty() || name.is_empty() || parts.next().is_some() {
        return Err("El repositorio de GitHub debe tener el formato owner/repository.".to_string());
    }
    if [owner, name].iter().any(|part| {
        part.starts_with('-')
            || part.ends_with('-')
            || part.chars().any(|character| {
                !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_' | '.')
            })
    }) {
        return Err("El identificador del repositorio de GitHub no es valido.".to_string());
    }
    Ok(repository)
}

fn git_clone_with_token(
    repository: &str,
    destination: &Path,
    access_token: &str,
) -> Result<Output, String> {
    let executable = crate::resolve_executable(if cfg!(windows) { "git.exe" } else { "git" })?;
    let encoded = BASE64.encode(format!("x-access-token:{access_token}"));
    let mut command = Command::new(&executable);
    command
        .args(["clone", &format!("https://github.com/{repository}.git")])
        .arg(destination)
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.extraHeader")
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("AUTHORIZATION: basic {encoded}"),
        )
        .env("GIT_TERMINAL_PROMPT", "0");
    if let Some(path) = crate::augmented_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(crate::CREATE_NO_WINDOW);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("No se pudo iniciar Git clone: {error}"))
}

fn command_error(output: &Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        format!("{fallback}: {stderr}")
    } else if !stdout.is_empty() {
        format!("{fallback}: {stdout}")
    } else {
        fallback.to_string()
    }
}

#[tauri::command]
pub fn github_clone_repository(
    client_id: String,
    repository: String,
    destination: String,
) -> Result<String, String> {
    let client_id = validate_client_id(&client_id)?;
    let repository = validate_repository_name(&repository)?;
    let target = clone_destination(&destination)?;
    let credentials = credentials_for_api(&client_id)?;
    let output = git_clone_with_token(repository, &target, &credentials.access_token)?;
    if !output.status.success() {
        return Err(command_error(
            &output,
            "No se pudo clonar el repositorio de GitHub",
        ));
    }
    let resolved = target.canonicalize().map_err(|error| {
        format!("GitHub clono el repositorio pero no se pudo resolver la carpeta: {error}")
    })?;
    if !resolved.join(".git").exists() {
        return Err(
            "GitHub termino el clone, pero la carpeta no parece un repositorio Git valido."
                .to_string(),
        );
    }
    Ok(resolved.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_github_repository_identifiers() {
        assert!(validate_repository_name("owner/repository").is_ok());
        assert!(validate_repository_name("owner/repository-name").is_ok());
        assert!(validate_repository_name("owner/repository/name").is_err());
        assert!(validate_repository_name("owner/repository with spaces").is_err());
    }

    #[test]
    fn stores_expiring_tokens_without_exposing_them_in_public_payloads() {
        let payload = GithubTokenPayload {
            access_token: Some("access".to_string()),
            refresh_token: Some("refresh".to_string()),
            expires_in: Some(3600),
            refresh_token_expires_in: Some(86400),
            interval: None,
            error: None,
            error_description: None,
        };
        let credentials = credentials_from_token_payload(payload, None).expect("token valido");
        assert_eq!(credentials.access_token, "access");
        assert_eq!(credentials.refresh_token.as_deref(), Some("refresh"));
        assert!(credentials.access_token_expires_at.is_some());
        assert!(credentials.refresh_token_expires_at.is_some());
    }
}
