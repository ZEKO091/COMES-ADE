use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

mod git_service;
mod github_service;
mod storage;
mod workspace_fs;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: String,
    name: String,
    shell: String,
    executable: String,
    cwd: String,
    pid: Option<u32>,
    cols: u16,
    rows: u16,
    status: String,
    agent_type: Option<String>,
    worktree: Option<String>,
    workspace_path: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    session_id: String,
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatusEvent {
    session_id: String,
    status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileChange {
    root: String,
    kind: String,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentDefinition {
    id: String,
    name: String,
    executable: String,
    path: Option<String>,
    installed: bool,
    args: Vec<String>,
    environment: HashMap<String, String>,
    detect_command: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellDefinition {
    id: String,
    name: String,
    executable: String,
    path: Option<String>,
    installed: bool,
    is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: String,
    default_shell: String,
    default_shell_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionRequest {
    name: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    initial_command: Option<String>,
    agent_type: Option<String>,
    worktree: Option<String>,
    workspace_path: Option<String>,
    env: Option<HashMap<String, String>>,
}

struct SessionProcess {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send>>,
    closed: AtomicBool,
}

struct AppState {
    sessions: Mutex<HashMap<String, Arc<SessionProcess>>>,
    metadata: Mutex<HashMap<String, SessionInfo>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            metadata: Mutex::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

impl AppState {
    fn close_all(&self) {
        if let Ok(mut watchers) = self.watchers.lock() {
            watchers.clear();
        }
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, process)| process)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for process in sessions {
            terminate_session_process(&process);
        }

        if let Ok(mut metadata) = self.metadata.lock() {
            metadata.clear();
        }
    }
}

fn default_cwd() -> PathBuf {
    user_home()
        .filter(|path| path.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:/" } else { "/" }))
}

fn user_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let variable = "USERPROFILE";
    #[cfg(not(windows))]
    let variable = "HOME";

    std::env::var_os(variable).map(PathBuf::from)
}

#[cfg(windows)]
pub(crate) fn augmented_path() -> Option<OsString> {
    let mut paths =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    let mut additional_paths = Vec::new();
    if let Some(home) = user_home() {
        additional_paths.extend([
            home.join("AppData").join("Roaming").join("npm"),
            home.join(".npm-global").join("bin"),
            home.join(".local").join("bin"),
            home.join("scoop").join("shims"),
        ]);
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            additional_paths.extend([
                root.join("nodejs"),
                root.join("Git").join("cmd"),
                root.join("Git").join("bin"),
                root.join("Programs").join("Git").join("cmd"),
                root.join("Programs").join("Git").join("bin"),
            ]);
        }
    }
    for path in additional_paths {
        if path.is_dir() && !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).ok()
}

#[cfg(unix)]
pub(crate) fn augmented_path() -> Option<OsString> {
    let mut paths =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect::<Vec<_>>();
    let mut additional_paths = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    if let Some(home) = user_home() {
        additional_paths.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".npm-global/bin"),
        ]);
    }
    for path in additional_paths {
        if path.is_dir() && !paths.iter().any(|existing| existing == &path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).ok()
}

#[cfg(not(any(windows, unix)))]
pub(crate) fn augmented_path() -> Option<OsString> {
    std::env::var_os("PATH")
}

#[cfg(windows)]
fn shell_candidates() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("powershell", "Windows PowerShell", "powershell.exe"),
        ("pwsh", "PowerShell 7", "pwsh.exe"),
        ("cmd", "Command Prompt", "cmd.exe"),
        ("bash", "Bash", "bash.exe"),
        ("wsl", "WSL", "wsl.exe"),
    ]
}

#[cfg(target_os = "macos")]
fn shell_candidates() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("zsh", "Zsh", "zsh"),
        ("bash", "Bash", "bash"),
        ("fish", "Fish", "fish"),
        ("sh", "POSIX shell", "sh"),
        ("pwsh", "PowerShell 7", "pwsh"),
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn shell_candidates() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("bash", "Bash", "bash"),
        ("zsh", "Zsh", "zsh"),
        ("fish", "Fish", "fish"),
        ("sh", "POSIX shell", "sh"),
        ("pwsh", "PowerShell 7", "pwsh"),
    ]
}

#[cfg(not(any(windows, unix)))]
fn shell_candidates() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![("sh", "Shell", "sh")]
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(unix) {
        "linux"
    } else {
        "unknown"
    }
}

