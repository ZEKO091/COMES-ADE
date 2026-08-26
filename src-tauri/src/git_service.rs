use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const GIT_CLONE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryInfo {
    pub root: String,
    pub branch: String,
    pub is_repository: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEntry {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub branch: String,
    pub entries: Vec<GitStatusEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktree {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub detached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileVersions {
    pub original: String,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiffStat {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStats {
    pub files_changed: u64,
    pub additions: u64,
    pub deletions: u64,
    pub files: Vec<GitFileDiffStat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitAvailability {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn git_command_name() -> &'static str {
    if cfg!(windows) {
        "git.exe"
    } else {
        "git"
    }
}

fn known_git_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(windows)]
    {
        for variable in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Some(root) = std::env::var_os(variable) {
                let root = PathBuf::from(root);
                paths.push(root.join("Git").join("cmd").join("git.exe"));
                paths.push(root.join("Git").join("bin").join("git.exe"));
                if variable == "LocalAppData" {
                    paths.push(
                        root.join("Programs")
                            .join("Git")
                            .join("cmd")
                            .join("git.exe"),
                    );
                    paths.push(
                        root.join("Programs")
                            .join("Git")
                            .join("bin")
                            .join("git.exe"),
                    );
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    paths.extend([
        PathBuf::from("/usr/bin/git"),
        PathBuf::from("/usr/local/bin/git"),
        PathBuf::from("/opt/homebrew/bin/git"),
    ]);

    paths
}

fn git_executable() -> Result<PathBuf, String> {
    if let Ok(path) = crate::resolve_executable(git_command_name()) {
        return Ok(path);
    }

    for candidate in known_git_paths() {
        if candidate.is_file() {
            return Ok(crate::clean_windows_path(
                candidate.canonicalize().unwrap_or(candidate),
            ));
        }
    }

    Err("Git no esta instalado o no esta disponible en PATH.".to_string())
}

fn configure_command(command: &mut Command) {
    if let Some(path) = crate::augmented_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn clone_output_with_timeout(mut command: Command) -> Result<Output, String> {
    let mut child = command
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("No se pudo iniciar Git clone: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(Output {
                    status,
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                });
            }
            Ok(None) if started.elapsed() >= GIT_CLONE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "Git clone tardo mas de 90 segundos y se detuvo. Comprueba la red e intentalo de nuevo."
                        .to_string(),
                );
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("No se pudo comprobar el estado de Git clone: {error}"));
            }
        }
    }
}

fn git_command() -> Result<Command, String> {
    let mut command = Command::new(git_executable()?);
    configure_command(&mut command);
    Ok(command)
}

fn git_version(executable: &Path) -> Option<String> {
    let mut command = Command::new(executable);
    configure_command(&mut command);
    let output = command.arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

#[cfg(any(windows, target_os = "macos"))]
fn run_install_command(executable: PathBuf, args: &[&str]) -> Result<(), String> {
    let mut command = Command::new(&executable);
    configure_command(&mut command);
    let output = command
        .args(args)
        .output()
        .map_err(|error| format!("No se pudo iniciar el instalador de Git: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!("El instalador {} devolvio un error.", executable.display())
    } else {
        detail
    })
}

#[cfg(any(windows, target_os = "macos"))]
fn install_from_tool(tool: &str, args: &[&str]) -> Result<(), String> {
    let executable = crate::resolve_executable(tool)
        .map_err(|_| format!("No se encontro el instalador {tool}."))?;
    run_install_command(executable, args)
}

#[cfg(any(windows, target_os = "macos"))]
fn verify_installed_git() -> Result<GitAvailability, String> {
    let availability = git_availability();
    if availability.available {
        Ok(availability)
    } else {
        Err("Git no quedo disponible despues de la instalacion. Reinicia ComesADE o completa el instalador del sistema y vuelve a intentarlo.".to_string())
    }
}

#[tauri::command]
pub fn git_availability() -> GitAvailability {
    match git_executable() {
        Ok(path) => {
            let version = git_version(&path);
            GitAvailability {
                available: true,
                path: Some(path.to_string_lossy().into_owned()),
                version,
            }
        }
        Err(_) => GitAvailability {
            available: false,
            path: None,
            version: None,
        },
    }
}

#[tauri::command]
pub fn install_git() -> Result<GitAvailability, String> {
    if git_availability().available {
        return Ok(git_availability());
    }

    #[cfg(windows)]
    {
        if crate::resolve_executable("winget.exe").is_ok() {
            install_from_tool(
                "winget.exe",
                &[
                    "install",
                    "--id",
                    "Git.Git",
                    "--exact",
                    "--source",
                    "winget",
                    "--accept-source-agreements",
                    "--accept-package-agreements",
                ],
            )?;
        } else if crate::resolve_executable("choco.exe").is_ok() {
            install_from_tool("choco.exe", &["install", "git", "-y", "--no-progress"])?;
        } else if crate::resolve_executable("scoop.cmd").is_ok() {
            install_from_tool("scoop.cmd", &["install", "git"])?;
        } else {
            return Err("No se encontro winget, Chocolatey ni Scoop. Instala Git desde https://git-scm.com/download/win y vuelve a intentarlo.".to_string());
        }
    }

    #[cfg(target_os = "macos")]
    {
        if crate::resolve_executable("brew").is_ok() {
            install_from_tool("brew", &["install", "git"])?;
        } else {
            let xcode_select = PathBuf::from("/usr/bin/xcode-select");
            if !xcode_select.is_file() {
                return Err("No se encontro xcode-select. Instala Git o las Command Line Tools de Apple y vuelve a intentarlo.".to_string());
            }
            run_install_command(xcode_select, &["--install"])?;
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        return Err(
            "La instalacion automatica de Git solo esta preparada para Windows y macOS."
                .to_string(),
        );
    }

    verify_installed_git()
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let path = crate::clean_windows_path(
        PathBuf::from(path.trim().trim_matches('"'))
            .canonicalize()
            .map_err(|error| format!("Could not resolve path: {error}"))?,
    );
    if !path.is_dir() {
        return Err("The path is not a directory.".to_string());
    }
    Ok(path)
}

#[cfg(windows)]
fn normalize_git_reported_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim().trim_matches('"');
    let bytes = trimmed.as_bytes();
    if trimmed.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b'/'
    {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let rest = trimmed[3..].replace('/', "\\");
        return PathBuf::from(format!("{drive}:\\{rest}"));
    }
    PathBuf::from(trimmed.replace('/', "\\"))
}

#[cfg(not(windows))]
fn normalize_git_reported_path(raw: &str) -> PathBuf {
    PathBuf::from(raw.trim().trim_matches('"'))
}

fn git_path_from_output(raw: &str) -> Result<PathBuf, String> {
    let candidate = normalize_git_reported_path(raw);
    if candidate.as_os_str().is_empty() {
        return Err("Git no devolvio la raiz del repositorio.".to_string());
    }
    let resolved = candidate.canonicalize().unwrap_or(candidate);
    let cleaned = crate::clean_windows_path(resolved);
    if cleaned.is_dir() {
        Ok(cleaned)
    } else {
        Err(format!(
            "Could not resolve Git root: {}",
            cleaned.display()
        ))
    }
}

fn path_key(value: &Path) -> String {
    let mut key = value.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        if let Some(stripped) = key.strip_prefix("//?/") {
            key = stripped.to_string();
        }
        key = key.trim_end_matches('/').to_ascii_lowercase();
    } else {
        key = if key == "/" {
            key
        } else {
            key.trim_end_matches('/').to_string()
        };
    }
    key
}

fn run_git(root: &Path, args: &[String]) -> Result<Output, String> {
    let cwd = crate::clean_windows_path(root.to_path_buf());
    let mut command = git_command()?;
    command.current_dir(&cwd);
    command.arg("-C").arg(&cwd).args(args);
    command
        .output()
        .map_err(|error| format!("Could not start Git: {error}"))
}

fn output_text(output: &Output) -> Result<String, String> {
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Git returned an error.".to_string()
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn repository_root(path: &str) -> Result<PathBuf, String> {
    let path = canonical_directory(path)?;
    let output = run_git(
        &path,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    )?;
    git_path_from_output(&output_text(&output)?)
}

fn branch(root: &Path) -> String {
    let abbrev = run_git(
        root,
        &[
            "rev-parse".to_string(),
            "--abbrev-ref".to_string(),
            "HEAD".to_string(),
        ],
    );
    if let Ok(output) = abbrev {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() && name != "HEAD" {
                return name;
            }
            if name == "HEAD" {
                if let Ok(short) = run_git(
                    root,
                    &[
                        "rev-parse".to_string(),
                        "--short".to_string(),
                        "HEAD".to_string(),
                    ],
                ) {
                    if short.status.success() {
                        let hash = String::from_utf8_lossy(&short.stdout).trim().to_string();
                        if !hash.is_empty() {
                            return format!("HEAD ({hash})");
                        }
                    }
                }
                return "HEAD".to_string();
            }
        }
    }

    let symbolic = run_git(
        root,
        &[
            "symbolic-ref".to_string(),
            "--quiet".to_string(),
            "--short".to_string(),
            "HEAD".to_string(),
        ],
    );
    if let Ok(output) = symbolic {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }

    "HEAD".to_string()
}

fn safe_relative_path(value: &str) -> Result<String, String> {
    let value = value.trim().trim_matches('"');
    if value.is_empty() {
        return Err("A Git file path is required.".to_string());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("The Git file path must stay inside the repository.".to_string());
    }
    Ok(value.replace('\\', "/"))
}

fn read_head_file(root: &Path, relative: &str) -> Result<String, String> {
    let spec = format!("HEAD:{relative}");
    let output = run_git(root, &["show".to_string(), spec])?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    Ok(String::new())
}

fn read_worktree_file(root: &Path, relative: &str) -> Result<String, String> {
    let path = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !path.exists() {
        return Ok(String::new());
    }
    if !path.is_file() {
        return Err("The selected Git path is not a file.".to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("Could not read the working file: {error}"))
}

fn verify_ref(root: &Path, reference: &str) -> Result<String, String> {
    let reference = reference.trim();
    if reference.is_empty()
        || reference.starts_with('-')
        || reference.contains('\r')
        || reference.contains('\n')
    {
        return Err("The Git reference is invalid.".to_string());
    }
    let output = run_git(
        root,
        &[
            "rev-parse".to_string(),
            "--verify".to_string(),
            reference.to_string(),
        ],
    )?;
    if !output.status.success() {
        return Err(format!("Git reference not found: {reference}"));
    }
    Ok(reference.to_string())
}

fn read_ref_file(root: &Path, reference: &str, relative: &str) -> Result<String, String> {
    let spec = format!("{reference}:{relative}");
    let output = run_git(root, &["show".to_string(), spec])?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    Ok(String::new())
}

#[tauri::command]
pub fn repository_info(path: String) -> Result<GitRepositoryInfo, String> {
    let candidate = canonical_directory(&path)?;
    let output = run_git(
        &candidate,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    );
    match output {
        Ok(output) if output.status.success() => {
            let root = git_path_from_output(&output_text(&output)?)?;
            Ok(GitRepositoryInfo {
                root: root.to_string_lossy().into_owned(),
                branch: branch(&root),
                is_repository: true,
            })
        }
        _ => Ok(GitRepositoryInfo {
            root: candidate.to_string_lossy().into_owned(),
            branch: String::new(),
            is_repository: false,
        }),
    }
}

fn parse_github_full_name(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let rest = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))
        .or_else(|| trimmed.strip_prefix("git@github.com:"));
    let rest = rest?;
    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    if parts.len() >= 2 {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

/// Returns `owner/repo` for the GitHub `origin` remote, or `None` if the folder
/// is not a git repo / has no GitHub origin.
#[tauri::command]
pub fn git_github_remote(path: String) -> Result<Option<String>, String> {
    let candidate = canonical_directory(&path)?;
    let toplevel = run_git(
        &candidate,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    );
    let root = match toplevel {
        Ok(output) if output.status.success() => git_path_from_output(&output_text(&output)?)?,
        _ => return Ok(None),
    };
    let origin = run_git(&root, &["remote".to_string(), "get-url".to_string(), "origin".to_string()]);
    match origin {
        Ok(output) if output.status.success() => {
            let url = output_text(&output)?;
            Ok(parse_github_full_name(&url))
        }
        _ => Ok(None),
    }
}

/// Sets (or adds) `origin` to `https://github.com/{owner}/{repo}.git`.
/// Initializes a git repo in `path` when needed.
#[tauri::command]
pub fn git_set_github_origin(path: String, repository: String) -> Result<String, String> {
    let repository = {
        let trimmed = repository.trim();
        let mut parts = trimmed.split('/');
        let owner = parts.next().unwrap_or("").trim();
        let name = parts.next().unwrap_or("").trim();
        if owner.is_empty()
            || name.is_empty()
            || parts.next().is_some()
            || owner.contains(' ')
            || name.contains(' ')
        {
            return Err("El repositorio de GitHub debe tener el formato owner/repository.".to_string());
        }
        format!("{owner}/{name}")
    };
    let candidate = canonical_directory(&path)?;
    let toplevel = run_git(
        &candidate,
        &["rev-parse".to_string(), "--show-toplevel".to_string()],
    );
    let root = match toplevel {
        Ok(output) if output.status.success() => git_path_from_output(&output_text(&output)?)?,
        _ => {
            output_text(&run_git(&candidate, &["init".to_string()])?)?;
            candidate.clone()
        }
    };
    let url = format!("https://github.com/{repository}.git");
    let existing = run_git(
        &root,
        &[
            "remote".to_string(),
            "get-url".to_string(),
            "origin".to_string(),
        ],
    );
    if existing.as_ref().map(|output| output.status.success()).unwrap_or(false) {
        output_text(&run_git(
            &root,
            &[
                "remote".to_string(),
                "set-url".to_string(),
                "origin".to_string(),
                url,
            ],
        )?)?;
    } else {
        output_text(&run_git(
            &root,
            &[
                "remote".to_string(),
                "add".to_string(),
                "origin".to_string(),
                url,
            ],
        )?)?;
    }
    Ok(repository)
}

fn parse_status_entries(output: &[u8]) -> Vec<GitStatusEntry> {
    let mut records = output
        .split(|value| *value == 0)
        .filter(|record| !record.is_empty());
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let index_status = String::from_utf8_lossy(&record[0..1]).into_owned();
        let worktree_status = String::from_utf8_lossy(&record[1..2]).into_owned();
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        let kind = if index_status == "?" && worktree_status == "?" {
            "untracked"
        } else if index_status == "D" || worktree_status == "D" {
            "deleted"
        } else if index_status == "R" || worktree_status == "R" {
            "renamed"
        } else if index_status == "C" || worktree_status == "C" {
            "copied"
        } else {
            "modified"
        };
        entries.push(GitStatusEntry {
            path,
            index_status: index_status.clone(),
            worktree_status: worktree_status.clone(),
            kind: kind.to_string(),
        });
        if index_status == "R"
            || index_status == "C"
            || worktree_status == "R"
            || worktree_status == "C"
        {
            let _old_path = records.next();
        }
    }
    entries
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatusResult, String> {
    let root = repository_root(&path)?;
    let output = run_git(
        &root,
        &[
            "status".to_string(),
            "--short".to_string(),
            "--untracked-files=all".to_string(),
            "-z".to_string(),
        ],
    )?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let entries = parse_status_entries(&output.stdout);
    Ok(GitStatusResult {
        branch: branch(&root),
        entries,
    })
}

#[tauri::command]
pub fn status(path: String) -> Result<GitStatusResult, String> {
    git_status(path)
}

fn add_numstat(output: &[u8], files: &mut HashMap<String, (u64, u64)>) {
    for line in String::from_utf8_lossy(output).lines() {
        let mut fields = line.splitn(3, '\t');
        let Some(additions_field) = fields.next() else {
            continue;
        };
        let Some(deletions_field) = fields.next() else {
            continue;
        };
        let Some(path) = fields.next() else { continue };
        if files.contains_key(path) {
            continue;
        }
        let additions = additions_field.parse::<u64>().unwrap_or(0);
        let deletions = deletions_field.parse::<u64>().unwrap_or(0);
        files.insert(path.to_string(), (additions, deletions));
    }
}

fn finalize_diff_stats(files: HashMap<String, (u64, u64)>) -> GitDiffStats {
    let mut files: Vec<GitFileDiffStat> = files
        .into_iter()
        .map(|(path, (additions, deletions))| GitFileDiffStat {
            path,
            additions,
            deletions,
        })
        .collect();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let additions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();
    GitDiffStats {
        files_changed: files.len() as u64,
        additions,
        deletions,
        files,
    }
}

#[tauri::command]
pub fn diff_stats(path: String) -> Result<GitDiffStats, String> {
    let root = repository_root(&path)?;
    let status_result = status(root.to_string_lossy().into_owned())?;
    let mut files = HashMap::new();

    let head_diff = run_git(
        &root,
        &[
            "diff".to_string(),
            "--numstat".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
        ],
    )?;
    if head_diff.status.success() {
        add_numstat(&head_diff.stdout, &mut files);
    } else {
        for args in [
            vec![
                "diff".to_string(),
                "--numstat".to_string(),
                "--".to_string(),
            ],
            vec![
                "diff".to_string(),
                "--cached".to_string(),
                "--numstat".to_string(),
                "--".to_string(),
            ],
        ] {
            if let Ok(output) = run_git(&root, &args) {
                add_numstat(&output.stdout, &mut files);
            }
        }
    }

    for entry in status_result
        .entries
        .iter()
        .filter(|entry| entry.index_status == "?" && entry.worktree_status == "?")
    {
        if files.contains_key(&entry.path) {
            continue;
        }
        let file = root.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let additions = fs::read_to_string(file)
            .map(|content| content.lines().count() as u64)
            .unwrap_or(0);
        files.insert(entry.path.clone(), (additions, 0));
    }

    Ok(finalize_diff_stats(files))
}

fn numstat_pair_for_relative(root: &Path, relative: &str) -> (u64, u64) {
    let mut files = HashMap::new();
    for args in [
        vec![
            "diff".to_string(),
            "--numstat".to_string(),
            "HEAD".to_string(),
            "--".to_string(),
            relative.to_string(),
        ],
        vec![
            "diff".to_string(),
            "--numstat".to_string(),
            "--".to_string(),
            relative.to_string(),
        ],
        vec![
            "diff".to_string(),
            "--cached".to_string(),
            "--numstat".to_string(),
            "--".to_string(),
            relative.to_string(),
        ],
    ] {
        if let Ok(output) = run_git(root, &args) {
            if output.status.success() {
                add_numstat(&output.stdout, &mut files);
            }
        }
        if let Some((additions, deletions)) = files.get(relative).copied() {
            return (additions, deletions);
        }
        // git may report path with different separators or rename syntax
        if let Some((_, stats)) = files.iter().find(|(path, _)| {
            path.replace('\\', "/") == relative.replace('\\', "/")
                || path.ends_with(relative)
                || relative.ends_with(path.as_str())
        }) {
            return *stats;
        }
    }

    let status_result = status(root.to_string_lossy().into_owned()).ok();
    let untracked = status_result
        .as_ref()
        .map(|result| {
            result.entries.iter().any(|entry| {
                (entry.path == relative || relative.ends_with(&entry.path) || entry.path.ends_with(relative))
                    && entry.index_status == "?"
                    && entry.worktree_status == "?"
            })
        })
        .unwrap_or(false);
    if untracked {
        let file = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        let additions = fs::read_to_string(file)
            .map(|content| content.lines().count() as u64)
            .unwrap_or(0);
        return (additions, 0);
    }
    (0, 0)
}

/// Real per-file +/- from Git numstat for workspace-relative paths (finds nested repo roots).
#[tauri::command]
pub fn path_diff_stats(workspace: String, relatives: Vec<String>) -> Result<Vec<GitFileDiffStat>, String> {
    let workspace = PathBuf::from(workspace.trim());
    let mut results = Vec::new();
    for relative_raw in relatives {
        let relative_raw = relative_raw.trim().replace('\\', "/");
        if relative_raw.is_empty() {
            continue;
        }
        let absolute = workspace.join(relative_raw.replace('/', std::path::MAIN_SEPARATOR_STR));
        let probe = if absolute.is_file() {
            absolute
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| workspace.clone())
        } else if absolute.is_dir() {
            absolute.clone()
        } else {
            absolute
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| workspace.clone())
        };
        let mut root = match repository_root(probe.to_string_lossy().as_ref()) {
            Ok(root) => root,
            Err(_) => continue,
        };
        let abs_canon = crate::clean_windows_path(
            absolute
                .canonicalize()
                .unwrap_or_else(|_| absolute.clone()),
        );
        root = crate::clean_windows_path(root.canonicalize().unwrap_or(root));
        let Ok(rel_in_repo) = abs_canon.strip_prefix(&root) else {
            continue;
        };
        let rel_in_repo = rel_in_repo.to_string_lossy().replace('\\', "/");
        if rel_in_repo.is_empty() {
            continue;
        }
        let (additions, deletions) = numstat_pair_for_relative(&root, &rel_in_repo);
        results.push(GitFileDiffStat {
            path: relative_raw,
            additions,
            deletions,
        });
    }
    Ok(results)
}

