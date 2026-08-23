use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use keyring::{Entry, Error as KeyringError};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::providers::{
    anthropic, cursor, gemini, openai,
    types::{
        OAuthPollResult, OAuthStartResult, ProviderId, ProviderStatus, StoredProviderCredentials,
    },
    xai,
};
use crate::providers::http::credential_needs_refresh;

const KEYRING_SERVICE: &str = "com.comesade.desktop";

#[derive(Clone)]
enum PendingOAuth {
    OpenaiPkce {
        start: openai::OpenaiPkceStart,
        started: Instant,
    },
    OpenaiDevice {
        device_code: String,
        started: Instant,
        expires_in: u64,
    },
    XaiDevice {
        device_code: String,
        started: Instant,
        expires_in: u64,
    },
    AnthropicPkce {
        start: anthropic::ClaudePkceStart,
        started: Instant,
    },
    CursorCli {
        started: Instant,
    },
    GenericCli {
        started: Instant,
    },
}

static PENDING: Mutex<Option<(ProviderId, PendingOAuth)>> = Mutex::new(None);

/// Windows Credential Manager limita cada entrada a 2560 bytes UTF-16. Los tokens
/// OAuth de ChatGPT y Claude superan ese tamano, asi que la credencial se reparte
/// en varias entradas del mismo almacen seguro.
const KEYRING_CHUNK_CHARS: usize = 1000;
const KEYRING_MAX_CHUNKS: usize = 32;

fn keyring_entry(provider: ProviderId) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, provider.keyring_account())
        .map_err(|error| format!("No se pudo abrir el almacen seguro: {error}"))
}

fn keyring_chunk_entry(provider: ProviderId, index: usize) -> Result<Entry, String> {
    let account = format!("{}-part{index}", provider.keyring_account());
    Entry::new(KEYRING_SERVICE, &account)
        .map_err(|error| format!("No se pudo abrir el almacen seguro: {error}"))
}

fn chunk_count(value: &str) -> Option<usize> {
    serde_json::from_str::<Value>(value)
        .ok()?
        .get("__chunks")?
        .as_u64()
        .map(|count| count as usize)
}

fn clear_chunks(provider: ProviderId) {
    for index in 0..KEYRING_MAX_CHUNKS {
        let Ok(entry) = keyring_chunk_entry(provider, index) else {
            return;
        };
        match entry.delete_credential() {
            Ok(()) => {}
            Err(_) => return,
        }
    }
}

pub fn load_credentials(provider: ProviderId) -> Result<Option<StoredProviderCredentials>, String> {
    let entry = keyring_entry(provider)?;
    let value = match entry.get_password() {
        Ok(value) => value,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "No se pudo leer la cuenta de {}: {error}",
                provider.display_name()
            ))
        }
    };
    if value.trim().is_empty() {
        return Ok(None);
    }
    let payload = match chunk_count(&value) {
        Some(count) if count > 0 && count <= KEYRING_MAX_CHUNKS => {
            let mut joined = String::new();
            for index in 0..count {
                let chunk = keyring_chunk_entry(provider, index)?
                    .get_password()
                    .map_err(|error| {
                        format!(
                            "No se pudo leer la cuenta de {}: {error}",
                            provider.display_name()
                        )
                    })?;
                joined.push_str(&chunk);
            }
            joined
        }
        _ => value,
    };
    serde_json::from_str(&payload).map(Some).map_err(|error| {
        format!(
            "La credencial guardada de {} no es valida: {error}",
            provider.display_name()
        )
    })
}