fn platform_default_shell_id() -> String {
    #[cfg(not(windows))]
    if let Some(shell) = std::env::var_os("SHELL").and_then(|value| {
        PathBuf::from(value)
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_ascii_lowercase())
    }) {
        if shell_candidates()
            .iter()
            .any(|(id, _, _)| id.eq_ignore_ascii_case(shell.as_str()))
            && command_path(&shell).is_some()
        {
            return shell;
        }
    }

    shell_candidates()
        .into_iter()
        .find(|(_, _, executable)| command_path(executable).is_some())
        .map(|(id, _, _)| id.to_string())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "powershell".to_string()
            } else {
                "sh".to_string()
            }
        })
}

fn platform_default_shell_name() -> String {
    let id = platform_default_shell_id();
    shell_candidates()
        .into_iter()
        .find(|(candidate, _, _)| *candidate == id.as_str())
        .map(|(_, name, _)| name.to_string())
        .unwrap_or_else(|| "Shell".to_string())
}

#[cfg(windows)]
fn resolve_powershell() -> Result<(PathBuf, String), String> {
    if let Ok(path) = resolve_executable("pwsh.exe") {
        return Ok((path, "PowerShell 7".to_string()));
    }
    resolve_executable("powershell.exe").map(|path| (path, "Windows PowerShell".to_string()))
}

#[cfg(not(windows))]
fn resolve_powershell() -> Result<(PathBuf, String), String> {
    resolve_executable("pwsh").map(|path| (path, "PowerShell 7".to_string()))
}

#[derive(Debug, Clone)]
struct ShellSpec {
    path: PathBuf,
    reported_path: PathBuf,
    label: String,
    args: Vec<String>,
    direct_program: bool,
}