#[tauri::command]
pub fn branches(path: String) -> Result<Vec<GitBranch>, String> {
    let root = repository_root(&path)?;
    let output = run_git(
        &root,
        &[
            "for-each-ref".to_string(),
            "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)".to_string(),
            "refs/heads".to_string(),
        ],
    )?;
    let text = output_text(&output)?;
    let mut result = text
        .split('\n')
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let current = parts
                .next()
                .map(|value| value.trim() == "*")
                .unwrap_or(false);
            let upstream = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            Some(GitBranch {
                name,
                current,
                upstream,
            })
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| {
        right.current.cmp(&left.current).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
    Ok(result)
}

#[tauri::command]
pub fn checkout_branch(path: String, branch_name: String) -> Result<String, String> {
    let root = repository_root(&path)?;
    let branch_name = branch_name.trim();
    if branch_name.is_empty()
        || branch_name.starts_with('-')
        || branch_name.contains('\r')
        || branch_name.contains('\n')
    {
        return Err("The Git branch is invalid.".to_string());
    }
    verify_ref(&root, &format!("refs/heads/{branch_name}"))?;
    output_text(&run_git(
        &root,
        &["checkout".to_string(), branch_name.to_string()],
    )?)
}

#[tauri::command]
pub fn create_branch(path: String, branch_name: String) -> Result<String, String> {
    let root = repository_root(&path)?;
    let branch_name = branch_name.trim();
    if branch_name.is_empty()
        || branch_name.starts_with('-')
        || branch_name.contains('\r')
        || branch_name.contains('\n')
        || branch_name.contains(' ')
    {
        return Err("The Git branch is invalid.".to_string());
    }
    output_text(&run_git(
        &root,
        &[
            "checkout".to_string(),
            "-b".to_string(),
            branch_name.to_string(),
        ],
    )?)
}

#[tauri::command]
pub fn diff(
    path: String,
    staged: Option<bool>,
    relative_paths: Option<Vec<String>>,
) -> Result<String, String> {
    let root = repository_root(&path)?;
    let mut args = vec!["diff".to_string()];
    if staged.unwrap_or(false) {
        args.push("--cached".to_string());
    }
    if let Some(paths) = relative_paths {
        let paths = paths
            .into_iter()
            .filter(|item| !item.trim().is_empty())
            .map(|item| safe_relative_path(&item))
            .collect::<Result<Vec<_>, _>>()?;
        if !paths.is_empty() {
            args.push("--".to_string());
            args.extend(paths);
        }
    }
    output_text(&run_git(&root, &args)?)
}

#[tauri::command]
pub fn file_versions(
    path: String,
    relative: String,
    staged: Option<bool>,
) -> Result<GitFileVersions, String> {
    let root = repository_root(&path)?;
    let relative = safe_relative_path(&relative)?;
    let original = read_head_file(&root, &relative)?;
    let current = if staged.unwrap_or(false) {
        let spec = format!(":{relative}");
        let output = run_git(&root, &["show".to_string(), spec])?;
        if output.status.success() {
            String::from_utf8_lossy(&output.stdout).into_owned()
        } else {
            // The index is authoritative for a staged diff. A staged
            // deletion (or an untracked path) has no index blob and must be
            // represented as empty, rather than falling back to the working
            // tree content.
            String::new()
        }
    } else {
        read_worktree_file(&root, &relative)?
    };
    Ok(GitFileVersions { original, current })
}

#[tauri::command]
pub fn file_versions_between(
    path: String,
    relative: String,
    original_ref: String,
    current_ref: String,
) -> Result<GitFileVersions, String> {
    let root = repository_root(&path)?;
    let relative = safe_relative_path(&relative)?;
    let original_ref = verify_ref(&root, &original_ref)?;
    let current_ref = verify_ref(&root, &current_ref)?;
    Ok(GitFileVersions {
        original: read_ref_file(&root, &original_ref, &relative)?,
        current: read_ref_file(&root, &current_ref, &relative)?,
    })
}

fn path_args(paths: Vec<String>) -> Result<Vec<String>, String> {
    let paths = paths
        .into_iter()
        .filter(|item| !item.trim().is_empty())
        .map(|item| safe_relative_path(&item))
        .collect::<Result<Vec<_>, _>>()?;
    if paths.is_empty() {
        return Err("At least one Git path is required.".to_string());
    }
    let mut args = vec!["--".to_string()];
    args.extend(paths);
    Ok(args)
}

#[tauri::command]
pub fn stage(path: String, paths: Vec<String>) -> Result<(), String> {
    let root = repository_root(&path)?;
    let mut args = vec!["add".to_string()];
    args.extend(path_args(paths)?);
    output_text(&run_git(&root, &args)?).map(|_| ())
}

#[tauri::command]
pub fn unstage(path: String, paths: Vec<String>) -> Result<(), String> {
    let root = repository_root(&path)?;
    let mut args = vec!["restore".to_string(), "--staged".to_string()];
    args.extend(path_args(paths)?);
    output_text(&run_git(&root, &args)?).map(|_| ())
}

#[tauri::command]
pub fn discard(path: String, paths: Vec<String>) -> Result<(), String> {
    let root = repository_root(&path)?;
    let mut args = vec![
        "restore".to_string(),
        "--worktree".to_string(),
        "--staged".to_string(),
    ];
    args.extend(path_args(paths)?);
    output_text(&run_git(&root, &args)?).map(|_| ())
}

#[tauri::command]
pub fn commit(path: String, message: String) -> Result<String, String> {
    let root = repository_root(&path)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("A commit message is required.".to_string());
    }
    output_text(&run_git(
        &root,
        &["commit".to_string(), "-m".to_string(), message.to_string()],
    )?)
}

