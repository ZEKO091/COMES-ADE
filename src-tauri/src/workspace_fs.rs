use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use regex::{Regex, RegexBuilder};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub text: String,
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let trimmed = root.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("Workspace path is required.".to_string());
    }
    let path = PathBuf::from(trimmed)
        .canonicalize()
        .map_err(|error| format!("Workspace path is invalid: {error}"))?;
    if !path.is_dir() {
        return Err("Workspace path is not a directory.".to_string());
    }
    Ok(path)
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    #[cfg(windows)]
    {
        let root_text = root
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase();
        let candidate_text = candidate
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        candidate_text == root_text || candidate_text.starts_with(&(root_text + "\\"))
    }

    #[cfg(not(windows))]
    {
        candidate == root || candidate.strip_prefix(root).is_ok()
    }
}

fn contains_symlink_component(root: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let Ok(metadata) = fs::symlink_metadata(&current) else {
            break;
        };
        if metadata.file_type().is_symlink() {
            return true;
        }
    }
    false
}

fn normalize_relative_path(value: &str) -> String {
    if cfg!(windows) {
        value.replace('/', "\\")
    } else {
        value.replace('\\', "/")
    }
}

fn safe_target(
    root: &str,
    relative: &str,
    allow_missing: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(root)?;
    let requested = relative.trim().trim_matches('"');
    let normalized = if Path::new(requested).is_absolute() {
        requested.to_string()
    } else {
        normalize_relative_path(requested)
    };
    let input = PathBuf::from(&normalized);
    let joined = if normalized.is_empty() {
        root.clone()
    } else if input.is_absolute() {
        input
    } else {
        root.join(input)
    };

    if contains_symlink_component(&root, &joined) {
        return Err("Symbolic links are not supported inside workspace operations.".to_string());
    }

    let resolved = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|error| format!("Could not resolve path: {error}"))?
    } else if allow_missing {
        let parent = joined
            .parent()
            .ok_or_else(|| "The requested path has no parent.".to_string())?
            .canonicalize()
            .map_err(|error| format!("Parent directory does not exist: {error}"))?;
        parent.join(
            joined
                .file_name()
                .ok_or_else(|| "The requested path has no name.".to_string())?,
        )
    } else {
        return Err("The requested path does not exist.".to_string());
    };

    if !is_within(&root, &resolved) {
        return Err("The requested path is outside the workspace.".to_string());
    }
    Ok((root, resolved))
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string_lossy().into_owned())
}