pub(crate) fn resolve_executable(name: &str) -> Result<PathBuf, String> {
    let trimmed = name.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("El ejecutable no puede estar vacio.".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if candidate.is_file() {
        return candidate
            .canonicalize()
            .map(clean_executable_path)
            .map_err(|error| format!("No se pudo resolver el ejecutable: {error}"));
    }

    #[cfg(windows)]
    let resolver = ("where.exe", trimmed);
    #[cfg(not(windows))]
    let resolver = ("which", trimmed);

    let mut command = Command::new(resolver.0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    if let Some(path) = augmented_path() {
        command.env("PATH", path);
    }
    let output = command
        .arg(resolver.1)
        .output()
        .map_err(|error| format!("No se pudo buscar {trimmed} en PATH: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "El ejecutable \"{trimmed}\" no esta instalado o no esta en PATH."
        ));
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
        .map(clean_executable_path)
        .ok_or_else(|| format!("No se encontro \"{trimmed}\" en PATH."))
}

fn clean_executable_path(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        let text = path.to_string_lossy();
        if let Some(stripped) = text.strip_prefix("\\\\?\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

fn executable_label(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Process")
        .to_string()
}

fn resolve_shell(request: &CreateSessionRequest) -> Result<ShellSpec, String> {
    if let Some(program) = request
        .program
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let reported_path = resolve_executable(program)?;
        let label = request
            .agent_type
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| executable_label(&reported_path));
        let program_args = request.args.clone().unwrap_or_default();
        let extension = reported_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if extension == "ps1" {
            let (host, _) = resolve_powershell()?;
            let mut args = vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-File".to_string(),
                reported_path.to_string_lossy().into_owned(),
            ];
            args.extend(program_args);
            return Ok(ShellSpec {
                path: host,
                reported_path,
                label,
                args,
                direct_program: true,
            });
        }

        if (extension == "cmd" || extension == "bat") && !cfg!(windows) {
            return Err("Los scripts .cmd y .bat solo pueden abrirse en Windows.".to_string());
        }

        if extension == "cmd" || extension == "bat" {
            let host = resolve_executable("cmd.exe")?;
            let command_line = std::iter::once(reported_path.to_string_lossy().into_owned())
                .chain(program_args)
                .map(|value| quote_cmd_argument(&value))
                .collect::<Vec<_>>()
                .join(" ");
            return Ok(ShellSpec {
                path: host,
                reported_path,
                label,
                args: vec![
                    "/D".to_string(),
                    "/Q".to_string(),
                    "/C".to_string(),
                    format!("call {command_line}"),
                ],
                direct_program: true,
            });
        }

        if extension == "sh" && cfg!(windows) {
            let host = resolve_executable("bash.exe")?;
            let mut args = vec![reported_path.to_string_lossy().into_owned()];
            args.extend(program_args);
            return Ok(ShellSpec {
                path: host,
                reported_path,
                label,
                args,
                direct_program: true,
            });
        }

        return Ok(ShellSpec {
            path: reported_path.clone(),
            reported_path,
            label,
            args: program_args,
            direct_program: true,
        });
    }

    let mut requested = request
        .shell
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(platform_default_shell_id);

    // Configuraciones antiguas guardaban "powershell" incluso fuera de Windows.
    // Si PowerShell 7 no existe, migramos la sesión al shell nativo del sistema.
    if !cfg!(windows)
        && matches!(
            requested.as_str(),
            "powershell" | "windows-powershell" | "powershell.exe"
        )
        && resolve_executable("pwsh").is_err()
    {
        requested = platform_default_shell_id();
    }

    let (path, label, mut args) = match requested.as_str() {
        "powershell" | "windows-powershell" | "powershell.exe" => {
            let (path, label) = resolve_powershell()?;
            let args = vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NoExit".to_string(),
            ];
            (path, label, args)
        }
        "pwsh" | "pwsh.exe" | "powershell-7" => (
            resolve_executable(if cfg!(windows) { "pwsh.exe" } else { "pwsh" })?,
            "PowerShell 7".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NoExit".to_string(),
            ],
        ),
        "cmd" | "cmd.exe" if cfg!(windows) => (
            resolve_executable("cmd.exe")?,
            "Command Prompt".to_string(),
            vec!["/Q".to_string()],
        ),
        "cmd" | "cmd.exe" => {
            return Err("Command Prompt solo está disponible en Windows.".to_string())
        }
        "bash" | "bash.exe" => (
            resolve_executable(if cfg!(windows) { "bash.exe" } else { "bash" })?,
            "Bash".to_string(),
            vec![
                "--noprofile".to_string(),
                "--norc".to_string(),
                "-i".to_string(),
            ],
        ),
        "zsh" | "zsh.exe" => (
            resolve_executable(if cfg!(windows) { "zsh.exe" } else { "zsh" })?,
            "Zsh".to_string(),
            vec!["-f".to_string(), "-i".to_string()],
        ),
        "fish" | "fish.exe" => (
            resolve_executable(if cfg!(windows) { "fish.exe" } else { "fish" })?,
            "Fish".to_string(),
            vec!["--no-config".to_string(), "--interactive".to_string()],
        ),
        "sh" | "sh.exe" => (
            resolve_executable(if cfg!(windows) { "sh.exe" } else { "sh" })?,
            "POSIX shell".to_string(),
            vec!["-i".to_string()],
        ),
        "wsl" | "wsl.exe" if cfg!(windows) => (
            resolve_executable("wsl.exe")?,
            "WSL".to_string(),
            Vec::new(),
        ),
        "wsl" | "wsl.exe" => return Err("WSL solo está disponible en Windows.".to_string()),
        custom => {
            let path = resolve_executable(custom)?;
            (path.clone(), executable_label(&path), Vec::new())
        }
    };

    let path = resolve_executable(path.to_string_lossy().as_ref())?;
    if let Some(extra) = &request.args {
        args.extend(extra.iter().cloned());
    }
    Ok(ShellSpec {
        path: path.clone(),
        reported_path: path.clone(),
        label,
        args,
        direct_program: false,
    })
}

fn quote_cmd_argument(value: &str) -> String {
    let escaped = value
        .chars()
        .map(|character| match character {
            '^' | '&' | '|' | '<' | '>' => format!("^{}", character),
            '"' => "^\"".to_string(),
            _ => character.to_string(),
        })
        .collect::<String>();
    format!("\"{escaped}\"")
}

fn created_at() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn unique_session_name(
    metadata: &HashMap<String, SessionInfo>,
    requested: &str,
    excluded_id: Option<&str>,
) -> String {
    let base = requested.trim();
    let is_used = |candidate: &str| {
        metadata.iter().any(|(id, session)| {
            Some(id.as_str()) != excluded_id && session.name.eq_ignore_ascii_case(candidate)
        })
    };
    if !is_used(base) {
        return base.to_string();
    }
    for index in 2..10_000 {
        let candidate = format!("{base} ({index})");
        if !is_used(&candidate) {
            return candidate;
        }
    }
    format!("{base} ({})", metadata.len() + 1)
}