#[tauri::command]
pub fn merge_worktree(path: String, branch_name: String) -> Result<String, String> {
    let root = repository_root(&path)?;
    let branch_name = branch_name.trim();
    if branch_name.is_empty()
        || branch_name.starts_with('-')
        || branch_name.contains('\r')
        || branch_name.contains('\n')
    {
        return Err("The worktree branch is invalid.".to_string());
    }
    let verified = verify_ref(&root, &format!("refs/heads/{branch_name}"))?;
    let output = run_git(
        &root,
        &["merge".to_string(), "--no-edit".to_string(), verified],
    )?;
    if output.status.success() {
        return output_text(&output);
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{stderr}\n{stdout}")
    })
}

#[tauri::command]
pub fn worktree_list(path: String) -> Result<Vec<GitWorktree>, String> {
    let root = repository_root(&path)?;
    let output = run_git(
        &root,
        &[
            "worktree".to_string(),
            "list".to_string(),
            "--porcelain".to_string(),
        ],
    )?;
    let text = output_text(&output)?;
    let mut result = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("worktree ") {
            if let Some(previous) = current.take() {
                result.push(previous);
            }
            current = Some(GitWorktree {
                path: value.to_string(),
                head: String::new(),
                branch: None,
                detached: false,
            });
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            if let Some(item) = current.as_mut() {
                item.head = value.to_string();
            }
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            if let Some(item) = current.as_mut() {
                item.branch = Some(value.to_string());
            }
        } else if line == "detached" {
            if let Some(item) = current.as_mut() {
                item.detached = true;
            }
        }
    }
    if let Some(item) = current {
        result.push(item);
    }
    Ok(result)
}

