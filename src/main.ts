import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview, Webview } from '@tauri-apps/api/webview';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { FitAddon } from '@xterm/addon-fit';
import type { ILink, Terminal } from '@xterm/xterm';
import { FitAddon as FitAddonClass } from '@xterm/addon-fit';
import { Terminal as TerminalClass } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import comesadeLogoUrl from './assets/comesade-logo.png';
import './styles.css';

type SessionInfo = {
  id: string;
  name: string;
  shell: string;
  executable: string;
  cwd: string;
  pid: number | null;
  cols: number;
  rows: number;
  status: string;
  agentType: string | null;
  worktree: string | null;
  workspacePath: string | null;
  createdAt: string;
};

type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
};

type TerminalOutput = { sessionId: string; data: string };
type TerminalExit = { sessionId: string; exitCode: number | null };
type TerminalStatusEvent = { sessionId: string; status: string };
type WorkspaceFileChange = { root: string; kind: string; paths: string[] };
type AgentDefinition = { id: string; name: string; executable: string; path: string | null; installed: boolean; args: string[]; environment: Record<string, string>; detectCommand: string | null };
type CustomAgentDefinition = { id: string; name: string; executable: string; args: string[]; environment: Record<string, string> };
type ShellDefinition = { id: string; name: string; executable: string; path: string | null; installed: boolean; isDefault?: boolean };
type RuntimePlatform = { os: string; defaultShell: string; defaultShellName: string };
type AppUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;
type GithubReleaseAsset = { name: string; browser_download_url: string };
type GithubReleaseUpdate = {
  source: 'github';
  version: string;
  body: string;
  date: string | null;
  downloadUrl: string;
  downloadLabel: string;
  releaseUrl: string;
};
type AvailableAppUpdate = AppUpdate | GithubReleaseUpdate;
type FsEntry = { name: string; path: string; kind: 'file' | 'directory'; size: number; modifiedAt: number | null };
type SearchMatch = { path: string; line: number; text: string };
type GitStatusEntry = { path: string; indexStatus: string; worktreeStatus: string; kind: string };
type GitStatusResult = { branch: string; entries: GitStatusEntry[] };
type GitAvailability = { available: boolean; path: string | null; version: string | null };
type GithubAuthStatus = { connected: boolean; oauthConfigured: boolean; login: string | null; displayName: string | null; avatarUrl: string | null; host: string | null; error: string | null };
type GithubDeviceAuthorization = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };
type GithubOAuthPoll = { status: 'pending' | 'connected' | 'error'; interval: number; auth: GithubAuthStatus | null; error: string | null };
type GithubRepository = {
  id: number;
  name: string;
  fullName: string;
  ownerLogin: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  visibility: string | null;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string | null;
  updatedAt: string | null;
  pushedAt: string | null;
};
type GitWorktree = { path: string; head: string; branch: string | null; detached: boolean };
type GitBranch = { name: string; current: boolean; upstream: string | null };
type GitFileVersions = { original: string; current: string };
type GitDiffStats = { filesChanged: number; additions: number; deletions: number };

type TerminalInstance = {
  terminal: Terminal;
  fit: FitAddon;
  surface: HTMLElement;
  resizeObserver?: ResizeObserver;
  linkProvider?: { dispose(): void };
};

type OpenFileTab = {
  path: string;
  root: string;
  content: string;
  dirty: boolean;
};

type TerminalOutputQueue = {
  data: string;
  frame: number | undefined;
  writing: boolean;
};

type LocalhostPanel = {
  id: string;
  url: string;
  element: HTMLElement;
  frame: HTMLIFrameElement;
};

type BrowserPanel = {
  id: string;
  url: string;
  title: string;
  element: HTMLElement;
  frame: HTMLDivElement;
  webview: Webview | null;
};

const appElement = document.querySelector<HTMLDivElement>('#app');
if (!appElement) throw new Error('No se encontró el contenedor principal.');
const app = appElement;

const icons = {
  add: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 7 5 5-5 5M13 17h6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h6l1.7 2H20v8.5H4z"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h6l1.7 2H20v8.5H4zM12 11v6M9 14h6"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  task: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="12" y2="17"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 3-8 10h6l-1 8 8-10h-6z"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>',
  split: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  splitPane: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="1"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>',
  browser: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2 2.2 3 4.8 3 8s-1 5.8-3 8c-2-2.2-3-4.8-3-8s1-5.8 3-8Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="7" x2="19" y2="7"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="17" x2="19" y2="17"/></svg>',
  panel: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 5v14"/></svg>',
  panelRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M15 5v14"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4L4 9M4 5v4h4M4 13a8 8 0 0 0 14.6 4L20 15m0 4v-4h-4"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  stats: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
  git: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/><path d="M7 9v4a4 4 0 0 0 4 4h4M17 15v-4a4 4 0 0 0-4-4h-2"/></svg>',
  github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-4 1.2-4-2-5.5-2.5M14.5 21v-3.2c0-1 .1-1.4-.5-2.1 2.2-.2 4.5-1.1 4.5-5a3.9 3.9 0 0 0-1-2.7 3.6 3.6 0 0 0-.1-2.7s-.9-.3-3 1a10.3 10.3 0 0 0-5.5 0c-2.1-1.3-3-1-3-1a3.6 3.6 0 0 0-.1 2.7 3.9 3.9 0 0 0-1 2.7c0 3.9 2.3 4.8 4.5 5-.6.6-.6 1.1-.5 2.1V21"/></svg>',
  branch: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  chevronLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 19-7-7 7-7"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8zM7 12h13"/></svg>',
  minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
  maximize: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
  windowClose: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>',
};

/* Gemini UI removed: the ComesADE surface below is the only rendered shell.
  <div class="app-shell">
    <header class="titlebar">
      <div class="titlebar-left">
        <!-- macOS dots -->
        <div class="macos-dots">
          <button class="mac-dot mac-dot-red" id="mac-close" title="Cerrar"></button>
          <button class="mac-dot mac-dot-yellow" id="mac-minimize" title="Minimizar"></button>
          <button class="mac-dot mac-dot-green" id="mac-maximize" title="Maximizar"></button>
        </div>
        
        <div class="brand-container">
          <svg class="brand-logo-svg" viewBox="0 0 24 24" style="width:16px;height:16px;stroke:#e2e8f0;stroke-width:2.2;">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="#e2e8f0" stroke="none"/>
          </svg>
          <span class="brand-text">BridgeMind</span>
          <span class="brand-badge" id="active-agents-badge">1</span>
        </div>

        <button class="titlebar-btn" id="titlebar-layout" title="Ocultar sidebar">${icons.panel}</button>
      </div>

      <!-- Segmented top navigation -->
      <div class="titlebar-nav-segments">
        <button class="nav-segment-btn" id="segment-agent" type="button">Agent</button>
        <button class="nav-segment-btn nav-segment-btn-active" id="segment-code" type="button">Code</button>
        <button class="nav-segment-btn" id="segment-chat" type="button">Chat</button>
      </div>

      <div class="titlebar-right-controls">
        <button class="tidy-btn" id="open-command-palette" type="button">
          ${icons.grid} <span>Tidy</span>
        </button>
        <button class="titlebar-btn" id="titlebar-inspector-toggle" title="Mostrar u ocultar inspector">${icons.panelRight}</button>
      </div>
    </header>

    <div class="bridge-voice-pill">
      <svg viewBox="0 0 24 24" style="width:10px;height:10px;stroke:#fff;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="#fff" stroke="none"/></svg>
      <span>BridgeVoice</span>
    </div>

    <div class="app-body">
      <!-- Left Sidebar -->
      <aside class="sidebar">
        <button class="sidebar-menu-item" id="sidebar-dashboard-btn" type="button">
          <span>Dashboard</span>
          <span class="sidebar-badge-blue">9</span>
        </button>
        <button class="sidebar-menu-item" id="sidebar-routines-btn" type="button">Routines</button>
        <button class="sidebar-menu-item" id="sidebar-plugins-btn" type="button">Plugins</button>
        <button class="sidebar-menu-item" id="sidebar-skills-btn" type="button">Skills</button>

        <div class="sidebar-section-title">
          <span>Workspaces</span>
          <button class="projects-action-btn" id="sidebar-open-workspaces" title="Agregar proyecto" style="width:16px;height:16px;">${icons.add}</button>
        </div>

        <div class="workspaces-tree" id="projects-list">
          <div class="tree-folder" id="project-folder-name">
            <span>∨ <strong id="sidebar-project-label">bridgemind</strong></span>
            <span class="sidebar-badge-gray" id="workspace-total-badge">10</span>
          </div>
          <div class="tree-folder-contents" id="session-list">
            <!-- nested terminals will render here -->
          </div>
        </div>

        <div class="sidebar-footer">
          <div class="footer-row">
            <span>Notch</span>
            <button class="sidebar-badge-gray" id="notch-toggle-btn" style="padding:0 8px;border-radius:4px;cursor:pointer;">Off</button>
          </div>
          <div class="footer-row">
            <span>Credits</span>
            <span class="sidebar-badge-gray" style="padding:0 8px;border-radius:4px;" id="credits-badge">19,396</span>
          </div>

          <div class="footer-user-section">
            <div class="user-info">
              <div class="user-avatar">B</div>
              <div class="user-meta">
                <span class="user-name">Bridgemindapps</span>
                <span class="user-level">ULTRA</span>
              </div>
            </div>
            <div class="user-actions">
              <button class="user-action-btn" id="sidebar-theme-toggle" title="Modo nocturno">🌙</button>
              <button class="user-action-btn" id="sidebar-settings" title="Configuración">${icons.settings}</button>
            </div>
          </div>
        </div>
      </aside>

      <!-- Center Main Workspace -->
      <main class="workspace-main">
        <div class="terminal-tabs-container" id="terminal-tabs">
          <div class="replica-tab">
            <span class="tab-gpt-logo">●</span>
            <span class="tab-title" id="active-tab-title">bridgemind</span>
            <span class="replica-tab-actions">
              <button class="titlebar-btn" id="tab-action-more" style="width:14px;height:14px;">${icons.more}</button>
              <button class="titlebar-btn" id="tab-action-split" style="width:14px;height:14px;">${icons.splitPane}</button>
              <button class="titlebar-btn" id="tab-action-add" style="width:14px;height:14px;">${icons.add}</button>
              <button class="titlebar-btn" id="tab-action-close" style="width:14px;height:14px;">×</button>
            </span>
          </div>
        </div>

        <div class="workspace-views-stack" id="workspace-views-stack">
          <!-- Split terminal container (Chat view) -->
          <div class="workspace-view-panel" id="view-chat-panel">
            <div class="terminal-grid" id="terminal-split-container">
              <div class="terminal-grid-pane" id="split-pane-left">
                <div class="grid-pane-header">
                  <span class="grid-pane-title">Terminal principal</span>
                  <div class="grid-pane-actions">
                    <button class="grid-pane-btn" id="split-pane-btn-left" title="Dividir terminal">${icons.splitPane}</button>
                    <button class="grid-pane-btn" id="close-pane-btn-left" title="Cerrar">×</button>
                  </div>
                </div>
                <div class="terminal-grid-pane-mount" id="terminal-stack"></div>
              </div>
              <div class="terminal-grid-pane" id="split-pane-right">
                <div class="grid-pane-header">
                  <span class="grid-pane-title">Terminal secundaria</span>
                  <div class="grid-pane-actions">
                    <button class="grid-pane-btn" id="split-pane-btn-right" title="Dividir terminal">${icons.splitPane}</button>
                    <button class="grid-pane-btn" id="close-pane-btn-right" title="Cerrar">×</button>
                  </div>
                </div>
                <div class="terminal-grid-pane-mount" id="terminal-mount-right">
                  <div class="dock-empty" style="display:grid;place-items:center;height:100%;color:var(--muted);">
                    <span>›_ Terminal secundaria lista</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <!-- Right File Explorer Inspector -->
      <aside class="workspace-inspector" id="workspace-inspector">
        <div class="inspector-tab-strip">
          <button class="inspector-tab-header-btn inspector-tab-header-btn-active" id="inspector-tab-files" type="button">Archivos</button>
          <button class="inspector-tab-header-btn" id="inspector-tab-tools" type="button">Herramientas</button>
        </div>

        <div class="inspector-view-body">
          <div class="inspector-header-row">
            <span class="inspector-project-title" id="inspector-workspace-title">bridgemind</span>
            <div class="inspector-header-actions">
              <button class="inspector-action-btn" id="inspector-view-sort" title="Vista">${icons.list}</button>
              <button class="inspector-action-btn" id="files-refresh" title="Actualizar">${icons.refresh}</button>
              <button class="inspector-action-btn" id="inspector-more" title="Más opciones">${icons.more}</button>
            </div>
          </div>

          <div class="inspector-segmented-control">
            <button class="inspector-segment-btn inspector-segment-btn-active" id="filter-names-btn">Nombres</button>
            <button class="inspector-segment-btn" id="filter-content-btn">Contenido</button>
          </div>

          <div class="file-list-tree" id="file-tree">
            <!-- File tree elements render here -->
          </div>

          <button class="floating-action-button-right" id="floating-layout-toggle" title="Layout">${icons.panelRight}</button>
        </div>
      </aside>
    </div>

    <!-- Bottom status bar -->
    <footer class="statusbar">
      <div class="statusbar-left-group">
        <span class="statusbar-pill">${icons.sparkle}</span>
        <span class="statusbar-pill"><span id="connection-state">Actualizando inicio de sesión</span></span>
        <span class="statusbar-pill">${icons.user}</span>
        <span class="statusbar-pill"><span id="runtime-usage-metric">27% usado 19h 26m</span></span>
        <span class="statusbar-pill"><button id="refresh-workspace-btn" class="titlebar-btn" style="height:18px;font-size:10.5px;color:var(--muted);">Refresh workspace ↻</button></span>
      </div>
      <div class="statusbar-right-group">
        <span class="statusbar-pill">☕ Off <span class="statusbar-green-dot"></span></span>
        <span class="statusbar-pill"><span id="memory-metric">647.7 MB</span></span>
        <span class="statusbar-pill">›_ <span id="active-terminal-count">2</span></span>
        <span class="statusbar-pill">⚙ 0</span>
      </div>
    </footer>
  </div>
  <div id="modal-root"></div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
*/

function renderComesadeLegacyReference(): void {
  app.innerHTML = [
    "<div class='app-shell'>",
    "  <header class='titlebar'>",
    "    <div class='titlebar-left'><div class='window-controls' aria-label='Controles de ventana'><button class='window-control window-control-close' id='close-window' type='button' title='Cerrar ComesADE' aria-label='Cerrar ComesADE'></button><button class='window-control window-control-minimize' id='minimize-window' type='button' title='Minimizar' aria-label='Minimizar'></button><button class='window-control window-control-maximize' id='maximize-window' type='button' title='Maximizar o restaurar' aria-label='Maximizar o restaurar'></button></div><button class='titlebar-btn' id='titlebar-layout' type='button' title='Mostrar u ocultar la barra lateral'>☰</button><button class='titlebar-brand-button' id='titlebar-more' type='button' title='Cambiar workspace'><span class='brand-mark'>C</span><span class='brand-lockup'><strong>ComesADE</strong><small>ADE · ASA</small></span></button></div>",
    "    <nav class='titlebar-nav' aria-label='Modo de trabajo'><button class='titlebar-nav-item is-active' data-view='overview' type='button'><span>ADE</span><small>Workspace</small></button><button class='titlebar-nav-item' data-view='asa' type='button'><span>ASA</span><small>Agents</small></button><button class='titlebar-nav-item' data-view='terminals' type='button'><span>Terminal</span><small>Shells</small></button><button class='titlebar-nav-item' data-view='tools' type='button'><span>Tools</span><small>Preview</small></button></nav>",
    "    <div class='titlebar-right-controls'><button class='titlebar-btn' id='titlebar-back' type='button' title='Vista anterior'>‹</button><button class='titlebar-btn' id='titlebar-forward' type='button' title='Vista siguiente'>›</button><button class='command-palette-button' id='open-command-palette' type='button'><span>Buscar</span><kbd>Ctrl K</kbd></button><button class='titlebar-btn' id='titlebar-inspector-toggle' type='button' title='Mostrar u ocultar inspector'>▣</button></div>",
    "  </header>",
    "  <div class='app-body'>",
    "    <nav class='activity-rail' id='activity-rail' aria-label='Atajos del workspace'><button class='activity-rail-item is-active' data-view='overview' type='button' title='Workspace' aria-label='Workspace'>▦</button><button class='activity-rail-item' data-view='asa' type='button' title='Agentes' aria-label='Agentes'>✦</button><button class='activity-rail-item' data-view='terminals' type='button' title='Terminales' aria-label='Terminales'>›_</button><button class='activity-rail-item' data-view='tools' type='button' title='Herramientas' aria-label='Herramientas'>◎</button><span class='activity-rail-spacer'></span><button class='activity-rail-item' id='rail-settings' type='button' title='Configuración' aria-label='Configuración'>⚙</button></nav>",
    "    <aside class='sidebar' aria-label='Navegación principal'><div class='sidebar-identity'><span class='sidebar-kicker'>LOCAL DESKTOP</span><span class='product-badge'>ADE / ASA</span></div><div class='sidebar-section-label'>Producto</div><nav class='sidebar-nav' aria-label='Producto'><button class='sidebar-nav-item is-active' data-view='overview' type='button'><span class='nav-glyph'>▦</span><span><strong>ADE</strong><small>Workspace</small></span></button><button class='sidebar-nav-item' data-view='asa' type='button'><span class='nav-glyph'>✦</span><span><strong>ASA</strong><small>Agentes y sesiones</small></span></button><button class='sidebar-nav-item' data-view='terminals' type='button'><span class='nav-glyph'>›_</span><span><strong>Terminal</strong><small>Shells locales</small></span></button><button class='sidebar-nav-item' data-view='tools' type='button'><span class='nav-glyph'>◎</span><span><strong>Tools</strong><small>Browser y preview</small></span></button></nav>",
    "      <div class='sidebar-section-title'><span>Workspaces</span><button class='icon-button' id='sidebar-open-workspaces' type='button' title='Abrir workspace'>+</button></div><button class='active-workspace-card' id='active-workspace-card' type='button'><span class='workspace-card-icon'>□</span><span class='workspace-card-copy'><strong id='active-workspace-name'>Sin workspace</strong><small id='active-workspace-path'>Crea o abre una carpeta</small></span><span class='workspace-card-chevron'>›</span></button><div class='sidebar-project-empty' id='sidebar-project-empty' hidden><span>□</span><strong>Sin workspace</strong><small>Abre una carpeta local para empezar.</small></div>",
    "      <div class='sidebar-workspace-heading'><span id='sidebar-project-label'>Workspace</span><button class='icon-button' id='sidebar-filter-btn' type='button' title='Filtros: todas las sesiones'>≡</button></div><div class='session-list' id='session-list'></div><div class='sidebar-session-actions'><input class='sidebar-search-input' id='sidebar-search-input' type='search' placeholder='Filtrar sesiones' aria-label='Filtrar sesiones' /><button class='secondary-button sidebar-new-session' id='sidebar-new-session' type='button'>+<span>Nueva sesión</span></button></div>",
    "      <div class='sidebar-spacer'></div><div class='sidebar-footer'><button class='sidebar-runtime-button' id='sidebar-runtime' type='button'><span class='status-dot'></span><span><strong>Runtime local</strong><small id='connection-state'>LOCAL / STARTING</small></span></button><div class='sidebar-footer-actions'><button class='icon-button' id='sidebar-help' type='button' title='Ayuda'>?</button><button class='icon-button' id='sidebar-feedback' type='button' title='Comentarios'>…</button><button class='icon-button' id='sidebar-stats' type='button' title='Estadísticas'>▥</button><button class='icon-button' id='sidebar-settings' type='button' title='Configuración'>⚙</button></div><div class='sidebar-version'><span>COMESADE</span><span id='app-version-label'>1.21.0</span></div></div><div class='sidebar-resizer' id='sidebar-resizer' aria-hidden='true'></div>",
    "    </aside>",
    "    <main class='workspace-main view-overview'><header class='workspace-header'><div class='workspace-header-copy'><span class='eyebrow'>ADE / LOCAL WORKSPACE</span><h1 id='workspace-heading'>Sin workspace seleccionado</h1><p id='workspace-header-path'>Crea o abre un workspace para comenzar.</p></div><div class='workspace-header-actions'><button class='header-button' id='open-workspace-menu' type='button'>Workspace</button><button class='header-button' id='open-browser-menu' type='button'>Browser</button><button class='header-button header-button-primary' id='header-new-session' type='button'>+<span>Nueva sesión</span></button></div></header>",
    "      <div class='workspace-views-stack' id='workspace-views-stack'>",
    "        <section class='workspace-overview' id='workspace-overview'><section class='workspace-lock panel' id='workspace-lock' hidden><span class='workspace-lock-icon'>□</span><span class='eyebrow'>ADE / WORKSPACE REQUIRED</span><h2>Abre un workspace real</h2><p>Crea o abre una carpeta local para conectar archivos, terminales, Git y agentes.</p><div class='workspace-lock-actions'><button class='secondary-button' id='workspace-lock-open' type='button'>Abrir workspace</button><button class='primary-button' id='workspace-lock-create' type='button'>Crear workspace</button></div></section><div class='workspace-grid'><section class='panel workspace-summary-panel'><header class='panel-header'><div><span class='eyebrow'>ADE / WORKSPACE</span><h2>Proyecto local</h2></div><button class='icon-button' id='workspace-context-session' type='button' title='Abrir una sesión real'>+</button></header><div class='workspace-summary-identity'><span class='summary-project-icon'>□</span><div><strong id='workspace-summary-name'>Sin workspace</strong><small id='workspace-summary-path'>Crea o abre una carpeta para comenzar.</small></div></div><div class='summary-metrics'><button class='summary-metric' id='summary-sessions' type='button'><span>Sesiones</span><strong id='overview-session-count'>0</strong><small id='overview-active-label'>READY</small></button><button class='summary-metric' id='summary-runtime' type='button'><span>Runtime</span><strong id='overview-runtime-status'>LOCKED</strong><small id='overview-shell'>Sin shell</small></button><button class='summary-metric' id='summary-shell' type='button'><span>Directorio</span><strong id='overview-path-short'>—</strong><small id='overview-path-detail'>Sin workspace</small></button></div><div class='panel-actions'><button class='secondary-button' id='workspace-summary-browser' type='button'>Abrir preview</button><button class='secondary-button' id='workspace-summary-agent' type='button'>Nuevo agente</button></div></section><section class='panel notes-panel'><header class='panel-header'><div><span class='eyebrow'>WORKSPACE NOTES</span><h2>Notas rápidas</h2></div><span class='panel-state' id='notes-status'>LOCKED</span></header><textarea id='notes-input' placeholder='Decisiones, comandos o contexto de este proyecto…' aria-label='Notas del workspace'></textarea><small class='panel-hint'>Se guardan localmente por workspace.</small></section></div></section>",
    "        <section class='asa-overview' id='asa-overview'><header class='asa-header'><div><span class='eyebrow'>ASA / AGENT SUPER APP</span><h2>Agentes y sesiones</h2><p>Orquesta CLIs reales dentro de tu workspace, con terminales y worktrees conectados.</p></div><div class='asa-header-actions'><button class='secondary-button' id='asa-new-terminal' type='button'>Nueva terminal</button><button class='primary-button' id='asa-new-agent' type='button'>Nuevo agente</button></div></header><div class='asa-facts'><div><span>AGENTES ACTIVOS</span><strong id='asa-live-agents'>0</strong></div><div><span>AGENTES INSTALADOS</span><strong id='asa-installed-agents'>0</strong></div><div><span>WORKTREES ACTIVOS</span><strong id='asa-worktrees'>0</strong></div><div><span>RUNTIME</span><strong id='asa-runtime-status'>LOCKED</strong></div></div><section class='panel asa-sessions-panel'><header class='panel-header'><div><span class='eyebrow'>LIVE CONTEXT</span><h3>Procesos conectados</h3></div><span class='panel-state'>REAL / LOCAL</span></header><div class='asa-session-list' id='asa-session-list'></div></section></section>",
    "        <section class='tools-view' id='tools-view'><header class='tools-header'><div><span class='eyebrow'>TOOLS / LOCAL PREVIEW</span><h2>Browser y previews</h2><p>Conecta navegadores y servidores locales reales sin salir del workspace.</p></div><div class='tools-header-actions'><button class='secondary-button' id='tools-new-localhost' type='button'>Open localhost</button><button class='primary-button' id='tools-new-browser' type='button'>Open browser</button></div></header><div class='tool-tabs' id='tool-tabs'></div><div class='tool-stage' id='tool-stage'><div class='tool-empty' id='tool-empty'><span class='tool-empty-icon'>◎</span><strong>No hay previews abiertos</strong><small>Abre un navegador o un localhost real.</small><button class='secondary-button' id='tool-empty-open' type='button'>Open browser</button></div></div></section>",
    "        <section class='terminal-area' id='terminal-area'><header class='terminal-area-header'><div><span class='eyebrow'>ADE / REAL SHELL · PTY</span><h2>Terminal sessions</h2><small id='active-session-label'>Sin sesión activa</small></div><button class='primary-button' id='terminal-new' type='button'>+<span>Nueva terminal</span></button></header><div class='endpoint-strip' id='endpoint-strip' hidden></div><div class='terminal-tabs' id='terminal-tabs'></div><div class='terminal-stack' id='terminal-stack'></div><div class='terminal-empty' id='terminal-empty'><span>›_</span><strong>No hay terminales abiertas</strong><small id='terminal-empty-copy'>Abre un shell real cuando lo necesites.</small><button class='secondary-button' id='terminal-empty-new' type='button'>Nueva terminal</button></div><div class='terminal-splitter' id='terminal-splitter' role='separator' aria-label='Redimensionar terminal'></div><form class='command-form' id='command-form'><button class='command-cwd' id='command-cwd' type='button' title='Abrir carpeta en el explorador'><span id='command-cwd-label'>Sin directorio activo</span>›</button><input class='command-input' id='command-input' type='text' placeholder='Escribe un comando para el shell real…' autocomplete='off' /><span class='command-live' id='command-live'>WAITING</span><button class='command-submit primary-button' type='submit'>Run</button></form></section>",
    "      </div></main>",
    "    <aside class='workspace-inspector' id='workspace-inspector' aria-label='Inspector del workspace'><div class='inspector-tab-strip' role='tablist' aria-label='Inspector'><button class='inspector-tab-header-btn inspector-tab-active' data-inspector-tab='explorer' type='button' role='tab' aria-selected='true'>Archivos</button><button class='inspector-tab-header-btn' data-inspector-tab='overview' type='button' role='tab' aria-selected='false'>Resumen</button><button class='inspector-tab-header-btn' data-inspector-tab='git' type='button' role='tab' aria-selected='false'>Git</button><button class='inspector-tab-header-btn' data-inspector-tab='sessions' type='button' role='tab' aria-selected='false'>Sesiones</button></div><div class='inspector-view-body'><div class='inspector-empty' id='workspace-inspector-empty'><span>□</span><strong>Sin workspace</strong><small>Abre una carpeta para explorar sus archivos.</small></div><div class='inspector-file-pane' id='workspace-file-explorer'><div class='inspector-header-row'><div><span class='eyebrow'>EXPLORER</span><strong id='inspector-workspace-title'>Workspace</strong><small id='file-tree-path'>WORKSPACE</small></div><div class='inspector-header-actions'><button class='icon-button' id='inspector-view-sort' type='button' title='Ordenar archivos'>↕</button><button class='icon-button' id='files-refresh' type='button' title='Actualizar archivos'>↻</button><button class='icon-button' id='inspector-more' type='button' title='Más opciones'>…</button></div></div><input class='field-input inspector-search-input' id='inspector-search-input' type='search' placeholder='Buscar archivos' aria-label='Buscar archivos' /><div class='inspector-segmented-control'><button class='inspector-segment-btn segmented-item-active' id='filter-names-btn' type='button'>Nombres</button><button class='inspector-segment-btn' id='filter-content-btn' type='button'>Contenido</button></div><div class='file-list-tree' id='file-tree'></div><div class='inspector-file-actions'><button class='secondary-button' id='floating-layout-toggle' type='button'>Inspector</button></div></div><section class='inspector-compat-pane' id='inspector-overview-pane' hidden><span class='eyebrow'>WORKSPACE</span><strong id='inspector-overview-name'>Sin workspace</strong><small id='inspector-overview-path'>Crea o abre un workspace.</small><div class='inspector-overview-facts'><span><b id='inspector-overview-sessions'>0</b> sesiones</span><span><b id='inspector-overview-runtime'>LOCKED</b></span></div></section><section class='inspector-compat-pane' id='inspector-git-pane' hidden><div class='inspector-pane-heading'><div><span class='eyebrow'>GIT STATUS</span><strong id='inspector-git-branch'>NO REPOSITORY</strong></div><button class='icon-button' id='inspector-git-refresh' type='button' title='Actualizar Git'>↻</button></div><div id='inspector-git-content' class='inspector-compat-list'></div></section><section class='inspector-compat-pane' id='inspector-sessions-pane' hidden><div class='inspector-pane-heading'><div><span class='eyebrow'>RUNTIME</span><strong>Sesiones abiertas</strong></div><span class='panel-state' id='inspector-session-count'>0</span></div><div id='inspector-sessions-list' class='inspector-compat-list'></div></section></div></aside>",
    "  </div>",
    "  <footer class='statusbar'><div class='statusbar-left-group'><span class='statusbar-pill'><span class='status-dot'></span><span>LOCAL</span></span><span class='statusbar-pill' id='runtime-usage-metric'>PTY / READY</span></div><div class='statusbar-right-group'><button class='statusbar-action' id='refresh-workspace-btn' type='button' title='Actualizar sesiones, archivos y Git'>↻<span>Refresh</span></button><span class='statusbar-pill'><span id='memory-metric'>—</span></span><span class='statusbar-pill'>›_ <span id='active-terminal-count'>0</span></span></div></footer>",
    "</div><div id='modal-root'></div><div id='toast' class='toast' role='status' aria-live='polite'></div>"
  ].join('');
  const legacyBrandMark = app.querySelector<HTMLElement>('.titlebar-brand-button .brand-mark');
  if (legacyBrandMark) {
    legacyBrandMark.innerHTML = `<img src="${comesadeLogoUrl}" alt="" aria-hidden="true" />`;
  }
}

function renderComesadeSurface(): void {
  app.innerHTML = `
    <div class="app-shell">
      <header class="titlebar">
        <div class="titlebar-left">
          <div class="titlebar-window-slot titlebar-window-slot-left" id="titlebar-window-slot-left"></div>
          <button class="titlebar-btn titlebar-menu-btn" id="titlebar-layout" type="button" title="Ocultar la barra lateral" aria-label="Ocultar la barra lateral" aria-expanded="true" aria-controls="app-body">${icons.menu}</button>
          <button class="titlebar-brand-button" id="titlebar-more" type="button" title="Cambiar workspace">
            <span class="brand-mark"><img src="${comesadeLogoUrl}" alt="" aria-hidden="true" /></span>
            <span class="brand-lockup">
              <strong>ComesADE</strong>
              <small>Local workspace</small>
            </span>
          </button>
        </div>
        <div class="titlebar-right-controls">
          <button class="titlebar-btn" id="titlebar-back" type="button" title="Vista anterior">‹</button>
          <button class="titlebar-btn" id="titlebar-forward" type="button" title="Vista siguiente">›</button>
          <button class="command-palette-button" id="open-command-palette" type="button">
            <span>Buscar</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button class="titlebar-btn titlebar-update" id="titlebar-update" type="button" title="Hay una actualización disponible" hidden>
            ${icons.download}<span>Actualizar</span>
          </button>
          <button class="titlebar-btn" id="titlebar-inspector-toggle" type="button" title="Mostrar u ocultar inspector">▣</button>
          <div class="titlebar-window-slot titlebar-window-slot-right" id="titlebar-window-slot-right"></div>
        </div>
      </header>

      <div class="app-body" id="app-body">
        <aside class="sidebar" aria-label="Navegación principal">
          <div class="sidebar-identity">
            <strong>Workspaces</strong>
            <small>Desktop local-first</small>
          </div>

          <button class="sidebar-github-card" id="github-account-card" type="button" aria-label="Abrir repositorios de GitHub" aria-live="polite">
            <span class="github-account-icon">${icons.github}</span>
            <span class="github-account-copy"><strong id="github-account-label">GitHub</strong><small id="github-account-status">Comprobando conexiÃ³n...</small></span>
            <span class="github-account-dot" id="github-account-dot"></span>
          </button>

          <nav class="sidebar-nav" aria-label="Vistas principales">
            <button class="sidebar-nav-item is-active" data-view="overview" type="button">
              <span class="nav-glyph">▦</span>
              <span><strong>Workspace</strong><small>Resumen y notas</small></span>
            </button>
            <button class="sidebar-nav-item" data-view="asa" type="button">
              <span class="nav-glyph">✦</span>
              <span><strong>Agents</strong><small>Sesiones y worktrees</small></span>
            </button>
            <button class="sidebar-nav-item" data-view="terminals" type="button">
              <span class="nav-glyph">›_</span>
              <span><strong>Terminal</strong><small>Shells reales</small></span>
            </button>
            <button class="sidebar-nav-item" data-view="tools" type="button">
              <span class="nav-glyph">◎</span>
              <span><strong>Browser</strong><small>Preview integrado</small></span>
            </button>
            <button class="sidebar-nav-item" id="sidebar-search" type="button">
              <span class="nav-glyph">⌕</span>
              <span><strong>Buscar</strong><small>Proyecto y archivos</small></span>
            </button>
          </nav>

          <div class="sidebar-section-title">
            <span>Workspace actual</span>
            <button class="icon-button" id="sidebar-open-workspaces" type="button" title="Abrir workspace">+</button>
          </div>

          <button class="active-workspace-card" id="active-workspace-card" type="button">
            <span class="workspace-card-icon">□</span>
            <span class="workspace-card-copy">
              <strong id="active-workspace-name">Sin workspace</strong>
              <small id="active-workspace-path">Abre una carpeta local</small>
            </span>
            <span class="workspace-card-chevron">›</span>
          </button>

          <div class="sidebar-project-empty" id="sidebar-project-empty" hidden>
            <span>□</span>
            <strong>Sin workspace</strong>
            <small>Abre una carpeta para empezar.</small>
          </div>

          <div class="sidebar-workspace-heading">
            <span id="sidebar-project-label">Sesiones</span>
            <button class="icon-button" id="sidebar-filter-btn" type="button" title="Filtros: todas las sesiones">≡</button>
          </div>
          <div class="session-list" id="session-list"></div>

          <div class="sidebar-session-actions">
            <input class="sidebar-search-input" id="sidebar-search-input" type="search" placeholder="Filtrar sesiones" aria-label="Filtrar sesiones" />
            <button class="secondary-button sidebar-new-session" id="sidebar-new-session" type="button">+<span>Nueva sesión</span></button>
          </div>

          <div class="sidebar-spacer"></div>

          <div class="sidebar-footer">
            <button class="sidebar-runtime-button" id="sidebar-runtime" type="button">
              <span class="status-dot"></span>
              <span><strong>Runtime local</strong><small id="connection-state">LOCAL / STARTING</small></span>
            </button>
            <div class="sidebar-footer-actions">
              <button class="icon-button sidebar-refresh-action" id="refresh-workspace-btn" type="button" title="Actualizar sesiones, archivos y Git" aria-label="Actualizar sesiones, archivos y Git">${icons.refresh}</button>
            </div>
            <div class="sidebar-version"><span>COMESADE</span><span id="app-version-label">1.21.0</span></div>
          </div>
          <div class="sidebar-resizer" id="sidebar-resizer" aria-hidden="true"></div>
        </aside>

        <main class="workspace-main view-overview">
          <header class="workspace-header">
            <div class="workspace-header-copy">
              <span class="eyebrow">LOCAL WORKSPACE</span>
              <h1 id="workspace-heading">Sin workspace seleccionado</h1>
              <p id="workspace-header-path">Abre una carpeta local para empezar.</p>
            </div>
            <div class="workspace-header-actions">
              <button class="header-button" id="open-workspace-menu" type="button">Workspace</button>
              <button class="header-button" id="open-browser-menu" type="button">Browser</button>
              <button class="header-button header-button-agent" id="header-new-agent" type="button">Nuevo agente</button>
              <button class="header-button header-button-primary" id="header-new-session" type="button">Nueva sesión</button>
            </div>
          </header>

          <div class="workspace-views-stack" id="workspace-views-stack">
            <section class="workspace-overview" id="workspace-overview">
              <section class="workspace-lock panel" id="workspace-lock" hidden>
                <span class="workspace-lock-icon">□</span>
                <span class="eyebrow">WORKSPACE REQUIRED</span>
                <h2>Abre un workspace real</h2>
                <p>Conecta archivos, terminales, Git y previews desde una carpeta local.</p>
                <div class="workspace-lock-actions">
                  <button class="secondary-button" id="workspace-lock-open" type="button">Abrir workspace</button>
                  <button class="primary-button" id="workspace-lock-create" type="button">Crear workspace</button>
                </div>
              </section>

              <div class="workspace-grid">
                <section class="panel workspace-summary-panel">
                  <header class="panel-header">
                    <div>
                      <span class="eyebrow">WORKSPACE</span>
                      <h2>Proyecto local</h2>
                    </div>
                    <button class="icon-button" id="workspace-context-session" type="button" title="Abrir una sesión real">+</button>
                  </header>

                  <div class="workspace-summary-identity">
                    <span class="summary-project-icon">□</span>
                    <div>
                      <strong id="workspace-summary-name">Sin workspace</strong>
                      <small id="workspace-summary-path">Abre o crea una carpeta para comenzar.</small>
                    </div>
                  </div>

                  <div class="summary-metrics">
                    <button class="summary-metric" id="summary-sessions" type="button">
                      <span>Sesiones</span>
                      <strong id="overview-session-count">0</strong>
                      <small id="overview-active-label">READY</small>
                    </button>
                    <button class="summary-metric" id="summary-runtime" type="button">
                      <span>Runtime</span>
                      <strong id="overview-runtime-status">LOCKED</strong>
                      <small id="overview-shell">Sin shell</small>
                    </button>
                    <button class="summary-metric" id="summary-shell" type="button">
                      <span>Path</span>
                      <strong id="overview-path-short">—</strong>
                      <small id="overview-path-detail">Sin workspace</small>
                    </button>
                  </div>

                  <div class="panel-actions">
                    <button class="secondary-button" id="workspace-summary-browser" type="button">Abrir browser</button>
                    <button class="secondary-button" id="workspace-summary-agent" type="button">Nuevo agente</button>
                  </div>
                </section>

                <section class="panel notes-panel">
                  <header class="panel-header">
                    <div>
                      <span class="eyebrow">NOTES</span>
                      <h2>Notas rápidas</h2>
                    </div>
                    <span class="panel-state" id="notes-status">LOCKED</span>
                  </header>
                  <textarea id="notes-input" placeholder="Decisiones, comandos o contexto de este proyecto..." aria-label="Notas del workspace"></textarea>
                  <small class="panel-hint">Se guardan localmente por workspace.</small>
                </section>
              </div>
            </section>

            <section class="asa-overview" id="asa-overview">
              <header class="asa-header">
                <div>
                  <span class="eyebrow">AGENTS</span>
                  <h2>Sesiones y worktrees reales</h2>
                  <p>Solo muestra procesos, CLIs y worktrees detectados en este equipo.</p>
                </div>
                <div class="asa-header-actions">
                  <button class="secondary-button" id="asa-new-terminal" type="button">Nueva terminal</button>
                  <button class="primary-button" id="asa-new-agent" type="button">Nuevo agente</button>
                </div>
              </header>

              <div class="asa-facts">
                <div><span>Agentes activos</span><strong id="asa-live-agents">—</strong></div>
                <div><span>CLIs instalados</span><strong id="asa-installed-agents">—</strong></div>
                <div><span>Worktrees Git</span><strong id="asa-worktrees">—</strong></div>
                <div><span>Runtime</span><strong id="asa-runtime-status">LOCKED</strong></div>
              </div>

              <section class="panel asa-sessions-panel">
                <header class="panel-header">
                  <div>
                    <span class="eyebrow">LIVE CONTEXT</span>
                    <h3>Procesos PTY conectados</h3>
                  </div>
                  <span class="panel-state">REAL / LOCAL</span>
                </header>
                <div class="asa-session-list" id="asa-session-list"></div>
              </section>
            </section>

            <section class="tools-view" id="tools-view">
              <header class="tools-header">
                <div>
                  <span class="eyebrow">BROWSER</span>
                  <h2>Previews y navegación</h2>
                  <p>Abre localhost o sitios reales sin salir del workspace.</p>
                </div>
                <div class="tools-header-actions">
                  <button class="secondary-button" id="tools-new-localhost" type="button">Localhost</button>
                  <button class="primary-button" id="tools-new-browser" type="button">Open browser</button>
                </div>
              </header>
              <div class="tool-tabs" id="tool-tabs"></div>
              <div class="tool-stage" id="tool-stage">
                <div class="tool-empty" id="tool-empty">
                  <span class="tool-empty-icon">◎</span>
                  <strong>No hay previews abiertos</strong>
                  <small>Abre un browser o un localhost real.</small>
                  <button class="secondary-button" id="tool-empty-open" type="button">Open browser</button>
                </div>
              </div>
            </section>

            <section class="terminal-area" id="terminal-area">
              <header class="terminal-area-header">
                <div>
                  <span class="eyebrow">REAL SHELL · PTY</span>
                  <h2>Terminales reales</h2>
                  <small id="active-session-label">Sin sesión activa</small>
                </div>
                <button class="primary-button" id="terminal-new" type="button">+<span>Nueva terminal</span></button>
              </header>
              <div class="endpoint-strip" id="endpoint-strip" hidden></div>
              <div class="terminal-tabs" id="terminal-tabs"></div>
              <div class="terminal-stack" id="terminal-stack"></div>
              <div class="terminal-empty" id="terminal-empty" hidden aria-hidden="true">
                <span>›_</span>
                <strong>No hay terminales abiertas</strong>
                <small id="terminal-empty-copy">Abre un shell real cuando lo necesites.</small>
                <button class="secondary-button" id="terminal-empty-new" type="button">Nueva terminal</button>
              </div>
              <div class="terminal-splitter" id="terminal-splitter" role="separator" aria-label="Redimensionar terminal"></div>
              <form class="command-form" id="command-form">
                <button class="command-cwd" id="command-cwd" type="button" title="Abrir carpeta en el explorador">
                  <span id="command-cwd-label">Sin directorio activo</span>›
                </button>
                <input class="command-input" id="command-input" type="text" placeholder="Escribe un comando para el shell real..." autocomplete="off" />
                <span class="command-live" id="command-live">WAITING</span>
                <button class="command-submit primary-button" type="submit">Run</button>
              </form>
            </section>
          </div>
        </main>

        <aside class="workspace-inspector" id="workspace-inspector" aria-label="Inspector del workspace">
          <div class="inspector-resizer" id="inspector-resizer" role="separator" aria-orientation="vertical" aria-label="Redimensionar inspector" title="Redimensionar inspector" tabindex="0"></div>
          <div class="inspector-tab-strip" role="tablist" aria-label="Inspector">
            <button class="inspector-tab-header-btn inspector-tab-active" data-inspector-tab="explorer" type="button" role="tab" aria-selected="true">Archivos</button>
            <button class="inspector-tab-header-btn" data-inspector-tab="git" type="button" role="tab" aria-selected="false">Git</button>
            <button class="inspector-tab-header-btn" data-inspector-tab="overview" type="button" role="tab" aria-selected="false">Resumen</button>
            <button class="inspector-tab-header-btn" data-inspector-tab="sessions" type="button" role="tab" aria-selected="false">Sesiones</button>
          </div>
          <div class="inspector-view-body">
            <div class="inspector-empty" id="workspace-inspector-empty">
              <span>□</span>
              <strong>Sin workspace</strong>
              <small>Abre una carpeta para explorar sus archivos.</small>
            </div>

            <div class="inspector-file-pane" id="workspace-file-explorer">
              <div class="inspector-header-row">
                <div>
                  <span class="eyebrow">EXPLORER</span>
                  <strong id="inspector-workspace-title">Workspace</strong>
                  <small id="file-tree-path">WORKSPACE</small>
                </div>
                <div class="inspector-header-actions">
                  <button class="icon-button" id="inspector-view-sort" type="button" title="Ordenar archivos">↕</button>
                  <button class="icon-button" id="files-refresh" type="button" title="Actualizar archivos">↻</button>
                  <button class="icon-button" id="inspector-more" type="button" title="Más opciones">…</button>
                </div>
              </div>

              <input class="field-input inspector-search-input" id="inspector-search-input" type="search" placeholder="Buscar archivos" aria-label="Buscar archivos" />
              <div class="inspector-segmented-control">
                <button class="inspector-segment-btn segmented-item-active" id="filter-names-btn" type="button">Nombres</button>
                <button class="inspector-segment-btn" id="filter-content-btn" type="button">Contenido</button>
              </div>
              <div class="file-list-tree" id="file-tree"></div>
              <div class="inspector-file-actions">
                <button class="secondary-button" id="floating-layout-toggle" type="button">Inspector</button>
              </div>
            </div>

            <section class="inspector-compat-pane" id="inspector-overview-pane" hidden>
              <span class="eyebrow">WORKSPACE</span>
              <strong id="inspector-overview-name">Sin workspace</strong>
              <small id="inspector-overview-path">Crea o abre un workspace.</small>
              <div class="inspector-overview-facts">
                <span><b id="inspector-overview-sessions">0</b> sesiones</span>
                <span><b id="inspector-overview-runtime">LOCKED</b></span>
              </div>
            </section>

            <section class="inspector-compat-pane" id="inspector-git-pane" hidden>
              <div class="inspector-pane-heading">
                <div>
                  <span class="eyebrow">GIT STATUS</span>
                  <strong id="inspector-git-branch">NO REPOSITORY</strong>
                </div>
                <button class="icon-button" id="inspector-git-refresh" type="button" title="Actualizar Git">↻</button>
              </div>
              <div id="inspector-git-content" class="inspector-compat-list"></div>
            </section>

            <section class="inspector-compat-pane" id="inspector-sessions-pane" hidden>
              <div class="inspector-pane-heading">
                <div>
                  <span class="eyebrow">RUNTIME</span>
                  <strong>Sesiones abiertas</strong>
                </div>
                <span class="panel-state" id="inspector-session-count">0</span>
              </div>
              <div id="inspector-sessions-list" class="inspector-compat-list"></div>
            </section>
          </div>
        </aside>
      </div>

      <footer class="statusbar">
        <div class="statusbar-left-group">
          <span class="statusbar-pill"><span class="status-dot"></span><span>LOCAL</span></span>
          <span class="statusbar-pill" id="runtime-usage-metric">PTY / READY</span>
        </div>
        <div class="statusbar-right-group">
          <div class="statusbar-utility-actions" role="group" aria-label="Acciones rápidas">
            <button class="icon-button" id="sidebar-help" type="button" title="Ayuda" aria-label="Ayuda">?</button>
            <button class="icon-button" id="sidebar-feedback" type="button" title="Comentarios" aria-label="Comentarios">…</button>
            <button class="icon-button" id="sidebar-stats" type="button" title="Estadísticas" aria-label="Estadísticas">▥</button>
            <button class="icon-button" id="sidebar-settings" type="button" title="Configuración" aria-label="Configuración">⚙</button>
          </div>
          <span class="statusbar-pill"><span id="memory-metric">—</span></span>
          <span class="statusbar-pill">›_ <span id="active-terminal-count">0</span></span>
        </div>
      </footer>
    </div>
    <div class="github-auth-gate" id="github-auth-gate" role="dialog" aria-modal="true" aria-labelledby="github-auth-title" aria-describedby="github-auth-copy">
      <section class="github-auth-panel">
        <div class="github-auth-heading">
          <span class="github-auth-mark">${icons.github}</span>
          <div>
            <span class="eyebrow">COMESADE / REQUIRED ACCESS</span>
            <h1 id="github-auth-title">Conecta GitHub para continuar</h1>
          </div>
        </div>
        <p class="github-auth-copy" id="github-auth-copy">ComesADE necesita que conectes tu cuenta real de GitHub antes de abrir el escritorio. La credencial se guarda en el almacen seguro de este sistema.</p>
        <div class="github-auth-status" role="status" aria-live="polite">
          <span class="github-auth-status-dot" id="github-auth-status-dot"></span>
          <span><strong id="github-auth-status-title">Comprobando conexion</strong><small id="github-auth-status-detail">Verificando la autorizacion de GitHub...</small></span>
        </div>
        <div class="github-auth-device-code" id="github-auth-device-code" hidden aria-live="polite">
          <div class="github-auth-device-code-copy">
            <span class="eyebrow">GITHUB DEVICE CODE</span>
            <span class="github-auth-device-code-label">Codigo que debes introducir en GitHub</span>
            <code id="github-auth-device-code-value" aria-label="Codigo de autorizacion de GitHub"></code>
          </div>
        </div>
        <small class="github-auth-device-warning" id="github-auth-device-warning" hidden></small>
        <div class="github-auth-actions">
          <button class="primary-button" id="github-auth-connect" type="button">${icons.github}<span>Conectar GitHub</span></button>
          <button class="secondary-button" id="github-auth-check" type="button">Ya estoy conectado</button>
        </div>
        <small class="github-auth-note" id="github-auth-note">Se abrira el flujo oficial de autorizacion de GitHub en tu navegador.</small>
      </section>
    </div>
    <div id="modal-root"></div>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  `;
}

renderComesadeSurface();


// La superficie ComesADE ya contiene todos los puntos de montaje reales.

const workspaceLockDescription = document.querySelector<HTMLElement>('#workspace-lock p');
if (workspaceLockDescription) workspaceLockDescription.textContent = 'Crea o abre un workspace real. Tus notas, terminales y herramientas quedaran ligados a ese proyecto.';
const terminalAreaMount = document.querySelector<HTMLElement>('#terminal-area');
if (terminalAreaMount && !document.querySelector('#developer-dock')) {
  const dock = document.createElement('section');
  dock.className = 'developer-dock';
  dock.id = 'developer-dock';
  dock.innerHTML = '<section class="editor-panel panel"><header class="dock-header"><div><strong id="editor-file-name">No file open</strong><small id="editor-file-path">Selecciona un archivo real</small></div><div class="dock-actions"><span id="editor-save-status" class="muted-label">CLEAN</span><button class="secondary-button" id="editor-save" type="button">' + icons.note + '<span>Save</span></button></div></header><div class="editor-tabs" id="editor-tabs" role="tablist" aria-label="Archivos abiertos"></div><textarea id="editor-content" class="code-editor" spellcheck="false" disabled placeholder="Selecciona un archivo del proyecto."></textarea></section><div class="developer-dock-resizer" id="developer-dock-resizer" role="separator" aria-orientation="vertical" aria-label="Redimensionar Editor y Git" title="Redimensionar Editor y Git" tabindex="0"></div><aside class="git-panel panel"><header class="dock-header"><div><strong>Git</strong><small id="git-branch">NO REPOSITORY</small></div><button class="icon-button" id="git-refresh" title="Refresh Git">' + icons.refresh + '</button></header><div class="git-list" id="git-list"><div class="dock-empty">El workspace no tiene status Git cargado.</div></div><pre class="git-diff" id="git-diff">Selecciona un cambio para ver el diff real.</pre><div class="git-commit-row"><input class="field-input" id="git-commit-message" placeholder="Commit message"/><button class="primary-button" id="git-commit" type="button">Commit</button></div></aside>';
  terminalAreaMount.before(dock);
}
if (terminalAreaMount && !document.querySelector('#endpoint-strip')) {
  const strip = document.createElement('div');
  strip.className = 'endpoint-strip';
  strip.id = 'endpoint-strip';
  strip.hidden = true;
  terminalAreaMount.insertBefore(strip, terminalAreaMount.querySelector('.command-form'));
}
const sessionList = document.querySelector<HTMLDivElement>('#session-list')!;
const workspaceInspector = document.querySelector<HTMLElement>('#workspace-inspector')!;
const sidebarProjectEmpty = document.querySelector<HTMLElement>('#sidebar-project-empty')!;
const workspaceInspectorEmpty = document.querySelector<HTMLElement>('#workspace-inspector-empty')!;
const workspaceFileExplorer = document.querySelector<HTMLElement>('#workspace-file-explorer')!;
const inspectorOverviewPane = document.querySelector<HTMLElement>('#inspector-overview-pane')!;
const inspectorGitPane = document.querySelector<HTMLElement>('#inspector-git-pane')!;
const inspectorSessionsPane = document.querySelector<HTMLElement>('#inspector-sessions-pane')!;
const inspectorOverviewName = document.querySelector<HTMLElement>('#inspector-overview-name')!;
const inspectorOverviewPath = document.querySelector<HTMLElement>('#inspector-overview-path')!;
const inspectorOverviewSessions = document.querySelector<HTMLElement>('#inspector-overview-sessions')!;
const inspectorOverviewRuntime = document.querySelector<HTMLElement>('#inspector-overview-runtime')!;
const inspectorGitBranch = document.querySelector<HTMLElement>('#inspector-git-branch')!;
const inspectorGitContent = document.querySelector<HTMLElement>('#inspector-git-content')!;
const inspectorGitRefresh = document.querySelector<HTMLButtonElement>('#inspector-git-refresh')!;
const inspectorSessionCount = document.querySelector<HTMLElement>('#inspector-session-count')!;
const inspectorSessionsList = document.querySelector<HTMLElement>('#inspector-sessions-list')!;
const fileTree = document.querySelector<HTMLDivElement>('#file-tree')!;
const fileTreePath = document.querySelector<HTMLElement>('#file-tree-path')!;
const filesRefresh = document.querySelector<HTMLButtonElement>('#files-refresh')!;
const filesBack = document.createElement('button');
filesBack.id = 'files-back';
filesBack.className = 'icon-button files-back-button';
filesBack.type = 'button';
filesBack.title = 'Volver a la carpeta padre';
filesBack.setAttribute('aria-label', 'Volver a la carpeta padre');
filesBack.innerHTML = icons.chevronLeft;
document.querySelector<HTMLElement>('#inspector-view-sort')?.before(filesBack);
const inspectorSearchInput = document.querySelector<HTMLInputElement>('#inspector-search-input')!;
const filesNewFile = document.createElement('button');
filesNewFile.id = 'files-new-file';
filesNewFile.className = 'icon-button';
filesNewFile.type = 'button';
filesNewFile.title = 'New file';
filesNewFile.setAttribute('aria-label', 'New file');
filesNewFile.innerHTML = icons.file;
filesRefresh.before(filesNewFile);
const filesNewFolder = document.createElement('button');
filesNewFolder.id = 'files-new-folder';
filesNewFolder.className = 'icon-button';
filesNewFolder.type = 'button';
filesNewFolder.title = 'New folder';
filesNewFolder.setAttribute('aria-label', 'New folder');
filesNewFolder.innerHTML = icons.folderPlus;
filesRefresh.before(filesNewFolder);
const editorFileName = document.querySelector<HTMLElement>('#editor-file-name')!;
const editorFilePath = document.querySelector<HTMLElement>('#editor-file-path')!;
const editorTabs = document.querySelector<HTMLDivElement>('#editor-tabs')!;
const editorContent = document.querySelector<HTMLTextAreaElement>('#editor-content')!;
const editorSave = document.querySelector<HTMLButtonElement>('#editor-save')!;
const editorSaveStatus = document.querySelector<HTMLElement>('#editor-save-status')!;
const gitBranch = document.querySelector<HTMLElement>('#git-branch')!;
const gitList = document.querySelector<HTMLDivElement>('#git-list')!;
const gitWorktreeList = document.createElement('div');
gitWorktreeList.className = 'git-worktree-list';
gitWorktreeList.id = 'git-worktree-list';
gitList.after(gitWorktreeList);
const gitDiff = document.querySelector<HTMLElement>('#git-diff')!;
const gitRefresh = document.querySelector<HTMLButtonElement>('#git-refresh')!;
const gitCommitMessage = document.querySelector<HTMLInputElement>('#git-commit-message')!;
const gitCommit = document.querySelector<HTMLButtonElement>('#git-commit')!;

type InspectorTab = 'explorer' | 'overview' | 'git' | 'sessions';
let activeInspectorTab: InspectorTab = 'explorer';
const openFileTabs: OpenFileTab[] = [];

function editorLanguage(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'ts' || extension === 'tsx') return 'typescript';
  if (extension === 'js' || extension === 'jsx') return 'javascript';
  if (extension === 'json') return 'json';
  if (extension === 'css') return 'css';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'md') return 'markdown';
  if (extension === 'py') return 'python';
  if (extension === 'rs') return 'rust';
  if (extension === 'sql') return 'sql';
  return 'plaintext';
}

let monacoApi: typeof Monaco | null = null;
let monacoLoadPromise: Promise<void> | null = null;

async function setupMonacoEditor(): Promise<void> {
  if (codeEditor || monacoLoadPromise) {
    await monacoLoadPromise;
    return;
  }

  monacoLoadPromise = (async () => {
    const [monacoModule, editorWorkerModule, jsonWorkerModule, cssWorkerModule, htmlWorkerModule, tsWorkerModule] = await Promise.all([
      import('monaco-editor/esm/vs/editor/editor.api'),
      import('monaco-editor/esm/vs/editor/editor.worker?worker'),
      import('monaco-editor/esm/vs/language/json/json.worker?worker'),
      import('monaco-editor/esm/vs/language/css/css.worker?worker'),
      import('monaco-editor/esm/vs/language/html/html.worker?worker'),
      import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
    ]);
    monacoApi = monacoModule;
    const editorWorker = editorWorkerModule.default;
    const jsonWorker = jsonWorkerModule.default;
    const cssWorker = cssWorkerModule.default;
    const htmlWorker = htmlWorkerModule.default;
    const tsWorker = tsWorkerModule.default;
    const globalWithMonaco = globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker } };
    globalWithMonaco.MonacoEnvironment = {
      getWorker: (_moduleId, label) => {
        if (label === 'json') return new jsonWorker();
        if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
        if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
        if (label === 'typescript' || label === 'javascript') return new tsWorker();
        return new editorWorker();
      },
    };
    try {
      codeEditorHost = document.createElement('div');
      codeEditorHost.className = 'monaco-editor-host';
      codeEditorHost.hidden = false;
      editorContent.insertAdjacentElement('afterend', codeEditorHost);
      codeEditor = monacoModule.editor.create(codeEditorHost, {
        automaticLayout: true,
        theme: 'vs-dark',
        language: 'plaintext',
        readOnly: !openFilePath,
        minimap: { enabled: true },
        fontFamily: defaultTerminalFont(),
        fontSize: 12,
        lineNumbers: 'on',
        wordWrap: 'off',
        tabSize: 2,
        scrollBeyondLastLine: false,
      });
      let syncingInitialEditorValue = true;
      codeEditor.setValue(editorContent.value);
      const initialModel = codeEditor.getModel();
      if (initialModel && openFilePath) monacoModule.editor.setModelLanguage(initialModel, editorLanguage(openFilePath));
      codeEditor.onDidChangeModelContent(() => {
        if (syncingInitialEditorValue) return;
        openFileDirty = true;
        const tab = currentOpenFileTab();
        if (tab) {
          tab.content = codeEditor?.getValue() ?? '';
          tab.dirty = true;
        }
        renderEditorTabs();
        editorSaveStatus.textContent = 'DIRTY';
      });
      syncingInitialEditorValue = false;
      codeEditor.addCommand(monacoModule.KeyMod.CtrlCmd | monacoModule.KeyCode.KeyS, () => { void saveWorkspaceFile(); });
      diffEditorHost = document.createElement('div');
      diffEditorHost.className = 'monaco-diff-host';
      diffEditorHost.hidden = true;
      gitDiff.insertAdjacentElement('afterend', diffEditorHost);
      diffEditor = monacoModule.editor.createDiffEditor(diffEditorHost, {
        automaticLayout: true,
        theme: 'vs-dark',
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        fontFamily: defaultTerminalFont(),
        fontSize: 11,
        scrollBeyondLastLine: false,
      });
      editorContent.hidden = true;
    } catch {
      codeEditor = null;
      codeEditorHost?.remove();
      codeEditorHost = null;
      diffEditor = null;
      diffEditorHost?.remove();
      diffEditorHost = null;
      editorContent.hidden = false;
    }
  })().catch(() => {
    monacoApi = null;
    editorContent.hidden = false;
  });

  await monacoLoadPromise;
}

function editorValue(): string {
  return codeEditor?.getValue() ?? editorContent.value;
}

function setEditorValue(value: string, path = ''): void {
  if (codeEditor) {
    codeEditor.setValue(value);
    const model = codeEditor.getModel();
    if (model && monacoApi) monacoApi.editor.setModelLanguage(model, editorLanguage(path));
  }
  editorContent.value = value;
}

function setEditorEnabled(enabled: boolean): void {
  editorContent.disabled = !enabled;
  codeEditor?.updateOptions({ readOnly: !enabled });
}

function syncDeveloperDockVisibility(): void {
  const visible = Boolean(openFilePath || diffOpen) && !developerDockCollapsed;
  developerDock.classList.toggle('developer-dock-open', visible);
  developerDock.classList.toggle('developer-dock-collapsed', developerDockCollapsed);
}

function toggleDeveloperDock(): void {
  developerDockCollapsed = !developerDockCollapsed;
  layoutState.developerDockCollapsed = developerDockCollapsed;
  syncDeveloperDockVisibility();
  saveLayout();
  scheduleLayoutSync();
}

function currentOpenFileTab(): OpenFileTab | undefined {
  const currentPath = openFilePath;
  const currentRoot = openFileRoot;
  if (!currentPath || !currentRoot) return undefined;
  return openFileTabs.find((tab) => sameFsPath(tab.root, currentRoot) && relativePathKey(tab.path) === relativePathKey(currentPath));
}

function syncCurrentOpenFileTab(): void {
  const tab = currentOpenFileTab();
  if (!tab) return;
  tab.content = editorValue();
  tab.dirty = openFileDirty;
}

function renderEditorTabs(): void {
  editorTabs.innerHTML = openFileTabs.map((tab) => {
    const active = Boolean(openFilePath && openFileRoot && sameFsPath(tab.root, openFileRoot) && relativePathKey(tab.path) === relativePathKey(openFilePath));
    const name = tab.path.split('/').pop() ?? tab.path;
    return '<button class="editor-tab ' + (active ? 'editor-tab-active' : '') + '" data-file-tab="' + escapeHtml(tab.path) + '" data-file-root="' + escapeHtml(tab.root) + '" type="button" role="tab" aria-selected="' + String(active) + '"><span>' + escapeHtml(name) + (tab.dirty ? '<i aria-label="Unsaved">•</i>' : '') + '</span><span class="editor-tab-close" data-close-file-tab="' + escapeHtml(tab.path) + '" data-file-root="' + escapeHtml(tab.root) + '" title="Cerrar archivo" aria-label="Cerrar archivo">' + icons.close + '</span></button>';
  }).join('');
}

function clearOpenFile(): void {
  fileOpenRequest += 1;
  openFileTabs.length = 0;
  openFilePath = null;
  openFileRoot = null;
  openFileDirty = false;
  diffOpen = false;
  setEditorValue('', '');
  setEditorEnabled(false);
  editorFileName.textContent = 'No file open';
  editorFilePath.textContent = 'Selecciona un archivo real';
  editorSaveStatus.textContent = 'CLEAN';
  renderEditorTabs();
  syncDeveloperDockVisibility();
}

function clearDiffModels(): void {
  diffEditor?.setModel(null);
  for (const model of diffModels) model.dispose();
  diffModels = [];
}

function setDiffMessage(message: string): void {
  diffOpen = false;
  clearDiffModels();
  gitDiff.hidden = false;
  gitDiff.textContent = message;
  if (diffEditorHost) diffEditorHost.hidden = true;
  syncDeveloperDockVisibility();
}

function setDiffVersions(original: string, current: string, path: string): void {
  diffOpen = true;
  developerDockCollapsed = false;
  layoutState.developerDockCollapsed = false;
  if (!monacoApi || !diffEditor || !diffEditorHost) {
    gitDiff.hidden = false;
    gitDiff.textContent = current || original || 'No hay diff para este archivo.';
    syncDeveloperDockVisibility();
    return;
  }
  clearDiffModels();
  const language = editorLanguage(path);
  const originalModel = monacoApi.editor.createModel(original, language);
  const currentModel = monacoApi.editor.createModel(current, language);
  diffModels = [originalModel, currentModel];
  diffEditor.setModel({ original: originalModel, modified: currentModel });
  gitDiff.hidden = true;
  diffEditorHost.hidden = false;
  syncDeveloperDockVisibility();
}

const activeWorkspaceCard = document.querySelector<HTMLButtonElement>('#active-workspace-card')!;
const activeWorkspaceName = document.querySelector<HTMLElement>('#active-workspace-name')!;
const activeWorkspacePath = document.querySelector<HTMLElement>('#active-workspace-path')!;
const workspaceList = document.createElement('div');
workspaceList.id = 'workspace-list';
workspaceList.className = 'workspace-list';
activeWorkspaceCard.before(workspaceList);
const workspaceHeading = document.querySelector<HTMLElement>('#workspace-heading')!;
const workspaceHeaderPath = document.querySelector<HTMLElement>('#workspace-header-path')!;
const workspaceSummaryName = document.querySelector<HTMLElement>('#workspace-summary-name')!;
const workspaceSummaryPath = document.querySelector<HTMLElement>('#workspace-summary-path')!;
const workspaceLock = document.querySelector<HTMLElement>('#workspace-lock')!;
const workspaceLockOpen = document.querySelector<HTMLButtonElement>('#workspace-lock-open')!;
const workspaceLockCreate = document.querySelector<HTMLButtonElement>('#workspace-lock-create')!;
const overviewSessionCount = document.querySelector<HTMLElement>('#overview-session-count')!;
const overviewActiveLabel = document.querySelector<HTMLElement>('#overview-active-label')!;
const overviewPathShort = document.querySelector<HTMLElement>('#overview-path-short')!;
const overviewPathDetail = document.querySelector<HTMLElement>('#overview-path-detail')!;
const overviewRuntimeStatus = document.querySelector<HTMLElement>('#overview-runtime-status')!;
const overviewShell = document.querySelector<HTMLElement>('#overview-shell')!;
const asaOverview = document.querySelector<HTMLElement>('#asa-overview')!;
const asaLiveAgents = document.querySelector<HTMLElement>('#asa-live-agents')!;
const asaInstalledAgents = document.querySelector<HTMLElement>('#asa-installed-agents')!;
const asaWorktrees = document.querySelector<HTMLElement>('#asa-worktrees')!;
const asaRuntimeStatus = document.querySelector<HTMLElement>('#asa-runtime-status')!;
const asaSessionList = document.querySelector<HTMLElement>('#asa-session-list')!;
const notesInput = document.querySelector<HTMLTextAreaElement>('#notes-input')!;
const notesStatus = document.querySelector<HTMLElement>('#notes-status')!;
const toolTabs = document.querySelector<HTMLDivElement>('#tool-tabs')!;
const toolStage = document.querySelector<HTMLDivElement>('#tool-stage')!;
const toolEmpty = document.querySelector<HTMLElement>('#tool-empty')!;
const terminalArea = document.querySelector<HTMLElement>('#terminal-area')!;
const developerDock = document.querySelector<HTMLElement>('#developer-dock')!;
const terminalStack = document.querySelector<HTMLDivElement>('#terminal-stack')!;
const terminalEmpty = document.querySelector<HTMLElement>('#terminal-empty')!;
const endpointStrip = document.querySelector<HTMLElement>('#endpoint-strip')!;
const terminalTabs = document.querySelector<HTMLDivElement>('#terminal-tabs')!;
const commandForm = document.querySelector<HTMLFormElement>('#command-form')!;
const commandInput = document.querySelector<HTMLInputElement>('#command-input')!;
const commandCwdButton = document.querySelector<HTMLButtonElement>('#command-cwd')!;
const commandCwd = document.querySelector<HTMLElement>('#command-cwd-label')!;
const commandLive = document.querySelector<HTMLElement>('#command-live')!;
const connectionState = document.querySelector<HTMLElement>('#connection-state')!;
const activeSessionLabel = document.querySelector<HTMLElement>('#active-session-label')!;
const appVersionLabel = document.querySelector<HTMLElement>('#app-version-label')!;
const modalRoot = document.querySelector<HTMLDivElement>('#modal-root')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const githubAuthGate = document.querySelector<HTMLElement>('#github-auth-gate')!;
const githubAuthConnectButton = document.querySelector<HTMLButtonElement>('#github-auth-connect')!;
const githubAuthCheckButton = document.querySelector<HTMLButtonElement>('#github-auth-check')!;
const githubAuthStatusDot = document.querySelector<HTMLElement>('#github-auth-status-dot')!;
const githubAuthStatusTitle = document.querySelector<HTMLElement>('#github-auth-status-title')!;
const githubAuthStatusDetail = document.querySelector<HTMLElement>('#github-auth-status-detail')!;
const githubAuthDeviceCodePanel = document.querySelector<HTMLElement>('#github-auth-device-code')!;
const githubAuthDeviceCodeValue = document.querySelector<HTMLElement>('#github-auth-device-code-value')!;
const githubAuthNote = document.querySelector<HTMLElement>('#github-auth-note')!;
const githubAuthDeviceWarning = document.querySelector<HTMLElement>('#github-auth-device-warning')!;
const githubAccountCard = document.querySelector<HTMLElement>('#github-account-card')!;
const githubAccountLabel = document.querySelector<HTMLElement>('#github-account-label')!;
const githubAccountStatus = document.querySelector<HTMLElement>('#github-account-status')!;
const githubAccountDot = document.querySelector<HTMLElement>('#github-account-dot')!;
const currentAppWebview = getCurrentWebview();
const API_BASE_URL = 'https://comesade-api.kingfrianfrian16.workers.dev';
const API_HEALTH_ENDPOINT = `${API_BASE_URL}/health`;
const API_READY_ENDPOINT = `${API_BASE_URL}/v1`;
const GITHUB_CLIENT_ID = (import.meta.env.VITE_GITHUB_CLIENT_ID ?? '').trim();
const GITHUB_DEVICE_CODE_WARNING = "Enter the code displayed in the app or on the device you're signing in to. Never use a code sent by someone else.";
const GITHUB_RELEASE_API_URL = 'https://api.github.com/repos/ZEKO091/COMES-ADE/releases/latest';
const API_MONITOR_INTERVAL_MS = 60_000;
const API_MONITOR_TIMEOUT_MS = 6_000;
const APP_UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
let localRuntimeState = 'LOCAL / STARTING';
let apiConnectionState = 'API / CHECKING';
let apiMonitorTimer: number | undefined;
let appUpdateCheckTimer: number | undefined;
let availableAppUpdate: AvailableAppUpdate | null = null;
let appUpdateInstalling = false;
let appUpdateCheckCompleted = false;
let appUpdateCheckError: unknown = null;
let appUpdateCheckPromise: Promise<void> | null = null;
let githubAuth: GithubAuthStatus = {
  connected: false,
  oauthConfigured: Boolean(GITHUB_CLIENT_ID),
  login: null,
  displayName: null,
  avatarUrl: null,
  host: null,
  error: null,
};
let githubAuthBusy = false;
let githubDeviceAuthorization: GithubDeviceAuthorization | null = null;
let githubAuthCheckPromise: Promise<void> | null = null;
let githubRepositories: GithubRepository[] = [];
let githubRepositoriesLoading = false;
let githubRepositoriesLoaded = false;
let githubRepositoriesError: string | null = null;
let githubRepositoriesRequest: Promise<void> | null = null;
let authorizedStartupPromise: Promise<void> | null = null;

type ApiHealthPayload = {
  database?: string;
  service?: string;
  status?: string;
  timestamp?: string;
};

type ApiReadyPayload = {
  auth?: string;
  dataPolicy?: string;
  next?: string;
  notes?: string;
  ready?: boolean;
  service?: string;
  status?: string;
  version?: string;
  workspaces?: string;
};

function renderGithubAuthState(): void {
  const connected = githubAuth.connected;
  const account = githubAuth.login ? `@${githubAuth.login}` : 'GitHub';
  githubAuthGate.hidden = connected;
  githubAuthGate.setAttribute('aria-hidden', String(connected));
  githubAccountCard.classList.toggle('is-connected', connected);
  githubAccountDot.classList.toggle('is-connected', connected);
  githubAccountDot.classList.toggle('is-error', !connected && !githubAuthBusy);
  githubAccountLabel.textContent = connected ? account : 'GitHub requerido';
  githubAccountStatus.textContent = connected ? 'Cuenta conectada' : githubAuthBusy ? 'Esperando conexion' : 'Conecta para continuar';
  githubAccountCard.setAttribute('aria-label', connected ? 'Abrir repositorios de GitHub' : 'Conectar cuenta de GitHub');

  githubAuthConnectButton.disabled = githubAuthBusy || !githubAuth.oauthConfigured;
  githubAuthCheckButton.disabled = githubAuthBusy || !githubAuth.oauthConfigured;
  githubAuthConnectButton.innerHTML = `${icons.github}<span>${githubAuthBusy ? 'Esperando GitHub...' : 'Conectar GitHub'}</span>`;
  githubAuthStatusDot.classList.toggle('is-connected', connected);
  githubAuthStatusDot.classList.toggle('is-error', !connected && !githubAuthBusy);
  githubAuthStatusDot.classList.toggle('is-pending', githubAuthBusy);
  const hasDeviceAuthorization = githubAuthBusy && githubDeviceAuthorization !== null;
  githubAuthDeviceCodePanel.hidden = !hasDeviceAuthorization;
  githubAuthDeviceCodeValue.textContent = githubDeviceAuthorization?.userCode ?? '';
  githubAuthDeviceWarning.hidden = !hasDeviceAuthorization;
  githubAuthDeviceWarning.textContent = GITHUB_DEVICE_CODE_WARNING;

  if (connected) {
    githubAuthStatusTitle.textContent = 'GitHub conectado';
    githubAuthStatusDetail.textContent = `Cuenta activa: ${account}`;
    githubAuthNote.textContent = 'La cuenta se administra con OAuth y el almacen seguro de este sistema.';
    return;
  }
  if (githubAuthBusy) {
    githubAuthStatusTitle.textContent = 'Completa la autorizacion';
    githubAuthStatusDetail.textContent = githubDeviceAuthorization
      ? 'Escribe en GitHub el codigo que aparece en el bloque de abajo.'
      : 'Preparando una autorizacion segura con GitHub.';
    githubAuthNote.textContent = githubDeviceAuthorization
      ? `Se abrio ${githubDeviceAuthorization.verificationUri}. Si no se abrio, visita esa direccion e introduce el codigo.`
      : 'No cierres esta ventana hasta completar la autorizacion.';
    return;
  }
  if (!githubAuth.oauthConfigured) {
    githubAuthStatusTitle.textContent = 'OAuth de GitHub no configurado';
    githubAuthStatusDetail.textContent = githubAuth.error ?? 'Falta el Client ID de la GitHub App.';
    githubAuthNote.textContent = 'Configura VITE_GITHUB_CLIENT_ID al compilar la aplicacion.';
    return;
  }
  githubAuthStatusTitle.textContent = 'GitHub requerido';
  githubAuthStatusDetail.textContent = githubAuth.error ?? 'No hay una cuenta activa en este equipo.';
  githubAuthNote.textContent = 'Se abrira el flujo oficial de autorizacion de GitHub en tu navegador.';
}

async function refreshGithubAuth(): Promise<GithubAuthStatus> {
  if (githubAuthCheckPromise) {
    await githubAuthCheckPromise;
    return githubAuth;
  }
  githubAuthCheckPromise = (async () => {
    try {
      if (!GITHUB_CLIENT_ID) {
        githubAuth = {
          connected: false,
          oauthConfigured: false,
          login: null,
          displayName: null,
          avatarUrl: null,
          host: null,
          error: 'Configura VITE_GITHUB_CLIENT_ID con el Client ID real de tu GitHub App.',
        };
      } else {
        githubAuth = await invoke<GithubAuthStatus>('github_auth_status', { clientId: GITHUB_CLIENT_ID });
      }
      if (!githubAuth.connected) {
        githubRepositories = [];
        githubRepositoriesLoaded = false;
      }
    } catch (error) {
      githubAuth = {
        connected: false,
        oauthConfigured: Boolean(GITHUB_CLIENT_ID),
        login: null,
        displayName: null,
        avatarUrl: null,
        host: null,
        error: `No se pudo comprobar GitHub: ${String(error)}`,
      };
    } finally {
      renderGithubAuthState();
    }
  })();
  await githubAuthCheckPromise;
  githubAuthCheckPromise = null;
  return githubAuth;
}

async function connectGithubAccount(): Promise<void> {
  if (githubAuthBusy) return;
  if (!GITHUB_CLIENT_ID) {
    githubAuth = {
      ...githubAuth,
      connected: false,
      oauthConfigured: false,
      error: 'Configura VITE_GITHUB_CLIENT_ID con el Client ID real de tu GitHub App.',
    };
    renderGithubAuthState();
    showToast(
      githubAuth.error ??
        'Configura VITE_GITHUB_CLIENT_ID con el Client ID real de tu GitHub App.',
      true,
    );
    return;
  }
  githubAuthBusy = true;
  githubDeviceAuthorization = null;
  githubAuth.error = null;
  renderGithubAuthState();
  try {
    const device = await invoke<GithubDeviceAuthorization>('github_oauth_start', { clientId: GITHUB_CLIENT_ID });
    githubDeviceAuthorization = device;
    renderGithubAuthState();
    try {
      await invoke('open_external_url', { url: device.verificationUri });
    } catch (error) {
      githubAuth.error = `No se pudo abrir el navegador: ${String(error)}`;
      renderGithubAuthState();
    }

    let intervalSeconds = Math.max(5, device.interval);
    const expiresAt = Date.now() + device.expiresIn * 1000;
    let connectedAuth: GithubAuthStatus | null = null;
    while (Date.now() < expiresAt) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, intervalSeconds * 1000));
      const poll = await invoke<GithubOAuthPoll>('github_oauth_poll', {
        clientId: GITHUB_CLIENT_ID,
        deviceCode: device.deviceCode,
        interval: intervalSeconds,
      });
      if (poll.status === 'connected' && poll.auth?.connected) {
        connectedAuth = poll.auth;
        break;
      }
      if (poll.status === 'error') {
        throw new Error(poll.error ?? 'GitHub no pudo completar la autorizacion.');
      }
      intervalSeconds = Math.max(5, poll.interval || intervalSeconds);
    }
    if (!connectedAuth) throw new Error('El codigo de autorizacion de GitHub expiro.');
    githubAuth = connectedAuth;
    showToast(`GitHub conectado como @${githubAuth.login ?? 'usuario'}.`);
    await finishAuthorizedStartup();
  } catch (error) {
    githubAuth = {
      ...githubAuth,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
    showToast(githubAuth.error ?? 'No se pudo conectar GitHub.', true);
  } finally {
    githubAuthBusy = false;
    githubDeviceAuthorization = null;
    renderGithubAuthState();
  }
}

async function checkGithubAccount(): Promise<void> {
  const status = await refreshGithubAuth();
  if (status.connected) {
    await finishAuthorizedStartup();
    return;
  }
  showToast(status.error ?? 'Conecta GitHub para continuar.', true);
}

function formatGithubDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function renderGithubRepositoryList(search = '', selectedFullName = ''): void {
  const list = document.querySelector<HTMLDivElement>('#github-repository-list');
  const account = document.querySelector<HTMLElement>('#github-repository-account');
  if (!list) return;

  if (account) {
    account.textContent = githubAuth.connected
      ? `Cuenta activa: @${githubAuth.login ?? 'usuario'}`
      : githubAuth.error ?? 'Conecta GitHub para consultar tus repositorios.';
  }

  if (githubRepositoriesLoading) {
    list.innerHTML = '<div class="github-repository-state">Consultando repositorios reales de GitHub…</div>';
    return;
  }
  if (githubRepositoriesError) {
    list.innerHTML = `<div class="github-repository-state github-repository-state-error">${escapeHtml(githubRepositoriesError)}</div>`;
    return;
  }
  if (!githubRepositoriesLoaded) {
    list.innerHTML = '<div class="github-repository-state">Pulsa actualizar para consultar los repositorios de esta cuenta.</div>';
    return;
  }

  const query = search.trim().toLowerCase();
  const repositories = githubRepositories.filter((repository) => {
    if (!query) return true;
    return [repository.fullName, repository.description ?? '', repository.defaultBranch ?? '']
      .some((value) => value.toLowerCase().includes(query));
  });
  if (!repositories.length) {
    list.innerHTML = githubRepositories.length
      ? '<div class="github-repository-state">No hay repositorios que coincidan con la búsqueda.</div>'
      : '<div class="github-repository-state">GitHub no devolvió repositorios para esta cuenta.</div>';
    return;
  }

  list.innerHTML = repositories.map((repository) => {
    const selected = repository.fullName === selectedFullName;
    const visibility = repository.private ? 'PRIVATE' : 'PUBLIC';
    const flags = [visibility, repository.fork ? 'FORK' : '', repository.archived ? 'ARCHIVED' : '']
      .filter(Boolean)
      .join(' · ');
    const updated = formatGithubDate(repository.updatedAt);
    return `<button class="github-repository-row${selected ? ' is-selected' : ''}" data-github-repository="${escapeHtml(repository.fullName)}" type="button" role="option" aria-selected="${String(selected)}">
      <span class="github-repository-mark">${icons.folder}</span>
      <span class="github-repository-copy"><strong>${escapeHtml(repository.fullName)}</strong><small>${escapeHtml(repository.description || 'Sin descripción')}</small></span>
      <span class="github-repository-meta"><i>${escapeHtml(flags)}</i><small>${escapeHtml(repository.defaultBranch ? `↳ ${repository.defaultBranch}` : '')}${updated ? ` · ${escapeHtml(updated)}` : ''}</small></span>
    </button>`;
  }).join('');
}

async function loadGithubRepositories(force = false): Promise<void> {
  if (githubRepositoriesRequest) {
    await githubRepositoriesRequest;
    return;
  }
  if (githubRepositoriesLoaded && !force) {
    renderGithubRepositoryList(document.querySelector<HTMLInputElement>('#github-repository-search')?.value ?? '');
    return;
  }

  const request = (async () => {
    githubRepositoriesLoading = true;
    githubRepositoriesError = null;
    renderGithubRepositoryList();
    try {
      const status = await refreshGithubAuth();
      if (!status.connected) {
        throw new Error(status.error ?? 'Conecta GitHub para consultar repositorios.');
      }
      githubRepositories = await invoke<GithubRepository[]>('github_repositories', { clientId: GITHUB_CLIENT_ID });
      githubRepositoriesLoaded = true;
    } catch (error) {
      githubRepositoriesLoaded = false;
      githubRepositoriesError = error instanceof Error ? error.message : String(error);
    } finally {
      githubRepositoriesLoading = false;
      renderGithubRepositoryList(document.querySelector<HTMLInputElement>('#github-repository-search')?.value ?? '');
    }
  })();
  githubRepositoriesRequest = request;
  try {
    await request;
  } finally {
    if (githubRepositoriesRequest === request) githubRepositoriesRequest = null;
  }
}

function updateConnectionStateLabel(): void {
  connectionState.textContent = `${localRuntimeState} · ${apiConnectionState}`;
  syncMainMenuRuntimeState();
}

function setLocalRuntimeState(value: string): void {
  localRuntimeState = value;
  updateConnectionStateLabel();
}

function setApiConnectionState(value: string): void {
  apiConnectionState = value;
  updateConnectionStateLabel();
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json() as T;
  } finally {
    window.clearTimeout(timer);
  }
}

async function probeRemoteApi(): Promise<void> {
  const startedAt = performance.now();
  try {
    const [health, ready] = await Promise.all([
      fetchJsonWithTimeout<ApiHealthPayload>(API_HEALTH_ENDPOINT, API_MONITOR_TIMEOUT_MS),
      fetchJsonWithTimeout<ApiReadyPayload>(API_READY_ENDPOINT, API_MONITOR_TIMEOUT_MS),
    ]);
    const latencyMs = Math.round(performance.now() - startedAt);
    const healthOk = health.status === 'ok' && health.database === 'connected';
    const readyOk = ready.status === 'ok' || ready.status === 'ready' || ready.ready === true;
    const localOnlyPolicy = ready.dataPolicy === 'workspaces-and-notes-stay-local'
      || (ready.workspaces === 'local_only' && ready.notes === 'local_only');
    if (!healthOk) {
      setApiConnectionState('API / HEALTH ERROR');
      return;
    }
    if (!readyOk) {
      setApiConnectionState('API / READY ERROR');
      return;
    }
    if (!localOnlyPolicy) {
      setApiConnectionState(`API / CONTRACT CHANGED ${latencyMs}MS`);
      return;
    }
    setApiConnectionState(`API / OK ${latencyMs}MS`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(reason)) {
      setApiConnectionState('API / TIMEOUT');
      return;
    }
    setApiConnectionState('API / OFFLINE');
  }
}

function startApiMonitor(): void {
  if (apiMonitorTimer !== undefined) window.clearInterval(apiMonitorTimer);
  void probeRemoteApi();
  apiMonitorTimer = window.setInterval(() => {
    void probeRemoteApi();
  }, API_MONITOR_INTERVAL_MS);
}

function inferWindowChromeOs(): string {
  const identity = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase();
  if (identity.includes('mac')) return 'macos';
  if (identity.includes('win')) return 'windows';
  if (identity.includes('linux')) return 'linux';
  return 'unknown';
}

function usesMacWindowControls(os: string): boolean {
  return os === 'macos';
}

function renderWindowControlsMarkup(os: string): string {
  if (usesMacWindowControls(os)) {
    return `
      <div class="window-controls window-controls-macos" aria-label="Controles de ventana">
        <button class="window-control window-control-close" id="close-window" type="button" title="Cerrar ComesADE" aria-label="Cerrar ComesADE"></button>
        <button class="window-control window-control-minimize" id="minimize-window" type="button" title="Minimizar" aria-label="Minimizar"></button>
        <button class="window-control window-control-maximize" id="maximize-window" type="button" title="Maximizar o restaurar" aria-label="Maximizar o restaurar"></button>
      </div>
    `;
  }
  return `
    <div class="window-controls window-controls-windows" aria-label="Controles de ventana">
      <button class="window-control window-control-minimize" id="minimize-window" type="button" title="Minimizar" aria-label="Minimizar">${icons.minimize}</button>
      <button class="window-control window-control-maximize" id="maximize-window" type="button" title="Maximizar o restaurar" aria-label="Maximizar o restaurar">${icons.maximize}</button>
      <button class="window-control window-control-close" id="close-window" type="button" title="Cerrar ComesADE" aria-label="Cerrar ComesADE">${icons.windowClose}</button>
    </div>
  `;
}

function syncWindowControls(): void {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const leftSlot = document.querySelector<HTMLElement>('#titlebar-window-slot-left');
  const rightSlot = document.querySelector<HTMLElement>('#titlebar-window-slot-right');
  const os = runtimePlatform.os || inferWindowChromeOs();
  const macControls = usesMacWindowControls(os);
  if (leftSlot) leftSlot.innerHTML = macControls ? renderWindowControlsMarkup(os) : '';
  if (rightSlot) rightSlot.innerHTML = macControls ? '' : renderWindowControlsMarkup(os);
  shell?.setAttribute('data-window-platform', macControls ? 'macos' : 'windows');
}

function inferRuntimePlatform(): RuntimePlatform {
  const os = inferWindowChromeOs();
  if (os === 'macos') return { os: 'macos', defaultShell: 'zsh', defaultShellName: 'Zsh' };
  if (os === 'windows') return { os: 'windows', defaultShell: 'powershell', defaultShellName: 'PowerShell' };
  if (os === 'linux') return { os: 'linux', defaultShell: 'bash', defaultShellName: 'Bash' };
  return { os: 'unknown', defaultShell: 'sh', defaultShellName: 'Shell' };
}

let runtimePlatform: RuntimePlatform = inferRuntimePlatform();
syncWindowControls();

function defaultTerminalFont(): string {
  if (runtimePlatform.os === 'macos') return 'SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  if (runtimePlatform.os === 'linux') return 'JetBrains Mono, DejaVu Sans Mono, monospace';
  return 'Cascadia Mono, Cascadia Code, Consolas, monospace';
}

const workspaces: WorkspaceInfo[] = [];
const sessions: SessionInfo[] = [];
const savedSessions: SavedSession[] = [];
const terminals = new Map<string, TerminalInstance>();
const sessionLaunches = new Map<string, SessionLaunchOptions>();
const localhostPanels = new Map<string, LocalhostPanel>();
const browserPanels = new Map<string, BrowserPanel>();
const visibleBrowserWebviews = new Set<string>();
const browserWebviewGeometry = new Map<string, string>();
const browserNavigationTokens = new Map<string, number>();
const pendingOutput = new Map<string, string>();
const terminalOutputQueues = new Map<string, TerminalOutputQueue>();
const terminalResizeState = new Map<string, string>();
const terminalInputBuffers = new Map<string, string>();
const pendingStatuses = new Map<string, string>();
const pendingExits = new Map<string, TerminalExit>();
const closingSessionIds = new Set<string>();
const ignoredSessionIds = new Set<string>();
type SessionActivity = 'working' | 'waiting' | 'finished' | 'error' | 'stopped';
const sessionActivities = new Map<string, SessionActivity>();
const detectedEndpoints = new Set<string>();
const exitedSessions = new Set<string>();
let activeWorkspaceId: string | null = null;
let activeSessionId: string | null = null;
let focusedTerminalId: string | null = null;
let activeToolId: string | null = null;
let mainMenuOpen = false;
let sessionSequence = 1;
let localhostSequence = 1;
let browserSequence = 1;
let detectedAgents: AgentDefinition[] = [];
let detectedShells: ShellDefinition[] = [];
let agentsDetectionReady = false;
let runtimeSnapshotReady = false;
let workspaceWatcherRoot: string | null = null;
let workspaceWatcherPromise: Promise<void> | null = null;
let fileTreeRelativePath = '';
let openFilePath: string | null = null;
let openFileRoot: string | null = null;
let openFileDirty = false;
let diffOpen = false;
let fileOpenRequest = 0;
let workspaceRefreshTimer: number | undefined;
let workspaceRefreshInFlight = false;
let workspaceRefreshQueued = false;
let codeEditor: Monaco.editor.IStandaloneCodeEditor | null = null;
let codeEditorHost: HTMLDivElement | null = null;
let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
let diffEditorHost: HTMLDivElement | null = null;
let diffModels: Monaco.editor.ITextModel[] = [];
let noteSaveTimer: number | undefined;
let notesLoadedWorkspaceId: string | null | undefined;
let toastTimer: number | undefined;
let layoutSyncFrame: number | undefined;
let renderFrame: number | undefined;
let terminalHeight = 300;
let browserNavigationSequence = 1;
let fileSortMode: 'name' | 'type' = 'name';
let inspectorFilterMode: 'names' | 'content' = 'names';
let sidebarSessionFilter: 'all' | 'live' = 'all';
let sidebarSessionQuery = '';
let developerDockCollapsed = false;
let inspectorCollapsed = false;
let viewHistory: LayoutView[] = ['overview'];
let viewHistoryIndex = 0;
let navigatingViewHistory = false;

const storageKeys = {
  workspaces: 'comesade.workspaces',
  activeWorkspace: 'comesade.active-workspace',
  notes: 'comesade.workspace.notes',
  sessions: 'comesade.workspace.sessions',
  layout: 'comesade.workspace.layout',
  settings: 'comesade.settings',
};
let nativePersistenceReady = false;

type AppSettings = {
  backgroundAnimation: boolean;
  defaultShell: string;
  terminalFont: string;
  terminalFontSize: number;
  terminalCursor: 'bar' | 'block' | 'underline';
  terminalScrollback: number;
  defaultAgent: string;
  worktreeDirectory: string;
  environment: Record<string, string>;
  customAgents: CustomAgentDefinition[];
  geminiTheme: boolean;
};
let appSettings: AppSettings = {
  backgroundAnimation: true,
  defaultShell: runtimePlatform.defaultShell,
  terminalFont: defaultTerminalFont(),
  terminalFontSize: 15,
  terminalCursor: 'bar',
  terminalScrollback: 12000,
  defaultAgent: '',
  worktreeDirectory: '',
  environment: {},
  customAgents: [],
  geminiTheme: false,
};

type LayoutView = 'overview' | 'asa' | 'terminals' | 'tools';

function isLayoutView(value: unknown): value is LayoutView {
  return value === 'overview' || value === 'asa' || value === 'terminals' || value === 'tools';
}

type WorkspaceLayoutState = {
  view?: LayoutView;
  openFilePath?: string | null;
  openFilePaths?: string[];
  terminalOrder?: string[];
  terminalSizes?: Record<string, { width: number; height: number }>;
  browserUrl?: string | null;
  localhostUrl?: string | null;
};

type LayoutState = {
  sidebarWidth: number;
  inspectorWidth: number;
  developerEditorShare: number;
  terminalHeight: number;
  developerDockCollapsed: boolean;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  view: LayoutView;
  workspaces: Record<string, WorkspaceLayoutState>;
};

let layoutState: LayoutState = {
  sidebarWidth: 258,
  inspectorWidth: 268,
  developerEditorShare: 0.58,
  terminalHeight: 300,
  developerDockCollapsed: false,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  view: 'overview',
  workspaces: {},
};

let compactViewport = false;
let responsiveLayoutInitialized = false;

const terminalTheme = {
  background: '#0b0e12',
  foreground: '#dfe7eb',
  cursor: '#ff7437',
  cursorAccent: '#0b0e12',
  selectionBackground: '#4a2b20',
  black: '#0b0e12', red: '#ff5d3d', green: '#45d89c', yellow: '#f4c45a',
  blue: '#69a8ff', magenta: '#d18cff', cyan: '#31d4ce', white: '#dfe7eb',
  brightBlack: '#66727b', brightRed: '#ff876e', brightGreen: '#7be8b9', brightYellow: '#ffd97f',
  brightBlue: '#9bc5ff', brightMagenta: '#e5b4ff', brightCyan: '#8bf0eb', brightWhite: '#ffffff',
};

const sessionNames = [
  'Sky', 'Suno', 'Nimbus', 'Nova', 'Atlas', 'Orbit', 'Sage', 'Lumen', 'Echo', 'Sol',
  'Astra', 'Zephyr', 'Aurora', 'Comet', 'Halo', 'Drift', 'Ember', 'Pulse', 'Flux', 'Vega',
  'Lyra', 'Orion', 'Terra', 'Titan', 'Luna', 'Solar', 'River', 'Mist', 'Cloud', 'Dune',
  'Frost', 'Dawn', 'Cinder', 'Breeze', 'Cobalt', 'Copper', 'Silver', 'Onyx', 'Quartz', 'Jade',
  'Opal', 'Pearl', 'Raven', 'Finch', 'Falcon', 'Owl', 'Wolf', 'Fox', 'Bear', 'Lynx',
  'Pine', 'Cedar', 'Maple', 'Willow', 'Aspen', 'Moss', 'Fern', 'Iris', 'Lotus', 'Olive',
  'Indigo', 'Saffron', 'Coral', 'Amber', 'Ruby', 'Garnet', 'Topaz', 'Mica', 'Graphite', 'Steel',
  'Vector', 'Matrix', 'Signal', 'Circuit', 'Pixel', 'Kernel', 'Orbitron', 'Vertex', 'Beacon', 'Relay',
  'Harbor', 'Summit', 'Valley', 'Meadow', 'Canyon', 'Coast', 'Island', 'Monsoon', 'Tempest', 'Solstice',
  'Equinox', 'Zenith', 'Horizon', 'Cosmos', 'Stellar', 'Meteor', 'Asteroid', 'Galaxy', 'Photon', 'NovaX',
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function showToast(message: string, error = false): void {
  toast.textContent = message;
  toast.classList.toggle('toast-error', error);
  toast.classList.add('toast-visible');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('toast-visible'), 3600);
}

function isGithubReleaseUpdate(update: AvailableAppUpdate): update is GithubReleaseUpdate {
  return 'source' in update && update.source === 'github';
}

function normalizeReleaseVersion(value: string): string | null {
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? `${match[1]}.${match[2] ?? '0'}.${match[3] ?? '0'}` : null;
}

function compareReleaseVersions(left: string, right: string): number {
  const leftVersion = normalizeReleaseVersion(left);
  const rightVersion = normalizeReleaseVersion(right);
  if (!leftVersion || !rightVersion) return left.localeCompare(right);
  const leftParts = leftVersion.split('.').map(Number);
  const rightParts = rightVersion.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function isGithubReleaseAsset(value: unknown): value is GithubReleaseAsset {
  if (!value || typeof value !== 'object') return false;
  const asset = value as Record<string, unknown>;
  return typeof asset.name === 'string' && typeof asset.browser_download_url === 'string';
}

async function checkGithubReleaseUpdate(): Promise<GithubReleaseUpdate | null> {
  const currentVersion = await getVersion();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(GITHUB_RELEASE_API_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub Releases respondio ${response.status}.`);

    const release = await response.json() as {
      tag_name?: unknown;
      body?: unknown;
      published_at?: unknown;
      html_url?: unknown;
      draft?: unknown;
      prerelease?: unknown;
      assets?: unknown;
    };
    if (release.draft === true || release.prerelease === true) return null;

    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const remoteVersion = normalizeReleaseVersion(tag);
    const localVersion = normalizeReleaseVersion(currentVersion);
    const releaseUrl = typeof release.html_url === 'string' ? release.html_url : '';
    if (!remoteVersion || !localVersion || !releaseUrl) throw new Error('La release de GitHub no tiene metadatos validos.');
    if (compareReleaseVersions(remoteVersion, localVersion) <= 0) return null;

    const assets = Array.isArray(release.assets) ? release.assets.filter(isGithubReleaseAsset) : [];
    const installer = assets.find((asset) => asset.name === 'ComesADE-Setup.exe')
      ?? assets.find((asset) => asset.name.toLowerCase().endsWith('_x64-setup.exe'))
      ?? assets.find((asset) => asset.name.toLowerCase().endsWith('.exe'));

    return {
      source: 'github',
      version: remoteVersion,
      body: typeof release.body === 'string' ? release.body : '',
      date: typeof release.published_at === 'string' ? release.published_at : null,
      downloadUrl: installer?.browser_download_url ?? releaseUrl,
      downloadLabel: installer ? 'Descargar instalador' : 'Abrir release',
      releaseUrl,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderUpdateButton(): void {
  const button = document.querySelector<HTMLButtonElement>('#titlebar-update');
  if (!button) return;
  const visible = Boolean(availableAppUpdate);
  button.hidden = !visible;
  if (!visible) return;
  button.disabled = appUpdateInstalling;
  const githubFallback = availableAppUpdate && isGithubReleaseUpdate(availableAppUpdate);
  button.innerHTML = `${appUpdateInstalling ? icons.refresh : icons.download}<span>${appUpdateInstalling ? 'Actualizando…' : githubFallback ? 'Descargar' : 'Actualizar'}</span>`;
  button.title = appUpdateInstalling
    ? 'Instalando la actualización firmada'
    : githubFallback
      ? `Descargar ComesADE ${availableAppUpdate?.version ?? 'la última versión'} desde GitHub`
      : `Actualizar ComesADE a ${availableAppUpdate?.version ?? 'la última versión'}`;
  button.setAttribute('aria-label', button.title);
}

function updateInstallProgress(message: string, percent?: number): void {
  const status = document.querySelector<HTMLElement>('#app-update-progress');
  if (status) status.textContent = message;
  const value = document.querySelector<HTMLElement>('#app-update-progress-value');
  const track = document.querySelector<HTMLElement>('#app-update-progress-track');
  const bar = document.querySelector<HTMLElement>('#app-update-progress-bar');
  if (!value || !track || !bar) return;
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    const normalized = Math.min(100, Math.max(0, Math.round(percent)));
    value.textContent = `${normalized}%`;
    bar.style.width = `${normalized}%`;
    track.classList.remove('is-indeterminate');
    track.setAttribute('aria-valuenow', String(normalized));
    track.setAttribute('aria-valuetext', `${normalized}%`);
    return;
  }
  if (appUpdateInstalling) {
    value.textContent = '...';
    bar.style.width = '34%';
    track.classList.add('is-indeterminate');
    track.removeAttribute('aria-valuenow');
    track.setAttribute('aria-valuetext', message);
  }
}

function openAppUpdateModal(): void {
  const update = availableAppUpdate;
  if (!update || appUpdateInstalling) return;
  const notes = String(update.body ?? '').trim().slice(0, 5000);
  const notesMarkup = notes
    ? escapeHtml(notes).replace(/\r?\n/g, '<br>')
    : 'Esta versión incluye mejoras y correcciones para tu dispositivo.';
  const published = update.date ? new Date(update.date).toLocaleDateString() : '';
  const githubFallback = isGithubReleaseUpdate(update);
  const modalCopy = githubFallback
    ? 'Esta release no incluye el manifiesto firmado del updater. Se abrirá el instalador oficial desde GitHub.'
    : 'La actualización se descargará desde GitHub y se validará con la firma de ComesADE antes de instalarse.';
  const installLabel = githubFallback ? update.downloadLabel : 'Instalar actualización';
  modalRoot.innerHTML = `<div class="modal-backdrop" id="app-update-backdrop"><section class="modal-panel app-update-modal"><div class="modal-heading"><div><span class="eyebrow">COMESADE / UPDATE</span><h2>Nueva versión disponible</h2></div><button class="modal-close" id="app-update-close" type="button">${icons.close}</button></div><div class="app-update-version"><strong>ComesADE ${escapeHtml(update.version)}</strong><span>${published ? `Publicada ${escapeHtml(published)}` : 'Release estable'}</span></div><p class="modal-copy">La actualización se descargará desde GitHub y se validará con la firma de ComesADE antes de instalarse.</p><div class="app-update-notes">${notesMarkup}</div><p class="app-update-progress" id="app-update-progress" role="status" aria-live="polite">Lista para instalar.</p><div class="modal-actions"><button class="secondary-button" id="app-update-cancel" type="button">Ahora no</button><button class="primary-button" id="app-update-install" type="button">${icons.download}<span>Instalar actualización</span></button></div></section></div>`;
  const copy = document.querySelector<HTMLElement>('.app-update-modal .modal-copy');
  if (copy) copy.textContent = modalCopy;
  const installButton = document.querySelector<HTMLButtonElement>('#app-update-install');
  if (installButton) installButton.innerHTML = `${icons.download}<span>${installLabel}</span>`;
  const versionRow = document.querySelector<HTMLElement>('.app-update-version');
  if (versionRow) {
    const versionText = versionRow.querySelector('strong')?.textContent || `ComesADE ${update.version}`;
    const publishedText = versionRow.querySelector('span')?.textContent || 'Release estable';
    versionRow.innerHTML = `<div class="app-update-release"><span class="app-update-kicker">VERSION ESTABLE</span><strong>${escapeHtml(versionText)}</strong></div><span>${escapeHtml(publishedText)}</span>`;
  }
  const notesPanel = document.querySelector<HTMLElement>('.app-update-notes');
  if (notesPanel) {
    notesPanel.innerHTML = `<div class="app-update-notes-heading"><span>NOVEDADES</span><span>Release notes</span></div><div class="app-update-notes-body">${notesMarkup}</div>`;
  }
  const progressStatus = document.querySelector<HTMLElement>('#app-update-progress');
  if (progressStatus) {
    const initialMessage = escapeHtml(progressStatus.textContent || 'Lista para instalar.');
    progressStatus.outerHTML = `<div class="app-update-status"><div class="app-update-status-header"><p class="app-update-progress" id="app-update-progress" role="status" aria-live="polite">${initialMessage}</p><strong class="app-update-progress-value" id="app-update-progress-value">-</strong></div><div class="app-update-progress-track" id="app-update-progress-track" role="progressbar" aria-label="Progreso de la actualizacion" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="app-update-progress-bar" id="app-update-progress-bar"></span></div></div>`;
  }
  const close = (): void => { if (!appUpdateInstalling) modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#app-update-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#app-update-cancel')?.addEventListener('click', close);
  document.querySelector<HTMLElement>('#app-update-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) close();
  });
  document.querySelector<HTMLButtonElement>('#app-update-install')?.addEventListener('click', () => { void installAppUpdate(); });
}

async function checkForAppUpdate(manual = false, force = false): Promise<void> {
  if (appUpdateCheckPromise) {
    await appUpdateCheckPromise;
  } else if (!appUpdateCheckCompleted || manual || force) {
    appUpdateCheckError = null;
    const request = (async () => {
      try {
        let signedCheckError: unknown = null;
        let signedUpdate: AppUpdate | null = null;
        try {
          signedUpdate = await check();
        } catch (error) {
          signedCheckError = error;
          console.debug('ComesADE signed update check skipped:', error);
        }
        try {
          availableAppUpdate = signedUpdate ?? await checkGithubReleaseUpdate();
        } catch (error) {
          if (signedCheckError) throw error;
          availableAppUpdate = null;
        }
        renderUpdateButton();
      } catch (error) {
        availableAppUpdate = null;
        appUpdateCheckError = error;
        renderUpdateButton();
        // Un release ausente, un repositorio privado o estar sin red no deben
        // bloquear el arranque ni llenar la interfaz de errores.
        console.debug('ComesADE update check skipped:', error);
      } finally {
        appUpdateCheckCompleted = true;
      }
    })();
    appUpdateCheckPromise = request;
    try {
      await request;
    } finally {
      appUpdateCheckPromise = null;
    }
  }

  if (!manual) return;
  if (availableAppUpdate) {
    openAppUpdateModal();
  } else if (appUpdateCheckError) {
    showToast('No se pudo comprobar si hay actualizaciones.', true);
  } else {
    showToast('ComesADE ya esta actualizado.');
  }
}

function startAppUpdateChecker(): void {
  if (appUpdateCheckTimer !== undefined) window.clearInterval(appUpdateCheckTimer);
  void checkForAppUpdate();
  appUpdateCheckTimer = window.setInterval(() => {
    if (appUpdateInstalling) return;
    void checkForAppUpdate(false, true);
  }, APP_UPDATE_CHECK_INTERVAL_MS);
}

async function installAppUpdate(): Promise<void> {
  const update = availableAppUpdate;
  if (!update || appUpdateInstalling) return;
  if (isGithubReleaseUpdate(update)) {
    appUpdateInstalling = true;
    renderUpdateButton();
    const installButton = document.querySelector<HTMLButtonElement>('#app-update-install');
    const cancelButton = document.querySelector<HTMLButtonElement>('#app-update-cancel');
    const closeButton = document.querySelector<HTMLButtonElement>('#app-update-close');
    if (installButton) installButton.disabled = true;
    if (cancelButton) cancelButton.disabled = true;
    if (closeButton) closeButton.disabled = true;
    updateInstallProgress('Abriendo la descarga oficial de GitHub...');
    try {
      await invoke('open_external_url', { url: update.downloadUrl });
      availableAppUpdate = null;
      appUpdateInstalling = false;
      renderUpdateButton();
      modalRoot.innerHTML = '';
      showToast('La descarga oficial de GitHub se abrió en el navegador.');
    } catch (error) {
      appUpdateInstalling = false;
      renderUpdateButton();
      showToast(`No se pudo abrir la descarga: ${String(error)}`, true);
      openAppUpdateModal();
    }
    return;
  }
  appUpdateInstalling = true;
  renderUpdateButton();
  const installButton = document.querySelector<HTMLButtonElement>('#app-update-install');
  const cancelButton = document.querySelector<HTMLButtonElement>('#app-update-cancel');
  const closeButton = document.querySelector<HTMLButtonElement>('#app-update-close');
  if (installButton) {
    installButton.disabled = true;
    installButton.textContent = 'Descargando…';
  }
  if (cancelButton) cancelButton.disabled = true;
  if (closeButton) closeButton.disabled = true;
  updateInstallProgress('Conectando con el release firmado…');
  let downloaded = 0;
  let contentLength = 0;
  let installed = false;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        contentLength = event.data.contentLength ?? 0;
        updateInstallProgress(contentLength ? `Descargando 0% (${formatUpdateBytes(contentLength)})` : 'Descargando actualización…', contentLength ? 0 : undefined);
        return;
      }
      if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        const progressValue = contentLength ? Math.min(99, Math.round((downloaded / contentLength) * 100)) : undefined;
        const progress = typeof progressValue === 'number' ? ` ${progressValue}%` : '';
        updateInstallProgress(`Descargando${progress}…`, progressValue);
        return;
      }
      if (event.event === 'Finished') {
        if (installButton) installButton.textContent = 'Instalando…';
        updateInstallProgress('Descarga verificada. Instalando…', 100);
      }
    });
    installed = true;
    availableAppUpdate = null;
    appUpdateInstalling = false;
    renderUpdateButton();
    updateInstallProgress('Actualización instalada. Reiniciando ComesADE…');
    await relaunch();
  } catch (error) {
    appUpdateInstalling = false;
    renderUpdateButton();
    if (installed) {
      modalRoot.innerHTML = '';
      showToast('La actualización quedó instalada. Cierra y abre ComesADE para terminar.', true);
      return;
    }
    showToast(`No se pudo instalar la actualización: ${String(error)}`, true);
    openAppUpdateModal();
  }
}

function formatUpdateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'tamaño desconocido';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function primaryModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

function terminalOwnsKeyboard(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  const active = document.activeElement as HTMLElement | null;
  return Boolean(target?.closest('.terminal-pane, .xterm-helper-textarea') || active?.closest('.terminal-pane, .xterm-helper-textarea'));
}

function getWorkspace(id: string | null = activeWorkspaceId): WorkspaceInfo | undefined {
  return id ? workspaces.find((workspace) => workspace.id === id) : undefined;
}

function workspaceNameFromPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? 'Workspace';
}

function enterWorkspace(): void {
  const closingMainMenu = mainMenuOpen;
  mainMenuOpen = false;
  if (closingMainMenu && layoutState.sidebarCollapsed) {
    // El escritorio debe recuperar el contexto completo al salir del menú.
    // El usuario todavía puede volver a ocultarlo con Ctrl+B o el botón de layout.
    layoutState.sidebarCollapsed = false;
    applyLayout();
    saveLayout();
  }
  modalRoot.innerHTML = '';
  updateWorkspaceView();
  render();
  scheduleWebviewSync();
  void restoreWorkspaceLayout();
  const workspace = getWorkspace();
  if (workspace) {
    void startWorkspaceWatcher(workspace.path)
      .then(() => refreshWorkspacePanels())
      .catch((error) => showToast('No se pudo iniciar el watcher del workspace: ' + String(error), true));
  }
}

async function startWorkspaceWatcher(root: string): Promise<void> {
  const normalized = root.trim();
  if (!normalized || (workspaceWatcherRoot && sameFsPath(workspaceWatcherRoot, normalized))) return;
  if (workspaceWatcherPromise) await workspaceWatcherPromise;
  if (workspaceWatcherRoot && sameFsPath(workspaceWatcherRoot, normalized)) return;
  const transition = (async () => {
    if (workspaceWatcherRoot) {
      await invoke('unwatch_workspace', { root: workspaceWatcherRoot }).catch(() => undefined);
    }
    await invoke('watch_workspace', { root: normalized });
    workspaceWatcherRoot = normalized;
  })();
  workspaceWatcherPromise = transition;
  try {
    await transition;
  } finally {
    if (workspaceWatcherPromise === transition) workspaceWatcherPromise = null;
  }
}

function handleWorkspaceFileChange(payload: WorkspaceFileChange): void {
  const workspace = getWorkspace();
  if (!workspace || !sameFsPath(payload.root, workspace.path)) return;
  window.dispatchEvent(new CustomEvent('comesade-workspace-changed', { detail: payload }));
}

async function activateWorkspace(workspace: WorkspaceInfo, enterAfter = true): Promise<void> {
  try {
    const switchingWorkspace = activeWorkspaceId !== workspace.id;
    const resolvedPath = await invoke<string>('validate_workspace_path', { path: workspace.path });
    if (switchingWorkspace && !prepareEditorForRootChange(resolvedPath)) return;
    if (switchingWorkspace) {
      closeAllTools(false);
      saveLayout();
    }
    workspace.path = resolvedPath;
    activeWorkspaceId = workspace.id;
    loadSessionDefinitions();
    saveWorkspaces();
    await startWorkspaceWatcher(workspace.path);
    await syncRuntimeSessions();
    updateWorkspaceView();
    render();
    if (enterAfter) enterWorkspace();
    else void refreshWorkspacePanels();
    showToast(`Workspace ${workspace.name} abierto.`);
  } catch (error) {
    showToast(`No se pudo abrir el workspace real: ${String(error)}`, true);
  }
}

async function registerWorkspaceFromPath(path: string, enterAfter = true): Promise<void> {
  try {
    const resolvedPath = await invoke<string>('validate_workspace_path', { path });
    const existing = workspaces.find((workspace) => sameFsPath(workspace.path, resolvedPath));
    if (existing) {
      await activateWorkspace(existing, enterAfter);
      return;
    }

    const workspace: WorkspaceInfo = {
      id: `workspace-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      name: workspaceNameFromPath(resolvedPath),
      path: resolvedPath,
      createdAt: new Date().toISOString(),
    };
    if (!prepareEditorForRootChange(resolvedPath)) return;
    closeAllTools(false);
    saveLayout();
    workspaces.unshift(workspace);
    activeWorkspaceId = workspace.id;
    loadSessionDefinitions();
    saveWorkspaces();
    await startWorkspaceWatcher(workspace.path);
    await syncRuntimeSessions();
    updateWorkspaceView();
    render();
    if (enterAfter) enterWorkspace();
    else void refreshWorkspacePanels();
    showToast(`Workspace ${workspace.name} abierto.`);
  } catch (error) {
    showToast(`No se pudo abrir la carpeta real: ${String(error)}`, true);
  }
}

async function pickAndOpenWorkspace(returnToMenu = true, enterAfter = true): Promise<void> {
  try {
    const path = await invoke<string | null>('pick_workspace_path');
    if (path) await registerWorkspaceFromPath(path, enterAfter);
    else if (returnToMenu && !getWorkspace()) openMainMenu();
  } catch (error) {
    showToast(`No se pudo abrir el selector de carpetas: ${String(error)}`, true);
  }
}

function getSession(id: string | null): SessionInfo | undefined {
  return id ? sessions.find((session) => session.id === id) : undefined;
}

function applySavedTerminalOrder(): void {
  const order = getWorkspace() ? layoutState.workspaces[getWorkspace()!.id]?.terminalOrder ?? [] : [];
  if (!order.length || sessions.length < 2) return;
  const positions = new Map(order.map((id, index) => [id, index]));
  const fallbackPositions = new Map(sessions.map((session, index) => [session.id, index]));
  sessions.sort((left, right) => {
    const leftPosition = positions.get(left.id) ?? order.length + (fallbackPositions.get(left.id) ?? 0);
    const rightPosition = positions.get(right.id) ?? order.length + (fallbackPositions.get(right.id) ?? 0);
    return leftPosition - rightPosition;
  });
}

function saveCurrentTerminalOrder(): void {
  if (!activeWorkspaceId) return;
  saveWorkspaceLayout({ terminalOrder: sessions.map((session) => session.id).slice(0, 64) });
}

function applySavedTerminalSize(id: string, surface: HTMLElement): void {
  const saved = activeWorkspaceId ? layoutState.workspaces[activeWorkspaceId]?.terminalSizes?.[id] : undefined;
  if (!saved) return;
  surface.style.width = `${saved.width}px`;
  surface.style.height = `${saved.height}px`;
  surface.classList.add('terminal-view-sized');
}

function saveTerminalSize(id: string, surface: HTMLElement): void {
  if (!activeWorkspaceId) return;
  const rect = surface.getBoundingClientRect();
  const sizes = { ...(layoutState.workspaces[activeWorkspaceId]?.terminalSizes ?? {}) };
  sizes[id] = {
    width: Math.min(Math.max(Math.round(rect.width), 260), 2400),
    height: Math.min(Math.max(Math.round(rect.height), 220), 1600),
  };
  saveWorkspaceLayout({ terminalSizes: sizes });
}

function reorderTerminal(sourceId: string, targetId: string): void {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const sourceIndex = sessions.findIndex((session) => session.id === sourceId);
  const targetIndex = sessions.findIndex((session) => session.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = sessions.splice(sourceIndex, 1);
  sessions.splice(targetIndex, 0, moved);
  saveCurrentTerminalOrder();
  render();
}

function bindTerminalReordering(): void {
  terminalStack.addEventListener('dragstart', (event) => {
    const target = event.target as HTMLElement;
    const header = target.closest<HTMLElement>('.terminal-view-header');
    const surface = target.closest<HTMLElement>('.terminal-view');
    if (!header || !surface || target.closest('button')) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData('text/plain', surface.dataset.sessionId ?? '');
    event.dataTransfer?.setDragImage(surface, Math.min(surface.clientWidth / 2, 180), 18);
    surface.classList.add('terminal-view-dragging');
  });
  terminalStack.addEventListener('dragover', (event) => {
    const surface = (event.target as HTMLElement).closest<HTMLElement>('.terminal-view');
    if (!surface || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    surface.classList.add('terminal-view-drop-target');
  });
  terminalStack.addEventListener('dragleave', (event) => {
    const surface = (event.target as HTMLElement).closest<HTMLElement>('.terminal-view');
    if (surface && !surface.contains(event.relatedTarget as Node | null)) surface.classList.remove('terminal-view-drop-target');
  });
  terminalStack.addEventListener('drop', (event) => {
    event.preventDefault();
    const sourceId = event.dataTransfer?.getData('text/plain') ?? '';
    const surface = (event.target as HTMLElement).closest<HTMLElement>('.terminal-view');
    terminalStack.querySelectorAll<HTMLElement>('.terminal-view-dragging, .terminal-view-drop-target').forEach((item) => item.classList.remove('terminal-view-dragging', 'terminal-view-drop-target'));
    if (surface) reorderTerminal(sourceId, surface.dataset.sessionId ?? '');
  });
  terminalStack.addEventListener('dragend', () => {
    terminalStack.querySelectorAll<HTMLElement>('.terminal-view-dragging, .terminal-view-drop-target').forEach((item) => item.classList.remove('terminal-view-dragging', 'terminal-view-drop-target'));
  });
}

function bindTerminalResizing(): void {
  terminalStack.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-terminal-resize]');
    const surface = target.closest<HTMLElement>('.terminal-view');
    const id = handle?.dataset.terminalResize ?? surface?.dataset.sessionId;
    if (!handle || !surface || !id) return;
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = surface.getBoundingClientRect().width;
    const startHeight = surface.getBoundingClientRect().height;
    const move = (moveEvent: PointerEvent): void => {
      const width = Math.min(Math.max(Math.round(startWidth + moveEvent.clientX - startX), 260), 2400);
      const height = Math.min(Math.max(Math.round(startHeight + moveEvent.clientY - startY), 220), 1600);
      surface.style.width = `${width}px`;
      surface.style.height = `${height}px`;
      surface.classList.add('terminal-view-sized');
      syncTerminalSize(id);
    };
    const stop = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      handle.releasePointerCapture?.(event.pointerId);
      saveTerminalSize(id, surface);
      syncTerminalSize(id);
      scheduleLayoutSync();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });
}

function sessionBelongsToWorkspace(session: SessionInfo, workspace: WorkspaceInfo): boolean {
  // workspacePath is the authoritative owner written when the PTY is created.
  // Falling back to cwd/worktree is only for sessions created by older builds.
  if (session.workspacePath?.trim()) return sameFsPath(session.workspacePath, workspace.path);
  const candidates = [session.workspacePath, session.worktree, session.cwd].filter((value): value is string => Boolean(value && value.trim()));
  return candidates.some((value) => isSameOrInsideFsPath(value, workspace.path));
}

function activeProjectRoot(): string | undefined {
  const workspace = getWorkspace();
  if (!workspace) return undefined;
  return getSession(activeSessionId)?.worktree ?? workspace.path;
}

async function syncRuntimeSessions(): Promise<void> {
  runtimeSnapshotReady = false;
  const workspace = getWorkspace();
  const runtimeSessions = await invoke<SessionInfo[]>('list_sessions');
  const visible = workspace
    ? runtimeSessions.filter((session) => sessionBelongsToWorkspace(session, workspace) && !ignoredSessionIds.has(session.id))
    : [];
  const visibleIds = new Set(visible.map((session) => session.id));

  for (const session of sessions) {
    if (visibleIds.has(session.id)) continue;
    terminals.get(session.id)?.resizeObserver?.disconnect();
    const instance = terminals.get(session.id);
    instance?.linkProvider?.dispose();
    instance?.terminal.dispose();
    instance?.surface.remove();
    terminals.delete(session.id);
    clearTerminalOutputQueue(session.id);
    terminalResizeState.delete(session.id);
    // The process may belong to another workspace. Keep its metadata and its
    // event stream eligible for reattachment when the user switches back.
    closingSessionIds.delete(session.id);
    if (activeSessionId === session.id) activeSessionId = null;
    if (focusedTerminalId === session.id) focusedTerminalId = null;
  }

  sessions.splice(0, sessions.length, ...visible);
  for (const session of visible) {
    const pendingStatus = pendingStatuses.get(session.id);
    if (pendingStatus) {
      session.status = pendingStatus;
      pendingStatuses.delete(session.id);
    }
    const pendingExit = pendingExits.get(session.id);
    if (pendingExit) {
      session.status = 'exited';
      pendingExits.delete(session.id);
      exitedSessions.add(session.id);
      sessionActivities.set(session.id, pendingExit.exitCode === 0 ? 'finished' : pendingExit.exitCode === null ? 'stopped' : 'error');
    } else if (session.status === 'running') {
      exitedSessions.delete(session.id);
      if (!sessionActivities.has(session.id)) sessionActivities.set(session.id, 'waiting');
    } else {
      exitedSessions.add(session.id);
      if (!sessionActivities.has(session.id)) sessionActivities.set(session.id, 'finished');
    }
  }
  applySavedTerminalOrder();
  for (const session of visible) mountTerminal(session);

  if (!activeSessionId || !visibleIds.has(activeSessionId)) {
    activeSessionId = visible.find((session) => session.status === 'running' && !exitedSessions.has(session.id))?.id ?? visible[0]?.id ?? null;
  }
  runtimeSnapshotReady = true;
  render();
}

function getLiveSession(id: string | null): SessionInfo | undefined {
  const session = getSession(id);
  return session && session.status === 'running' && !exitedSessions.has(session.id) ? session : undefined;
}

function getPreferredLiveSession(): SessionInfo | undefined {
  return getLiveSession(activeSessionId) ?? sessions.find((session) => session.status === 'running' && !exitedSessions.has(session.id));
}

function findSessionByQuery(query: string): SessionInfo | undefined {
  const normalized = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/^['"]|['"]$/g, '');
  return sessions.find((session) => session.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() === normalized)
    ?? sessions.find((session) => session.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(normalized));
}

function randomName(): string | undefined {
  const used = new Set(sessions.map((session) => session.name.toLowerCase()));
  const available = sessionNames.filter((name) => !used.has(name.toLowerCase()));
  if (!available.length) return undefined;
  const buffer = new Uint32Array(1);
  window.crypto.getRandomValues(buffer);
  return available[buffer[0] % available.length];
}

function uniqueSessionName(preferred?: string, excludeId?: string): string | undefined {
  const base = preferred?.trim() || randomName();
  if (!base) return undefined;
  const used = new Set(sessions.filter((session) => session.id !== excludeId).map((session) => session.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = base + ' (' + index + ')';
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return undefined;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function isShellPromptVisible(data: string): boolean {
  const plain = stripAnsi(data).replace(/\r/g, '');
  return /(?:^|\n)(?:PS [^\r\n>]*>|[A-Za-z]:[\\/][^\r\n>]*>|[>$#])\s*$/m.test(plain);
}

function sessionActivity(session: SessionInfo): SessionActivity {
  if (sessionActivities.has(session.id)) return sessionActivities.get(session.id)!;
  return session.status === 'running' ? 'waiting' : 'finished';
}

function sessionActivityLabel(activity: SessionActivity): string {
  return activity === 'working' ? 'WORKING' : activity === 'waiting' ? 'WAITING' : activity === 'finished' ? 'FINISHED' : activity === 'error' ? 'ERROR' : 'STOPPED';
}

function updateTerminalHeaderState(sessionId: string): void {
  const session = getSession(sessionId);
  const instance = terminals.get(sessionId);
  if (!session || !instance) return;
  const badge = instance.surface.querySelector<HTMLElement>('.live-label');
  const label = instance.surface.querySelector<HTMLElement>('.live-label-text');
  const activity = session.status === 'running' ? sessionActivity(session) : session.status === 'exited' ? 'finished' : 'stopped';
  if (label) label.textContent = sessionActivityLabel(activity);
  if (badge) badge.dataset.state = activity;
}

const terminalWriteChunkSize = 64 * 1024;

function scheduleTerminalHeaderState(sessionId: string): void {
  if (closingSessionIds.has(sessionId) || ignoredSessionIds.has(sessionId)) return;
  const instance = terminals.get(sessionId);
  if (!instance) return;
  if (!instance.surface.dataset.headerUpdateQueued) {
    instance.surface.dataset.headerUpdateQueued = 'true';
    window.requestAnimationFrame(() => {
      instance.surface.dataset.headerUpdateQueued = 'false';
      updateTerminalHeaderState(sessionId);
    });
  }
}

function scheduleTerminalOutputFlush(sessionId: string): void {
  const queue = terminalOutputQueues.get(sessionId);
  if (!queue || queue.frame !== undefined || queue.writing || !queue.data) return;
  queue.frame = window.requestAnimationFrame(() => {
    queue.frame = undefined;
    if (closingSessionIds.has(sessionId) || ignoredSessionIds.has(sessionId)) {
      terminalOutputQueues.delete(sessionId);
      return;
    }
    flushTerminalOutput(sessionId);
  });
}

function flushTerminalOutput(sessionId: string): void {
  if (closingSessionIds.has(sessionId) || ignoredSessionIds.has(sessionId)) {
    clearTerminalOutputQueue(sessionId);
    return;
  }
  const queue = terminalOutputQueues.get(sessionId);
  if (!queue || queue.writing || !queue.data) return;
  const instance = terminals.get(sessionId);
  if (!instance) {
    pendingOutput.set(sessionId, `${pendingOutput.get(sessionId) ?? ''}${queue.data}`.slice(-30000));
    terminalOutputQueues.delete(sessionId);
    return;
  }

  const chunk = queue.data.slice(0, terminalWriteChunkSize);
  queue.data = queue.data.slice(chunk.length);
  queue.writing = true;
  instance.terminal.write(chunk, () => {
    queue.writing = false;
    scheduleTerminalOutputFlush(sessionId);
  });
}

function queueTerminalOutput(sessionId: string, data: string): void {
  if (!data || closingSessionIds.has(sessionId) || ignoredSessionIds.has(sessionId)) return;
  const queue = terminalOutputQueues.get(sessionId) ?? { data: '', frame: undefined, writing: false };
  queue.data += data;
  terminalOutputQueues.set(sessionId, queue);
  scheduleTerminalOutputFlush(sessionId);
}

function clearTerminalOutputQueue(sessionId: string): void {
  const queue = terminalOutputQueues.get(sessionId);
  if (queue?.frame !== undefined) window.cancelAnimationFrame(queue.frame);
  terminalOutputQueues.delete(sessionId);
}

async function detectAgentCommand(sessionId: string, line: string): Promise<void> {
  const command = line.trim().replace(/^&\s*/, '');
  const match = command.match(/^(?:(?:npx|pnpm\s+dlx|bunx)\s+)?(?:\.?[\\/])?(claude|codex|opencode|gemini|cursor-agent|aider)(?:\.(?:ps1|cmd|bat|exe))?(?:\s|$)/i);
  if (!match) return;
  const agent = detectedAgents.find((candidate) => candidate.id.toLowerCase() === match[1].toLowerCase() && candidate.installed);
  const session = getSession(sessionId);
  if (!agent || !session || session.agentType === agent.id) return;
  const nextName = uniqueSessionName(agent.name, sessionId);
  if (!nextName) return;
  const launch = sessionLaunches.get(sessionId);
  const detectedLaunch: SessionLaunchOptions = { ...(launch ?? {}), agentType: agent.id, program: launch?.program ?? agent.executable };
  try {
    const previousName = session.name;
    const renamed = await invoke<SessionInfo>('rename_session', { sessionId, name: nextName });
    if (previousName !== renamed.name) {
      removeSessionDefinition({ ...session, name: previousName });
    }
    Object.assign(session, renamed);
    session.agentType = agent.id;
    sessionLaunches.set(sessionId, detectedLaunch);
    persistSessionDefinition(renamed, detectedLaunch);
    scheduleRender();
    showToast(agent.name + ' detectado en ' + nextName + '.');
  } catch {
    session.agentType = agent.id;
    sessionLaunches.set(sessionId, detectedLaunch);
    persistSessionDefinition(session, detectedLaunch);
    scheduleRender();
    // El comando real sigue ejecutándose aunque el metadato no pueda renombrarse.
  }
}

function observeTerminalInput(sessionId: string, data: string): void {
  let buffer = terminalInputBuffers.get(sessionId) ?? '';
  let escapeSequence = false;
  for (const character of data) {
    if (escapeSequence) {
      if (/[A-Za-z~]/.test(character)) escapeSequence = false;
      continue;
    }
    if (character === '\u001b') {
      escapeSequence = true;
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (buffer.trim()) void detectAgentCommand(sessionId, buffer);
      buffer = '';
      continue;
    }
    if (character === '\u0003') {
      buffer = '';
      continue;
    }
    if (character === '\u0008' || character === '\u007f') {
      buffer = buffer.slice(0, -1);
      continue;
    }
    if (character >= ' ') buffer = (buffer + character).slice(-1024);
  }
  terminalInputBuffers.set(sessionId, buffer);
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? 'null') as T | null;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function setStoredValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    showToast('No se pudo guardar el estado local del workspace.', true);
  }
  if (nativePersistenceReady) {
    void invoke('save_local_state', { key, value }).catch((error) => showToast('No se pudo guardar la base local: ' + String(error), true));
  }
}

async function hydrateNativePersistence(): Promise<void> {
  try {
    const nativeState = await invoke<Record<string, string>>('load_local_state');
    const migrations: Promise<unknown>[] = [];
    for (const key of Object.values(storageKeys)) {
      const nativeValue = nativeState[key];
      const browserValue = window.localStorage.getItem(key);
      if (browserValue === null && typeof nativeValue === 'string') {
        // A new WebView can have an empty localStorage while SQLite already
        // contains the user's workspaces and layout.
        window.localStorage.setItem(key, nativeValue);
      } else if (browserValue !== null && browserValue !== nativeValue) {
        // The first paint is interactive. Keep the WebView value when both
        // stores exist so a click made during startup cannot be overwritten by
        // a slower SQLite hydration; then reconcile SQLite with that value.
        migrations.push(invoke('save_local_state', { key, value: browserValue }));
      }
    }
    await Promise.all(migrations);
    nativePersistenceReady = true;
  } catch (error) {
    nativePersistenceReady = false;
    console.warn('Persistencia nativa no disponible; se conserva el estado local del WebView.', error);
  }
}

function saveWorkspaces(): void {
  try {
    setStoredValue(storageKeys.workspaces, JSON.stringify(workspaces));
    setStoredValue(storageKeys.activeWorkspace, activeWorkspaceId ?? '');
  } catch {
    showToast('No se pudieron guardar los workspaces localmente.', true);
  }
}

function loadWorkspaces(): void {
  workspaces.length = 0;
  const stored = readJson<unknown[]>(storageKeys.workspaces, []);
  if (Array.isArray(stored)) {
    for (const candidate of stored) {
      if (!candidate || typeof candidate !== 'object') continue;
      const value = candidate as Partial<WorkspaceInfo>;
      if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.path !== 'string') continue;
      if (!value.name.trim() || !value.path.trim()) continue;
      workspaces.push({ id: value.id, name: value.name.trim(), path: value.path.trim(), createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString() });
    }
  }
  const storedActive = window.localStorage.getItem(storageKeys.activeWorkspace);
  activeWorkspaceId = workspaces.some((workspace) => workspace.id === storedActive) ? storedActive : workspaces[0]?.id ?? null;
}

function saveSessionDefinitions(): void {
  if (!activeWorkspaceId) return;
  const store = readJson<Record<string, unknown>>(storageKeys.sessions, {});
  store[activeWorkspaceId] = savedSessions.slice(-30);
  setStoredValue(storageKeys.sessions, JSON.stringify(store));
}

function loadSessionDefinitions(): void {
  savedSessions.length = 0;
  currentGitWorktrees = [];
  currentGitWorktreeRoot = null;
  currentGitWorktreeState = 'unknown';
  if (!activeWorkspaceId) return;
  const store = readJson<Record<string, unknown>>(storageKeys.sessions, {});
  const values = store[activeWorkspaceId];
  if (!Array.isArray(values)) return;
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<SavedSession>;
    if (typeof candidate.name !== 'string' || typeof candidate.cwd !== 'string' || !candidate.options || typeof candidate.options !== 'object') continue;
    savedSessions.push({ name: candidate.name, cwd: candidate.cwd, options: candidate.options as SessionLaunchOptions, lastStatus: typeof candidate.lastStatus === 'string' ? candidate.lastStatus : 'stopped' });
  }
}

function persistSessionDefinition(session: SessionInfo, options: SessionLaunchOptions): void {
  if (!activeWorkspaceId) return;
  const existing = savedSessions.find((item) => item.name === session.name && sameFsPath(item.cwd, session.cwd));
  const value: SavedSession = { name: session.name, cwd: session.cwd, options: { ...options }, lastStatus: session.status };
  if (existing) Object.assign(existing, value);
  else savedSessions.push(value);
  saveSessionDefinitions();
}

function removeSessionDefinition(session: SessionInfo): void {
  const index = savedSessions.findIndex((item) => item.name === session.name && sameFsPath(item.cwd, session.cwd));
  if (index >= 0) {
    savedSessions.splice(index, 1);
    saveSessionDefinitions();
  }
}

async function restoreSavedSession(index: number): Promise<void> {
  const saved = savedSessions[index];
  if (!saved) return;
  const session = await createSession(saved.name, saved.cwd, saved.options);
  if (session) showToast(`${session.name} relanzada como proceso real.`);
}

function loadSettings(): void {
  const stored = readJson<Partial<AppSettings>>(storageKeys.settings, {});
  const cursor = stored.terminalCursor === 'block' || stored.terminalCursor === 'underline' ? stored.terminalCursor : 'bar';
  const environment: Record<string, string> = {};
  if (stored.environment && typeof stored.environment === 'object') {
    for (const [key, value] of Object.entries(stored.environment)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') environment[key] = value.slice(0, 4000);
    }
  }
  const customAgents: CustomAgentDefinition[] = [];
  if (Array.isArray(stored.customAgents)) {
    for (const item of stored.customAgents) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as Partial<CustomAgentDefinition>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, 120) : '';
      const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 120) : '';
      const executable = typeof candidate.executable === 'string' ? candidate.executable.trim().slice(0, 500) : '';
      if (!id || !name || !executable) continue;
      const args = Array.isArray(candidate.args)
        ? candidate.args.filter((value): value is string => typeof value === 'string').map((value) => value.slice(0, 400)).slice(0, 32)
        : [];
      const environment: Record<string, string> = {};
      if (candidate.environment && typeof candidate.environment === 'object') {
        for (const [key, value] of Object.entries(candidate.environment)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') environment[key] = value.slice(0, 4000);
        }
      }
      customAgents.push({ id, name, executable, args, environment });
    }
  }
  appSettings = {
    backgroundAnimation: stored.backgroundAnimation !== false,
    defaultShell: typeof stored.defaultShell === 'string' && stored.defaultShell.trim() ? stored.defaultShell.trim() : runtimePlatform.defaultShell,
    terminalFont: typeof stored.terminalFont === 'string' && stored.terminalFont.trim() ? stored.terminalFont.trim().slice(0, 160) : defaultTerminalFont(),
    terminalFontSize: typeof stored.terminalFontSize === 'number' ? Math.min(Math.max(Math.round(stored.terminalFontSize), 10), 28) : 15,
    terminalCursor: cursor,
    terminalScrollback: typeof stored.terminalScrollback === 'number' ? Math.min(Math.max(Math.round(stored.terminalScrollback), 1000), 100000) : 12000,
    defaultAgent: typeof stored.defaultAgent === 'string' ? stored.defaultAgent.trim().slice(0, 120) : '',
    worktreeDirectory: typeof stored.worktreeDirectory === 'string' ? stored.worktreeDirectory.trim().slice(0, 500) : '',
    environment,
    customAgents,
    geminiTheme: stored.geminiTheme === true,
  };
  applySettings();
}

function normalizeDefaultShell(): void {
  const installed = detectedShells.filter((shell) => shell.installed);
  const selected = installed.find((shell) => shell.id === appSettings.defaultShell);
  const platformDefault = installed.find((shell) => shell.isDefault)
    ?? installed.find((shell) => shell.id === runtimePlatform.defaultShell)
    ?? installed[0];
  if (!selected && platformDefault) {
    appSettings = { ...appSettings, defaultShell: platformDefault.id };
    saveSettings();
  }
  updateShellLabels();
}

function fallbackShellDefinition(): ShellDefinition {
  return {
    id: runtimePlatform.defaultShell,
    name: runtimePlatform.defaultShellName,
    executable: runtimePlatform.defaultShell,
    path: null,
    installed: true,
    isDefault: true,
  };
}

function activeShellName(): string {
  return detectedShells.find((shell) => shell.id === appSettings.defaultShell)?.name
    ?? runtimePlatform.defaultShellName;
}

function compactShellName(value: string): string {
  const normalized = value.trim();
  if (/^windows\s+powershell$/i.test(normalized)) return 'PowerShell';
  if (/^(command\s+prompt|windows\s+command\s+processor|cmd)$/i.test(normalized)) return 'CMD';
  return normalized.replace(/^Windows\s+/i, '');
}

function compactPathLabel(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function updateShellLabels(): void {
  const shellName = activeShellName();
  const emptyCopy = document.querySelector<HTMLElement>('#terminal-empty small');
  if (emptyCopy) emptyCopy.textContent = `Abre un ${shellName} real cuando lo necesites.`;
  const emptyButton = document.querySelector<HTMLElement>('#terminal-empty-new span');
  if (emptyButton) emptyButton.textContent = `Open ${shellName}`;
  const summaryShell = document.querySelector<HTMLButtonElement>('#summary-shell');
  if (summaryShell) summaryShell.title = `Abrir un ${shellName} real`;
  const contextSession = document.querySelector<HTMLButtonElement>('#workspace-context-session');
  if (contextSession) contextSession.title = `Abrir una nueva ${shellName} real`;
  const newSessionButton = document.querySelector<HTMLButtonElement>('#sidebar-new-session');
  if (newSessionButton) newSessionButton.title = `Nueva ${shellName}`;
}

function saveSettings(): void {
  setStoredValue(storageKeys.settings, JSON.stringify(appSettings));
}

function rememberCustomAgent(name: string, executable: string, args: string[]): CustomAgentDefinition {
  const cleanedExecutable = executable.trim().slice(0, 500);
  const cleanedName = name.trim().slice(0, 120) || compactPathLabel(cleanedExecutable) || 'Custom CLI';
  const cleanedArgs = args.filter((value) => value.trim()).map((value) => value.slice(0, 400)).slice(0, 32);
  const existing = appSettings.customAgents.find((agent) => agent.executable.toLowerCase() === cleanedExecutable.toLowerCase());
  const agent: CustomAgentDefinition = existing
    ? { ...existing, name: cleanedName, args: cleanedArgs }
    : {
      id: `custom-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      name: cleanedName,
      executable: cleanedExecutable,
      args: cleanedArgs,
      environment: {},
    };
  appSettings = {
    ...appSettings,
    customAgents: [...appSettings.customAgents.filter((item) => item.id !== agent.id), agent].slice(-32),
  };
  saveSettings();
  return agent;
}

function applySettings(): void {
  app?.classList.toggle('motion-off', !appSettings.backgroundAnimation);
  app?.classList.toggle('theme-gemini', appSettings.geminiTheme);
  for (const instance of terminals.values()) {
    instance.terminal.options.fontFamily = appSettings.terminalFont;
    instance.terminal.options.fontSize = appSettings.terminalFontSize;
    instance.terminal.options.cursorStyle = appSettings.terminalCursor;
    instance.terminal.options.scrollback = appSettings.terminalScrollback;
  }
}

function loadLayout(): void {
  const stored = readJson<Partial<LayoutState>>(storageKeys.layout, {});
  const width = typeof stored.sidebarWidth === 'number' ? stored.sidebarWidth : 258;
  const inspectorWidth = typeof stored.inspectorWidth === 'number' ? stored.inspectorWidth : 268;
  const developerEditorShare = typeof stored.developerEditorShare === 'number' ? stored.developerEditorShare : 0.58;
  const height = typeof stored.terminalHeight === 'number' ? stored.terminalHeight : 300;
  layoutState.sidebarWidth = Math.min(Math.max(Math.round(width), 218), 390);
  layoutState.inspectorWidth = Math.min(Math.max(Math.round(inspectorWidth), 220), 420);
  layoutState.developerEditorShare = Math.min(Math.max(developerEditorShare, 0.32), 0.75);
  layoutState.terminalHeight = Math.min(Math.max(Math.round(height), 190), Math.max(190, Math.round(window.innerHeight * 0.68)));
  terminalHeight = layoutState.terminalHeight;
  layoutState.developerDockCollapsed = stored.developerDockCollapsed === true;
  developerDockCollapsed = layoutState.developerDockCollapsed;
  layoutState.sidebarCollapsed = stored.sidebarCollapsed === true;
  layoutState.inspectorCollapsed = stored.inspectorCollapsed === true;
  inspectorCollapsed = layoutState.inspectorCollapsed;
  layoutState.view = isLayoutView(stored.view) ? stored.view : 'overview';
  layoutState.workspaces = {};
  if (stored.workspaces && typeof stored.workspaces === 'object') {
    for (const [workspaceId, value] of Object.entries(stored.workspaces as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Partial<WorkspaceLayoutState>;
      const openFilePaths = Array.isArray(candidate.openFilePaths)
        ? candidate.openFilePaths.filter((path): path is string => typeof path === 'string').map((path) => normalizedRelativePath(path)).filter(Boolean).slice(0, 24)
        : [];
      const terminalOrder = Array.isArray(candidate.terminalOrder)
        ? candidate.terminalOrder.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).slice(0, 64)
        : [];
      const terminalSizes: Record<string, { width: number; height: number }> = {};
      if (candidate.terminalSizes && typeof candidate.terminalSizes === 'object') {
        for (const [sessionId, value] of Object.entries(candidate.terminalSizes)) {
          if (!value || typeof value !== 'object') continue;
          const size = value as Partial<{ width: number; height: number }>;
          if (typeof size.width !== 'number' || typeof size.height !== 'number') continue;
          terminalSizes[sessionId] = {
            width: Math.min(Math.max(Math.round(size.width), 260), 2400),
            height: Math.min(Math.max(Math.round(size.height), 220), 1600),
          };
        }
      }
      layoutState.workspaces[workspaceId] = {
        view: isLayoutView(candidate.view) ? candidate.view : 'overview',
        openFilePath: typeof candidate.openFilePath === 'string' ? candidate.openFilePath : null,
        openFilePaths,
        terminalOrder,
        terminalSizes,
        browserUrl: typeof candidate.browserUrl === 'string' ? candidate.browserUrl : null,
        localhostUrl: typeof candidate.localhostUrl === 'string' ? candidate.localhostUrl : null,
      };
    }
  }
  applyLayout();
  syncResponsiveLayout(true);
}

function saveLayout(): void {
  try {
    setStoredValue(storageKeys.layout, JSON.stringify(layoutState));
  } catch {
    showToast('No se pudo guardar el layout localmente.', true);
  }
}

function saveWorkspaceLayout(patch: Partial<WorkspaceLayoutState>): void {
  if (!activeWorkspaceId) return;
  layoutState.workspaces[activeWorkspaceId] = { ...layoutState.workspaces[activeWorkspaceId], ...patch };
  saveLayout();
}

function applyLayout(): void {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const workspaceMain = document.querySelector<HTMLElement>('.workspace-main');
  const sidebarToggle = document.querySelector<HTMLButtonElement>('#titlebar-layout');
  shell?.style.setProperty('--sidebar-width', String(layoutState.sidebarWidth) + 'px');
  shell?.style.setProperty('--inspector-width', String(layoutState.inspectorWidth) + 'px');
  document.querySelector<HTMLElement>('.developer-dock')?.style.setProperty('--developer-editor-share', String(layoutState.developerEditorShare));
  terminalArea.style.setProperty('--terminal-height', String(layoutState.terminalHeight) + 'px');
  syncDeveloperDockVisibility();
  shell?.classList.toggle('sidebar-collapsed', layoutState.sidebarCollapsed);
  shell?.classList.toggle('inspector-collapsed', layoutState.inspectorCollapsed);
  if (sidebarToggle) {
    const sidebarVisible = !layoutState.sidebarCollapsed;
    sidebarToggle.setAttribute('aria-expanded', String(sidebarVisible));
    sidebarToggle.setAttribute('aria-label', sidebarVisible ? 'Ocultar la barra lateral' : 'Mostrar la barra lateral');
    sidebarToggle.title = sidebarVisible ? 'Ocultar la barra lateral' : 'Mostrar la barra lateral';
    sidebarToggle.innerHTML = sidebarVisible ? icons.close : icons.menu;
  }
  workspaceMain?.classList.remove('view-overview', 'view-asa', 'view-terminals', 'view-tools');
  workspaceMain?.classList.add(`view-${layoutState.view}`);
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((item) => item.classList.toggle('is-active', item.dataset.view === layoutState.view));
}

function syncResponsiveLayout(force = false): void {
  const nextCompactViewport = window.innerWidth <= 760;
  const viewportChanged = nextCompactViewport !== compactViewport;

  if (nextCompactViewport && (force || !responsiveLayoutInitialized || viewportChanged)) {
    if (!layoutState.sidebarCollapsed) {
      layoutState.sidebarCollapsed = true;
      applyLayout();
    }
  } else if (!nextCompactViewport && responsiveLayoutInitialized && viewportChanged && layoutState.sidebarCollapsed) {
    layoutState.sidebarCollapsed = false;
    applyLayout();
  }

  compactViewport = nextCompactViewport;
  responsiveLayoutInitialized = true;
}

async function restoreWorkspaceLayout(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  const saved = layoutState.workspaces[workspace.id];
  const requestedFiles = saved?.openFilePaths?.length ? saved.openFilePaths : (saved?.openFilePath ? [saved.openFilePath] : []);
  const filePaths = [...requestedFiles.filter((path) => path !== saved?.openFilePath), ...(saved?.openFilePath ? [saved.openFilePath] : [])];
  for (const path of filePaths.slice(0, 24)) await openWorkspaceFile(path);
  if (saved?.browserUrl && ![...browserPanels.values()].some((panel) => panel.url === saved.browserUrl)) createBrowserPanel(saved.browserUrl);
  if (saved?.localhostUrl && ![...localhostPanels.values()].some((panel) => panel.url === saved.localhostUrl)) createLocalhostPanel(saved.localhostUrl);
  const savedView = isLayoutView(saved?.view) ? saved.view : layoutState.view;
  setView(savedView);
}

function notesStore(): Record<string, string> {
  return readJson<Record<string, string>>(storageKeys.notes, {});
}

function loadNotes(): void {
  if (notesLoadedWorkspaceId === activeWorkspaceId) return;
  notesInput.value = activeWorkspaceId ? notesStore()[activeWorkspaceId] ?? '' : '';
  notesStatus.textContent = activeWorkspaceId ? 'SAVED' : 'LOCKED';
  notesLoadedWorkspaceId = activeWorkspaceId;
}

function scheduleNoteSave(): void {
  if (!activeWorkspaceId) {
    notesStatus.textContent = 'LOCKED';
    return;
  }
  notesStatus.textContent = 'SAVING';
  if (noteSaveTimer) window.clearTimeout(noteSaveTimer);
  noteSaveTimer = window.setTimeout(() => {
    const notes = notesStore();
    notes[activeWorkspaceId!] = notesInput.value;
    setStoredValue(storageKeys.notes, JSON.stringify(notes));
    notesStatus.textContent = 'SAVED';
  }, 260);
}

async function writeToSession(sessionId: string, data: string): Promise<void> {
  await invoke('write_to_session', { sessionId, data });
}
function updateWorkspaceView(): void {
  const workspace = getWorkspace();
  const locked = !workspace;
  document.querySelector<HTMLElement>('.workspace-main')?.classList.toggle('workspace-locked', locked);
  workspaceLock.hidden = !locked;
  activeWorkspaceCard.hidden = locked;
  sidebarProjectEmpty.hidden = !locked;
  sessionList.hidden = locked;
  activeWorkspaceName.textContent = workspace?.name ?? 'Sin workspace';
  activeWorkspacePath.textContent = workspace?.path ?? 'CREA UNO PARA EMPEZAR';
  workspaceHeading.textContent = workspace?.name ?? 'Sin workspace seleccionado';
  workspaceHeaderPath.textContent = workspace?.path ?? 'Crea o abre un workspace para comenzar.';
  workspaceSummaryName.textContent = workspace?.name ?? 'Sin workspace';
  workspaceSummaryPath.textContent = workspace?.path ?? 'Crea o abre una carpeta para comenzar.';
  overviewSessionCount.textContent = String(sessions.filter((session) => !exitedSessions.has(session.id)).length);
  const liveActiveSession = Boolean(getLiveSession(activeSessionId));
  overviewActiveLabel.textContent = workspace ? (liveActiveSession ? 'ACTIVE' : 'READY') : 'LOCKED';
  overviewPathShort.textContent = workspace ? compactPathLabel(workspace.path) : '—';
  overviewPathDetail.textContent = workspace?.path ?? 'Sin workspace';
  overviewRuntimeStatus.textContent = workspace ? (liveActiveSession ? 'LIVE' : 'READY') : 'LOCKED';
  overviewShell.textContent = workspace ? activeShellName() : 'Sin shell';
  activeSessionLabel.textContent = getLiveSession(activeSessionId)?.name ?? 'Sin sesión activa';
  commandCwd.textContent = getLiveSession(activeSessionId)?.cwd ?? workspace?.path ?? 'Sin directorio activo';
  commandLive.textContent = getLiveSession(activeSessionId) ? sessionActivityLabel(sessionActivity(getLiveSession(activeSessionId)!)).toUpperCase() : 'WAITING';
  // El centro queda reservado para superficies PTY reales. La acción para
  // abrir una terminal vive en la cabecera y no invade el lienzo central.
  terminalEmpty.hidden = true;
  terminalEmpty.setAttribute('aria-hidden', 'true');
  notesInput.disabled = locked;
  loadNotes();
  applyInspectorTabVisibility();
  renderInspectorPanels();
}

let currentGitStatus: GitStatusResult | null = null;
let currentGitWorktrees: GitWorktree[] = [];
let currentGitWorktreeRoot: string | null = null;
let currentGitWorktreeState: 'unknown' | 'ready' | 'unavailable' = 'unknown';
let gitAvailability: GitAvailability | null = null;
let gitInstallInFlight: Promise<boolean> | null = null;
let gitInstallPrompted = false;

function applyInspectorTabVisibility(): void {
  const locked = !getWorkspace();
  workspaceInspectorEmpty.hidden = !locked;
  workspaceFileExplorer.hidden = locked || activeInspectorTab !== 'explorer';
  inspectorOverviewPane.hidden = locked || activeInspectorTab !== 'overview';
  inspectorGitPane.hidden = locked || activeInspectorTab !== 'git';
  inspectorSessionsPane.hidden = locked || activeInspectorTab !== 'sessions';
  document.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]').forEach((button) => {
    const active = button.dataset.inspectorTab === activeInspectorTab;
    button.classList.toggle('inspector-tab-active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function renderInspectorPanels(): void {
  const workspace = getWorkspace();
  const liveSessions = sessions.filter((session) => !exitedSessions.has(session.id));
  inspectorOverviewName.textContent = workspace?.name ?? 'Sin workspace';
  inspectorOverviewPath.textContent = workspace?.path ?? 'Crea o abre un workspace para comenzar.';
  inspectorOverviewSessions.textContent = String(liveSessions.length);
  inspectorOverviewRuntime.textContent = workspace ? (getLiveSession(activeSessionId) ? 'LIVE' : 'READY') : 'LOCKED';
  inspectorGitBranch.textContent = workspace ? (currentGitStatus?.branch || gitBranch.textContent || 'NO REPOSITORY') : 'NO WORKSPACE';
  if (!workspace) {
    inspectorGitContent.innerHTML = '<div class="dock-empty">Selecciona un workspace para consultar Git.</div>';
  } else if (currentGitStatus) {
    inspectorGitContent.innerHTML = currentGitStatus.entries.length
      ? currentGitStatus.entries.map((entry) => '<div class="inspector-git-row"><span class="git-item-kind">' + escapeHtml(entry.indexStatus + entry.worktreeStatus) + '</span><span>' + escapeHtml(entry.path) + '</span></div>').join('')
      : '<div class="dock-empty">Working tree clean.</div>';
  } else {
    inspectorGitContent.innerHTML = '<div class="dock-empty">No es un repositorio Git o todavía no se ha consultado.</div>';
  }
  inspectorSessionCount.textContent = String(liveSessions.length);
  inspectorSessionsList.innerHTML = liveSessions.length
    ? liveSessions.map((session) => '<button class="inspector-session-item" data-inspector-session="' + escapeHtml(session.id) + '" type="button"><span class="session-avatar">' + escapeHtml(session.name.charAt(0).toUpperCase()) + '</span><span><strong>' + escapeHtml(session.name) + '</strong><small>' + escapeHtml(sessionActivityLabel(sessionActivity(session))) + '</small></span><span class="inspector-session-status">' + (session.id === activeSessionId ? 'FOCUSED' : 'FOCUS') + '</span></button>').join('')
    : '<div class="dock-empty">No hay sesiones abiertas.</div>';
}

function setInspectorTab(tab: string): void {
  if (tab !== 'explorer' && tab !== 'overview' && tab !== 'git' && tab !== 'sessions') return;
  activeInspectorTab = tab;
  applyInspectorTabVisibility();
  renderInspectorPanels();
  if (tab === 'explorer' && getWorkspace()) void refreshFileTree();
  if (tab === 'git' && getWorkspace()) void refreshGitPanel();
}

async function refreshFileTree(relative = fileTreeRelativePath): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    filesBack.disabled = true;
    fileTree.innerHTML = '<div class="dock-empty">Abre un workspace para ver sus archivos.</div>';
    return;
  }
  const normalizedRelative = normalizedRelativePath(relative);
  fileTreeRelativePath = normalizedRelative;
  filesBack.disabled = !normalizedRelative;
  fileTreePath.textContent = normalizedRelative || compactPathLabel(workspace.path);
  const root = activeProjectRoot() ?? workspace.path;
  try {
    const entries = await invoke<FsEntry[]>('list', { root, relative: normalizedRelative || null });
    if (getWorkspace()?.id !== workspace.id || !sameFsPath(activeProjectRoot() ?? workspace.path, root)) return;
    const query = inspectorSearchInput.value.trim().toLowerCase();
    const visibleEntries = entries
      .filter((entry) => inspectorFilterMode === 'names' ? !query || entry.name.toLowerCase().includes(query) : true)
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
        return fileSortMode === 'type'
          ? `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
          : left.name.localeCompare(right.name);
      });
    fileTree.innerHTML = visibleEntries.length ? visibleEntries.map((entry) => {
      const icon = entry.kind === 'directory' ? icons.folder : icons.note;
      const action = entry.kind === 'directory' ? 'data-file-dir' : 'data-file-path';
      return '<button class="file-tree-item file-tree-item-' + entry.kind + '" ' + action + '="' + escapeHtml(entry.path) + '" title="' + escapeHtml(entry.name) + '" type="button">' + icon + '<span>' + escapeHtml(entry.name) + '</span></button>';
    }).join('') : '<div class="dock-empty">Carpeta vacia.</div>';
    if (normalizedRelative) {
      const up = document.createElement('button');
      up.className = 'file-tree-item file-tree-up';
      up.dataset.fileUp = 'true';
      up.type = 'button';
      up.textContent = '..';
      fileTree.prepend(up);
    }
  } catch (error) {
    fileTree.innerHTML = '<div class="dock-empty dock-empty-error">' + escapeHtml(String(error)) + '</div>';
  }
}

function workspaceAbsolutePath(workspace: WorkspaceInfo, relative: string): string {
  const root = activeProjectRoot() ?? workspace.path;
  const normalizedRoot = root.replace(/[\\/]+$/, '') || '/';
  return normalizedRoot + '/' + relative.replace(/[\\/]+/g, '/');
}

function normalizedFsPath(value: string): string {
  const normalized = value.replace(/[\\/]+/g, '/');
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
}

function fsPathKey(value: string): string {
  const normalized = normalizedFsPath(value);
  return runtimePlatform.os === 'windows' ? normalized.toLowerCase() : normalized;
}

function sameFsPath(left: string | null, right: string | null): boolean {
  return Boolean(left && right && fsPathKey(left) === fsPathKey(right));
}

function isSameOrInsideFsPath(candidate: string, root: string): boolean {
  const candidateKey = fsPathKey(candidate);
  const rootKey = fsPathKey(root);
  if (candidateKey === rootKey) return true;
  return candidateKey.startsWith(rootKey.endsWith('/') ? rootKey : rootKey + '/');
}

function prepareEditorForRootChange(nextRoot: string | null): boolean {
  if (!openFilePath) return true;
  if (openFileRoot && nextRoot && sameFsPath(openFileRoot, nextRoot)) return true;
  if (openFileDirty && !window.confirm('Hay cambios sin guardar. ¿Descartarlos al cambiar de proyecto?')) return false;
  clearOpenFile();
  return true;
}

function normalizedRelativePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function relativePathKey(value: string): string {
  const normalized = normalizedRelativePath(value);
  return runtimePlatform.os === 'windows' ? normalized.toLowerCase() : normalized;
}

function isSameOrInsideRelativePath(candidate: string | null, parent: string): boolean {
  if (!candidate) return false;
  const normalizedCandidate = relativePathKey(candidate);
  const normalizedParent = relativePathKey(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(normalizedParent + '/');
}

function remapOpenFilePath(source: string, destination: string): string | null {
  if (!openFilePath || !isSameOrInsideRelativePath(openFilePath, source)) return null;
  const openPath = normalizedRelativePath(openFilePath);
  const sourcePath = normalizedRelativePath(source);
  const suffix = openPath.slice(sourcePath.length).replace(/^\/+/, '');
  return suffix ? `${normalizedRelativePath(destination)}/${suffix}` : normalizedRelativePath(destination);
}

function updateOpenFilePath(path: string): void {
  const previousPath = openFilePath;
  const previousRoot = openFileRoot;
  openFilePath = path;
  const tab = openFileTabs.find((item) => previousPath && previousRoot && sameFsPath(item.root, previousRoot) && relativePathKey(item.path) === relativePathKey(previousPath));
  if (tab) tab.path = path;
  editorFileName.textContent = path.split(/[\\/]/).pop() ?? path;
  editorFilePath.textContent = path;
  renderEditorTabs();
  saveWorkspaceLayout({ openFilePath: path, openFilePaths: openFileTabs.map((item) => item.path).slice(-24) });
}

async function createWorkspaceEntry(kind: 'file' | 'directory'): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  const name = window.prompt(kind === 'file' ? 'Nombre del nuevo archivo (ruta relativa):' : 'Nombre de la nueva carpeta (ruta relativa):', fileTreeRelativePath ? fileTreeRelativePath + '/' : '');
  if (!name?.trim()) return;
  try {
    await invoke(kind === 'file' ? 'create_file' : 'create_directory', { root: activeProjectRoot() ?? workspace.path, relative: name.trim() });
    await refreshFileTree();
    showToast((kind === 'file' ? 'Archivo' : 'Carpeta') + ' creado en el filesystem real.');
  } catch (error) {
    showToast('No se pudo crear: ' + String(error), true);
  }
}

function openFileContextMenu(event: MouseEvent, relative: string): void {
  event.preventDefault();
  const workspace = getWorkspace();
  if (!workspace) return;
  document.querySelector<HTMLElement>('.file-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'file-context-menu';
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 180)}px`;
  menu.innerHTML = '<button data-context-action="rename" type="button">Rename</button><button data-context-action="move" type="button">Move</button><button data-context-action="delete" type="button">Delete</button><button data-context-action="reveal" type="button">Reveal in Explorer</button><button data-context-action="copy" type="button">Copy relative path</button><button data-context-action="copy-absolute" type="button">Copy absolute path</button>';
  document.body.appendChild(menu);
  const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', outside); };
  const outside = (pointerEvent: PointerEvent): void => { if (!menu.contains(pointerEvent.target as Node)) close(); };
  document.addEventListener('pointerdown', outside);
  menu.addEventListener('click', async (menuEvent) => {
    const action = (menuEvent.target as HTMLElement).closest<HTMLElement>('[data-context-action]')?.dataset.contextAction;
    close();
    try {
      if (action === 'rename') {
        const current = relative.split(/[\\/]/).pop() ?? relative;
        const next = window.prompt('Nuevo nombre:', current);
        if (next?.trim()) {
          const normalizedSource = normalizedRelativePath(relative);
          const parent = normalizedSource.includes('/') ? normalizedSource.slice(0, normalizedSource.lastIndexOf('/') + 1) : '';
          const destination = parent + next.trim();
          await invoke('rename', { root: activeProjectRoot() ?? workspace.path, relative, newName: next.trim() });
          const remapped = remapOpenFilePath(relative, destination);
          if (remapped) updateOpenFilePath(remapped);
        }
      } else if (action === 'move') {
        const destination = window.prompt('Ruta relativa de destino (incluye el nombre):', relative);
        if (destination?.trim()) {
          const nextPath = destination.trim();
          await invoke('move_path', { root: activeProjectRoot() ?? workspace.path, relative, destination: nextPath });
          const remapped = remapOpenFilePath(relative, nextPath);
          if (remapped) updateOpenFilePath(remapped);
        }
      } else if (action === 'delete') {
        if (!window.confirm('Esto eliminara el elemento real del disco. Continuar?')) return;
        await invoke('delete', { root: activeProjectRoot() ?? workspace.path, relative });
        if (isSameOrInsideRelativePath(openFilePath, relative)) clearOpenFile();
      } else if (action === 'reveal') {
        await invoke('reveal_path', { path: workspaceAbsolutePath(workspace, relative) });
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(relative);
        showToast('Ruta relativa copiada.');
      } else if (action === 'copy-absolute') {
        await navigator.clipboard.writeText(workspaceAbsolutePath(workspace, relative));
        showToast('Ruta absoluta copiada.');
      }
      await refreshFileTree(fileTreeRelativePath);
      await refreshGitPanel();
    } catch (error) {
      showToast('No se pudo completar la operacion: ' + String(error), true);
    }
  });
}

async function openWorkspaceFile(relative: string): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  syncCurrentOpenFileTab();
  if (openFileDirty && !window.confirm('Hay cambios sin guardar. ¿Abrir otro archivo?')) return;
  const requestId = ++fileOpenRequest;
  const workspaceId = workspace.id;
  const root = activeProjectRoot() ?? workspace.path;
  const normalizedRelative = normalizedRelativePath(relative);
  if (!normalizedRelative) return;
  const existing = openFileTabs.find((tab) => sameFsPath(tab.root, root) && relativePathKey(tab.path) === relativePathKey(normalizedRelative));
  try {
    const content = await invoke<string>('read', { root, relative: normalizedRelative });
    if (requestId !== fileOpenRequest || getWorkspace()?.id !== workspaceId || !sameFsPath(activeProjectRoot() ?? workspace.path, root)) return;
    const tab = existing ?? { path: normalizedRelative, root, content, dirty: false };
    if (!existing) openFileTabs.push(tab);
    if (!tab.dirty) tab.content = content;
    openFilePath = tab.path;
    openFileRoot = tab.root;
    openFileDirty = tab.dirty;
    setEditorValue(tab.content, tab.path);
    setEditorEnabled(true);
    editorFileName.textContent = tab.path.split('/').pop() ?? tab.path;
    editorFilePath.textContent = tab.path;
    editorSaveStatus.textContent = tab.dirty ? 'DIRTY' : 'CLEAN';
    renderEditorTabs();
    developerDockCollapsed = false;
    layoutState.developerDockCollapsed = false;
    saveWorkspaceLayout({ openFilePath: tab.path, openFilePaths: openFileTabs.map((item) => item.path).slice(-24) });
    syncDeveloperDockVisibility();
    // Monaco es pesado y no debe bloquear el arranque ni el menú principal.
    // Se carga únicamente cuando el usuario abre un archivo real.
    if (!codeEditor && !monacoLoadPromise) window.setTimeout(() => { if (openFilePath === tab.path) void setupMonacoEditor(); }, 0);
  } catch (error) {
    showToast('No se pudo leer el archivo real: ' + String(error), true);
  }
}

async function activateFileTab(path: string, rootHint?: string): Promise<void> {
  const workspace = getWorkspace();
  const root = rootHint ?? activeProjectRoot() ?? workspace?.path ?? openFileRoot ?? null;
  const current = openFileTabs.find((tab) => relativePathKey(tab.path) === relativePathKey(path) && (!root || sameFsPath(tab.root, root)));
  if (!workspace || !current) return;
  if (openFilePath && openFileRoot && sameFsPath(openFileRoot, current.root) && relativePathKey(openFilePath) === relativePathKey(current.path)) return;
  syncCurrentOpenFileTab();
  const requestId = ++fileOpenRequest;
  let content = current.content;
  try {
    if (!current.dirty) content = await invoke<string>('read', { root: current.root, relative: current.path });
    if (requestId !== fileOpenRequest || getWorkspace()?.id !== workspace.id) return;
    current.content = content;
    openFilePath = current.path;
    openFileRoot = current.root;
    openFileDirty = current.dirty;
    setEditorValue(current.content, current.path);
    setEditorEnabled(true);
    editorFileName.textContent = current.path.split('/').pop() ?? current.path;
    editorFilePath.textContent = current.path;
    editorSaveStatus.textContent = current.dirty ? 'DIRTY' : 'CLEAN';
    renderEditorTabs();
    developerDockCollapsed = false;
    layoutState.developerDockCollapsed = false;
    saveWorkspaceLayout({ openFilePath: current.path, openFilePaths: openFileTabs.map((item) => item.path).slice(-24) });
  } catch (error) {
    showToast('No se pudo abrir el archivo real: ' + String(error), true);
  }
}

async function closeFileTab(path: string, rootHint?: string): Promise<void> {
  const root = rootHint ?? activeProjectRoot() ?? getWorkspace()?.path ?? openFileRoot ?? null;
  const index = openFileTabs.findIndex((tab) => relativePathKey(tab.path) === relativePathKey(path) && (!root || sameFsPath(tab.root, root)));
  if (index < 0) return;
  syncCurrentOpenFileTab();
  const tab = openFileTabs[index];
  if (tab.dirty && !window.confirm('Hay cambios sin guardar en este archivo. ¿Cerrar la pestaña?')) return;
  const wasActive = Boolean(openFilePath && openFileRoot && sameFsPath(openFileRoot, tab.root) && relativePathKey(openFilePath) === relativePathKey(tab.path));
  openFileTabs.splice(index, 1);
  if (!openFileTabs.length) {
    clearOpenFile();
    return;
  }
  if (wasActive) {
    const next = openFileTabs[Math.min(index, openFileTabs.length - 1)];
    await activateFileTab(next.path, next.root);
  } else {
    renderEditorTabs();
    saveWorkspaceLayout({ openFilePaths: openFileTabs.map((item) => item.path).slice(-24) });
  }
}

async function saveWorkspaceFile(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace || !openFilePath) return;
  const workspaceId = workspace.id;
  const path = openFilePath;
  const root = openFileRoot ?? activeProjectRoot() ?? workspace.path;
  const content = editorValue();
  try {
    await invoke('write', { root, relative: path, content });
    if (getWorkspace()?.id !== workspaceId || openFilePath !== path || !sameFsPath(openFileRoot ?? activeProjectRoot() ?? workspace.path, root)) return;
    openFileDirty = false;
    const tab = currentOpenFileTab();
    if (tab) {
      tab.content = content;
      tab.dirty = false;
    }
    editorSaveStatus.textContent = 'SAVED';
    renderEditorTabs();
    saveWorkspaceLayout({ openFilePath: path, openFilePaths: openFileTabs.map((item) => item.path).slice(-24) });
    window.setTimeout(() => { if (!openFileDirty) editorSaveStatus.textContent = 'CLEAN'; }, 1400);
  } catch (error) {
    showToast('No se pudo guardar el archivo real: ' + String(error), true);
  }
}

async function loadGitDiff(relative: string): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  try {
    const versions = await invoke<GitFileVersions>('file_versions', { path: activeProjectRoot() ?? workspace.path, relative, staged: false });
    setDiffVersions(versions.original, versions.current, relative);
  } catch (error) {
    setDiffMessage(String(error));
  }
}

function gitEntryMarkup(entry: GitStatusEntry): string {
  const stage = entry.indexStatus === '?' || (entry.indexStatus === ' ' && entry.worktreeStatus !== ' ');
  const unstage = entry.indexStatus !== ' ' && entry.indexStatus !== '?';
  const discard = entry.worktreeStatus !== ' ' && entry.worktreeStatus !== '?';
  const action = stage ? '<button class="git-action" data-git-stage="' + escapeHtml(entry.path) + '" type="button">Stage</button>' : unstage ? '<button class="git-action" data-git-unstage="' + escapeHtml(entry.path) + '" type="button">Unstage</button>' : '';
  const discardAction = discard ? '<button class="git-action git-action-danger" data-git-discard="' + escapeHtml(entry.path) + '" type="button">Discard</button>' : '';
  return '<div class="git-item-row"><button class="git-item" data-git-path="' + escapeHtml(entry.path) + '" type="button"><span class="git-item-kind">' + escapeHtml(entry.indexStatus + entry.worktreeStatus) + '</span><span>' + escapeHtml(entry.path) + '</span></button><span class="git-item-actions">' + action + discardAction + '</span></div>';
}

async function ensureGitAvailable(): Promise<boolean> {
  if (gitAvailability?.available) return true;
  if (gitInstallInFlight) return gitInstallInFlight;

  let availability: GitAvailability;
  try {
    availability = await invoke<GitAvailability>('git_availability');
    gitAvailability = availability;
  } catch (error) {
    showToast('No se pudo comprobar Git: ' + String(error), true);
    return false;
  }
  if (availability.available) return true;
  if (gitInstallPrompted) return false;

  gitInstallPrompted = true;
  if (!window.confirm('Git no esta instalado en este PC. ComesADE puede instalar Git mediante el instalador oficial disponible. ¿Continuar?')) {
    gitInstallPrompted = false;
    return false;
  }

  const installPromise = (async (): Promise<boolean> => {
    try {
      showToast('Instalando Git. Puede aparecer una solicitud de permisos del sistema.');
      const installed = await invoke<GitAvailability>('install_git');
      gitAvailability = installed;
      if (!installed.available) {
        showToast('Git no quedo disponible despues de la instalacion.', true);
        return false;
      }
      showToast('Git instalado correctamente' + (installed.version ? ' (' + installed.version + ').' : '.'));
      return true;
    } catch (error) {
      gitInstallPrompted = false;
      showToast('No se pudo instalar Git: ' + String(error), true);
      return false;
    } finally {
      gitInstallInFlight = null;
    }
  })();
  gitInstallInFlight = installPromise;
  return installPromise;
}

async function refreshGitPanel(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    currentGitStatus = null;
    currentGitWorktrees = [];
    currentGitWorktreeRoot = null;
    currentGitWorktreeState = 'unavailable';
    gitBranch.textContent = 'NO WORKSPACE';
    gitList.innerHTML = '<div class="dock-empty">Abre un workspace para consultar Git.</div>';
    gitWorktreeList.innerHTML = '';
    setDiffMessage('Selecciona un cambio para ver el diff real.');
    renderInspectorPanels();
    renderAsaOverview();
    return;
  }
  if (!(await ensureGitAvailable())) {
    currentGitStatus = null;
    currentGitWorktrees = [];
    currentGitWorktreeRoot = workspace.path;
    currentGitWorktreeState = 'unavailable';
    gitBranch.textContent = 'GIT NOT INSTALLED';
    gitList.innerHTML = '<div class="dock-empty">Instala Git para consultar cambios, ramas y worktrees.</div>';
    gitWorktreeList.innerHTML = '<div class="dock-empty">Git no esta disponible.</div>';
    setDiffMessage('Instala Git para ver diffs reales.');
    renderInspectorPanels();
    renderAsaOverview();
    return;
  }
  try {
    const status = await invoke<GitStatusResult>('status', { path: activeProjectRoot() ?? workspace.path });
    if (getWorkspace()?.id !== workspace.id) return;
    currentGitStatus = status;
    gitBranch.textContent = status.branch || 'DETACHED';
    gitList.innerHTML = status.entries.length ? status.entries.map(gitEntryMarkup).join('') : '<div class="dock-empty">Working tree clean.</div>';
    await refreshWorktrees();
    renderInspectorPanels();
  } catch (error) {
    currentGitStatus = null;
    currentGitWorktrees = [];
    currentGitWorktreeRoot = workspace.path;
    currentGitWorktreeState = 'unavailable';
    gitBranch.textContent = 'NO REPOSITORY';
    gitList.innerHTML = '<div class="dock-empty">No es un repositorio Git: ' + escapeHtml(String(error)) + '</div>';
    gitWorktreeList.innerHTML = '<div class="dock-empty">No hay worktrees disponibles.</div>';
    setDiffMessage('Git no esta disponible para este workspace.');
    renderInspectorPanels();
    renderAsaOverview();
  }
}

async function refreshWorktrees(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    currentGitWorktrees = [];
    currentGitWorktreeRoot = null;
    currentGitWorktreeState = 'unavailable';
    renderAsaOverview();
    return;
  }
  try {
    const worktrees = await invoke<GitWorktree[]>('worktree_list', { path: workspace.path });
    if (getWorkspace()?.id !== workspace.id) return;
    currentGitWorktrees = worktrees;
    currentGitWorktreeRoot = workspace.path;
    currentGitWorktreeState = 'ready';
    gitWorktreeList.innerHTML = '<div class="git-subheading">WORKTREES</div>' + worktrees.map((worktree) => {
      const main = sameFsPath(worktree.path, workspace.path);
      const owner = sessions.find((session) => session.worktree ? sameFsPath(session.worktree, worktree.path) : false);
      const label = worktree.branch || (worktree.detached ? 'detached' : worktree.head.slice(0, 8));
      return '<div class="git-worktree-row"><span class="git-worktree-dot"></span><span class="git-worktree-copy"><strong>' + escapeHtml(label) + '</strong><small>' + escapeHtml(worktree.path) + (owner ? ' · ' + escapeHtml(owner.name) : '') + '</small></span>' + (main ? '<em>MAIN</em>' : '<button class="git-action git-action-danger" data-remove-worktree="' + escapeHtml(worktree.path) + '" type="button">Remove</button>') + '</div>';
    }).join('');
    const rows: HTMLElement[] = Array.from(gitWorktreeList.querySelectorAll('.git-worktree-row')) as HTMLElement[];
    worktrees.forEach((worktree, index) => {
      if (!worktree.branch || index >= rows.length || sameFsPath(worktree.path, workspace.path)) return;
      const row = rows[index];
      const actions = document.createElement('span');
      actions.className = 'git-worktree-actions';
      const review = document.createElement('button');
      review.className = 'git-action';
      review.type = 'button';
      review.textContent = 'Review';
      review.dataset.worktreeDiff = worktree.path;
      review.dataset.worktreeBranch = worktree.branch;
      const merge = document.createElement('button');
      merge.className = 'git-action';
      merge.type = 'button';
      merge.textContent = 'Merge';
      merge.dataset.mergeWorktree = worktree.branch;
      merge.dataset.mergeWorktreePath = worktree.path;
      const remove = row.querySelector('[data-remove-worktree]') as HTMLElement | null;
      if (remove) {
        remove.remove();
        actions.append(remove);
      }
      actions.prepend(merge);
      actions.prepend(review);
      row.append(actions);
    });
    renderAsaOverview();
  } catch {
    currentGitWorktrees = [];
    currentGitWorktreeRoot = workspace.path;
    currentGitWorktreeState = 'unavailable';
    gitWorktreeList.innerHTML = '<div class="dock-empty">No es un repositorio Git.</div>';
    renderAsaOverview();
  }
}

async function loadWorktreeDiff(worktreePath: string, branchName: string): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  try {
    const worktreeStatus = await invoke<GitStatusResult>('status', { path: worktreePath });
    const entry = worktreeStatus.entries[0];
    if (!entry) {
      showToast('Ese worktree no tiene cambios Git reales para revisar.');
      return;
    }
    let versions: GitFileVersions;
    if (entry.worktreeStatus !== ' ') {
      versions = await invoke<GitFileVersions>('file_versions', { path: worktreePath, relative: entry.path, staged: false });
    } else if (entry.indexStatus !== ' ') {
      versions = await invoke<GitFileVersions>('file_versions', { path: worktreePath, relative: entry.path, staged: true });
    } else {
      const mainStatus = await invoke<GitStatusResult>('status', { path: workspace.path });
      versions = await invoke<GitFileVersions>('file_versions_between', { path: workspace.path, relative: entry.path, originalRef: mainStatus.branch || 'HEAD', currentRef: branchName });
    }
    setView('terminals');
    setDiffVersions(versions.original, versions.current, entry.path);
  } catch (error) {
    setDiffMessage('No se pudo leer el diff real: ' + String(error));
  }
}

async function openGitBranchMenu(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast('Abre un workspace real antes de cambiar de rama.', true);
    return;
  }
  const root = activeProjectRoot() ?? workspace.path;
  let branches: GitBranch[];
  try {
    branches = await invoke<GitBranch[]>('branches', { path: root });
  } catch (error) {
    showToast('No se pudieron leer las ramas reales: ' + String(error), true);
    return;
  }
  const close = (): void => { modalRoot.innerHTML = ''; };
  modalRoot.innerHTML = '<div class="modal-backdrop" id="git-branch-backdrop"><section class="modal-panel git-branch-modal"><div class="modal-heading"><div><span class="eyebrow">GIT / BRANCHES</span><h2>Cambiar rama</h2></div><button class="modal-close" id="git-branch-close" type="button">' + icons.close + '</button></div><p class="modal-copy">Selecciona una rama local. Git rechazará el cambio si el working tree real no puede cambiar de forma segura.</p><div class="git-branch-list">' + (branches.length ? branches.map((branch) => '<button class="git-branch-option ' + (branch.current ? 'is-current' : '') + '" data-git-branch="' + escapeHtml(branch.name) + '" type="button"><span><strong>' + escapeHtml(branch.name) + '</strong><small>' + escapeHtml(branch.upstream ? 'upstream: ' + branch.upstream : 'rama local') + '</small></span>' + (branch.current ? '<em>ACTUAL</em>' : icons.chevron) + '</button>').join('') : '<div class="dock-empty">No hay ramas locales.</div>') + '</div></section></div>';
  document.querySelector<HTMLButtonElement>('#git-branch-close')?.addEventListener('click', close);
  document.querySelectorAll<HTMLButtonElement>('[data-git-branch]').forEach((button) => button.addEventListener('click', async () => {
    const branchName = button.dataset.gitBranch;
    if (!branchName || button.classList.contains('is-current')) {
      close();
      return;
    }
    close();
    try {
      await invoke('checkout_branch', { path: root, branchName });
      await refreshWorkspacePanels();
      render();
      showToast('Rama real cambiada a ' + branchName + '.');
    } catch (error) {
      showToast('No se pudo cambiar de rama: ' + String(error), true);
      await refreshWorkspacePanels();
    }
  }));
}

async function refreshWorkspacePanels(): Promise<void> {
  if (!getWorkspace()) return;
  if (workspaceRefreshInFlight) {
    workspaceRefreshQueued = true;
    return;
  }
  workspaceRefreshInFlight = true;
  try {
    await Promise.all([refreshFileTree(), refreshGitPanel()]);
  } finally {
    workspaceRefreshInFlight = false;
    if (workspaceRefreshQueued) {
      workspaceRefreshQueued = false;
      scheduleWorkspacePanelRefresh();
    }
  }
}

function scheduleWorkspacePanelRefresh(): void {
  if (workspaceRefreshTimer) window.clearTimeout(workspaceRefreshTimer);
  if (workspaceRefreshInFlight) {
    workspaceRefreshQueued = true;
    return;
  }
  workspaceRefreshTimer = window.setTimeout(() => {
    workspaceRefreshTimer = undefined;
    void refreshWorkspacePanels();
  }, 350);
}

window.addEventListener('comesade-workspace-changed', scheduleWorkspacePanelRefresh);

function renderWorkspaceList(): void {
  if (!workspaces.length) {
    workspaceList.innerHTML = '<div class="workspace-list-empty">No hay workspaces guardados.</div>';
    return;
  }
  workspaceList.innerHTML = workspaces.map((workspace) => {
    const active = workspace.id === activeWorkspaceId;
    const count = sessions.filter((session) => sessionBelongsToWorkspace(session, workspace)).length;
    const badgeHtml = count > 0 ? `<span class="session-badge">${count}</span>` : '';
    return `<button class="workspace-list-item ${active ? 'workspace-list-item-active' : ''}" data-sidebar-workspace="${escapeHtml(workspace.id)}" type="button"><span class="workspace-list-dot"></span><span class="workspace-list-copy"><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(compactPathLabel(workspace.path))}</small></span>${badgeHtml}</button>`;
  }).join('');
}

function renderSessions(): void {
  const workspace = getWorkspace();
  const projectLabel = document.querySelector<HTMLElement>('#sidebar-project-label');
  const inspectorTitle = document.querySelector<HTMLElement>('#inspector-workspace-title');
  if (projectLabel && workspace) projectLabel.textContent = workspace.name;
  if (inspectorTitle && workspace) inspectorTitle.textContent = workspace.name;

  const visibleSessions = sessions.filter((session) => {
    if (sidebarSessionFilter === 'live' && (session.status !== 'running' || exitedSessions.has(session.id))) return false;
    if (sidebarSessionQuery.trim() && !(session.name + ' ' + session.shell + ' ' + session.cwd).toLowerCase().includes(sidebarSessionQuery.trim().toLowerCase())) return false;
    return true;
  });
  sessionList.innerHTML = visibleSessions.length ? visibleSessions.map((session) => {
    const active = session.id === activeSessionId;
    const exited = session.status !== 'running' || exitedSessions.has(session.id);
    const activity = session.status === 'running' && !exited ? sessionActivity(session) : 'stopped';
    const badgeCount = terminals.has(session.id) ? 1 : 0;
    const badgeHtml = badgeCount > 0 ? `<span class="session-badge">${badgeCount}</span>` : '';

    return `<div class="tree-session-item ${active ? 'tree-session-item-active' : ''}" data-session-id="${session.id}" role="button" tabindex="0">
      <div class="tree-session-left">
        <span class="solid-dot" style="background:${exited ? '#ef4444' : '#22c55e'}"></span>
        <span style="font-weight:600;">${escapeHtml(session.name)}</span>
        ${badgeHtml}
      </div>
      <span class="sidebar-session-state" data-state="${activity}">${escapeHtml(sessionActivityLabel(activity))}</span>
    </div>`;
  }).join('') : '<div class="dock-empty sidebar-no-sessions">Sin sesiones abiertas.</div>';
  const active = getLiveSession(activeSessionId);
  const activeTabTitle = document.querySelector<HTMLElement>('#active-tab-title');
  if (activeTabTitle) {
    activeTabTitle.textContent = active ? active.name : (workspace ? workspace.name : 'ComesADE');
  }

  const termCount = document.querySelector<HTMLElement>('#active-terminal-count');
  if (termCount) termCount.textContent = String(sessions.length);
  
  const agentsBadge = document.querySelector<HTMLElement>('#active-agents-badge');
  if (agentsBadge) agentsBadge.textContent = String(sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id)).length);
}

function renderTerminalTabs(): void {
  terminalTabs.innerHTML = sessions.map((session) => {
    const active = session.id === activeSessionId;
    const act = sessionActivity(session);
    const isWorking = act === 'working' && session.status === 'running' && !exitedSessions.has(session.id);
    return `<button class="terminal-tab ${active ? 'terminal-tab-active' : ''}" data-session-id="${session.id}" type="button">
      <span class="terminal-tab-dot ${isWorking ? 'pulse-live' : ''}"></span>
      <span>${escapeHtml(session.name)}</span>
      <span class="terminal-tab-close" data-close-session="${session.id}">${icons.close}</span>
    </button>`;
  }).join('');
}

function renderAsaOverview(): void {
  const workspace = getWorkspace();
  const liveSessions = sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id));
  const liveAgents = liveSessions.filter((session) => Boolean(session.agentType || sessionLaunches.get(session.id)?.agentType));
  const worktreeSnapshot = workspace && currentGitWorktreeState === 'ready' && currentGitWorktreeRoot && sameFsPath(currentGitWorktreeRoot, workspace.path)
    ? currentGitWorktrees.filter((worktree) => !sameFsPath(worktree.path, workspace.path))
    : null;
  asaLiveAgents.textContent = runtimeSnapshotReady ? String(liveAgents.length) : '—';
  asaInstalledAgents.textContent = agentsDetectionReady ? String(detectedAgents.filter((agent) => agent.installed).length) : '—';
  asaWorktrees.textContent = worktreeSnapshot ? String(worktreeSnapshot.length) : !workspace || currentGitWorktreeState === 'unavailable' ? '—' : '…';
  asaRuntimeStatus.textContent = !workspace ? 'LOCKED' : !runtimeSnapshotReady ? 'CHECKING' : (liveSessions.length ? 'LIVE' : 'READY');
  if (!workspace) {
    asaSessionList.innerHTML = '<div class="asa-empty-state"><strong>Abre un workspace para usar ASA</strong><small>Los agentes y sus terminales se ejecutan dentro de una carpeta local real.</small></div>';
    return;
  }
  const liveMarkup = liveSessions.length
    ? liveSessions.map((session) => {
      const activity = sessionActivity(session);
      const kind = session.agentType || sessionLaunches.get(session.id)?.agentType || session.shell;
      const process = session.pid === null ? session.executable || session.shell : `${session.executable || session.shell} · PID ${session.pid}`;
      const location = session.worktree ? 'Worktree · ' + compactPathLabel(session.worktree) : compactPathLabel(session.cwd);
      return '<button class="asa-session-row" data-asa-session="' + escapeHtml(session.id) + '" type="button"><span class="asa-session-status asa-session-status-' + activity + '"></span><span class="asa-session-copy"><strong>' + escapeHtml(session.name) + '</strong><small>' + escapeHtml(kind) + ' · ' + escapeHtml(process) + ' · ' + escapeHtml(location) + '</small></span><span class="asa-session-activity">' + escapeHtml(sessionActivityLabel(activity)) + '</span></button>';
    }).join('')
    : '<div class="asa-empty-state"><strong>No hay procesos conectados</strong><small>Lanza un agente o una terminal para ver su contexto aquí.</small></div>';
  const restorable = savedSessions
    .map((saved, index) => ({ saved, index }))
    .filter(({ saved }) => !sessions.some((session) => session.name.toLowerCase() === saved.name.toLowerCase() && sameFsPath(session.cwd, saved.cwd)));
  const savedMarkup = restorable.length
    ? '<details class="asa-saved-sessions"><summary class="asa-saved-heading"><span>Definiciones locales guardadas (' + String(restorable.length) + ')</span><small>En este PC · no son procesos activos</small></summary><div class="asa-saved-list">' + restorable.map(({ saved, index }) => {
      const kind = saved.options.agentType || saved.options.program || saved.options.shell || activeShellName();
      return '<div class="asa-saved-row"><span class="asa-session-status asa-session-status-stopped"></span><span class="asa-session-copy"><strong>' + escapeHtml(saved.name) + '</strong><small>' + escapeHtml(kind) + ' · ' + escapeHtml(compactPathLabel(saved.cwd)) + ' · SIN PROCESO</small></span><button class="text-action" data-restore-session="' + String(index) + '" type="button">Abrir shell real</button></div>';
    }).join('') + '</div></details>'
    : '';
  asaSessionList.innerHTML = liveMarkup + savedMarkup;
}

function renderStatus(): void {
  const workspace = getWorkspace();
  const active = getLiveSession(activeSessionId);
  const projectLabel = document.querySelector<HTMLElement>('#sidebar-project-label');
  const inspectorTitle = document.querySelector<HTMLElement>('#inspector-workspace-title');
  if (projectLabel && workspace) projectLabel.textContent = workspace.name;
  if (inspectorTitle && workspace) inspectorTitle.textContent = workspace.name;

  const activeTabTitle = document.querySelector<HTMLElement>('#active-tab-title');
  if (activeTabTitle) {
    activeTabTitle.textContent = active ? active.name : (workspace ? workspace.name : 'ComesADE');
  }

  const termCount = document.querySelector<HTMLElement>('#active-terminal-count');
  if (termCount) termCount.textContent = String(sessions.length);

  renderWorkspaceList();
  renderSessions();
  renderTerminalTabs();
  renderAsaOverview();
  updateWorkspaceView();
}

function scheduleRender(): void {
  if (renderFrame !== undefined) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = undefined;
    render();
  });
}

function scheduleLayoutSync(): void {
  if (layoutSyncFrame !== undefined) return;
  layoutSyncFrame = window.requestAnimationFrame(() => {
    layoutSyncFrame = undefined;
    for (const id of terminals.keys()) syncTerminalSize(id);
    syncEmbeddedWebviews();
  });
}

function render(): void {
  applySavedTerminalOrder();
  renderStatus();
  const count = terminals.size;
  const columns = count <= 1 ? 1 : count === 2 ? 2 : count === 3 ? 3 : count <= 4 ? 2 : count <= 6 ? 3 : count <= 8 ? 4 : Math.ceil(Math.sqrt(count));
  terminalStack.style.setProperty('--terminal-columns', String(columns));
  for (const session of sessions) {
    const id = session.id;
    const instance = terminals.get(id);
    if (!instance) continue;
    terminalStack.appendChild(instance.surface);
    instance.surface.classList.toggle('terminal-view-active', id === activeSessionId);
    updateTerminalHeaderState(id);
  }
  terminalStack.classList.toggle('terminal-stack-focus', focusedTerminalId !== null);
  for (const [id, instance] of terminals) instance.surface.classList.toggle('terminal-view-focus', id === focusedTerminalId);
  scheduleLayoutSync();
}

function syncTerminalSize(id: string): void {
  if (closingSessionIds.has(id) || ignoredSessionIds.has(id)) return;
  const instance = terminals.get(id);
  if (!instance) return;
  try {
    instance.fit.fit();
    persistTerminalSize(id, instance.terminal.cols, instance.terminal.rows);
  } catch {
    // xterm puede medirse antes de terminar el layout.
  }
}

function persistTerminalSize(id: string, cols: number, rows: number): void {
  if (closingSessionIds.has(id) || ignoredSessionIds.has(id)) return;
  const safeCols = Math.max(2, Math.round(cols));
  const safeRows = Math.max(2, Math.round(rows));
  const key = `${safeCols}x${safeRows}`;
  if (terminalResizeState.get(id) === key) return;
  terminalResizeState.set(id, key);
  void invoke('resize_session', { sessionId: id, cols: safeCols, rows: safeRows }).catch(() => {
    terminalResizeState.delete(id);
  });
}

function registerTerminalLinks(terminal: Terminal): { dispose(): void } {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const text = terminal.buffer.active.getLine(bufferLineNumber)?.translateToString(true) ?? '';
      const links: ILink[] = [];
      const pattern = /https?:\/\/[^\s"'<>]+/gi;
      for (const match of text.matchAll(pattern)) {
        const raw = match[0];
        const link = raw.replace(/[.,;:!?\])}]+$/g, '');
        const index = match.index ?? -1;
        if (!link || index < 0) continue;
        links.push({
          range: {
            start: { x: index + 1, y: bufferLineNumber },
            end: { x: index + link.length, y: bufferLineNumber },
          },
          text: link,
          decorations: { pointerCursor: true, underline: true },
          activate: (_event, value) => createBrowserPanel(value),
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}

function mountTerminal(session: SessionInfo): void {
  if (terminals.has(session.id)) return;
  const surface = document.createElement('article');
  surface.className = 'terminal-view';
  surface.dataset.sessionId = session.id;
  const branch = (session as any).branch || (session as any).gitBranch;
  const branchHtml = branch ? `<small class="terminal-branch">⎇ ${escapeHtml(branch)}</small>` : '';
  
  surface.innerHTML = `<header class="terminal-view-header" draggable="true" title="Arrastra para reordenar; doble clic para enfocar"><div class="terminal-view-title"><span class="terminal-view-icon">${icons.terminal}</span><span><strong>${escapeHtml(session.name)}</strong>${branchHtml}<small>${escapeHtml(session.shell)} · ${escapeHtml(session.cwd)}</small></span></div><div class="terminal-view-actions"><span class="live-label" data-state="waiting"><i></i><span class="live-label-text">WAITING</span></span><button class="icon-button terminal-control terminal-control-close" data-close-session="${session.id}" title="Cerrar sesión" aria-label="Cerrar sesión">${icons.close}</button></div></header><div class="terminal-pane" data-session-id="${session.id}"></div><div class="terminal-resize-handle" data-terminal-resize="${session.id}" role="separator" aria-label="Redimensionar terminal" title="Redimensionar terminal"></div>`;
  applySavedTerminalSize(session.id, surface);
  const pane = surface.querySelector<HTMLDivElement>('.terminal-pane')!;
  const actionHost = surface.querySelector<HTMLElement>('.terminal-view-actions');
  if (actionHost) {
    const stop = document.createElement('button');
    stop.className = 'icon-button terminal-control terminal-control-stop';
    stop.dataset.interruptSession = session.id;
    stop.title = 'Enviar Ctrl+C';
    stop.setAttribute('aria-label', 'Interrumpir proceso');
    stop.innerHTML = icons.stop;
    const restart = document.createElement('button');
    restart.className = 'icon-button terminal-control';
    restart.dataset.restartSession = session.id;
    restart.title = 'Reiniciar proceso';
    restart.setAttribute('aria-label', 'Reiniciar proceso');
    restart.innerHTML = icons.refresh;
    actionHost.insertBefore(restart, actionHost.firstElementChild);
    actionHost.insertBefore(stop, actionHost.firstElementChild);
  }
  surface.querySelector<HTMLElement>('.terminal-view-header')?.addEventListener('dblclick', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    setTerminalFocus(focusedTerminalId === session.id ? null : session.id);
  });
  terminalStack.appendChild(surface);
  const fit = new FitAddonClass();
  const terminal = new TerminalClass({ allowProposedApi: true, allowTransparency: true, convertEol: true, cursorBlink: true, cursorStyle: appSettings.terminalCursor, fontFamily: appSettings.terminalFont, fontSize: appSettings.terminalFontSize, lineHeight: 1.35, scrollback: appSettings.terminalScrollback, theme: terminalTheme });
  terminal.loadAddon(fit);
  terminal.open(pane);
  const linkProvider = registerTerminalLinks(terminal);
  terminal.attachCustomKeyEventHandler((event) => {
    const primary = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (primary && event.shiftKey && key === 'c') {
      const selection = terminal.getSelection();
      if (selection) {
        void navigator.clipboard.writeText(selection)
          .then(() => showToast('Selección copiada.'))
          .catch((error) => showToast('No se pudo copiar la selección: ' + String(error), true));
        return false;
      }
    }
    if (primary && (key === 'v' || (event.shiftKey && key === 'v'))) {
      void navigator.clipboard.readText()
        .then((value) => { if (value) return invoke('write_to_session', { sessionId: session.id, data: value }); return undefined; })
        .catch((error) => showToast('No se pudo pegar en la terminal: ' + String(error), true));
      return false;
    }
    return true;
  });
  terminal.onData((data) => {
    if (closingSessionIds.has(session.id) || ignoredSessionIds.has(session.id)) return;
    observeTerminalInput(session.id, data);
    void invoke('write_to_session', { sessionId: session.id, data }).catch((error: unknown) => {
      if (!closingSessionIds.has(session.id) && !ignoredSessionIds.has(session.id)) {
        showToast(String(error), true);
      }
    });
  });
  terminal.onResize(({ cols, rows }) => persistTerminalSize(session.id, cols, rows));
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      if (!closingSessionIds.has(session.id) && !ignoredSessionIds.has(session.id)) window.requestAnimationFrame(() => syncTerminalSize(session.id));
    })
    : undefined;
  resizeObserver?.observe(surface);
  terminals.set(session.id, { terminal, fit, surface, resizeObserver, linkProvider });
  const initialLabel = surface.querySelector<HTMLElement>('.live-label-text');
  if (initialLabel) initialLabel.textContent = sessionActivityLabel(sessionActivity(session));
  const initialBadge = surface.querySelector<HTMLElement>('.live-label');
  if (initialBadge) initialBadge.dataset.state = sessionActivity(session);
  const buffered = pendingOutput.get(session.id);
  if (buffered) {
    queueTerminalOutput(session.id, buffered);
    pendingOutput.delete(session.id);
  }
  scheduleLayoutSync();
}

function activateSession(id: string): void {
  const session = getSession(id);
  if (!session) return;
  const nextRoot = session.worktree ?? getWorkspace()?.path ?? null;
  if (!prepareEditorForRootChange(nextRoot)) return;
  activeSessionId = id;
  setView('terminals');
  fileTreeRelativePath = '';
  mountTerminal(session);
  render();
  void refreshWorkspacePanels();
  scheduleLayoutSync();
  window.requestAnimationFrame(() => {
    terminals.get(id)?.terminal.focus();
  });
}

type SessionLaunchOptions = {
  shell?: string;
  program?: string;
  args?: string[];
  initialCommand?: string;
  agentType?: string;
  worktree?: string;
  env?: Record<string, string>;
};

type SavedSession = {
  name: string;
  cwd: string;
  options: SessionLaunchOptions;
  lastStatus: string;
};

async function createSession(name?: string, cwd?: string, options: SessionLaunchOptions = {}): Promise<SessionInfo | undefined> {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast('Abre o crea un workspace antes de iniciar una terminal real.', true);
    return undefined;
  }
  try {
    const environment = { ...appSettings.environment, ...(options.env ?? {}) };
    const session = await invoke<SessionInfo>('create_session', { request: { name: uniqueSessionName(name) || null, cwd: cwd?.trim() || workspace.path, workspacePath: workspace.path, cols: 120, rows: 28, shell: options.shell ?? appSettings.defaultShell, program: options.program ?? null, args: options.args ?? null, initialCommand: options.initialCommand ?? null, agentType: options.agentType ?? null, worktree: options.worktree ?? null, env: Object.keys(environment).length ? environment : null } });
    ignoredSessionIds.delete(session.id);
    closingSessionIds.delete(session.id);
    sessions.push(session);
    exitedSessions.delete(session.id);
    const earlyStatus = pendingStatuses.get(session.id);
    if (earlyStatus) {
      session.status = earlyStatus;
      pendingStatuses.delete(session.id);
    }
    const earlyExit = pendingExits.get(session.id);
    if (earlyExit) {
      session.status = 'exited';
      pendingExits.delete(session.id);
      exitedSessions.add(session.id);
      sessionActivities.set(session.id, earlyExit.exitCode === 0 ? 'finished' : earlyExit.exitCode === null ? 'stopped' : 'error');
    } else if (session.status !== 'running') {
      exitedSessions.add(session.id);
      sessionActivities.set(session.id, 'stopped');
    } else {
      sessionActivities.set(session.id, 'waiting');
    }
    const launchOptions = { ...options, shell: options.shell ?? appSettings.defaultShell };
    sessionLaunches.set(session.id, launchOptions);
    persistSessionDefinition(session, launchOptions);
    saveCurrentTerminalOrder();
    activateSession(session.id);
    showToast(`${session.name} conectada a ${session.shell}.`);
    return session;
  } catch (error) {
    showToast(`No se pudo abrir la sesión: ${String(error)}`, true);
    return undefined;
  }
}

async function closeSession(id: string): Promise<boolean> {
  const session = getSession(id);
  if (!session || closingSessionIds.has(id) || ignoredSessionIds.has(id)) return false;
  closingSessionIds.add(id);
  // Windows puede entregar salida/status/exit después de close_session.
  // Ignorarlos evita que un PTY ya cerrado vuelva a tocar el DOM.
  ignoredSessionIds.add(id);
  try {
    await invoke('close_session', { sessionId: id });
  } catch (error) {
    closingSessionIds.delete(id);
    ignoredSessionIds.delete(id);
    showToast(`No se pudo cerrar ${session.name}: ${String(error)}`, true);
    return false;
  }
  closingSessionIds.delete(id);
  terminals.get(id)?.resizeObserver?.disconnect();
  terminals.get(id)?.linkProvider?.dispose();
  terminals.get(id)?.terminal.dispose();
  terminals.get(id)?.surface.remove();
  terminals.delete(id);
  clearTerminalOutputQueue(id);
  terminalResizeState.delete(id);
  pendingOutput.delete(id);
  terminalInputBuffers.delete(id);
  pendingStatuses.delete(id);
  pendingExits.delete(id);
  sessionLaunches.delete(id);
  exitedSessions.delete(id);
  sessionActivities.delete(id);
  const index = sessions.findIndex((item) => item.id === id);
  if (index >= 0) sessions.splice(index, 1);
  saveCurrentTerminalOrder();
  if (activeSessionId === id) activeSessionId = sessions[index]?.id ?? sessions[index - 1]?.id ?? sessions[0]?.id ?? null;
  if (focusedTerminalId === id) focusedTerminalId = null;
  render();
  return true;
}

async function interruptSession(id: string): Promise<void> {
  if (closingSessionIds.has(id) || ignoredSessionIds.has(id)) return;
  const session = getLiveSession(id);
  if (!session) return;
  try {
    await invoke('interrupt_session', { sessionId: id });
    showToast(`Ctrl+C enviado a ${session.name}.`);
  } catch (error) {
    showToast(`No se pudo interrumpir ${session.name}: ${String(error)}`, true);
  }
}

async function restartSession(id: string): Promise<void> {
  if (closingSessionIds.has(id) || ignoredSessionIds.has(id)) return;
  const session = getSession(id);
  if (!session) return;
  const launch = { ...(sessionLaunches.get(id) ?? {}), shell: sessionLaunches.get(id)?.shell ?? appSettings.defaultShell };
  const name = session.name;
  const cwd = session.cwd;
  if (!await closeSession(id)) return;
  await createSession(name, cwd, launch);
}

function handleOutput(payload: TerminalOutput): void {
  if (closingSessionIds.has(payload.sessionId) || ignoredSessionIds.has(payload.sessionId)) return;
  detectLocalhostEndpoints(payload.data);
  const session = getSession(payload.sessionId);
  if (session && session.status === 'running') sessionActivities.set(payload.sessionId, isShellPromptVisible(payload.data) ? 'waiting' : 'working');
  scheduleTerminalHeaderState(payload.sessionId);
  const terminal = terminals.get(payload.sessionId)?.terminal;
  if (terminal) queueTerminalOutput(payload.sessionId, payload.data);
  else pendingOutput.set(payload.sessionId, `${pendingOutput.get(payload.sessionId) ?? ''}${payload.data}`.slice(-30000));
}

function renderDetectedEndpoints(): void {
  endpointStrip.hidden = detectedEndpoints.size === 0;
  endpointStrip.innerHTML = [...detectedEndpoints].map((url) => `<span class="detected-endpoint"><span>${icons.browser}<strong>${escapeHtml(url)}</strong></span><button class="text-action" data-open-endpoint="${escapeHtml(url)}" type="button">Open preview</button></span>`).join('');
}

function detectLocalhostEndpoints(data: string): void {
  const matches = data.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|::1):\d{1,5}(?:[^\s\u001b"'<>]*)?/gi) ?? [];
  let changed = false;
  for (const match of matches) {
    const normalized = normalizeLocalhostUrl(match.replace(/[.,;!?]+$/, ''));
    if (normalized && !detectedEndpoints.has(normalized)) {
      detectedEndpoints.add(normalized);
      changed = true;
    }
  }
  if (changed) {
    renderDetectedEndpoints();
    showToast('Se detecto un endpoint localhost real en la terminal.');
  }
}

function handleStatus(payload: TerminalStatusEvent): void {
  if (closingSessionIds.has(payload.sessionId) || ignoredSessionIds.has(payload.sessionId)) return;
  const session = getSession(payload.sessionId);
  if (!session) {
    pendingStatuses.set(payload.sessionId, payload.status);
    return;
  }
  session.status = payload.status;
  if (payload.status === 'running' && !sessionActivities.has(payload.sessionId)) sessionActivities.set(payload.sessionId, 'waiting');
  scheduleTerminalHeaderState(payload.sessionId);
  if (payload.status !== 'running') exitedSessions.add(payload.sessionId);
  scheduleRender();
}

function handleExit(payload: TerminalExit): void {
  if (closingSessionIds.has(payload.sessionId) || ignoredSessionIds.has(payload.sessionId)) return;
  const session = getSession(payload.sessionId);
  if (!session) {
    pendingExits.set(payload.sessionId, payload);
    pendingStatuses.set(payload.sessionId, 'exited');
    return;
  }
  session.status = 'exited';
  exitedSessions.add(payload.sessionId);
  terminalInputBuffers.delete(payload.sessionId);
  sessionActivities.set(payload.sessionId, payload.exitCode === 0 ? 'finished' : payload.exitCode === null ? 'stopped' : 'error');
  const instance = terminals.get(payload.sessionId);
  if (instance) queueTerminalOutput(payload.sessionId, '\r\n\x1b[33m[ComesADE] El shell finalizó.\x1b[0m\r\n');
  instance?.surface.classList.add('terminal-view-exited');
  updateTerminalHeaderState(payload.sessionId);
  scheduleRender();
}

function handleSessionClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('[data-terminal-resize]')) return;
  const restoreButton = target.closest<HTMLElement>('[data-restore-session]');
  if (restoreButton) {
    event.stopPropagation();
    void restoreSavedSession(Number(restoreButton.dataset.restoreSession));
    return;
  }
  const interruptButton = target.closest<HTMLElement>('[data-interrupt-session]');
  if (interruptButton) {
    event.stopPropagation();
    void interruptSession(interruptButton.dataset.interruptSession ?? '');
    return;
  }
  const restartButton = target.closest<HTMLElement>('[data-restart-session]');
  if (restartButton) {
    event.stopPropagation();
    void restartSession(restartButton.dataset.restartSession ?? '');
    return;
  }
  const closeButton = target.closest<HTMLElement>('[data-close-session]');
  if (closeButton) {
    event.stopPropagation();
    void closeSession(closeButton.dataset.closeSession ?? '');
    return;
  }
  const item = target.closest<HTMLElement>('[data-session-id]');
  if (item?.dataset.sessionId) activateSession(item.dataset.sessionId);
}

function sessionStartedLabel(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return value || 'Desconocido';
  return new Date(seconds * 1000).toLocaleString();
}

async function openSessionDetails(session: SessionInfo): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  const root = session.worktree ?? session.cwd;
  let branch = 'No disponible';
  let stats: GitDiffStats | null = null;
  let statsError = '';
  try {
    const repository = await invoke<{ branch: string; isRepository: boolean }>('repository_info', { path: root });
    branch = repository.isRepository ? (repository.branch || 'DETACHED') : 'No es un repositorio Git';
  } catch (error) {
    branch = 'No disponible: ' + String(error);
  }
  try {
    stats = await invoke<GitDiffStats>('diff_stats', { path: root });
  } catch (error) {
    statsError = String(error);
  }
  const statsValue = stats
    ? String(stats.filesChanged) + ' files · <b class="stat-add">+' + String(stats.additions) + '</b> <b class="stat-delete">-' + String(stats.deletions) + '</b>'
    : 'No disponible';
  const rows = [
    ['AGENT / SHELL', escapeHtml(session.agentType ?? session.shell), escapeHtml(session.shell + ' · ' + session.executable)],
    ['STATUS / PID', escapeHtml(session.status.toUpperCase() + ' · ' + (session.pid === null ? 'N/A' : String(session.pid))), String(session.cols) + ' x ' + String(session.rows) + ' PTY'],
    ['DIRECTORY', escapeHtml(session.cwd), 'Working directory actual'],
    ['WORKTREE / BRANCH', escapeHtml(session.worktree ?? 'Main repository'), escapeHtml(branch)],
    ['STARTED', escapeHtml(sessionStartedLabel(session.createdAt)), 'Registro del proceso'],
    ['FILES CHANGED', statsValue, escapeHtml(statsError || 'Calculado con Git real')],
  ];
  modalRoot.innerHTML = '<div class="modal-backdrop" id="session-details-backdrop"><section class="modal-panel session-details-modal"><div class="modal-heading"><div><span class="eyebrow">RUNTIME / SESSION</span><h2>' + escapeHtml(session.name) + '</h2></div><button class="modal-close" id="session-details-close" type="button">' + icons.close + '</button></div><p class="modal-copy">Metadatos obtenidos del proceso y del filesystem reales.</p><div class="session-details-grid">' + rows.map((row) => '<div class="session-detail"><span>' + row[0] + '</span><strong>' + row[1] + '</strong><small>' + row[2] + '</small></div>').join('') + '</div><div class="modal-actions"><button class="secondary-button" id="session-details-explorer" type="button">' + icons.external + '<span>Open in Explorer</span></button><button class="primary-button" id="session-details-done" type="button">Done</button></div></section></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#session-details-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#session-details-done')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#session-details-explorer')?.addEventListener('click', () => {
    void invoke('reveal_path', { path: root }).catch((error) => showToast(String(error), true));
  });
}

function openSessionContextMenu(event: MouseEvent, sessionId: string): void {
  event.preventDefault();
  event.stopPropagation();
  const session = getSession(sessionId);
  const workspace = getWorkspace();
  if (!session || !workspace) return;
  document.querySelector<HTMLElement>('.session-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'file-context-menu session-context-menu';
  menu.style.left = String(Math.min(event.clientX, window.innerWidth - 230)) + 'px';
  menu.style.top = String(Math.min(event.clientY, window.innerHeight - 310)) + 'px';
  menu.innerHTML = '<button data-session-action="details" type="button">Session details</button><button data-session-action="focus" type="button">Focus</button><button data-session-action="restart" type="button">Restart</button><button data-session-action="stop" type="button">Stop / Ctrl+C</button><button data-session-action="kill" type="button">Kill process</button><button data-session-action="worktree" type="button">Open worktree</button><button data-session-action="explorer" type="button">Open in Explorer</button><button data-session-action="git" type="button">Git status</button><button data-session-action="diff" type="button">View diff</button><button data-session-action="remove" type="button">Remove session</button>';
  document.body.appendChild(menu);
  const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', outside); };
  const outside = (pointerEvent: PointerEvent): void => { if (!menu.contains(pointerEvent.target as Node)) close(); };
  document.addEventListener('pointerdown', outside);
  menu.addEventListener('click', async (menuEvent) => {
    const action = (menuEvent.target as HTMLElement).closest<HTMLElement>('[data-session-action]')?.dataset.sessionAction;
    close();
    try {
      if (action === 'details') {
        await openSessionDetails(session);
      } else if (action === 'focus') {
        activateSession(session.id);
      } else if (action === 'restart') {
        await restartSession(session.id);
      } else if (action === 'stop') {
        await interruptSession(session.id);
      } else if (action === 'kill') {
        await closeSession(session.id);
      } else if (action === 'worktree') {
        await invoke('reveal_path', { path: session.worktree ?? session.cwd });
      } else if (action === 'explorer') {
        await invoke('reveal_path', { path: session.cwd });
      } else if (action === 'git') {
        activateSession(session.id);
        setView('terminals');
        await refreshGitPanel();
      } else if (action === 'diff') {
        activateSession(session.id);
        setView('terminals');
        await refreshGitPanel();
        const firstChange = currentGitStatus?.entries[0]?.path;
        if (firstChange) await loadGitDiff(firstChange);
        else showToast('No hay cambios Git reales para revisar.');
      } else if (action === 'remove') {
        if (!window.confirm('Esto cerrará el proceso real y quitará su definición guardada. ¿Continuar?')) return;
        if (await closeSession(session.id)) removeSessionDefinition(session);
        render();
      }
    } catch (error) {
      showToast('No se pudo completar la acción: ' + String(error), true);
    }
  });
}

function setView(view: string): void {
  if (!isLayoutView(view)) return;
  if (!navigatingViewHistory && viewHistory[viewHistoryIndex] !== view) {
    viewHistory = viewHistory.slice(0, viewHistoryIndex + 1);
    viewHistory.push(view);
    viewHistoryIndex = viewHistory.length - 1;
  }
  layoutState.view = view;
  if (activeWorkspaceId) saveWorkspaceLayout({ view });
  else saveLayout();
  applyLayout();
  if (view === 'terminals') {
    terminalArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (activeSessionId) terminals.get(activeSessionId)?.terminal.focus();
  }
  if (view === 'asa') asaOverview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (view === 'tools') toolStage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function navigateViewHistory(direction: -1 | 1): void {
  const next = viewHistoryIndex + direction;
  if (next < 0 || next >= viewHistory.length) {
    showToast(direction < 0 ? 'No hay una vista anterior.' : 'No hay una vista siguiente.');
    return;
  }
  viewHistoryIndex = next;
  navigatingViewHistory = true;
  try {
    setView(viewHistory[viewHistoryIndex]);
  } finally {
    navigatingViewHistory = false;
  }
}

function toggleSidebar(): void {
  layoutState.sidebarCollapsed = !layoutState.sidebarCollapsed;
  applyLayout();
  saveLayout();
  scheduleLayoutSync();
}

function toggleInspector(): void {
  inspectorCollapsed = !inspectorCollapsed;
  layoutState.inspectorCollapsed = inspectorCollapsed;
  document.querySelector<HTMLElement>('.app-shell')?.classList.toggle('inspector-collapsed', inspectorCollapsed);
  saveLayout();
  scheduleLayoutSync();
}

function toggleSidebarSessionFilter(): void {
  sidebarSessionFilter = sidebarSessionFilter === 'all' ? 'live' : 'all';
  const button = document.querySelector<HTMLButtonElement>('#sidebar-filter-btn');
  if (button) button.title = sidebarSessionFilter === 'live' ? 'Filtros: solo sesiones activas' : 'Filtros: todas las sesiones';
  renderSessions();
  showToast(sidebarSessionFilter === 'live' ? 'Mostrando sesiones activas.' : 'Mostrando todas las sesiones.');
}

function toggleFileSort(): void {
  fileSortMode = fileSortMode === 'name' ? 'type' : 'name';
  const button = document.querySelector<HTMLButtonElement>('#inspector-view-sort');
  if (button) button.title = fileSortMode === 'name' ? 'Ordenar por tipo' : 'Ordenar por nombre';
  void refreshFileTree();
}

function setInspectorFilterMode(mode: 'names' | 'content'): void {
  inspectorFilterMode = mode;
  document.querySelector<HTMLButtonElement>('#filter-names-btn')?.classList.toggle('segmented-item-active', mode === 'names');
  document.querySelector<HTMLButtonElement>('#filter-content-btn')?.classList.toggle('segmented-item-active', mode === 'content');
  if (mode === 'content') {
    void openSearchModal();
    return;
  }
  void refreshFileTree();
}

function openInspectorActionsMenu(): void {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast('Abre un workspace para usar las acciones del inspector.', true);
    return;
  }
  document.querySelector<HTMLElement>('.inspector-context-menu')?.remove();
  const button = document.querySelector<HTMLElement>('#inspector-more');
  const rect = button?.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'file-context-menu inspector-context-menu';
  menu.style.right = `${Math.max(8, window.innerWidth - (rect?.right ?? window.innerWidth - 12))}px`;
  menu.style.top = `${Math.min(window.innerHeight - 180, (rect?.bottom ?? 42) + 6)}px`;
  menu.innerHTML = '<button data-inspector-action="new-file" type="button">New file</button><button data-inspector-action="new-folder" type="button">New folder</button><button data-inspector-action="refresh" type="button">Refresh files</button><button data-inspector-action="reveal" type="button">Reveal workspace</button><button data-inspector-action="search" type="button">Search project</button>';
  document.body.appendChild(menu);
  const close = (): void => { menu.remove(); document.removeEventListener('pointerdown', outside); };
  const outside = (event: PointerEvent): void => { if (!menu.contains(event.target as Node) && event.target !== button) close(); };
  document.addEventListener('pointerdown', outside);
  menu.addEventListener('click', async (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-inspector-action]')?.dataset.inspectorAction;
    close();
    if (action === 'new-file') await createWorkspaceEntry('file');
    else if (action === 'new-folder') await createWorkspaceEntry('directory');
    else if (action === 'refresh') await refreshWorkspacePanels();
    else if (action === 'reveal') await invoke('reveal_path', { path: workspace.path }).catch((error) => showToast(String(error), true));
    else if (action === 'search') await openSearchModal();
  });
}

function openHelpModal(): void {
  modalRoot.innerHTML = '<div class="modal-backdrop" id="help-backdrop"><section class="modal-panel"><div class="modal-heading"><div><span class="eyebrow">COMESADE / HELP</span><h2>Ayuda y atajos</h2></div><button class="modal-close" id="help-close" type="button">' + icons.close + '</button></div><p class="modal-copy">Todas las acciones de terminal, archivos, Git y previews trabajan con recursos reales de este PC.</p><div class="help-grid"><div><strong>Ctrl + Shift + P</strong><small>Command palette</small></div><div><strong>Ctrl + P</strong><small>Buscar archivos</small></div><div><strong>Ctrl + `</strong><small>Enfocar terminal</small></div><div><strong>Ctrl + B</strong><small>Mostrar u ocultar sidebar</small></div><div><strong>Ctrl + Tab</strong><small>Cambiar de terminal</small></div><div><strong>Ctrl + S</strong><small>Guardar archivo real</small></div></div><div class="modal-actions"><button class="primary-button" id="help-done" type="button">Listo</button></div></section></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#help-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#help-done')?.addEventListener('click', close);
}

function openFeedbackModal(): void {
  modalRoot.innerHTML = '<div class="modal-backdrop" id="feedback-backdrop"><form class="modal-panel" id="feedback-form"><div class="modal-heading"><div><span class="eyebrow">COMESADE / FEEDBACK</span><h2>Comentarios</h2></div><button class="modal-close" id="feedback-close" type="button">' + icons.close + '</button></div><p class="modal-copy">Escribe tus comentarios. ComesADE no los envía automáticamente: puedes copiarlos y compartirlos tú.</p><textarea class="field-input feedback-input" id="feedback-input" rows="6" placeholder="¿Qué debería mejorar?"></textarea><div class="modal-actions"><button class="secondary-button" id="feedback-cancel" type="button">Cancelar</button><button class="primary-button" id="feedback-copy" type="button">Copiar comentarios</button></div></form></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#feedback-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#feedback-cancel')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#feedback-copy')?.addEventListener('click', async () => {
    const value = document.querySelector<HTMLTextAreaElement>('#feedback-input')?.value.trim();
    if (!value) { showToast('Escribe un comentario antes de copiarlo.', true); return; }
    try {
      await navigator.clipboard.writeText(value);
      showToast('Comentarios copiados al portapapeles.');
      close();
    } catch (error) {
      showToast('No se pudo copiar el comentario: ' + String(error), true);
    }
  });
  document.querySelector<HTMLTextAreaElement>('#feedback-input')?.focus();
}

function openStatsModal(): void {
  const workspace = getWorkspace();
  const live = sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id)).length;
  modalRoot.innerHTML = '<div class="modal-backdrop" id="stats-backdrop"><section class="modal-panel"><div class="modal-heading"><div><span class="eyebrow">COMESADE / LOCAL STATS</span><h2>Estadísticas reales</h2></div><button class="modal-close" id="stats-close" type="button">' + icons.close + '</button></div><div class="stats-grid"><div><strong>' + String(live) + '</strong><small>sesiones activas</small></div><div><strong>' + String(localhostPanels.size + browserPanels.size) + '</strong><small>previews abiertos</small></div><div><strong>' + String(detectedEndpoints.size) + '</strong><small>endpoints detectados</small></div><div><strong id="stats-git">CONSULTANDO</strong><small>cambios Git</small></div></div><p class="modal-copy">Workspace: ' + escapeHtml(workspace?.name ?? 'ninguno') + '<br/>Ruta: ' + escapeHtml(workspace?.path ?? '—') + '</p><div class="modal-actions"><button class="secondary-button" id="stats-open-git" type="button">Abrir Git</button><button class="primary-button" id="stats-done" type="button">Listo</button></div></section></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#stats-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#stats-done')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#stats-open-git')?.addEventListener('click', () => { close(); setInspectorTab('git'); });
  const statsTarget = document.querySelector<HTMLElement>('#stats-git');
  if (!workspace) { if (statsTarget) statsTarget.textContent = 'SIN WORKSPACE'; return; }
  void invoke<GitDiffStats>('diff_stats', { path: activeProjectRoot() ?? workspace.path })
    .then((stats) => { if (statsTarget) statsTarget.textContent = String(stats.filesChanged); })
    .catch(() => { if (statsTarget) statsTarget.textContent = 'N/A'; });
}

function focusAdjacentSession(direction: 1 | -1): void {
  const live = sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id));
  if (!live.length) return;
  const index = live.findIndex((session) => session.id === activeSessionId);
  activateSession(live[(index + direction + live.length) % live.length].id);
}

function setTerminalFocus(id: string | null): void {
  focusedTerminalId = id;
  render();
  scheduleLayoutSync();
}

function bringToolToFront(id: string): void {
  activeToolId = id;
  renderTools();
  scheduleWebviewSync();
}

function browserInputToUrl(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function normalizeLocalhostUrl(rawValue: string): string | null {
  let value = rawValue.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !new Set(['localhost', '127.0.0.1', '[::1]', '::1']).has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function renderTools(): void {
  const panels = [...localhostPanels.values(), ...browserPanels.values()];
  toolTabs.innerHTML = panels.map((panel) => `<button class="tool-tab ${panel.id === activeToolId ? 'tool-tab-active' : ''}" data-tool-id="${panel.id}" type="button">${escapeHtml('title' in panel ? panel.title : new URL(panel.url).hostname)}<b data-close-tool="${panel.id}">${icons.close}</b></button>`).join('');
  toolEmpty.hidden = panels.length > 0;
  panels.forEach((panel) => panel.element.classList.toggle('tool-view-active', panel.id === activeToolId));
}

function scheduleWebviewSync(): void {
  scheduleLayoutSync();
}

function syncEmbeddedWebviews(): void {
  const modalOpen = modalRoot.childElementCount > 0;
  for (const panel of browserPanels.values()) {
    if (!panel.webview) {
      visibleBrowserWebviews.delete(panel.id);
      browserWebviewGeometry.delete(panel.id);
      continue;
    }
    const shouldShow = !modalOpen && panel.id === activeToolId && panel.element.classList.contains('tool-view-active');
    if (!shouldShow) {
      if (visibleBrowserWebviews.delete(panel.id)) void panel.webview.hide().catch(() => undefined);
      continue;
    }
    const rect = panel.frame.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      if (visibleBrowserWebviews.delete(panel.id)) void panel.webview.hide().catch(() => undefined);
      continue;
    }
    const left = Math.max(0, Math.round(rect.left));
    const top = Math.max(0, Math.round(rect.top));
    const width = Math.max(8, Math.round(rect.width));
    const height = Math.max(8, Math.round(rect.height));
    const geometry = `${left}:${top}:${width}:${height}`;
    const operations: Promise<unknown>[] = [];
    if (browserWebviewGeometry.get(panel.id) !== geometry) {
      browserWebviewGeometry.set(panel.id, geometry);
      operations.push(
        panel.webview.setPosition(new LogicalPosition(left, top)),
        panel.webview.setSize(new LogicalSize(width, height)),
      );
    }
    if (!visibleBrowserWebviews.has(panel.id)) {
      visibleBrowserWebviews.add(panel.id);
      operations.push(panel.webview.show());
    }
    if (operations.length) {
      void Promise.all(operations).catch(() => {
        visibleBrowserWebviews.delete(panel.id);
      });
    }
  }
}

function createNativeBrowserWebview(panel: BrowserPanel): void {
  const status = panel.element.querySelector<HTMLElement>('[data-tool-status]');
  try {
    visibleBrowserWebviews.delete(panel.id);
    browserWebviewGeometry.delete(panel.id);
    const webview = new Webview(currentAppWebview.window, panel.id, { url: panel.url, x: 0, y: 0, width: 8, height: 8, focus: false, dragDropEnabled: false, zoomHotkeysEnabled: true });
    panel.webview = webview;
    void webview.once('tauri://created', () => { if (status) status.textContent = 'LOADED'; scheduleWebviewSync(); });
    void webview.once('tauri://error', () => { if (status) status.textContent = 'ERROR'; showToast('No se pudo cargar este sitio integrado.', true); });
    scheduleWebviewSync();
  } catch (error) {
    if (status) status.textContent = 'EXTERNAL';
    showToast(`No se pudo crear el navegador integrado: ${String(error)}`, true);
  }
}

function createLocalhostPanel(rawUrl: string, requestedName?: string): void {
  const url = normalizeLocalhostUrl(rawUrl);
  if (!url) {
    showToast('Usa una dirección local válida, por ejemplo http://localhost:3000.', true);
    return;
  }
  const existing = [...localhostPanels.values()].find((panel) => panel.url === url);
  if (existing) {
    activeToolId = existing.id;
    setView('tools');
    renderTools();
    scheduleWebviewSync();
    return;
  }
  const id = `localhost-${localhostSequence++}`;
  const label = requestedName?.trim() || new URL(url).host;
  const element = document.createElement('article');
  element.className = 'tool-view';
  element.dataset.toolId = id;
  element.innerHTML = `<header class="tool-view-header"><div class="tool-view-title">${icons.browser}<span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(url)}</small></span></div><div class="tool-view-actions"><span data-tool-status>LOADING</span><button class="icon-button" data-tool-refresh="${id}" title="Actualizar">${icons.refresh}</button><button class="icon-button" data-close-tool="${id}" title="Cerrar">${icons.close}</button></div></header><iframe class="tool-frame" title="${escapeHtml(label)}" src="${escapeHtml(url)}" loading="eager" referrerpolicy="no-referrer" allow="fullscreen; clipboard-read; clipboard-write"></iframe>`;
  const frame = element.querySelector<HTMLIFrameElement>('.tool-frame')!;
  frame.addEventListener('load', () => { const status = element.querySelector<HTMLElement>('[data-tool-status]'); if (status) status.textContent = 'LOADED'; });
  frame.addEventListener('error', () => { const status = element.querySelector<HTMLElement>('[data-tool-status]'); if (status) status.textContent = 'ERROR'; });
  toolStage.appendChild(element);
  localhostPanels.set(id, { id, url, element, frame });
  activeToolId = id;
  saveWorkspaceLayout({ localhostUrl: url });
  setView('tools');
  renderTools();
  showToast(`${label} abierto en Tools.`);
}

function createBrowserPanel(rawUrl: string, requestedName?: string): void {
  const url = browserInputToUrl(rawUrl);
  if (!url) {
    showToast('Escribe un enlace o una búsqueda válida.', true);
    return;
  }
  const existing = [...browserPanels.values()].find((panel) => panel.url === url);
  if (existing) {
    activeToolId = existing.id;
    setView('tools');
    renderTools();
    scheduleWebviewSync();
    return;
  }
  const parsed = new URL(url);
  const id = `browser-${browserSequence++}`;
  const title = requestedName?.trim() || (parsed.hostname === 'www.google.com' ? 'Google' : parsed.hostname);
  const element = document.createElement('article');
  element.className = 'tool-view';
  element.dataset.toolId = id;
  element.innerHTML = `<header class="tool-view-header"><div class="tool-view-title">${icons.browser}<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(url)}</small></span></div><div class="tool-view-actions"><span data-tool-status>LOADING</span><button class="icon-button" data-tool-external="${id}" title="Abrir externo">${icons.external}</button><button class="icon-button" data-tool-refresh="${id}" title="Actualizar">${icons.refresh}</button><button class="icon-button" data-close-tool="${id}" title="Cerrar">${icons.close}</button></div></header><div class="browser-address"><form data-tool-search="${id}"><input value="${escapeHtml(url)}" data-tool-url="${id}" autocomplete="url"/><button type="submit">${icons.chevron}</button></form></div><div class="tool-frame browser-frame" title="${escapeHtml(title)}"></div>`;
  const frame = element.querySelector<HTMLDivElement>('.browser-frame')!;
  toolStage.appendChild(element);
  const panel: BrowserPanel = { id, url, title, element, frame, webview: null };
  browserPanels.set(id, panel);
  element.querySelector<HTMLFormElement>('[data-tool-search]')!.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = element.querySelector<HTMLInputElement>('[data-tool-url]');
    void navigateBrowserPanel(id, input?.value ?? '');
  });
  createNativeBrowserWebview(panel);
  activeToolId = id;
  saveWorkspaceLayout({ browserUrl: url });
  setView('tools');
  renderTools();
  showToast(`${title} abierto en Browser.`);
}

async function navigateBrowserPanel(id: string, rawUrl: string): Promise<void> {
  const panel = browserPanels.get(id);
  const url = browserInputToUrl(rawUrl);
  if (!panel || !url) return;
  const token = browserNavigationSequence++;
  browserNavigationTokens.set(id, token);
  const old = panel.webview;
  panel.webview = null;
  visibleBrowserWebviews.delete(id);
  browserWebviewGeometry.delete(id);
  panel.url = url;
  panel.title = new URL(url).hostname;
  const title = panel.element.querySelector<HTMLElement>('.tool-view-title strong');
  const address = panel.element.querySelector<HTMLInputElement>('[data-tool-url]');
  const status = panel.element.querySelector<HTMLElement>('[data-tool-status]');
  if (title) title.textContent = panel.title;
  if (address) address.value = url;
  if (status) status.textContent = 'LOADING';
  if (old) await old.close().catch(() => undefined);
  if (browserNavigationTokens.get(id) !== token || browserPanels.get(id) !== panel) return;
  createNativeBrowserWebview(panel);
  saveWorkspaceLayout({ browserUrl: url });
  renderTools();
}

function refreshTool(id: string): void {
  const browser = browserPanels.get(id);
  if (browser) {
    void navigateBrowserPanel(id, browser.url);
    return;
  }
  const localhost = localhostPanels.get(id);
  if (localhost) localhost.frame.contentWindow?.location.reload();
}

function closeLocalhostPanel(id: string): void {
  const panel = localhostPanels.get(id);
  if (!panel) return;
  panel.element.remove();
  localhostPanels.delete(id);
  if (layoutState.workspaces[activeWorkspaceId ?? '']?.localhostUrl === panel.url) saveWorkspaceLayout({ localhostUrl: null });
  if (activeToolId === id) {
    const toolIds = [...localhostPanels.keys(), ...browserPanels.keys()];
    activeToolId = toolIds[toolIds.length - 1] ?? null;
  }
  renderTools();
}

function closeBrowserPanel(id: string): void {
  const panel = browserPanels.get(id);
  if (!panel) return;
  browserNavigationTokens.delete(id);
  visibleBrowserWebviews.delete(id);
  browserWebviewGeometry.delete(id);
  if (panel.webview) void panel.webview.close().catch(() => undefined);
  panel.element.remove();
  browserPanels.delete(id);
  if (layoutState.workspaces[activeWorkspaceId ?? '']?.browserUrl === panel.url) saveWorkspaceLayout({ browserUrl: null });
  if (activeToolId === id) {
    const toolIds = [...localhostPanels.keys(), ...browserPanels.keys()];
    activeToolId = toolIds[toolIds.length - 1] ?? null;
  }
  renderTools();
}

function closeTool(id: string): void {
  if (localhostPanels.has(id)) closeLocalhostPanel(id);
  else closeBrowserPanel(id);
}

function closeAllTools(persistLayout = true): void {
  const previousWorkspaceLayout = activeWorkspaceId ? { ...layoutState.workspaces[activeWorkspaceId] } : undefined;
  for (const id of [...localhostPanels.keys()]) closeLocalhostPanel(id);
  for (const id of [...browserPanels.keys()]) closeBrowserPanel(id);
  activeToolId = null;
  if (!persistLayout && activeWorkspaceId && previousWorkspaceLayout) {
    layoutState.workspaces[activeWorkspaceId] = previousWorkspaceLayout;
  }
  if (persistLayout) saveLayout();
}

function openBrowserMenu(): void {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="browser-modal-backdrop"><form class="modal-panel browser-modal" id="browser-form"><div class="modal-heading"><div><span class="eyebrow">TOOLS / BROWSER</span><h2>Open browser</h2></div><button class="modal-close" id="browser-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">Carga un sitio o una búsqueda dentro de un browser integrado en tu workspace.</p><label class="field-label" for="browser-url-input">URL o búsqueda</label><input class="field-input" id="browser-url-input" placeholder="https://... o buscar en Google" autocomplete="url"/><div class="quick-links"><button type="button" data-browser-link="https://www.google.com">Google</button><button type="button" data-browser-link="https://www.youtube.com">YouTube</button><button type="button" data-browser-link="https://github.com">GitHub</button><button type="button" data-browser-link="https://developer.mozilla.org">MDN</button></div><div class="modal-actions"><button class="secondary-button" id="browser-modal-cancel" type="button">Cancelar</button><button class="primary-button" type="submit">${icons.browser}<span>Open browser</span></button></div></form></div>`;
  const form = document.querySelector<HTMLFormElement>('#browser-form')!;
  const close = (): void => { modalRoot.innerHTML = ''; scheduleWebviewSync(); };
  document.querySelector<HTMLButtonElement>('#browser-modal-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#browser-modal-cancel')!.addEventListener('click', close);
  document.querySelectorAll<HTMLButtonElement>('[data-browser-link]').forEach((button) => button.addEventListener('click', () => { createBrowserPanel(button.dataset.browserLink ?? ''); close(); }));
  form.addEventListener('submit', (event) => { event.preventDefault(); createBrowserPanel(document.querySelector<HTMLInputElement>('#browser-url-input')?.value ?? ''); close(); });
  document.querySelector<HTMLInputElement>('#browser-url-input')!.focus();
}

function openLocalhostMenu(): void {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="localhost-modal-backdrop"><form class="modal-panel" id="localhost-form"><div class="modal-heading"><div><span class="eyebrow">TOOLS / LOCAL PREVIEW</span><h2>Open localhost</h2></div><button class="modal-close" id="localhost-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">Carga un servidor local real. ComesADE no inicia servidores automáticamente.</p><label class="field-label" for="localhost-url-input">Dirección local</label><input class="field-input" id="localhost-url-input" value="http://localhost:3000" placeholder="http://localhost:3000"/><label class="field-label" for="localhost-name-input">Nombre <span>(opcional)</span></label><input class="field-input" id="localhost-name-input" placeholder="Frontend / API / Docs"/><div class="modal-actions"><button class="secondary-button" id="localhost-modal-cancel" type="button">Cancelar</button><button class="primary-button" type="submit">${icons.browser}<span>Open preview</span></button></div></form></div>`;
  const close = (): void => { modalRoot.innerHTML = ''; scheduleWebviewSync(); };
  document.querySelector<HTMLButtonElement>('#localhost-modal-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#localhost-modal-cancel')!.addEventListener('click', close);
  document.querySelector<HTMLFormElement>('#localhost-form')!.addEventListener('submit', (event) => { event.preventDefault(); createLocalhostPanel(document.querySelector<HTMLInputElement>('#localhost-url-input')?.value ?? '', document.querySelector<HTMLInputElement>('#localhost-name-input')?.value); close(); });
  document.querySelector<HTMLInputElement>('#localhost-url-input')!.focus();
}

async function launchAgent(program: string, name: string, workspace: WorkspaceInfo, args: string[], isolated: boolean, baseBranch: string, agentType = name, environment: Record<string, string> = {}): Promise<boolean> {
  let cwd = workspace.path;
  let worktree: string | undefined;
  if (isolated) {
    try {
      const suffix = `${Date.now().toString(36)}-${crypto.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}`;
      const safeProgram = program.replace(/[^a-zA-Z0-9_-]/g, '-');
      const branchName = 'agent/' + safeProgram + '-' + suffix;
      const worktreeRoot = appSettings.worktreeDirectory || workspace.path.replace(/[\\/]+$/, '') + '-worktrees';
      const destination = worktreeRoot.replace(/[\\/]+$/, '') + '/' + safeProgram + '-' + suffix;
      const created = await invoke<GitWorktree>('worktree_create', { path: workspace.path, worktreePath: destination, branchName, baseBranch: baseBranch || null });
      cwd = created.path;
      worktree = created.path;
      await refreshWorkspacePanels();
    } catch (error) {
      showToast('No se pudo crear el worktree Git real: ' + String(error), true);
      return false;
    }
  }
  const session = await createSession(name, cwd, { program, args, agentType, worktree, env: environment });
  return Boolean(session);
}

function splitCliArguments(raw: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const character of raw.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quote === '"') {
      escaped = true;
    } else if ((character === '"' || character === "'") && !quote) {
      quote = character;
    } else if (character === quote) {
      quote = '';
    } else if (/\s/.test(character) && !quote) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += '\\';
  if (current) result.push(current);
  return result;
}

async function openAgentMenu(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast('Abre un workspace real antes de lanzar un agente.', true);
    return;
  }
  if (!detectedAgents.length) {
    try {
      detectedAgents = await invoke<AgentDefinition[]>('detect_agents');
      agentsDetectionReady = true;
      renderAsaOverview();
    } catch (error) {
      showToast('No se pudo consultar los agentes: ' + String(error), true);
      return;
    }
  }
  const customAvailability = await Promise.all(appSettings.customAgents.map(async (agent) => ({
    agent,
    path: await invoke<string | null>('resolve_executable_path', { name: agent.executable }).catch(() => null),
  })));
  const orderedAgents = [...detectedAgents].sort((left, right) => Number(right.executable === appSettings.defaultAgent) - Number(left.executable === appSettings.defaultAgent) || left.name.localeCompare(right.name));
  const rows = orderedAgents.map((agent) => {
    const state = (agent.executable === appSettings.defaultAgent ? 'DEFAULT · ' : '') + (agent.installed ? 'INSTALLED' : 'NOT FOUND');
    const disabled = agent.installed ? '' : ' disabled';
    return '<button class="agent-launch-row" data-agent-id="' + escapeHtml(agent.id) + '" type="button"' + disabled + '><span class="panel-icon panel-icon-orange">' + icons.bolt + '</span><span><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.executable) + '</small></span><i>' + state + '</i></button>';
  }).join('');
  const customRows = customAvailability.map(({ agent, path }) => {
    const state = path ? 'INSTALLED' : 'NOT FOUND';
    const disabled = path ? '' : ' disabled';
    return '<button class="agent-launch-row agent-launch-row-custom" data-custom-agent-id="' + escapeHtml(agent.id) + '" type="button"' + disabled + '><span class="panel-icon panel-icon-gray">' + icons.terminal + '</span><span><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.executable) + '</small></span><i>' + state + '</i></button>';
  }).join('');
  modalRoot.innerHTML = '<div class="modal-backdrop" id="agent-launch-backdrop"><section class="modal-panel agent-launch-modal"><div class="modal-heading"><div><span class="eyebrow">AGENTS / REAL CLI</span><h2>New agent</h2></div><button class="modal-close" id="agent-launch-close" type="button">' + icons.close + '</button></div><p class="modal-copy">Cada agente se ejecuta como el CLI instalado en este PC, dentro de un PTY independiente. ComesADE no lo suplanta.</p><div class="agent-launch-list">' + (rows || '<div class="workspace-list-empty">No hay agentes conocidos instalados.</div>') + (customRows ? '<div class="agent-list-heading">Custom CLIs guardados</div>' + customRows : '') + '</div><div class="agent-custom-row"><label class="field-label" for="custom-agent-name">Custom CLI nuevo</label><input class="field-input" id="custom-agent-name" placeholder="Nombre visible (opcional)"/><input class="field-input" id="custom-agent-program" placeholder="ruta o ejecutable en PATH"/><input class="field-input" id="custom-agent-args" placeholder="argumentos separados por espacios (opcional)"/><button class="primary-button" id="custom-agent-launch" type="button">' + icons.terminal + '<span>Launch custom</span></button></div></section></div>';
  const customRow = document.querySelector<HTMLElement>('.agent-custom-row');
  if (customRow) {
    const isolation = document.createElement('div');
    isolation.className = 'agent-isolation-options';
    isolation.innerHTML = '<label><input type="checkbox" id="agent-isolated-worktree"/> <span>Crear worktree Git aislado</span></label><input class="field-input" id="agent-base-branch" placeholder="Base branch (vacio = HEAD)"/>';
    customRow.before(isolation);
  }
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#agent-launch-close')!.addEventListener('click', close);
  document.querySelectorAll<HTMLButtonElement>('[data-agent-id]').forEach((button) => button.addEventListener('click', () => {
    const agent = detectedAgents.find((item) => item.id === button.dataset.agentId);
    if (!agent || !agent.installed) return;
    const isolated = document.querySelector<HTMLInputElement>('#agent-isolated-worktree')?.checked ?? false;
    const baseBranch = document.querySelector<HTMLInputElement>('#agent-base-branch')?.value.trim() ?? '';
    close();
    void launchAgent(agent.executable, agent.name, workspace, agent.args, isolated, baseBranch, agent.id, agent.environment);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-custom-agent-id]').forEach((button) => button.addEventListener('click', () => {
    const custom = appSettings.customAgents.find((item) => item.id === button.dataset.customAgentId);
    if (!custom) return;
    const isolated = document.querySelector<HTMLInputElement>('#agent-isolated-worktree')?.checked ?? false;
    const baseBranch = document.querySelector<HTMLInputElement>('#agent-base-branch')?.value.trim() ?? '';
    close();
    void launchAgent(custom.executable, custom.name, workspace, custom.args, isolated, baseBranch, custom.id, custom.environment);
  }));
  document.querySelector<HTMLButtonElement>('#custom-agent-launch')!.addEventListener('click', () => {
    const program = document.querySelector<HTMLInputElement>('#custom-agent-program')!.value.trim();
    const args = document.querySelector<HTMLInputElement>('#custom-agent-args')!.value.trim();
    const name = document.querySelector<HTMLInputElement>('#custom-agent-name')?.value.trim() || compactPathLabel(program);
    if (!program) {
      showToast('Escribe el ejecutable real del CLI.', true);
      return;
    }
    const isolated = document.querySelector<HTMLInputElement>('#agent-isolated-worktree')?.checked ?? false;
    const baseBranch = document.querySelector<HTMLInputElement>('#agent-base-branch')?.value.trim() ?? '';
    close();
    const parsedArgs = splitCliArguments(args);
    void (async () => {
      const custom = rememberCustomAgent(name, program, parsedArgs);
      await launchAgent(custom.executable, custom.name, workspace, custom.args, isolated, baseBranch, custom.id);
    })();
  });
}

function openSessionMenu(): void {
  if (!getWorkspace()) {
    showToast('Abre o crea un workspace antes de iniciar una terminal real.', true);
    return;
  }
  const availableShells = detectedShells.filter((shell) => shell.installed);
  const shells = availableShells.length ? availableShells : [fallbackShellDefinition()];
  modalRoot.innerHTML = `<div class="modal-backdrop" id="session-modal-backdrop"><form class="modal-panel" id="session-form"><div class="modal-heading"><div><span class="eyebrow">TERMINALS / LOCAL PROCESS</span><h2>Open session</h2></div><button class="modal-close" id="session-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">Se abrirá un shell real con nombre automático. No se iniciará ningún proceso antes de confirmar.</p><div class="auto-name-row"><span class="panel-icon panel-icon-orange">${icons.terminal}</span><span><strong>Nombre automático</strong><small>Se elige un nombre único entre 100 opciones.</small></span></div><label class="field-label" for="session-cwd-input">Directorio inicial <span>(opcional)</span></label><input class="field-input" id="session-cwd-input" placeholder="Vacío = workspace activo"/><div class="modal-actions"><button class="secondary-button" id="session-modal-cancel" type="button">Cancelar</button><button class="primary-button" type="submit">${icons.terminal}<span>Open shell</span></button></div></form></div>`;
  const cwdInput = document.querySelector<HTMLInputElement>('#session-cwd-input');
  if (cwdInput) {
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = 'Shell real';
    const select = document.createElement('select');
    select.className = 'field-input';
    select.id = 'session-shell-input';
    for (const shell of shells) {
      const option = document.createElement('option');
      option.value = shell.id;
      option.textContent = `${shell.name} · ${shell.executable}`;
      select.appendChild(option);
    }
    if (shells.some((shell) => shell.id === appSettings.defaultShell)) select.value = appSettings.defaultShell;
    label.htmlFor = select.id;
    cwdInput.before(label, select);
  }
  const sessionDescription = document.querySelector<HTMLElement>('#session-form .modal-copy');
  if (sessionDescription) sessionDescription.textContent = `Se abrirá un ${activeShellName()} real con nombre automático. No se iniciará ningún proceso antes de confirmar.`;
  const sessionSubmit = document.querySelector<HTMLButtonElement>('#session-form button[type="submit"] span');
  if (sessionSubmit) sessionSubmit.textContent = `Open ${activeShellName()}`;
  const updateShellCopy = (): void => {
    const selectedId = document.querySelector<HTMLSelectElement>('#session-shell-input')?.value;
    const selectedShell = shells.find((shell) => shell.id === selectedId);
    const shellName = selectedShell?.name ?? activeShellName();
    if (sessionDescription) sessionDescription.textContent = `Se abrirá un ${shellName} real con nombre automático. No se iniciará ningún proceso antes de confirmar.`;
    if (sessionSubmit) sessionSubmit.textContent = `Open ${shellName}`;
  };
  document.querySelector<HTMLSelectElement>('#session-shell-input')?.addEventListener('change', updateShellCopy);
  updateShellCopy();
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLFormElement>('#session-form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const cwd = document.querySelector<HTMLInputElement>('#session-cwd-input')?.value;
    const shell = document.querySelector<HTMLSelectElement>('#session-shell-input')?.value || runtimePlatform.defaultShell;
    close();
    await createSession(randomName(), cwd || getWorkspace()?.path, { shell });
  }, true);
  document.querySelector<HTMLButtonElement>('#session-modal-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#session-modal-cancel')!.addEventListener('click', close);
  document.querySelector<HTMLInputElement>('#session-cwd-input')!.focus();
}

function openWorkspaceModal(returnToMenu = true, enterAfter = false): void {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="workspace-modal-backdrop"><form class="modal-panel" id="workspace-form"><div class="modal-heading"><div><span class="eyebrow">WORKSPACES / LOCAL</span><h2>Create workspace</h2></div><button class="modal-close" id="workspace-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">La carpeta es opcional. Si la dejas vacía, usaremos Documentos local fuera de OneDrive.</p><label class="field-label" for="workspace-name-input">Nombre del workspace</label><input class="field-input" id="workspace-name-input" placeholder="Mi proyecto" required/><label class="field-label" for="workspace-path-input">Carpeta local <span>(opcional)</span></label><input class="field-input" id="workspace-path-input" placeholder="Vacío = Documentos local"/><div class="modal-actions"><button class="secondary-button" id="workspace-modal-cancel" type="button">Cancelar</button><button class="primary-button" type="submit">${icons.folder}<span>Create workspace</span></button></div></form></div>`;
  const close = (): void => { modalRoot.innerHTML = ''; if (returnToMenu) openMainMenu(); };
  document.querySelector<HTMLButtonElement>('#workspace-modal-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#workspace-modal-cancel')!.addEventListener('click', close);
  document.querySelector<HTMLFormElement>('#workspace-form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector<HTMLInputElement>('#workspace-name-input')!.value.trim();
    const requestedPath = document.querySelector<HTMLInputElement>('#workspace-path-input')!.value.trim();
    try {
      const path = requestedPath ? await invoke<string>('validate_workspace_path', { path: requestedPath }) : await invoke<string>('default_workspace_path');
      if (!prepareEditorForRootChange(path)) return;
      const workspace: WorkspaceInfo = { id: `workspace-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, name, path, createdAt: new Date().toISOString() };
      closeAllTools(false);
      saveLayout();
      workspaces.unshift(workspace);
      activeWorkspaceId = workspace.id;
      loadSessionDefinitions();
      saveWorkspaces();
      await startWorkspaceWatcher(workspace.path);
      await syncRuntimeSessions();
      updateWorkspaceView();
      render();
      modalRoot.innerHTML = '';
      if (enterAfter) enterWorkspace();
      else if (returnToMenu) openMainMenu();
      showToast(`${name} listo para trabajar.`);
    } catch (error) {
      showToast(String(error), true);
    }
  });
  document.querySelector<HTMLInputElement>('#workspace-name-input')!.focus();
}

function openCloneRepositoryModal(returnToMenu = true, enterAfter = true): void {
  let selectedRepository: GithubRepository | null = null;
  modalRoot.innerHTML = `<div class="modal-backdrop" id="clone-backdrop"><form class="modal-panel clone-modal" id="clone-form"><div class="modal-heading"><div><span class="eyebrow">GIT / GITHUB</span><h2>Clone repository</h2></div><div class="github-modal-actions"><button class="secondary-button github-disconnect" id="github-disconnect" type="button">Desconectar</button><button class="modal-close" id="clone-close" type="button" aria-label="Cerrar">${icons.close}</button></div></div><p class="modal-copy">Selecciona un repositorio real de tu cuenta o usa una URL Git. El clone se ejecuta en este PC y la carpeta destino debe estar vacía.</p><section class="github-repository-picker" aria-labelledby="github-repository-heading"><div class="github-repository-heading"><div><span class="eyebrow">GITHUB / REPOSITORIES</span><strong id="github-repository-heading">Repositorios disponibles</strong><small id="github-repository-account">Comprobando cuenta…</small></div><button class="secondary-button github-repository-refresh" id="github-repositories-refresh" type="button">Actualizar</button></div><input class="field-input" id="github-repository-search" type="search" placeholder="Filtrar por nombre o descripción" autocomplete="off" aria-label="Filtrar repositorios de GitHub"/><div class="github-repository-list" id="github-repository-list" role="listbox" aria-label="Repositorios de GitHub"></div><div class="github-repository-selection" id="github-repository-selection" hidden></div></section><div class="clone-manual-fields"><label class="field-label" for="clone-url">Repository URL</label><input class="field-input" id="clone-url" placeholder="https://github.com/owner/repository.git" required/><label class="field-label" for="clone-destination">Destination</label><input class="field-input" id="clone-destination" placeholder="C:\\Users\\...\\Documents\\repository" required/></div><div class="modal-actions"><button class="secondary-button" id="clone-cancel" type="button">Cancel</button><button class="primary-button" type="submit">${icons.folder}<span>Clone</span></button></div></form></div>`;
  const repositorySearch = document.querySelector<HTMLInputElement>('#github-repository-search')!;
  const repositoryList = document.querySelector<HTMLDivElement>('#github-repository-list')!;
  const repositorySelection = document.querySelector<HTMLElement>('#github-repository-selection')!;
  const cloneUrlInput = document.querySelector<HTMLInputElement>('#clone-url')!;
  const destinationInput = document.querySelector<HTMLInputElement>('#clone-destination')!;
  const refreshRepositoriesButton = document.querySelector<HTMLButtonElement>('#github-repositories-refresh')!;
  const disconnectButton = document.querySelector<HTMLButtonElement>('#github-disconnect')!;
  const renderSelection = (): void => {
    renderGithubRepositoryList(repositorySearch.value, selectedRepository?.fullName ?? '');
    if (!selectedRepository) {
      repositorySelection.hidden = true;
      repositorySelection.textContent = '';
      return;
    }
    repositorySelection.hidden = false;
    repositorySelection.innerHTML = `<strong>Repositorio seleccionado</strong><span>${escapeHtml(selectedRepository.fullName)} · ${escapeHtml(selectedRepository.private ? 'privado' : 'público')}</span>`;
  };
  const close = (): void => { modalRoot.innerHTML = ''; if (returnToMenu) openMainMenu(); };
  document.querySelector<HTMLButtonElement>('#clone-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#clone-cancel')!.addEventListener('click', close);
  disconnectButton.addEventListener('click', async () => {
    disconnectButton.disabled = true;
    try {
      await invoke('github_disconnect');
      githubRepositories = [];
      githubRepositoriesLoaded = false;
      githubRepositoriesError = null;
      await refreshGithubAuth();
      modalRoot.innerHTML = '';
      if (returnToMenu) openMainMenu();
      showToast('Cuenta de GitHub desconectada de este equipo.');
    } catch (error) {
      disconnectButton.disabled = false;
      showToast(`No se pudo desconectar GitHub: ${String(error)}`, true);
    }
  });
  repositorySearch.addEventListener('input', () => renderSelection());
  repositoryList.addEventListener('click', (event) => {
    const fullName = (event.target as HTMLElement).closest<HTMLElement>('[data-github-repository]')?.dataset.githubRepository;
    if (!fullName) return;
    const repository = githubRepositories.find((candidate) => candidate.fullName === fullName);
    if (!repository) return;
    selectedRepository = repository;
    cloneUrlInput.value = repository.cloneUrl;
    const shouldAutofillDestination = !destinationInput.value.trim() || destinationInput.dataset.autofilled === 'true';
    if (shouldAutofillDestination) {
      void invoke<string>('default_workspace_path').then((basePath) => {
        if (destinationInput.value.trim() && destinationInput.dataset.autofilled !== 'true') return;
        const separator = basePath.includes('\\') ? '\\' : '/';
        destinationInput.value = `${basePath.replace(/[\\/]+$/, '')}${separator}${repository.name}`;
        destinationInput.dataset.autofilled = 'true';
      }).catch(() => undefined);
    }
    renderSelection();
  });
  cloneUrlInput.addEventListener('input', () => {
    if (selectedRepository && cloneUrlInput.value.trim() !== selectedRepository.cloneUrl) {
      selectedRepository = null;
      renderSelection();
    }
  });
  destinationInput.addEventListener('input', () => { destinationInput.dataset.autofilled = 'false'; });
  refreshRepositoriesButton.addEventListener('click', () => { void loadGithubRepositories(true); });
  document.querySelector<HTMLFormElement>('#clone-form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = document.querySelector<HTMLInputElement>('#clone-url')!.value.trim();
    const destination = document.querySelector<HTMLInputElement>('#clone-destination')!.value.trim();
    if (!url || !destination) return;
    const submit = document.querySelector<HTMLButtonElement>('#clone-form button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      if (!(await ensureGitAvailable())) {
        if (submit) submit.disabled = false;
        return;
      }
      if (selectedRepository) {
        await invoke<string>('github_clone_repository', { clientId: GITHUB_CLIENT_ID, repository: selectedRepository.fullName, destination });
      } else {
        await invoke<string>('clone_repository', { url, destination });
      }
      modalRoot.innerHTML = '';
      await registerWorkspaceFromPath(destination, enterAfter);
      showToast('Repositorio clonado y abierto desde el disco real.');
    } catch (error) {
      if (submit) submit.disabled = false;
      showToast('No se pudo clonar el repositorio: ' + String(error), true);
    }
  });
  renderSelection();
  void loadGithubRepositories();
  repositorySearch.focus();
}

function openWorkspaceBrowser(returnToMenu = true, enterAfter = false): void {
  let selectedWorkspaceId: string | null = null;
  modalRoot.innerHTML = `<div class="modal-backdrop" id="workspace-browser-backdrop"><section class="modal-panel workspace-browser-modal"><div class="modal-heading"><div><span class="eyebrow">WORKSPACES / LOCAL</span><h2>Open workspace</h2></div><button class="modal-close" id="workspace-browser-close" type="button">${icons.close}</button></div><p class="modal-copy">Selecciona una carpeta real de este PC o usa un workspace guardado localmente.</p><div class="workspace-browser-picker"><button class="secondary-button" id="workspace-browser-pick" type="button">${icons.folder}<span>Elegir carpeta real</span></button><small>La carpeta se valida antes de abrirla y no se crean datos de muestra.</small></div><div class="workspace-list-modal">${workspaces.length ? workspaces.map((workspace) => `<button class="workspace-list-item ${workspace.id === activeWorkspaceId ? 'workspace-list-item-active' : ''}" data-workspace-id="${workspace.id}" type="button"><span class="panel-icon panel-icon-gray">${icons.folder}</span><span><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(workspace.path)}</small></span>${workspace.id === activeWorkspaceId ? '<i>ACTIVE</i>' : icons.chevron}</button>`).join('') : '<div class="workspace-list-empty">No hay workspaces guardados.</div>'}</div><div class="modal-actions"><button class="secondary-button" id="workspace-browser-new" type="button">${icons.add}<span>New workspace</span></button><button class="primary-button" id="workspace-browser-done" type="button">Done</button></div></section></div>`;
  const workspaceActions = document.querySelector<HTMLElement>('.workspace-browser-modal .modal-actions');
  const workspaceSelectionNote = document.createElement('p');
  workspaceSelectionNote.className = 'workspace-selection-note';
  workspaceSelectionNote.id = 'workspace-selection-note';
  workspaceSelectionNote.setAttribute('role', 'status');
  workspaceSelectionNote.setAttribute('aria-live', 'polite');
  workspaceSelectionNote.textContent = workspaces.length
    ? 'Selecciona el nombre del workspace que quieres abrir.'
    : 'No hay workspaces guardados para seleccionar.';
  document.querySelector<HTMLElement>('.workspace-browser-modal .workspace-list-modal')?.after(workspaceSelectionNote);

  const openWorkspaceButton = document.createElement('button');
  openWorkspaceButton.className = 'primary-button';
  openWorkspaceButton.id = 'workspace-browser-open';
  openWorkspaceButton.type = 'button';
  openWorkspaceButton.disabled = true;
  openWorkspaceButton.innerHTML = icons.folder + '<span>Open workspace</span>';
  workspaceActions?.append(openWorkspaceButton);

  const close = (): void => { modalRoot.innerHTML = ''; if (returnToMenu) openMainMenu(); };
  document.querySelector<HTMLButtonElement>('#workspace-browser-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#workspace-browser-done')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#workspace-browser-pick')!.addEventListener('click', () => { void pickAndOpenWorkspace(returnToMenu, enterAfter); });
  document.querySelector<HTMLButtonElement>('#workspace-browser-new')!.addEventListener('click', () => openWorkspaceModal(returnToMenu, enterAfter));
  const cloneButton = document.createElement('button');
  cloneButton.className = 'secondary-button';
  cloneButton.id = 'workspace-browser-clone';
  cloneButton.type = 'button';
  cloneButton.innerHTML = icons.external + '<span>Clone repository</span>';
  document.querySelector<HTMLElement>('#workspace-browser-new')?.before(cloneButton);
  cloneButton.addEventListener('click', () => openCloneRepositoryModal(returnToMenu, enterAfter));
  const workspaceButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-workspace-id]'));
  workspaceButtons.forEach((button) => {
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      const workspace = getWorkspace(button.dataset.workspaceId ?? null);
      if (!workspace) return;
      selectedWorkspaceId = workspace.id;
      workspaceButtons.forEach((candidate) => {
        const selected = candidate.dataset.workspaceId === selectedWorkspaceId;
        candidate.classList.toggle('workspace-list-item-selected', selected);
        candidate.setAttribute('aria-pressed', String(selected));
      });
      workspaceSelectionNote.classList.add('is-selected');
      workspaceSelectionNote.textContent = `Seleccionado: ${workspace.name}. Pulsa Open workspace para continuar.`;
      openWorkspaceButton.disabled = false;
    });
  });
  openWorkspaceButton.addEventListener('click', () => {
    const workspace = getWorkspace(selectedWorkspaceId);
    if (!workspace) {
      workspaceSelectionNote.classList.remove('is-selected');
      workspaceSelectionNote.textContent = 'Selecciona el nombre del workspace que quieres abrir.';
      openWorkspaceButton.disabled = true;
      return;
    }
    openWorkspaceButton.disabled = true;
    void activateWorkspace(workspace, enterAfter || returnToMenu).finally(() => {
      if (document.body.contains(openWorkspaceButton)) openWorkspaceButton.disabled = false;
    });
  });
}

async function openSettingsModal(): Promise<void> {
  if (!detectedShells.length || !detectedAgents.length) {
    const [shellResult, agentResult] = await Promise.allSettled([
      detectedShells.length ? Promise.resolve(detectedShells) : invoke<ShellDefinition[]>('detect_shells'),
      detectedAgents.length ? Promise.resolve(detectedAgents) : invoke<AgentDefinition[]>('detect_agents'),
    ]);
    if (shellResult.status === 'fulfilled') detectedShells = shellResult.value;
    if (agentResult.status === 'fulfilled') {
      detectedAgents = agentResult.value;
      agentsDetectionReady = true;
      renderAsaOverview();
    }
    normalizeDefaultShell();
  }
  const availableSettingsShells = detectedShells.filter((shell) => shell.installed);
  const settingsShellChoices = (availableSettingsShells.length ? availableSettingsShells : [fallbackShellDefinition()]).map((shell) => '<option value="' + escapeHtml(shell.id) + '"' + (shell.id === appSettings.defaultShell ? ' selected' : '') + '>' + escapeHtml(shell.name + ' · ' + shell.executable) + '</option>').join('');
  const settingsAgentChoices = detectedAgents.filter((agent) => agent.installed).map((agent) => '<option value="' + escapeHtml(agent.executable) + '"' + (agent.executable === appSettings.defaultAgent ? ' selected' : '') + '>' + escapeHtml(agent.name + ' · ' + agent.executable) + '</option>').join('');
  const settingsEnvironmentText = escapeHtml(Object.entries(appSettings.environment).map(([key, value]) => key + '=' + value).join('\n'));
  modalRoot.innerHTML = '<div class="modal-backdrop" id="settings-backdrop"><section class="modal-panel settings-modal"><div class="modal-heading"><div><span class="eyebrow">COMESADE / SETTINGS</span><h2>Configuración local</h2></div><button class="modal-close" id="settings-close" type="button">' + icons.close + '</button></div><p class="modal-copy">Estas preferencias controlan procesos reales, terminales y worktrees de este equipo.</p><div class="settings-grid"><label class="setting-field"><span>Shell predeterminado</span><select class="field-input" id="settings-shell">' + settingsShellChoices + '</select><small>Se usará al abrir una nueva terminal.</small></label><label class="setting-field"><span>Agente predeterminado</span><select class="field-input" id="settings-agent"><option value=""' + (!appSettings.defaultAgent ? ' selected' : '') + '>Selección manual</option>' + settingsAgentChoices + '</select><small>Se prioriza en el lanzador, siempre ejecutando el CLI real.</small></label><label class="setting-field"><span>Fuente de terminal</span><input class="field-input" id="settings-font" value="' + escapeHtml(appSettings.terminalFont) + '"/><small>Usa una fuente instalada, por ejemplo Cascadia Mono.</small></label><label class="setting-field"><span>Tamaño de fuente</span><input class="field-input" id="settings-font-size" type="number" min="10" max="28" value="' + String(appSettings.terminalFontSize) + '"/><small>Entre 10 y 28 px.</small></label><label class="setting-field"><span>Cursor</span><select class="field-input" id="settings-cursor"><option value="bar"' + (appSettings.terminalCursor === 'bar' ? ' selected' : '') + '>Barra</option><option value="block"' + (appSettings.terminalCursor === 'block' ? ' selected' : '') + '>Bloque</option><option value="underline"' + (appSettings.terminalCursor === 'underline' ? ' selected' : '') + '>Subrayado</option></select><small>Se aplica también a terminales ya abiertas.</small></label><label class="setting-field"><span>Scrollback</span><input class="field-input" id="settings-scrollback" type="number" min="1000" max="100000" step="1000" value="' + String(appSettings.terminalScrollback) + '"/><small>Líneas conservadas por terminal real.</small></label><label class="setting-field settings-field-wide"><span>Directorio de worktrees</span><input class="field-input" id="settings-worktree" placeholder="Vacío = carpeta hermana del workspace" value="' + escapeHtml(appSettings.worktreeDirectory) + '"/><small>Se usa únicamente al elegir aislamiento Git.</small></label></div><label class="setting-field settings-field-wide"><span>Variables de entorno</span><small>Una por línea, formato NOMBRE=valor. Se inyectan al crear procesos nuevos.</small><textarea class="field-input settings-environment" id="settings-environment" spellcheck="false">' + settingsEnvironmentText + '</textarea></label><label class="setting-row settings-motion-row"><span><strong>Tema Chat/Gemini</strong><small>Transforma la interfaz a un modo conversacional (flotante).</small></span><input id="settings-gemini-theme" type="checkbox"' + (appSettings.geminiTheme ? ' checked' : '') + '/></label><label class="setting-row settings-motion-row"><span><strong>Animación ambiental</strong><small>Movimiento visual mínimo; no abre procesos ni consume VRAM.</small></span><input id="settings-motion" type="checkbox"' + (appSettings.backgroundAnimation ? ' checked' : '') + '/></label><div class="settings-info"><span class="panel-icon panel-icon-orange">' + icons.bolt + '</span><span><strong>Local-first</strong><small>PowerShell, archivos, Git y configuraciones permanecen en esta PC.</small></span></div><div class="modal-actions"><button class="secondary-button" id="settings-back" type="button">Volver al menú</button><button class="primary-button" id="settings-save" type="button">Guardar cambios</button></div></section></div>';
  const settingsPanel = document.querySelector<HTMLElement>('.settings-modal');
  const settingsTitle = settingsPanel?.querySelector<HTMLElement>('h2');
  const settingsDescription = settingsPanel?.querySelector<HTMLElement>('.modal-copy');
  settingsPanel?.setAttribute('role', 'dialog');
  settingsPanel?.setAttribute('aria-modal', 'true');
  settingsTitle?.setAttribute('id', 'settings-title');
  settingsDescription?.setAttribute('id', 'settings-description');
  settingsPanel?.setAttribute('aria-labelledby', 'settings-title');
  settingsPanel?.setAttribute('aria-describedby', 'settings-description');

  const settingFields = Array.from(document.querySelectorAll<HTMLElement>('.settings-modal .settings-grid > .setting-field'));
  const insertSettingsSection = (anchor: Element | null | undefined, number: string, title: string, detail: string): void => {
    if (!anchor?.parentElement) return;
    const heading = document.createElement('div');
    heading.className = 'settings-section-heading';
    heading.innerHTML = '<span>' + number + '</span><strong>' + title + '</strong><small>' + detail + '</small>';
    anchor.parentElement.insertBefore(heading, anchor);
  };
  insertSettingsSection(settingFields[0], '01', 'Ejecucion', 'Procesos y agentes predeterminados');
  insertSettingsSection(settingFields[2], '02', 'Terminal y apariencia', 'Tipografia, cursor y buffer');
  insertSettingsSection(settingFields[6], '03', 'Workspace e integraciones', 'Aislamiento y variables locales');
  insertSettingsSection(
    document.querySelector<HTMLElement>('.settings-modal > .settings-field-wide'),
    '04',
    'Variables de entorno',
    'Se aplican a procesos nuevos',
  );
  insertSettingsSection(
    document.querySelector<HTMLElement>('.settings-modal > .settings-motion-row'),
    '05',
    'Experiencia',
    'Preferencias visuales de la superficie',
  );

  const settingsInfo = document.querySelector<HTMLElement>('.settings-info small');
  if (settingsInfo) settingsInfo.textContent = 'El shell, las notas y las herramientas permanecen en esta PC.';
  const closeToMenu = (): void => openMainMenu();
  const settingsActions = document.querySelector<HTMLElement>('.settings-modal .modal-actions');
  const checkUpdateButton = document.createElement('button');
  checkUpdateButton.className = 'secondary-button';
  checkUpdateButton.type = 'button';
  checkUpdateButton.textContent = 'Buscar actualizaciones';
  settingsActions?.insertBefore(checkUpdateButton, settingsActions.querySelector('#settings-save'));
  checkUpdateButton.addEventListener('click', async () => {
    checkUpdateButton.disabled = true;
    checkUpdateButton.textContent = 'Comprobando...';
    try {
      await checkForAppUpdate(true);
    } finally {
      if (document.body.contains(checkUpdateButton)) {
        checkUpdateButton.disabled = false;
        checkUpdateButton.textContent = 'Buscar actualizaciones';
      }
    }
  });
  document.querySelector<HTMLButtonElement>('#settings-close')!.addEventListener('click', closeToMenu);
  document.querySelector<HTMLButtonElement>('#settings-back')!.addEventListener('click', closeToMenu);
  document.querySelector<HTMLButtonElement>('#settings-save')!.addEventListener('click', () => {
    const environment: Record<string, string> = {};
    const rawEnvironment = document.querySelector<HTMLTextAreaElement>('#settings-environment')?.value ?? '';
    for (const line of rawEnvironment.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const separator = line.indexOf('=');
      const key = separator >= 0 ? line.slice(0, separator).trim() : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        showToast('Variable inválida: usa NOMBRE=valor.', true);
        return;
      }
      environment[key] = line.slice(separator + 1).slice(0, 4000);
    }
    const cursorValue = document.querySelector<HTMLSelectElement>('#settings-cursor')?.value ?? 'bar';
    const terminalCursor: AppSettings['terminalCursor'] = cursorValue === 'block' || cursorValue === 'underline' ? cursorValue : 'bar';
    const parsedFontSize = Number.parseInt(document.querySelector<HTMLInputElement>('#settings-font-size')?.value ?? '', 10);
    const parsedScrollback = Number.parseInt(document.querySelector<HTMLInputElement>('#settings-scrollback')?.value ?? '', 10);
    appSettings = {
      ...appSettings,
      geminiTheme: document.querySelector<HTMLInputElement>('#settings-gemini-theme')?.checked ?? false,
      backgroundAnimation: document.querySelector<HTMLInputElement>('#settings-motion')?.checked ?? true,
      defaultShell: document.querySelector<HTMLSelectElement>('#settings-shell')?.value.trim() || runtimePlatform.defaultShell,
      defaultAgent: document.querySelector<HTMLSelectElement>('#settings-agent')?.value.trim() ?? '',
      terminalFont: document.querySelector<HTMLInputElement>('#settings-font')?.value.trim().slice(0, 160) || defaultTerminalFont(),
      terminalFontSize: Number.isFinite(parsedFontSize) ? Math.min(Math.max(parsedFontSize, 10), 28) : appSettings.terminalFontSize,
      terminalCursor,
      terminalScrollback: Number.isFinite(parsedScrollback) ? Math.min(Math.max(parsedScrollback, 1000), 100000) : appSettings.terminalScrollback,
      worktreeDirectory: document.querySelector<HTMLInputElement>('#settings-worktree')?.value.trim().slice(0, 500) ?? '',
      environment,
    };
    saveSettings();
    applySettings();
    openMainMenu();
    showToast('Configuración guardada localmente.');
  });
}

function openMainMenu(): void {
  mainMenuOpen = true;
  updateWorkspaceView();
  const workspace = getWorkspace();
  const workspaceCount = `${workspaces.length} saved workspace${workspaces.length === 1 ? '' : 's'}`;
  const runtimeState = connectionState.textContent?.trim() || 'LOCAL / STARTING';
  const currentWorkspace = workspace
    ? `<button class="main-menu-current main-menu-workspace-card" id="main-menu-current" type="button" aria-label="Select ${escapeHtml(workspace.name)} workspace to open it"><span class="panel-icon panel-icon-orange">${icons.folder}</span><span class="main-menu-workspace-copy"><span class="main-menu-workspace-label">CURRENT WORKSPACE</span><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(workspace.path)}</small></span><span class="main-menu-workspace-state"><i></i><span>SAVED LOCALLY</span></span>${icons.chevron}</button>`
    : `<div class="main-menu-current main-menu-current-empty"><span class="panel-icon panel-icon-gray">${icons.folder}</span><span class="main-menu-workspace-copy"><span class="main-menu-workspace-label">CURRENT WORKSPACE</span><strong>No workspace selected</strong><small>Create or open a real folder to continue.</small></span><span class="main-menu-workspace-state"><i class="is-empty"></i><span>NOT SELECTED</span></span></div>`;
  modalRoot.innerHTML = `<div class="modal-backdrop main-menu-backdrop" id="main-menu-backdrop" role="dialog" aria-modal="true" aria-labelledby="main-menu-title" aria-describedby="main-menu-copy"><section class="main-menu-panel"><div class="main-menu-topline"><div class="main-menu-brand"><div class="brand-mark"><img src="${comesadeLogoUrl}" alt="" aria-hidden="true" /></div><span><strong>ComesADE</strong><small>LOCAL DEVELOPMENT DESKTOP</small></span></div><div class="main-menu-local-state"><i></i><span>${escapeHtml(runtimeState)}</span></div></div><div class="main-menu-heading"><div><span class="eyebrow">COMESADE / MAIN MENU</span><h2 id="main-menu-title">Where do you want to <em>work?</em></h2><p class="main-menu-copy" id="main-menu-copy">Start with a real workspace. Your files, terminals, Git changes and tools stay connected to that folder.</p></div><div class="main-menu-hint"><kbd>LOCAL</kbd><span>Data stays on this PC</span></div></div><div class="main-menu-section-heading"><span>Workspace</span><small>${workspaceCount}</small></div>${currentWorkspace}<div class="main-menu-section-heading main-menu-actions-heading"><span>Start here</span><small>Choose one real action</small></div><div class="main-menu-actions"><button class="main-menu-action main-menu-action-primary" id="main-menu-open" type="button"><span class="panel-icon panel-icon-orange">${icons.folder}</span><span><strong>Open workspace</strong><small>Choose a saved workspace or a real folder on this PC.</small></span>${icons.chevron}</button><button class="main-menu-action" id="main-menu-create" type="button"><span class="panel-icon panel-icon-orange">${icons.add}</span><span><strong>Create workspace</strong><small>Use a name and an optional local folder.</small></span>${icons.chevron}</button><button class="main-menu-action" id="main-menu-clone" type="button"><span class="panel-icon panel-icon-gray">${icons.external}</span><span><strong>Clone repository</strong><small>Run a real Git clone and open the result.</small></span>${icons.chevron}</button><button class="main-menu-action" id="main-menu-settings" type="button"><span class="panel-icon panel-icon-blue">${icons.settings}</span><span><strong>Settings</strong><small>Configure shells, agents, fonts and local behavior.</small></span>${icons.chevron}</button></div><footer class="main-menu-footer"><span><i></i>WORKSPACE REQUIRED TO ENTER THE DESKTOP</span><small>${workspaceCount}</small></footer></section></div>`;
  syncMainMenuRuntimeState();
  document.querySelector<HTMLButtonElement>('#main-menu-current')?.addEventListener('click', () => {
    openWorkspaceBrowser(true, true);
  });
  document.querySelector<HTMLButtonElement>('#main-menu-open')?.addEventListener('click', () => openWorkspaceBrowser(true, true));
  document.querySelector<HTMLButtonElement>('#main-menu-create')?.addEventListener('click', () => openWorkspaceModal(true, true));
  document.querySelector<HTMLButtonElement>('#main-menu-clone')?.addEventListener('click', () => openCloneRepositoryModal(true, true));
  document.querySelector<HTMLButtonElement>('#main-menu-settings')?.addEventListener('click', openSettingsModal);
  (document.querySelector<HTMLButtonElement>('#main-menu-current') ?? document.querySelector<HTMLButtonElement>('#main-menu-open'))?.focus();
}

function syncMainMenuRuntimeState(): void {
  const state = document.querySelector<HTMLElement>('.main-menu-local-state');
  const label = state?.querySelector('span');
  if (!state || !label) return;
  const value = connectionState.textContent?.trim() || 'LOCAL / STARTING';
  label.textContent = value;
  state.classList.toggle('is-ready', value === 'LOCAL / READY');
  state.classList.toggle('is-error', value.includes('ERROR'));
}

function openRuntimeModal(): void {
  const workspace = getWorkspace();
  const liveSessionCount = sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id)).length;
  modalRoot.innerHTML = `<div class="modal-backdrop" id="runtime-backdrop"><section class="modal-panel"><div class="modal-heading"><div><span class="eyebrow">RUNTIME / LOCAL PROCESS</span><h2>Runtime details</h2></div><button class="modal-close" id="runtime-close" type="button">${icons.close}</button></div><p class="modal-copy">Las sesiones mostradas aquí son procesos ${escapeHtml(activeShellName())} reales en esta PC.</p><div class="runtime-details"><div><span>WORKSPACE</span><strong>${escapeHtml(workspace?.name ?? 'Sin workspace')}</strong></div><div><span>PATH</span><strong>${escapeHtml(workspace?.path ?? '—')}</strong></div><div><span>LIVE SESSIONS</span><strong>${liveSessionCount}</strong></div></div><div class="runtime-session-list">${sessions.length ? sessions.map((session) => `<div class="runtime-session-row"><span class="session-avatar">${escapeHtml(session.name.charAt(0))}</span><span><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.cwd)}</small></span><button class="text-action" data-runtime-focus="${session.id}" type="button">Focus</button><button class="text-action text-action-danger" data-runtime-close="${session.id}" type="button">Close</button></div>`).join('') : '<div class="workspace-list-empty">No hay sesiones abiertas.</div>'}</div><div class="modal-actions"><button class="primary-button" id="runtime-done" type="button">Done</button></div></section></div>`;
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#runtime-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#runtime-done')!.addEventListener('click', close);
  document.querySelectorAll<HTMLButtonElement>('[data-runtime-focus]').forEach((button) => button.addEventListener('click', () => { activateSession(button.dataset.runtimeFocus ?? ''); close(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-runtime-close]').forEach((button) => button.addEventListener('click', async () => { await closeSession(button.dataset.runtimeClose ?? ''); openRuntimeModal(); }));
}

function openCommandPalette(): void {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="palette-backdrop"><form class="modal-panel command-palette" id="palette-form"><div class="modal-heading"><div><span class="eyebrow">COMMAND PALETTE</span><h2>Find or run</h2></div><button class="modal-close" id="palette-close" type="button">${icons.close}</button></div><input class="field-input palette-input" id="palette-input" placeholder="Session name or > command" autocomplete="off"/><div class="palette-list">${sessions.map((session) => `<button type="button" data-palette-session="${session.id}">${icons.terminal}<span><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.cwd)}</small></span>${icons.chevron}</button>`).join('') || '<span class="palette-empty">No active sessions yet.</span>'}</div></form></div>`;
  const paletteList = document.querySelector<HTMLElement>('.palette-list');
  if (paletteList) {
    const commands = [
      ['new-agent', 'New Agent', 'Launch an installed CLI in a real PTY'],
      ['new-terminal', 'New Terminal', 'Open a shell selected from the real OS'],
      ['open-file', 'Open File', 'Search and open a real workspace file'],
      ['switch-workspace', 'Switch Workspace', 'Open a saved local workspace'],
      ['search', 'Search Files', 'Search the real workspace filesystem'],
      ['git-status', 'Git Status', 'Show actual repository changes'],
      ['git-commit', 'Git Commit', 'Focus the real Git commit form'],
      ['clone', 'Clone Repository', 'Run git clone with real arguments'],
      ['browser', 'Open Browser', 'Open an actual integrated webview'],
      ['localhost', 'Open Localhost', 'Open a real local server preview'],
      ['sidebar', 'Toggle Sidebar', 'Show or hide the workspace sidebar'],
      ['toggle-editor', 'Show Editor', 'Open the real Monaco workspace editor'],
      ['toggle-browser', 'Show Browser', 'Open the integrated browser tools'],
      ['focus-next', 'Focus Next Agent', 'Move focus to the next live terminal'],
      ['restart-agent', 'Restart Agent', 'Restart the focused real process'],
      ['kill-agent', 'Kill Agent', 'Terminate the focused real process'],
    ];
    paletteList.insertAdjacentHTML('afterbegin', commands.map(([id, name, description]) => '<button type="button" data-palette-command="' + id + '">' + icons.bolt + '<span><strong>' + name + '</strong><small>' + description + '</small></span>' + icons.chevron + '</button>').join(''));
  }
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#palette-close')!.addEventListener('click', close);
  document.querySelectorAll<HTMLButtonElement>('[data-palette-command]').forEach((button) => button.addEventListener('click', () => {
    const command = button.dataset.paletteCommand;
    close();
    if (command === 'new-agent') void openAgentMenu();
    else if (command === 'new-terminal') openSessionMenu();
    else if (command === 'open-file') void openSearchModal();
    else if (command === 'switch-workspace') openWorkspaceBrowser(false, true);
    else if (command === 'search') void openSearchModal();
    else if (command === 'git-status') { setView('terminals'); void refreshGitPanel(); }
    else if (command === 'git-commit') { setView('terminals'); gitCommitMessage.focus(); }
    else if (command === 'clone') openCloneRepositoryModal(false, true);
    else if (command === 'browser') openBrowserMenu();
    else if (command === 'localhost') openLocalhostMenu();
    else if (command === 'sidebar') toggleSidebar();
    else if (command === 'toggle-editor') {
      if (!openFilePath && !diffOpen) {
        void openSearchModal();
      } else {
        setView('terminals');
        toggleDeveloperDock();
        if (!developerDockCollapsed) developerDock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    else if (command === 'toggle-browser') setView('tools');
    else if (command === 'focus-next') focusAdjacentSession(1);
    else if (command === 'restart-agent') {
      if (activeSessionId) void restartSession(activeSessionId);
      else showToast('Selecciona un agente real primero.', true);
    } else if (command === 'kill-agent') {
      if (activeSessionId) void closeSession(activeSessionId);
      else showToast('Selecciona un proceso real primero.', true);
    }
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-palette-session]').forEach((button) => button.addEventListener('click', () => { activateSession(button.dataset.paletteSession ?? ''); close(); }));
  const paletteInput = document.querySelector<HTMLInputElement>('#palette-input')!;
  paletteInput.addEventListener('input', () => {
    const query = paletteInput.value.trim().toLowerCase();
    paletteList?.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      const text = button.textContent?.toLowerCase().replace(/\s+/g, '') ?? '';
      const parts = query.replace(/^>\s*/, '').split(/\s+/).filter(Boolean);
      button.hidden = Boolean(parts.length && !parts.every((part) => text.includes(part)));
    });
  });
  document.querySelector<HTMLFormElement>('#palette-form')!.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = paletteInput.value.trim();
    const session = findSessionByQuery(value);
    const visibleCommand = paletteList ? Array.from(paletteList.querySelectorAll<HTMLButtonElement>('[data-palette-command]')).find((button) => !button.hidden) : undefined;
    if (visibleCommand && value && visibleCommand.textContent?.toLowerCase().replace(/\s+/g, '').includes(value.toLowerCase().replace(/^>\s*/, '').replace(/\s+/g, ''))) {
      visibleCommand.click();
      return;
    }
    close();
    if (session) {
      activateSession(session.id);
      return;
    }
    if (value && activeSessionId && getWorkspace()) {
      commandInput.value = value.replace(/^>\s*/, '');
      commandForm.requestSubmit();
      return;
    }
    if (value) showToast('Selecciona un shell real para ejecutar el comando.', true);
  });
  paletteInput.focus();
}

async function openSearchModal(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast('Abre un workspace real antes de buscar.', true);
    return;
  }
  modalRoot.innerHTML = '<div class="modal-backdrop" id="search-backdrop"><section class="modal-panel search-modal" role="dialog" aria-modal="true" aria-labelledby="search-title" aria-describedby="search-description"><div class="modal-heading"><div><span class="eyebrow">PROJECT / SEARCH</span><h2 id="search-title">Search files</h2></div><button class="modal-close" id="search-close" type="button" aria-label="Close search" title="Close search">' + icons.close + '</button></div><p class="modal-copy" id="search-description">Busca en los archivos reales del workspace. Se excluyen .git, node_modules, target y dist.</p><form id="search-form"><div class="search-options" aria-label="Search options"><label><input id="search-regex" type="checkbox"/><span>Regex</span></label><label><input id="search-case" type="checkbox"/><span>Case sensitive</span></label><label><input id="search-whole" type="checkbox"/><span>Whole word</span></label><label class="search-filter"><span>Files</span><input id="search-file-filter" placeholder="*.ts, *.tsx" aria-label="File filter"/></label></div><div class="search-query"><label class="search-query-label" for="search-query"><span>Search content</span><kbd>Enter</kbd></label><input class="field-input" id="search-query" placeholder="texto a buscar" autocomplete="off" aria-describedby="search-description" required/></div><button class="primary-button" type="submit">' + icons.search + '<span>Search</span><kbd>Enter</kbd></button></form><div class="search-results" id="search-results" aria-live="polite"><div class="dock-empty">Escribe una consulta.</div></div></section></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#search-close')!.addEventListener('click', close);
  document.querySelector<HTMLFormElement>('#search-form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = document.querySelector<HTMLInputElement>('#search-query')!.value.trim();
    const results = document.querySelector<HTMLDivElement>('#search-results')!;
    if (!query) return;
    const useRegex = document.querySelector<HTMLInputElement>('#search-regex')?.checked ?? false;
    const caseSensitive = document.querySelector<HTMLInputElement>('#search-case')?.checked ?? false;
    const wholeWord = document.querySelector<HTMLInputElement>('#search-whole')?.checked ?? false;
    const fileFilter = document.querySelector<HTMLInputElement>('#search-file-filter')?.value.trim() || null;
    results.innerHTML = '<div class="dock-empty">Buscando en el filesystem...</div>';
    try {
      const matches = await invoke<SearchMatch[]>('search', { root: activeProjectRoot() ?? workspace.path, query, useRegex, caseSensitive, wholeWord, fileFilter });
      results.innerHTML = matches.length ? matches.map((match) => '<button class="search-result" data-search-path="' + escapeHtml(match.path) + '" data-search-line="' + match.line + '" type="button"><strong>' + escapeHtml(match.path) + ':' + match.line + '</strong><code>' + escapeHtml(match.text) + '</code></button>').join('') : '<div class="dock-empty">No se encontraron coincidencias reales.</div>';
      results.querySelectorAll<HTMLButtonElement>('[data-search-path]').forEach((button) => button.addEventListener('click', () => {
        const path = button.dataset.searchPath;
        const line = Number(button.dataset.searchLine ?? '1');
        if (!path) return;
        close();
        void openWorkspaceFile(path).then(() => { codeEditor?.revealLineInCenter(line); codeEditor?.setPosition({ lineNumber: line, column: 1 }); });
      }));
    } catch (error) {
      results.innerHTML = '<div class="dock-empty dock-empty-error">' + escapeHtml(String(error)) + '</div>';
    }
  });
  document.querySelector<HTMLInputElement>('#search-query')!.focus();
}

function bindWindowControls(): void {
  const currentWindow = getCurrentWindow();
  const safe = (label: string, action: () => Promise<void>): void => { void action().catch((error: unknown) => showToast(`${label}: ${String(error)}`, true)); };
  const titlebar = document.querySelector<HTMLElement>('.titlebar');
  if (!titlebar) return;
  titlebar.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('#mac-minimize, #minimize-window')) {
      safe('No se pudo minimizar', () => currentWindow.minimize());
      return;
    }
    if (target.closest('#mac-maximize, #maximize-window')) {
      safe('No se pudo maximizar', () => currentWindow.toggleMaximize());
      return;
    }
    if (target.closest('#mac-close, #close-window')) {
      safe('No se pudo cerrar', () => currentWindow.close());
    }
  });
  titlebar.addEventListener('mousedown', (event) => { if (event.button === 0 && !(event.target as HTMLElement).closest('button,input,a')) safe('No se pudo mover la ventana', () => currentWindow.startDragging()); });
  titlebar.addEventListener('dblclick', (event) => { if (!(event.target as HTMLElement).closest('button,input,a')) safe('No se pudo cambiar el tamaño', () => currentWindow.toggleMaximize()); });
}

function bindTerminalSplitter(): void {
  const splitter = document.querySelector<HTMLElement>('#terminal-splitter');
  if (!splitter) return;
  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = terminalHeight;
    splitter.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      terminalHeight = Math.min(Math.max(startHeight + startY - moveEvent.clientY, 190), Math.round(window.innerHeight * 0.68));
      terminalArea.style.setProperty('--terminal-height', `${terminalHeight}px`);
      if (activeSessionId) syncTerminalSize(activeSessionId);
    };
    const stop = (): void => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', stop);
      splitter.removeEventListener('pointercancel', stop);
      layoutState.terminalHeight = terminalHeight;
      saveLayout();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', stop);
    splitter.addEventListener('pointercancel', stop);
  });
}

function bindSidebarResizer(): void {
  const resizer = document.querySelector<HTMLElement>('#sidebar-resizer');
  const shell = document.querySelector<HTMLElement>('.app-shell');
  if (!resizer || !shell) return;
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = document.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().width ?? 258;
    resizer.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      const width = Math.min(Math.max(startWidth + moveEvent.clientX - startX, 218), 390);
      shell.style.setProperty('--sidebar-width', `${Math.round(width)}px`);
      if (activeSessionId) syncTerminalSize(activeSessionId);
      scheduleWebviewSync();
    };
    const stop = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', stop);
      resizer.removeEventListener('pointercancel', stop);
      layoutState.sidebarWidth = Math.round(shell.getBoundingClientRect().width > 0 ? (document.querySelector<HTMLElement>('.sidebar')?.getBoundingClientRect().width ?? layoutState.sidebarWidth) : layoutState.sidebarWidth);
      saveLayout();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', stop);
    resizer.addEventListener('pointercancel', stop);
  });
}

function bindInspectorResizer(): void {
  const resizer = document.querySelector<HTMLElement>('#inspector-resizer');
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const inspector = document.querySelector<HTMLElement>('#workspace-inspector');
  if (!resizer || !shell || !inspector) return;
  const setWidth = (width: number): void => {
    layoutState.inspectorWidth = Math.min(Math.max(Math.round(width), 220), 420);
    shell.style.setProperty('--inspector-width', `${layoutState.inspectorWidth}px`);
    for (const id of terminals.keys()) syncTerminalSize(id);
    scheduleWebviewSync();
  };
  resizer.addEventListener('pointerdown', (event) => {
    if (inspectorCollapsed) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspector.getBoundingClientRect().width || layoutState.inspectorWidth;
    resizer.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      setWidth(startWidth + startX - moveEvent.clientX);
    };
    const stop = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', stop);
      resizer.removeEventListener('pointercancel', stop);
      saveLayout();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', stop);
    resizer.addEventListener('pointercancel', stop);
  });
  resizer.addEventListener('keydown', (event) => {
    if (inspectorCollapsed || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    setWidth(layoutState.inspectorWidth + (event.key === 'ArrowLeft' ? 16 : -16));
    saveLayout();
  });
}

function bindDeveloperDockResizer(): void {
  const resizer = document.querySelector<HTMLElement>('#developer-dock-resizer');
  const dock = document.querySelector<HTMLElement>('#developer-dock');
  if (!resizer || !dock) return;

  const setShare = (clientX: number): void => {
    const rect = dock.getBoundingClientRect();
    if (rect.width <= 0) return;
    layoutState.developerEditorShare = Math.min(Math.max((clientX - rect.left) / rect.width, 0.32), 0.75);
    dock.style.setProperty('--developer-editor-share', String(layoutState.developerEditorShare));
    scheduleLayoutSync();
  };

  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    setShare(event.clientX);
    const move = (moveEvent: PointerEvent): void => setShare(moveEvent.clientX);
    const stop = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', stop);
      resizer.removeEventListener('pointercancel', stop);
      saveLayout();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', stop);
    resizer.addEventListener('pointercancel', stop);
  });

  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    layoutState.developerEditorShare = Math.min(Math.max(layoutState.developerEditorShare + (event.key === 'ArrowRight' ? 0.03 : -0.03), 0.32), 0.75);
    dock.style.setProperty('--developer-editor-share', String(layoutState.developerEditorShare));
    saveLayout();
    scheduleLayoutSync();
  });
}

function bindInteractions(): void {
  bindWindowControls();
  bindTerminalSplitter();
  bindSidebarResizer();
  bindInspectorResizer();
  bindDeveloperDockResizer();
  bindTerminalReordering();
  bindTerminalResizing();
  githubAuthConnectButton.addEventListener('click', () => { void connectGithubAccount(); });
  githubAuthCheckButton.addEventListener('click', () => { void checkGithubAccount(); });
  githubAccountCard.addEventListener('click', () => {
    if (!githubAuth.connected) {
      void connectGithubAccount();
      return;
    }
    openCloneRepositoryModal(false, true);
  });
  /* Gemini shell handlers removed; ComesADE controls are bound below.
  const onClick = (selector: string, handler: () => void): void => {
    document.querySelector<HTMLElement>(selector)?.addEventListener('click', handler);
  };
  onClick('#segment-agent', () => setView('terminals'));
  onClick('#segment-code', () => setView('overview'));
  onClick('#segment-chat', () => setView('tools'));
  onClick('#sidebar-dashboard-btn', () => setView('overview'));
  onClick('#sidebar-routines-btn', openCommandPalette);
  onClick('#sidebar-plugins-btn', openSettingsModal);
  onClick('#sidebar-skills-btn', openHelpModal);
  onClick('#notch-toggle-btn', () => {
    const button = document.querySelector<HTMLButtonElement>('#notch-toggle-btn');
    const enabled = !document.body.classList.contains('notch-enabled');
    document.body.classList.toggle('notch-enabled', enabled);
    const pill = document.querySelector<HTMLElement>('.bridge-voice-pill');
    if (pill) pill.hidden = !enabled;
    if (button) {
      button.textContent = enabled ? 'On' : 'Off';
      button.setAttribute('aria-pressed', String(enabled));
    }
  });
  onClick('#sidebar-theme-toggle', () => {
    const light = app?.classList.toggle('theme-light') ?? false;
    setStoredValue('comesade-theme', light ? 'light' : 'dark');
    const button = document.querySelector<HTMLButtonElement>('#sidebar-theme-toggle');
    if (button) {
      button.textContent = light ? '☀' : '🌙';
      button.setAttribute('aria-pressed', String(light));
    }
  });
  onClick('#tab-action-more', openInspectorActionsMenu);
  onClick('#tab-action-split', openSessionMenu);
  onClick('#tab-action-add', openSessionMenu);
  onClick('#tab-action-close', () => {
    if (activeSessionId) void closeSession(activeSessionId);
    else showToast('No hay una sesión activa para cerrar.', true);
  });
  onClick('#inspector-tab-files', () => setInspectorTab('explorer'));
  onClick('#inspector-tab-tools', () => setView('tools'));
  */
  document.querySelector<HTMLButtonElement>('#titlebar-layout')?.addEventListener('click', toggleSidebar);
  document.querySelector<HTMLButtonElement>('#titlebar-more')?.addEventListener('click', () => openWorkspaceBrowser(false, true));
  document.querySelector<HTMLButtonElement>('#titlebar-back')?.addEventListener('click', () => navigateViewHistory(-1));
  document.querySelector<HTMLButtonElement>('#titlebar-forward')?.addEventListener('click', () => navigateViewHistory(1));
  document.querySelector<HTMLButtonElement>('#titlebar-update')?.addEventListener('click', openAppUpdateModal);
  document.querySelector<HTMLButtonElement>('#titlebar-inspector-toggle')?.addEventListener('click', toggleInspector);
  document.querySelector<HTMLButtonElement>('#split-pane-btn-left')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#split-pane-btn-right')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#close-pane-btn-left')?.addEventListener('click', () => {
    if (activeSessionId) void closeSession(activeSessionId);
    else showToast('No hay una terminal activa en este panel.', true);
  });
  document.querySelector<HTMLButtonElement>('#close-pane-btn-right')?.addEventListener('click', () => {
    if (activeSessionId) void closeSession(activeSessionId);
    else showToast('No hay una terminal activa en este panel.', true);
  });
  document.querySelector<HTMLButtonElement>('#sidebar-filter-btn')?.addEventListener('click', toggleSidebarSessionFilter);
  document.querySelector<HTMLButtonElement>('#sidebar-help')?.addEventListener('click', openHelpModal);
  document.querySelector<HTMLButtonElement>('#sidebar-feedback')?.addEventListener('click', openFeedbackModal);
  document.querySelector<HTMLButtonElement>('#sidebar-stats')?.addEventListener('click', openStatsModal);
  document.querySelector<HTMLButtonElement>('#refresh-workspace-btn')?.addEventListener('click', () => {
    if (!getWorkspace()) { showToast('Abre un workspace antes de actualizarlo.', true); return; }
    void Promise.all([syncRuntimeSessions(), refreshWorkspacePanels()])
      .then(() => showToast('Workspace, sesiones y Git actualizados.'))
      .catch((error) => showToast('No se pudo actualizar el workspace: ' + String(error), true));
  });
  document.querySelector<HTMLButtonElement>('#inspector-view-sort')?.addEventListener('click', toggleFileSort);
  document.querySelector<HTMLButtonElement>('#inspector-more')?.addEventListener('click', openInspectorActionsMenu);
  document.querySelector<HTMLButtonElement>('#floating-layout-toggle')?.addEventListener('click', toggleInspector);
  document.querySelector<HTMLButtonElement>('#filter-names-btn')?.addEventListener('click', () => setInspectorFilterMode('names'));
  document.querySelector<HTMLButtonElement>('#filter-content-btn')?.addEventListener('click', () => setInspectorFilterMode('content'));
  commandForm.addEventListener('submit', async (event) => { event.preventDefault(); const command = commandInput.value.trim(); if (!command || !activeSessionId || !getWorkspace()) { showToast('Abre un workspace y un shell real primero.', true); return; } try { await writeToSession(activeSessionId, `${command}\r`); commandInput.value = ''; terminals.get(activeSessionId)?.terminal.focus(); } catch (error) { showToast(String(error), true); } });
  document.querySelector<HTMLButtonElement>('#summary-sessions')?.addEventListener('click', () => {
    setView('terminals');
    terminalArea.scrollIntoView({ block: 'nearest' });
    if (activeSessionId) terminals.get(activeSessionId)?.terminal.focus();
    else if (getWorkspace()) openSessionMenu();
    else showToast('Abre un workspace antes de abrir una terminal.', true);
  });
  document.querySelector<HTMLButtonElement>('#summary-runtime')?.addEventListener('click', openRuntimeModal);
  document.querySelector<HTMLButtonElement>('#summary-shell')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#workspace-context-session')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#workspace-summary-browser')?.addEventListener('click', openBrowserMenu);
  commandCwdButton.addEventListener('click', () => {
    const workspace = getWorkspace();
    const session = getLiveSession(activeSessionId);
    const path = session?.cwd ?? workspace?.path;
    if (!path) {
      showToast('No hay una carpeta activa para abrir.', true);
      return;
    }
    void invoke('reveal_path', { path }).catch((error) => showToast(String(error), true));
  });
  notesInput.addEventListener('input', scheduleNoteSave);
  workspaceInspector.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>('[data-inspector-tab]')?.dataset.inspectorTab;
    if (tab) {
      setInspectorTab(tab);
      return;
    }
    const sessionId = target.closest<HTMLElement>('[data-inspector-session]')?.dataset.inspectorSession;
    if (sessionId) activateSession(sessionId);
  });
  inspectorGitRefresh.addEventListener('click', () => { void refreshGitPanel(); });
  filesBack.addEventListener('click', () => {
    const parts = fileTreeRelativePath.split(/[\\/]/).filter(Boolean);
    if (!parts.length) return;
    parts.pop();
    void refreshFileTree(parts.join('/'));
  });
  filesRefresh.addEventListener('click', () => { fileTreeRelativePath = ''; void refreshFileTree(); });
  filesNewFile.addEventListener('click', () => { void createWorkspaceEntry('file'); });
  filesNewFolder.addEventListener('click', () => { void createWorkspaceEntry('directory'); });
  fileTree.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest<HTMLElement>('[data-file-up]')) {
      const parts = fileTreeRelativePath.split(/[\\/]/).filter(Boolean);
      parts.pop();
      void refreshFileTree(parts.join('/'));
      return;
    }
    const directory = target.closest<HTMLElement>('[data-file-dir]')?.dataset.fileDir;
    const file = target.closest<HTMLElement>('[data-file-path]')?.dataset.filePath;
    if (directory !== undefined) void refreshFileTree(directory);
    if (file) void openWorkspaceFile(file);
  });
  fileTree.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement;
    const relative = target.closest<HTMLElement>('[data-file-dir], [data-file-path]')?.dataset.fileDir ?? target.closest<HTMLElement>('[data-file-path]')?.dataset.filePath;
    if (relative) openFileContextMenu(event, relative);
  });
  editorContent.addEventListener('input', () => {
    openFileDirty = true;
    const tab = currentOpenFileTab();
    if (tab) {
      tab.content = editorContent.value;
      tab.dirty = true;
    }
    renderEditorTabs();
    editorSaveStatus.textContent = 'DIRTY';
  });
  editorSave.addEventListener('click', () => { void saveWorkspaceFile(); });
  gitRefresh.addEventListener('click', () => { void refreshGitPanel(); });
  gitBranch.classList.add('git-branch-button');
  gitBranch.addEventListener('click', () => { void openGitBranchMenu(); });
  gitList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const stagePath = target.closest<HTMLElement>('[data-git-stage]')?.dataset.gitStage;
    const unstagePath = target.closest<HTMLElement>('[data-git-unstage]')?.dataset.gitUnstage;
    const discardPath = target.closest<HTMLElement>('[data-git-discard]')?.dataset.gitDiscard;
    const path = target.closest<HTMLElement>('[data-git-path]')?.dataset.gitPath;
    const workspace = getWorkspace();
    if (!workspace) return;
    if (stagePath) {
      void invoke('stage', { path: activeProjectRoot() ?? workspace.path, paths: [stagePath] }).then(() => refreshGitPanel()).catch((error) => showToast(String(error), true));
      return;
    }
    if (unstagePath) {
      void invoke('unstage', { path: activeProjectRoot() ?? workspace.path, paths: [unstagePath] }).then(() => refreshGitPanel()).catch((error) => showToast(String(error), true));
      return;
    }
    if (discardPath) {
      if (!window.confirm('Esto descartará los cambios reales del archivo. ¿Continuar?')) return;
      void invoke('discard', { path: activeProjectRoot() ?? workspace.path, paths: [discardPath] }).then(() => refreshGitPanel()).catch((error) => showToast(String(error), true));
      return;
    }
    if (path) void loadGitDiff(path);
  });
  gitWorktreeList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const reviewButton = target.closest<HTMLElement>('[data-worktree-diff]');
    const reviewPath = reviewButton?.dataset.worktreeDiff;
    const reviewBranch = reviewButton?.dataset.worktreeBranch;
    if (reviewPath && reviewBranch) {
      void loadWorktreeDiff(reviewPath, reviewBranch);
      return;
    }
    const workspace = getWorkspace();
    const mergeButton = target.closest<HTMLElement>('[data-merge-worktree]');
    const mergeBranch = mergeButton?.dataset.mergeWorktree;
    const mergePath = mergeButton?.dataset.mergeWorktreePath;
    if (mergeBranch && workspace) {
      const owner = sessions.find((session) => Boolean(session.worktree && sameFsPath(session.worktree, mergePath ?? null) && session.status === 'running'));
      if (owner) {
        showToast('Cierra o detén el agente ' + owner.name + ' antes de fusionar su worktree.', true);
        return;
      }
      if (!window.confirm('Esto fusionará la rama real ' + mergeBranch + ' en el workspace principal. ¿Continuar?')) return;
      void invoke('merge_worktree', { path: workspace.path, branchName: mergeBranch })
        .then(async () => {
          await refreshGitPanel();
          showToast('Worktree fusionado en la rama principal.');
        })
        .catch((error) => {
          showToast('No se pudo fusionar el worktree: ' + String(error), true);
          void refreshGitPanel();
        });
      return;
    }
    const path = target.closest<HTMLElement>('[data-remove-worktree]')?.dataset.removeWorktree;
    if (!path || !workspace) return;
    const owner = sessions.find((session) => Boolean(session.worktree && sameFsPath(session.worktree, path) && session.status === 'running'));
    if (owner) {
      showToast('Cierra o detiene el agente ' + owner.name + ' antes de quitar su worktree.', true);
      return;
    }
    if (!window.confirm('Esto eliminara el worktree Git real y su carpeta. Continuar?')) return;
    void invoke('worktree_remove', { path: workspace.path, worktreePath: path }).then(() => refreshWorktrees()).catch((error) => showToast(String(error), true));
  });
  gitCommit.addEventListener('click', async () => {
    const workspace = getWorkspace();
    const message = gitCommitMessage.value.trim();
    if (!workspace || !message) {
      showToast('Selecciona un workspace y escribe un mensaje de commit.', true);
      return;
    }
    try {
      await invoke('commit', { path: activeProjectRoot() ?? workspace.path, message });
      gitCommitMessage.value = '';
      await refreshGitPanel();
      showToast('Commit real creado.');
    } catch (error) {
      showToast('No se pudo crear el commit: ' + String(error), true);
    }
  });
  workspaceList.addEventListener('click', (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-sidebar-workspace]')?.dataset.sidebarWorkspace;
    const workspace = id ? getWorkspace(id) : undefined;
    if (workspace) void activateWorkspace(workspace, true);
  });
  sessionList.addEventListener('click', handleSessionClick);
  terminalStack.addEventListener('click', handleSessionClick);
  terminalTabs.addEventListener('click', handleSessionClick);
  sessionList.addEventListener('contextmenu', (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    if (id) openSessionContextMenu(event, id);
  });
  terminalStack.addEventListener('contextmenu', (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    if (id) openSessionContextMenu(event, id);
  });
  terminalTabs.addEventListener('contextmenu', (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-session-id]')?.dataset.sessionId;
    if (id) openSessionContextMenu(event, id);
  });
  toolTabs.addEventListener('click', (event) => { const target = event.target as HTMLElement; const closeId = target.closest<HTMLElement>('[data-close-tool]')?.dataset.closeTool; if (closeId) { event.stopPropagation(); closeTool(closeId); return; } const toolId = target.closest<HTMLElement>('[data-tool-id]')?.dataset.toolId; if (toolId) bringToolToFront(toolId); });
  toolStage.addEventListener('click', (event) => { const target = event.target as HTMLElement; const closeId = target.closest<HTMLElement>('[data-close-tool]')?.dataset.closeTool; if (closeId) closeTool(closeId); const refreshId = target.closest<HTMLElement>('[data-tool-refresh]')?.dataset.toolRefresh; if (refreshId) refreshTool(refreshId); const externalId = target.closest<HTMLElement>('[data-tool-external]')?.dataset.toolExternal; const panel = externalId ? browserPanels.get(externalId) : undefined; if (panel) void invoke('open_external_url', { url: panel.url }).catch((error) => showToast(String(error), true)); });
  document.querySelector<HTMLButtonElement>('#tool-empty-open')?.addEventListener('click', openBrowserMenu);
  endpointStrip.addEventListener('click', (event) => {
    const url = (event.target as HTMLElement).closest<HTMLElement>('[data-open-endpoint]')?.dataset.openEndpoint;
    if (url) createLocalhostPanel(url, 'Detected localhost');
  });
  document.querySelector<HTMLButtonElement>('#open-browser-menu')?.addEventListener('click', openBrowserMenu);
  document.querySelector<HTMLButtonElement>('#tools-new-localhost')?.addEventListener('click', openLocalhostMenu);
  document.querySelector<HTMLButtonElement>('#tools-new-browser')?.addEventListener('click', openBrowserMenu);
  document.querySelector<HTMLButtonElement>('#open-workspace-menu')?.addEventListener('click', () => openWorkspaceBrowser(false, true));
  document.querySelector<HTMLButtonElement>('#sidebar-open-workspaces')!.addEventListener('click', () => openWorkspaceBrowser(false, true));
  activeWorkspaceCard.addEventListener('click', () => openWorkspaceBrowser(false, true));
  document.querySelector<HTMLButtonElement>('#sidebar-settings')!.addEventListener('click', openSettingsModal);
  document.querySelector<HTMLButtonElement>('#rail-settings')?.addEventListener('click', openSettingsModal);
  document.querySelector<HTMLButtonElement>('#sidebar-search')?.addEventListener('click', () => { void openSearchModal(); });
  document.querySelector<HTMLButtonElement>('#sidebar-runtime')?.addEventListener('click', openRuntimeModal);
  document.querySelector<HTMLButtonElement>('#sidebar-new-session')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#header-new-session')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#header-new-agent')?.addEventListener('click', () => { void openAgentMenu(); });
  document.querySelector<HTMLButtonElement>('#workspace-summary-agent')?.addEventListener('click', () => { void openAgentMenu(); });
  document.querySelector<HTMLButtonElement>('#asa-new-agent')?.addEventListener('click', () => { void openAgentMenu(); });
  document.querySelector<HTMLButtonElement>('#asa-new-terminal')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#terminal-new')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#terminal-empty-new')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#workspace-lock-open')?.addEventListener('click', () => openWorkspaceBrowser(false, true));
  document.querySelector<HTMLButtonElement>('#workspace-lock-create')?.addEventListener('click', () => openWorkspaceModal(false, true));
  document.querySelector<HTMLButtonElement>('#open-command-palette')!.addEventListener('click', openCommandPalette);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => button.addEventListener('click', () => {
    setView(button.dataset.view ?? 'overview');
    if (window.innerWidth <= 760 && !layoutState.sidebarCollapsed) {
      layoutState.sidebarCollapsed = true;
      applyLayout();
      saveLayout();
    }
  }));
  asaOverview.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const restoreIndex = target.closest<HTMLElement>('[data-restore-session]')?.dataset.restoreSession;
    if (restoreIndex !== undefined) {
      event.stopPropagation();
      void restoreSavedSession(Number(restoreIndex));
      return;
    }
    const sessionId = target.closest<HTMLElement>('[data-asa-session]')?.dataset.asaSession;
    if (sessionId) activateSession(sessionId);
  });
  inspectorSearchInput.addEventListener('input', () => { if (inspectorFilterMode === 'names') void refreshFileTree(); });
  document.querySelector<HTMLInputElement>('#sidebar-search-input')?.addEventListener('input', (event) => {
    sidebarSessionQuery = (event.target as HTMLInputElement).value;
    renderSessions();
  });
  document.querySelector<HTMLInputElement>('#sidebar-search-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void openSearchModal(); }
  });
  editorContent.addEventListener('keydown', (event) => {
    if (primaryModifier(event) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveWorkspaceFile();
    }
  });
  editorTabs.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const closeTarget = target.closest<HTMLElement>('[data-close-file-tab]');
    const closePath = closeTarget?.dataset.closeFileTab;
    const closeRoot = closeTarget?.dataset.fileRoot;
    if (closePath) {
      event.stopPropagation();
      void closeFileTab(closePath, closeRoot);
      return;
    }
    const fileTarget = target.closest<HTMLElement>('[data-file-tab]');
    const filePath = fileTarget?.dataset.fileTab;
    if (filePath) void activateFileTab(filePath, fileTarget.dataset.fileRoot);
  });
  window.addEventListener('resize', () => {
    syncResponsiveLayout();
    scheduleLayoutSync();
  });
  window.addEventListener('keydown', (event) => {
    if (mainMenuOpen) return;
    if (terminalOwnsKeyboard(event) && !(event.ctrlKey && event.key === 'Tab')) return;
    const key = event.key.toLowerCase();
    const primary = primaryModifier(event);
    if (primary && event.shiftKey && key === 'p') { event.preventDefault(); openCommandPalette(); return; }
    if (primary && event.key === 'k') { event.preventDefault(); openCommandPalette(); return; }
    if (primary && event.shiftKey && key === 'f') { event.preventDefault(); void openSearchModal(); return; }
    if (primary && key === 'p' && !event.shiftKey) { event.preventDefault(); void openSearchModal(); return; }
    if (primary && key === 'b') { event.preventDefault(); toggleSidebar(); return; }
    if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); focusAdjacentSession(event.shiftKey ? -1 : 1); return; }
    if (event.ctrlKey && event.key === '`') {
      event.preventDefault();
      if (focusedTerminalId) {
        setTerminalFocus(null);
      } else if (activeSessionId) {
        setView('terminals');
        setTerminalFocus(activeSessionId);
        terminals.get(activeSessionId)?.terminal.focus();
      } else if (getWorkspace()) {
        openSessionMenu();
      }
      return;
    }
    if (event.key === 'Escape' && focusedTerminalId) { event.preventDefault(); setTerminalFocus(null); return; }
    if (primary && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      const session = sessions[Number(event.key) - 1];
      if (session) { event.preventDefault(); activateSession(session.id); return; }
    }
    if (primary && event.shiftKey && key === 'n') { event.preventDefault(); openSessionMenu(); return; }
    if (primary && key === 'w' && activeSessionId) { event.preventDefault(); void closeSession(activeSessionId); }
  });
}

const modalObserver = new MutationObserver(() => scheduleWebviewSync());
modalObserver.observe(modalRoot, { childList: true });

function refreshPersistedUi(): void {
  loadSettings();
  loadWorkspaces();
  loadLayout();
  loadSessionDefinitions();
  notesLoadedWorkspaceId = undefined;
  updateWorkspaceView();
  if (document.getElementById('main-menu-backdrop')) openMainMenu();
}

async function finishAuthorizedStartup(): Promise<void> {
  if (authorizedStartupPromise) {
    await authorizedStartupPromise;
    return;
  }
  authorizedStartupPromise = (async () => {
    if (getWorkspace() && !mainMenuOpen) {
      try {
        await startWorkspaceWatcher(getWorkspace()!.path);
        await refreshWorkspacePanels();
      } catch (error) {
        showToast('No se pudo iniciar el watcher del workspace: ' + String(error), true);
      }
    }

    try {
      await syncRuntimeSessions();
    } catch (error) {
      showToast(`No se pudo consultar el runtime: ${String(error)}`, true);
    }

    try {
      [detectedAgents, detectedShells] = await Promise.all([
        invoke<AgentDefinition[]>('detect_agents'),
        invoke<ShellDefinition[]>('detect_shells'),
      ]);
      agentsDetectionReady = true;
      normalizeDefaultShell();
      render();
    } catch (error) {
      showToast(`No se pudo detectar shells y agentes: ${String(error)}`, true);
    }

    setLocalRuntimeState('LOCAL / READY');
  })();
  await authorizedStartupPromise;
}

async function finishStartup(): Promise<void> {
  const hydration = hydrateNativePersistence();
  const platformRequest = invoke<RuntimePlatform>('platform_info');
  const versionRequest = getVersion();
  const eventsRequest = connectEvents();
  const [platformResult, versionResult, eventsResult] = await Promise.allSettled([platformRequest, versionRequest, eventsRequest]);

  if (platformResult.status === 'fulfilled') {
    runtimePlatform = platformResult.value;
    syncWindowControls();
  }
  if (versionResult.status === 'fulfilled') {
    appVersionLabel.textContent = `COMESADE ${versionResult.value}`;
  } else {
    appVersionLabel.textContent = 'COMESADE';
  }
  if (eventsResult.status === 'rejected') {
    setLocalRuntimeState('LOCAL / EVENTS ERROR');
    showToast(`No se pudieron conectar los eventos locales: ${String(eventsResult.reason)}`, true);
  }

  try {
    await hydration;
    refreshPersistedUi();
  } catch {
    // hydrateNativePersistence ya conserva el fallback de localStorage.
  }

  const githubStatus = await refreshGithubAuth();
  if (!githubStatus.connected) {
    setLocalRuntimeState('LOCAL / GITHUB REQUIRED');
    return;
  }
  await finishAuthorizedStartup();
}

async function initialize(): Promise<void> {
  bindInteractions();
  renderGithubAuthState();
  loadSettings();
  loadWorkspaces();
  loadLayout();
  loadSessionDefinitions();
  updateWorkspaceView();
  openMainMenu();
  setLocalRuntimeState('LOCAL / STARTING');
  setApiConnectionState('API / CHECKING');
  startApiMonitor();
  startAppUpdateChecker();

  // El primer paint queda libre: el editor y las comprobaciones nativas no
  // pueden bloquear el menú ni aparentar que la ventana dejó de cargar.
  void finishStartup();
}

async function connectEvents(): Promise<UnlistenFn[]> {
  const outputUnlisten = await listen<TerminalOutput>('terminal-output', (event) => handleOutput(event.payload));
  const statusUnlisten = await listen<TerminalStatusEvent>('terminal-status', (event) => handleStatus(event.payload));
  const exitUnlisten = await listen<TerminalExit>('terminal-exit', (event) => handleExit(event.payload));
  const fileUnlisten = await listen<WorkspaceFileChange>('workspace-file-change', (event) => handleWorkspaceFileChange(event.payload));
  return [outputUnlisten, statusUnlisten, exitUnlisten, fileUnlisten];
}

void initialize();