fn command_path(name: &str) -> Option<String> {
    resolve_executable(name)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn detect_agents() -> Vec<AgentDefinition> {
    [
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("opencode", "OpenCode"),
        ("gemini", "Gemini CLI"),
        ("cursor-agent", "Cursor Agent"),
        ("aider", "Aider"),
    ]
    .into_iter()
    .map(|(executable, name)| {
        let path = command_path(executable);
        AgentDefinition {
            id: executable.to_string(),
            name: name.to_string(),
            executable: executable.to_string(),
            installed: path.is_some(),
            path,
            args: Vec::new(),
            environment: HashMap::new(),
            detect_command: Some(executable.to_string()),
        }
    })
    .collect()
}

#[tauri::command]
fn resolve_executable_path(name: String) -> Result<Option<String>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(resolve_executable(trimmed)
        .ok()
        .map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn detect_shells() -> Vec<ShellDefinition> {
    let default_shell = platform_default_shell_id();
    shell_candidates()
        .into_iter()
        .map(|(id, name, executable)| {
            let path = command_path(executable);
            ShellDefinition {
                id: id.to_string(),
                name: name.to_string(),
                executable: executable.to_string(),
                installed: path.is_some(),
                path,
                is_default: id == default_shell,
            }
        })
        .collect()
}

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: platform_name().to_string(),
        default_shell: platform_default_shell_id(),
        default_shell_name: platform_default_shell_name(),
    }
}

fn valid_cwd(requested: Option<String>) -> Result<PathBuf, String> {
    let Some(value) = requested
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(default_cwd());
    };

    let path = PathBuf::from(&value);
    if !path.is_dir() {
        return Err(format!(
            "El directorio inicial no existe o no es una carpeta: {value}"
        ));
    }
    path.canonicalize()
        .map_err(|error| format!("No se pudo resolver el directorio inicial: {error}"))
}

fn terminate_process_tree(pid: Option<u32>, child: &mut dyn Child) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        let taskkill = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|root| root.join("System32").join("taskkill.exe"))
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from("taskkill.exe"));
        let mut command = Command::new(taskkill);
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.creation_flags(CREATE_NO_WINDOW);
        if command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            wait_for_child_exit_with_timeout(child, Duration::from_millis(500));
            return;
        }
    }

    let _ = child.kill();
    wait_for_child_exit_with_timeout(child, Duration::from_millis(500));
}

fn wait_for_child_exit_with_timeout(child: &mut dyn Child, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() >= deadline => return,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
        }
    }
}

fn terminate_session_process(process: &Arc<SessionProcess>) {
    if process.closed.swap(true, Ordering::AcqRel) {
        return;
    }

    #[cfg(unix)]
    if let Ok(master) = process.master.lock() {
        terminate_process_group(&**master);
    }
    if let Ok(mut child) = process.child.lock() {
        terminate_process_tree(child.process_id(), &mut **child);
    }
}

#[cfg(unix)]
fn terminate_process_group(master: &dyn MasterPty) {
    if let Some(group) = master.process_group_leader() {
        let current_group = unsafe { libc::getpgrp() };
        if group > 0 && group != current_group {
            unsafe {
                libc::kill(-group, libc::SIGHUP);
            }
        }
    }
}

fn watcher_should_ignore(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    relative.components().any(|component| {
        matches!(
            component
                .as_os_str()
                .to_string_lossy()
                .to_ascii_lowercase()
                .as_str(),
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".nuxt"
                | ".turbo"
                | ".cache"
                | ".parcel-cache"
        )
    })
}

#[tauri::command]
fn watch_workspace(app: AppHandle, state: State<'_, AppState>, root: String) -> Result<(), String> {
    let trimmed = root.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Watcher root is required.".to_string());
    }
    let root_path = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|error| format!("Could not resolve watcher root: {error}"))?;
    if !root_path.is_dir() {
        return Err("Watcher root is not a directory.".to_string());
    }
    let root_key = root_path.to_string_lossy().into_owned();
    let event_root = root_key.clone();
    let callback_root = root_path.clone();
    let pending_events = Arc::new(Mutex::new((HashSet::<String>::new(), String::new(), false)));
    let callback_pending_events = Arc::clone(&pending_events);
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            let paths = event
                .paths
                .into_iter()
                .filter(|path| !watcher_should_ignore(&callback_root, path))
                .map(|path| path.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            if paths.is_empty() {
                return;
            }

            let should_schedule = if let Ok(mut pending) = callback_pending_events.lock() {
                pending.0.extend(paths);
                pending.1 = format!("{:?}", event.kind);
                if pending.2 {
                    false
                } else {
                    pending.2 = true;
                    true
                }
            } else {
                false
            };

            if should_schedule {
                let app = app.clone();
                let root = event_root.clone();
                let pending = Arc::clone(&callback_pending_events);
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(180));
                    let (paths, kind) = if let Ok(mut pending) = pending.lock() {
                        pending.2 = false;
                        (pending.0.drain().collect::<Vec<_>>(), pending.1.clone())
                    } else {
                        (Vec::new(), String::new())
                    };
                    if paths.is_empty() {
                        return;
                    }
                    let _ = app.emit(
                        "workspace-file-change",
                        WorkspaceFileChange { root, kind, paths },
                    );
                });
            }
        }
    })
    .map_err(|error| format!("Could not create filesystem watcher: {error}"))?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|error| format!("Could not watch workspace: {error}"))?;

    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "Watcher registry is locked.".to_string())?;
    watchers.insert(root_key, watcher);
    Ok(())
}