#[tauri::command]
pub fn worktree_create(
    path: String,
    worktree_path: String,
    branch_name: String,
    base_branch: Option<String>,
) -> Result<GitWorktree, String> {
    let root = repository_root(&path)?;
    let branch_name = branch_name.trim();
    if branch_name.is_empty() {
        return Err("A worktree branch is required.".to_string());
    }
    output_text(&run_git(
        &root,
        &[
            "check-ref-format".to_string(),
            "--branch".to_string(),
            branch_name.to_string(),
        ],
    )?)?;

    let requested = PathBuf::from(worktree_path.trim().trim_matches('"'));
    let target = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    if target.exists() {
        return Err("The worktree destination already exists.".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create worktree parent: {error}"))?;
    }

    let mut args = vec![
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        branch_name.to_string(),
        target.to_string_lossy().into_owned(),
    ];
    if let Some(base) = base_branch.filter(|value| !value.trim().is_empty()) {
        let base = base.trim();
        if base.contains('\r') || base.contains('\n') || base.starts_with('-') {
            return Err("The base Git branch is invalid.".to_string());
        }
        let verified_base = if base == "HEAD" {
            verify_ref(&root, "HEAD")?
        } else {
            verify_ref(&root, &format!("refs/heads/{base}"))?
        };
        args.push(verified_base);
    }
    output_text(&run_git(&root, &args)?)?;

    let target_key = path_key(&target.canonicalize().unwrap_or_else(|_| target.clone()));
    worktree_list(root.to_string_lossy().into_owned())?
        .into_iter()
        .find(|item| {
            let listed = PathBuf::from(&item.path);
            let listed = listed.canonicalize().unwrap_or(listed);
            path_key(&listed) == target_key
        })
        .ok_or_else(|| "Git created the worktree but it could not be listed.".to_string())
}

#[tauri::command]
pub fn worktree_remove(path: String, worktree_path: String) -> Result<(), String> {
    let root = repository_root(&path)?;
    let target = PathBuf::from(worktree_path.trim().trim_matches('"'));
    if !target.is_absolute() {
        return Err("The worktree path must be absolute.".to_string());
    }
    if path_key(&target.canonicalize().unwrap_or_else(|_| target.clone())) == path_key(&root) {
        return Err("The main worktree cannot be removed.".to_string());
    }
    let listed = worktree_list(root.to_string_lossy().into_owned())?;
    if !listed.iter().any(|item| {
        let listed_path = PathBuf::from(&item.path);
        path_key(&listed_path.canonicalize().unwrap_or(listed_path)) == path_key(&target)
    }) {
        return Err("The selected path is not a worktree of this repository.".to_string());
    }
    output_text(&run_git(
        &root,
        &[
            "worktree".to_string(),
            "remove".to_string(),
            target.to_string_lossy().into_owned(),
        ],
    )?)
    .map(|_| ())
}

#[tauri::command]
pub fn clone_repository(url: String, destination: String) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty() || url.contains('\r') || url.contains('\n') {
        return Err("La URL del repositorio esta vacia o contiene saltos de linea.".to_string());
    }
    let lower_url = url.to_ascii_lowercase();
    let allowed = lower_url.starts_with("https://")
        || lower_url.starts_with("http://")
        || lower_url.starts_with("ssh://")
        || lower_url.starts_with("git@");
    if !allowed {
        return Err("Usa una URL Git https, http, ssh o git@ valida.".to_string());
    }

    let target = crate::clean_windows_path(PathBuf::from(destination.trim().trim_matches('"')));
    if target.as_os_str().is_empty() {
        return Err("El destino del clone es obligatorio.".to_string());
    }
    if target.exists() {
        if !target.is_dir() {
            return Err("El destino del clone ya existe y no es una carpeta.".to_string());
        }
        if fs::read_dir(&target)
            .map_err(|error| format!("No se pudo leer el destino: {error}"))?
            .next()
            .is_some()
        {
            return Err("El destino del clone debe estar vacio.".to_string());
        }
    } else if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("No se pudo crear el destino: {error}"))?;
    }

    let mut command = git_command()?;
    command.arg("clone").arg(url).arg(&target);
    let output = clone_output_with_timeout(command)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Git clone devolvio un error.".to_string()
        } else {
            detail
        });
    }
    let resolved = target.canonicalize().map_err(|error| {
        format!("Git clono el repositorio pero no se pudo resolver la carpeta: {error}")
    })?;
    let output_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if output_text.is_empty() {
        resolved.to_string_lossy().into_owned()
    } else {
        output_text
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_z_status_without_emitting_rename_source_as_a_second_file() {
        let entries = parse_status_entries(
            b" M file with spaces.txt\0R  renamed.txt\0old-name.txt\0?? untracked.txt\0",
        );

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "file with spaces.txt");
        assert_eq!(entries[1].path, "renamed.txt");
        assert_eq!(entries[1].kind, "renamed");
        assert_eq!(entries[2].path, "untracked.txt");
    }

    fn run_test_git(root: &Path, args: &[&str]) -> Result<(), String> {
        let mut command = git_command()?;
        command.arg("-C").arg(root).args(args);
        let output = command
            .output()
            .map_err(|error| format!("Could not start test Git: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(if detail.is_empty() {
                format!("Test Git command failed: {:?}", args)
            } else {
                detail
            })
        }
    }

    #[test]
    fn real_worktree_status_and_merge_flow() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock must be valid")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("comesade-git-{stamp}-{}", std::process::id()));
        let worktree_path =
            std::env::temp_dir().join(format!("comesade-worktree-{stamp}-{}", std::process::id()));
        let result: Result<(), String> = (|| {
            fs::create_dir_all(&root).map_err(|error| error.to_string())?;
            run_test_git(&root, &["init", "-b", "main"])?;
            run_test_git(
                &root,
                &["config", "user.email", "comesade-test@example.invalid"],
            )?;
            run_test_git(&root, &["config", "user.name", "ComesADE Test"])?;
            fs::write(root.join("README.md"), "base\n").map_err(|error| error.to_string())?;
            run_test_git(&root, &["add", "README.md"])?;
            run_test_git(&root, &["commit", "-m", "initial"])?;

            let base = branch(&root);
            assert_eq!(base, "main");
            let branch_name = "agent/comesade-test";
            let created = worktree_create(
                root.to_string_lossy().into_owned(),
                worktree_path.to_string_lossy().into_owned(),
                branch_name.to_string(),
                Some(base),
            )?;
            assert!(Path::new(&created.path).is_dir());

            fs::write(worktree_path.join("README.md"), "agent\n")
                .map_err(|error| error.to_string())?;
            let changed = status(worktree_path.to_string_lossy().into_owned())?;
            assert!(changed
                .entries
                .iter()
                .any(|entry| entry.path == "README.md" && entry.kind == "modified"));
            let stats = diff_stats(worktree_path.to_string_lossy().into_owned())?;
            assert_eq!(stats.files_changed, 1);
            assert_eq!(stats.additions, 1);
            assert_eq!(stats.deletions, 1);
            assert_eq!(stats.files.len(), 1);
            assert_eq!(stats.files[0].path, "README.md");
            assert_eq!(stats.files[0].additions, 1);
            assert_eq!(stats.files[0].deletions, 1);
            let versions = file_versions(
                worktree_path.to_string_lossy().into_owned(),
                "README.md".to_string(),
                Some(false),
            )?;
            assert_eq!(versions.original, "base\n");
            assert_eq!(versions.current.replace("\r\n", "\n"), "agent\n");

            stage(
                worktree_path.to_string_lossy().into_owned(),
                vec!["README.md".to_string()],
            )?;
            commit(
                worktree_path.to_string_lossy().into_owned(),
                "agent change".to_string(),
            )?;
            merge_worktree(root.to_string_lossy().into_owned(), branch_name.to_string())?;
            let merged =
                fs::read_to_string(root.join("README.md")).map_err(|error| error.to_string())?;
            assert_eq!(merged.replace("\r\n", "\n"), "agent\n");
            worktree_remove(
                root.to_string_lossy().into_owned(),
                worktree_path.to_string_lossy().into_owned(),
            )?;
            assert!(!worktree_path.exists());
            Ok(())
        })();

        let _ = fs::remove_dir_all(&worktree_path);
        let _ = fs::remove_dir_all(&root);
        assert!(
            result.is_ok(),
            "real Git integration flow failed: {:?}",
            result.err()
        );
    }
}