fn save_credentials(provider: ProviderId, credentials: &StoredProviderCredentials) -> Result<(), String> {
    let entry = keyring_entry(provider)?;
    let value = serde_json::to_string(credentials)
        .map_err(|error| format!("No se pudo serializar la cuenta: {error}"))?;
    clear_chunks(provider);

    let chunks: Vec<String> = if value.chars().count() <= KEYRING_CHUNK_CHARS {
        Vec::new()
    } else {
        value
            .chars()
            .collect::<Vec<char>>()
            .chunks(KEYRING_CHUNK_CHARS)
            .map(|chunk| chunk.iter().collect())
            .collect()
    };

    if chunks.is_empty() {
        return entry.set_password(&value).map_err(|error| {
            format!(
                "No se pudo guardar {} en el almacen seguro: {error}",
                provider.display_name()
            )
        });
    }
    if chunks.len() > KEYRING_MAX_CHUNKS {
        return Err(format!(
            "La credencial de {} es demasiado grande para el almacen seguro.",
            provider.display_name()
        ));
    }
    for (index, chunk) in chunks.iter().enumerate() {
        keyring_chunk_entry(provider, index)?
            .set_password(chunk)
            .map_err(|error| {
                format!(
                    "No se pudo guardar {} en el almacen seguro: {error}",
                    provider.display_name()
                )
            })?;
    }
    let manifest = serde_json::json!({ "__chunks": chunks.len() }).to_string();
    entry.set_password(&manifest).map_err(|error| {
        format!(
            "No se pudo guardar {} en el almacen seguro: {error}",
            provider.display_name()
        )
    })
}

fn delete_credentials(provider: ProviderId) -> Result<(), String> {
    clear_chunks(provider);
    let entry = keyring_entry(provider)?;
    match entry.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "No se pudo quitar la cuenta de {}: {error}",
            provider.display_name()
        )),
    }
}

fn empty_status(provider: ProviderId, error: Option<String>) -> ProviderStatus {
    ProviderStatus {
        id: provider.as_str().to_string(),
        name: provider.display_name().to_string(),
        connected: false,
        auth_mode: None,
        account_label: None,
        plan: None,
        reauth_required: false,
        supports_oauth: provider.supports_oauth(),
        supports_api_key: provider.supports_api_key(),
        oauth_hint: provider.oauth_hint().into(),
    }
    .with_error_hint(error)
}

trait StatusError {
    fn with_error_hint(self, error: Option<String>) -> Self;
}

impl StatusError for ProviderStatus {
    fn with_error_hint(mut self, error: Option<String>) -> Self {
        if let Some(error) = error {
            self.oauth_hint = error;
        }
        self
    }
}

fn status_from_credentials(provider: ProviderId, credentials: &StoredProviderCredentials) -> ProviderStatus {
    ProviderStatus {
        id: provider.as_str().to_string(),
        name: provider.display_name().to_string(),
        connected: credentials.is_connected() || credentials.auth_mode == "cli_login",
        auth_mode: Some(credentials.auth_mode.clone()),
        account_label: credentials.account_label.clone(),
        plan: credentials.plan.clone(),
        reauth_required: false,
        supports_oauth: provider.supports_oauth(),
        supports_api_key: provider.supports_api_key(),
        oauth_hint: "Cuenta guardada en el almacen seguro de este sistema.".into(),
    }
}

pub fn ensure_fresh(provider: ProviderId) -> Result<StoredProviderCredentials, String> {
    let credentials = load_credentials(provider)?
        .ok_or_else(|| format!("No hay una cuenta conectada de {}.", provider.display_name()))?;
    if !credential_needs_refresh(&credentials) {
        return Ok(credentials);
    }
    let refreshed = match provider {
        ProviderId::Openai => openai::refresh(&credentials),
        ProviderId::Xai => xai::refresh(&credentials),
        ProviderId::Anthropic => anthropic::refresh(&credentials),
        _ => return Ok(credentials),
    };
    match refreshed {
        Ok(next) => {
            save_credentials(provider, &next)?;
            Ok(next)
        }
        Err(error) => {
            let mut stale = credentials;
            stale.access_token = None;
            let _ = save_credentials(provider, &stale);
            Err(format!(
                "{} requiere volver a iniciar sesion: {error}",
                provider.display_name()
            ))
        }
    }
}