#[tauri::command]
fn unwatch_workspace(state: State<'_, AppState>, root: String) -> Result<(), String> {
    let key = PathBuf::from(root.trim().trim_matches('"'))
        .canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| root.trim().trim_matches('"').to_string());
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "Watcher registry is locked.".to_string())?;
    watchers.remove(&key);
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.is_empty()
        || (!lower.starts_with("https://") && !lower.starts_with("http://"))
        || trimmed.contains('\r')
        || trimmed.contains('\n')
    {
        return Err("Solo se permiten enlaces http o https válidos.".to_string());
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        command.arg(trimmed);
        command.creation_flags(0x08000000);
        command
            .spawn()
            .map_err(|error| format!("No se pudo abrir el navegador: {error}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|error| format!("No se pudo abrir el navegador: {error}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|error| format!("No se pudo abrir el navegador: {error}"))?;
        Ok(())
    }
}

#[tauri::command]
fn validate_workspace_path(path: String) -> Result<String, String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Escribe la ruta de una carpeta real.".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if !candidate.is_dir() {
        return Err("La carpeta no existe o no es un directorio válido.".to_string());
    }

    candidate
        .canonicalize()
        .map(|resolved| resolved.to_string_lossy().into_owned())
        .map_err(|error| format!("No se pudo validar la carpeta: {error}"))
}

#[tauri::command]
fn pick_workspace_path() -> Result<Option<String>, String> {
    let selected = rfd::FileDialog::new()
        .set_title("Abrir workspace real")
        .pick_folder();

    selected
        .map(|path| {
            path.canonicalize()
                .map(|resolved| resolved.to_string_lossy().into_owned())
                .map_err(|error| format!("No se pudo resolver la carpeta seleccionada: {error}"))
        })
        .transpose()
}

#[tauri::command]
fn default_workspace_path() -> Result<String, String> {
    let documents = user_home()
        .map(|profile| profile.join("Documents"))
        .filter(|path| path.is_dir())
        .or_else(|| user_home().filter(|path| path.is_dir()))
        .ok_or_else(|| "No se encontró la carpeta Documentos local.".to_string())?;

    documents
        .canonicalize()
        .map(|resolved| resolved.to_string_lossy().into_owned())
        .map_err(|error| format!("No se pudo validar Documentos: {error}"))
}

fn wait_for_child_exit(child: &Mutex<Box<dyn Child + Send>>) -> Option<i32> {
    loop {
        let result = child.lock().ok().map(|mut child| child.try_wait());
        match result {
            Some(Ok(Some(status))) => return Some(status.exit_code() as i32),
            Some(Ok(None)) => thread::sleep(Duration::from_millis(80)),
            Some(Err(_)) | None => return None,
        }
    }
}

