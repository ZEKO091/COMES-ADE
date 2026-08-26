# ComesADE

ComesADE is a desktop ADE and an Agent Super App (ASA) for working with local projects, native shells, CLI agents, Git, worktrees, and real previews on Windows and macOS.

## Location

The project is located at `C:\Users\administrator\Documents\ComesADE`, outside of OneDrive.

## Development

```powershell
npm install
npm start
```

`npm start` runs Vite and Tauri in the background and opens the ComesADE window. To run the build process in the foreground, use:

```powershell
node scripts/tauri.mjs dev --foreground
```

## GitHub Required

ComesADE requires a connected GitHub account before the desktop application can be opened.

The app uses GitHub's real OAuth Device Flow. Each user authorizes their own account, and the credential is stored securely in the operating system's credential store rather than inside the app or GitHub CLI.

Before building, configure the public Client ID of a GitHub App using `VITE_GITHUB_CLIENT_ID`. The GitHub App must have Device Flow enabled, along with Metadata and Contents permissions so that ComesADE can view and clone repositories.

From `Clone repository`, ComesADE retrieves the repositories accessible to the authenticated account using the real GitHub API and clones the selected repository using the user's credential.

## Verification

```powershell
npm run build
cargo check --release --manifest-path src-tauri/Cargo.toml
cargo test --offline --manifest-path src-tauri/Cargo.toml
```

The native tests open the system's default shell inside a PTY, verify real command output, and test Git/worktree and filesystem functionality.

Application metadata, including workspaces, notes, restorable sessions, layout, and configuration, is stored locally in SQLite inside AppData.

Repositories and files remain in their actual locations on disk and are not copied into the application's storage.

The app also checks the remote ComesADE Worker when it starts and every 60 seconds afterward using `GET /health` and `GET /v1` at:

`https://comesade-api.kingfrianfrian16.workers.dev`

This connection is used only for health and readiness checks. Workspaces and notes remain stored locally.

## Packaging

```powershell
npm run tauri build
```

This command is intended for validating the local packaging process. Do not distribute these artifacts unless they are signed.

For a public Windows release, use:

```powershell
npm run build:windows:signed
```

Generated artifacts:

* `src-tauri\target\release\comesade.exe`
* `src-tauri\target\release\bundle\nsis\ComesADE_1.0.0_x64-setup.exe`

On macOS, the distributable package is a zipped `.app`:

```bash
npm run release:macos
```

Generated artifacts:

* `releases/ComesADE-arm64.app.zip`
* `releases/ComesADE-x64.app.zip`

This build must be performed on a Mac or through GitHub Actions. A macOS `.app` cannot be generated from Windows.

The Windows installer remains:

`ComesADE-Setup.exe`

For instructions on preparing a signed, distributable release, see [`docs/RELEASING.md`](docs/RELEASING.md).

Never store certificates, passwords, or private keys inside the project.

To create a signed artifact, use:

```powershell
npm run release:desktop:signed
```

with a properly configured Authenticode certificate.

The local release workflow does not attempt to bypass SmartScreen or modify Windows security permissions.

## Stable Desktop Launcher

To update the application without creating another copy, use the release workflow:

```powershell
npm run release:desktop
```

This workflow always publishes the same launcher to the Desktop:

`ComesADE.exe`

The stable installer is stored at:

`Documents\ComesADE\releases\ComesADE-Setup.exe`

The installer uses the same application identifier and the same per-user installation location, so updates replace the existing ComesADE installation in place.

If ComesADE is currently running, the script stops and asks the user to close it. It does not create a second launcher with a different name.

Each session opens the user's selected native shell inside a visible PTY.

On Windows, ComesADE detects PowerShell and Command Prompt. On macOS, it detects the shell configured by the operating system.

System execution policies are respected. ComesADE does not disable Defender, SmartScreen, or PowerShell security policies.