pub fn launch_environment(agent_type: &str) -> HashMap<String, String> {
    let Some(provider) = crate::providers::http::provider_from_agent_type(agent_type) else {
        return HashMap::new();
    };
    let Ok(Some(credentials)) = load_credentials(provider) else {
        return HashMap::new();
    };
    match provider {
        ProviderId::Openai => openai::launch_env(&credentials),
        ProviderId::Xai => xai::launch_env(&credentials),
        ProviderId::Anthropic => anthropic::launch_env(&credentials),
        ProviderId::Gemini => gemini::launch_env(&credentials),
        ProviderId::Cursor => cursor::launch_env(&credentials),
        other if other.is_openai_compat() => crate::providers::openai_compat::launch_env(other, &credentials),
        other if other.is_cli_agent() => crate::providers::cli_agent::launch_env(other, &credentials),
        _ => HashMap::new(),
    }
}

#[tauri::command]
pub fn provider_status(provider: String) -> Result<ProviderStatus, String> {
    let provider = ProviderId::parse(&provider)?;
    match load_credentials(provider) {
        Ok(Some(credentials)) => {
            let mut status = status_from_credentials(provider, &credentials);
            if credential_needs_refresh(&credentials) {
                match ensure_fresh(provider) {
                    Ok(fresh) => status = status_from_credentials(provider, &fresh),
                    Err(_) => status.reauth_required = true,
                }
            }
            Ok(status)
        }
        Ok(None) => Ok(empty_status(provider, None)),
        Err(error) => Ok(empty_status(provider, Some(error))),
    }
}

fn provider_status_local(provider: ProviderId) -> Result<ProviderStatus, String> {
    match load_credentials(provider) {
        Ok(Some(credentials)) => {
            let mut status = status_from_credentials(provider, &credentials);
            status.reauth_required = credential_needs_refresh(&credentials);
            Ok(status)
        }
        Ok(None) => Ok(empty_status(provider, None)),
        Err(error) => Ok(empty_status(provider, Some(error))),
    }
}

#[tauri::command]
pub fn provider_list_status() -> Result<Vec<ProviderStatus>, String> {
    ProviderId::all()
        .into_iter()
        .copied()
        .map(provider_status_local)
        .collect()
}

fn watch_credential_slot(
    app: AppHandle,
    provider: ProviderId,
    slot: Arc<std::sync::Mutex<Option<Result<StoredProviderCredentials, String>>>>,
) {
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(610);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(80));
            let snapshot = slot.lock().ok().and_then(|guard| guard.clone());
            match snapshot {
                Some(Ok(credentials)) => {
                    let status = match save_credentials(provider, &credentials) {
                        Ok(()) => status_from_credentials(provider, &credentials),
                        Err(error) => empty_status(provider, Some(error)),
                    };
                    let _ = app.emit("provider-oauth-complete", status);
                    return;
                }
                Some(Err(error)) => {
                    let status = empty_status(provider, Some(error));
                    let _ = app.emit("provider-oauth-complete", status);
                    return;
                }
                None => {}
            }
        }
    });
}