#[tauri::command]
fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CreateSessionRequest,
) -> Result<SessionInfo, String> {
    let id = format!(
        "session-{}",
        NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let cwd = valid_cwd(request.cwd.clone())?;
    let shell = resolve_shell(&request)?;
    let cols = request.cols.unwrap_or(120).max(2);
    let rows = request.rows.unwrap_or(32).max(2);
    let name = request
        .name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            request
                .agent_type
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    if shell.direct_program {
                        shell.label.clone()
                    } else {
                        format!("Terminal {}", NEXT_SESSION_ID.load(Ordering::Relaxed) - 1)
                    }
                })
        });

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("No se pudo abrir el PTY: {error}"))?;

    let mut command = CommandBuilder::new(shell.path.as_os_str());
    command.args(&shell.args);
    command.cwd(&cwd);
    if request
        .env
        .as_ref()
        .map(|values| !values.contains_key("PATH"))
        .unwrap_or(true)
    {
        if let Some(path) = augmented_path() {
            command.env("PATH", path);
        }
    }
    #[cfg(unix)]
    {
        if request
            .env
            .as_ref()
            .map(|values| !values.contains_key("TERM"))
            .unwrap_or(true)
        {
            command.env("TERM", "xterm-256color");
        }
        if request
            .env
            .as_ref()
            .map(|values| !values.contains_key("COLORTERM"))
            .unwrap_or(true)
        {
            command.env("COLORTERM", "truecolor");
        }
        if request
            .env
            .as_ref()
            .map(|values| !values.contains_key("TERM_PROGRAM"))
            .unwrap_or(true)
        {
            command.env("TERM_PROGRAM", "ComesADE");
        }
    }
    if let Some(environment) = &request.env {
        for (key, value) in environment {
            if !key.trim().is_empty() {
                command.env(key, value);
            }
        }
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("No se pudo iniciar {}: {error}", shell.label))?;
    drop(pair.slave);

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            #[cfg(unix)]
            terminate_process_group(&*pair.master);
            terminate_process_tree(child.process_id(), &mut *child);
            return Err(format!("No se pudo leer el PTY: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            #[cfg(unix)]
            terminate_process_group(&*pair.master);
            terminate_process_tree(child.process_id(), &mut *child);
            return Err(format!("No se pudo escribir en el PTY: {error}"));
        }
    };
    let pid = child.process_id();

    let mut writer = writer;
    if !shell.direct_program {
        if let Some(initial_command) = request
            .initial_command
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            if let Err(error) = writer
                .write_all(initial_command.as_bytes())
                .and_then(|_| writer.write_all(b"\r"))
                .and_then(|_| writer.flush())
            {
                #[cfg(unix)]
                terminate_process_group(&*pair.master);
                terminate_process_tree(child.process_id(), &mut *child);
                return Err(format!("No se pudo enviar el comando inicial: {error}"));
            }
        }
    }

    let process = Arc::new(SessionProcess {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        closed: AtomicBool::new(false),
    });

    let info = SessionInfo {
        id: id.clone(),
        name,
        shell: shell.label,
        executable: shell.reported_path.to_string_lossy().into_owned(),
        cwd: cwd.to_string_lossy().into_owned(),
        pid,
        cols,
        rows,
        status: "running".to_string(),
        agent_type: request.agent_type,
        worktree: request.worktree,
        workspace_path: request.workspace_path,
        created_at: created_at(),
    };

    if state.sessions.lock().is_err() || state.metadata.lock().is_err() {
        #[cfg(unix)]
        if let Ok(master) = process.master.lock() {
            terminate_process_group(&**master);
        }
        if let Ok(mut child) = process.child.lock() {
            terminate_process_tree(child.process_id(), &mut **child);
        }
        return Err("No se pudo registrar la sesion real.".to_string());
    }

    let mut session_registry = state
        .sessions
        .lock()
        .map_err(|_| "El registro de sesiones está bloqueado".to_string())?;
    let mut metadata_registry = state
        .metadata
        .lock()
        .map_err(|_| "El registro de metadatos está bloqueado".to_string())?;
    let mut info = info;
    info.name = unique_session_name(&metadata_registry, &info.name, None);
    session_registry.insert(id.clone(), Arc::clone(&process));
    metadata_registry.insert(id.clone(), info.clone());

    let output_app = app.clone();
    let output_id = id.clone();
    let output_process = Arc::clone(&process);
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    if output_process.closed.load(Ordering::Acquire) {
                        break;
                    }
                    let data = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let _ = output_app.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id: output_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        if !output_process.closed.load(Ordering::Acquire) {
            let _ = output_app.emit(
                "terminal-output-closed",
                TerminalStatusEvent {
                    session_id: output_id,
                    status: "output-closed".to_string(),
                },
            );
        }
    });

    let wait_app = app.clone();
    let wait_id = id.clone();
    let wait_process = Arc::clone(&process);
    thread::spawn(move || {
        // No mantengas el mutex durante una espera bloqueante: close_session
        // necesita adquirirlo para terminar el árbol del proceso. Polling con
        // try_wait permite que cerrar/reiniciar una terminal nunca se bloquee.
        let exit_code = wait_for_child_exit(&wait_process.child);
        if wait_process.closed.load(Ordering::Acquire) {
            return;
        }
        let app_state = wait_app.state::<AppState>();
        if let Ok(mut metadata) = app_state.metadata.lock() {
            if let Some(info) = metadata.get_mut(&wait_id) {
                info.status = "exited".to_string();
            }
        }
        let _ = wait_app.emit(
            "terminal-status",
            TerminalStatusEvent {
                session_id: wait_id.clone(),
                status: "exited".to_string(),
            },
        );
        let _ = wait_app.emit(
            "terminal-exit",
            TerminalExit {
                session_id: wait_id,
                exit_code,
            },
        );
    });

    Ok(info)
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let metadata = state
        .metadata
        .lock()
        .map_err(|_| "El registro de metadatos está bloqueado".to_string())?;
    let mut sessions = metadata.values().cloned().collect::<Vec<_>>();
    sessions.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(sessions)
}

