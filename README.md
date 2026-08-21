# ComesADE

ComesADE es un ADE de escritorio y una Agent Super App (ASA) para trabajar con proyectos locales, shells nativos, agentes CLI, Git, worktrees y previews reales en Windows y macOS.

## Ubicación

El proyecto está en `C:\Users\ianda\Documents\ComesADE`, fuera de OneDrive.

## Desarrollo

```powershell
npm install
npm run tauri dev
```

## GitHub requerido

ComesADE requiere una cuenta de GitHub conectada antes de abrir el escritorio.
La app usa OAuth real de GitHub con Device Flow. Cada usuario autoriza su propia
cuenta y la credencial queda en el almacen seguro del sistema, no en la app ni
en GitHub CLI. Configura el Client ID publico de una GitHub App con
`VITE_GITHUB_CLIENT_ID` antes de compilar. La app debe tener habilitado Device
Flow y permisos de Metadata y Contents para consultar y clonar repositorios.
Desde `Clone repository`, ComesADE consulta los repositorios accesibles de la
cuenta mediante la API real de GitHub y clona el repositorio seleccionado usando
la credencial del usuario.

## Verificaciones

```powershell
npm run build
cargo check --release --manifest-path src-tauri/Cargo.toml
cargo test --offline --manifest-path src-tauri/Cargo.toml
```

Las pruebas nativas abren el shell predeterminado dentro de un PTY, verifican salida real y ejercitan Git/worktrees y filesystem.

La metadata de la aplicación (workspaces, notas, sesiones restaurables,
layout y configuración) se guarda localmente en SQLite dentro de AppData.
Los repositorios y archivos siguen siendo los reales del disco; no se copian
al almacenamiento de la aplicación.

La app también verifica el Worker remoto de ComesADE al iniciar y luego cada
60 segundos contra `GET /health` y `GET /v1` en
`https://comesade-api.kingfrianfrian16.workers.dev`. Esa conexión es solo de
salud/ready; workspaces y notas siguen siendo locales.

## Empaquetado

```powershell
npm run tauri build
```

Ese comando sirve para validar el empaquetado local. No distribuyas esos
artefactos sin firma. Para una versión pública de Windows usa:

```powershell
npm run build:windows:signed
```

Artefactos generados:

- `src-tauri\target\release\comesade.exe`
- `src-tauri\target\release\bundle\nsis\ComesADE_1.22.0_x64-setup.exe`

Para preparar una versión distribuible y firmada, consulta
[`docs/RELEASING.md`](docs/RELEASING.md). Nunca guardes certificados,
contraseñas ni claves privadas dentro del proyecto.

Para un artefacto firmado usa \`npm run release:desktop:signed\` con un
certificado Authenticode real configurado. El flujo local no intenta evadir
SmartScreen ni modificar permisos de Windows.

## Launcher estable en el Escritorio

Para actualizar la aplicación sin crear otra copia, usa el flujo de release:

```powershell
npm run release:desktop
```

Ese flujo siempre publica el mismo launcher en el Escritorio:
`ComesADE.exe`. El instalador estable queda en
`Documents\ComesADE\releases\ComesADE-Setup.exe`.
El instalador usa el mismo identificador y la misma instalación por usuario, por lo que una actualización reemplaza ComesADE en su lugar.
Si ComesADE está abierto, el script se detiene y pide cerrarlo; no crea un segundo launcher con otro nombre.

Cada sesión abre el shell nativo seleccionado por el usuario dentro de un
PTY visible. En Windows se detecta PowerShell/cmd y en macOS se detecta el
shell configurado por el sistema. Las políticas de ejecución del sistema se
respetan; la aplicación no desactiva Defender, SmartScreen ni PowerShell.