#[tauri::command]
pub fn provider_oauth_start(
    app: AppHandle,
    provider: String,
    mode: Option<String>,
) -> Result<OAuthStartResult, String> {
    let provider = ProviderId::parse(&provider)?;
    let mode = mode.unwrap_or_default();
    let mut pending = PENDING
        .lock()
        .map_err(|_| "El estado OAuth esta bloqueado.".to_string())?;
    *pending = None;

    match provider {
        ProviderId::Gemini => {
            return Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some(gemini::STUDIO_KEY_URL.into()),
                user_code: None,
                expires_in: None,
                interval_ms: None,
                message: "Google retiro el login consumer. Se abre AI Studio para crear una API key real.".into(),
            });
        }
        ProviderId::Openai if mode == "device" => {
            let (device_code, user_code, verification_uri, interval, expires_in) = openai::start_device()?;
            *pending = Some((
                provider,
                PendingOAuth::OpenaiDevice {
                    device_code,
                    started: Instant::now(),
                    expires_in,
                },
            ));
            Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some(verification_uri),
                user_code: Some(user_code),
                expires_in: Some(expires_in),
                interval_ms: Some(interval.saturating_mul(1000)),
                message: "Introduce el codigo en el login oficial de ChatGPT.".into(),
            })
        }
        ProviderId::Openai => {
            let start = openai::start_pkce()?;
            let url = start.authorize_url.clone();
            let slot = start.code_slot.clone();
            *pending = Some((
                provider,
                PendingOAuth::OpenaiPkce {
                    start,
                    started: Instant::now(),
                },
            ));
            watch_credential_slot(app, provider, slot);
            Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some(url),
                user_code: None,
                expires_in: Some(600),
                interval_ms: Some(400),
                message: "Se abre el login real de ChatGPT. Completalo en el navegador.".into(),
            })
        }
        ProviderId::Xai => {
            let (device_code, user_code, verification_uri, interval, expires_in) = xai::start_device()?;
            *pending = Some((
                provider,
                PendingOAuth::XaiDevice {
                    device_code,
                    started: Instant::now(),
                    expires_in,
                },
            ));
            Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some(verification_uri),
                user_code: Some(user_code),
                expires_in: Some(expires_in),
                interval_ms: Some(interval.saturating_mul(1000)),
                message: "Aprueba Grok en accounts.x.ai con el codigo mostrado.".into(),
            })
        }
        ProviderId::Anthropic => {
            let start = anthropic::start_pkce()?;
            let url = start.authorize_url.clone();
            let slot = start.code_slot.clone();
            *pending = Some((
                provider,
                PendingOAuth::AnthropicPkce {
                    start,
                    started: Instant::now(),
                },
            ));
            watch_credential_slot(app, provider, slot);
            Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some(url),
                user_code: None,
                expires_in: Some(600),
                interval_ms: Some(400),
                message: "Se abre el login real de Claude. Completalo en el navegador.".into(),
            })
        }
        ProviderId::Cursor => {
            let message = cursor::start_login()?;
            *pending = Some((
                provider,
                PendingOAuth::CursorCli {
                    started: Instant::now(),
                },
            ));
            Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some("https://cursor.com/dashboard".into()),
                user_code: None,
                expires_in: Some(180),
                interval_ms: Some(2000),
                message,
            })
        }
        ProviderId::Github => {
            if let Some(token) = crate::github_service::current_access_token() {
                let mut credentials = StoredProviderCredentials::from_api_key(token);
                credentials.account_label = Some("GitHub conectado".into());
                credentials.plan = Some("GitHub Models".into());
                save_credentials(provider, &credentials)?;
                return Ok(OAuthStartResult {
                    provider: provider.as_str().to_string(),
                    verification_uri: None,
                    user_code: None,
                    expires_in: None,
                    interval_ms: None,
                    message: "Se reutiliza tu cuenta de GitHub para GitHub Models.".into(),
                });
            }
            Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some(provider.key_console_url().into()),
                user_code: None,
                expires_in: None,
                interval_ms: None,
                message: "Conecta GitHub en ComesADE o pega un PAT con acceso a Models.".into(),
            })
        }
        other if crate::providers::cli_agent::spec(other).is_some_and(|spec| !spec.login_args.is_empty()) => {
            let message = crate::providers::cli_agent::start_login(other)?;
            *pending = Some((
                provider,
                PendingOAuth::GenericCli {
                    started: Instant::now(),
                },
            ));
            Ok(OAuthStartResult {
                provider: provider.as_str().to_string(),
                verification_uri: Some(other.key_console_url().into()),
                user_code: None,
                expires_in: Some(180),
                interval_ms: Some(2000),
                message,
            })
        }
        other => Ok(OAuthStartResult {
            provider: other.as_str().to_string(),
            verification_uri: Some(other.key_console_url().into()),
            user_code: None,
            expires_in: None,
            interval_ms: None,
            message: format!(
                "Se abre la consola de {}. Pega una API key real; ComesADE la guarda en el almacen seguro.",
                other.display_name()
            ),
        }),
    }
}