#[tauri::command]
fn write_to_session(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let process = get_process(&state, &session_id)?;
    let mut writer = process
        .writer
        .lock()
        .map_err(|_| "El escritor del terminal está bloqueado".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("No se pudo escribir en el terminal: {error}"))
}

#[tauri::command]
fn interrupt_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    write_to_session(state, session_id, "\u{3}".to_string())
}

#[tauri::command]
fn resize_session(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let process = get_process(&state, &session_id)?;
    let cols = cols.max(2);
    let rows = rows.max(2);
    let master = process
        .master
        .lock()
        .map_err(|_| "El PTY está bloqueado".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("No se pudo redimensionar el PTY: {error}"))?;

    let mut metadata = state
        .metadata
        .lock()
        .map_err(|_| "metadata lock".to_string())?;
    if let Some(info) = metadata.get_mut(&session_id) {
        info.cols = cols;
        info.rows = rows;
    }
    Ok(())
}

#[tauri::command]
fn close_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let process = state
        .sessions
        .lock()
        .map_err(|_| "El registro de sesiones está bloqueado".to_string())?
        .remove(&session_id);

    let metadata_result = state
        .metadata
        .lock()
        .map(|mut metadata| metadata.remove(&session_id))
        .map_err(|_| "El registro de metadatos esta bloqueado".to_string());

    if let Some(process) = process {
        terminate_session_process(&process);
    }

    metadata_result.map(|_| ())
}