fn modified_seconds(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

#[tauri::command]
pub fn list(root: String, relative: Option<String>) -> Result<Vec<FsEntry>, String> {
    let (root, directory) = safe_target(&root, relative.as_deref().unwrap_or(""), false)?;
    if !directory.is_dir() {
        return Err("The requested path is not a directory.".to_string());
    }

    let mut entries = fs::read_dir(&directory)
        .map_err(|error| format!("Could not read directory: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let resolved = path.canonicalize().ok()?;
            if !is_within(&root, &resolved) {
                return None;
            }
            let metadata = fs::metadata(&resolved).ok()?;
            Some(FsEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: relative_path(&root, &resolved),
                kind: if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .to_string(),
                size: metadata.len(),
                modified_at: modified_seconds(&metadata),
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        right.kind.cmp(&left.kind).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
    Ok(entries)
}

#[tauri::command]
pub fn read(root: String, relative: String) -> Result<String, String> {
    let (_, path) = safe_target(&root, &relative, false)?;
    if !path.is_file() {
        return Err("The requested path is not a file.".to_string());
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not inspect file: {error}"))?;
    if metadata.len() > 20 * 1024 * 1024 {
        return Err("The file is larger than the 20 MB editor limit.".to_string());
    }
    fs::read_to_string(&path).map_err(|error| format!("Could not read file: {error}"))
}

#[tauri::command]
pub fn write(root: String, relative: String, content: String) -> Result<(), String> {
    let (_, path) = safe_target(&root, &relative, true)?;
    if path.exists() && !path.is_file() {
        return Err("The target is not a file.".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create parent directory: {error}"))?;
    }
    fs::write(&path, content.as_bytes()).map_err(|error| format!("Could not write file: {error}"))
}

#[tauri::command]
pub fn create_file(root: String, relative: String) -> Result<(), String> {
    let (_, path) = safe_target(&root, &relative, true)?;
    if path.exists() {
        return Err("A file or directory with that name already exists.".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create parent directory: {error}"))?;
    }
    fs::File::create(&path)
        .map(|_| ())
        .map_err(|error| format!("Could not create file: {error}"))
}

#[tauri::command]
pub fn create_directory(root: String, relative: String) -> Result<(), String> {
    let (_, path) = safe_target(&root, &relative, true)?;
    if path.exists() {
        return Err("A file or directory with that name already exists.".to_string());
    }
    fs::create_dir_all(&path).map_err(|error| format!("Could not create directory: {error}"))
}

#[tauri::command]
pub fn rename(root: String, relative: String, new_name: String) -> Result<(), String> {
    let (root, source) = safe_target(&root, &relative, false)?;
    let name = new_name.trim().trim_matches('"');
    if name.is_empty()
        || name.contains('/')
        || name.contains(std::path::MAIN_SEPARATOR)
        || name == "."
        || name == ".."
    {
        return Err("The new name is invalid.".to_string());
    }
    let target = source
        .parent()
        .ok_or_else(|| "The source has no parent directory.".to_string())?
        .join(name);
    if !is_within(&root, &target) {
        return Err("The new path is outside the workspace.".to_string());
    }
    if target.exists() {
        return Err("A file or directory with that name already exists.".to_string());
    }
    fs::rename(&source, &target).map_err(|error| format!("Could not rename path: {error}"))
}

#[tauri::command]
pub fn move_path(root: String, relative: String, destination: String) -> Result<(), String> {
    let (root, source) = safe_target(&root, &relative, false)?;
    let destination = destination.trim().trim_matches('"');
    if destination.is_empty() {
        return Err("The destination is required.".to_string());
    }
    let (_, target) = safe_target(&root.to_string_lossy(), destination, true)?;
    if target.exists() {
        return Err("A file or directory already exists at the destination.".to_string());
    }
    if let Some(parent) = target.parent() {
        if !is_within(&root, parent) || !parent.is_dir() {
            return Err("The destination directory is invalid.".to_string());
        }
    }
    fs::rename(&source, &target).map_err(|error| format!("Could not move path: {error}"))
}

#[tauri::command]
pub fn delete(root: String, relative: String) -> Result<(), String> {
    if relative.trim().is_empty() {
        return Err("The workspace root cannot be deleted.".to_string());
    }
    let (root, path) = safe_target(&root, &relative, false)?;
    if path == root {
        return Err("The workspace root cannot be deleted.".to_string());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|error| format!("Could not delete directory: {error}"))
    } else {
        fs::remove_file(&path).map_err(|error| format!("Could not delete file: {error}"))
    }
}

fn wildcard_match(value: &str, pattern: &str) -> bool {
    let mut value_index = 0;
    let mut pattern_index = 0;
    let mut star_index: Option<usize> = None;
    let mut retry_index = 0;
    let value = value.as_bytes();
    let pattern = pattern.as_bytes();

    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?'
                || pattern[pattern_index].eq_ignore_ascii_case(&value[value_index]))
        {
            value_index += 1;
            pattern_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            pattern_index += 1;
            retry_index = value_index;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            retry_index += 1;
            value_index = retry_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn matches_file_filter(name: &str, filter: &str) -> bool {
    let filters = filter
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    filters.is_empty() || filters.iter().any(|pattern| wildcard_match(name, pattern))
}

fn search_directory(
    root: &Path,
    directory: &Path,
    matcher: &Regex,
    file_filter: Option<&str>,
    results: &mut Vec<SearchMatch>,
) {
    if results.len() >= 500 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        if results.len() >= 500 {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(file_type) = fs::symlink_metadata(&path).map(|metadata| metadata.file_type()) else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if path.is_dir() {
            if matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist") {
                continue;
            }
            search_directory(root, &path, matcher, file_filter, results);
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > 2 * 1024 * 1024 {
            continue;
        }
        if let Some(filter) = file_filter {
            if !matches_file_filter(&name, filter) {
                continue;
            }
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if matcher.is_match(line) {
                results.push(SearchMatch {
                    path: relative_path(root, &path),
                    line: index + 1,
                    text: line.chars().take(400).collect(),
                });
                if results.len() >= 500 {
                    break;
                }
            }
        }
    }
}

#[tauri::command]
pub fn search(
    root: String,
    query: String,
    use_regex: Option<bool>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    file_filter: Option<String>,
) -> Result<Vec<SearchMatch>, String> {
    let root = canonical_root(&root)?;
    let query = query.trim().chars().take(2000).collect::<String>();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut pattern = if use_regex.unwrap_or(false) {
        query
    } else {
        regex::escape(&query)
    };
    if whole_word.unwrap_or(false) {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let matcher = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive.unwrap_or(false))
        .multi_line(true)
        .build()
        .map_err(|error| format!("La expresion de busqueda no es valida: {error}"))?;
    let mut results = Vec::new();
    search_directory(&root, &root, &matcher, file_filter.as_deref(), &mut results);
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{delete, read};
    use std::{fs, path::PathBuf};

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    #[test]
    fn refuses_to_delete_workspace_root() {
        let result = delete(String::new(), String::new());
        assert_eq!(
            result,
            Err("The workspace root cannot be deleted.".to_string())
        );
    }

    #[test]
    fn accepts_windows_style_relative_paths_on_every_platform() {
        let root = std::env::temp_dir().join(format!("comesade-fs-{}", std::process::id()));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("the test directory should be created");
        fs::write(nested.join("file.txt"), "ok").expect("the test file should be written");

        let result = read(
            root.to_string_lossy().into_owned(),
            "nested\\file.txt".to_string(),
        );
        assert_eq!(result.expect("the relative path should resolve"), "ok");

        let _ = fs::remove_dir_all(PathBuf::from(root));
    }

    #[test]
    fn refuses_an_absolute_workspace_root_target() {
        let root = std::env::temp_dir().join(format!("comesade-delete-{}", std::process::id()));
        fs::create_dir_all(&root).expect("the test directory should be created");
        let result = delete(
            root.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
        );
        assert_eq!(
            result,
            Err("The workspace root cannot be deleted.".to_string())
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symbolic_link_targets() {
        let root = std::env::temp_dir().join(format!("comesade-symlink-{}", std::process::id()));
        fs::create_dir_all(&root).expect("the test directory should be created");
        fs::write(root.join("target.txt"), "outside the link")
            .expect("the target should be written");
        symlink(root.join("target.txt"), root.join("link.txt"))
            .expect("the symlink should be created");

        let result = read(root.to_string_lossy().into_owned(), "link.txt".to_string());
        assert_eq!(
            result,
            Err("Symbolic links are not supported inside workspace operations.".to_string())
        );

        let _ = fs::remove_file(root.join("link.txt"));
        let _ = fs::remove_dir_all(root);
    }
}