#[tauri::command]
pub fn provider_oauth_poll(provider: String) -> Result<OAuthPollResult, String> {
    let provider = ProviderId::parse(&provider)?;
    let pending = PENDING
        .lock()
        .map_err(|_| "El estado OAuth esta bloqueado.".to_string())?
        .clone();
    let Some((pending_provider, kind)) = pending else {
        return Ok(OAuthPollResult {
            provider: provider.as_str().to_string(),
            connected: false,
            pending: false,
            error: Some("No hay un login en curso.".into()),
            status: provider_status(provider.as_str().to_string())?,
        });
    };
    if pending_provider != provider {
        return Err("Hay otro proveedor autenticandose ahora.".into());
    }

    let credentials = match kind {
        PendingOAuth::OpenaiPkce { start, started } => {
            if started.elapsed().as_secs() > 600 {
                return timeout_result(provider);
            }
            match start.code_slot.lock() {
                Ok(guard) => match guard.as_ref() {
                    None => return pending_result(provider),
                    Some(Err(error)) => return err_result(provider, error.clone()),
                    Some(Ok(credentials)) => Some(credentials.clone()),
                },
                Err(_) => return pending_result(provider),
            }
        }
        PendingOAuth::OpenaiDevice {
            device_code,
            started,
            expires_in,
        } => {
            if started.elapsed().as_secs() > expires_in {
                return timeout_result(provider);
            }
            openai::poll_device(&device_code)?
        }
        PendingOAuth::XaiDevice {
            device_code,
            started,
            expires_in,
        } => {
            if started.elapsed().as_secs() > expires_in {
                return timeout_result(provider);
            }
            xai::poll_device(&device_code)?
        }
        PendingOAuth::AnthropicPkce { start, started } => {
            if started.elapsed().as_secs() > 600 {
                return timeout_result(provider);
            }
            match start.code_slot.lock() {
                Ok(guard) => match guard.as_ref() {
                    None => return pending_result(provider),
                    Some(Err(error)) => return err_result(provider, error.clone()),
                    Some(Ok(credentials)) => Some(credentials.clone()),
                },
                Err(_) => return pending_result(provider),
            }
        }
        PendingOAuth::CursorCli { started } => {
            if started.elapsed().as_secs() > 180 {
                return timeout_result(provider);
            }
            cursor::poll_status()?
        }
        PendingOAuth::GenericCli { started } => {
            if started.elapsed().as_secs() > 180 {
                return timeout_result(provider);
            }
            crate::providers::cli_agent::poll_status(provider)?
        }
    };

    if let Some(credentials) = credentials {
        save_credentials(provider, &credentials)?;
        if let Ok(mut guard) = PENDING.lock() {
            *guard = None;
        }
        return Ok(OAuthPollResult {
            provider: provider.as_str().to_string(),
            connected: true,
            pending: false,
            error: None,
            status: status_from_credentials(provider, &credentials),
        });
    }
    pending_result(provider)
}

fn pending_result(provider: ProviderId) -> Result<OAuthPollResult, String> {
    Ok(OAuthPollResult {
        provider: provider.as_str().to_string(),
        connected: false,
        pending: true,
        error: None,
        status: provider_status(provider.as_str().to_string())?,
    })
}

fn timeout_result(provider: ProviderId) -> Result<OAuthPollResult, String> {
    if let Ok(mut guard) = PENDING.lock() {
        *guard = None;
    }
    err_result(provider, "El login expiro. Vuelve a conectar.".into())
}