#[tauri::command]
fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<SessionInfo, String> {
    let cleaned = name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(80)
        .collect::<String>();
    if cleaned.is_empty() {
        return Err("El nombre de la sesión no puede estar vacío.".to_string());
    }
    let mut metadata = state
        .metadata
        .lock()
        .map_err(|_| "El registro de metadatos está bloqueado".to_string())?;
    let unique = unique_session_name(&metadata, &cleaned, Some(&session_id));
    let session = metadata
        .get_mut(&session_id)
        .ok_or_else(|| "La sesión ya no existe.".to_string())?;
    session.name = unique;
    Ok(session.clone())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("La ruta esta vacia.".to_string());
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.exists() {
        return Err("La ruta ya no existe en este PC.".to_string());
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        if candidate.is_file() {
            command.arg(format!("/select,{}", candidate.to_string_lossy()));
        } else {
            command.arg(candidate.as_os_str());
        }
        command.creation_flags(0x08000000);
        command
            .spawn()
            .map_err(|error| format!("No se pudo abrir Explorer: {error}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if candidate.is_file() {
            command.arg("-R").arg(&candidate);
        } else {
            command.arg(&candidate);
        }
        command
            .spawn()
            .map_err(|error| format!("No se pudo abrir Finder: {error}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(candidate)
            .spawn()
            .map_err(|error| format!("No se pudo abrir el explorador: {error}"))?;
        Ok(())
    }
}

fn get_process(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<SessionProcess>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "El registro de sesiones está bloqueado".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| "La sesión ya no existe".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    fn test_session(name: &str) -> SessionInfo {
        SessionInfo {
            id: format!("test-{name}"),
            name: name.to_string(),
            shell: "PowerShell".to_string(),
            executable: "powershell.exe".to_string(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            pid: None,
            cols: 80,
            rows: 24,
            status: "running".to_string(),
            agent_type: None,
            worktree: None,
            workspace_path: None,
            created_at: "0".to_string(),
        }
    }

    #[test]
    fn session_names_are_unique_without_blocking_rename() {
        let mut metadata = HashMap::new();
        metadata.insert("first".to_string(), test_session("Sky"));
        metadata.insert("second".to_string(), test_session("Sky (2)"));

        assert_eq!(unique_session_name(&metadata, "sky", None), "sky (3)");
        assert_eq!(unique_session_name(&metadata, "Sky", Some("first")), "Sky");
    }

    #[test]
    fn native_shell_answers_through_a_real_pty() {
        let request = CreateSessionRequest {
            name: None,
            cwd: None,
            cols: Some(80),
            rows: Some(12),
            shell: Some(platform_default_shell_id()),
            program: None,
            args: None,
            initial_command: None,
            agent_type: None,
            worktree: None,
            workspace_path: None,
            env: None,
        };
        let shell = resolve_shell(&request).expect("el shell nativo debe resolverse");
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 12,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("el PTY debe abrirse");

        let mut command = CommandBuilder::new(shell.path.as_os_str().to_owned());
        command.args(&shell.args);

        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("el shell debe iniciarse dentro del PTY");
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .expect("el lector del PTY debe estar disponible");
        let mut writer = pair
            .master
            .take_writer()
            .expect("el escritor del PTY debe estar disponible");

        let (sender, receiver) = mpsc::channel();
        let reader_thread = thread::spawn(move || {
            let mut output = String::new();
            let mut buffer = [0_u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        output.push_str(&String::from_utf8_lossy(&buffer[..size]));
                        if output.contains("COMESADE_PTY_OK") {
                            let _ = sender.send(output);
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let marker_command = if shell.label.contains("PowerShell") {
            "Write-Output 'COMESADE_PTY_OK'"
        } else {
            "printf 'COMESADE_PTY_OK\\n'"
        };
        std::thread::sleep(Duration::from_millis(500));
        writer
            .write_all(format!("{marker_command}\r\n").as_bytes())
            .expect("el comando debe escribirse en el PTY");
        writer.flush().expect("el comando debe enviarse al PTY");

        let result = receiver.recv_timeout(Duration::from_secs(15));
        drop(writer);
        drop(pair.master);
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader_thread.join();
        let output = result.expect("el shell debe responder antes de 15 segundos");
        assert!(
            output.contains("COMESADE_PTY_OK"),
            "salida inesperada del PTY: {output}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_process_can_be_closed_before_returning_to_the_app() {
        let request = CreateSessionRequest {
            name: Some("PowerShell lifecycle test".to_string()),
            cwd: None,
            cols: Some(80),
            rows: Some(12),
            shell: Some("powershell".to_string()),
            program: None,
            args: None,
            initial_command: None,
            agent_type: None,
            worktree: None,
            workspace_path: None,
            env: None,
        };
        let Ok(shell) = resolve_shell(&request) else {
            return;
        };
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 12,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("el PTY de PowerShell debe abrirse");
        let mut child = pair
            .slave
            .spawn_command({
                let mut command = CommandBuilder::new(shell.path.as_os_str().to_owned());
                command.args(&shell.args);
                command
            })
            .expect("PowerShell debe iniciarse");
        drop(pair.slave);

        terminate_process_tree(child.process_id(), &mut *child);
        assert!(
            child
                .try_wait()
                .expect("debe poder consultar el proceso de PowerShell")
                .is_some(),
            "PowerShell seguia vivo despues del cierre"
        );
        drop(pair.master);
    }
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Reuse the existing desktop process when the launcher is opened again.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            create_session,
            list_sessions,
            rename_session,
            detect_agents,
            resolve_executable_path,
            detect_shells,
            platform_info,
            workspace_fs::list,
            workspace_fs::read,
            workspace_fs::write,
            workspace_fs::create_file,
            workspace_fs::create_directory,
            workspace_fs::rename,
            workspace_fs::move_path,
            workspace_fs::delete,
            workspace_fs::search,
            git_service::git_availability,
            git_service::install_git,
            git_service::repository_info,
            git_service::status,
            git_service::diff_stats,
            git_service::branches,
            git_service::checkout_branch,
            git_service::diff,
            git_service::file_versions,
            git_service::file_versions_between,
            git_service::stage,
            git_service::unstage,
            git_service::discard,
            git_service::commit,
            git_service::merge_worktree,
            git_service::worktree_list,
            git_service::worktree_create,
            git_service::worktree_remove,
            git_service::clone_repository,
            github_service::github_auth_status,
            github_service::github_oauth_start,
            github_service::github_oauth_poll,
            github_service::github_disconnect,
            github_service::github_repositories,
            github_service::github_clone_repository,
            storage::load_local_state,
            storage::save_local_state,
            watch_workspace,
            unwatch_workspace,
            validate_workspace_path,
            default_workspace_path,
            pick_workspace_path,
            write_to_session,
            interrupt_session,
            resize_session,
            close_session,
            reveal_path,
            open_external_url
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            if let Some(window) = _app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error al construir ComesADE")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                app_handle.state::<AppState>().close_all();
            }
        });
}
