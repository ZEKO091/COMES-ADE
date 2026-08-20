use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

const MAX_KEY_BYTES: usize = 200;
const MAX_VALUE_BYTES: usize = 8 * 1024 * 1024;

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No se pudo resolver AppData de ComesADE: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("No se pudo crear el directorio de datos local: {error}"))?;
    Ok(directory.join("comesade.sqlite3"))
}

fn connection(app: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(database_path(app)?)
        .map_err(|error| format!("No se pudo abrir la base SQLite local: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 3000;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS local_state (
                 key TEXT PRIMARY KEY NOT NULL,
                 value TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             );",
        )
        .map_err(|error| format!("No se pudo preparar la base SQLite local: {error}"))?;
    Ok(connection)
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty()
        || key.len() > MAX_KEY_BYTES
        || !key.starts_with("comesade.")
        || key.contains('\r')
        || key.contains('\n')
    {
        return Err("La clave de persistencia local no es valida.".to_string());
    }
    Ok(())
}

fn timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or_default()
}

#[tauri::command]
pub fn load_local_state(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let connection = connection(&app)?;
    let mut statement = connection
        .prepare("SELECT key, value FROM local_state")
        .map_err(|error| format!("No se pudo leer la persistencia local: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("No se pudo consultar la persistencia local: {error}"))?;
    let mut state = HashMap::new();
    for row in rows {
        let (key, value) =
            row.map_err(|error| format!("No se pudo decodificar la persistencia local: {error}"))?;
        state.insert(key, value);
    }
    Ok(state)
}

#[tauri::command]
pub fn save_local_state(app: AppHandle, key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    if value.len() > MAX_VALUE_BYTES {
        return Err("El valor de persistencia local supera el limite permitido.".to_string());
    }
    let connection = connection(&app)?;
    connection
        .execute(
            "INSERT INTO local_state (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, timestamp()],
        )
        .map_err(|error| format!("No se pudo guardar la persistencia local: {error}"))?;
    Ok(())
}