fn err_result(provider: ProviderId, error: String) -> Result<OAuthPollResult, String> {
    if let Ok(mut guard) = PENDING.lock() {
        *guard = None;
    }
    Ok(OAuthPollResult {
        provider: provider.as_str().to_string(),
        connected: false,
        pending: false,
        error: Some(error),
        status: provider_status(provider.as_str().to_string())?,
    })
}

#[tauri::command]
pub fn provider_oauth_cancel(provider: String) -> Result<(), String> {
    let provider = ProviderId::parse(&provider)?;
    if let Ok(mut guard) = PENDING.lock() {
        if guard.as_ref().is_some_and(|(id, _)| *id == provider) {
            *guard = None;
        }
    }
    Ok(())
}

fn verify_api_key(provider: ProviderId, key: &str) -> Result<String, String> {
    let client = crate::providers::http::http_client()?;
    let request = match provider {
        ProviderId::Gemini => client.get(format!(
            "https://generativelanguage.googleapis.com/v1beta/models?key={}",
            urlencoding::encode(key)
        )),
        ProviderId::Openai => client
            .get("https://api.openai.com/v1/models")
            .bearer_auth(key),
        ProviderId::Xai => client
            .get("https://api.x.ai/v1/models")
            .bearer_auth(key),
        ProviderId::Anthropic => client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        other => {
            let Some(chat_url) = other.chat_completions_url() else {
                return Err(format!(
                    "{} no acepta una API key suelta. Usa Conectar para el login real.",
                    other.display_name()
                ));
            };
            let models_url = chat_url.replacen("/chat/completions", "/models", 1);
            let mut request = client.get(models_url).bearer_auth(key);
            if other == ProviderId::Openrouter {
                request = request
                    .header("HTTP-Referer", "https://comesade.app")
                    .header("X-Title", "ComesADE");
            }
            if other == ProviderId::Github {
                request = request.header("Accept", "application/vnd.github+json");
            }
            request
        }
    };
    let response = request.send().map_err(|error| {
        format!("No se pudo comprobar la key de {}: {error}", provider.display_name())
    })?;
    if !response.status().is_success() {
        return Err(crate::providers::http::response_error(
            response,
            &format!("{} rechazo la API key", provider.display_name()),
        ));
    }
    Ok(format!("{} verificado", provider.display_name()))
}

#[tauri::command]
pub fn provider_save_key(provider: String, api_key: String) -> Result<ProviderStatus, String> {
    let provider = ProviderId::parse(&provider)?;
    let key = api_key.trim().to_string();
    if key.len() < 8 {
        return Err("La API key es demasiado corta.".into());
    }
    let label = verify_api_key(provider, &key)?;
    let mut credentials = StoredProviderCredentials::from_api_key(key);
    credentials.account_label = Some(label);
    credentials.plan = Some("API key".into());
    save_credentials(provider, &credentials)?;
    Ok(status_from_credentials(provider, &credentials))
}

/// Consumo del plan que los proveedores han reportado en esta maquina.
#[tauri::command]
pub fn provider_usage() -> Vec<crate::providers::usage::UsageSnapshot> {
    crate::providers::usage::all()
}

/// Rehidrata el ultimo consumo conocido al arrancar, antes de la primera llamada.
#[tauri::command]
pub fn provider_usage_restore(snapshots: Vec<crate::providers::usage::UsageSnapshot>) {
    crate::providers::usage::restore(snapshots);
}

#[tauri::command]
pub fn provider_disconnect(provider: String) -> Result<ProviderStatus, String> {
    let provider = ProviderId::parse(&provider)?;
    delete_credentials(provider)?;
    Ok(empty_status(provider, None))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatRequest {
    pub provider: String,
    pub workspace_path: String,
    pub messages: Vec<AgentUiMessage>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUiMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[allow(dead_code)]
pub fn parse_json_object(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or(Value::Null)
}
