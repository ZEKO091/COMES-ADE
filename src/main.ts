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
import './styles.css';
import comesadeLogoUrl from './assets/comesade-logo.png';
import { STT_LANGUAGES } from './stt-languages';
import { bindComposerSpeech, listMicrophones, setSelectedMicrophoneId } from './stt';
import { signInWithBetterAuth, signOutBetterAuth } from './auth-client';
import {
  consumeLocalSpeech,
  countSpeechTokens,
  isUnlimitedSpeechQuota,
  localSpeechQuota,
  parseSpeechQuotaResponse,
  type SpeechQuotaView,
} from './speech-quota';
import {
  consumeLocalMessage,
  isUnlimitedMessageQuota,
  localMessageQuota,
  parseMessageQuotaResponse,
  type MessageQuotaView,
} from './message-quota';
import {
  APP_LOCALES,
  applyDomI18n,
  currentLocale,
  detectIpLocale,
  isAppLocale,
  isLanguagePreference,
  localeLabel,
  localeSignals,
  readDeviceLocale,
  resolveLocale,
  setActiveLocale,
  setLocaleSignals,
  t,
  type LanguagePreference,
} from './i18n';

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
type ProviderStatus = {
  id: string;
  name: string;
  connected: boolean;
  authMode: string | null;
  accountLabel: string | null;
  plan: string | null;
  reauthRequired: boolean;
  supportsOauth: boolean;
  supportsApiKey: boolean;
  oauthHint: string;
};
type UsageWindow = {
  label: string;
  usedPercent: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: number | null;
};
type UsageSnapshot = {
  provider: string;
  providerName: string;
  planMode: string;
  windows: UsageWindow[];
  capturedAt: number;
  retryAfter: number | null;
  exhausted: boolean;
};
type ProviderOAuthStart = {
  provider: string;
  verificationUri: string | null;
  userCode: string | null;
  expiresIn: number | null;
  intervalMs: number | null;
  message: string;
};
type ProviderOAuthPoll = {
  provider: string;
  connected: boolean;
  pending: boolean;
  error: string | null;
  status: ProviderStatus;
};
type AgentChatMessage = { role: 'user' | 'assistant' | 'system'; content: string; images?: string[] };
type NativeAgentDelta = { requestId: string; text: string };
type NativeAgentTool = { requestId: string; name: string; input: string; output: string };
type NativeAgentDone = { requestId: string; error: string | null };
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
  frame: HTMLDivElement;
  webview: Webview | null;
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
  updateNow: '<svg class="titlebar-update-mark" viewBox="0 0 18 18" aria-hidden="true"><path fill="#E8C15A" stroke="none" d="M3.6 9 8.8 3.8 10.2 5.2 6.4 9 10.2 12.8 8.8 14.2z"/><path fill="#5BA8FF" stroke="none" d="M8.2 9 13.4 3.8 14.8 5.2 11 9 14.8 12.8 13.4 14.2z"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>',
  split: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 4v16"/></svg>',
  splitPane: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="1"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg>',
  browser: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2 2.2 3 4.8 3 8s-1 5.8-3 8c-2-2.2-3-4.8-3-8s1-5.8 3-8Z"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="5" y1="7" x2="19" y2="7"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="17" x2="19" y2="17"/></svg>',
  panel: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M10 5v14"/></svg>',
  panelRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M15 5v14"/></svg>',
  external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4L4 9M4 5v4h4M4 13a8 8 0 0 0 14.6 4L20 15m0 4v-4h-4"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  help: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  desktop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>',
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
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h3l4 4V6L7 10H4zM16 9a4 4 0 0 1 0 6M18.5 7a7 7 0 0 1 0 10"/></svg>',
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
    "    <div class='titlebar-left'><div class='window-controls' aria-label='Controles de ventana'><button class='window-control window-control-close' id='close-window' type='button' title='Cerrar ComesADE' aria-label='Cerrar ComesADE'></button><button class='window-control window-control-minimize' id='minimize-window' type='button' title='Minimizar' aria-label='Minimizar'></button><button class='window-control window-control-maximize' id='maximize-window' type='button' title='Maximizar o restaurar' aria-label='Maximizar o restaurar'></button></div><button class='titlebar-btn' id='titlebar-layout' type='button' title='Mostrar u ocultar la barra lateral'>☰</button><button class='titlebar-brand-button' id='titlebar-more' type='button' title='Cambiar workspace'><span class='brand-mark'>C</span><span class='brand-lockup'><strong>ComesADE</strong><small>IDE local</small></span></button></div>",
    "    <nav class='titlebar-nav' aria-label='Modo de trabajo'><button class='titlebar-nav-item is-active' data-view='overview' type='button'><span>IDE</span><small>Workspace</small></button><button class='titlebar-nav-item' data-view='asa' type='button'><span>Agents</span><small>Sesiones</small></button><button class='titlebar-nav-item' data-view='terminals' type='button'><span>Terminal</span><small>Shells</small></button><button class='titlebar-nav-item' data-view='tools' type='button'><span>Tools</span><small>Preview</small></button></nav>",
    "    <div class='titlebar-right-controls'><button class='titlebar-btn' id='titlebar-back' type='button' title='Vista anterior'>‹</button><button class='titlebar-btn' id='titlebar-forward' type='button' title='Vista siguiente'>›</button><button class='command-palette-button' id='open-command-palette' type='button'><span>Buscar</span><kbd>Ctrl K</kbd></button><button class='titlebar-btn' id='titlebar-inspector-toggle' type='button' title='Mostrar u ocultar inspector'>▣</button></div>",
    "  </header>",
    "  <div class='app-body'>",
    "    <nav class='activity-rail' id='activity-rail' aria-label='Atajos del workspace'><button class='activity-rail-item is-active' data-view='overview' type='button' title='Workspace' aria-label='Workspace'>▦</button><button class='activity-rail-item' data-view='asa' type='button' title='Agentes' aria-label='Agentes'>✦</button><button class='activity-rail-item' data-view='terminals' type='button' title='Terminales' aria-label='Terminales'>›_</button><button class='activity-rail-item' data-view='tools' type='button' title='Herramientas' aria-label='Herramientas'>◎</button><span class='activity-rail-spacer'></span><button class='activity-rail-item' id='rail-settings' type='button' title='Configuración' aria-label='Configuración'>⚙</button></nav>",
    "    <aside class='sidebar' aria-label='Navegación principal'><div class='sidebar-identity'><span class='sidebar-kicker'>LOCAL DESKTOP</span><span class='product-badge'>IDE</span></div><div class='sidebar-section-label'>Producto</div><nav class='sidebar-nav' aria-label='Producto'><button class='sidebar-nav-item is-active' data-view='overview' type='button'><span class='nav-glyph'>▦</span><span><strong>Workspace</strong><small>Workspace</small></span></button><button class='sidebar-nav-item' data-view='asa' type='button'><span class='nav-glyph'>✦</span><span><strong>Agents</strong><small>Agentes y sesiones</small></span></button><button class='sidebar-nav-item' data-view='terminals' type='button'><span class='nav-glyph'>›_</span><span><strong>Terminal</strong><small>Shells locales</small></span></button><button class='sidebar-nav-item' data-view='tools' type='button'><span class='nav-glyph'>◎</span><span><strong>Tools</strong><small>Browser y preview</small></span></button></nav>",
    "      <div class='sidebar-section-title'><span>Workspaces</span><button class='icon-button' id='sidebar-open-workspaces' type='button' title='Abrir workspace'>+</button></div><button class='active-workspace-card' id='active-workspace-card' type='button'><span class='workspace-card-icon'>□</span><span class='workspace-card-copy'><strong id='active-workspace-name'>Sin workspace</strong><small id='active-workspace-path'>Crea o abre una carpeta</small></span><span class='workspace-card-chevron'>›</span></button><div class='sidebar-project-empty' id='sidebar-project-empty' hidden><span>□</span><strong>Sin workspace</strong><small>Abre una carpeta local para empezar.</small></div>",
    "      <div class='sidebar-workspace-heading'><span id='sidebar-project-label'>Workspace</span><button class='icon-button' id='sidebar-filter-btn' type='button' title='Filtros: todas las sesiones'>≡</button></div><div class='session-list' id='session-list'></div><div class='sidebar-session-actions'><input class='sidebar-search-input' id='sidebar-search-input' type='search' placeholder='Filtrar sesiones' aria-label='Filtrar sesiones' /><button class='secondary-button sidebar-new-session' id='sidebar-new-session' type='button'>+<span>Nueva sesión</span></button></div>",
    "      <div class='sidebar-spacer'></div><div class='sidebar-footer'><button class='sidebar-runtime-button' id='sidebar-runtime' type='button'><span class='status-dot'></span><span><strong>Runtime local</strong><small id='connection-state'>LOCAL / STARTING</small></span></button><div class='sidebar-footer-actions'><button class='icon-button' id='sidebar-help' type='button' title='Ayuda'>?</button><button class='icon-button' id='sidebar-feedback' type='button' title='Comentarios'>…</button><button class='icon-button' id='sidebar-stats' type='button' title='Estadísticas'>▥</button><button class='icon-button' id='sidebar-settings' type='button' title='Configuración'>⚙</button></div><div class='sidebar-version'><span>COMESADE</span><span id='app-version-label'>1.0.0</span></div></div><div class='sidebar-resizer' id='sidebar-resizer' aria-hidden='true'></div>",
    "    </aside>",
    "    <main class='workspace-main view-overview'><header class='workspace-header'><div class='workspace-header-copy'><span class='eyebrow'>IDE / LOCAL WORKSPACE</span><h1 id='workspace-heading'>Sin workspace seleccionado</h1><p id='workspace-header-path'>Crea o abre un workspace para comenzar.</p></div><div class='workspace-header-actions'><button class='header-button' id='open-workspace-menu' type='button'>Workspace</button><button class='header-button' id='open-browser-menu' type='button'>Browser</button><button class='header-button header-button-primary' id='header-new-session' type='button'>+<span>Nueva sesión</span></button></div></header>",
    "      <div class='workspace-views-stack' id='workspace-views-stack'>",
    "        <section class='workspace-overview' id='workspace-overview'><section class='workspace-lock panel' id='workspace-lock' hidden><span class='workspace-lock-icon'>□</span><span class='eyebrow'>IDE / WORKSPACE REQUIRED</span><h2>Abre un workspace real</h2><p>Crea o abre una carpeta local para conectar archivos, terminales, Git y agentes.</p><div class='workspace-lock-actions'><button class='secondary-button' id='workspace-lock-open' type='button'>Abrir workspace</button><button class='primary-button' id='workspace-lock-create' type='button'>Crear workspace</button></div></section><div class='workspace-grid'><section class='panel workspace-summary-panel'><header class='panel-header'><div><span class='eyebrow'>IDE / WORKSPACE</span><h2>Proyecto local</h2></div><button class='icon-button' id='workspace-context-session' type='button' title='Abrir una sesión real'>+</button></header><div class='workspace-summary-identity'><span class='summary-project-icon'>□</span><div><strong id='workspace-summary-name'>Sin workspace</strong><small id='workspace-summary-path'>Crea o abre una carpeta para comenzar.</small></div></div><div class='summary-metrics'><button class='summary-metric' id='summary-sessions' type='button'><span>Sesiones</span><strong id='overview-session-count'>0</strong><small id='overview-active-label'>READY</small></button><button class='summary-metric' id='summary-runtime' type='button'><span>Runtime</span><strong id='overview-runtime-status'>LOCKED</strong><small id='overview-shell'>Sin shell</small></button><button class='summary-metric' id='summary-shell' type='button'><span>Directorio</span><strong id='overview-path-short'>—</strong><small id='overview-path-detail'>Sin workspace</small></button></div><div class='panel-actions'><button class='secondary-button' id='workspace-summary-browser' type='button'>Abrir preview</button><button class='secondary-button' id='workspace-summary-agent' type='button'>Nuevo agente</button></div></section><section class='panel notes-panel'><header class='panel-header'><div><span class='eyebrow'>WORKSPACE NOTES</span><h2>Notas rápidas</h2></div><span class='panel-state' id='notes-status'>LOCKED</span></header><textarea id='notes-input' placeholder='Decisiones, comandos o contexto de este proyecto…' aria-label='Notas del workspace'></textarea><small class='panel-hint'>Se guardan localmente por workspace.</small></section></div></section>",
    "        <section class='asa-overview' id='asa-overview'><header class='asa-header'><div><span class='eyebrow'>IDE / AGENTES</span><h2>Agentes y sesiones</h2><p>Conecta cuentas reales y lanza CLIs dentro del workspace, con terminales y worktrees.</p></div><div class='asa-header-actions'><button class='secondary-button' id='asa-new-terminal' type='button'>Nueva terminal</button><button class='primary-button' id='asa-new-agent' type='button'>Nuevo agente</button></div></header><div class='asa-facts'><div><span>AGENTES ACTIVOS</span><strong id='asa-live-agents'>0</strong></div><div><span>AGENTES INSTALADOS</span><strong id='asa-installed-agents'>0</strong></div><div><span>WORKTREES ACTIVOS</span><strong id='asa-worktrees'>0</strong></div><div><span>RUNTIME</span><strong id='asa-runtime-status'>LOCKED</strong></div></div><section class='panel asa-sessions-panel'><header class='panel-header'><div><span class='eyebrow'>LIVE CONTEXT</span><h3>Procesos conectados</h3></div><span class='panel-state'>REAL / LOCAL</span></header><div class='asa-session-list' id='asa-session-list'></div></section></section>",
    "        <section class='tools-view' id='tools-view'><header class='tools-header'><div><span class='eyebrow'>TOOLS / LOCAL PREVIEW</span><h2>Browser y previews</h2><p>Conecta navegadores y servidores locales reales sin salir del workspace.</p></div><div class='tools-header-actions'><button class='secondary-button' id='tools-new-localhost' type='button'>Open localhost</button><button class='primary-button' id='tools-new-browser' type='button'>Open browser</button></div></header><div class='tool-tabs' id='tool-tabs'></div><div class='tool-stage' id='tool-stage'><div class='tool-empty' id='tool-empty'><span class='tool-empty-icon'>◎</span><strong>No hay previews abiertos</strong><small>Abre un navegador o un localhost real.</small><button class='secondary-button' id='tool-empty-open' type='button'>Open browser</button></div></div></section>",
    "        <section class='terminal-area' id='terminal-area'><header class='terminal-area-header'><div><span class='eyebrow'>IDE / REAL SHELL · PTY</span><h2>Terminal sessions</h2><small id='active-session-label'>Sin sesión activa</small></div><button class='primary-button' id='terminal-new' type='button'>+<span>Nueva terminal</span></button></header><div class='endpoint-strip' id='endpoint-strip' hidden></div><div class='terminal-tabs' id='terminal-tabs'></div><div class='terminal-stack' id='terminal-stack'></div><div class='terminal-empty' id='terminal-empty'><span>›_</span><strong>No hay terminales abiertas</strong><small id='terminal-empty-copy'>Abre un shell real cuando lo necesites.</small><button class='secondary-button' id='terminal-empty-new' type='button'>Nueva terminal</button></div><div class='terminal-splitter' id='terminal-splitter' role='separator' aria-label='Redimensionar terminal'></div><form class='command-form' id='command-form'><button class='command-cwd' id='command-cwd' type='button' title='Abrir carpeta en el explorador'><span id='command-cwd-label'>Sin directorio activo</span>›</button><input class='command-input' id='command-input' type='text' placeholder='Escribe un comando para el shell real…' autocomplete='off' /><span class='command-live' id='command-live'>WAITING</span><button class='command-submit primary-button' type='submit'>Run</button></form></section>",
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
          <button class="titlebar-btn titlebar-menu-btn" id="titlebar-layout" type="button" title="Workspaces" data-i18n-title="chrome.workspaces" data-i18n-aria="chrome.showWorkspaces" aria-label="Mostrar workspaces" aria-expanded="true" aria-controls="app-body">${icons.menu}</button>
          <button class="titlebar-brand-button" id="titlebar-more" type="button" title="Cambiar workspace" data-i18n-title="chrome.switchWorkspace">
            <span class="brand-lockup">
              <strong id="titlebar-workspace-name">ComesADE</strong>
            </span>
          </button>
        </div>
        <nav class="titlebar-pills" aria-label="Vistas" data-i18n-aria="chrome.views">
          <button class="titlebar-pill is-active" data-view="overview" type="button" data-i18n="chrome.code">Code</button>
          <button class="titlebar-pill" data-view="tools" type="button" data-i18n="chrome.browser">Browser</button>
          <button class="titlebar-pill" data-view="asa" type="button" data-i18n="chrome.agents">Agents</button>
          <button class="titlebar-pill" data-view="terminals" type="button" data-i18n="chrome.terminal">Terminal</button>
          <button class="titlebar-pill" id="titlebar-layout-picker" type="button" title="Design Mode" data-i18n="chrome.design" data-i18n-title="chrome.design">Design</button>
        </nav>
        <div class="titlebar-right-controls">
          <button class="titlebar-btn titlebar-update" id="titlebar-update" type="button" title="Hay una actualización disponible" data-i18n-title="chrome.update" hidden>
            ${icons.updateNow}<span data-i18n="chrome.updateNow">Update Now</span>
          </button>
          <button class="titlebar-btn" id="open-command-palette" type="button" title="Search" data-i18n="common.search" data-i18n-title="common.search">Search</button>
          <button class="titlebar-btn" id="titlebar-composer-toggle" type="button" title="AI" data-i18n="chrome.ai" data-i18n-title="chrome.ai">AI</button>
          <button class="titlebar-account" id="titlebar-account" type="button" title="Account" data-i18n-title="common.account" aria-haspopup="menu" aria-expanded="false">${icons.user}</button>
          <div class="titlebar-window-slot titlebar-window-slot-right" id="titlebar-window-slot-right"></div>
        </div>
      </header>

      <div class="app-body" id="app-body">
        <nav class="activity-rail" id="activity-rail" aria-label="Actividad" data-i18n-aria="chrome.activity">
          <button class="activity-rail-item is-active" data-activity="explorer" type="button" title="Explorer" data-i18n-title="chrome.explorer">${icons.folder}</button>
          <button class="activity-rail-item" data-activity="search" type="button" title="Search" data-i18n-title="common.search">${icons.search}</button>
          <button class="activity-rail-item" data-activity="scm" type="button" title="Source Control" data-i18n-title="chrome.scm">${icons.git}</button>
          <button class="activity-rail-item" data-activity="ai" type="button" title="AI" data-i18n-title="chrome.ai">${icons.sparkle}</button>
          <button class="activity-rail-item" data-activity="agents" type="button" title="Agents" data-i18n-title="chrome.agents">${icons.bolt}</button>
          <button class="activity-rail-item" data-activity="terminal" type="button" title="Terminal" data-i18n-title="chrome.terminal">${icons.terminal}</button>
          <button class="activity-rail-item" data-activity="extensions" type="button" title="Cuentas y modelos" data-i18n-title="chrome.accountsModels">${icons.grid}</button>
          <span class="activity-rail-spacer"></span>
          <button class="activity-rail-item" id="rail-settings" type="button" title="Settings" data-i18n-title="common.settings">${icons.settings}</button>
        </nav>
        <aside class="sidebar" aria-label="Workspaces y sesiones" data-i18n-aria="chrome.sidebar">
          <div class="sidebar-mode-tabs">
            <button type="button" id="sidebar-tab-plugins" data-i18n="chrome.plugins">Plugins</button>
            <button type="button" class="is-active" id="sidebar-tab-projects" data-i18n="chrome.projects">Projects</button>
          </div>

          <button class="sidebar-github-card" id="github-account-card" type="button" aria-label="Publicar en GitHub" data-i18n-aria="chrome.githubPublish" aria-live="polite">
            <span class="github-account-icon">${icons.github}</span>
            <span class="github-account-copy"><strong id="github-account-label">GitHub</strong><small id="github-account-status" data-i18n="chrome.githubPublishHint">Publica este proyecto en GitHub.</small></span>
            <span class="github-account-dot" id="github-account-dot"></span>
            <span class="github-publish-cta" id="github-publish-cta" data-i18n="chrome.githubPublish">Publish to GitHub</span>
          </button>
          <button class="sidebar-github-card sidebar-accounts-card" id="ai-accounts-card" type="button" aria-label="Conectar cuentas de agentes" data-i18n-aria="chrome.accounts">
            <span class="github-account-icon">✦</span>
            <span class="github-account-copy"><strong id="ai-accounts-label" data-i18n="chrome.aiAccounts">Cuentas AI</strong><small id="ai-accounts-status" data-i18n="chrome.noAgents">Sin agentes conectados</small></span>
            <span class="github-account-dot" id="ai-accounts-dot"></span>
          </button>

          <nav class="sidebar-nav" aria-label="Vistas principales">
            <button class="sidebar-nav-item is-active" data-view="overview" type="button">
              <span class="nav-glyph">▦</span>
              <span><strong data-i18n="chrome.editor">Editor</strong><small data-i18n="chrome.editorHint">Archivos y chat</small></span>
            </button>
            <button class="sidebar-nav-item" data-view="asa" type="button">
              <span class="nav-glyph">✦</span>
              <span><strong data-i18n="chrome.agents">Agents</strong><small data-i18n="chrome.agentsHint">CLI y worktrees</small></span>
            </button>
            <button class="sidebar-nav-item" data-view="terminals" type="button">
              <span class="nav-glyph">›_</span>
              <span><strong data-i18n="chrome.terminal">Terminal</strong><small data-i18n="chrome.terminalHint">Shells reales</small></span>
            </button>
            <button class="sidebar-nav-item" data-view="tools" type="button">
              <span class="nav-glyph">◎</span>
              <span><strong data-i18n="chrome.browser">Browser</strong><small data-i18n="chrome.browserHint">Preview integrado</small></span>
            </button>
            <button class="sidebar-nav-item" id="sidebar-search" type="button">
              <span class="nav-glyph">⌕</span>
              <span><strong data-i18n="common.search">Buscar</strong><small data-i18n="chrome.searchHint">Proyecto y archivos</small></span>
            </button>
          </nav>

          <div class="sidebar-section-title">
            <span data-i18n="chrome.activeProjects">Active projects</span>
            <button class="icon-button" id="sidebar-open-workspaces" type="button" title="Abrir workspace" data-i18n-title="chrome.openWorkspace">+</button>
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
            <strong data-i18n="chrome.noWorkspace">Sin workspace</strong>
            <small data-i18n="chrome.openFolderStart">Abre una carpeta para empezar.</small>
          </div>

          <div class="sidebar-workspace-heading">
            <span id="sidebar-project-label" data-i18n="chrome.threads">Coding threads</span>
            <button class="icon-button" id="sidebar-filter-btn" type="button" title="Filtros: todas las sesiones" data-i18n-title="chrome.filterSessions">≡</button>
          </div>
          <div class="session-list" id="session-list"></div>

          <div class="sidebar-session-actions">
            <input class="sidebar-search-input" id="sidebar-search-input" type="search" placeholder="Filtrar sesiones" data-i18n-placeholder="chrome.filterSessionsPh" data-i18n-aria="chrome.filterSessionsPh" aria-label="Filtrar sesiones" />
            <button class="secondary-button sidebar-new-session" id="sidebar-new-session" type="button">+<span data-i18n="chrome.newSession">Nueva sesión</span></button>
          </div>

          <div class="sidebar-spacer"></div>

          <div class="sidebar-footer">
            <button class="sidebar-runtime-button" id="sidebar-runtime" type="button">
              <span class="status-dot"></span>
              <span><strong data-i18n="chrome.local">Local</strong><small id="connection-state" data-i18n="chrome.thisComputer">This computer</small></span>
            </button>
            <div class="sidebar-footer-actions">
              <button class="icon-button sidebar-refresh-action" id="refresh-workspace-btn" type="button" title="Actualizar sesiones, archivos y Git" aria-label="Actualizar sesiones, archivos y Git" data-i18n-title="chrome.refreshAll" data-i18n-aria="chrome.refreshAll">${icons.refresh}</button>
            </div>
            <div class="sidebar-version"><span>COMESADE</span><span id="app-version-label">1.0.0</span></div>
          </div>
          <div class="sidebar-resizer" id="sidebar-resizer" aria-hidden="true"></div>
        </aside>

        <main class="workspace-main view-overview">
          <header class="workspace-header" hidden>
            <div class="workspace-header-copy">
              <span class="editor-breadcrumbs" id="workspace-header-path">Sin workspace</span>
              <h1 id="workspace-heading" class="visually-hidden">Editor</h1>
            </div>
            <div class="workspace-header-actions">
              <button class="header-button" id="open-workspace-menu" type="button" data-i18n="chrome.folder">Folder</button>
              <button class="header-button" id="open-browser-menu" type="button" data-i18n="chrome.browser">Browser</button>
              <button class="header-button header-button-agent" id="header-new-agent" type="button" data-i18n="chrome.ai">AI</button>
              <button class="header-button" id="header-new-session" type="button" data-i18n="chrome.terminal">Terminal</button>
            </div>
          </header>

          <section class="start-canvas" id="start-canvas" hidden>
            <img class="start-logo" id="start-canvas-logo" src="${comesadeLogoUrl}" alt="ComesADE" width="80" height="80" />
            <div class="start-copy">
              <h2 id="start-canvas-title" data-i18n="chrome.startTitle">What should we work on?</h2>
              <p class="start-subtitle" id="start-canvas-subtitle" hidden></p>
            </div>
            <div class="start-cards">
              <button class="start-card" id="start-explore" type="button">
                <span class="start-card-icon" aria-hidden="true">${icons.search}</span>
                <strong data-i18n="chrome.explore">Explore and understand code</strong>
                <span data-i18n="chrome.exploreHint">Lee el workspace real y resume cómo está montado.</span>
              </button>
              <button class="start-card" id="start-build" type="button">
                <span class="start-card-icon" aria-hidden="true">${icons.bolt}</span>
                <strong data-i18n="chrome.build">Build a new feature, app, or tool</strong>
                <span data-i18n="chrome.buildHint">Pide un cambio y el agente lo aplica en archivos de verdad.</span>
              </button>
            </div>
          </section>

          <div class="workspace-views-stack" id="workspace-views-stack">
            <section class="workspace-overview" id="workspace-overview">
              <section class="workspace-lock panel" id="workspace-lock" hidden>
                <span class="workspace-lock-icon">□</span>
                <span class="eyebrow" data-i18n="chrome.lockEyebrow">WORKSPACE REQUIRED</span>
                <h2 data-i18n="chrome.lockTitle">Abre un workspace real</h2>
                <p data-i18n="chrome.lockCopy">Conecta archivos, terminales, Git y previews desde una carpeta local.</p>
                <div class="workspace-lock-actions">
                  <button class="secondary-button" id="workspace-lock-open" type="button" data-i18n="chrome.lockOpen">Abrir workspace</button>
                  <button class="primary-button" id="workspace-lock-create" type="button" data-i18n="chrome.lockCreate">Crear workspace</button>
                </div>
              </section>

              <div class="workspace-grid">
                <section class="panel workspace-summary-panel">
                  <header class="panel-header">
                    <div>
                      <span class="eyebrow" data-i18n="chrome.workspace">WORKSPACE</span>
                      <h2 data-i18n="chrome.localProject">Proyecto local</h2>
                    </div>
                    <button class="icon-button" id="workspace-context-session" type="button" title="Abrir una sesión real" data-i18n-title="chrome.openRealSession">+</button>
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
                      <span data-i18n="chrome.sessions">Sesiones</span>
                      <strong id="overview-session-count">0</strong>
                      <small id="overview-active-label">READY</small>
                    </button>
                    <button class="summary-metric" id="summary-runtime" type="button">
                      <span data-i18n="chrome.runtime">Runtime</span>
                      <strong id="overview-runtime-status">LOCKED</strong>
                      <small id="overview-shell">Sin shell</small>
                    </button>
                    <button class="summary-metric" id="summary-shell" type="button">
                      <span data-i18n="chrome.path">Path</span>
                      <strong id="overview-path-short">—</strong>
                      <small id="overview-path-detail">Sin workspace</small>
                    </button>
                  </div>

                  <div class="panel-actions">
                    <button class="secondary-button" id="workspace-summary-browser" type="button" data-i18n="chrome.openBrowser">Abrir browser</button>
                    <button class="secondary-button" id="workspace-summary-agent" type="button" data-i18n="chrome.openChat">Abrir chat</button>
                  </div>
                </section>

                <section class="panel notes-panel">
                  <header class="panel-header">
                    <div>
                      <span class="eyebrow" data-i18n="chrome.notesEyebrow">NOTES</span>
                      <h2 data-i18n="chrome.notesTitle">Notas rápidas</h2>
                    </div>
                    <span class="panel-state" id="notes-status">LOCKED</span>
                  </header>
                  <textarea id="notes-input" placeholder="Decisiones, comandos o contexto de este proyecto..." aria-label="Notas del workspace" data-i18n-placeholder="chrome.notesPh" data-i18n-aria="chrome.notesAria"></textarea>
                  <small class="panel-hint" data-i18n="chrome.notesHint">Se guardan localmente por workspace.</small>
                </section>
              </div>
            </section>

            <section class="asa-overview" id="asa-overview">
              <header class="asa-header">
                <div>
                  <span class="eyebrow" data-i18n="chrome.agentsEyebrow">AGENTS</span>
                  <h2 data-i18n="chrome.agentsTitle">Procesos reales</h2>
                  <p data-i18n="chrome.agentsCopy">El agente corre en este dispositivo. El modelo es tu cuenta; archivos, Git y terminal se ejecutan aquí.</p>
                </div>
                <div class="asa-header-actions">
                  <button class="secondary-button" id="asa-accounts" type="button" data-i18n="chrome.accounts">Cuentas</button>
                </div>
              </header>
              <section class="panel asa-accounts-panel">
                <header class="panel-header">
                  <div>
                    <span class="eyebrow" data-i18n="chrome.accounts">Cuentas</span>
                    <h3 data-i18n="chrome.agentsPanelTitle">Cuentas de agentes</h3>
                  </div>
                </header>
                <div id="asa-agent-list" class="asa-agent-list"></div>
              </section>
            </section>

              <section class="panel native-agent-panel" id="native-agent-panel">
                <header class="agent-chat-header">
                  <div class="agent-chat-heading">
                    <strong id="agent-chat-title" data-i18n="chrome.agent">Agente</strong>
                    <small id="agent-chat-subtitle" data-i18n="chrome.thisDevice">Este dispositivo</small>
                  </div>
                  <div class="agent-chat-header-actions">
                    <button class="secondary-button" id="composer-accounts" type="button" data-i18n="chrome.accounts">Cuentas</button>
                    <button class="icon-button" id="composer-hide" type="button" title="Ocultar chat" data-i18n-title="chrome.hideChat">${icons.close}</button>
                  </div>
                </header>
                <p class="agent-chat-hint" id="agent-chat-hint" data-i18n="chrome.agentHint">El agente corre en este PC. Conecta tu plan y escribe; ComesADE no lo ejecuta en un servidor.</p>
                <div class="native-agent-log" id="native-agent-log" hidden></div>
                <div class="composer-listening" id="composer-listening" hidden role="status" aria-live="polite">
                  <div class="composer-listening-bars" id="composer-listening-bars" aria-hidden="true">${Array.from({ length: 28 }, () => '<i></i>').join('')}</div>
                  <span data-i18n="chrome.listening">Escuchando</span>
                </div>
                <form class="native-agent-form" id="native-agent-form">
                  <div class="composer-git-bar" id="composer-git-bar" hidden>
                    <button class="composer-changes" id="composer-changes" type="button" hidden>
                      <span data-i18n="chrome.changes">Changes</span> <b class="stat-add" id="composer-git-add">+0</b> <b class="stat-delete" id="composer-git-del">-0</b>
                    </button>
                    <button class="composer-commit-action" id="composer-commit-action" type="button" hidden>
                      <span data-i18n="chrome.createBranch">Create Branch &amp; Commit</span> ${icons.chevron}
                    </button>
                  </div>
                  <div class="composer-captures" id="composer-captures" hidden></div>
                  <div class="ai-context-bar" id="ai-context-bar" hidden></div>
                  <div class="composer-input-card">
                    <button class="icon-button composer-plus" id="ai-attach-context" type="button" title="Adjuntar archivo" data-i18n-title="chrome.attach">${icons.add}</button>
                    <textarea class="composer-input" id="native-agent-input" rows="1" placeholder="Escribe un mensaje" data-i18n-placeholder="chrome.writeMessage"></textarea>
                    <div class="composer-input-end">
                      <select class="visually-hidden" id="native-agent-provider" aria-label="Cuenta" data-i18n-aria="chrome.accountSelect"></select>
                      <button class="composer-account" id="composer-account" type="button" aria-haspopup="listbox" aria-expanded="false" title="Cuenta del agente" data-i18n-title="chrome.accountSelect">
                        <span class="composer-account-dot" aria-hidden="true"></span>
                        <span id="composer-account-label" data-i18n="chrome.accountSelect">Cuenta</span>
                        ${icons.chevron}
                      </button>
                      <button class="native-agent-model" id="native-agent-model" type="button" aria-haspopup="listbox" aria-expanded="false" title="Cambiar modelo" data-i18n-title="chrome.changeModel" hidden>
                        <span id="native-agent-model-label" data-i18n="chrome.model">Modelo</span>
                      </button>
                      <button class="composer-usage" id="composer-usage" type="button" hidden></button>
                      <button class="icon-button composer-mic" id="composer-mic" type="button" title="Dictado en ComesADE" data-i18n-title="chrome.mic" aria-pressed="false">${icons.mic}</button>
                      <button class="composer-stop" id="native-agent-cancel" type="button" hidden title="Stop" data-i18n-title="chrome.stop">${icons.stop}</button>
                      <button class="composer-send" id="native-agent-send" type="submit" title="Send" data-i18n-title="chrome.send" hidden>${icons.chevron}</button>
                    </div>
                  </div>
                  <div class="composer-meta-row">
                    <button class="composer-meta-chip" id="composer-git-branch" type="button" title="Cambiar rama" hidden>${icons.branch}<span id="composer-git-branch-label"></span></button>
                    <span class="composer-meta-chip" id="composer-runtime" title="El agente corre en este PC" data-i18n-title="chrome.agentHint">${icons.desktop}<span data-i18n="chrome.thisPc">This PC</span></span>
                    <span class="native-agent-status composer-busy-spin" id="native-agent-status" hidden></span>
                    <span class="native-agent-form-spacer"></span>
                    <span class="composer-message-quota" id="composer-message-quota" hidden>Msgs</span>
                    <span class="composer-speech-quota" id="composer-speech-quota" hidden>Voz</span>
                    <button class="composer-meta-chip composer-stt-lang" id="composer-stt-lang-button" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Idioma de dictado" title="Idioma para dictado en ComesADE" data-i18n-aria="chrome.sttLang" data-i18n-title="chrome.sttLang"><span id="composer-stt-lang-label">Auto</span></button>
                    <select class="visually-hidden" id="composer-stt-lang" aria-hidden="true" tabindex="-1"></select>
                    <button class="icon-button composer-tts" id="composer-tts" type="button" title="Leer respuesta del agente" data-i18n-title="chrome.tts">${icons.speaker}</button>
                  </div>
                  <div class="native-agent-efforts" id="native-agent-efforts" hidden></div>
                </form>
              </section>

            <section class="tools-view" id="tools-view">
              <header class="tools-header">
                <div class="browser-chrome">
                  <strong data-i18n="chrome.browser">Browser</strong>
                  <small data-i18n="chrome.previewReal">Preview real</small>
                </div>
                <div class="tools-header-actions">
                  <button class="secondary-button" id="design-mode-toggle" type="button" title="Design Mode (Ctrl+Shift+D)" data-i18n="chrome.design">Design</button>
                  <button class="secondary-button" id="tools-new-localhost" type="button" data-i18n="chrome.localhost">Localhost</button>
                  <button class="primary-button" id="tools-new-browser" type="button" data-i18n="chrome.open">Open</button>
                </div>
              </header>
              <div class="design-toolbar" id="design-toolbar" hidden>
                <button type="button" class="design-tool" data-design-tool="select" title="Seleccionar un elemento" data-i18n="chrome.select" data-i18n-title="chrome.selectEl">Select</button>
                <button type="button" class="design-tool is-active" data-design-tool="draw" title="Capturar una zona del preview" data-i18n="chrome.capture" data-i18n-title="chrome.captureZone">Capture</button>
                <div class="design-picks" id="design-picks"></div>
                <button class="secondary-button" id="design-clear" type="button" data-i18n="chrome.clear">Limpiar</button>
                <button class="primary-button" id="design-to-chat" type="button" data-i18n="chrome.toChat">Al chat</button>
              </div>
              <div class="tool-tabs" id="tool-tabs"></div>
              <div class="tool-stage" id="tool-stage">
                <div class="tool-empty" id="tool-empty">
                  <span class="tool-empty-icon">◎</span>
                  <strong data-i18n="chrome.noPreviews">No hay previews abiertos</strong>
                  <small data-i18n="chrome.noPreviewsHint">Abre un browser o un localhost real.</small>
                  <button class="secondary-button" id="tool-empty-open" type="button" data-i18n="chrome.openBrowser">Open browser</button>
                </div>
              </div>
            </section>

            <section class="terminal-area" id="terminal-area">
              <header class="terminal-area-header">
                <div class="bottom-panel-tabs">
                  <button class="bottom-panel-tab is-active" type="button" data-i18n="chrome.terminal">Terminal</button>
                  <small id="active-session-label">Sin sesión</small>
                </div>
                <button class="icon-button" id="terminal-new" type="button" title="Nueva terminal" data-i18n-title="chrome.newTerminal">+</button>
              </header>
              <div class="endpoint-strip" id="endpoint-strip" hidden></div>
              <div class="terminal-tabs" id="terminal-tabs"></div>
              <div class="terminal-stack" id="terminal-stack"></div>
              <div class="terminal-empty" id="terminal-empty" aria-hidden="true">
                <span>›_</span>
                <strong data-i18n="chrome.noTerminals">No hay terminales abiertas</strong>
                <small id="terminal-empty-copy" data-i18n="shell.emptyCopy">Abre un shell real cuando lo necesites.</small>
                <button class="secondary-button" id="terminal-empty-new" type="button" data-i18n="chrome.newTerminal">Nueva terminal</button>
              </div>
              <div class="terminal-splitter" id="terminal-splitter" role="separator" aria-label="Redimensionar terminal" data-i18n-aria="chrome.resizeTerminal"></div>
              <form class="command-form" id="command-form">
                <button class="command-cwd" id="command-cwd" type="button" title="Abrir carpeta en el explorador" data-i18n-title="chrome.openFolderExplorer">
                  <span id="command-cwd-label">Sin directorio activo</span>›
                </button>
                <input class="command-input" id="command-input" type="text" placeholder="Escribe un comando para el shell real..." autocomplete="off" data-i18n-placeholder="chrome.commandPh" />
                <span class="command-live" id="command-live" data-i18n="status.waiting">WAITING</span>
                <button class="command-submit primary-button" type="submit" data-i18n="chrome.run">Run</button>
              </form>
            </section>
          </div>
        </main>

        <aside class="workspace-inspector" id="workspace-inspector" aria-label="Inspector del workspace" data-i18n-aria="chrome.inspector">
          <div class="inspector-resizer" id="inspector-resizer" role="separator" aria-orientation="vertical" aria-label="Redimensionar inspector" title="Redimensionar inspector" tabindex="0" data-i18n-aria="chrome.resizeInspector" data-i18n-title="chrome.resizeInspector"></div>
          <div class="inspector-tab-strip" role="tablist" aria-label="Inspector" data-i18n-aria="chrome.inspectorTab">
                    <button class="inspector-tab-header-btn inspector-tab-active" data-inspector-tab="explorer" type="button" role="tab" aria-selected="true" data-i18n="chrome.files">Archivos</button>
            <button class="inspector-tab-header-btn" data-inspector-tab="git" type="button" role="tab" aria-selected="false" data-i18n="chrome.git">Git</button>
            <button class="inspector-tab-header-btn" data-inspector-tab="overview" type="button" role="tab" aria-selected="false" data-i18n="chrome.summary">Resumen</button>
            <button class="inspector-tab-header-btn" data-inspector-tab="sessions" type="button" role="tab" aria-selected="false" data-i18n="chrome.sessions">Sesiones</button>
          </div>
          <div class="inspector-view-body">
            <div class="inspector-empty" id="workspace-inspector-empty">
              <span>□</span>
              <strong data-i18n="chrome.noWorkspace">Sin workspace</strong>
              <small data-i18n="chrome.exploreFiles">Abre una carpeta para explorar sus archivos.</small>
            </div>

            <div class="inspector-file-pane" id="workspace-file-explorer">
              <div class="inspector-header-row">
                <div>
                  <span class="eyebrow" data-i18n="chrome.explorer">EXPLORER</span>
                  <strong id="inspector-workspace-title">Workspace</strong>
                  <small id="file-tree-path">WORKSPACE</small>
                </div>
                <div class="inspector-header-actions">
                  <button class="icon-button" id="inspector-view-sort" type="button" title="Ordenar archivos" data-i18n-title="chrome.sortFiles">↕</button>
                  <button class="icon-button" id="files-refresh" type="button" title="Actualizar archivos" data-i18n-title="chrome.refreshFiles">↻</button>
                  <button class="icon-button" id="inspector-more" type="button" title="Más opciones" data-i18n-title="chrome.more">…</button>
                </div>
              </div>

              <input class="field-input inspector-search-input" id="inspector-search-input" type="search" placeholder="Buscar archivos" aria-label="Buscar archivos" data-i18n-placeholder="chrome.searchFiles" data-i18n-aria="chrome.searchFiles" />
              <div class="inspector-segmented-control">
                <button class="inspector-segment-btn segmented-item-active" id="filter-names-btn" type="button" data-i18n="chrome.names">Nombres</button>
                <button class="inspector-segment-btn" id="filter-content-btn" type="button" data-i18n="chrome.content">Contenido</button>
              </div>
              <div class="file-list-tree" id="file-tree"></div>
              <div class="inspector-file-actions">
                <button class="secondary-button" id="floating-layout-toggle" type="button" data-i18n="chrome.inspectorTab">Inspector</button>
              </div>
            </div>

            <section class="inspector-compat-pane" id="inspector-overview-pane" hidden>
              <span class="eyebrow" data-i18n="chrome.workspace">WORKSPACE</span>
              <strong id="inspector-overview-name">Sin workspace</strong>
              <small id="inspector-overview-path">Crea o abre un workspace.</small>
              <div class="inspector-overview-facts">
                <span><b id="inspector-overview-sessions">0</b> <span data-i18n="chrome.sessionsWord">sesiones</span></span>
                <span><b id="inspector-overview-runtime">LOCKED</b></span>
              </div>
            </section>

            <section class="inspector-compat-pane" id="inspector-git-pane" hidden>
              <div class="inspector-pane-heading">
                <div>
                  <span class="eyebrow" data-i18n="chrome.gitStatus">GIT STATUS</span>
                  <strong id="inspector-git-branch">NO REPOSITORY</strong>
                </div>
                <button class="icon-button" id="inspector-git-refresh" type="button" title="Actualizar Git" data-i18n-title="chrome.refreshGit">↻</button>
              </div>
              <div id="inspector-git-content" class="inspector-compat-list"></div>
            </section>

            <section class="inspector-compat-pane" id="inspector-sessions-pane" hidden>
              <div class="inspector-pane-heading">
                <div>
                  <span class="eyebrow" data-i18n="chrome.runtime">RUNTIME</span>
                  <strong data-i18n="chrome.openSessions">Sesiones abiertas</strong>
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
          <button class="statusbar-pill" id="git-branch-status" type="button" hidden></button>
          <span class="statusbar-pill" id="runtime-usage-metric" hidden></span>
        </div>
        <div class="statusbar-right-group">
          <span class="statusbar-pill" id="editor-cursor-status" hidden></span>
          <span class="statusbar-pill" id="editor-file-meta" hidden></span>
          <span class="statusbar-pill" id="active-terminal-pill" hidden>›_ <span id="active-terminal-count">0</span></span>
          <button class="icon-button" id="sidebar-settings" type="button" title="Settings" data-i18n-title="common.settings">${icons.settings}</button>
        </div>
      </footer>
    </div>
    <div class="github-auth-gate" id="github-auth-gate" hidden role="dialog" aria-modal="true" aria-labelledby="github-auth-title" aria-describedby="github-auth-copy">
      <section class="github-auth-panel">
        <div class="github-auth-heading">
          <span class="github-account-icon">${icons.github}</span>
          <div>
            <span class="eyebrow" data-i18n="chrome.githubEyebrow">COMESADE / GITHUB</span>
            <h1 id="github-auth-title" data-i18n="chrome.githubOptional">Conecta GitHub si quieres clonar</h1>
          </div>
        </div>
        <p class="github-auth-copy" id="github-auth-copy" data-i18n="chrome.githubCopy">GitHub es opcional. El IDE funciona en local; conéctalo solo para clonar o publicar repositorios. Las cuentas de agentes se conectan en Cuentas AI.</p>
        <div class="github-auth-status" role="status" aria-live="polite">
          <span class="github-auth-status-dot" id="github-auth-status-dot"></span>
          <span><strong id="github-auth-status-title" data-i18n="chrome.githubCheckingTitle">Comprobando conexion</strong><small id="github-auth-status-detail" data-i18n="chrome.githubCheckingDetail">Verificando la autorizacion de GitHub...</small></span>
        </div>
        <div class="github-auth-device-code" id="github-auth-device-code" hidden aria-live="polite">
          <div class="github-auth-device-code-copy">
            <span class="eyebrow" data-i18n="chrome.githubDevice">GITHUB DEVICE CODE</span>
            <span class="github-auth-device-code-label" data-i18n="chrome.githubDeviceLabel">Codigo que debes introducir en GitHub</span>
            <code id="github-auth-device-code-value" aria-label="Codigo de autorizacion de GitHub" data-i18n-aria="chrome.githubAuthCode"></code>
          </div>
        </div>
        <small class="github-auth-device-warning" id="github-auth-device-warning" hidden></small>
        <div class="github-auth-actions">
          <button class="primary-button" id="github-auth-connect" type="button">${icons.github}<span data-i18n="chrome.githubConnect">Conectar GitHub</span></button>
          <button class="secondary-button" id="github-auth-check" type="button" data-i18n="chrome.githubAlready">Ya estoy conectado</button>
        </div>
        <small class="github-auth-note" id="github-auth-note" data-i18n="chrome.githubNote">Se abrira el flujo oficial de autorizacion de GitHub en tu navegador.</small>
      </section>
    </div>
    <div id="modal-root"></div>
    <div id="account-menu-root"></div>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
    <div class="boot-splash" id="boot-splash" role="status" aria-live="polite" aria-label="Cargando ComesADE" data-i18n-aria="chrome.loading">
      <div class="boot-stage">
        <img class="boot-logo" id="boot-logo" src="${comesadeLogoUrl}" alt="" />
        <canvas class="boot-pixels" id="boot-pixels" hidden></canvas>
        <p class="boot-wordmark" id="boot-wordmark" hidden><span>COMES</span><span>ADE</span></p>
      </div>
    </div>
  `;
}

renderComesadeSurface();


// La superficie ComesADE ya contiene todos los puntos de montaje reales.

const workspaceLockDescription = document.querySelector<HTMLElement>('#workspace-lock p');
if (workspaceLockDescription) workspaceLockDescription.setAttribute('data-i18n', 'chrome.lockCopyLive');
const terminalAreaMount = document.querySelector<HTMLElement>('#terminal-area');
if (terminalAreaMount && !document.querySelector('#developer-dock')) {
  const dock = document.createElement('section');
  dock.className = 'developer-dock';
  dock.id = 'developer-dock';
  dock.innerHTML = '<section class="editor-panel panel"><header class="dock-header"><div><strong id="editor-file-name">No file open</strong><small id="editor-file-path">Selecciona un archivo real</small></div><div class="dock-actions"><span id="editor-save-status" class="muted-label">CLEAN</span><button class="secondary-button" id="editor-save" type="button">' + icons.note + '<span data-i18n="chrome.saveFile">Save</span></button></div></header><div class="editor-tabs" id="editor-tabs" role="tablist" aria-label="Archivos abiertos" data-i18n-aria="chrome.openFiles"></div><textarea id="editor-content" class="code-editor" spellcheck="false" disabled placeholder="Selecciona un archivo del proyecto." data-i18n-placeholder="chrome.selectFilePh"></textarea></section><div class="developer-dock-resizer" id="developer-dock-resizer" role="separator" aria-orientation="vertical" aria-label="Redimensionar Editor y Git" title="Redimensionar Editor y Git" tabindex="0" data-i18n-aria="chrome.resizeEditorGit" data-i18n-title="chrome.resizeEditorGit"></div><aside class="git-panel panel"><header class="dock-header"><div><strong data-i18n="chrome.git">Git</strong><small id="git-branch">NO REPOSITORY</small></div><button class="icon-button" id="git-refresh" title="Refresh Git" data-i18n-title="chrome.refreshGit">' + icons.refresh + '</button></header><div class="git-list" id="git-list"><div class="dock-empty" data-i18n="chrome.gitEmpty">El workspace no tiene status Git cargado.</div></div><pre class="git-diff" id="git-diff">Selecciona un cambio para ver el diff real.</pre><div class="git-commit-row"><input class="field-input" id="git-commit-message" placeholder="Commit message" data-i18n-placeholder="chrome.commitMessage"/><button class="primary-button" id="git-commit" type="button" data-i18n="chrome.commit">Commit</button></div></aside>';
  terminalAreaMount.before(dock);
}
const workspaceMainMount = document.querySelector<HTMLElement>('.workspace-main');
const workspaceInspectorMount = document.querySelector<HTMLElement>('#workspace-inspector');
if (workspaceMainMount && workspaceInspectorMount) {
  workspaceMainMount.before(workspaceInspectorMount);
}
const agentPanelMount = document.querySelector('#native-agent-panel');
if (workspaceMainMount && agentPanelMount && !agentPanelMount.classList.contains('composer-dock')) {
  agentPanelMount.classList.add('composer-dock');
  workspaceMainMount.appendChild(agentPanelMount);
}
const developerDockMount = document.querySelector<HTMLElement>('#developer-dock');
const viewsStackEl = document.querySelector<HTMLElement>('#workspace-views-stack');
const toolsViewMount = document.querySelector<HTMLElement>('#tools-view');
if (workspaceMainMount && developerDockMount && viewsStackEl) {
  let workSplit = document.querySelector<HTMLElement>('#work-split');
  if (!workSplit) {
    workSplit = document.createElement('div');
    workSplit.id = 'work-split';
    workSplit.className = 'work-split';
    workspaceMainMount.insertBefore(workSplit, viewsStackEl);
  }
  if (developerDockMount.parentElement !== workSplit) workSplit.appendChild(developerDockMount);
  if (toolsViewMount && toolsViewMount.parentElement !== workSplit) workSplit.appendChild(toolsViewMount);
}
if (document.querySelector('#app-body') && !document.querySelector('#composer-rail')) {
  const rail = document.createElement('aside');
  rail.className = 'composer-rail';
  rail.id = 'composer-rail';
  rail.setAttribute('aria-label', 'Chat');
  document.querySelector('#app-body')!.appendChild(rail);
}
if (toolsViewMount) toolsViewMount.classList.remove('browser-rail');
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
      codeEditor.addCommand(monacoModule.KeyMod.CtrlCmd | monacoModule.KeyCode.KeyL, () => { focusComposer(); });
      codeEditor.addCommand(monacoModule.KeyMod.CtrlCmd | monacoModule.KeyCode.KeyK, () => { startInlineEdit(); });
      codeEditor.onDidChangeCursorPosition(() => {
        updateEditorStatusbar();
        renderAiContextBar();
      });
      updateEditorStatusbar();
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
  updateEditorStatusbar();
}

function setEditorEnabled(enabled: boolean): void {
  editorContent.disabled = !enabled;
  codeEditor?.updateOptions({ readOnly: !enabled });
}

function renderStartCanvas(): void {
  const title = document.querySelector<HTMLElement>('#start-canvas-title');
  const subtitle = document.querySelector<HTMLElement>('#start-canvas-subtitle');
  const workspace = getWorkspace();
  if (title) title.textContent = t('chrome.startTitle');
  if (subtitle) {
    const label = workspace ? compactPathLabel(workspace.path) : '';
    subtitle.textContent = label;
    subtitle.hidden = !label;
  }
}

function syncDeveloperDockVisibility(): void {
  const workspaceOpen = Boolean(getWorkspace());
  const emptyCode = workspaceOpen && !openFilePath && layoutState.view === 'overview' && layoutState.workLayout !== 'browser' && layoutState.workLayout !== 'design' && layoutState.workLayout !== 'dual';
  const visible = workspaceOpen && !developerDockCollapsed && !emptyCode;
  developerDock.classList.toggle('developer-dock-open', visible);
  developerDock.classList.toggle('developer-dock-collapsed', developerDockCollapsed || emptyCode);
  const start = document.querySelector<HTMLElement>('#start-canvas');
  if (start) start.hidden = !emptyCode;
  if (emptyCode) renderStartCanvas();
  document.querySelector('.workspace-main')?.classList.toggle('code-chat-open', emptyCode);
}

function syncComposerVisibility(): void {
  const open = Boolean(getWorkspace()) && !composerCollapsed;
  document.querySelector<HTMLElement>('.app-shell')?.classList.toggle('composer-collapsed', !open);
  const toggle = document.querySelector<HTMLButtonElement>('#titlebar-composer-toggle');
  if (toggle) {
    toggle.title = open ? 'Ocultar chat (Ctrl+L)' : 'Mostrar chat (Ctrl+L)';
    toggle.setAttribute('aria-expanded', String(open));
  }
  applyWorkLayout();
}

function focusComposer(prefill?: string): void {
  if (!getWorkspace()) {
    showToast(t('toast.needWorkspaceChat'), true);
    return;
  }
  composerCollapsed = false;
  layoutState.composerCollapsed = false;
  syncComposerVisibility();
  saveLayout();
  if (typeof prefill === 'string') nativeAgentInput.value = prefill;
  resizeNativeAgentInput();
  nativeAgentInput.focus();
  nativeAgentInput.setSelectionRange(nativeAgentInput.value.length, nativeAgentInput.value.length);
}

function toggleComposer(forceOpen = false): void {
  if (!getWorkspace()) {
    showToast(t('toast.needWorkspaceChat'), true);
    return;
  }
  composerCollapsed = forceOpen ? false : !composerCollapsed;
  layoutState.composerCollapsed = composerCollapsed;
  syncComposerVisibility();
  saveLayout();
  if (!composerCollapsed) nativeAgentInput.focus();
}

function renderAiContextBar(): void {
  const bar = document.querySelector<HTMLElement>('#ai-context-bar');
  if (!bar) return;
  const chips: string[] = [];
  if (openFilePath) chips.push(openFilePath.split('/').pop() ?? openFilePath);
  const extras = openFileTabs.filter((tab) => !openFilePath || relativePathKey(tab.path) !== relativePathKey(openFilePath)).slice(-3);
  for (const tab of extras) chips.push(tab.path.split('/').pop() ?? tab.path);
  const selection = editorSelectionText();
  if (selection) chips.push('Selection');
  const live = sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id));
  if (live[0]) chips.push(live[0].name);
  for (const pick of designPicks.slice(0, 6)) {
    chips.push(pick.component || pick.tag + (pick.id ? '#' + pick.id : ''));
  }
  bar.hidden = chips.length === 0;
  bar.innerHTML = chips.length
    ? '<span class="ai-context-label">Context</span>' + chips.map((chip) => '<span class="ai-context-chip">' + escapeHtml(chip) + '</span>').join('')
    : '';
}

function setActivity(activity: string): void {
  document.querySelectorAll<HTMLButtonElement>('[data-activity]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.activity === activity);
  });
  if (activity === 'explorer') {
    inspectorCollapsed = false;
    layoutState.inspectorCollapsed = false;
    setInspectorTab('explorer');
    setView('overview');
  } else if (activity === 'search') {
    void openSearchModal();
  } else if (activity === 'scm') {
    inspectorCollapsed = false;
    layoutState.inspectorCollapsed = false;
    setInspectorTab('git');
    setView('overview');
  } else if (activity === 'ai') {
    focusComposer();
  } else if (activity === 'agents') {
    setView('asa');
  } else if (activity === 'terminal') {
    setView('terminals');
  } else if (activity === 'extensions') {
    void openAccountsModal();
  } else if (activity === 'settings') {
    openSettingsModal();
  }
  applyLayout();
}

function toggleFocusMode(): void {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const on = !shell?.classList.contains('focus-mode');
  shell?.classList.toggle('focus-mode', on);
  shell?.classList.remove('zen-ai');
  if (on) {
    composerCollapsed = true;
    layoutState.composerCollapsed = true;
    syncComposerVisibility();
  }
}

function toggleZenAi(): void {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const on = !shell?.classList.contains('zen-ai');
  shell?.classList.toggle('zen-ai', on);
  shell?.classList.remove('focus-mode');
  if (on) focusComposer();
}

function editorSelectionText(): string {
  if (codeEditor) {
    const selection = codeEditor.getSelection();
    const model = codeEditor.getModel();
    if (selection && model && !selection.isEmpty()) return model.getValueInRange(selection);
  }
  if (editorContent.selectionStart !== editorContent.selectionEnd) {
    return editorContent.value.slice(editorContent.selectionStart, editorContent.selectionEnd);
  }
  return '';
}

function composerEditorContext(): string {
  const selection = editorSelectionText();
  const monacoSelection = codeEditor?.getSelection();
  const tabs = openFileTabs.map((tab) => tab.path).join(', ');
  const lines: string[] = ['[Editor context — use this to edit the real workspace]'];
  lines.push(openFilePath ? `Active file: ${openFilePath}` : 'No file open.');
  if (tabs) lines.push(`Open tabs: ${tabs}`);
  if (designPicks.length) {
    lines.push('Design Mode selection (screenshots attached as images):');
    for (const [index, pick] of designPicks.slice(0, 8).entries()) {
      lines.push(`${index + 1}. ${pick.kind === 'draw' ? 'Capture' : pick.component || pick.tag}${pick.id ? '#' + pick.id : ''} xpath=${pick.xpath}`);
      lines.push(`   css: ${Object.entries(pick.css).map(([key, value]) => `${key}:${value}`).join('; ')}`);
      if (pick.text) lines.push(`   text: ${pick.text.slice(0, 180)}`);
      if (pick.note) lines.push(`   note: ${pick.note}`);
    }
    lines.push(`Page: ${designPicks[0]?.url ?? ''}`);
  }
  if (selection) {
    const range = monacoSelection && !monacoSelection.isEmpty()
      ? ` L${monacoSelection.startLineNumber}-${monacoSelection.endLineNumber}`
      : '';
    lines.push(`Selection${range}:\n\`\`\`\n${selection.slice(0, 12000)}\n\`\`\``);
  }
  return lines.join('\n');
}

function activePreviewWebviews(): { id: string; webview: Webview }[] {
  return [...browserPanels.values(), ...localhostPanels.values()]
    .filter((panel): panel is (BrowserPanel | LocalhostPanel) & { webview: Webview } => Boolean(panel.webview))
    .map((panel) => ({ id: panel.id, webview: panel.webview }));
}

function designPickerScript(webviewLabel: string): string {
  const port = designBridgePort ?? 0;
  const tool = designTool;
  return `(() => {
    const port = ${port};
    const tool = ${JSON.stringify(tool)};
    const webviewLabel = ${JSON.stringify(webviewLabel)};
    const send = (payload) => {
      try { fetch('http://127.0.0.1:' + port + '/pick', { method: 'POST', mode: 'cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ webviewLabel, dpr: window.devicePixelRatio || 1 }, payload)) }); } catch (e) {}
    };
    const cssKeys = ['display','position','width','height','margin','padding','gap','color','backgroundColor','fontSize','fontWeight','fontFamily','lineHeight','borderRadius','flexDirection','alignItems','justifyContent','gridTemplateColumns'];
    const xpathOf = (node) => {
      const parts = [];
      let current = node;
      while (current && current.nodeType === 1 && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) { if (sibling.tagName === current.tagName) index += 1; sibling = sibling.previousElementSibling; }
        parts.unshift(tag + '[' + index + ']');
        current = current.parentElement;
      }
      return '//' + parts.join('/');
    };
    const fiberName = (el) => {
      const key = Object.keys(el).find((item) => item.startsWith('__reactFiber') || item.startsWith('__reactInternalInstance'));
      if (!key) return null;
      const type = el[key] && el[key].type;
      if (!type) return null;
      return typeof type === 'string' ? type : (type.displayName || type.name || null);
    };
    const describe = (el) => {
      const style = window.getComputedStyle(el);
      const css = {};
      cssKeys.forEach((key) => { css[key] = style[key]; });
      const rect = el.getBoundingClientRect();
      return {
        kind: 'element',
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        className: String(el.className || '').slice(0, 160),
        xpath: xpathOf(el),
        text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 180),
        css,
        component: fiberName(el),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        url: location.href
      };
    };
    const old = document.getElementById('__comesade-design-root');
    if (old) old.remove();
    const root = document.createElement('div');
    root.id = '__comesade-design-root';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:auto;cursor:crosshair;';
    const hover = document.createElement('div');
    hover.style.cssText = 'position:absolute;border:1.5px solid rgba(255,255,255,.35);background:rgba(255,255,255,.06);pointer-events:none;';
    const canvas = document.createElement('canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    root.appendChild(hover);
    root.appendChild(canvas);
    document.documentElement.appendChild(root);
    const targetAt = (x, y) => {
      const hits = document.elementsFromPoint(x, y);
      return hits.find((node) => node && !root.contains(node)) || null;
    };
    const move = (event) => {
      if (drawing) return;
      if (tool !== 'select') { hover.style.display = 'none'; return; }
      const el = targetAt(event.clientX, event.clientY);
      if (!el) { hover.style.display = 'none'; return; }
      const rect = el.getBoundingClientRect();
      hover.style.display = 'block';
      hover.style.left = rect.left + 'px';
      hover.style.top = rect.top + 'px';
      hover.style.width = rect.width + 'px';
      hover.style.height = rect.height + 'px';
    };
    let drawing = false;
    let dragged = false;
    let start = null;
    const ctx = canvas.getContext('2d');
    const down = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      drawing = true;
      dragged = false;
      start = { x: event.clientX, y: event.clientY };
    };
    const drag = (event) => {
      if (!drawing || !ctx || !start) { move(event); return; }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(start.x, start.y, dx, dy);
    };
    const up = (event) => {
      if (!drawing || !start) return;
      event.preventDefault();
      event.stopPropagation();
      drawing = false;
      ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (dragged || tool === 'draw') {
        const x = Math.min(start.x, event.clientX);
        const y = Math.min(start.y, event.clientY);
        const w = Math.abs(event.clientX - start.x);
        const h = Math.abs(event.clientY - start.y);
        if (w >= 8 && h >= 8) {
          send({ kind: 'draw', tag: 'capture', id: '', className: '', xpath: '', text: '', css: {}, component: null, rect: { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }, url: location.href, note: 'Captura de Design Mode' });
          start = null;
          return;
        }
      }
      const el = targetAt(event.clientX, event.clientY);
      if (el) send(describe(el));
      start = null;
    };
    window.addEventListener('pointermove', drag, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.__comesadeDesignOff = () => {
      window.removeEventListener('pointermove', drag, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      root.remove();
    };
  })();`;
}

async function ensureDesignBridge(): Promise<number> {
  if (designBridgePort) return designBridgePort;
  const info = await invoke<{ port: number }>('design_bridge_port');
  designBridgePort = info.port;
  return info.port;
}

function renderComposerCaptures(): void {
  const host = document.querySelector<HTMLElement>('#composer-captures');
  if (!host) return;
  const images = designPicks.filter((pick) => pick.image);
  host.hidden = images.length === 0;
  host.innerHTML = images.map((pick, index) => {
    const source = designPicks.indexOf(pick);
    return `<span class="composer-capture"><img src="${pick.image}" alt="Captura ${index + 1}"><button type="button" data-remove-pick="${source}" aria-label="Quitar captura">×</button></span>`;
  }).join('');
}

function renderDesignToolbar(): void {
  const toggle = document.querySelector<HTMLButtonElement>('#design-mode-toggle');
  const toolbar = document.querySelector<HTMLElement>('#design-toolbar');
  const picks = document.querySelector<HTMLElement>('#design-picks');
  const pill = document.querySelector<HTMLButtonElement>('#titlebar-layout-picker');
  toggle?.classList.toggle('is-active', designModeEnabled);
  pill?.classList.toggle('is-active', designModeEnabled);
  if (toolbar) toolbar.hidden = !designModeEnabled;
  document.querySelectorAll<HTMLButtonElement>('[data-design-tool]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.designTool === designTool);
  });
  if (picks) {
    picks.innerHTML = designPicks.length
      ? designPicks.map((pick, index) => {
          const label = pick.kind === 'draw' ? 'Captura' : (pick.component || pick.tag) + (pick.id ? '#' + pick.id : '');
          const thumb = pick.image ? `<img src="${pick.image}" alt="">` : '';
          return `<span class="design-pick">${thumb}${escapeHtml(label)}<button type="button" data-remove-pick="${index}" aria-label="Quitar">×</button></span>`;
        }).join('')
      : '<small>Arrastra una zona del preview para capturarla</small>';
  }
  renderComposerCaptures();
  renderAiContextBar();
}

async function injectDesignPicker(): Promise<void> {
  const previews = activePreviewWebviews();
  if (!previews.length) return;
  await ensureDesignBridge();
  for (const preview of previews) {
    const script = designModeEnabled
      ? designPickerScript(preview.id)
      : 'try { window.__comesadeDesignOff && window.__comesadeDesignOff(); } catch (e) {}';
    await invoke('webview_eval', { label: preview.id, script }).catch(() => undefined);
  }
}

async function setDesignMode(enabled: boolean): Promise<void> {
  designModeEnabled = enabled;
  if (enabled) {
    layoutState.workLayout = 'design';
    layoutState.view = 'tools';
    composerCollapsed = false;
    layoutState.composerCollapsed = false;
    applyLayout();
    if (localhostPanels.size + browserPanels.size === 0) openLocalhostMenu();
    await ensureDesignBridge();
    await injectDesignPicker();
    showToast(t('toast.designHint'));
  } else {
    await injectDesignPicker();
  }
  renderDesignToolbar();
  scheduleWebviewSync();
}

function toggleDesignMode(): void {
  void setDesignMode(!designModeEnabled);
}

function handleDesignPick(payload: DesignPick): void {
  void completeDesignPick(payload);
}

async function completeDesignPick(payload: DesignPick): Promise<void> {
  if (!designModeEnabled || !payload) return;
  const label = payload.webviewLabel || activePreviewWebviews()[0]?.id;
  if (label && payload.rect && payload.rect.w >= 4 && payload.rect.h >= 4) {
    await invoke('webview_eval', {
      label,
      script: 'try{var r=document.getElementById("__comesade-design-root"); if(r) r.style.visibility="hidden";}catch(e){}',
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      payload.image = await invoke<string>('capture_webview_region', {
        label,
        x: payload.rect.x,
        y: payload.rect.y,
        w: payload.rect.w,
        h: payload.rect.h,
        dpr: payload.dpr || 1,
      });
    } catch (error) {
      showToast(String(error), true);
    }
    await injectDesignPicker();
  }
  if (designTool === 'select' && payload.kind === 'element') {
    designPicks = designPicks.filter((item) => item.kind !== 'element' || item.xpath !== payload.xpath).concat(payload).slice(-8);
  } else {
    designPicks = [...designPicks, payload].slice(-8);
  }
  renderDesignToolbar();
  focusComposer();
}

function sendDesignPicksToChat(): void {
  if (!designPicks.length) {
    showToast(t('toast.needCapture'), true);
    return;
  }
  focusComposer(nativeAgentInput.value.trim() || 'Cambia el UI de esta captura en el codigo real del workspace. ');
}

function startInlineEdit(): void {
  if (!getWorkspace()) {
    showToast(t('toast.needWorkspaceEdit'), true);
    return;
  }
  const selection = editorSelectionText();
  const file = openFilePath ?? 'el workspace';
  const monacoSelection = codeEditor?.getSelection();
  const range = monacoSelection && !monacoSelection.isEmpty()
    ? ` líneas ${monacoSelection.startLineNumber}-${monacoSelection.endLineNumber}`
    : '';
  const prompt = selection
    ? `Edita ${file}${range}. Conserva el resto del archivo y aplica solo este cambio.\n\nSelección:\n\`\`\`\n${selection.slice(0, 8000)}\n\`\`\`\n\nInstrucción: `
    : `Edita ${file}. Aplica el cambio con write_file.\n\nInstrucción: `;
  focusComposer(prompt);
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
  editorFileName.textContent = t('chrome.noFile');
  editorFilePath.textContent = t('chrome.selectFile');
  editorSaveStatus.textContent = t('chrome.clean');
  renderEditorTabs();
  syncDeveloperDockVisibility();
  updateStatusbar();
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
const asaAgentList = document.querySelector<HTMLElement>('#asa-agent-list');
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
const accountMenuRoot = document.querySelector<HTMLDivElement>('#account-menu-root')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const githubAuthGate = document.querySelector<HTMLElement>('#github-auth-gate')!;
const githubAuthConnectButton = document.querySelector<HTMLButtonElement>('#github-auth-connect')!;
const githubAuthCheckButton = document.querySelector<HTMLButtonElement>('#github-auth-check')!;
const githubAuthStatusDot = document.querySelector<HTMLElement>('#github-auth-status-dot')!;
const githubAuthStatusTitle = document.querySelector<HTMLElement>('#github-auth-status-title')!;
const githubAuthStatusDetail = document.querySelector<HTMLElement>('#github-auth-status-detail')!;
const githubAuthDeviceCodePanel = document.querySelector<HTMLElement>('#github-auth-device-code')!;
const githubAuthDeviceCodeValue = document.querySelector<HTMLElement>('#github-auth-device-code-value')!;
const aiAccountsCard = document.querySelector<HTMLButtonElement>('#ai-accounts-card')!;
const aiAccountsLabel = document.querySelector<HTMLElement>('#ai-accounts-label')!;
const aiAccountsStatus = document.querySelector<HTMLElement>('#ai-accounts-status')!;
const aiAccountsDot = document.querySelector<HTMLElement>('#ai-accounts-dot')!;
const nativeAgentLog = document.querySelector<HTMLElement>('#native-agent-log')!;
const nativeAgentProvider = document.querySelector<HTMLSelectElement>('#native-agent-provider')!;
const nativeAgentModel = document.querySelector<HTMLButtonElement>('#native-agent-model')!;
const nativeAgentModelLabel = document.querySelector<HTMLElement>('#native-agent-model-label')!;
const nativeAgentEfforts = document.querySelector<HTMLElement>('#native-agent-efforts')!;
const nativeAgentForm = document.querySelector<HTMLFormElement>('#native-agent-form')!;
const nativeAgentInput = document.querySelector<HTMLTextAreaElement>('#native-agent-input')!;
const nativeAgentSend = document.querySelector<HTMLButtonElement>('#native-agent-send')!;
const nativeAgentCancel = document.querySelector<HTMLButtonElement>('#native-agent-cancel')!;
const nativeAgentStatus = document.querySelector<HTMLElement>('#native-agent-status');
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
const COMESADE_WEB_URL = (import.meta.env.VITE_COMESADE_WEB_URL ?? 'https://usecomes.com/').trim() || 'https://usecomes.com/';
const COMESADE_PLANS_URL = (import.meta.env.VITE_COMESADE_PLANS_URL ?? COMESADE_WEB_URL).trim() || COMESADE_WEB_URL;
const COMESADE_SIGNUP_URL = (import.meta.env.VITE_COMESADE_SIGNUP_URL ?? COMESADE_WEB_URL).trim() || COMESADE_WEB_URL;
const GITHUB_CLIENT_ID = (import.meta.env.VITE_GITHUB_CLIENT_ID ?? 'Ov23likU101MbFvs0gWw').trim();
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
let providerAccounts: ProviderStatus[] = [];
let providerOauthBusy: string | null = null;
let providerKeyForm: string | null = null;
let providerOauthCode: string | null = null;
let nativeAgentMessages: AgentChatMessage[] = [];
let nativeAgentRequestId: string | null = null;
let nativeAgentBusy = false;
let nativeAgentStreamPre: HTMLPreElement | null = null;
let agentTurnStartedAt = 0;
let agentThoughtTimer: number | null = null;
let agentThoughtLine: HTMLDivElement | null = null;
let agentPendingStep: HTMLDivElement | null = null;
let agentTurnGitSnapshot: Record<string, string> = {};
let providerUsage: Record<string, UsageSnapshot> = {};
let selectedAgentChoices: Record<string, { model: string; effort: string }> = {};
let closeModelPickerListeners: (() => void) | null = null;
let closeAccountPickerListeners: (() => void) | null = null;
let closeSttLangPickerListeners: (() => void) | null = null;

type AgentModelOption = {
  id: string;
  label: string;
  hint: string;
  efforts: string[];
  defaultEffort: string;
};

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'xHigh',
  max: 'Max',
  ultra: 'Ultra',
};

const EFFORTS_FULL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORTS_MAX = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_XHIGH = ['low', 'medium', 'high', 'xhigh'];
const EFFORTS_GROK = ['low', 'medium', 'high'];

function agentModel(id: string, label: string, hint: string, efforts: string[] = EFFORTS_FULL, defaultEffort = 'medium'): AgentModelOption {
  return { id, label, hint, efforts, defaultEffort };
}

function modelsForProvider(account: ProviderStatus | undefined): AgentModelOption[] {
  if (!account?.connected) return [];
  const subscription = account.authMode !== 'api_key';
  switch (account.id) {
    case 'openai':
      return subscription
        ? [
            agentModel('gpt-5.6-sol', '5.6 Sol', 'Detalle y razonamiento', EFFORTS_FULL, 'low'),
            agentModel('gpt-5.6-terra', '5.6 Terra', 'Trabajo diario', EFFORTS_FULL, 'medium'),
            agentModel('gpt-5.6-luna', '5.6 Luna', 'Rapido y claro', EFFORTS_FULL, 'medium'),
            agentModel('gpt-5.5', '5.5', 'Familia anterior', EFFORTS_XHIGH, 'medium'),
            agentModel('gpt-5.4', '5.4', 'Hasta el 31 ago', EFFORTS_XHIGH, 'medium'),
            agentModel('gpt-5.4-mini', '5.4 Mini', 'Hasta el 31 ago', EFFORTS_XHIGH, 'medium'),
          ]
        : [
            agentModel('gpt-5.6-sol', '5.6 Sol', 'API', EFFORTS_MAX, 'low'),
            agentModel('gpt-5.6-terra', '5.6 Terra', 'API', EFFORTS_MAX, 'medium'),
            agentModel('gpt-5.6-luna', '5.6 Luna', 'API', EFFORTS_MAX, 'medium'),
            agentModel('gpt-5.4', 'GPT-5.4', 'API', EFFORTS_XHIGH),
            agentModel('gpt-5.4-mini', 'GPT-5.4 Mini', 'API', EFFORTS_XHIGH),
            agentModel('o3', 'o3', 'Razonamiento', EFFORTS_XHIGH, 'high'),
            agentModel('o4-mini', 'o4-mini', 'Razonamiento rapido', EFFORTS_XHIGH),
            agentModel('gpt-4.1', 'GPT-4.1', 'Sin variantes', []),
            agentModel('gpt-4.1-mini', 'GPT-4.1 Mini', 'Sin variantes', []),
            agentModel('gpt-4o', 'GPT-4o', 'Sin variantes', []),
            agentModel('gpt-4o-mini', 'GPT-4o Mini', 'Sin variantes', []),
          ];
    case 'xai':
      return [
        agentModel('grok-4.6', 'Grok 4.6', 'Actual', EFFORTS_GROK, 'high'),
        agentModel('grok-4', 'Grok 4', 'Anterior', EFFORTS_GROK, 'high'),
        agentModel('grok-4-fast', 'Grok 4 Fast', 'Velocidad', EFFORTS_GROK, 'low'),
        agentModel('grok-3', 'Grok 3', 'Estable', EFFORTS_GROK),
        agentModel('grok-3-mini', 'Grok 3 Mini', 'Ligero', EFFORTS_GROK, 'low'),
        agentModel('grok-3-fast', 'Grok 3 Fast', 'Rapido', ['low', 'medium']),
        agentModel('grok-2', 'Grok 2', 'Clasico', []),
      ];
    case 'anthropic':
      return [
        agentModel('claude-opus-4-6', 'Opus 4.6', 'Maxima capacidad', EFFORTS_MAX, 'high'),
        agentModel('claude-sonnet-4-6', 'Sonnet 4.6', 'Equilibrio nuevo', EFFORTS_MAX),
        agentModel('claude-opus-4-5', 'Opus 4.5', 'Opus anterior', EFFORTS_MAX, 'high'),
        agentModel('claude-sonnet-4-5', 'Sonnet 4.5', 'Trabajo diario', EFFORTS_MAX),
        agentModel('claude-haiku-4-5', 'Haiku 4.5', 'Rapido', ['low', 'medium', 'high'], 'low'),
        agentModel('claude-sonnet-4-0', 'Sonnet 4', 'Estable', EFFORTS_XHIGH),
        agentModel('claude-3-7-sonnet-latest', 'Sonnet 3.7', 'Thinking clasico', EFFORTS_XHIGH),
        agentModel('claude-3-5-haiku-latest', 'Haiku 3.5', 'Ligero', ['low', 'medium']),
      ];
    case 'gemini':
      return [
        agentModel('gemini-3.7-flash', '3.7 Flash', 'Actual rapido', EFFORTS_FULL, 'low'),
        agentModel('gemini-3.6-flash', '3.6 Flash', 'Rapido', EFFORTS_FULL, 'low'),
        agentModel('gemini-3.5-flash', '3.5 Flash', 'Estable', EFFORTS_FULL),
        agentModel('gemini-3.1-pro', '3.1 Pro', 'Pro', EFFORTS_FULL, 'high'),
        agentModel('gemini-3-flash', '3 Flash', 'Flash', EFFORTS_FULL, 'low'),
        agentModel('gemini-2.5-pro', '2.5 Pro', 'Pro anterior', EFFORTS_FULL, 'high'),
        agentModel('gemini-2.5-flash', '2.5 Flash', 'Flash anterior', EFFORTS_FULL, 'low'),
        agentModel('gemini-2.5-flash-lite', '2.5 Flash Lite', 'Minimo', ['low', 'medium'], 'low'),
        agentModel('gemini-2.0-flash', '2.0 Flash', 'Legacy', []),
      ];
    case 'deepseek':
      return [
        agentModel('deepseek-chat', 'DeepSeek Chat', 'General', []),
        agentModel('deepseek-reasoner', 'DeepSeek Reasoner', 'Razonamiento interno', []),
      ];
    case 'glm':
      return [
        agentModel('glm-5', 'GLM 5', 'Actual', ['low', 'medium', 'high']),
        agentModel('glm-4.6', 'GLM 4.6', 'Anterior', ['low', 'medium', 'high']),
        agentModel('glm-4.5', 'GLM 4.5', 'Estable', []),
        agentModel('glm-4-plus', 'GLM 4 Plus', 'Plus', []),
        agentModel('glm-4-flash', 'GLM 4 Flash', 'Rapido', []),
      ];
    case 'kimi':
      return [
        agentModel('kimi-k2.5', 'Kimi K2.5', 'Actual', ['low', 'medium', 'high']),
        agentModel('kimi-k2-turbo-preview', 'Kimi K2 Turbo', 'Rapido', ['low', 'medium', 'high'], 'low'),
        agentModel('moonshot-v1-128k', 'Moonshot 128k', 'Contexto largo', []),
        agentModel('moonshot-v1-32k', 'Moonshot 32k', 'Estandar', []),
      ];
    case 'qwen':
      return [
        agentModel('qwen-max', 'Qwen Max', 'Maxima capacidad', ['low', 'medium', 'high'], 'high'),
        agentModel('qwen-plus', 'Qwen Plus', 'Equilibrio', ['low', 'medium', 'high']),
        agentModel('qwen-turbo', 'Qwen Turbo', 'Rapido', []),
        agentModel('qwen3-coder-plus', 'Qwen3 Coder Plus', 'Codigo', ['low', 'medium', 'high']),
        agentModel('qwen-long', 'Qwen Long', 'Contexto largo', []),
      ];
    case 'openrouter':
      return [
        agentModel('openrouter/auto', 'Auto', 'Elige proveedor', EFFORTS_FULL),
        agentModel('openai/gpt-5.6-sol', 'GPT-5.6 Sol', 'OpenAI', EFFORTS_FULL, 'low'),
        agentModel('openai/gpt-5.6-terra', 'GPT-5.6 Terra', 'OpenAI', EFFORTS_FULL),
        agentModel('anthropic/claude-sonnet-4.5', 'Sonnet 4.5', 'Claude', EFFORTS_MAX),
        agentModel('anthropic/claude-opus-4.6', 'Opus 4.6', 'Claude', EFFORTS_MAX, 'high'),
        agentModel('google/gemini-2.5-pro', 'Gemini 2.5 Pro', 'Google', EFFORTS_FULL, 'high'),
        agentModel('x-ai/grok-4', 'Grok 4', 'xAI', EFFORTS_GROK, 'high'),
        agentModel('deepseek/deepseek-chat', 'DeepSeek Chat', 'DeepSeek', []),
      ];
    case 'github':
      return [
        agentModel('openai/gpt-4.1', 'GPT-4.1', 'GitHub Models', []),
        agentModel('openai/gpt-4o', 'GPT-4o', 'GitHub Models', []),
        agentModel('openai/o3', 'o3', 'Razonamiento', EFFORTS_XHIGH, 'high'),
        agentModel('openai/o4-mini', 'o4-mini', 'Rapido', EFFORTS_XHIGH, 'low'),
        agentModel('microsoft/phi-4', 'Phi-4', 'Microsoft', []),
      ];
    case 'cursor':
      return [
        agentModel('auto', 'Auto', 'El agente elige', []),
        agentModel('gpt-5.6-sol', '5.6 Sol', 'ChatGPT', EFFORTS_FULL, 'low'),
        agentModel('gpt-5.6-terra', '5.6 Terra', 'ChatGPT', EFFORTS_FULL),
        agentModel('gpt-5.6-luna', '5.6 Luna', 'ChatGPT', EFFORTS_FULL),
        agentModel('claude-opus-4-6', 'Opus 4.6', 'Claude', EFFORTS_MAX, 'high'),
        agentModel('claude-sonnet-4-5', 'Sonnet 4.5', 'Claude', EFFORTS_MAX),
        agentModel('gemini-3.1-pro', 'Gemini 3.1 Pro', 'Google', EFFORTS_FULL, 'high'),
        agentModel('grok-4.6', 'Grok 4.6', 'xAI', EFFORTS_GROK, 'high'),
      ];
    case 'droid':
    case 'aider':
    case 'kilo':
    case 'pi':
    case 'opencode':
    case 'antigravity':
      return [
        agentModel('auto', 'Auto', 'El agente elige', []),
        agentModel('gpt-5.6-sol', '5.6 Sol', 'ChatGPT', []),
        agentModel('gpt-5.6-terra', '5.6 Terra', 'ChatGPT', []),
        agentModel('gpt-5.6-luna', '5.6 Luna', 'ChatGPT', []),
        agentModel('claude-sonnet-4-5', 'Sonnet 4.5', 'Claude', []),
        agentModel('gemini-2.5-pro', 'Gemini 2.5 Pro', 'Google', []),
        agentModel('grok-4.6', 'Grok 4.6', 'xAI', []),
      ];
    default:
      return [];
  }
}

function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

function selectedModelChoice(account: ProviderStatus | undefined): { option: AgentModelOption; effort: string } | null {
  const models = modelsForProvider(account);
  if (!models.length || !account) return null;
  const stored = selectedAgentChoices[account.id];
  const option = models.find((model) => model.id === stored?.model) ?? models[0];
  const effort = option.efforts.includes(stored?.effort ?? '')
    ? stored!.effort
    : (option.defaultEffort || option.efforts[0] || 'medium');
  if (!stored || stored.model !== option.id || stored.effort !== effort) {
    selectedAgentChoices[account.id] = { model: option.id, effort };
    persistSelectedAgentModels();
  }
  return { option, effort };
}

function persistSelectedAgentModels(): void {
  setStoredValue(storageKeys.agentModels, JSON.stringify(selectedAgentChoices));
}

function setSelectedChoice(provider: string, model: string, effort: string, keepPicker = false): void {
  selectedAgentChoices[provider] = { model, effort };
  persistSelectedAgentModels();
  renderComposerModel();
  if (keepPicker) openModelPicker();
}

function loadSelectedAgentModels(): void {
  const stored = readJson<Record<string, unknown>>(storageKeys.agentModels, {});
  const next: Record<string, { model: string; effort: string }> = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [provider, value] of Object.entries(stored)) {
      if (typeof value === 'string') {
        next[provider] = { model: value, effort: 'medium' };
      } else if (value && typeof value === 'object' && typeof (value as { model?: unknown }).model === 'string') {
        const row = value as { model: string; effort?: unknown };
        next[provider] = { model: row.model, effort: typeof row.effort === 'string' ? row.effort : 'medium' };
      }
    }
  }
  selectedAgentChoices = next;
}

function renderComposerModel(): void {
  const account = providerAccounts.find((item) => item.id === nativeAgentProvider.value && item.connected);
  const selected = selectedModelChoice(account);
  closeModelPicker();
  if (!selected) {
    nativeAgentModel.hidden = true;
    nativeAgentEfforts.hidden = true;
    nativeAgentEfforts.innerHTML = '';
    nativeAgentModelLabel.textContent = 'Modelo';
    nativeAgentModel.title = 'Conecta una cuenta para elegir modelo';
    syncComposerPlaceholder();
    return;
  }
  nativeAgentModel.hidden = false;
  const variant = selected.option.efforts.length ? ` · ${effortLabel(selected.effort)}` : '';
  nativeAgentModelLabel.textContent = `${selected.option.label}${variant}`;
  nativeAgentModel.title = selected.option.efforts.length
    ? `Modelo ${selected.option.label}, variante ${effortLabel(selected.effort)}. Se envía al proveedor.`
    : `Modelo: ${selected.option.label}.`;
  nativeAgentModel.setAttribute('aria-label', nativeAgentModel.title);
  nativeAgentModel.dataset.model = selected.option.id;
  nativeAgentModel.dataset.effort = selected.option.efforts.length ? selected.effort : '';
  syncComposerPlaceholder();
  if (!selected.option.efforts.length) {
    nativeAgentEfforts.hidden = true;
    nativeAgentEfforts.innerHTML = '';
    return;
  }
  nativeAgentEfforts.hidden = false;
  nativeAgentEfforts.innerHTML = selected.option.efforts.map((effort) => {
    const current = effort === selected.effort;
    return `<button type="button" class="model-effort-chip${current ? ' is-selected' : ''}" data-effort="${escapeHtml(effort)}" title="${escapeHtml(effortLabel(effort))}" aria-pressed="${current ? 'true' : 'false'}">${escapeHtml(effortLabel(effort))}</button>`;
  }).join('');
}

function renderComposerAccount(): void {
  const button = document.querySelector<HTMLButtonElement>('#composer-account');
  const label = document.querySelector('#composer-account-label');
  if (!button || !label) return;
  const account = providerAccounts.find((item) => item.id === nativeAgentProvider.value && item.connected);
  button.classList.toggle('is-connected', Boolean(account));
  if (!account) {
    label.textContent = t('chrome.accountSelect');
    button.title = t('chrome.connectAccountHint');
    return;
  }
  label.textContent = account.name;
  button.title = account.accountLabel ? `${account.name} · ${account.accountLabel}` : account.name;
}

function closeAccountPicker(): void {
  document.querySelector<HTMLElement>('.account-picker-menu')?.remove();
  document.querySelector('#composer-account')?.setAttribute('aria-expanded', 'false');
  closeAccountPickerListeners?.();
  closeAccountPickerListeners = null;
}

function sttLanguageLabel(id: string): string {
  if (id === 'auto') return t('lang.autoShort');
  return STT_LANGUAGES.find((item) => item.id === id)?.label ?? id;
}

function syncSttLangButton(): void {
  const select = document.querySelector<HTMLSelectElement>('#composer-stt-lang');
  const label = document.querySelector('#composer-stt-lang-label');
  if (!select || !label) return;
  label.textContent = sttLanguageLabel(select.value || 'auto');
}

function closeSttLangPicker(): void {
  document.querySelector<HTMLElement>('.stt-lang-menu')?.remove();
  document.querySelector('#composer-stt-lang-button')?.setAttribute('aria-expanded', 'false');
  closeSttLangPickerListeners?.();
  closeSttLangPickerListeners = null;
}

function openSttLangPicker(): void {
  const button = document.querySelector<HTMLButtonElement>('#composer-stt-lang-button');
  const select = document.querySelector<HTMLSelectElement>('#composer-stt-lang');
  if (!button || !select) return;
  closeModelPicker();
  closeAccountPicker();
  closeSttLangPicker();
  const selected = select.value || 'auto';
  const menu = document.createElement('div');
  menu.className = 'file-context-menu stt-lang-menu';
  menu.innerHTML = `
    <div class="stt-lang-menu-head">
      <strong>${escapeHtml(t('chrome.sttLang'))}</strong>
      <input class="stt-lang-search" type="search" placeholder="${escapeHtml(t('chrome.searchLang'))}" autocomplete="off" />
    </div>
    <div class="stt-lang-menu-list" role="listbox">${STT_LANGUAGES.map((item) => {
      const current = item.id === selected;
      return `<button type="button" class="stt-lang-item${current ? ' is-selected' : ''}" data-lang="${escapeHtml(item.id)}" role="option" aria-selected="${current ? 'true' : 'false'}"><span>${escapeHtml(sttLanguageLabel(item.id))}</span>${current ? `<em>${escapeHtml(t('chrome.currentLang'))}</em>` : ''}</button>`;
    }).join('')}</div>`;
  document.body.appendChild(menu);
  const rect = button.getBoundingClientRect();
  const width = 280;
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
  menu.style.top = `${rect.top - 8 - menu.offsetHeight}px`;
  if (menu.getBoundingClientRect().top < 8) {
    menu.style.top = `${rect.bottom + 8}px`;
  }
  button.setAttribute('aria-expanded', 'true');
  const search = menu.querySelector<HTMLInputElement>('.stt-lang-search');
  const list = menu.querySelector('.stt-lang-menu-list');
  const filter = (): void => {
    const query = search?.value.trim().toLowerCase() ?? '';
    menu.querySelectorAll<HTMLButtonElement>('.stt-lang-item').forEach((item) => {
      const id = item.dataset.lang ?? '';
      const label = sttLanguageLabel(id).toLowerCase();
      item.hidden = Boolean(query) && !label.includes(query) && !id.includes(query);
    });
  };
  search?.addEventListener('input', filter);
  const outside = (event: PointerEvent): void => {
    if (menu.contains(event.target as Node) || button.contains(event.target as Node)) return;
    closeSttLangPicker();
  };
  document.addEventListener('pointerdown', outside);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeSttLangPicker();
  };
  document.addEventListener('keydown', onKey);
  closeSttLangPickerListeners = () => {
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', onKey);
  };
  menu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.stt-lang-item');
    if (!target?.dataset.lang) return;
    select.value = target.dataset.lang;
    select.dispatchEvent(new Event('change'));
    syncSttLangButton();
    closeSttLangPicker();
  });
  search?.focus();
  list?.querySelector<HTMLButtonElement>('.is-selected')?.scrollIntoView({ block: 'nearest' });
}

function openAccountPicker(): void {
  const button = document.querySelector<HTMLButtonElement>('#composer-account');
  if (!button) return;
  const connected = providerAccounts.filter((account) => account.connected);
  closeModelPicker();
  closeAccountPicker();
  closeSttLangPicker();
  if (!connected.length) {
    void openAccountsModal();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'file-context-menu account-picker-menu';
  menu.setAttribute('role', 'listbox');
  menu.innerHTML = [
    ...connected.map((account) => {
      const current = account.id === nativeAgentProvider.value;
      const detail = account.accountLabel || account.authMode || 'Conectada';
      return `<button type="button" class="account-picker-item${current ? ' is-selected' : ''}" data-account-id="${escapeHtml(account.id)}" role="option" aria-selected="${current ? 'true' : 'false'}"><span><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(detail)}</small></span>${current ? '<em>ACTUAL</em>' : ''}</button>`;
    }),
    '<button type="button" class="account-picker-item account-picker-manage" data-manage-accounts="1"><span><strong>Administrar cuentas</strong><small>Conectar o desconectar proveedores</small></span></button>',
  ].join('');
  document.body.appendChild(menu);
  const rect = button.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 300))}px`;
  menu.style.top = `${rect.top - 8 - menu.offsetHeight}px`;
  if (menu.getBoundingClientRect().top < 8) {
    menu.style.top = `${rect.bottom + 8}px`;
  }
  button.setAttribute('aria-expanded', 'true');
  const outside = (event: PointerEvent): void => {
    if (menu.contains(event.target as Node) || button.contains(event.target as Node)) return;
    closeAccountPicker();
  };
  document.addEventListener('pointerdown', outside);
  closeAccountPickerListeners = () => {
    document.removeEventListener('pointerdown', outside);
  };
  menu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-account-id], [data-manage-accounts]');
    if (!target) return;
    if (target.dataset.manageAccounts) {
      closeAccountPicker();
      void openAccountsModal();
      return;
    }
    const id = target.dataset.accountId;
    if (!id) return;
    nativeAgentProvider.value = id;
    nativeAgentProvider.dispatchEvent(new Event('change'));
    closeAccountPicker();
  });
}

function closeModelPicker(): void {
  document.querySelector<HTMLElement>('.model-picker-menu')?.remove();
  nativeAgentModel.setAttribute('aria-expanded', 'false');
  closeModelPickerListeners?.();
  closeModelPickerListeners = null;
}

function openModelPicker(): void {
  const account = providerAccounts.find((item) => item.id === nativeAgentProvider.value && item.connected);
  const models = modelsForProvider(account);
  const selected = selectedModelChoice(account);
  if (!account || !models.length || !selected) return;
  closeAccountPicker();
  closeSttLangPicker();
  closeModelPicker();
  const menu = document.createElement('div');
  menu.className = 'file-context-menu model-picker-menu';
  menu.setAttribute('role', 'listbox');
  menu.innerHTML = models.map((model) => {
    const currentModel = model.id === selected.option.id;
    const effortRow = model.efforts.length
      ? `<div class="model-effort-row">${model.efforts.map((effort) => {
          const current = currentModel && effort === selected.effort;
          return `<button type="button" class="model-effort-chip${current ? ' is-selected' : ''}" data-model-id="${escapeHtml(model.id)}" data-effort="${escapeHtml(effort)}" aria-pressed="${current ? 'true' : 'false'}">${escapeHtml(effortLabel(effort))}</button>`;
        }).join('')}</div>`
      : '';
    return `<div class="model-picker-group${currentModel ? ' is-selected' : ''}"><button type="button" class="model-picker-name${currentModel ? ' is-selected' : ''}" data-model-id="${escapeHtml(model.id)}" data-select-model="1" role="option" aria-selected="${currentModel ? 'true' : 'false'}"><span><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.hint)}${currentModel && model.efforts.length ? ` · ${effortLabel(selected.effort)}` : ''}</small></span>${currentModel ? '<em>ACTUAL</em>' : ''}</button>${effortRow}</div>`;
  }).join('');
  document.body.appendChild(menu);
  const rect = nativeAgentModel.getBoundingClientRect();
  const maxHeight = Math.max(200, Math.min(360, rect.top - 24));
  menu.style.maxHeight = `${maxHeight}px`;
  const width = Math.min(320, window.innerWidth - 24);
  menu.style.width = `${width}px`;
  const height = Math.min(menu.scrollHeight, maxHeight);
  menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  menu.style.top = `${Math.max(12, rect.top - height - 8)}px`;
  nativeAgentModel.setAttribute('aria-expanded', 'true');
  const outside = (event: PointerEvent): void => {
    if (menu.contains(event.target as Node) || nativeAgentModel.contains(event.target as Node)) return;
    closeModelPicker();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeModelPicker();
  };
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', onKey);
  closeModelPickerListeners = () => {
    document.removeEventListener('pointerdown', outside);
    document.removeEventListener('keydown', onKey);
  };
  menu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-model-id]');
    const id = target?.dataset.modelId;
    if (!id) return;
    const model = models.find((item) => item.id === id);
    const chip = target?.classList.contains('model-effort-chip');
    const clickedEffort = target?.dataset.effort;
    const effort = chip && clickedEffort && model?.efforts.includes(clickedEffort)
      ? clickedEffort
      : (selected.option.id === id
        ? selected.effort
        : (model?.defaultEffort || model?.efforts[0] || selected.effort));
    setSelectedChoice(account.id, id, effort, Boolean(chip));
  });
}

// El consumo lo reporta el proveedor; aqui solo se formatea lo que llega.
function formatResetIn(resetsAt: number | null): string | null {
  if (!resetsAt) return null;
  const seconds = resetsAt - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return 'ya disponible';
  if (seconds < 60) return `en ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `en ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `en ${hours} h ${rest} min` : `en ${hours} h`;
  return `en ${Math.round(hours / 24)} d`;
}

function usageWindowLabel(window: UsageWindow): string {
  if (typeof window.usedPercent === 'number') {
    return `${window.label} ${Math.round(window.usedPercent)}%`;
  }
  if (typeof window.remaining === 'number' && typeof window.limit === 'number') {
    return `${window.label} ${window.remaining}/${window.limit}`;
  }
  return window.label;
}

function renderComposerUsage(): void {
  const button = document.querySelector<HTMLButtonElement>('#composer-usage');
  if (!button) return;
  const snapshot = providerUsage[nativeAgentProvider.value];
  if (!snapshot || !snapshot.windows.length) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.textContent = snapshot.windows.map(usageWindowLabel).join(' · ');
  button.classList.toggle('is-exhausted', snapshot.exhausted);
  const reset = snapshot.windows.map((window) => formatResetIn(window.resetsAt)).find(Boolean);
  button.title = reset
    ? `Consumo de tu plan de ${snapshot.providerName}. Se renueva ${reset}.`
    : `Consumo de tu plan de ${snapshot.providerName}.`;
}

/// Cuando el plan se agota, avisar con el tiempo de reset y proponer otra
/// cuenta conectada en vez de bloquear el envio.
function warnUsageExhausted(snapshot: UsageSnapshot): void {
  const reset = snapshot.windows.map((window) => formatResetIn(window.resetsAt)).find(Boolean)
    ?? (typeof snapshot.retryAfter === 'number' ? formatResetIn(Math.floor(Date.now() / 1000) + snapshot.retryAfter) : null);
  const alternative = providerAccounts.find(
    (account) => account.connected && account.id !== snapshot.provider && !providerUsage[account.id]?.exhausted,
  );
  const parts = [t('toast.usageExhausted', { provider: snapshot.providerName })];
  if (reset) parts.push(t('toast.usageRenews', { when: reset }));
  if (alternative) parts.push(t('toast.usageContinueWith', { name: alternative.name }));
  showToast(`${parts.join('; ')}.`, true);
}

function applyUsageSnapshot(snapshot: UsageSnapshot, notify = true): void {
  const previous = providerUsage[snapshot.provider];
  providerUsage[snapshot.provider] = snapshot;
  renderComposerUsage();
  if (document.getElementById('accounts-modal')) renderAccountsModalBody();
  setStoredValue(storageKeys.providerUsage, JSON.stringify(Object.values(providerUsage)));
  if (notify && snapshot.exhausted && !previous?.exhausted) warnUsageExhausted(snapshot);
}

async function loadProviderUsage(): Promise<void> {
  const stored = readJson<UsageSnapshot[]>(storageKeys.providerUsage, []);
  if (stored.length) {
    await invoke('provider_usage_restore', { snapshots: stored }).catch(() => undefined);
  }
  try {
    const live = await invoke<UsageSnapshot[]>('provider_usage');
    providerUsage = Object.fromEntries(live.map((snapshot) => [snapshot.provider, snapshot]));
  } catch {
    providerUsage = Object.fromEntries(stored.map((snapshot) => [snapshot.provider, snapshot]));
  }
  renderComposerUsage();
}

function hasConnectedAccount(): boolean {
  return githubAuth.connected || providerAccounts.some((account) => account.connected);
}

type ComesSession = {
  token: string;
  email: string | null;
  subscriptionActive: boolean;
  status: string | null;
  plan: string | null;
  lastPaymentAt: string | null;
  checkedAt: number;
};

let comesSession: ComesSession | null = null;
let speechQuota: SpeechQuotaView | null = null;
let messageQuota: MessageQuotaView | null = null;
let comesAuthEmailDraft = '';

function hasActiveSubscription(): boolean {
  return Boolean(comesSession?.token && comesSession.subscriptionActive);
}

function comesAccountInitial(): string {
  const email = comesSession?.email?.trim() ?? '';
  return (email.charAt(0) || 'C').toUpperCase();
}

function comesPlanLabel(): string {
  if (!comesSession?.token) return 'Signed out';
  if (!comesSession.subscriptionActive) return 'No plan';
  if (comesSession.plan?.trim()) return comesSession.plan.trim();
  const status = comesSession.status?.trim();
  if (status && !['active', 'trialing', 'trial'].includes(status.toLowerCase())) return status;
  return 'Pro';
}

function saveComesSession(): void {
  if (!comesSession) {
    try {
      window.localStorage.removeItem(storageKeys.comesSession);
    } catch {
      // ignore
    }
    if (nativePersistenceReady) {
      void invoke('save_local_state', { key: storageKeys.comesSession, value: '' }).catch(() => undefined);
    }
    renderTitlebarAccount();
    return;
  }
  setStoredValue(storageKeys.comesSession, JSON.stringify(comesSession));
  renderTitlebarAccount();
}

function loadComesSession(): void {
  const stored = readJson<Partial<ComesSession> | null>(storageKeys.comesSession, null);
  if (!stored || typeof stored.token !== 'string' || !stored.token.trim()) {
    comesSession = null;
    renderTitlebarAccount();
    return;
  }
  comesSession = {
    token: stored.token.trim(),
    email: typeof stored.email === 'string' ? stored.email : null,
    subscriptionActive: stored.subscriptionActive === true,
    status: typeof stored.status === 'string' ? stored.status : null,
    plan: typeof stored.plan === 'string' ? stored.plan : null,
    lastPaymentAt: typeof stored.lastPaymentAt === 'string' ? stored.lastPaymentAt : null,
    checkedAt: typeof stored.checkedAt === 'number' ? stored.checkedAt : 0,
  };
  renderTitlebarAccount();
}

function readApiError(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const record = data as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (message) return message;
  const error = typeof record.error === 'string' ? record.error.trim() : '';
  if (error && !/^[a-z0-9_]+$/.test(error)) return error;
  const detail = typeof record.detail === 'string' ? record.detail.trim() : '';
  if (detail) return detail;
  return fallback;
}

function extractSessionToken(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  for (const key of ['token', 'access_token', 'session_token', 'sessionToken']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const nestedKey of ['session', 'auth', 'user']) {
    const nested = record[nestedKey];
    const token = extractSessionToken(nested);
    if (token) return token;
  }
  return null;
}

function extractAccountEmail(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (typeof record.email === 'string' && record.email.includes('@')) return record.email.trim();
  for (const nestedKey of ['user', 'account', 'customer', 'profile']) {
    const nested = extractAccountEmail(record[nestedKey]);
    if (nested) return nested;
  }
  return null;
}

function subscriptionIsActive(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record.has_access === true || record.active === true || record.subscribed === true || record.has_subscription === true) {
    return true;
  }
  const nested = record.subscription;
  if (nested && typeof nested === 'object') {
    const sub = nested as Record<string, unknown>;
    if (sub.active === true) return true;
    const nestedStatus = String(sub.status ?? '').toLowerCase();
    if (['active', 'trialing', 'trial'].includes(nestedStatus)) return true;
  }
  const status = String(record.status ?? record.subscription_status ?? record.plan_status ?? '').toLowerCase();
  return ['active', 'trialing', 'trial'].includes(status);
}

function extractSubscriptionStatus(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const nested = record.subscription && typeof record.subscription === 'object'
    ? (record.subscription as Record<string, unknown>).status
    : null;
  const value = record.status ?? record.subscription_status ?? nested;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractPlanLabel(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const nested = record.subscription && typeof record.subscription === 'object'
    ? record.subscription as Record<string, unknown>
    : null;
  const value = record.plan_name ?? record.planName ?? record.product_name ?? record.price_name ?? record.plan
    ?? record.plan_type ?? nested?.plan_name ?? nested?.planName ?? nested?.product_name ?? nested?.plan
    ?? nested?.plan_type ?? nested?.product_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractLastPaymentAt(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const nested = record.subscription && typeof record.subscription === 'object'
    ? record.subscription as Record<string, unknown>
    : null;
  const lastPayment = record.last_payment ?? record.lastPayment ?? nested?.last_payment ?? nested?.lastPayment;
  if (typeof lastPayment === 'string' && lastPayment.trim()) return lastPayment.trim();
  if (lastPayment && typeof lastPayment === 'object') {
    const stamp = (lastPayment as Record<string, unknown>).at
      ?? (lastPayment as Record<string, unknown>).time
      ?? (lastPayment as Record<string, unknown>).date
      ?? (lastPayment as Record<string, unknown>).paid_at;
    if (typeof stamp === 'string' && stamp.trim()) return stamp.trim();
  }
  const value = record.last_payment_at ?? record.lastPaymentAt ?? nested?.last_payment_at ?? nested?.lastPaymentAt;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function speechPeriodKey(): string {
  return comesSession?.lastPaymentAt?.trim() || 'unpaid';
}

function renderSpeechQuota(): void {
  const chip = document.querySelector<HTMLElement>('#composer-speech-quota');
  const mic = document.querySelector<HTMLButtonElement>('#composer-mic');
  const tts = document.querySelector<HTMLButtonElement>('#composer-tts');
  if (!chip) return;
  const unlimited = isUnlimitedSpeechQuota(speechQuota, comesSession?.email);
  if (unlimited) {
    chip.hidden = false;
    chip.textContent = 'Voz ∞';
    chip.title = 'Plan ADMIN: dictado en la nube de ComesADE ilimitado.';
    if (mic) mic.disabled = false;
    if (tts) tts.disabled = false;
    return;
  }
  if (!speechQuota || (speechQuota.limit ?? 0) <= 0) {
    chip.hidden = !comesSession?.token;
    chip.textContent = comesSession?.token ? 'Voz 0' : 'Voz';
    if (mic) mic.disabled = true;
    if (tts) tts.disabled = true;
    return;
  }
  chip.hidden = false;
  chip.textContent = `Voz ${speechQuota.remaining}/${speechQuota.limit}`;
  chip.title = `Dictado en la nube de ComesADE. 1 palabra = 1 token. Se reinicia al pagar (${speechQuota.plan}).`;
  const blocked = (speechQuota.remaining ?? 0) < 1;
  if (mic) mic.disabled = blocked;
  if (tts) tts.disabled = blocked;
}

async function refreshSpeechQuota(): Promise<void> {
  const email = comesSession?.email?.trim() ?? '';
  if (!email || !comesSession?.subscriptionActive) {
    speechQuota = email
      ? localSpeechQuota(email, comesSession?.plan ?? null, false, speechPeriodKey())
      : null;
    renderSpeechQuota();
    return;
  }
  try {
    const result = await comesApi('GET', '/v1/speech/quota', { token: comesSession.token });
    const remote = result.ok ? parseSpeechQuotaResponse(result.data) : null;
    if (remote) {
      speechQuota = remote;
    } else if (result.status === 402 || (result.status === 404 && result.data && typeof result.data === 'object' && (result.data as Record<string, unknown>).error === 'speech_no_subscription')) {
      speechQuota = localSpeechQuota(email, comesSession.plan, false, speechPeriodKey());
    } else {
      speechQuota = localSpeechQuota(email, comesSession.plan, comesSession.subscriptionActive, speechPeriodKey());
    }
  } catch {
    speechQuota = localSpeechQuota(email, comesSession.plan, comesSession.subscriptionActive, speechPeriodKey());
  }
  renderSpeechQuota();
}

function renderMessageQuota(): void {
  const chip = document.querySelector<HTMLElement>('#composer-message-quota');
  if (!chip) return;
  const unlimited = isUnlimitedMessageQuota(messageQuota, comesSession?.email);
  if (unlimited) {
    chip.hidden = false;
    chip.textContent = 'Msgs ∞';
    chip.title = 'Plan ADMIN: mensajes al agente ilimitados.';
    return;
  }
  if (!messageQuota || (messageQuota.limit ?? 0) <= 0) {
    chip.hidden = !comesSession?.token;
    chip.textContent = comesSession?.token ? 'Msgs 0' : 'Msgs';
    chip.title = 'Necesitas un plan Starter, Pro o Advanced para enviar mensajes.';
    return;
  }
  chip.hidden = false;
  chip.textContent = `Msgs ${messageQuota.remaining}/${messageQuota.limit}`;
  chip.title = `Mensajes enviados esta semana (${messageQuota.plan}): Starter 1.000, Pro 30.000, Advanced 100.000. Se reinicia el lunes.`;
}

async function refreshMessageQuota(): Promise<void> {
  const email = comesSession?.email?.trim() ?? '';
  if (!email || !comesSession?.subscriptionActive) {
    messageQuota = email
      ? localMessageQuota(email, comesSession?.plan ?? null, false)
      : null;
    renderMessageQuota();
    return;
  }
  try {
    const result = await comesApi('GET', '/v1/messages/quota', { token: comesSession.token });
    const remote = result.ok ? parseMessageQuotaResponse(result.data) : null;
    if (remote) {
      messageQuota = remote;
    } else {
      messageQuota = localMessageQuota(email, comesSession.plan, comesSession.subscriptionActive);
    }
  } catch {
    messageQuota = localMessageQuota(email, comesSession.plan, comesSession.subscriptionActive);
  }
  renderMessageQuota();
}

async function consumeAgentRequest(): Promise<boolean> {
  const email = comesSession?.email?.trim() ?? '';
  if (!email || !comesSession?.token) {
    showToast(t('toast.needSignInMessages'), true);
    return false;
  }
  if (isUnlimitedMessageQuota(messageQuota, email)) return true;
  if (messageQuota && (messageQuota.remaining ?? 0) < 1) {
    showToast(t('toast.messagesExhaustedPlan', { plan: messageQuota.plan }), true);
    return false;
  }
  try {
    const result = await comesApi('POST', '/v1/messages/consume', {
      token: comesSession.token,
      body: { count: 1 },
    });
    if (result.ok) {
      messageQuota = parseMessageQuotaResponse(result.data) ?? messageQuota;
      renderMessageQuota();
      return true;
    }
    const message = result.data && typeof result.data === 'object'
      ? String((result.data as Record<string, unknown>).message ?? '')
      : '';
    if (result.status === 402) {
      const remote = parseMessageQuotaResponse(
        result.data && typeof result.data === 'object'
          ? (result.data as Record<string, unknown>).quota ?? result.data
          : result.data,
      );
      if (remote) {
        messageQuota = remote;
        renderMessageQuota();
      }
      showToast(message || t('toast.messagesExhausted'), true);
      return false;
    }
    if (result.status === 401) {
      showToast(t('toast.needSignInAgain'), true);
      return false;
    }
  } catch {
    // fall through to local
  }
  const next = messageQuota
    ? consumeLocalMessage(messageQuota, email, 1)
    : consumeLocalMessage(localMessageQuota(email, comesSession.plan, comesSession.subscriptionActive), email, 1);
  if (!next) {
    showToast(t('toast.messagesExhaustedMonday'), true);
    return false;
  }
  messageQuota = next;
  renderMessageQuota();
  return true;
}

async function consumeSpeechText(text: string): Promise<boolean> {
  const tokens = countSpeechTokens(text);
  const email = comesSession?.email?.trim() ?? '';
  if (tokens < 1) return true;
  if (!email) {
    showToast(t('toast.needSignInVoice'), true);
    return false;
  }
  if (isUnlimitedSpeechQuota(speechQuota, email)) {
    return true;
  }
  if (!speechQuota || (speechQuota.remaining ?? 0) < tokens) {
    showToast(t('toast.voiceTokensShort', { tokens }), true);
    return false;
  }
  try {
    const result = await comesApi('POST', '/v1/speech/consume', {
      token: comesSession?.token,
      body: { text },
    });
    if (result.ok) {
      speechQuota = parseSpeechQuotaResponse(result.data) ?? speechQuota;
      renderSpeechQuota();
      return true;
    }
    if (result.status === 404) {
      const code = result.data && typeof result.data === 'object'
        ? String((result.data as Record<string, unknown>).error ?? '')
        : '';
      if (code === 'speech_no_subscription') {
        showToast(t('toast.voiceNoSub'), true);
        return false;
      }
      const next = consumeLocalSpeech(speechQuota, email, tokens);
      if (!next) {
        showToast(t('toast.voiceTokensNone'), true);
        return false;
      }
      speechQuota = next;
      renderSpeechQuota();
      return true;
    }
    const remote = parseSpeechQuotaResponse(result.data);
    if (remote) {
      speechQuota = remote;
      renderSpeechQuota();
    }
    showToast(readApiError(result.data, t('toast.voiceQuotaFail')), true);
    return false;
  } catch {
    const next = consumeLocalSpeech(speechQuota, email, tokens);
    if (!next) {
      showToast(t('toast.voiceTokensNone'), true);
      return false;
    }
    speechQuota = next;
    renderSpeechQuota();
    return true;
  }
}

async function transcribeComesSpeech(blob: Blob, language: string): Promise<string> {
  const token = comesSession?.token;
  if (!token) throw new Error('Inicia sesión en ComesADE para usar voz.');
  const form = new FormData();
  const filename = blob.type.includes('mp4') ? 'speech.mp4' : 'speech.webm';
  form.append('audio', blob, filename);
  if (language && language !== 'auto') form.append('language', language.slice(0, 2));
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${API_BASE_URL}/v1/speech/transcribe`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'omit',
      body: form,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    const quota = parseSpeechQuotaResponse(data);
    if (quota) {
      speechQuota = quota;
      renderSpeechQuota();
    }
    if (!response.ok) {
      throw new Error(readApiError(data, 'No se pudo transcribir el audio en ComesADE.'));
    }
    const text = data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string'
      ? (data as { text: string }).text.trim()
      : '';
    if (!text) throw new Error('No se reconoció habla en esa grabación.');
    return text;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('La transcripción en ComesADE tardó demasiado.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function lastAssistantSpeechText(): string {
  for (let index = nativeAgentMessages.length - 1; index >= 0; index -= 1) {
    const message = nativeAgentMessages[index];
    if (message?.role === 'assistant' && message.content.trim()) return message.content.trim();
  }
  return '';
}

function speakAgentReply(): void {
  const text = lastAssistantSpeechText();
  if (!text) {
    showToast(t('toast.noAgentReply'), true);
    return;
  }
  if (!window.speechSynthesis) {
    showToast(t('toast.noTts'), true);
    return;
  }
  void consumeSpeechText(text).then((ok) => {
    if (!ok) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const lang = document.querySelector<HTMLSelectElement>('#composer-stt-lang')?.value;
    if (lang && lang !== 'auto') utterance.lang = lang;
    window.speechSynthesis.speak(utterance);
  });
}

async function comesApi(method: string, path: string, options: { token?: string | null; body?: unknown; timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token && options.token !== 'cookie-session') headers.Authorization = `Bearer ${options.token}`;
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      credentials: 'omit',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      data: { error: message.includes('fetch') ? 'No se pudo conectar con el servicio de cuentas.' : message },
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function refreshComesSubscription(): Promise<boolean> {
  loadComesSession();
  if (!comesSession?.token) {
    comesSession = null;
    speechQuota = null;
    messageQuota = null;
    renderSpeechQuota();
    renderMessageQuota();
    return false;
  }
  try {
    const me = await comesApi('GET', '/v1/auth/me', { token: comesSession.token });
    if (me.status === 401 || me.status === 403) {
      comesSession = null;
      speechQuota = null;
      messageQuota = null;
      saveComesSession();
      renderSpeechQuota();
      renderMessageQuota();
      return false;
    }
    if (me.ok) {
      const email = extractAccountEmail(me.data);
      if (email) comesSession.email = email;
    }
    const billing = await comesApi('GET', '/v1/billing/status', { token: comesSession.token });
    if (billing.status === 401 || billing.status === 403) {
      comesSession = null;
      speechQuota = null;
      messageQuota = null;
      saveComesSession();
      renderSpeechQuota();
      renderMessageQuota();
      return false;
    }
    if (!billing.ok) {
      void refreshSpeechQuota();
      void refreshMessageQuota();
      return comesSession.subscriptionActive;
    }
    comesSession.subscriptionActive = subscriptionIsActive(billing.data);
    comesSession.status = extractSubscriptionStatus(billing.data);
    comesSession.plan = extractPlanLabel(billing.data) ?? comesSession.plan;
    comesSession.lastPaymentAt = extractLastPaymentAt(billing.data) ?? comesSession.lastPaymentAt;
    comesSession.checkedAt = Date.now();
    saveComesSession();
    void refreshSpeechQuota();
    void refreshMessageQuota();
    return comesSession.subscriptionActive;
  } catch {
    void refreshSpeechQuota();
    void refreshMessageQuota();
    return comesSession?.subscriptionActive ?? false;
  }
}

async function comesAuthRequest(email: string, password: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const betterAuth = await signInWithBetterAuth(normalizedEmail, password);
  if (betterAuth) {
    comesSession = {
      token: betterAuth.token,
      email: betterAuth.email,
      subscriptionActive: false,
      status: null,
      plan: null,
      lastPaymentAt: null,
      checkedAt: Date.now(),
    };
    saveComesSession();
    await refreshComesSubscription();
    return;
  }

  const result = await comesApi('POST', '/v1/auth/signin', {
    body: { email: normalizedEmail, password },
    timeoutMs: 30_000,
  });
  if (!result.ok) {
    if (result.status === 0) {
      throw new Error(readApiError(result.data, t('auth.offline')));
    }
    if (result.status === 404) {
      throw new Error(t('auth.offline'));
    }
    if (result.status === 401 || result.status === 403) {
      throw new Error(readApiError(result.data, t('auth.failed')));
    }
    throw new Error(readApiError(result.data, t('auth.generic')));
  }
  const token = extractSessionToken(result.data);
  if (!token) {
    throw new Error(t('auth.generic'));
  }
  comesSession = {
    token,
    email: extractAccountEmail(result.data) ?? email,
    subscriptionActive: subscriptionIsActive(result.data),
    status: extractSubscriptionStatus(result.data),
    plan: extractPlanLabel(result.data),
    lastPaymentAt: extractLastPaymentAt(result.data),
    checkedAt: Date.now(),
  };
  saveComesSession();
  await refreshComesSubscription();
}

async function signOutComesAccount(): Promise<void> {
  const token = comesSession?.token;
  if (token) {
    await Promise.allSettled([
      signOutBetterAuth(token),
      comesApi('POST', '/v1/auth/signout', { token }),
    ]);
  }
  comesSession = null;
  speechQuota = null;
  messageQuota = null;
  saveComesSession();
  renderSpeechQuota();
  renderMessageQuota();
}

async function openComesBillingPortal(): Promise<void> {
  if (!comesSession?.token) {
    showToast(t('auth.portalNeedSignIn'), true);
    return;
  }
  try {
    const result = await comesApi('POST', '/v1/billing/portal', { token: comesSession.token, body: {} });
    const data = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
    const url = [data.url, data.portal_url, data.portalUrl].find((value): value is string => typeof value === 'string' && /^https?:\/\//.test(value));
    await invoke('open_external_url', { url: url ?? COMESADE_PLANS_URL });
  } catch (error) {
    showToast(t('auth.portalFailed', { error: String(error) }), true);
  }
}

async function ensureSignedInForDesktop(): Promise<boolean> {
  await refreshComesSubscription();
  if (hasActiveSubscription()) return true;
  openMainMenu();
  showToast(comesSession?.token
    ? t('auth.needPlan')
    : t('auth.needSignIn'));
  document.querySelector<HTMLInputElement>('#main-menu-email')?.focus();
  return false;
}

async function submitComesAuth(): Promise<void> {
  const email = document.querySelector<HTMLInputElement>('#main-menu-email')?.value.trim() ?? '';
  const password = document.querySelector<HTMLInputElement>('#main-menu-password')?.value ?? '';
  const loginButton = document.querySelector<HTMLButtonElement>('#main-menu-login');
  const errorLabel = document.querySelector<HTMLElement>('#auth-gate-error');
  const showAuthError = (message: string): void => {
    if (errorLabel) {
      errorLabel.hidden = false;
      errorLabel.textContent = message;
    }
    showToast(message, true);
  };
  if (errorLabel) {
    errorLabel.hidden = true;
    errorLabel.textContent = '';
  }
  if (!email || !password) {
    showAuthError(t('auth.needEmailPassword'));
    return;
  }
  if (loginButton) loginButton.disabled = true;
  try {
    await comesAuthRequest(email, password);
    comesAuthEmailDraft = email;
    showToast(hasActiveSubscription()
      ? t('auth.activePlan')
      : t('auth.signedIn'));
    openMainMenu();
  } catch (error) {
    showAuthError(String(error).replace(/^Error:\s*/, ''));
  } finally {
    if (loginButton && document.body.contains(loginButton)) loginButton.disabled = false;
  }
}

function closeAccountMenu(): void {
  accountMenuRoot.innerHTML = '';
  document.querySelector('#titlebar-account')?.setAttribute('aria-expanded', 'false');
}

function renderTitlebarAccount(): void {
  const button = document.querySelector<HTMLButtonElement>('#titlebar-account');
  if (!button) return;
  const signedIn = Boolean(comesSession?.token);
  const email = comesSession?.email ?? 'Account';
  button.classList.toggle('is-signed-in', signedIn);
  button.classList.toggle('is-subscribed', hasActiveSubscription());
  button.innerHTML = signedIn ? `<span>${escapeHtml(comesAccountInitial())}</span>` : icons.user;
  button.title = signedIn ? email : t('common.signIn');
  button.setAttribute('aria-label', signedIn ? `${t('common.account')} ${email}` : t('common.signIn'));
}

async function handleAccountMenuAction(action: string): Promise<void> {
  closeAccountMenu();
  if (action === 'portal') {
    await openComesBillingPortal();
    return;
  }
  if (action === 'refresh') {
    const active = await refreshComesSubscription();
    renderTitlebarAccount();
    if (active) openMainMenu();
    else showToast(t('account.planPending'), true);
    return;
  }
  if (action === 'settings') {
    openSettingsModal();
    return;
  }
  if (action === 'signout') {
    await signOutComesAccount();
    showToast(t('auth.signedOut'));
    openMainMenu();
  }
}

function toggleAccountMenu(): void {
  if (accountMenuRoot.innerHTML) {
    closeAccountMenu();
    return;
  }
  if (!comesSession?.token) {
    openMainMenu();
    return;
  }
  const button = document.querySelector<HTMLButtonElement>('#titlebar-account');
  if (!button) return;
  const rect = button.getBoundingClientRect();
  const email = comesSession.email ?? 'ComesADE account';
  const plan = comesPlanLabel();
  accountMenuRoot.innerHTML = `<div class="account-menu-backdrop" id="account-menu-backdrop"></div><section class="account-menu" id="account-menu" role="menu" aria-label="${escapeHtml(t('common.account'))}"><div class="account-menu-identity"><span class="account-menu-avatar">${escapeHtml(comesAccountInitial())}</span><div><strong>${escapeHtml(email)}</strong><small>${escapeHtml(plan)}</small></div></div><button class="account-menu-item" data-account-action="portal" type="button" role="menuitem">${icons.external}<span>${escapeHtml(t('account.manage'))}</span></button><button class="account-menu-item" data-account-action="refresh" type="button" role="menuitem">${icons.refresh}<span>${escapeHtml(t('account.refresh'))}</span></button><button class="account-menu-item" data-account-action="settings" type="button" role="menuitem">${icons.settings}<span>${escapeHtml(t('common.settings'))}</span></button><button class="account-menu-item account-menu-item-danger" data-account-action="signout" type="button" role="menuitem">${icons.user}<span>${escapeHtml(t('common.signOut'))}</span></button></section>`;
  const menu = document.querySelector<HTMLElement>('#account-menu');
  if (menu) {
    menu.style.top = `${Math.round(rect.bottom + 8)}px`;
    menu.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
  }
  button.setAttribute('aria-expanded', 'true');
  document.querySelector('#account-menu-backdrop')?.addEventListener('click', closeAccountMenu);
  accountMenuRoot.querySelectorAll<HTMLButtonElement>('[data-account-action]').forEach((item) => {
    item.addEventListener('click', () => {
      void handleAccountMenuAction(item.dataset.accountAction ?? '');
    });
  });
}

function openComesAuthScreen(): void {
  setMainMenuOpen(true);
  document.body.classList.add('auth-gate-open');
  closeAccountMenu();
  updateWorkspaceView();
  const signedIn = Boolean(comesSession?.token);
  const email = comesSession?.email ?? '';
  const body = signedIn
    ? `<h2 id="auth-gate-title">${escapeHtml(t('auth.upgradeTitle'))}</h2><p class="auth-gate-copy">${escapeHtml(t('auth.upgradeCopy', { email: email || 'ComesADE' }))}</p><p class="auth-gate-plan">${escapeHtml(comesPlanLabel())}</p><div class="auth-gate-actions"><button class="primary-button auth-gate-submit" id="main-menu-subscribe" type="button">${escapeHtml(t('auth.upgrade'))}</button><button class="secondary-button" id="main-menu-refresh-sub" type="button">${escapeHtml(t('auth.alreadySubscribed'))}</button></div><button class="auth-gate-text" id="auth-gate-signout" type="button">${escapeHtml(t('common.signOut'))}</button>`
    : `<h2 id="auth-gate-title">${escapeHtml(t('auth.title'))}</h2><p class="auth-gate-copy">${escapeHtml(t('auth.copy'))}</p><form class="auth-gate-form" id="main-menu-auth"><label class="field-label" for="main-menu-email">${escapeHtml(t('auth.email'))}</label><input class="field-input" id="main-menu-email" type="email" autocomplete="username" required placeholder="tu@email.com" value="${escapeHtml(comesAuthEmailDraft || email)}" /><label class="field-label" for="main-menu-password">${escapeHtml(t('auth.password'))}</label><input class="field-input" id="main-menu-password" type="password" autocomplete="current-password" required /><button class="primary-button auth-gate-submit" id="main-menu-login" type="submit">${escapeHtml(t('auth.submit'))}</button><p class="auth-gate-error" id="auth-gate-error" hidden></p></form><button class="auth-gate-text" id="main-menu-plans" type="button">${escapeHtml(t('auth.createWeb'))}</button>`;
  modalRoot.innerHTML = `<div class="modal-backdrop main-menu-backdrop auth-gate" id="main-menu-backdrop" role="dialog" aria-modal="true" aria-labelledby="auth-gate-title"><section class="auth-gate-panel"><div class="auth-gate-brand"><div class="brand-mark"><img src="${comesadeLogoUrl}" alt="" aria-hidden="true" /></div><strong>ComesADE</strong></div>${body}</section></div>`;
  renderTitlebarAccount();
  document.querySelector<HTMLFormElement>('#main-menu-auth')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitComesAuth();
  });
  document.querySelector('#main-menu-subscribe')?.addEventListener('click', () => {
    void openComesBillingPortal();
  });
  document.querySelector('#main-menu-refresh-sub')?.addEventListener('click', () => {
    void refreshComesSubscription().then((active) => {
      if (active) {
        showToast(t('toast.subscriptionActive'));
        openMainMenu();
        return;
      }
      showToast(t('toast.noActivePlan'), true);
      openComesAuthScreen();
    });
  });
  document.querySelector('#main-menu-plans')?.addEventListener('click', () => {
    void invoke('open_external_url', { url: COMESADE_SIGNUP_URL });
  });
  document.querySelector('#auth-gate-signout')?.addEventListener('click', () => {
    void signOutComesAccount().then(() => {
      openMainMenu();
    });
  });
  document.querySelector<HTMLInputElement>('#main-menu-email')?.focus();
}

function renderProviderAccountCard(): void {
  const connected = providerAccounts.filter((account) => account.connected);
  aiAccountsCard.classList.toggle('is-connected', connected.length > 0);
  aiAccountsDot.classList.toggle('is-connected', connected.length > 0);
  aiAccountsDot.classList.toggle('is-error', connected.length === 0 && !providerOauthBusy);
  aiAccountsDot.classList.toggle('is-pending', Boolean(providerOauthBusy));
  aiAccountsLabel.textContent = t('chrome.aiAccounts');
  aiAccountsStatus.textContent = connected.length
    ? connected.map((account) => account.name).join(' · ')
    : providerOauthBusy
      ? t('chrome.connecting')
      : t('chrome.connectAgents');
  const selectValue = nativeAgentProvider.value;
  nativeAgentProvider.innerHTML = connected.length
    ? connected.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}</option>`).join('')
    : `<option value="">${escapeHtml(t('chrome.accountSelect'))}</option>`;
  if (selectValue && connected.some((account) => account.id === selectValue)) {
    nativeAgentProvider.value = selectValue;
  } else if (connected[0]) {
    nativeAgentProvider.value = connected[0].id;
  }
  renderComposerAccount();
  const providerB = document.querySelector<HTMLSelectElement>('#native-agent-provider-b');
  if (providerB) {
    const previous = providerB.value;
    providerB.innerHTML = nativeAgentProvider.innerHTML;
    if (previous && providerAccounts.some((account) => account.id === previous && account.connected)) {
      providerB.value = previous;
    } else {
      providerB.value = nativeAgentProvider.value;
    }
  }
  syncComposerPlaceholder();
  renderComposerUsage();
  renderComposerModel();
  renderAsaOverview();
}

async function refreshProviderAccounts(): Promise<ProviderStatus[]> {
  try {
    providerAccounts = await invoke<ProviderStatus[]>('provider_list_status');
  } catch (error) {
    showToast(t('accounts.readError', { error: String(error) }), true);
  }
  renderProviderAccountCard();
  return providerAccounts;
}

function applyProviderStatus(status: ProviderStatus, notify = true): void {
  providerAccounts = providerAccounts.map((account) => account.id === status.id ? status : account);
  if (!providerAccounts.some((account) => account.id === status.id)) providerAccounts.push(status);
  if (status.connected) {
    providerOauthBusy = null;
    providerOauthCode = null;
  }
  renderProviderAccountCard();
  if (document.getElementById('accounts-modal')) renderAccountsModalBody();
  if (!notify) return;
  if (status.connected) {
    showToast(t('accounts.connectedToast', { name: status.name, detail: status.accountLabel ? `: ${status.accountLabel}` : '' }));
  } else if (status.oauthHint && providerOauthBusy === status.id) {
    showToast(status.oauthHint, true);
  }
}

async function pollProviderOAuth(provider: string, intervalMs: number, expiresIn: number | null): Promise<void> {
  const started = Date.now();
  const limit = (expiresIn ?? 600) * 1000;
  while (Date.now() - started < limit) {
    await new Promise((resolve) => window.setTimeout(resolve, Math.max(400, intervalMs)));
    const poll = await invoke<ProviderOAuthPoll>('provider_oauth_poll', { provider });
    if (poll.connected) {
      applyProviderStatus(poll.status);
      return;
    }
    const live = await invoke<ProviderStatus>('provider_status', { provider }).catch(() => null);
    if (live?.connected) {
      applyProviderStatus(live);
      return;
    }
    if (!poll.pending) {
      throw new Error(poll.error ?? 'El login se interrumpio.');
    }
    intervalMs = Math.min(1200, Math.max(intervalMs, 400));
  }
  throw new Error('El login expiro.');
}

async function connectProviderAccount(provider: string, mode?: string): Promise<void> {
  if (providerOauthBusy) return;
  providerOauthBusy = provider;
  providerOauthCode = null;
  renderProviderAccountCard();
  if (document.getElementById('accounts-modal')) renderAccountsModalBody();
  try {
    const start = await invoke<ProviderOAuthStart>('provider_oauth_start', { provider, mode: mode ?? null });
    if (start.verificationUri) {
      await invoke('open_external_url', { url: start.verificationUri }).catch(() => undefined);
    }
    if (start.userCode) {
      providerOauthCode = start.userCode;
      if (document.getElementById('accounts-modal')) renderAccountsModalBody();
      showToast(t('toast.deviceCode', { message: start.message, code: start.userCode }));
    } else {
      showToast(start.message);
    }
    if (!start.intervalMs && !start.userCode) {
      providerKeyForm = provider;
      if (document.getElementById('accounts-modal')) renderAccountsModalBody();
      return;
    }
    await pollProviderOAuth(provider, start.intervalMs ?? 1000, start.expiresIn);
    providerOauthCode = null;
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
  } finally {
    providerOauthBusy = null;
    await refreshProviderAccounts();
    if (document.getElementById('accounts-modal')) renderAccountsModalBody();
  }
}

async function saveProviderApiKey(provider: string, apiKey: string): Promise<void> {
  const status = await invoke<ProviderStatus>('provider_save_key', { provider, apiKey });
  providerAccounts = providerAccounts.map((account) => account.id === provider ? status : account);
  if (!providerAccounts.some((account) => account.id === provider)) providerAccounts.push(status);
  providerKeyForm = null;
  renderProviderAccountCard();
  renderAccountsModalBody();
  showToast(t('toast.apiKeyConnected', { name: status.name }));
}

/// Detalle del consumo del plan dentro de la ficha de cada cuenta. Si el
/// proveedor no publica limites, se dice claramente que no hay dato.
function renderAccountUsage(providerId: string): string {
  const snapshot = providerUsage[providerId];
  if (!snapshot || !snapshot.windows.length) {
    return `<div class="account-usage account-usage-empty">${escapeHtml(t('accounts.noUsage'))}</div>`;
  }
  const rows = snapshot.windows.map((window) => {
    const reset = formatResetIn(window.resetsAt);
    const percent = typeof window.usedPercent === 'number' ? Math.min(100, Math.max(0, window.usedPercent)) : null;
    const bar = percent === null
      ? ''
      : `<span class="account-usage-bar"><i style="width:${percent}%"></i></span>`;
    return `<div class="account-usage-row"><div><strong>${escapeHtml(window.label)}</strong><small>${escapeHtml(reset ? t('accounts.renews', { when: reset }) : usageWindowLabel(window))}</small></div>${bar}<em>${percent === null ? escapeHtml(usageWindowLabel(window)) : `${Math.round(percent)}%`}</em></div>`;
  }).join('');
  return `<div class="account-usage${snapshot.exhausted ? ' is-exhausted' : ''}"><span class="account-usage-title">${escapeHtml(t('accounts.planUsage'))}</span>${rows}</div>`;
}

function renderAccountsModalBody(): void {
  const list = document.querySelector<HTMLElement>('#accounts-list');
  if (!list) return;
  list.innerHTML = providerAccounts.map((account) => {
    const busy = providerOauthBusy === account.id;
    const mark = escapeHtml((account.name.trim()[0] || '?').toUpperCase());
    const status = busy
      ? (providerOauthCode ? t('accounts.waitingLogin', { code: providerOauthCode }) : t('accounts.openingLogin'))
      : account.connected
        ? (account.reauthRequired ? t('accounts.reauth') : t('settings.connected'))
        : t('accounts.disconnected');
    const detail = account.connected
      ? (account.accountLabel || t('accounts.sessionHere'))
      : account.oauthHint;
    const oauthLabel = busy ? t('accounts.waiting') : account.connected ? t('accounts.reconnect') : account.supportsOauth ? t('accounts.connect') : t('accounts.openConsole');
    const oauthButton = `<button class="${account.connected ? 'secondary-button' : 'primary-button'}" data-connect-provider="${escapeHtml(account.id)}" type="button"${providerOauthBusy ? ' disabled' : ''}>${oauthLabel}</button>`;
    const deviceButton = account.id === 'openai'
      ? `<button class="secondary-button" data-connect-provider="${escapeHtml(account.id)}" data-oauth-mode="device" type="button"${providerOauthBusy ? ' disabled' : ''}>${escapeHtml(t('accounts.deviceCode'))}</button>`
      : '';
    const keyButton = account.supportsApiKey
      ? `<button class="secondary-button" data-key-provider="${escapeHtml(account.id)}" type="button">API key</button>`
      : '';
    const keyForm = providerKeyForm === account.id
      ? `<form class="account-key-form" data-save-key="${escapeHtml(account.id)}"><input class="field-input" name="api-key" type="password" autocomplete="off" placeholder="${escapeHtml(t('accounts.pasteKey'))}" required /><button class="primary-button" type="submit">${escapeHtml(t('accounts.saveKey'))}</button></form>`
      : '';
    const usage = account.connected ? renderAccountUsage(account.id) : '';
    const disconnect = account.connected
      ? `<button class="text-action text-action-danger" data-disconnect-provider="${escapeHtml(account.id)}" type="button">${escapeHtml(t('accounts.disconnect'))}</button>`
      : '';
    return `<article class="account-card${account.connected ? ' is-connected' : ''}${busy ? ' is-busy' : ''}">
      <header class="account-card-head">
        <div class="account-card-id"><span class="account-card-mark" aria-hidden="true">${mark}</span><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(detail)}</small></div></div>
        <span class="account-card-status">${escapeHtml(status)}</span>
      </header>
      ${usage}${keyForm}
      <footer class="account-card-actions">${oauthButton}${deviceButton}${keyButton}${disconnect}</footer>
    </article>`;
  }).join('');
}

async function openAccountsModal(): Promise<void> {
  await refreshProviderAccounts();
  modalRoot.innerHTML = `<div class="modal-backdrop" id="accounts-backdrop"><section class="modal-panel accounts-modal" id="accounts-modal" role="dialog" aria-modal="true"><div class="modal-heading"><div><span class="eyebrow">${escapeHtml(t('accounts.eyebrow'))}</span><h2>${escapeHtml(t('accounts.title'))}</h2></div><button class="modal-close" id="accounts-close" type="button">${icons.close}</button></div><p class="modal-copy">${escapeHtml(t('accounts.copy'))}</p><div id="accounts-list" class="accounts-list"></div></section></div>`;
  renderAccountsModalBody();
  const closeAccounts = (): void => {
    providerKeyForm = null;
    if (!hasActiveSubscription() || mainMenuOpen) openMainMenu();
    else {
      modalRoot.innerHTML = '';
      scheduleWebviewSync();
    }
  };
  document.querySelector('#accounts-close')?.addEventListener('click', closeAccounts);
  document.querySelector('#accounts-backdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeAccounts();
  });
  document.querySelector('#accounts-list')?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const connect = target.closest<HTMLElement>('[data-connect-provider]');
    const disconnect = target.closest<HTMLElement>('[data-disconnect-provider]');
    const key = target.closest<HTMLElement>('[data-key-provider]');
    if (connect?.dataset.connectProvider) {
      void connectProviderAccount(connect.dataset.connectProvider, connect.dataset.oauthMode);
    } else if (disconnect?.dataset.disconnectProvider) {
      void invoke('provider_disconnect', { provider: disconnect.dataset.disconnectProvider }).then(refreshProviderAccounts).then(() => {
        if (!hasActiveSubscription()) {
          closeAccounts();
          return;
        }
        renderAccountsModalBody();
      });
    } else if (key?.dataset.keyProvider) {
      providerKeyForm = key.dataset.keyProvider;
      renderAccountsModalBody();
      document.querySelector<HTMLInputElement>(`[data-save-key="${key.dataset.keyProvider}"] input`)?.focus();
    }
  });
  document.querySelector('#accounts-list')?.addEventListener('submit', (event) => {
    const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-save-key]');
    if (!form) return;
    event.preventDefault();
    const provider = form.dataset.saveKey;
    const value = new FormData(form).get('api-key');
    if (!provider || typeof value !== 'string' || !value.trim()) return;
    void saveProviderApiKey(provider, value.trim()).catch((error) => showToast(String(error), true));
  });
}

function agentLineLabel(kind: string): string {
  if (kind === 'user') return t('chrome.you');
  if (kind === 'assistant') return t('chrome.agent');
  if (kind === 'tool') return t('chrome.tool');
  if (kind === 'error') return t('common.error');
  return kind;
}

function toolStepTitle(name: string, input: string): string {
  const relative = relativeFromToolInput(input);
  const file = relative?.split(/[\\/]/).pop();
  const key = name.toLowerCase();
  if (/(grep|search|glob|find)/.test(key)) return file ? t('chrome.exploringFile', { file }) : t('chrome.exploring');
  if (/(read|cat|open)/.test(key)) return file ? t('chrome.readingFile', { file }) : t('chrome.reading');
  if (/(write|edit|patch|apply)/.test(key)) return file ? t('chrome.editingFile', { file }) : t('chrome.editing');
  if (/(shell|bash|command|pty|terminal)/.test(key)) return t('chrome.runningCommand');
  return file ? `${name} · ${file}` : name.replace(/_/g, ' ');
}

function clearAgentThoughtTimer(): void {
  if (agentThoughtTimer !== null) {
    window.clearInterval(agentThoughtTimer);
    agentThoughtTimer = null;
  }
}

function thoughtElapsedLabel(): string {
  const seconds = Math.max(1, Math.round((Date.now() - agentTurnStartedAt) / 1000));
  return `Thought for ${seconds}s`;
}

function startAgentThought(): void {
  clearAgentThoughtTimer();
  agentTurnStartedAt = Date.now();
  agentThoughtLine = appendNativeAgentLine('thought', 'Thinking…');
  agentThoughtTimer = window.setInterval(() => {
    const pre = agentThoughtLine?.querySelector('pre');
    if (pre && !agentThoughtLine?.classList.contains('is-settled')) pre.textContent = `Thinking · ${Math.max(1, Math.round((Date.now() - agentTurnStartedAt) / 1000))}s`;
  }, 1000);
}

function settleAgentThought(): void {
  clearAgentThoughtTimer();
  if (!agentThoughtLine || agentThoughtLine.classList.contains('is-settled')) return;
  agentThoughtLine.classList.add('is-settled');
  const pre = agentThoughtLine.querySelector('pre');
  if (pre) pre.textContent = thoughtElapsedLabel();
}

function setAgentPendingStep(visible: boolean): void {
  if (!visible) {
    agentPendingStep?.remove();
    agentPendingStep = null;
    return;
  }
  if (agentPendingStep?.isConnected) return;
  agentPendingStep = appendNativeAgentLine('step', 'Planning next moves');
}

function appendAgentFilesChanged(entries: GitStatusEntry[]): void {
  if (!entries.length) return;
  const line = document.createElement('div');
  line.className = 'native-agent-line native-agent-line-files';
  line.innerHTML = `<div class="agent-files-changed"><header><strong>${entries.length} file${entries.length === 1 ? '' : 's'} changed</strong><button type="button" class="agent-files-review">Review</button></header><ul>${entries.map((entry) => `<li><span>${escapeHtml(entry.path)}</span><em>${escapeHtml((entry.indexStatus + entry.worktreeStatus).trim() || 'M')}</em></li>`).join('')}</ul></div>`;
  line.querySelector('.agent-files-review')?.addEventListener('click', () => {
    setView('terminals');
    void refreshGitPanel();
  });
  nativeAgentLog.appendChild(line);
  showNativeAgentLog();
  nativeAgentLog.scrollTop = nativeAgentLog.scrollHeight;
}

function showNativeAgentLog(): void {
  nativeAgentLog.hidden = false;
  document.querySelector('#native-agent-panel')?.classList.add('has-thread');
  document.querySelector<HTMLElement>('#agent-chat-hint')?.setAttribute('hidden', '');
}

function resizeNativeAgentInput(): void {
  nativeAgentInput.style.height = 'auto';
  const next = Math.min(140, Math.max(22, nativeAgentInput.scrollHeight));
  nativeAgentInput.style.height = `${next}px`;
  nativeAgentInput.classList.toggle('is-expanded', next >= 140);
  if (!nativeAgentBusy) nativeAgentSend.hidden = !nativeAgentInput.value.trim();
}

function syncComposerPlaceholder(): void {
  const account = providerAccounts.find((item) => item.id === nativeAgentProvider.value && item.connected);
  const accounts = document.querySelector<HTMLButtonElement>('#composer-accounts');
  if (accounts) accounts.hidden = Boolean(account);
  const title = document.querySelector('#agent-chat-title');
  const selected = selectedModelChoice(account);
  if (title) title.textContent = selected ? selected.option.label : t('chrome.agent');
  nativeAgentInput.placeholder = nativeAgentLog.childElementCount ? t('chrome.writeFollowup') : t('chrome.writeMessage');
}

function appendNativeAgentLine(kind: string, text: string, heading?: string, images?: string[]): HTMLDivElement {
  const line = document.createElement('div');
  line.className = 'native-agent-line native-agent-line-' + kind;
  const gallery = images?.length
    ? `<div class="native-agent-captures">${images.map((src) => `<img src="${src}" alt="${escapeHtml(t('chrome.captureAlt'))}">`).join('')}</div>`
    : '';
  if (kind === 'thought' || kind === 'step') {
    line.innerHTML = `<div class="agent-step"><pre></pre></div>`;
    line.querySelector('pre')!.textContent = heading || text;
  } else if (kind === 'tool') {
    line.innerHTML = `<div class="agent-step">${escapeHtml(heading || text)}</div>`;
    if (kind === 'tool' && text && text !== heading) {
      const details = document.createElement('details');
      details.className = 'agent-step-details';
      details.innerHTML = `<summary>${escapeHtml(t('chrome.detail'))}</summary><pre></pre>`;
      details.querySelector('pre')!.textContent = text;
      line.appendChild(details);
    }
  } else {
    line.innerHTML = `<div class="native-agent-body">${gallery}<pre></pre></div>`;
    const pre = line.querySelector('pre')!;
    pre.textContent = text;
  }
  nativeAgentLog.appendChild(line);
  showNativeAgentLog();
  nativeAgentLog.scrollTop = nativeAgentLog.scrollHeight;
  return line;
}

function setNativeAgentBusy(busy: boolean): void {
  nativeAgentBusy = busy;
  nativeAgentSend.disabled = busy;
  nativeAgentSend.hidden = busy || !nativeAgentInput.value.trim();
  nativeAgentCancel.hidden = !busy;
  nativeAgentInput.disabled = false;
  if (nativeAgentStatus) nativeAgentStatus.hidden = !busy;
  document.querySelector('#native-agent-panel')?.classList.toggle('is-busy', busy);
  if (busy) {
    agentTurnGitSnapshot = Object.fromEntries((currentGitStatus?.entries ?? []).map((entry) => [entry.path, `${entry.indexStatus}${entry.worktreeStatus}`]));
    startAgentThought();
  } else {
    settleAgentThought();
    setAgentPendingStep(false);
  }
}

async function sendNativeAgentMessage(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast(t('toast.needWorkspaceAgent'), true);
    return;
  }
  const provider = nativeAgentProvider.value;
  if (!provider || !providerAccounts.some((account) => account.id === provider && account.connected)) {
    showToast(t('toast.connectAgentFirst'), true);
    await openAccountsModal();
    return;
  }
  const images = designPicks.map((pick) => pick.image).filter((value): value is string => Boolean(value));
  const content = nativeAgentInput.value.trim() || (images.length ? 'Cambia el UI de esta captura en el codigo real del workspace.' : '');
  if (!content) return;
  if (!(await consumeAgentRequest())) return;
  nativeAgentInput.value = '';
  resizeNativeAgentInput();
  nativeAgentStreamPre = null;
  setAgentPendingStep(false);
  nativeAgentMessages.push({ role: 'user', content, images: images.length ? images : undefined });
  appendNativeAgentLine('user', content, undefined, images);
  const contextualMessages = nativeAgentMessages.map((message, index) => (
    index === nativeAgentMessages.length - 1 && message.role === 'user'
      ? { role: 'user', content: `${composerEditorContext()}\n\n${message.content}`, images: message.images }
      : message
  ));
  setNativeAgentBusy(true);
  try {
    nativeAgentRequestId = await invoke<string>('agent_chat_start', {
      request: {
        provider,
        workspacePath: workspace.path,
        messages: contextualMessages,
        model: (() => {
          const selected = selectedModelChoice(providerAccounts.find((item) => item.id === provider));
          return selected && selected.option.id !== 'auto' ? selected.option.id : null;
        })(),
        effort: (() => {
          const selected = selectedModelChoice(providerAccounts.find((item) => item.id === provider));
          return selected && selected.option.efforts.length ? selected.effort : null;
        })(),
        requestId: `ui-${Date.now()}`,
      },
    });
  } catch (error) {
    setNativeAgentBusy(false);
    appendNativeAgentLine('error', String(error));
  }
}

async function sendNativeAgentMessageB(): Promise<void> {
  const workspace = getWorkspace();
  const input = document.querySelector<HTMLTextAreaElement>('#native-agent-input-b');
  const provider = document.querySelector<HTMLSelectElement>('#native-agent-provider-b')?.value || nativeAgentProvider.value;
  if (!workspace || !input) return;
  if (!provider || !providerAccounts.some((account) => account.id === provider && account.connected)) {
    showToast(t('toast.connectAgentFirst'), true);
    await openAccountsModal();
    return;
  }
  const content = input.value.trim();
  if (!content) return;
  if (!(await consumeAgentRequest())) return;
  input.value = '';
  nativeAgentStreamPreB = null;
  nativeAgentMessagesB.push({ role: 'user', content });
  appendNativeAgentLineB('user', content);
  nativeAgentBusyB = true;
  document.querySelector<HTMLButtonElement>('#native-agent-send-b')?.setAttribute('disabled', 'true');
  const cancel = document.querySelector<HTMLButtonElement>('#native-agent-cancel-b');
  if (cancel) cancel.hidden = false;
  input.disabled = true;
  document.querySelector('#native-agent-panel-b')?.classList.add('is-busy');
  const contextualMessages = nativeAgentMessagesB.map((message, index) => (
    index === nativeAgentMessagesB.length - 1 && message.role === 'user'
      ? { role: 'user', content: `${composerEditorContext()}\n\n${message.content}` }
      : message
  ));
  try {
    nativeAgentRequestIdB = await invoke<string>('agent_chat_start', {
      request: {
        provider,
        workspacePath: workspace.path,
        messages: contextualMessages,
        model: (() => {
          const selected = selectedModelChoice(providerAccounts.find((item) => item.id === provider));
          return selected && selected.option.id !== 'auto' ? selected.option.id : null;
        })(),
        effort: (() => {
          const selected = selectedModelChoice(providerAccounts.find((item) => item.id === provider));
          return selected && selected.option.efforts.length ? selected.effort : null;
        })(),
        requestId: `ui-b-${Date.now()}`,
      },
    });
  } catch (error) {
    nativeAgentBusyB = false;
    document.querySelector<HTMLButtonElement>('#native-agent-send-b')?.removeAttribute('disabled');
    const cancel = document.querySelector<HTMLButtonElement>('#native-agent-cancel-b');
    if (cancel) cancel.hidden = true;
    input.disabled = false;
    document.querySelector('#native-agent-panel-b')?.classList.remove('is-busy');
    appendNativeAgentLineB('error', String(error));
  }
}

function handleAgentDelta(payload: { requestId: string; text: string }): void {
  if (nativeAgentRequestIdB && payload.requestId === nativeAgentRequestIdB) {
    const last = nativeAgentMessagesB[nativeAgentMessagesB.length - 1];
    if (last?.role === 'assistant') last.content += payload.text;
    else nativeAgentMessagesB.push({ role: 'assistant', content: payload.text });
    const log = document.querySelector<HTMLElement>('#native-agent-log-b');
    if (!nativeAgentStreamPreB) {
      const line = appendNativeAgentLineB('assistant', payload.text);
      line.classList.add('is-streaming');
      nativeAgentStreamPreB = line.querySelector('pre');
    } else {
      nativeAgentStreamPreB.textContent = (nativeAgentStreamPreB.textContent ?? '') + payload.text;
      if (log) log.scrollTop = log.scrollHeight;
    }
    return;
  }
  if (nativeAgentRequestId && payload.requestId !== nativeAgentRequestId) return;
  settleAgentThought();
  setAgentPendingStep(false);
  const last = nativeAgentMessages[nativeAgentMessages.length - 1];
  if (last?.role === 'assistant') last.content += payload.text;
  else nativeAgentMessages.push({ role: 'assistant', content: payload.text });
  if (!nativeAgentStreamPre) {
    const line = appendNativeAgentLine('assistant', payload.text);
    line.classList.add('is-streaming');
    nativeAgentStreamPre = line.querySelector('pre');
  } else {
    nativeAgentStreamPre.textContent = (nativeAgentStreamPre.textContent ?? '') + payload.text;
    nativeAgentLog.scrollTop = nativeAgentLog.scrollHeight;
  }
}

function relativeFromToolInput(input: string): string | null {
  try {
    const parsed = JSON.parse(input) as { relative?: string; path?: string };
    const value = parsed.relative || parsed.path;
    return value ? normalizedRelativePath(value) : null;
  } catch {
    return null;
  }
}

function handleAgentTool(payload: { requestId: string; name: string; input: string; output: string }): void {
  const isB = Boolean(nativeAgentRequestIdB && payload.requestId === nativeAgentRequestIdB);
  if (!isB && nativeAgentRequestId && payload.requestId !== nativeAgentRequestId) return;
  settleAgentThought();
  setAgentPendingStep(false);
  const title = toolStepTitle(payload.name, payload.input);
  if (isB) appendNativeAgentLineB('tool', payload.output || payload.input, title);
  else appendNativeAgentLine('tool', payload.output || payload.input, title);
  if (!isB) setAgentPendingStep(true);
  if (payload.name === 'write_file' && !payload.output.toLowerCase().startsWith('error')) {
    const relative = relativeFromToolInput(payload.input);
    if (relative) void openWorkspaceFile(relative, { fromAgent: true });
    void refreshFileTree();
    void refreshGitPanel();
  }
}

function handleAgentDone(payload: { requestId: string; error: string | null }): void {
  if (nativeAgentRequestIdB && payload.requestId === nativeAgentRequestIdB) {
    if (payload.error) appendNativeAgentLineB('error', payload.error);
    nativeAgentStreamPreB?.closest('.native-agent-line')?.classList.remove('is-streaming');
    nativeAgentStreamPreB = null;
    nativeAgentBusyB = false;
    document.querySelector<HTMLButtonElement>('#native-agent-send-b')?.removeAttribute('disabled');
    const cancel = document.querySelector<HTMLButtonElement>('#native-agent-cancel-b');
    if (cancel) cancel.hidden = true;
    const input = document.querySelector<HTMLTextAreaElement>('#native-agent-input-b');
    if (input) input.disabled = false;
    document.querySelector('#native-agent-panel-b')?.classList.remove('is-busy');
    nativeAgentRequestIdB = null;
    return;
  }
  if (nativeAgentRequestId && payload.requestId !== nativeAgentRequestId) return;
  if (payload.error) appendNativeAgentLine('error', payload.error);
  nativeAgentStreamPre?.closest('.native-agent-line')?.classList.remove('is-streaming');
  nativeAgentStreamPre = null;
  setNativeAgentBusy(false);
  nativeAgentRequestId = null;
  void refreshGitPanel().then(() => {
    const next = currentGitStatus?.entries ?? [];
    const unique = next.filter((entry) => agentTurnGitSnapshot[entry.path] !== `${entry.indexStatus}${entry.worktreeStatus}`);
    if (unique.length) appendAgentFilesChanged(unique);
    syncComposerPlaceholder();
  });
}

async function cancelNativeAgent(): Promise<void> {
  if (nativeAgentRequestId) {
    await invoke('agent_chat_cancel', { requestId: nativeAgentRequestId }).catch(() => undefined);
  }
  setNativeAgentBusy(false);
}

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
  githubAuthGate.hidden = true;
  githubAuthGate.setAttribute('aria-hidden', 'true');
  githubAccountCard.classList.toggle('is-connected', connected);
  githubAccountDot.classList.toggle('is-connected', connected);
  githubAccountDot.classList.toggle('is-error', !connected && !githubAuthBusy);
  githubAccountLabel.textContent = connected ? account : 'GitHub';
  githubAccountStatus.textContent = connected
    ? t('chrome.githubPublishHint')
    : githubAuthBusy
      ? t('chrome.githubWaiting')
      : t('chrome.githubPublishHint');
  githubAccountCard.setAttribute('aria-label', connected ? t('chrome.githubRepos') : t('chrome.githubPublish'));
  const githubPublishCta = document.querySelector<HTMLElement>('#github-publish-cta');
  if (githubPublishCta) githubPublishCta.textContent = connected ? t('chrome.githubOpenRepos') : t('chrome.githubPublish');

  githubAuthConnectButton.disabled = githubAuthBusy || !githubAuth.oauthConfigured;
  githubAuthCheckButton.disabled = githubAuthBusy || !githubAuth.oauthConfigured;
  githubAuthConnectButton.innerHTML = `${icons.github}<span>${githubAuthBusy ? t('chrome.githubWaitingBtn') : t('chrome.githubConnect')}</span>`;
  githubAuthStatusDot.classList.toggle('is-connected', connected);
  githubAuthStatusDot.classList.toggle('is-error', !connected && !githubAuthBusy);
  githubAuthStatusDot.classList.toggle('is-pending', githubAuthBusy);
  const hasDeviceAuthorization = githubAuthBusy && githubDeviceAuthorization !== null;
  githubAuthDeviceCodePanel.hidden = !hasDeviceAuthorization;
  githubAuthDeviceCodeValue.textContent = githubDeviceAuthorization?.userCode ?? '';
  githubAuthDeviceWarning.hidden = !hasDeviceAuthorization;
  githubAuthDeviceWarning.textContent = t('chrome.deviceWarning');

  if (connected) {
    githubAuthStatusTitle.textContent = t('chrome.githubConnected');
    githubAuthStatusDetail.textContent = t('chrome.activeAccount', { account });
    githubAuthNote.textContent = t('chrome.githubManaged');
    return;
  }
  if (githubAuthBusy) {
    githubAuthStatusTitle.textContent = t('chrome.githubCompleteAuth');
    githubAuthStatusDetail.textContent = githubDeviceAuthorization
      ? t('chrome.githubEnterCode')
      : t('chrome.githubPreparing');
    githubAuthNote.textContent = githubDeviceAuthorization
      ? t('chrome.githubOpened', { uri: githubDeviceAuthorization.verificationUri })
      : t('chrome.githubDontClose');
    return;
  }
  if (!githubAuth.oauthConfigured) {
    githubAuthStatusTitle.textContent = t('chrome.githubOauthMissing');
    githubAuthStatusDetail.textContent = githubAuth.error ?? t('chrome.githubMissingClient');
    githubAuthNote.textContent = t('chrome.githubConfigureVite');
    return;
  }
  githubAuthStatusTitle.textContent = t('chrome.githubOptionalTitle');
  githubAuthStatusDetail.textContent = githubAuth.error ?? t('chrome.githubNoAccount');
  githubAuthNote.textContent = t('chrome.githubNote');
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
    githubRepositoriesLoaded = false;
    showToast(t('toast.githubConnected', { user: githubAuth.login ?? t('toast.userFallback') }));
    await finishAuthorizedStartup();
    void loadGithubRepositories(true);
  } catch (error) {
    githubAuth = {
      ...githubAuth,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
    showToast(githubAuth.error ?? t('toast.githubConnectFail'), true);
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
    showToast(status.error ?? t('toast.githubStillOff'), true);
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
      : '<div class="github-repository-state">Esta cuenta no tiene repositorios visibles. Instala la GitHub App de ComesADE y concede acceso a tus repos reales (públicos y privados).</div>';
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
    renderMainMenuGithubRepos();
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
      renderMainMenuGithubRepos();
    }
  })();
  githubRepositoriesRequest = request;
  try {
    await request;
  } finally {
    if (githubRepositoriesRequest === request) githubRepositoriesRequest = null;
  }
}

function joinWorkspacePath(base: string, name: string): string {
  const separator = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function localWorkspaceForGithubRepo(repository: GithubRepository): WorkspaceInfo | undefined {
  const repoName = repository.name.toLowerCase();
  const fullName = repository.fullName.toLowerCase();
  return workspaces.find((workspace) => {
    const normalized = workspace.path.replace(/\\/g, '/').toLowerCase();
    const workspaceName = workspace.name.toLowerCase();
    return workspaceName === repoName
      || workspaceName === fullName
      || normalized.endsWith(`/${repoName}`)
      || normalized.endsWith(`/${fullName}`);
  });
}

function githubRepositoryRowsHtml(search = '', selectedFullName = ''): string {
  if (githubRepositoriesLoading) {
    return `<div class="github-repository-state">${escapeHtml(t('menu.githubLoading'))}</div>`;
  }
  if (!githubAuth.connected) {
    return `<div class="github-repository-state">${escapeHtml(t('menu.githubNeedAccount'))}</div>`;
  }
  if (githubRepositoriesError) {
    return `<div class="github-repository-state github-repository-state-error">${escapeHtml(githubRepositoriesError)}</div>`;
  }
  if (!githubRepositoriesLoaded) {
    return `<div class="github-repository-state">${escapeHtml(t('menu.githubLoading'))}</div>`;
  }
  const query = search.trim().toLowerCase();
  const repositories = githubRepositories.filter((repository) => {
    if (!query) return true;
    return [repository.fullName, repository.description ?? '', repository.defaultBranch ?? '']
      .some((value) => value.toLowerCase().includes(query));
  });
  if (!repositories.length) {
    return `<div class="github-repository-state">${escapeHtml(githubRepositories.length ? t('menu.githubNoMatch') : t('menu.githubEmpty'))}</div>`;
  }
  return repositories.map((repository) => {
    const selected = repository.fullName === selectedFullName;
    const visibility = repository.private ? t('menu.githubPrivate') : t('menu.githubPublic');
    const flags = [visibility, repository.fork ? 'FORK' : '', repository.archived ? 'ARCHIVED' : '']
      .filter(Boolean)
      .join(' · ');
    const updated = formatGithubDate(repository.updatedAt);
    return `<button class="github-repository-row${selected ? ' is-selected' : ''}" data-github-repository="${escapeHtml(repository.fullName)}" type="button">
      <span class="github-repository-mark">${icons.github}</span>
      <span class="github-repository-copy"><strong>${escapeHtml(repository.fullName)}</strong><small>${escapeHtml(repository.description || t('menu.githubNoDescription'))}</small></span>
      <span class="github-repository-meta"><i>${escapeHtml(flags)}</i><small>${escapeHtml(repository.defaultBranch ? `↳ ${repository.defaultBranch}` : '')}${updated ? ` · ${escapeHtml(updated)}` : ''}</small></span>
    </button>`;
  }).join('');
}

function renderMainMenuGithubRepos(): void {
  const list = document.querySelector<HTMLElement>('#main-menu-github-list');
  const account = document.querySelector<HTMLElement>('#main-menu-github-account');
  const count = document.querySelector<HTMLElement>('#main-menu-github-count');
  if (account) {
    account.textContent = githubAuth.connected
      ? `@${githubAuth.login ?? 'github'}`
      : t('menu.githubNeedAccount');
  }
  if (count) {
    count.textContent = githubAuth.connected && githubRepositoriesLoaded
      ? t('menu.githubCount', { count: githubRepositories.length })
      : t('menu.github');
  }
  if (!list) return;
  list.innerHTML = githubRepositoryRowsHtml();
}

async function openOrCloneGithubRepository(repository: GithubRepository, enterAfter = true): Promise<void> {
  const existing = localWorkspaceForGithubRepo(repository);
  if (existing) {
    await activateWorkspace(existing, enterAfter);
    return;
  }
  if (!(await ensureGitAvailable())) return;
  const basePath = await invoke<string>('default_workspace_path');
  const destination = joinWorkspacePath(basePath, repository.name);
  try {
    await invoke<string>('github_clone_repository', {
      clientId: GITHUB_CLIENT_ID,
      repository: repository.fullName,
      destination,
    });
  } catch (error) {
    const message = String(error);
    if (/destino del clone|ya existe|not empty|already exists/i.test(message)) {
      await registerWorkspaceFromPath(destination, enterAfter);
      return;
    }
    throw error;
  }
  await registerWorkspaceFromPath(destination, enterAfter);
  showToast(t('toast.githubCloned', { name: repository.fullName }));
}

function updateConnectionStateLabel(): void {
  connectionState.textContent = localRuntimeState;
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
type DesignPick = {
  tag: string;
  id: string;
  className: string;
  xpath: string;
  text: string;
  css: Record<string, string>;
  component: string | null;
  rect: { x: number; y: number; w: number; h: number };
  url: string;
  kind: 'element' | 'draw';
  note?: string;
  image?: string;
  webviewLabel?: string;
  dpr?: number;
};
let designModeEnabled = false;
let designTool: 'select' | 'draw' = 'draw';
let designPicks: DesignPick[] = [];
let designBridgePort: number | null = null;
let bootSplashActive = true;
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

function setMainMenuOpen(open: boolean): void {
  mainMenuOpen = open;
  document.body.classList.toggle('main-menu-open', open);
  if (!open) document.body.classList.remove('auth-gate-open');
}
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
let composerCollapsed = false;
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
  providerUsage: 'comesade.provider-usage',
  agentModels: 'comesade.agent-models',
  comesSession: 'comesade.comes-session',
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
  uiLanguage: LanguagePreference;
  microphoneId: string;
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
  uiLanguage: 'auto',
  microphoneId: '',
};
let languagePreferenceDraft: LanguagePreference | null = null;

type LayoutView = 'overview' | 'asa' | 'terminals' | 'tools';
type WorkLayout = 'code' | 'cursor' | 'browser' | 'design' | 'dual';

function isLayoutView(value: unknown): value is LayoutView {
  return value === 'overview' || value === 'asa' || value === 'terminals' || value === 'tools';
}

function isWorkLayout(value: unknown): value is WorkLayout {
  return value === 'code' || value === 'cursor' || value === 'browser' || value === 'design' || value === 'dual';
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
  composerCollapsed: boolean;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  layoutChrome?: string;
  workLayout?: WorkLayout;
  view: LayoutView;
  workspaces: Record<string, WorkspaceLayoutState>;
};

let layoutState: LayoutState = {
  sidebarWidth: 258,
  inspectorWidth: 268,
  developerEditorShare: 0.78,
  terminalHeight: 220,
  developerDockCollapsed: false,
  composerCollapsed: false,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  view: 'overview',
  workLayout: 'code',
  layoutChrome: 'nexa',
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

function tx(key: string, vars: Record<string, string | number> = {}): string {
  return escapeHtml(t(key, vars));
}

function showToast(message: string, error = false): void {
  toast.textContent = message;
  toast.classList.toggle('toast-error', error);
  toast.classList.add('toast-visible');
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('toast-visible'), 3600);
}

type AppDialogOptions = {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

function askConfirm(message: string, options: AppDialogOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'app-dialog-host';
    const title = options.title ?? 'ComesADE';
    const confirmLabel = options.confirmLabel ?? t('common.continue');
    const cancelLabel = options.cancelLabel ?? t('common.cancel');
    host.innerHTML = `<div class="modal-backdrop app-dialog-backdrop" role="presentation"><section class="modal-panel app-dialog-panel" role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title"><div class="modal-heading"><div><span class="eyebrow">COMESADE</span><h2 id="app-dialog-title">${escapeHtml(title)}</h2></div></div><p class="modal-copy">${escapeHtml(message)}</p><div class="modal-actions"><button class="secondary-button" type="button" data-app-dialog="cancel">${escapeHtml(cancelLabel)}</button><button class="${options.danger ? 'primary-button app-dialog-danger' : 'primary-button'}" type="button" data-app-dialog="ok">${escapeHtml(confirmLabel)}</button></div></section></div>`;
    document.body.appendChild(host);
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      host.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish(false);
    };
    host.querySelector('[data-app-dialog="ok"]')?.addEventListener('click', () => finish(true));
    host.querySelector('[data-app-dialog="cancel"]')?.addEventListener('click', () => finish(false));
    host.querySelector('.app-dialog-backdrop')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish(false);
    });
    document.addEventListener('keydown', onKey);
    host.querySelector<HTMLButtonElement>('[data-app-dialog="ok"]')?.focus();
  });
}

function askPrompt(message: string, defaultValue = '', options: AppDialogOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'app-dialog-host';
    const title = options.title ?? 'ComesADE';
    const confirmLabel = options.confirmLabel ?? t('common.accept');
    const cancelLabel = options.cancelLabel ?? t('common.cancel');
    host.innerHTML = `<div class="modal-backdrop app-dialog-backdrop" role="presentation"><form class="modal-panel app-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title"><div class="modal-heading"><div><span class="eyebrow">COMESADE</span><h2 id="app-dialog-title">${escapeHtml(title)}</h2></div></div><label class="field-label" for="app-dialog-input">${escapeHtml(message)}</label><input class="field-input" id="app-dialog-input" value="${escapeHtml(defaultValue)}" /><div class="modal-actions"><button class="secondary-button" type="button" data-app-dialog="cancel">${escapeHtml(cancelLabel)}</button><button class="primary-button" type="submit">${escapeHtml(confirmLabel)}</button></div></form></div>`;
    document.body.appendChild(host);
    const input = host.querySelector<HTMLInputElement>('#app-dialog-input')!;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      host.remove();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    };
    host.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      finish(input.value);
    });
    host.querySelector('[data-app-dialog="cancel"]')?.addEventListener('click', () => finish(null));
    host.querySelector('.app-dialog-backdrop')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) finish(null);
    });
    document.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  });
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
      downloadLabel: installer ? t('modal.downloadInstaller') : t('modal.openRelease'),
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
  button.classList.toggle('is-busy', appUpdateInstalling);
  if (!visible) return;
  button.disabled = appUpdateInstalling;
  const version = availableAppUpdate?.version ?? '';
  button.innerHTML = `${appUpdateInstalling ? icons.refresh : icons.updateNow}<span>${escapeHtml(t(appUpdateInstalling ? 'chrome.updateInstalling' : 'chrome.updateNow'))}</span>`;
  button.title = appUpdateInstalling
    ? 'Instalando la actualización'
    : version
      ? `UPDATE · ComesADE ${version}`
      : 'Hay una actualización disponible';
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
    : tx('modal.updateNotesFallback');
  const published = update.date ? new Date(update.date).toLocaleDateString() : '';
  const githubFallback = isGithubReleaseUpdate(update);
  const modalCopy = githubFallback ? t('modal.updateGithubCopy') : t('modal.updateCopy');
  const installLabel = githubFallback ? update.downloadLabel : t('modal.installUpdate');
  modalRoot.innerHTML = `<div class="modal-backdrop" id="app-update-backdrop"><section class="modal-panel app-update-modal"><div class="modal-heading"><div><span class="eyebrow">${tx('modal.update')}</span><h2>${tx('modal.updateTitle')}</h2></div><button class="modal-close" id="app-update-close" type="button">${icons.close}</button></div><div class="app-update-version"><strong>ComesADE ${escapeHtml(update.version)}</strong><span>${published ? tx('modal.publishedOn', { date: published }) : tx('modal.stableRelease')}</span></div><p class="modal-copy">${tx('modal.updateCopy')}</p><div class="app-update-notes">${notesMarkup}</div><p class="app-update-progress" id="app-update-progress" role="status" aria-live="polite">${tx('modal.readyToInstall')}</p><div class="modal-actions"><button class="secondary-button" id="app-update-cancel" type="button">${tx('modal.notNow')}</button><button class="primary-button" id="app-update-install" type="button">${icons.download}<span>${tx('modal.installUpdate')}</span></button></div></section></div>`;
  const copy = document.querySelector<HTMLElement>('.app-update-modal .modal-copy');
  if (copy) copy.textContent = modalCopy;
  const installButton = document.querySelector<HTMLButtonElement>('#app-update-install');
  if (installButton) installButton.innerHTML = `${icons.download}<span>${installLabel}</span>`;
  const versionRow = document.querySelector<HTMLElement>('.app-update-version');
  if (versionRow) {
    const versionText = versionRow.querySelector('strong')?.textContent || `ComesADE ${update.version}`;
    const publishedText = versionRow.querySelector('span')?.textContent || t('modal.stableRelease');
    versionRow.innerHTML = `<div class="app-update-release"><span class="app-update-kicker">${tx('modal.stableKicker')}</span><strong>${escapeHtml(versionText)}</strong></div><span>${escapeHtml(publishedText)}</span>`;
  }
  const notesPanel = document.querySelector<HTMLElement>('.app-update-notes');
  if (notesPanel) {
    notesPanel.innerHTML = `<div class="app-update-notes-heading"><span>${tx('modal.whatsNew')}</span><span>${tx('modal.releaseNotes')}</span></div><div class="app-update-notes-body">${notesMarkup}</div>`;
  }
  const progressStatus = document.querySelector<HTMLElement>('#app-update-progress');
  if (progressStatus) {
    const initialMessage = escapeHtml(progressStatus.textContent || t('modal.readyToInstall'));
    progressStatus.outerHTML = `<div class="app-update-status"><div class="app-update-status-header"><p class="app-update-progress" id="app-update-progress" role="status" aria-live="polite">${initialMessage}</p><strong class="app-update-progress-value" id="app-update-progress-value">-</strong></div><div class="app-update-progress-track" id="app-update-progress-track" role="progressbar" aria-label="${tx('modal.installUpdate')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="app-update-progress-bar" id="app-update-progress-bar"></span></div></div>`;
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
    showToast(t('toast.updateCheckFail'), true);
  } else {
    showToast(t('toast.updateCurrent'));
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
      showToast(t('toast.updateDownloadOpened'));
    } catch (error) {
      appUpdateInstalling = false;
      renderUpdateButton();
      showToast(t('toast.updateDownloadFail', { error: String(error) }), true);
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
      showToast(t('toast.updateInstalled'), true);
      return;
    }
    showToast(t('toast.updateInstallFail', { error: String(error) }), true);
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

function openDesktop(): void {
  const closingMainMenu = mainMenuOpen;
  setMainMenuOpen(false);
  if (closingMainMenu && layoutState.sidebarCollapsed) {
    layoutState.sidebarCollapsed = false;
    applyLayout();
    saveLayout();
  }
  modalRoot.innerHTML = '';
  closeAccountMenu();
  updateWorkspaceView();
  render();
  scheduleWebviewSync();
  void restoreWorkspaceLayout();
  const workspace = getWorkspace();
  if (workspace) {
    void startWorkspaceWatcher(workspace.path)
      .then(() => refreshWorkspacePanels())
      .catch((error) => showToast(t('toast.watcherFail', { error: String(error) }), true));
  }
}

function enterWorkspace(): void {
  void (async () => {
    if (!(await ensureSignedInForDesktop())) return;
    openDesktop();
  })();
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
    if (switchingWorkspace && !(await prepareEditorForRootChange(resolvedPath))) return;
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
    if (enterAfter) {
      if (!(await ensureSignedInForDesktop())) return;
      openDesktop();
    } else void refreshWorkspacePanels();
    showToast(t('toast.workspaceOpened', { name: workspace.name }));
  } catch (error) {
    showToast(t('toast.workspaceOpenFail', { error: String(error) }), true);
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
    if (!(await prepareEditorForRootChange(resolvedPath))) return;
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
    if (enterAfter) {
      if (!(await ensureSignedInForDesktop())) return;
      openDesktop();
    } else void refreshWorkspacePanels();
    showToast(t('toast.workspaceOpened', { name: workspace.name }));
  } catch (error) {
    showToast(t('toast.folderOpenFail', { error: String(error) }), true);
  }
}

async function pickAndOpenWorkspace(returnToMenu = true, enterAfter = true): Promise<void> {
  try {
    const path = await invoke<string | null>('pick_workspace_path');
    if (path) await registerWorkspaceFromPath(path, enterAfter);
    else if (returnToMenu && !getWorkspace()) openMainMenu();
  } catch (error) {
    showToast(t('toast.folderPickerFail', { error: String(error) }), true);
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

function liveTerminalSessions(): SessionInfo[] {
  return sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id));
}

function syncTerminalSurface(): void {
  const live = liveTerminalSessions();
  const empty = live.length === 0;
  terminalEmpty.hidden = !empty;
  terminalEmpty.setAttribute('aria-hidden', String(!empty));
  terminalStack.hidden = empty;
  const emptyCopy = document.querySelector<HTMLElement>('#terminal-empty-copy');
  if (emptyCopy) {
    emptyCopy.textContent = getWorkspace()
      ? t('shell.emptyCopy', { shell: activeShellName() })
      : t('chrome.lockCopy');
  }
  if (empty) return;
  for (const session of live) {
    if (!terminals.has(session.id)) mountTerminal(session);
  }
}

function ensureLiveTerminal(): void {
  if (layoutState.view !== 'terminals') return;
  syncTerminalSurface();
  if (!liveTerminalSessions().length) return;
  window.requestAnimationFrame(() => {
    for (const session of liveTerminalSessions()) syncTerminalSize(session.id);
  });
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
  return t(`status.${activity}`);
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
  const match = command.match(/^(?:(?:npx|pnpm\s+dlx|bunx)\s+)?(?:\.?[\\/])?(claude|codex|opencode|gemini|cursor-agent|aider|droid|kilo|pi|antigravity|agy|qwen|grok)(?:\.(?:ps1|cmd|bat|exe))?(?:\s|$)/i);
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
    showToast(t('toast.agentDetected', { name: agent.name, path: nextName }));
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
    showToast(t('toast.saveStateFail'), true);
  }
  if (nativePersistenceReady) {
    void invoke('save_local_state', { key, value }).catch((error) => showToast(t('toast.saveDbFail', { error: String(error) }), true));
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
    showToast(t('toast.saveWorkspacesFail'), true);
  }
}

let pendingWorkspaceDeleteId: string | null = null;
let pendingWorkspaceDeleteTimer: number | undefined;
let pendingWorkspaceDeleteTick: number | undefined;

function clearPendingWorkspaceDeleteUi(): void {
  if (pendingWorkspaceDeleteTimer) window.clearTimeout(pendingWorkspaceDeleteTimer);
  if (pendingWorkspaceDeleteTick) window.clearInterval(pendingWorkspaceDeleteTick);
  pendingWorkspaceDeleteTimer = undefined;
  pendingWorkspaceDeleteTick = undefined;
  pendingWorkspaceDeleteId = null;
  document.querySelector('.workspace-delete-banner')?.remove();
}

function cancelPendingWorkspaceDelete(): void {
  clearPendingWorkspaceDeleteUi();
}

function refreshSavedWorkspaceSurfaces(): void {
  renderWorkspaceList();
  updateWorkspaceView();
  render();
  const list = document.querySelector<HTMLElement>('#main-menu-workspace-list');
  if (!list) return;
  list.innerHTML = workspaceMenuListHtml();
  bindMainMenuWorkspaceList(list);
  const countLabel = document.querySelector('.main-menu-tools .main-menu-section-heading small');
  if (countLabel) {
    countLabel.textContent = workspaces.length === 1 ? t('menu.savedOne') : t('menu.savedMany', { count: workspaces.length });
  }
  const currentName = document.querySelector('#main-menu-current strong');
  const currentPath = document.querySelector('#main-menu-current small');
  const current = getWorkspace();
  if (current && currentName) currentName.textContent = current.name;
  if (current && currentPath) currentPath.textContent = compactPathLabel(current.path);
}

function workspaceManageButtonHtml(workspaceId: string): string {
  return `<button class="workspace-list-manage" type="button" data-workspace-manage="${escapeHtml(workspaceId)}" title="${escapeHtml(t('menu.workspaceManage'))}" aria-label="${escapeHtml(t('menu.workspaceManage'))}">${icons.more}</button>`;
}

async function renameSavedWorkspace(workspaceId: string): Promise<void> {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;
  const next = await askPrompt(t('menu.renamePrompt'), workspace.name, {
    title: t('menu.rename'),
    confirmLabel: t('common.save'),
  });
  if (next === null) return;
  const name = next.trim();
  if (!name) {
    showToast(t('menu.renameEmpty'), true);
    return;
  }
  workspace.name = name;
  saveWorkspaces();
  refreshSavedWorkspaceSurfaces();
  showToast(t('menu.renameSaved', { name }));
}

function removeSavedWorkspace(workspaceId: string): void {
  const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (index < 0) return;
  const workspace = workspaces[index];
  const wasActive = activeWorkspaceId === workspaceId;
  workspaces.splice(index, 1);
  delete layoutState.workspaces[workspaceId];
  if (wasActive) {
    activeWorkspaceId = workspaces[0]?.id ?? null;
    loadSessionDefinitions();
  }
  saveWorkspaces();
  saveLayout();
  refreshSavedWorkspaceSurfaces();
  if (wasActive) openMainMenu();
  showToast(t('menu.removed', { name: workspace.name }));
}

function scheduleSavedWorkspaceDelete(workspaceId: string): void {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;
  cancelPendingWorkspaceDelete();
  pendingWorkspaceDeleteId = workspace.id;
  let remaining = 3;
  const banner = document.createElement('div');
  banner.className = 'workspace-delete-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'assertive');
  const paint = (): void => {
    banner.innerHTML = `<span>${escapeHtml(t('menu.deleteCountdown', { name: workspace.name, seconds: remaining }))}</span><button class="secondary-button" type="button">${escapeHtml(t('common.cancel'))}</button>`;
    banner.querySelector('button')?.addEventListener('click', cancelPendingWorkspaceDelete);
  };
  paint();
  document.body.appendChild(banner);
  pendingWorkspaceDeleteTick = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) return;
    paint();
  }, 1000);
  pendingWorkspaceDeleteTimer = window.setTimeout(() => {
    const id = pendingWorkspaceDeleteId;
    clearPendingWorkspaceDeleteUi();
    if (id) removeSavedWorkspace(id);
  }, 3000);
}

function openWorkspaceManageMenu(event: MouseEvent, workspaceId: string): void {
  event.preventDefault();
  event.stopPropagation();
  if (!getWorkspace(workspaceId)) return;
  document.querySelector<HTMLElement>('.workspace-manage-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'file-context-menu workspace-manage-menu';
  const left = Math.min(event.clientX, window.innerWidth - 200);
  const top = Math.min(event.clientY, window.innerHeight - 120);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.innerHTML = `<button data-workspace-action="rename" type="button">${icons.pencil}<span>${escapeHtml(t('menu.rename'))}</span></button><button class="is-danger" data-workspace-action="remove" type="button">${icons.trash}<span>${escapeHtml(t('menu.remove'))}</span></button>`;
  document.body.appendChild(menu);
  const close = (): void => {
    menu.remove();
    document.removeEventListener('pointerdown', outside);
  };
  const outside = (pointerEvent: PointerEvent): void => {
    if (!menu.contains(pointerEvent.target as Node)) close();
  };
  document.addEventListener('pointerdown', outside);
  menu.addEventListener('click', (clickEvent) => {
    const action = (clickEvent.target as HTMLElement).closest<HTMLElement>('[data-workspace-action]')?.dataset.workspaceAction;
    close();
    if (action === 'rename') void renameSavedWorkspace(workspaceId);
    if (action === 'remove') scheduleSavedWorkspaceDelete(workspaceId);
  });
}

function bindMainMenuWorkspaceList(list: HTMLElement): void {
  list.querySelectorAll<HTMLButtonElement>('[data-workspace-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const selected = getWorkspace(button.dataset.workspaceId ?? null);
      if (selected) void activateWorkspace(selected, true);
    });
  });
  list.querySelectorAll<HTMLButtonElement>('[data-workspace-manage]').forEach((button) => {
    button.addEventListener('click', (event) => {
      openWorkspaceManageMenu(event, button.dataset.workspaceManage ?? '');
    });
  });
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
  if (session) showToast(t('toast.sessionRelaunched', { name: session.name }));
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
    uiLanguage: isLanguagePreference(stored.uiLanguage) ? stored.uiLanguage : 'auto',
    microphoneId: typeof stored.microphoneId === 'string' ? stored.microphoneId.trim() : '',
  };
  setSelectedMicrophoneId(appSettings.microphoneId);
  applySettings();
}

function normalizeDefaultShell(): void {
  const installed = detectedShells.filter((shell) => shell.installed);
  const selected = installed.find((shell) => shell.id === appSettings.defaultShell);
  const platformDefault = installed.find((shell) => shell.isDefault)
    ?? installed.find((shell) => shell.id === runtimePlatform.defaultShell)
    ?? installed[0];
  if ((selected && /(?:^|[\\/])cargo(?:\.exe)?$/i.test(appSettings.defaultShell)) || (!selected && platformDefault)) {
    appSettings = { ...appSettings, defaultShell: platformDefault?.id ?? runtimePlatform.defaultShell };
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
  const stripped = value
    .trim()
    .replace(/\\\\\?\\UNC\\/gi, '\\\\')
    .replace(/\\\\\?\\/g, '')
    .replace(/^\/\/\?\//, '')
    .replace(/[\u0000-\u001F\u007F]/g, '');
  const normalized = stripped.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter((part) => part && part !== '?');
  if (!parts.length) return normalized || t('chrome.folderLocal');
  if (parts.length === 1) return parts[0];
  return parts.slice(-2).join('\\');
}

function updateShellLabels(): void {
  const shellName = activeShellName();
  const emptyCopy = document.querySelector<HTMLElement>('#terminal-empty small');
  if (emptyCopy) emptyCopy.textContent = t('shell.emptyCopy', { shell: shellName });
  const emptyButton = document.querySelector<HTMLElement>('#terminal-empty-new span')
    ?? document.querySelector<HTMLElement>('#terminal-empty-new');
  if (emptyButton && emptyButton.childElementCount === 0) emptyButton.textContent = t('chrome.newTerminal');
  const summaryShell = document.querySelector<HTMLButtonElement>('#summary-shell');
  if (summaryShell) summaryShell.title = t('shell.openTitle', { shell: shellName });
  const contextSession = document.querySelector<HTMLButtonElement>('#workspace-context-session');
  if (contextSession) contextSession.title = t('shell.openTitle', { shell: shellName });
  const newSessionButton = document.querySelector<HTMLButtonElement>('#sidebar-new-session');
  if (newSessionButton) newSessionButton.title = t('shell.newTitle', { shell: shellName });
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
  app?.classList.remove('theme-gemini');
  for (const instance of terminals.values()) {
    instance.terminal.options.fontFamily = appSettings.terminalFont;
    instance.terminal.options.fontSize = appSettings.terminalFontSize;
    instance.terminal.options.cursorStyle = appSettings.terminalCursor;
    instance.terminal.options.scrollback = appSettings.terminalScrollback;
  }
  applyAppLanguage();
}

function languageStatusText(): string {
  const info = localeSignals();
  const view = currentLocale();
  const device = info.deviceLocale ? localeLabel(info.deviceLocale, view) : `${t('lang.unknown')} (${info.deviceTag})`;
  const ip = info.ipCountry
    ? `${info.ipCountryName ?? info.ipCountry}${info.ipLocale ? ` → ${localeLabel(info.ipLocale, view)}` : ''}`
    : t('lang.unknown');
  if (appSettings.uiLanguage !== 'auto') return t('lang.manualHint');
  return t('lang.hint', { device, ip, resolved: localeLabel(view, view) });
}

function applyAppLanguage(): void {
  const device = readDeviceLocale();
  setLocaleSignals({ deviceTag: device.tag, deviceLocale: device.locale });
  const locale = resolveLocale(languagePreferenceDraft ?? appSettings.uiLanguage, localeSignals());
  setActiveLocale(locale);
  applyDomI18n();
  renderStartCanvas();
  updateShellLabels();
  renderTitlebarAccount();
  syncComposerPlaceholder();
  renderComposerAccount();
  renderComposerModel();
  renderComposerUsage();
  syncSttLangButton();
  renderProviderAccountCard();
  renderGithubAuthState();
  updateWorkspaceView();
  renderComposerGitChrome();
  if (!openFilePath) {
    editorFileName.textContent = t('chrome.noFile');
    editorFilePath.textContent = t('chrome.selectFile');
    editorSaveStatus.textContent = t('chrome.clean');
    const gitDiffHint = document.querySelector<HTMLElement>('#git-diff');
    if (gitDiffHint && !gitDiffHint.textContent?.includes('\n') && !gitDiffHint.textContent?.includes('@@')) {
      gitDiffHint.textContent = t('chrome.gitDiffHint');
    }
    const gitBranch = document.querySelector<HTMLElement>('#git-branch');
    if (gitBranch && (!gitBranch.textContent || gitBranch.textContent === 'NO REPOSITORY')) {
      gitBranch.textContent = t('chrome.noRepo');
    }
  }
  const hint = document.querySelector('#settings-language-hint');
  if (hint) hint.textContent = languageStatusText();
  document.querySelectorAll<HTMLButtonElement>('#settings-language-choices [data-language]').forEach((item) => {
    const value = item.dataset.language ?? '';
    if (value === 'auto') item.textContent = t('lang.autoShort');
    else if (isAppLocale(value)) item.textContent = localeLabel(value, locale);
  });
  if (document.getElementById('accounts-modal')) {
    const title = document.querySelector('#accounts-modal h2');
    const copy = document.querySelector('#accounts-modal .modal-copy');
    const eyebrow = document.querySelector('#accounts-modal .eyebrow');
    if (title) title.textContent = t('accounts.title');
    if (copy) copy.textContent = t('accounts.copy');
    if (eyebrow) eyebrow.textContent = t('accounts.eyebrow');
    renderAccountsModalBody();
  }
  const menuOpen = Boolean(document.getElementById('main-menu-backdrop'));
  if (menuOpen && !document.querySelector('.settings-modal') && !document.getElementById('accounts-modal')) {
    if (document.querySelector('.auth-gate')) openComesAuthScreen();
    else openMainMenu();
  }
}

async function refreshAppLanguage(options: { waitForIp?: boolean } = {}): Promise<void> {
  const device = readDeviceLocale();
  setLocaleSignals({ deviceTag: device.tag, deviceLocale: device.locale });
  if (options.waitForIp && appSettings.uiLanguage === 'auto') {
    const ip = await detectIpLocale();
    setLocaleSignals({ ipCountry: ip.country, ipCountryName: ip.countryName, ipLocale: ip.locale });
  }
  applyAppLanguage();
  const hint = document.querySelector('#settings-language-hint');
  if (hint) hint.textContent = languageStatusText();
}

function loadLayout(): void {
  const stored = readJson<Partial<LayoutState>>(storageKeys.layout, {});
  const width = typeof stored.sidebarWidth === 'number' ? stored.sidebarWidth : 258;
  const inspectorWidth = typeof stored.inspectorWidth === 'number' ? stored.inspectorWidth : 268;
  const developerEditorShare = typeof stored.developerEditorShare === 'number' ? stored.developerEditorShare : 0.58;
  const height = typeof stored.terminalHeight === 'number' ? stored.terminalHeight : 300;
  layoutState.sidebarWidth = Math.min(Math.max(Math.round(width), 218), 390);
  layoutState.inspectorWidth = Math.min(Math.max(Math.round(inspectorWidth), 220), 420);
  layoutState.developerEditorShare = Math.min(Math.max(developerEditorShare, 0.45), 0.92);
  layoutState.terminalHeight = Math.min(Math.max(Math.round(height), 140), Math.max(140, Math.round(window.innerHeight * 0.68)));
  terminalHeight = layoutState.terminalHeight;
  layoutState.developerDockCollapsed = stored.developerDockCollapsed === true;
  developerDockCollapsed = layoutState.developerDockCollapsed;
  const storedRecord = stored as Record<string, unknown>;
  const migrateChrome = storedRecord.layoutChrome !== 'nexa';
  if (migrateChrome) {
    layoutState.composerCollapsed = false;
    layoutState.sidebarCollapsed = false;
    layoutState.inspectorCollapsed = false;
    layoutState.sidebarWidth = 248;
    layoutState.layoutChrome = 'nexa';
  } else {
    layoutState.composerCollapsed = stored.composerCollapsed === true;
    layoutState.sidebarCollapsed = stored.sidebarCollapsed === true;
    layoutState.inspectorCollapsed = stored.inspectorCollapsed === true;
    layoutState.layoutChrome = 'nexa';
  }
  composerCollapsed = layoutState.composerCollapsed;
  inspectorCollapsed = layoutState.inspectorCollapsed;
  const restoredView = isLayoutView(stored.view) ? stored.view : 'overview';
  layoutState.view = restoredView === 'terminals' ? 'overview' : restoredView;
  layoutState.workLayout = isWorkLayout((stored as { workLayout?: unknown }).workLayout)
    ? ((stored as { workLayout: WorkLayout }).workLayout === 'cursor' || (stored as { workLayout: WorkLayout }).workLayout === 'dual'
      ? 'code'
      : (stored as { workLayout: WorkLayout }).workLayout)
    : 'code';
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
        view: isLayoutView(candidate.view) && candidate.view !== 'terminals' ? candidate.view : 'overview',
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
  if (migrateChrome) saveLayout();
}

function saveLayout(): void {
  try {
    setStoredValue(storageKeys.layout, JSON.stringify(layoutState));
  } catch {
    showToast(t('toast.saveLayoutFail'), true);
  }
}

function saveWorkspaceLayout(patch: Partial<WorkspaceLayoutState>): void {
  if (!activeWorkspaceId) return;
  layoutState.workspaces[activeWorkspaceId] = { ...layoutState.workspaces[activeWorkspaceId], ...patch };
  saveLayout();
}

function applyWorkLayout(): void {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const panel = document.querySelector<HTMLElement>('#native-agent-panel');
  const split = document.querySelector<HTMLElement>('#work-split');
  const layout = layoutState.workLayout ?? 'code';
  const showBrowser = layout === 'browser' || layout === 'design' || layoutState.view === 'tools';
  shell?.setAttribute('data-work-layout', layout);
  if (panel && split && showBrowser) {
    panel.classList.add('composer-dock');
    panel.classList.remove('composer-column');
    if (panel.parentElement !== split || split.firstElementChild !== panel) {
      split.insertBefore(panel, split.firstElementChild);
    }
  } else if (workspaceMainMount && panel) {
    panel.classList.add('composer-dock');
    panel.classList.remove('composer-column');
    if (panel.parentElement !== workspaceMainMount) workspaceMainMount.appendChild(panel);
  }
  const panelB = document.querySelector<HTMLElement>('#native-agent-panel-b');
  if (panelB) panelB.hidden = true;
  shell?.style.setProperty('--composer-width', '0px');
  split?.classList.toggle('has-browser', showBrowser);
  if (showBrowser) scheduleWebviewSync();
}

const WORK_LAYOUTS: { id: WorkLayout; label: string; hint: string }[] = [
  { id: 'code', label: 'Code', hint: 'Editor y chat abajo' },
  { id: 'cursor', label: 'Cursor', hint: 'Archivos, editor y chat' },
  { id: 'browser', label: 'Browser + chat', hint: 'Chat a la izquierda y navegador a la derecha' },
  { id: 'design', label: 'Design Mode', hint: 'Captura una zona del preview y enviala al chat' },
  { id: 'dual', label: 'Doble chat', hint: 'Dos chats a la vez' },
];

function setWorkLayout(layout: WorkLayout): void {
  layoutState.workLayout = layout;
  if (layout !== 'code') {
    inspectorCollapsed = false;
    layoutState.inspectorCollapsed = false;
  }
  if (layout === 'browser' || layout === 'design') {
    composerCollapsed = false;
    layoutState.composerCollapsed = false;
    layoutState.view = 'tools';
  }
  if (layout === 'cursor' || layout === 'dual' || layout === 'code') {
    if (layoutState.view === 'tools') layoutState.view = 'overview';
  }
  applyLayout();
  saveLayout();
  scheduleWebviewSync();
  if (layout === 'design' && !designModeEnabled) void setDesignMode(true);
}

function openLayoutPicker(): void {
  document.querySelector('.layout-picker-menu')?.remove();
  const button = document.querySelector<HTMLButtonElement>('#titlebar-layout-picker');
  if (!button) return;
  const menu = document.createElement('div');
  menu.className = 'file-context-menu layout-picker-menu';
  const current = layoutState.workLayout ?? 'code';
  menu.innerHTML = WORK_LAYOUTS.map((item) => `<button type="button" data-work-layout="${item.id}" class="${item.id === current ? 'is-selected' : ''}"><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.hint)}</small></span>${item.id === current ? '<em>ACTUAL</em>' : ''}</button>`).join('');
  document.body.appendChild(menu);
  const rect = button.getBoundingClientRect();
  menu.style.minWidth = '260px';
  menu.style.left = `${Math.max(12, rect.left + rect.width / 2 - 130)}px`;
  menu.style.top = `${rect.bottom + 8}px`;
  const close = (): void => {
    menu.remove();
    document.removeEventListener('pointerdown', outside);
  };
  const outside = (event: PointerEvent): void => {
    if (menu.contains(event.target as Node) || button.contains(event.target as Node)) return;
    close();
  };
  document.addEventListener('pointerdown', outside);
  menu.addEventListener('click', (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-work-layout]')?.dataset.workLayout;
    if (!isWorkLayout(id)) return;
    close();
    setWorkLayout(id);
  });
}

let nativeAgentMessagesB: AgentChatMessage[] = [];
let nativeAgentRequestIdB: string | null = null;
let nativeAgentBusyB = false;
let nativeAgentStreamPreB: HTMLPreElement | null = null;

function ensureSecondComposer(): void {
  if (document.querySelector('#native-agent-panel-b')) return;
  const source = document.querySelector<HTMLElement>('#native-agent-panel');
  const rail = document.querySelector<HTMLElement>('#composer-rail');
  if (!source || !rail) return;
  const clone = source.cloneNode(true) as HTMLElement;
  clone.id = 'native-agent-panel-b';
  clone.querySelectorAll('[id]').forEach((node) => {
    node.id = `${node.id}-b`;
  });
  clone.classList.add('composer-column');
  clone.classList.remove('composer-dock', 'has-thread', 'is-busy');
  clone.querySelector('#native-agent-log-b')?.replaceChildren();
  clone.querySelector('#native-agent-model-b')?.setAttribute('hidden', '');
  clone.querySelector('#native-agent-efforts-b')?.setAttribute('hidden', '');
  const inputB = clone.querySelector<HTMLTextAreaElement>('#native-agent-input-b');
  if (inputB) {
    inputB.value = '';
    inputB.placeholder = 'Segundo chat';
  }
  const sourceProvider = source.querySelector<HTMLSelectElement>('#native-agent-provider');
  const destProvider = clone.querySelector<HTMLSelectElement>('#native-agent-provider-b');
  if (sourceProvider && destProvider) destProvider.innerHTML = sourceProvider.innerHTML;
  rail.appendChild(clone);
  const form = clone.querySelector<HTMLFormElement>('#native-agent-form-b');
  const input = clone.querySelector<HTMLTextAreaElement>('#native-agent-input-b');
  const cancel = clone.querySelector<HTMLButtonElement>('#native-agent-cancel-b');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendNativeAgentMessageB();
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendNativeAgentMessageB();
    }
  });
  cancel?.addEventListener('click', () => {
    if (nativeAgentRequestIdB) void invoke('agent_chat_cancel', { requestId: nativeAgentRequestIdB }).catch(() => undefined);
  });
  clone.querySelector('#composer-accounts-b')?.addEventListener('click', () => { void openAccountsModal(); });
  clone.querySelector('#composer-hide-b')?.addEventListener('click', () => toggleComposer());
}

function appendNativeAgentLineB(kind: string, text: string, heading?: string): HTMLDivElement {
  const log = document.querySelector<HTMLElement>('#native-agent-log-b');
  const line = document.createElement('div');
  line.className = 'native-agent-line native-agent-line-' + kind;
  line.innerHTML = `<span>${escapeHtml(heading || agentLineLabel(kind))}</span><pre></pre>`;
  const pre = line.querySelector('pre')!;
  pre.textContent = text;
  log?.appendChild(line);
  if (log) {
    log.hidden = false;
    log.scrollTop = log.scrollHeight;
  }
  document.querySelector('#native-agent-panel-b')?.classList.add('has-thread');
  return line;
}

function applyLayout(): void {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  const workspaceMain = document.querySelector<HTMLElement>('.workspace-main');
  const sidebarToggle = document.querySelector<HTMLButtonElement>('#titlebar-layout');
  shell?.style.setProperty('--sidebar-width', String(layoutState.sidebarWidth) + 'px');
  shell?.style.setProperty('--inspector-width', String(layoutState.inspectorWidth) + 'px');
  applyWorkLayout();
  document.querySelector<HTMLElement>('.developer-dock')?.style.setProperty('--developer-editor-share', String(layoutState.developerEditorShare));
  terminalArea.style.setProperty('--terminal-height', String(layoutState.terminalHeight) + 'px');
  syncDeveloperDockVisibility();
  syncComposerVisibility();
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
  const workLayout = layoutState.workLayout ?? 'code';
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((item) => {
    const view = item.dataset.view;
    if (!view) return;
    let active = view === layoutState.view;
    if (item.classList.contains('titlebar-pill')) {
      if (layoutState.view === 'asa' || layoutState.view === 'terminals') {
        active = view === layoutState.view;
      } else if (view === 'overview') {
        active = layoutState.view === 'overview' && workLayout !== 'browser' && workLayout !== 'design';
      } else if (view === 'tools') {
        active = layoutState.view === 'tools' || workLayout === 'browser' || workLayout === 'design';
      }
    }
    item.classList.toggle('is-active', active);
  });
}

function syncResponsiveLayout(force = false): void {
  const nextCompactViewport = window.innerWidth <= 760;
  const viewportChanged = nextCompactViewport !== compactViewport;

  if (nextCompactViewport && (force || !responsiveLayoutInitialized || viewportChanged)) {
    if (!layoutState.sidebarCollapsed) {
      layoutState.sidebarCollapsed = true;
      applyLayout();
    }
  } else if (!nextCompactViewport && responsiveLayoutInitialized && viewportChanged) {
    // Keep the compact activity-rail + explorer chrome on wide screens.
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
  setView(savedView === 'terminals' ? 'overview' : savedView);
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
  syncDeveloperDockVisibility();
  syncComposerVisibility();
  activeWorkspaceCard.hidden = locked;
  sidebarProjectEmpty.hidden = !locked;
  sessionList.hidden = locked;
  activeWorkspaceName.textContent = workspace?.name ?? t('chrome.noWorkspace');
  activeWorkspacePath.textContent = workspace?.path ?? t('chrome.openFolderStart');
  workspaceHeading.textContent = workspace?.name ?? t('chrome.noWorkspace');
  workspaceHeaderPath.textContent = workspace ? compactPathLabel(workspace.path) : t('chrome.openFolder');
  workspaceSummaryName.textContent = workspace?.name ?? t('chrome.noWorkspace');
  workspaceSummaryPath.textContent = workspace?.path ?? t('chrome.openToStart');
  overviewSessionCount.textContent = String(sessions.filter((session) => !exitedSessions.has(session.id)).length);
  const liveActiveSession = Boolean(getLiveSession(activeSessionId));
  overviewActiveLabel.textContent = workspace ? (liveActiveSession ? t('chrome.active') : t('chrome.ready')) : t('chrome.locked');
  overviewPathShort.textContent = workspace ? compactPathLabel(workspace.path) : '—';
  overviewPathDetail.textContent = workspace?.path ?? t('chrome.noWorkspace');
  overviewRuntimeStatus.textContent = workspace ? (liveActiveSession ? t('chrome.live') : t('chrome.ready')) : t('chrome.locked');
  overviewShell.textContent = workspace ? activeShellName() : t('chrome.noShell');
  activeSessionLabel.textContent = getLiveSession(activeSessionId)?.name ?? t('chrome.noSession');
  commandCwd.textContent = getLiveSession(activeSessionId)?.cwd ?? workspace?.path ?? t('chrome.noCwd');
  commandLive.textContent = getLiveSession(activeSessionId) ? sessionActivityLabel(sessionActivity(getLiveSession(activeSessionId)!)).toUpperCase() : t('chrome.waiting');
  syncTerminalSurface();
  notesInput.disabled = locked;
  loadNotes();
  applyInspectorTabVisibility();
  renderInspectorPanels();
}

let currentGitStatus: GitStatusResult | null = null;
let currentGitQueryRoot: string | null = null;
let gitPanelError: string | null = null;
let gitPanelBusy = false;
let currentGitDiffStats: GitDiffStats | null = null;
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
  inspectorOverviewName.textContent = workspace?.name ?? t('chrome.noWorkspace');
  inspectorOverviewPath.textContent = workspace?.path ?? t('chrome.createOrOpen');
  inspectorOverviewSessions.textContent = String(liveSessions.length);
  inspectorOverviewRuntime.textContent = workspace ? (getLiveSession(activeSessionId) ? 'LIVE' : 'READY') : 'LOCKED';
  inspectorGitBranch.textContent = currentGitStatus?.branch || (workspace ? '' : '');
  if (!inspectorGitBranch.textContent) {
    inspectorGitBranch.textContent = !workspace
      ? t('chrome.noWorkspace')
      : gitPanelBusy
        ? t('chrome.gitConsulting')
        : gitAvailability && !gitAvailability.available
          ? t('chrome.gitMissing')
          : gitPanelError
            ? t('chrome.gitQueryFailed')
            : t('chrome.noGitRepo');
  }
  if (!workspace) {
    inspectorGitContent.innerHTML = '<div class="dock-empty">' + escapeHtml(t('chrome.gitNeedWorkspace')) + '</div>';
  } else if (gitPanelBusy && !currentGitStatus) {
    inspectorGitContent.innerHTML = '<div class="dock-empty">' + escapeHtml(t('chrome.gitConsulting')) + '</div>';
  } else if (gitAvailability && !gitAvailability.available) {
    inspectorGitContent.innerHTML = '<div class="dock-empty">' + escapeHtml(t('chrome.gitMissing')) + '</div>';
  } else if (currentGitStatus) {
    inspectorGitContent.innerHTML = currentGitStatus.entries.length
      ? currentGitStatus.entries.map(gitEntryMarkup).join('')
      : '<div class="dock-empty">' + escapeHtml(t('chrome.gitClean')) + '</div>';
  } else {
    inspectorGitContent.innerHTML = '<div class="dock-empty">' + escapeHtml(gitPanelError || t('chrome.noGitRepo')) + '</div>';
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

async function prepareEditorForRootChange(nextRoot: string | null): Promise<boolean> {
  if (!openFilePath) return true;
  if (openFileRoot && nextRoot && sameFsPath(openFileRoot, nextRoot)) return true;
  if (openFileDirty && !(await askConfirm('Hay cambios sin guardar. ¿Descartarlos al cambiar de proyecto?', { title: 'Cambios sin guardar', confirmLabel: 'Descartar', danger: true }))) return false;
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
  const name = await askPrompt(
    kind === 'file' ? 'Nombre del nuevo archivo (ruta relativa):' : 'Nombre de la nueva carpeta (ruta relativa):',
    fileTreeRelativePath ? fileTreeRelativePath + '/' : '',
    { title: kind === 'file' ? 'Nuevo archivo' : 'Nueva carpeta', confirmLabel: 'Crear' },
  );
  if (!name?.trim()) return;
  try {
    await invoke(kind === 'file' ? 'create_file' : 'create_directory', { root: activeProjectRoot() ?? workspace.path, relative: name.trim() });
    await refreshFileTree();
    showToast(kind === 'file' ? t('toast.fileCreated') : t('toast.folderCreated'));
  } catch (error) {
    showToast(t('toast.createFail', { error: String(error) }), true);
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
        const next = await askPrompt('Nuevo nombre:', current, { title: 'Renombrar', confirmLabel: 'Renombrar' });
        if (next?.trim()) {
          const normalizedSource = normalizedRelativePath(relative);
          const parent = normalizedSource.includes('/') ? normalizedSource.slice(0, normalizedSource.lastIndexOf('/') + 1) : '';
          const destination = parent + next.trim();
          await invoke('rename', { root: activeProjectRoot() ?? workspace.path, relative, newName: next.trim() });
          const remapped = remapOpenFilePath(relative, destination);
          if (remapped) updateOpenFilePath(remapped);
        }
      } else if (action === 'move') {
        const destination = await askPrompt('Ruta relativa de destino (incluye el nombre):', relative, { title: 'Mover', confirmLabel: 'Mover' });
        if (destination?.trim()) {
          const nextPath = destination.trim();
          await invoke('move_path', { root: activeProjectRoot() ?? workspace.path, relative, destination: nextPath });
          const remapped = remapOpenFilePath(relative, nextPath);
          if (remapped) updateOpenFilePath(remapped);
        }
      } else if (action === 'delete') {
        if (!(await askConfirm('Esto eliminará el elemento real del disco. ¿Continuar?', { title: 'Eliminar', confirmLabel: 'Eliminar', danger: true }))) return;
        await invoke('delete', { root: activeProjectRoot() ?? workspace.path, relative });
        if (isSameOrInsideRelativePath(openFilePath, relative)) clearOpenFile();
      } else if (action === 'reveal') {
        await invoke('reveal_path', { path: workspaceAbsolutePath(workspace, relative) });
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(relative);
        showToast(t('toast.relativeCopied'));
      } else if (action === 'copy-absolute') {
        await navigator.clipboard.writeText(workspaceAbsolutePath(workspace, relative));
        showToast(t('toast.absoluteCopied'));
      }
      await refreshFileTree(fileTreeRelativePath);
      await refreshGitPanel();
    } catch (error) {
      showToast(t('toast.operationFail', { error: String(error) }), true);
    }
  });
}

async function openWorkspaceFile(relative: string, options?: { fromAgent?: boolean }): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  syncCurrentOpenFileTab();
  if (openFileDirty && !options?.fromAgent && !(await askConfirm('Hay cambios sin guardar. ¿Abrir otro archivo?', { title: 'Cambios sin guardar', confirmLabel: 'Descartar', danger: true }))) return;
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
    if (options?.fromAgent || !tab.dirty) {
      tab.content = content;
      if (options?.fromAgent) tab.dirty = false;
    }
    openFilePath = tab.path;
    openFileRoot = tab.root;
    openFileDirty = tab.dirty;
    setEditorValue(tab.content, tab.path);
    setEditorEnabled(true);
    editorFileName.textContent = tab.path.split('/').pop() ?? tab.path;
    editorFilePath.textContent = tab.path;
    editorSaveStatus.textContent = tab.dirty ? 'DIRTY' : 'CLEAN';
    renderEditorTabs();
    updateStatusbar();
    developerDockCollapsed = false;
    layoutState.developerDockCollapsed = false;
    saveWorkspaceLayout({ openFilePath: tab.path, openFilePaths: openFileTabs.map((item) => item.path).slice(-24) });
    syncDeveloperDockVisibility();
    // Monaco es pesado y no debe bloquear el arranque ni el menú principal.
    // Se carga únicamente cuando el usuario abre un archivo real.
    if (!codeEditor && !monacoLoadPromise) window.setTimeout(() => { if (openFilePath === tab.path) void setupMonacoEditor(); }, 0);
  } catch (error) {
    showToast(t('toast.readFileFail', { error: String(error) }), true);
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
    showToast(t('toast.openFileFail', { error: String(error) }), true);
  }
}

async function closeFileTab(path: string, rootHint?: string): Promise<void> {
  const root = rootHint ?? activeProjectRoot() ?? getWorkspace()?.path ?? openFileRoot ?? null;
  const index = openFileTabs.findIndex((tab) => relativePathKey(tab.path) === relativePathKey(path) && (!root || sameFsPath(tab.root, root)));
  if (index < 0) return;
  syncCurrentOpenFileTab();
  const tab = openFileTabs[index];
  if (tab.dirty && !(await askConfirm('Hay cambios sin guardar en este archivo. ¿Cerrar la pestaña?', { title: 'Cambios sin guardar', confirmLabel: 'Cerrar pestaña', danger: true }))) return;
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
    showToast(t('toast.saveFileFail', { error: String(error) }), true);
  }
}

async function loadGitDiff(relative: string): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) return;
  try {
    const versions = await invoke<GitFileVersions>('file_versions', { path: gitActionRoot() ?? workspace.path, relative, staged: false });
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
    showToast(t('toast.gitCheckFail', { error: String(error) }), true);
    return false;
  }
  if (availability.available) return true;
  if (gitInstallPrompted) return false;

  gitInstallPrompted = true;
  if (!(await askConfirm('Git no está instalado en este PC. ComesADE puede instalar Git mediante el instalador oficial. ¿Continuar?', { title: 'Instalar Git', confirmLabel: 'Instalar' }))) {
    gitInstallPrompted = false;
    return false;
  }

  const installPromise = (async (): Promise<boolean> => {
    try {
      showToast(t('toast.gitInstalling'));
      const installed = await invoke<GitAvailability>('install_git');
      gitAvailability = installed;
      if (!installed.available) {
        showToast(t('toast.gitInstallMissing'), true);
        return false;
      }
      showToast(t('toast.gitInstalled', { version: installed.version ? ` (${installed.version}).` : '.' }));
      return true;
    } catch (error) {
      gitInstallPrompted = false;
      showToast(t('toast.gitInstallFail', { error: String(error) }), true);
      return false;
    } finally {
      gitInstallInFlight = null;
    }
  })();
  gitInstallInFlight = installPromise;
  return installPromise;
}

function gitCandidateRoots(workspace: { path: string }): string[] {
  const roots: string[] = [];
  const push = (value?: string | null) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    if (roots.some((existing) => sameFsPath(existing, trimmed))) return;
    roots.push(trimmed);
  };
  push(workspace.path);
  push(getSession(activeSessionId)?.worktree);
  return roots;
}

function gitActionRoot(): string | undefined {
  const workspace = getWorkspace();
  if (!workspace) return undefined;
  return currentGitQueryRoot ?? gitCandidateRoots(workspace)[0];
}

async function invokeGitStatus(path: string): Promise<GitStatusResult> {
  try {
    return await invoke<GitStatusResult>('git_status', { path });
  } catch {
    return invoke<GitStatusResult>('status', { path });
  }
}

async function refreshGitPanel(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    currentGitStatus = null;
    currentGitQueryRoot = null;
    gitPanelError = null;
    gitPanelBusy = false;
    currentGitDiffStats = null;
    currentGitWorktrees = [];
    currentGitWorktreeRoot = null;
    currentGitWorktreeState = 'unavailable';
    gitBranch.textContent = '';
    const gitStatusPill = document.querySelector<HTMLElement>('#git-branch-status');
    if (gitStatusPill) {
      gitStatusPill.hidden = true;
      gitStatusPill.textContent = '';
    }
    gitList.innerHTML = '<div class="dock-empty">' + escapeHtml(t('chrome.gitNeedWorkspace')) + '</div>';
    gitWorktreeList.innerHTML = '';
    setDiffMessage('Selecciona un cambio para ver el diff real.');
    renderInspectorPanels();
    renderAsaOverview();
    renderComposerGitChrome();
    updateStatusbar();
    return;
  }
  gitPanelBusy = true;
  gitPanelError = null;
  renderInspectorPanels();
  if (!(await ensureGitAvailable())) {
    gitPanelBusy = false;
    currentGitStatus = null;
    currentGitQueryRoot = workspace.path;
    gitPanelError = t('chrome.gitMissing');
    currentGitDiffStats = null;
    currentGitWorktrees = [];
    currentGitWorktreeRoot = workspace.path;
    currentGitWorktreeState = 'unavailable';
    gitBranch.textContent = '';
    gitList.innerHTML = '<div class="dock-empty">' + escapeHtml(t('chrome.gitMissing')) + '</div>';
    gitWorktreeList.innerHTML = '<div class="dock-empty">Git no esta disponible.</div>';
    setDiffMessage('Instala Git para ver diffs reales.');
    renderInspectorPanels();
    renderAsaOverview();
    renderComposerGitChrome();
    updateStatusbar();
    return;
  }
  const roots = gitCandidateRoots(workspace);
  let status: GitStatusResult | null = null;
  let lastError = '';
  let usedRoot = roots[0] ?? workspace.path;
  for (const root of roots) {
    try {
      status = await invokeGitStatus(root);
      usedRoot = root;
      lastError = '';
      break;
    } catch (error) {
      lastError = String(error);
    }
  }
  if (getWorkspace()?.id !== workspace.id) return;
  gitPanelBusy = false;
  if (!status) {
    currentGitStatus = null;
    currentGitQueryRoot = usedRoot;
    gitPanelError = lastError || t('chrome.gitQueryFailed');
    currentGitDiffStats = null;
    currentGitWorktrees = [];
    currentGitWorktreeRoot = workspace.path;
    currentGitWorktreeState = 'unavailable';
    gitBranch.textContent = '';
    updateStatusbar();
    gitList.innerHTML = '<div class="dock-empty">' + escapeHtml(t('chrome.noGitRepo')) + (lastError ? ': ' + escapeHtml(lastError) : '') + '</div>';
    gitWorktreeList.innerHTML = '<div class="dock-empty">No hay worktrees disponibles.</div>';
    setDiffMessage('Git no esta disponible para este workspace.');
    renderInspectorPanels();
    renderAsaOverview();
    renderComposerGitChrome();
    return;
  }
  currentGitQueryRoot = usedRoot;
  gitPanelError = null;
  currentGitStatus = { ...status, branch: status.branch || 'HEAD' };
  gitBranch.textContent = currentGitStatus.branch;
  updateStatusbar();
  gitList.innerHTML = status.entries.length ? status.entries.map(gitEntryMarkup).join('') : '<div class="dock-empty">' + escapeHtml(t('chrome.gitClean')) + '</div>';
  try {
    currentGitDiffStats = await invoke<GitDiffStats>('diff_stats', { path: usedRoot });
  } catch {
    currentGitDiffStats = null;
  }
  await refreshWorktrees();
  renderInspectorPanels();
  renderComposerGitChrome();
}

function renderComposerGitChrome(): void {
  const bar = document.querySelector<HTMLElement>('#composer-git-bar');
  const changes = document.querySelector<HTMLButtonElement>('#composer-changes');
  const commit = document.querySelector<HTMLButtonElement>('#composer-commit-action');
  const branchButton = document.querySelector<HTMLButtonElement>('#composer-git-branch');
  const add = document.querySelector('#composer-git-add');
  const del = document.querySelector('#composer-git-del');
  const branchLabel = document.querySelector('#composer-git-branch-label');
  const branch = currentGitStatus?.branch?.trim() || '';
  if (branchLabel) branchLabel.textContent = branch;
  if (branchButton) {
    branchButton.hidden = !branch;
    branchButton.title = branch ? t('chrome.branchTitle', { branch }) : '';
  }
  const additions = Number(currentGitDiffStats?.additions ?? 0);
  const deletions = Number(currentGitDiffStats?.deletions ?? 0);
  const dirty = Boolean(currentGitStatus) && (additions > 0 || deletions > 0 || (currentGitStatus?.entries.length ?? 0) > 0);
  if (add) add.textContent = `+${additions}`;
  if (del) del.textContent = `-${deletions}`;
  if (changes) changes.hidden = !dirty;
  if (commit) commit.hidden = !dirty;
  if (bar) bar.hidden = !dirty;
}

function suggestedAgentBranch(): string {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}-${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
  return `comesade/${stamp}`;
}

function openComposerCommitModal(): void {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast(t('toast.needWorkspaceCommit'), true);
    return;
  }
  const close = (): void => { modalRoot.innerHTML = ''; };
  modalRoot.innerHTML = `<div class="modal-backdrop" id="composer-commit-backdrop"><section class="modal-panel"><div class="modal-heading"><div><span class="eyebrow">${tx('modal.git')}</span><h2>${tx('modal.createBranchCommit')}</h2></div><button class="modal-close" id="composer-commit-close" type="button">${icons.close}</button></div><label class="field-label" for="composer-commit-branch">${tx('modal.newBranch')}</label><input class="field-input" id="composer-commit-branch" value="${escapeHtml(suggestedAgentBranch())}"/><label class="field-label" for="composer-commit-message">${tx('modal.commitMessage')}</label><input class="field-input" id="composer-commit-message" placeholder="${tx('modal.commitMessagePh')}"/><div class="modal-actions"><button class="secondary-button" id="composer-commit-cancel" type="button">${tx('common.cancel')}</button><button class="primary-button" id="composer-commit-run" type="button">${tx('modal.commit')}</button></div></section></div>`;
  document.querySelector('#composer-commit-close')?.addEventListener('click', close);
  document.querySelector('#composer-commit-cancel')?.addEventListener('click', close);
  document.querySelector('#composer-commit-run')?.addEventListener('click', () => { void runComposerCommit(close); });
  document.querySelector<HTMLInputElement>('#composer-commit-message')?.focus();
}

async function runComposerCommit(close: () => void): Promise<void> {
  const workspace = getWorkspace();
  const branch = document.querySelector<HTMLInputElement>('#composer-commit-branch')?.value.trim() ?? '';
  const message = document.querySelector<HTMLInputElement>('#composer-commit-message')?.value.trim() ?? '';
  if (!workspace || !message) {
    showToast(t('toast.commitNeedMessage'), true);
    return;
  }
  const root = activeProjectRoot() ?? workspace.path;
  const paths = (currentGitStatus?.entries ?? []).map((entry) => entry.path).filter(Boolean);
  try {
    if (branch && branch !== (currentGitStatus?.branch ?? '')) {
      await invoke('create_branch', { path: root, branchName: branch });
    }
    if (paths.length) await invoke('stage', { path: root, paths });
    await invoke('commit', { path: root, message });
    close();
    await refreshGitPanel();
    showToast(t('toast.commitCreated'));
  } catch (error) {
    showToast(t('toast.commitFail', { error: String(error) }), true);
    await refreshGitPanel();
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
      showToast(t('toast.worktreeNoChanges'));
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
    showToast(t('toast.needWorkspaceBranch'), true);
    return;
  }
  const root = activeProjectRoot() ?? workspace.path;
  let branches: GitBranch[];
  try {
    branches = await invoke<GitBranch[]>('branches', { path: root });
  } catch (error) {
    showToast(t('toast.branchesFail', { error: String(error) }), true);
    return;
  }
  const close = (): void => { modalRoot.innerHTML = ''; };
  modalRoot.innerHTML = '<div class="modal-backdrop" id="git-branch-backdrop"><section class="modal-panel git-branch-modal"><div class="modal-heading"><div><span class="eyebrow">' + tx('modal.gitBranches') + '</span><h2>' + tx('modal.switchBranch') + '</h2></div><button class="modal-close" id="git-branch-close" type="button">' + icons.close + '</button></div><p class="modal-copy">' + tx('modal.switchBranchCopy') + '</p><div class="git-branch-list">' + (branches.length ? branches.map((branch) => '<button class="git-branch-option ' + (branch.current ? 'is-current' : '') + '" data-git-branch="' + escapeHtml(branch.name) + '" type="button"><span><strong>' + escapeHtml(branch.name) + '</strong><small>' + escapeHtml(branch.upstream ? 'upstream: ' + branch.upstream : t('modal.localBranch')) + '</small></span>' + (branch.current ? '<em>' + tx('modal.current') + '</em>' : icons.chevron) + '</button>').join('') : '<div class="dock-empty">' + tx('modal.noLocalBranches') + '</div>') + '</div></section></div>';
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
      showToast(t('toast.branchSwitched', { branch: branchName }));
    } catch (error) {
      showToast(t('toast.branchFail', { error: String(error) }), true);
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
    return `<div class="workspace-list-row${active ? ' is-active' : ''}"><button class="workspace-list-item ${active ? 'workspace-list-item-active' : ''}" data-sidebar-workspace="${escapeHtml(workspace.id)}" type="button"><span class="workspace-list-dot"></span><span class="workspace-list-copy"><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(compactPathLabel(workspace.path))}</small></span>${badgeHtml}</button>${workspaceManageButtonHtml(workspace.id)}</div>`;
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
  if (!asaAgentList) return;
  const workspace = getWorkspace();
  const connected = providerAccounts.filter((account) => account.connected);
  if (!workspace) {
    asaAgentList.innerHTML = `<div class="asa-empty-state"><strong>${escapeHtml(t('chrome.noWorkspace'))}</strong><small>${escapeHtml(t('chrome.agentsNeedWorkspace'))}</small></div>`;
    return;
  }
  if (!connected.length) {
    asaAgentList.innerHTML = `<div class="asa-empty-state"><strong>${escapeHtml(t('chrome.noAgents'))}</strong><small>${escapeHtml(t('chrome.agentsEmptyHint'))}</small></div>`;
    return;
  }
  asaAgentList.innerHTML = connected.map((account) => {
    const detail = account.accountLabel || t('accounts.sessionHere');
    return `<article class="asa-agent-row"><span class="panel-icon panel-icon-orange">${escapeHtml((account.name.trim()[0] || '?').toUpperCase())}</span><span><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(detail)}</small></span><em>${escapeHtml(t('settings.connected'))}</em></article>`;
  }).join('');
}

function updateEditorStatusbar(): void {
  const cursor = document.querySelector<HTMLElement>('#editor-cursor-status');
  const meta = document.querySelector<HTMLElement>('#editor-file-meta');
  const position = codeEditor && openFilePath ? codeEditor.getPosition() : null;
  if (cursor) {
    cursor.hidden = !position;
    cursor.textContent = position ? `Ln ${position.lineNumber}, Col ${position.column}` : '';
  }
  if (meta) {
    if (openFilePath) {
      const languageId = codeEditor?.getModel()?.getLanguageId();
      meta.hidden = false;
      meta.textContent = languageId && languageId !== 'plaintext' ? `${languageId} · UTF-8` : 'UTF-8';
      meta.title = openFilePath;
    } else {
      meta.hidden = true;
      meta.textContent = '';
      meta.title = '';
    }
  }
}

function updateStatusbar(): void {
  const gitPill = document.querySelector<HTMLButtonElement>('#git-branch-status');
  if (gitPill) {
    if (currentGitStatus?.branch) {
      const dirty = (currentGitStatus.entries?.length ?? 0) > 0;
      gitPill.hidden = false;
      gitPill.textContent = dirty ? `${currentGitStatus.branch}*` : currentGitStatus.branch;
      gitPill.title = dirty
        ? `${currentGitStatus.entries.length} cambios en ${currentGitStatus.branch}`
        : `Rama ${currentGitStatus.branch}`;
    } else {
      gitPill.hidden = true;
      gitPill.textContent = '';
      gitPill.title = '';
    }
  }

  const live = sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id));
  const termPill = document.querySelector<HTMLElement>('#active-terminal-pill');
  const termCount = document.querySelector<HTMLElement>('#active-terminal-count');
  if (termPill && termCount) {
    if (live.length) {
      termPill.hidden = false;
      termCount.textContent = String(live.length);
      termPill.title = live.map((session) => `${session.name}${session.pid != null ? ` · PID ${session.pid}` : ''}`).join('\n');
    } else {
      termPill.hidden = true;
      termCount.textContent = '0';
      termPill.title = '';
    }
  }

  const runtime = document.querySelector<HTMLElement>('#runtime-usage-metric');
  if (runtime) {
    const active = getLiveSession(activeSessionId);
    if (active) {
      runtime.hidden = false;
      runtime.textContent = active.pid != null ? `${active.name} · PID ${active.pid}` : active.name;
      runtime.title = active.cwd;
    } else {
      runtime.hidden = true;
      runtime.textContent = '';
      runtime.title = '';
    }
  }

  updateEditorStatusbar();
}

function renderStatus(): void {
  const workspace = getWorkspace();
  const projectLabel = document.querySelector<HTMLElement>('#sidebar-project-label');
  const inspectorTitle = document.querySelector<HTMLElement>('#inspector-workspace-title');
  if (projectLabel && workspace) projectLabel.textContent = workspace.name;
  if (inspectorTitle && workspace) inspectorTitle.textContent = workspace.name;

  const activeTabTitle = document.querySelector<HTMLElement>('#active-tab-title');
  if (activeTabTitle) {
    const active = getLiveSession(activeSessionId);
    activeTabTitle.textContent = active ? active.name : (workspace ? workspace.name : 'ComesADE');
  }

  const titlebarName = document.querySelector<HTMLElement>('#titlebar-workspace-name');
  if (titlebarName) titlebarName.textContent = workspace?.name ?? 'ComesADE';
  updateStatusbar();
  renderAiContextBar();

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
  syncTerminalSurface();
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
  
  surface.innerHTML = `<header class="terminal-view-header" draggable="true" title="${tx('chrome.resizeTerminal')}"><div class="terminal-view-title"><span class="terminal-view-icon">${icons.terminal}</span><span><strong>${escapeHtml(session.name)}</strong>${branchHtml}<small>${escapeHtml(session.shell)} · ${escapeHtml(session.cwd)}</small></span></div><div class="terminal-view-actions"><span class="live-label" data-state="waiting"><i></i><span class="live-label-text">${tx('status.waiting')}</span></span><button class="icon-button terminal-control terminal-control-close" data-close-session="${session.id}" title="${tx('common.close')}" aria-label="${tx('common.close')}">${icons.close}</button></div></header><div class="terminal-pane" data-session-id="${session.id}"></div><div class="terminal-resize-handle" data-terminal-resize="${session.id}" role="separator" aria-label="${tx('chrome.resizeTerminal')}" title="${tx('chrome.resizeTerminal')}"></div>`;
  if (layoutState.view !== 'terminals') applySavedTerminalSize(session.id, surface);
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
          .then(() => showToast(t('toast.selectionCopied')))
          .catch((error) => showToast(t('toast.copySelectionFail', { error: String(error) }), true));
        return false;
      }
    }
    if (primary && (key === 'v' || (event.shiftKey && key === 'v'))) {
      void navigator.clipboard.readText()
        .then((value) => { if (value) return invoke('write_to_session', { sessionId: session.id, data: value }); return undefined; })
        .catch((error) => showToast(t('toast.pasteFail', { error: String(error) }), true));
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
  void (async () => {
    if (!(await prepareEditorForRootChange(nextRoot))) return;
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
  })();
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
    showToast(t('toast.needWorkspaceTerminal'), true);
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
    showToast(t('toast.sessionConnected', { name: session.name, shell: session.shell }));
    return session;
  } catch (error) {
    showToast(t('toast.sessionOpenFail', { error: String(error) }), true);
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
    showToast(t('toast.sessionCloseFail', { name: session.name, error: String(error) }), true);
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
    showToast(t('toast.ctrlCSent', { name: session.name }));
  } catch (error) {
    showToast(t('toast.interruptFail', { name: session.name, error: String(error) }), true);
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
    showToast(t('toast.localhostDetected'));
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
  modalRoot.innerHTML = '<div class="modal-backdrop" id="session-details-backdrop"><section class="modal-panel session-details-modal"><div class="modal-heading"><div><span class="eyebrow">' + tx('modal.runtimeSession') + '</span><h2>' + escapeHtml(session.name) + '</h2></div><button class="modal-close" id="session-details-close" type="button">' + icons.close + '</button></div><p class="modal-copy">' + tx('modal.sessionMetaCopy') + '</p><div class="session-details-grid">' + rows.map((row) => '<div class="session-detail"><span>' + row[0] + '</span><strong>' + row[1] + '</strong><small>' + row[2] + '</small></div>').join('') + '</div><div class="modal-actions"><button class="secondary-button" id="session-details-explorer" type="button">' + icons.external + '<span>' + tx('modal.openInExplorer') + '</span></button><button class="primary-button" id="session-details-done" type="button">' + tx('modal.done') + '</button></div></section></div>';
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
        else showToast(t('toast.noGitChanges'));
      } else if (action === 'remove') {
        if (!(await askConfirm('Esto cerrará el proceso real y quitará su definición guardada. ¿Continuar?', { title: 'Cerrar sesión', confirmLabel: 'Cerrar', danger: true }))) return;
        if (await closeSession(session.id)) removeSessionDefinition(session);
        render();
      }
    } catch (error) {
      showToast(t('toast.actionFail', { error: String(error) }), true);
    }
  });
}

function setView(view: string): void {
  const openingTools = view === 'tools';
  if (openingTools) {
    layoutState.workLayout = layoutState.workLayout === 'design' ? 'design' : 'browser';
  } else if (view === 'overview' && (layoutState.workLayout === 'browser' || layoutState.workLayout === 'design')) {
    layoutState.workLayout = 'code';
  }
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
  if (view === 'overview' && getWorkspace()) {
    composerCollapsed = false;
    layoutState.composerCollapsed = false;
    nativeAgentLog.hidden = false;
    document.querySelector('#native-agent-panel')?.classList.add('has-thread');
    syncComposerVisibility();
    window.requestAnimationFrame(() => nativeAgentInput.focus());
  }
  if (view === 'terminals') {
    ensureLiveTerminal();
    terminalArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (activeSessionId) terminals.get(activeSessionId)?.terminal.focus();
  }
  if (view === 'asa') asaOverview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (openingTools) {
    scheduleWebviewSync();
    if (localhostPanels.size + browserPanels.size === 0) openBrowserMenu();
  }
}

function navigateViewHistory(direction: -1 | 1): void {
  const next = viewHistoryIndex + direction;
  if (next < 0 || next >= viewHistory.length) {
    showToast(direction < 0 ? t('toast.noPrevView') : t('toast.noNextView'));
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
  showToast(sidebarSessionFilter === 'live' ? t('toast.showingLiveSessions') : t('toast.showingAllSessions'));
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
    showToast(t('toast.needWorkspaceInspector'), true);
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
  modalRoot.innerHTML = '<div class="modal-backdrop" id="help-backdrop"><section class="modal-panel"><div class="modal-heading"><div><span class="eyebrow">' + tx('modal.help') + '</span><h2>' + tx('modal.helpTitle') + '</h2></div><button class="modal-close" id="help-close" type="button">' + icons.close + '</button></div><p class="modal-copy">' + tx('modal.helpCopy') + '</p><div class="help-grid"><div><strong>Ctrl + Shift + P</strong><small>' + tx('modal.helpPalette') + '</small></div><div><strong>Ctrl + P</strong><small>' + tx('modal.helpFindFiles') + '</small></div><div><strong>Ctrl + `</strong><small>' + tx('modal.helpFocusTerminal') + '</small></div><div><strong>Ctrl + B</strong><small>' + tx('modal.helpToggleSidebar') + '</small></div><div><strong>Ctrl + Tab</strong><small>' + tx('modal.helpSwitchTerminal') + '</small></div><div><strong>Ctrl + S</strong><small>' + tx('modal.helpSaveFile') + '</small></div></div><div class="modal-actions"><button class="primary-button" id="help-done" type="button">' + tx('modal.done') + '</button></div></section></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#help-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#help-done')?.addEventListener('click', close);
}

function openFeedbackModal(): void {
  modalRoot.innerHTML = '<div class="modal-backdrop" id="feedback-backdrop"><form class="modal-panel" id="feedback-form"><div class="modal-heading"><div><span class="eyebrow">' + tx('modal.feedback') + '</span><h2>' + tx('modal.feedbackTitle') + '</h2></div><button class="modal-close" id="feedback-close" type="button">' + icons.close + '</button></div><p class="modal-copy">' + tx('modal.feedbackCopy') + '</p><textarea class="field-input feedback-input" id="feedback-input" rows="6" placeholder="' + tx('modal.feedbackPh') + '"></textarea><div class="modal-actions"><button class="secondary-button" id="feedback-cancel" type="button">' + tx('common.cancel') + '</button><button class="primary-button" id="feedback-copy" type="button">' + tx('modal.copyFeedback') + '</button></div></form></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#feedback-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#feedback-cancel')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#feedback-copy')?.addEventListener('click', async () => {
    const value = document.querySelector<HTMLTextAreaElement>('#feedback-input')?.value.trim();
    if (!value) { showToast(t('toast.feedbackEmpty'), true); return; }
    try {
      await navigator.clipboard.writeText(value);
      showToast(t('toast.feedbackCopied'));
      close();
    } catch (error) {
      showToast(t('toast.feedbackCopyFail', { error: String(error) }), true);
    }
  });
  document.querySelector<HTMLTextAreaElement>('#feedback-input')?.focus();
}

function openStatsModal(): void {
  const workspace = getWorkspace();
  const live = sessions.filter((session) => session.status === 'running' && !exitedSessions.has(session.id)).length;
  modalRoot.innerHTML = '<div class="modal-backdrop" id="stats-backdrop"><section class="modal-panel"><div class="modal-heading"><div><span class="eyebrow">' + tx('modal.stats') + '</span><h2>' + tx('modal.statsTitle') + '</h2></div><button class="modal-close" id="stats-close" type="button">' + icons.close + '</button></div><div class="stats-grid"><div><strong>' + String(live) + '</strong><small>' + tx('modal.liveSessions') + '</small></div><div><strong>' + String(localhostPanels.size + browserPanels.size) + '</strong><small>' + tx('modal.openPreviews') + '</small></div><div><strong>' + String(detectedEndpoints.size) + '</strong><small>' + tx('modal.detectedEndpoints') + '</small></div><div><strong id="stats-git">' + tx('modal.checking') + '</strong><small>' + tx('modal.gitChanges') + '</small></div></div><p class="modal-copy">' + tx('modal.workspaceNamed', { name: workspace?.name ?? t('modal.none') }) + '<br/>' + tx('modal.pathNamed', { path: workspace?.path ?? '—' }) + '</p><div class="modal-actions"><button class="secondary-button" id="stats-open-git" type="button">' + tx('modal.openGit') + '</button><button class="primary-button" id="stats-done" type="button">' + tx('modal.done') + '</button></div></section></div>';
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#stats-close')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#stats-done')?.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#stats-open-git')?.addEventListener('click', () => { close(); setInspectorTab('git'); });
  const statsTarget = document.querySelector<HTMLElement>('#stats-git');
  if (!workspace) { if (statsTarget) statsTarget.textContent = t('chrome.noWorkspace'); return; }
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
  toolTabs.innerHTML = panels.map((panel) => {
    const label = 'title' in panel && typeof panel.title === 'string' ? panel.title : new URL(panel.url).hostname;
    return `<button class="tool-tab ${panel.id === activeToolId ? 'tool-tab-active' : ''}" data-tool-id="${panel.id}" type="button">${escapeHtml(label)}<b data-close-tool="${panel.id}">${icons.close}</b></button>`;
  }).join('');
  toolEmpty.hidden = panels.length > 0;
  panels.forEach((panel) => panel.element.classList.toggle('tool-view-active', panel.id === activeToolId));
}

function scheduleWebviewSync(): void {
  scheduleLayoutSync();
}

function syncEmbeddedWebviews(): void {
  const modalOpen = modalRoot.childElementCount > 0;
  const panels = [...browserPanels.values(), ...localhostPanels.values()];
  for (const panel of panels) {
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

function createNativeBrowserWebview(panel: BrowserPanel | LocalhostPanel): void {
  const status = panel.element.querySelector<HTMLElement>('[data-tool-status]');
  try {
    visibleBrowserWebviews.delete(panel.id);
    browserWebviewGeometry.delete(panel.id);
    const webview = new Webview(currentAppWebview.window, panel.id, { url: panel.url, x: 0, y: 0, width: 8, height: 8, focus: false, dragDropEnabled: false, zoomHotkeysEnabled: true });
    panel.webview = webview;
    void webview.once('tauri://created', () => {
      if (status) status.textContent = 'LOADED';
      scheduleWebviewSync();
      if (designModeEnabled) void injectDesignPicker();
    });
    void webview.once('tauri://error', () => { if (status) status.textContent = 'ERROR'; showToast(t('toast.browserLoadFail'), true); });
    scheduleWebviewSync();
  } catch (error) {
    if (status) status.textContent = 'EXTERNAL';
    showToast(t('toast.browserCreateFail', { error: String(error) }), true);
  }
}

function createLocalhostPanel(rawUrl: string, requestedName?: string): void {
  const url = normalizeLocalhostUrl(rawUrl);
  if (!url) {
    showToast(t('toast.localhostInvalid'), true);
    return;
  }
  const existing = [...localhostPanels.values()].find((panel) => panel.url === url);
  if (existing) {
    activeToolId = existing.id;
    setWorkLayout(layoutState.workLayout === 'design' ? 'design' : 'browser');
    renderTools();
    scheduleWebviewSync();
    return;
  }
  const id = `localhost-${localhostSequence++}`;
  const label = requestedName?.trim() || new URL(url).host;
  const element = document.createElement('article');
  element.className = 'tool-view';
  element.dataset.toolId = id;
  element.innerHTML = `<header class="tool-view-header"><div class="tool-view-title">${icons.browser}<span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(url)}</small></span></div><div class="tool-view-actions"><span data-tool-status>LOADING</span><button class="icon-button" data-tool-refresh="${id}" title="Actualizar">${icons.refresh}</button><button class="icon-button" data-close-tool="${id}" title="Cerrar">${icons.close}</button></div></header><div class="tool-frame browser-frame" title="${escapeHtml(label)}"></div>`;
  const frame = element.querySelector<HTMLDivElement>('.browser-frame')!;
  toolStage.appendChild(element);
  const panel: LocalhostPanel = { id, url, element, frame, webview: null };
  localhostPanels.set(id, panel);
  createNativeBrowserWebview(panel);
  activeToolId = id;
  saveWorkspaceLayout({ localhostUrl: url });
  setWorkLayout(layoutState.workLayout === 'design' ? 'design' : 'browser');
  renderTools();
  showToast(t('toast.toolOpened', { name: label }));
  if (designModeEnabled) void injectDesignPicker();
}

function createBrowserPanel(rawUrl: string, requestedName?: string): void {
  const url = browserInputToUrl(rawUrl);
  if (!url) {
    showToast(t('toast.browserNeedUrl'), true);
    return;
  }
  const existing = [...browserPanels.values()].find((panel) => panel.url === url);
  if (existing) {
    activeToolId = existing.id;
    setWorkLayout(layoutState.workLayout === 'design' ? 'design' : 'browser');
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
  setWorkLayout(layoutState.workLayout === 'design' ? 'design' : 'browser');
  renderTools();
  showToast(t('toast.browserOpened', { name: title }));
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
  if (localhost) {
    if (localhost.webview) void localhost.webview.close().catch(() => undefined);
    localhost.webview = null;
    createNativeBrowserWebview(localhost);
  }
}

function closeLocalhostPanel(id: string): void {
  const panel = localhostPanels.get(id);
  if (!panel) return;
  visibleBrowserWebviews.delete(id);
  browserWebviewGeometry.delete(id);
  if (panel.webview) void panel.webview.close().catch(() => undefined);
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
  modalRoot.innerHTML = `<div class="modal-backdrop" id="browser-modal-backdrop"><form class="modal-panel browser-modal" id="browser-form"><div class="modal-heading"><div><span class="eyebrow">${tx('modal.toolsBrowser')}</span><h2>${tx('modal.openBrowser')}</h2></div><button class="modal-close" id="browser-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">${tx('modal.openBrowserCopy')}</p><label class="field-label" for="browser-url-input">${tx('modal.urlOrSearch')}</label><input class="field-input" id="browser-url-input" placeholder="${tx('modal.urlOrSearchPh')}" autocomplete="url"/><div class="quick-links"><button type="button" data-browser-link="https://www.google.com">Google</button><button type="button" data-browser-link="https://www.youtube.com">YouTube</button><button type="button" data-browser-link="https://github.com">GitHub</button><button type="button" data-browser-link="https://developer.mozilla.org">MDN</button></div><div class="modal-actions"><button class="secondary-button" id="browser-modal-cancel" type="button">${tx('common.cancel')}</button><button class="primary-button" type="submit">${icons.browser}<span>${tx('modal.openBrowser')}</span></button></div></form></div>`;
  const form = document.querySelector<HTMLFormElement>('#browser-form')!;
  const close = (): void => { modalRoot.innerHTML = ''; scheduleWebviewSync(); };
  document.querySelector<HTMLButtonElement>('#browser-modal-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#browser-modal-cancel')!.addEventListener('click', close);
  document.querySelectorAll<HTMLButtonElement>('[data-browser-link]').forEach((button) => button.addEventListener('click', () => { createBrowserPanel(button.dataset.browserLink ?? ''); close(); }));
  form.addEventListener('submit', (event) => { event.preventDefault(); createBrowserPanel(document.querySelector<HTMLInputElement>('#browser-url-input')?.value ?? ''); close(); });
  document.querySelector<HTMLInputElement>('#browser-url-input')!.focus();
}

function openLocalhostMenu(): void {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="localhost-modal-backdrop"><form class="modal-panel" id="localhost-form"><div class="modal-heading"><div><span class="eyebrow">${tx('modal.toolsPreview')}</span><h2>${tx('modal.openLocalhost')}</h2></div><button class="modal-close" id="localhost-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">${tx('modal.openLocalhostCopy')}</p><label class="field-label" for="localhost-url-input">${tx('modal.localAddress')}</label><input class="field-input" id="localhost-url-input" value="http://localhost:3000" placeholder="http://localhost:3000"/><label class="field-label" for="localhost-name-input">${tx('modal.nameOptional')}</label><input class="field-input" id="localhost-name-input" placeholder="${tx('modal.nameOptionalPh')}"/><div class="modal-actions"><button class="secondary-button" id="localhost-modal-cancel" type="button">${tx('common.cancel')}</button><button class="primary-button" type="submit">${icons.browser}<span>${tx('modal.openPreview')}</span></button></div></form></div>`;
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
      showToast(t('toast.worktreeCreateFail', { error: String(error) }), true);
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
    showToast(t('toast.needWorkspaceAgentLaunch'), true);
    return;
  }
  if (!detectedAgents.length) {
    try {
      detectedAgents = await invoke<AgentDefinition[]>('detect_agents');
      agentsDetectionReady = true;
      renderAsaOverview();
    } catch (error) {
      showToast(t('toast.agentsQueryFail', { error: String(error) }), true);
      return;
    }
  }
  const customAvailability = await Promise.all(appSettings.customAgents.map(async (agent) => ({
    agent,
    path: await invoke<string | null>('resolve_executable_path', { name: agent.executable }).catch(() => null),
  })));
  const orderedAgents = [...detectedAgents].sort((left, right) => Number(right.executable === appSettings.defaultAgent) - Number(left.executable === appSettings.defaultAgent) || left.name.localeCompare(right.name));
  const rows = orderedAgents.map((agent) => {
    const state = (agent.executable === appSettings.defaultAgent ? `${t('modal.default')} · ` : '') + (agent.installed ? t('modal.installed') : t('modal.notFound'));
    const disabled = agent.installed ? '' : ' disabled';
    return '<button class="agent-launch-row" data-agent-id="' + escapeHtml(agent.id) + '" type="button"' + disabled + '><span class="panel-icon panel-icon-orange">' + icons.bolt + '</span><span><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.executable) + '</small></span><i>' + escapeHtml(state) + '</i></button>';
  }).join('');
  const customRows = customAvailability.map(({ agent, path }) => {
    const state = path ? t('modal.installed') : t('modal.notFound');
    const disabled = path ? '' : ' disabled';
    return '<button class="agent-launch-row agent-launch-row-custom" data-custom-agent-id="' + escapeHtml(agent.id) + '" type="button"' + disabled + '><span class="panel-icon panel-icon-gray">' + icons.terminal + '</span><span><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.executable) + '</small></span><i>' + escapeHtml(state) + '</i></button>';
  }).join('');
  modalRoot.innerHTML = '<div class="modal-backdrop" id="agent-launch-backdrop"><section class="modal-panel agent-launch-modal"><div class="modal-heading"><div><span class="eyebrow">' + tx('modal.agentsCli') + '</span><h2>' + tx('modal.advancedCli') + '</h2></div><button class="modal-close" id="agent-launch-close" type="button">' + icons.close + '</button></div><p class="modal-copy">' + tx('modal.advancedCliCopy') + '</p><div class="agent-launch-list">' + (rows || '<div class="workspace-list-empty">' + tx('modal.noKnownAgents') + '</div>') + (customRows ? '<div class="agent-list-heading">' + tx('modal.savedCustomClis') + '</div>' + customRows : '') + '</div><div class="agent-custom-row"><label class="field-label" for="custom-agent-name">' + tx('modal.newCustomCli') + '</label><input class="field-input" id="custom-agent-name" placeholder="' + tx('modal.visibleNamePh') + '"/><input class="field-input" id="custom-agent-program" placeholder="' + tx('modal.executablePh') + '"/><input class="field-input" id="custom-agent-args" placeholder="' + tx('modal.argsPh') + '"/><button class="primary-button" id="custom-agent-launch" type="button">' + icons.terminal + '<span>' + tx('modal.launchCustom') + '</span></button></div></section></div>';
  const customRow = document.querySelector<HTMLElement>('.agent-custom-row');
  if (customRow) {
    const isolation = document.createElement('div');
    isolation.className = 'agent-isolation-options';
    isolation.innerHTML = '<label><input type="checkbox" id="agent-isolated-worktree"/> <span>' + tx('modal.isolatedWorktree') + '</span></label><input class="field-input" id="agent-base-branch" placeholder="' + tx('modal.baseBranchPh') + '"/>';
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
      showToast(t('toast.needCliExecutable'), true);
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
    showToast(t('toast.needWorkspaceTerminal'), true);
    return;
  }
  const availableShells = detectedShells.filter((shell) => shell.installed);
  const shells = availableShells.length ? availableShells : [fallbackShellDefinition()];
  modalRoot.innerHTML = `<div class="modal-backdrop" id="session-modal-backdrop"><form class="modal-panel" id="session-form"><div class="modal-heading"><div><span class="eyebrow">${tx('modal.terminalsProcess')}</span><h2>${tx('modal.openSession')}</h2></div><button class="modal-close" id="session-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">${tx('modal.openSessionCopy', { shell: activeShellName() })}</p><div class="auto-name-row"><span class="panel-icon panel-icon-orange">${icons.terminal}</span><span><strong>${tx('modal.autoName')}</strong><small>${tx('modal.autoNameHint')}</small></span></div><label class="field-label" for="session-cwd-input">${tx('modal.startDir')}</label><input class="field-input" id="session-cwd-input" placeholder="${tx('modal.startDirPh')}"/><div class="modal-actions"><button class="secondary-button" id="session-modal-cancel" type="button">${tx('common.cancel')}</button><button class="primary-button" type="submit">${icons.terminal}<span>${tx('modal.openShell', { shell: activeShellName() })}</span></button></div></form></div>`;
  const cwdInput = document.querySelector<HTMLInputElement>('#session-cwd-input');
  if (cwdInput) {
    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = t('modal.realShell');
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
  if (sessionDescription) sessionDescription.textContent = t('modal.openSessionCopy', { shell: activeShellName() });
  const sessionSubmit = document.querySelector<HTMLButtonElement>('#session-form button[type="submit"] span');
  if (sessionSubmit) sessionSubmit.textContent = t('modal.openShell', { shell: activeShellName() });
  const updateShellCopy = (): void => {
    const selectedId = document.querySelector<HTMLSelectElement>('#session-shell-input')?.value;
    const selectedShell = shells.find((shell) => shell.id === selectedId);
    const shellName = selectedShell?.name ?? activeShellName();
    if (sessionDescription) sessionDescription.textContent = t('modal.openSessionCopy', { shell: shellName });
    if (sessionSubmit) sessionSubmit.textContent = t('modal.openShell', { shell: shellName });
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
  if (!hasActiveSubscription()) {
    void ensureSignedInForDesktop();
    return;
  }
  modalRoot.innerHTML = `<div class="modal-backdrop" id="workspace-modal-backdrop"><form class="modal-panel" id="workspace-form"><div class="modal-heading"><div><span class="eyebrow">GITHUB / REPOSITORIO</span><h2>${escapeHtml(t('menu.create'))}</h2></div><button class="modal-close" id="workspace-modal-close" type="button">${icons.close}</button></div><p class="modal-copy">${escapeHtml(t('menu.createGithubCopy'))}</p><label class="field-label" for="workspace-name-input">${escapeHtml(t('menu.createName'))}</label><input class="field-input" id="workspace-name-input" placeholder="mi-proyecto" required/><label class="field-check" for="workspace-github-create"><input id="workspace-github-create" type="checkbox" checked/><span>${escapeHtml(t('menu.createOnGithub'))}</span></label><label class="field-label" for="workspace-path-input">${escapeHtml(t('menu.createLocalFolder'))}</label><input class="field-input" id="workspace-path-input" placeholder="${escapeHtml(t('menu.createLocalPlaceholder'))}"/><div class="modal-actions"><button class="secondary-button" id="workspace-modal-cancel" type="button">${escapeHtml(t('common.cancel'))}</button><button class="primary-button" type="submit">${icons.github}<span>${escapeHtml(t('menu.create'))}</span></button></div></form></div>`;
  const close = (): void => { modalRoot.innerHTML = ''; if (returnToMenu) openMainMenu(); };
  document.querySelector<HTMLButtonElement>('#workspace-modal-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#workspace-modal-cancel')!.addEventListener('click', close);
  document.querySelector<HTMLFormElement>('#workspace-form')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = document.querySelector<HTMLInputElement>('#workspace-name-input')!.value.trim();
    const requestedPath = document.querySelector<HTMLInputElement>('#workspace-path-input')!.value.trim();
    try {
      const createOnGithub = document.querySelector<HTMLInputElement>('#workspace-github-create')?.checked ?? true;
      if (!(await ensureSignedInForDesktop())) return;
      if (createOnGithub) {
        if (!githubAuth.connected) {
          showToast(t('menu.githubNeedAccount'), true);
          void connectGithubAccount();
          return;
        }
        if (!(await ensureGitAvailable())) return;
        const repository = await invoke<GithubRepository>('github_create_repository', {
          clientId: GITHUB_CLIENT_ID,
          name,
          private: true,
          description: null,
        });
        const basePath = requestedPath
          ? await invoke<string>('validate_workspace_path', { path: requestedPath })
          : await invoke<string>('default_workspace_path');
        const destination = joinWorkspacePath(basePath, repository.name);
        await invoke<string>('github_clone_repository', {
          clientId: GITHUB_CLIENT_ID,
          repository: repository.fullName,
          destination,
        });
        githubRepositoriesLoaded = false;
        modalRoot.innerHTML = '';
        await registerWorkspaceFromPath(destination, enterAfter);
        showToast(t('toast.githubCreatedCloned', { name: repository.fullName }));
        return;
      }
      const path = requestedPath ? await invoke<string>('validate_workspace_path', { path: requestedPath }) : await invoke<string>('default_workspace_path');
      if (!(await prepareEditorForRootChange(path))) return;
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
      else if (returnToMenu || !hasActiveSubscription()) openMainMenu();
      showToast(t('toast.workspaceReady', { name }));
    } catch (error) {
      showToast(String(error), true);
    }
  });
  document.querySelector<HTMLInputElement>('#workspace-name-input')!.focus();
}

function openCloneRepositoryModal(returnToMenu = true, enterAfter = true): void {
  if (!hasActiveSubscription()) {
    void ensureSignedInForDesktop();
    return;
  }
  let selectedRepository: GithubRepository | null = null;
  modalRoot.innerHTML = `<div class="modal-backdrop" id="clone-backdrop"><form class="modal-panel clone-modal" id="clone-form"><div class="modal-heading"><div><span class="eyebrow">${tx('modal.gitGithub')}</span><h2>${tx('modal.cloneRepo')}</h2></div><div class="github-modal-actions"><button class="secondary-button github-disconnect" id="github-disconnect" type="button">${tx('modal.disconnect')}</button><button class="modal-close" id="clone-close" type="button" aria-label="${tx('common.close')}">${icons.close}</button></div></div><p class="modal-copy">${tx('modal.cloneCopy')}</p><section class="github-repository-picker" aria-labelledby="github-repository-heading"><div class="github-repository-heading"><div><span class="eyebrow">${tx('modal.githubRepos')}</span><strong id="github-repository-heading">${tx('modal.availableRepos')}</strong><small id="github-repository-account">${tx('modal.checkingAccount')}</small></div><button class="secondary-button github-repository-refresh" id="github-repositories-refresh" type="button">${tx('modal.refresh')}</button></div><input class="field-input" id="github-repository-search" type="search" placeholder="${tx('modal.filterGithubPh')}" autocomplete="off" aria-label="${tx('modal.filterGithubAria')}"/><div class="github-repository-list" id="github-repository-list" role="listbox" aria-label="${tx('modal.githubReposAria')}"></div><div class="github-repository-selection" id="github-repository-selection" hidden></div></section><div class="clone-manual-fields"><label class="field-label" for="clone-url">${tx('modal.repoUrl')}</label><input class="field-input" id="clone-url" placeholder="https://github.com/owner/repository.git" required/><label class="field-label" for="clone-destination">${tx('modal.destination')}</label><input class="field-input" id="clone-destination" placeholder="C:\\Users\\...\\Documents\\repository" required/></div><div class="modal-actions"><button class="secondary-button" id="clone-cancel" type="button">${tx('common.cancel')}</button><button class="primary-button" type="submit">${icons.folder}<span>${tx('modal.clone')}</span></button></div></form></div>`;
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
    repositorySelection.innerHTML = `<strong>${tx('modal.selectedRepo')}</strong><span>${escapeHtml(selectedRepository.fullName)} · ${escapeHtml(selectedRepository.private ? t('modal.private') : t('modal.public'))}</span>`;
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
      showToast(t('toast.githubDisconnected'));
    } catch (error) {
      disconnectButton.disabled = false;
      showToast(t('toast.githubDisconnectFail', { error: String(error) }), true);
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
      showToast(t('toast.cloneOk'));
    } catch (error) {
      if (submit) submit.disabled = false;
      showToast(t('toast.cloneFail', { error: String(error) }), true);
    }
  });
  renderSelection();
  void loadGithubRepositories();
  repositorySearch.focus();
}

async function openSettingsModal(): Promise<void> {
  const returnToMenu = mainMenuOpen;
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
  const settingsShellChoices = (availableSettingsShells.length ? availableSettingsShells : [fallbackShellDefinition()]).map((shell) => `<option value="${escapeHtml(shell.id)}"${shell.id === appSettings.defaultShell ? ' selected' : ''}>${escapeHtml(shell.name + ' · ' + shell.executable)}</option>`).join('');
  const settingsAgentChoices = detectedAgents.filter((agent) => agent.installed).map((agent) => `<option value="${escapeHtml(agent.executable)}"${agent.executable === appSettings.defaultAgent ? ' selected' : ''}>${escapeHtml(agent.name + ' · ' + agent.executable)}</option>`).join('');
  const settingsEnvironmentText = escapeHtml(Object.entries(appSettings.environment).map(([key, value]) => key + '=' + value).join('\n'));
  const versionLabel = escapeHtml(appVersionLabel.textContent?.trim() || 'COMESADE');
  const updateStatus = availableAppUpdate
    ? t('settings.updateAvailable', { version: availableAppUpdate.version })
    : t('settings.updateNone');
  const closeLabel = returnToMenu ? t('common.backMenu') : t('common.close');
  document.body.classList.add('settings-open');
  modalRoot.innerHTML = `<div class="modal-backdrop" id="settings-backdrop"><section class="modal-panel settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description">
    <header class="settings-header">
      <div>
        <span class="eyebrow" data-i18n="settings.eyebrow">${escapeHtml(t('settings.eyebrow'))}</span>
        <h2 id="settings-title" data-i18n="settings.title">${escapeHtml(t('settings.title'))}</h2>
        <p class="modal-copy" id="settings-description" data-i18n="settings.description">${escapeHtml(t('settings.description'))}</p>
      </div>
      <button class="modal-close" id="settings-close" type="button" aria-label="${escapeHtml(t('common.close'))}">${icons.close}</button>
    </header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="${escapeHtml(t('settings.title'))}">
        <button class="settings-nav-item is-active" data-settings-pane="general" type="button" aria-current="page" data-i18n="settings.nav.general">${escapeHtml(t('settings.nav.general'))}</button>
        <button class="settings-nav-item" data-settings-pane="accounts" type="button" data-i18n="settings.nav.accounts">${escapeHtml(t('settings.nav.accounts'))}</button>
        <button class="settings-nav-item" data-settings-pane="runtime" type="button" data-i18n="settings.nav.runtime">${escapeHtml(t('settings.nav.runtime'))}</button>
        <button class="settings-nav-item" data-settings-pane="terminal" type="button" data-i18n="settings.nav.terminal">${escapeHtml(t('settings.nav.terminal'))}</button>
        <button class="settings-nav-item" data-settings-pane="workspace" type="button" data-i18n="settings.nav.workspace">${escapeHtml(t('settings.nav.workspace'))}</button>
        <button class="settings-nav-item" data-settings-pane="about" type="button" data-i18n="settings.nav.about">${escapeHtml(t('settings.nav.about'))}</button>
      </nav>
      <div class="settings-body">
        <section class="settings-pane" data-pane="general">
          <h3 data-i18n="lang.section">${escapeHtml(t('lang.section'))}</h3>
          <p class="settings-pane-copy" data-i18n="lang.sectionCopy">${escapeHtml(t('lang.sectionCopy'))}</p>
          <div class="setting-field settings-field-wide">
            <span>${escapeHtml(t('lang.section'))}</span>
            <div class="settings-choice-row" id="settings-language-choices" role="radiogroup" aria-label="${escapeHtml(t('lang.section'))}">
              ${[['auto', t('lang.autoShort')], ...APP_LOCALES.map((locale) => [locale, localeLabel(locale, currentLocale())] as const)].map(([value, label]) => `<button class="settings-choice${appSettings.uiLanguage === value ? ' is-active' : ''}" type="button" role="radio" aria-checked="${appSettings.uiLanguage === value ? 'true' : 'false'}" data-language="${escapeHtml(value)}">${escapeHtml(label)}</button>`).join('')}
            </div>
            <input type="hidden" id="settings-language" value="${escapeHtml(appSettings.uiLanguage)}"/>
            <small id="settings-language-hint">${escapeHtml(languageStatusText())}</small>
          </div>
          <h3 data-i18n="settings.appearance">${escapeHtml(t('settings.appearance'))}</h3>
          <p class="settings-pane-copy" data-i18n="settings.appearanceCopy">${escapeHtml(t('settings.appearanceCopy'))}</p>
          <label class="settings-toggle">
            <span><strong>${escapeHtml(t('settings.reduceMotion'))}</strong><small>${escapeHtml(t('settings.reduceMotionHint'))}</small></span>
            <input id="settings-reduce-motion" type="checkbox"${appSettings.backgroundAnimation ? '' : ' checked'}/>
          </label>
          <h3 data-i18n="settings.voice">${escapeHtml(t('settings.voice'))}</h3>
          <p class="settings-pane-copy" data-i18n="settings.voiceCopy">${escapeHtml(t('settings.voiceCopy'))}</p>
          <div class="setting-field settings-field-wide">
            <span>${escapeHtml(t('settings.microphone'))}</span>
            <div class="settings-mic-row">
              <select class="field-input" id="settings-microphone" aria-label="${escapeHtml(t('settings.microphone'))}"></select>
              <button class="secondary-button" id="settings-microphone-refresh" type="button">${escapeHtml(t('settings.microphoneRefresh'))}</button>
            </div>
            <small>${escapeHtml(t('settings.microphoneHint'))}</small>
          </div>
        </section>
        <section class="settings-pane" data-pane="accounts" hidden>
          <h3 data-i18n="settings.nav.accounts">${escapeHtml(t('settings.nav.accounts'))}</h3>
          <p class="settings-pane-copy" data-i18n="settings.accountsCopy">${escapeHtml(t('settings.accountsCopy'))}</p>
          <div class="settings-accounts-actions">
            <button class="secondary-button" id="settings-open-accounts" type="button" data-i18n="settings.openAgentAccounts">${escapeHtml(t('settings.openAgentAccounts'))}</button>
            <small data-i18n="settings.openAgentAccountsHint">${escapeHtml(t('settings.openAgentAccountsHint'))}</small>
          </div>
          <div id="settings-accounts-list" class="settings-accounts-list"></div>
        </section>
        <section class="settings-pane" data-pane="runtime" hidden>
          <h3 data-i18n="settings.runtime">${escapeHtml(t('settings.runtime'))}</h3>
          <p class="settings-pane-copy" data-i18n="settings.runtimeCopy">${escapeHtml(t('settings.runtimeCopy'))}</p>
          <div class="settings-grid">
            <label class="setting-field"><span>${escapeHtml(t('settings.shell'))}</span><select class="field-input" id="settings-shell">${settingsShellChoices}</select><small>${escapeHtml(t('settings.shellHint'))}</small></label>
            <label class="setting-field"><span>${escapeHtml(t('settings.agent'))}</span><select class="field-input" id="settings-agent"><option value=""${!appSettings.defaultAgent ? ' selected' : ''}>${escapeHtml(t('settings.agentManual'))}</option>${settingsAgentChoices}</select><small>${escapeHtml(t('settings.agentHint'))}</small></label>
          </div>
        </section>
        <section class="settings-pane" data-pane="terminal" hidden>
          <h3 data-i18n="settings.nav.terminal">${escapeHtml(t('settings.nav.terminal'))}</h3>
          <p class="settings-pane-copy" data-i18n="settings.terminalCopy">${escapeHtml(t('settings.terminalCopy'))}</p>
          <div class="settings-grid">
            <label class="setting-field"><span>${escapeHtml(t('settings.font'))}</span><input class="field-input" id="settings-font" value="${escapeHtml(appSettings.terminalFont)}"/><small>${escapeHtml(t('settings.fontHint'))}</small></label>
            <label class="setting-field"><span>${escapeHtml(t('settings.size'))}</span><input class="field-input" id="settings-font-size" type="number" min="10" max="28" value="${String(appSettings.terminalFontSize)}"/><small>${escapeHtml(t('settings.sizeHint'))}</small></label>
            <label class="setting-field"><span>${escapeHtml(t('settings.cursor'))}</span><select class="field-input" id="settings-cursor"><option value="bar"${appSettings.terminalCursor === 'bar' ? ' selected' : ''}>${escapeHtml(t('settings.cursorBar'))}</option><option value="block"${appSettings.terminalCursor === 'block' ? ' selected' : ''}>${escapeHtml(t('settings.cursorBlock'))}</option><option value="underline"${appSettings.terminalCursor === 'underline' ? ' selected' : ''}>${escapeHtml(t('settings.cursorUnderline'))}</option></select><small>${escapeHtml(t('settings.cursorHint'))}</small></label>
            <label class="setting-field"><span>${escapeHtml(t('settings.scrollback'))}</span><input class="field-input" id="settings-scrollback" type="number" min="1000" max="100000" step="1000" value="${String(appSettings.terminalScrollback)}"/><small>${escapeHtml(t('settings.scrollbackHint'))}</small></label>
          </div>
        </section>
        <section class="settings-pane" data-pane="workspace" hidden>
          <h3 data-i18n="settings.nav.workspace">${escapeHtml(t('settings.nav.workspace'))}</h3>
          <p class="settings-pane-copy" data-i18n="settings.workspaceCopy">${escapeHtml(t('settings.workspaceCopy'))}</p>
          <label class="setting-field settings-field-wide"><span>${escapeHtml(t('settings.worktree'))}</span><input class="field-input" id="settings-worktree" placeholder="${escapeHtml(t('settings.worktreePlaceholder'))}" value="${escapeHtml(appSettings.worktreeDirectory)}"/><small>${escapeHtml(t('settings.worktreeHint'))}</small></label>
          <label class="setting-field settings-field-wide"><span>${escapeHtml(t('settings.env'))}</span><small>${escapeHtml(t('settings.envHint'))}</small><textarea class="field-input settings-environment" id="settings-environment" spellcheck="false">${settingsEnvironmentText}</textarea></label>
        </section>
        <section class="settings-pane" data-pane="about" hidden>
          <h3 data-i18n="settings.nav.about">${escapeHtml(t('settings.nav.about'))}</h3>
          <p class="settings-pane-copy" data-i18n="settings.aboutCopy">${escapeHtml(t('settings.aboutCopy'))}</p>
          <div class="settings-about-card">
            <span class="eyebrow">${escapeHtml(t('settings.install'))}</span>
            <strong>${versionLabel}</strong>
            <small>${escapeHtml(t('settings.platform', { platform: runtimePlatform.os || 'local', shell: runtimePlatform.defaultShellName || runtimePlatform.defaultShell }))}</small>
            <p>${updateStatus}</p>
          </div>
          <div class="settings-info">
            <span class="panel-icon panel-icon-gray">${icons.bolt}</span>
            <span><strong>${escapeHtml(t('settings.localFirst'))}</strong><small>${escapeHtml(t('settings.localFirstHint'))}</small></span>
          </div>
          <button class="secondary-button" id="settings-check-update" type="button">${escapeHtml(t('settings.checkUpdate'))}</button>
        </section>
      </div>
    </div>
    <div class="modal-actions">
      <button class="secondary-button" id="settings-back" type="button">${closeLabel}</button>
      <button class="primary-button" id="settings-save" type="button" data-i18n="common.save">${escapeHtml(t('common.save'))}</button>
    </div>
  </section></div>`;

  const showSettingsPane = (paneId: string): void => {
    document.querySelectorAll<HTMLButtonElement>('.settings-nav-item').forEach((button) => {
      const active = button.dataset.settingsPane === paneId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.querySelectorAll<HTMLElement>('.settings-pane').forEach((pane) => {
      pane.hidden = pane.dataset.pane !== paneId;
    });
  };
  document.querySelectorAll<HTMLButtonElement>('.settings-nav-item').forEach((button) => {
    button.addEventListener('click', () => showSettingsPane(button.dataset.settingsPane ?? 'general'));
  });
  renderSettingsAccounts();
  void Promise.all([refreshGithubAuth(), refreshProviderAccounts()]).then(() => renderSettingsAccounts());
  const languageInput = document.querySelector<HTMLInputElement>('#settings-language');
  document.querySelectorAll<HTMLButtonElement>('#settings-language-choices [data-language]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.language ?? 'auto';
      if (languageInput) languageInput.value = value;
      document.querySelectorAll<HTMLButtonElement>('#settings-language-choices [data-language]').forEach((item) => {
        const active = item === button;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      languagePreferenceDraft = isLanguagePreference(value) ? value : 'auto';
      void refreshAppLanguage({ waitForIp: languagePreferenceDraft === 'auto' });
    });
  });
  document.querySelector('#settings-open-accounts')?.addEventListener('click', () => {
    closeSettings('accounts');
  });
  const microphoneSelect = document.querySelector<HTMLSelectElement>('#settings-microphone');
  const fillMicrophones = async (): Promise<void> => {
    if (!microphoneSelect) return;
    const selected = microphoneSelect.value || appSettings.microphoneId;
    const devices = await listMicrophones();
    const options = [`<option value="">${escapeHtml(t('settings.microphoneDefault'))}</option>`];
    for (const device of devices) {
      options.push(`<option value="${escapeHtml(device.id)}"${device.id === selected ? ' selected' : ''}>${escapeHtml(device.label)}</option>`);
    }
    if (selected && !devices.some((device) => device.id === selected)) {
      options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(t('settings.microphoneMissing'))}</option>`);
    }
    microphoneSelect.innerHTML = options.join('');
    const hasSelected = Array.from(microphoneSelect.options).some((option) => option.value === selected);
    microphoneSelect.value = selected && hasSelected ? selected : '';
  };
  void fillMicrophones();
  document.querySelector('#settings-microphone-refresh')?.addEventListener('click', () => {
    void fillMicrophones().catch((error) => showToast(String(error), true));
  });
  microphoneSelect?.addEventListener('change', () => {
    setSelectedMicrophoneId(microphoneSelect.value.trim());
  });
  const onMicrophoneDevicesChanged = (): void => {
    void fillMicrophones();
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', onMicrophoneDevicesChanged);
  document.querySelector('#settings-accounts-list')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-close-account]');
    if (!button || button.disabled) return;
    void closeSettingsAccount(button);
  });

  const closeSettings = (next: 'idle' | 'accounts' = 'idle'): void => {
    window.removeEventListener('keydown', onSettingsKey);
    navigator.mediaDevices?.removeEventListener?.('devicechange', onMicrophoneDevicesChanged);
    document.body.classList.remove('settings-open');
    if (languagePreferenceDraft !== null) {
      languagePreferenceDraft = null;
      applyAppLanguage();
    }
    if (next === 'accounts') {
      void openAccountsModal();
      return;
    }
    if (returnToMenu || !hasActiveSubscription()) openMainMenu();
    else {
      modalRoot.innerHTML = '';
      scheduleWebviewSync();
    }
  };
  function onSettingsKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSettings();
    }
  }
  window.addEventListener('keydown', onSettingsKey);

  const checkUpdateButton = document.querySelector<HTMLButtonElement>('#settings-check-update');
  checkUpdateButton?.addEventListener('click', async () => {
    if (!checkUpdateButton) return;
    checkUpdateButton.disabled = true;
    checkUpdateButton.textContent = t('settings.checking');
    try {
      await checkForAppUpdate(true);
    } finally {
      if (document.body.contains(checkUpdateButton)) {
        checkUpdateButton.disabled = false;
        checkUpdateButton.textContent = t('settings.checkUpdate');
      }
    }
  });
  document.querySelector<HTMLButtonElement>('#settings-close')!.addEventListener('click', () => closeSettings());
  document.querySelector<HTMLButtonElement>('#settings-back')!.addEventListener('click', () => closeSettings());
  document.querySelector<HTMLButtonElement>('#settings-save')!.addEventListener('click', () => {
    const environment: Record<string, string> = {};
    const rawEnvironment = document.querySelector<HTMLTextAreaElement>('#settings-environment')?.value ?? '';
    for (const line of rawEnvironment.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const separator = line.indexOf('=');
      const key = separator >= 0 ? line.slice(0, separator).trim() : '';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        showToast(t('settings.invalidEnv'), true);
        showSettingsPane('workspace');
        document.querySelector<HTMLTextAreaElement>('#settings-environment')?.focus();
        return;
      }
      environment[key] = line.slice(separator + 1).slice(0, 4000);
    }
    const cursorValue = document.querySelector<HTMLSelectElement>('#settings-cursor')?.value ?? 'bar';
    const terminalCursor: AppSettings['terminalCursor'] = cursorValue === 'block' || cursorValue === 'underline' ? cursorValue : 'bar';
    const parsedFontSize = Number.parseInt(document.querySelector<HTMLInputElement>('#settings-font-size')?.value ?? '', 10);
    const parsedScrollback = Number.parseInt(document.querySelector<HTMLInputElement>('#settings-scrollback')?.value ?? '', 10);
    const languageValue = document.querySelector<HTMLInputElement>('#settings-language')?.value ?? 'auto';
    appSettings = {
      ...appSettings,
      geminiTheme: false,
      backgroundAnimation: !(document.querySelector<HTMLInputElement>('#settings-reduce-motion')?.checked ?? false),
      defaultShell: document.querySelector<HTMLSelectElement>('#settings-shell')?.value.trim() || runtimePlatform.defaultShell,
      defaultAgent: document.querySelector<HTMLSelectElement>('#settings-agent')?.value.trim() ?? '',
      terminalFont: document.querySelector<HTMLInputElement>('#settings-font')?.value.trim().slice(0, 160) || defaultTerminalFont(),
      terminalFontSize: Number.isFinite(parsedFontSize) ? Math.min(Math.max(parsedFontSize, 10), 28) : appSettings.terminalFontSize,
      terminalCursor,
      terminalScrollback: Number.isFinite(parsedScrollback) ? Math.min(Math.max(parsedScrollback, 1000), 100000) : appSettings.terminalScrollback,
      worktreeDirectory: document.querySelector<HTMLInputElement>('#settings-worktree')?.value.trim().slice(0, 500) ?? '',
      environment,
      uiLanguage: isLanguagePreference(languageValue) ? languageValue : 'auto',
      microphoneId: document.querySelector<HTMLSelectElement>('#settings-microphone')?.value.trim() ?? '',
    };
    setSelectedMicrophoneId(appSettings.microphoneId);
    languagePreferenceDraft = null;
    saveSettings();
    applySettings();
    void refreshAppLanguage({ waitForIp: appSettings.uiLanguage === 'auto' });
    closeSettings();
    showToast(t('settings.saved'));
  });
  document.querySelector<HTMLButtonElement>('.settings-nav-item.is-active')?.focus();
}

function settingsAccountsHtml(): string {
  const rows: string[] = [];
  if (comesSession?.token) {
    const subLabel = comesSession.subscriptionActive
      ? (comesSession.status ? t('settings.subStatus', { status: comesSession.status }) : t('settings.subActive'))
      : t('settings.subNone');
    rows.push(`<article class="settings-account-row"><div><strong>ComesADE</strong><small>${escapeHtml(comesSession.email ?? t('settings.localSession'))} · ${escapeHtml(subLabel)}</small></div><button class="text-action text-action-danger" data-close-account="comesade" type="button">${escapeHtml(t('settings.closeAccount'))}</button></article>`);
  }
  if (githubAuth.connected) {
    const label = githubAuth.login ? `@${githubAuth.login}` : 'GitHub';
    rows.push(`<article class="settings-account-row"><div><strong>GitHub</strong><small>${escapeHtml(label)}</small></div><button class="text-action text-action-danger" data-close-account="github" type="button">${escapeHtml(t('settings.closeAccount'))}</button></article>`);
  }
  for (const account of providerAccounts.filter((item) => item.connected)) {
    const label = account.accountLabel ?? account.authMode ?? t('settings.connected');
    rows.push(`<article class="settings-account-row"><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(label)}</small></div><button class="text-action text-action-danger" data-close-account="provider" data-close-provider="${escapeHtml(account.id)}" type="button">${escapeHtml(t('settings.closeAccount'))}</button></article>`);
  }
  if (!rows.length) {
    return `<div class="settings-accounts-empty">${escapeHtml(t('settings.noAccounts'))}</div>`;
  }
  return rows.join('');
}

function renderSettingsAccounts(): void {
  const list = document.querySelector('#settings-accounts-list');
  if (!list) return;
  list.innerHTML = settingsAccountsHtml();
}

async function closeSettingsAccount(button: HTMLButtonElement): Promise<void> {
  const kind = button.dataset.closeAccount;
  button.disabled = true;
  try {
    if (kind === 'comesade') {
      await signOutComesAccount();
      showToast(t('toast.accountClosedComes'));
    } else if (kind === 'github') {
      await invoke('github_disconnect');
      githubRepositories = [];
      githubRepositoriesLoaded = false;
      githubRepositoriesError = null;
      await refreshGithubAuth();
      showToast(t('toast.accountClosedGithub'));
    } else if (kind === 'provider' && button.dataset.closeProvider) {
      const provider = button.dataset.closeProvider;
      const name = providerAccounts.find((account) => account.id === provider)?.name ?? provider;
      await invoke('provider_disconnect', { provider });
      await refreshProviderAccounts();
      showToast(t('toast.accountClosedProvider', { name }));
    }
  } catch (error) {
    showToast(t('toast.accountCloseFail', { error: String(error) }), true);
  } finally {
    if (!hasActiveSubscription()) {
      document.body.classList.remove('settings-open');
      openMainMenu();
      showToast(t('toast.sessionClosedNeedSub'));
      return;
    }
    renderSettingsAccounts();
  }
}

function workspaceMenuListHtml(): string {
  if (!workspaces.length) return `<div class="workspace-list-empty">${escapeHtml(t('menu.emptyList'))}</div>`;
  return workspaces.map((workspace) => {
    const active = workspace.id === activeWorkspaceId;
    return `<div class="workspace-list-row${active ? ' is-active' : ''}"><button class="workspace-list-item ${active ? 'workspace-list-item-active' : ''}" data-workspace-id="${escapeHtml(workspace.id)}" type="button"><span class="panel-icon panel-icon-gray">${icons.folder}</span><span><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(compactPathLabel(workspace.path))}</small></span>${active ? `<span class="workspace-list-active">${escapeHtml(t('menu.active'))}</span>` : ''}</button>${workspaceManageButtonHtml(workspace.id)}</div>`;
  }).join('');
}

function openMainMenu(): void {
  if (bootSplashActive) return;
  if (!hasActiveSubscription()) {
    openComesAuthScreen();
    return;
  }
  setMainMenuOpen(true);
  closeAccountMenu();
  updateWorkspaceView();
  renderTitlebarAccount();
  const workspace = getWorkspace();
  const footerStatus = workspace
    ? t('menu.footerReady')
    : workspaces.length
      ? t('menu.footerPick')
      : t('menu.footer');
  const workspaceCount = workspaces.length === 1 ? t('menu.savedOne') : t('menu.savedMany', { count: workspaces.length });
  const runtimeState = connectionState.textContent?.trim() || 'LOCAL / STARTING';
  const currentWorkspace = workspace
    ? `<button class="main-menu-current main-menu-workspace-card" id="main-menu-current" type="button" aria-label="${escapeHtml(workspace.name)}"><span class="panel-icon panel-icon-orange">${icons.folder}</span><span class="main-menu-workspace-copy"><span class="main-menu-workspace-label">${escapeHtml(t('menu.current'))}</span><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(compactPathLabel(workspace.path))}</small></span><span class="main-menu-workspace-state"><i></i><span>${escapeHtml(t('menu.enterDesktop'))}</span></span></button>`
    : `<div class="main-menu-current main-menu-current-empty"><span class="panel-icon panel-icon-gray">${icons.folder}</span><span class="main-menu-workspace-copy"><span class="main-menu-workspace-label">${escapeHtml(t('menu.current'))}</span><strong>${escapeHtml(t('menu.noneSelected'))}</strong><small>${escapeHtml(t('menu.noneHint'))}</small></span><span class="main-menu-workspace-state"><i class="is-empty"></i><span>${escapeHtml(t('menu.notSelected'))}</span></span></div>`;
  modalRoot.innerHTML = `<div class="modal-backdrop main-menu-backdrop" id="main-menu-backdrop" role="dialog" aria-modal="true" aria-labelledby="main-menu-title" aria-describedby="main-menu-copy">
    <section class="main-menu-panel">
      <header class="main-menu-topline">
        <div class="main-menu-brand">
          <div class="brand-mark"><img src="${comesadeLogoUrl}" alt="" aria-hidden="true" /></div>
          <span><strong>ComesADE</strong><small>${escapeHtml(t('menu.desktop'))}</small></span>
        </div>
        <div class="main-menu-local-state"><i></i><span>${escapeHtml(runtimeState)}</span></div>
      </header>
      <div class="main-menu-layout">
        <div class="main-menu-hero">
          <div class="main-menu-hero-copy">
            <span class="eyebrow">${escapeHtml(t('menu.eyebrow'))}</span>
            <h2 id="main-menu-title">${escapeHtml(t('menu.title'))}</h2>
            <p class="main-menu-copy" id="main-menu-copy">${escapeHtml(t('menu.copy'))}</p>
          </div>
          <div class="main-menu-hint"><kbd>LOCAL</kbd><span>${escapeHtml(t('menu.local'))}</span></div>
        </div>
        <div class="main-menu-stage">
          <section class="main-menu-tools">
            <div class="main-menu-section-heading"><span>${escapeHtml(t('menu.workspace'))}</span><small>${escapeHtml(workspaceCount)}</small></div>
            ${currentWorkspace}
            <div class="workspace-browser-picker main-menu-picker">
              <button class="secondary-button" id="main-menu-pick" type="button">${icons.folder}<span>${escapeHtml(t('menu.pickFolder'))}</span></button>
              <small>${escapeHtml(t('menu.pickHint'))}</small>
            </div>
            <div class="workspace-list-modal main-menu-workspace-shelf" id="main-menu-workspace-list">${workspaceMenuListHtml()}</div>
            <div class="main-menu-section-heading main-menu-actions-heading"><span>${escapeHtml(t('menu.startHere'))}</span><small>${escapeHtml(t('menu.startHint'))}</small></div>
            <div class="main-menu-actions">
              <button class="main-menu-action" id="main-menu-signin" type="button"><span class="panel-icon panel-icon-orange">${icons.sparkle}</span><span><strong>${escapeHtml(t('menu.aiAccounts'))}</strong><small>${escapeHtml(t('menu.aiHint'))}</small></span>${icons.chevron}</button>
              <button class="main-menu-action" id="main-menu-create" type="button"><span class="panel-icon panel-icon-orange">${icons.add}</span><span><strong>${escapeHtml(t('menu.create'))}</strong><small>${escapeHtml(t('menu.createHint'))}</small></span>${icons.chevron}</button>
              <button class="main-menu-action" id="main-menu-clone" type="button"><span class="panel-icon panel-icon-gray">${icons.external}</span><span><strong>${escapeHtml(t('menu.clone'))}</strong><small>${escapeHtml(t('menu.cloneHint'))}</small></span>${icons.chevron}</button>
              <button class="main-menu-action" id="main-menu-settings" type="button"><span class="panel-icon panel-icon-blue">${icons.settings}</span><span><strong>${escapeHtml(t('common.settings'))}</strong><small>${escapeHtml(t('menu.settingsHint'))}</small></span>${icons.chevron}</button>
            </div>
          </section>
          <section class="main-menu-deck">
            <div class="main-menu-github">
              <div class="main-menu-section-heading main-menu-github-heading">
                <span id="main-menu-github-count">${escapeHtml(t('menu.github'))}</span>
                <small id="main-menu-github-account">${escapeHtml(githubAuth.connected ? `@${githubAuth.login ?? 'github'}` : t('menu.githubNeedAccount'))}</small>
              </div>
              <div class="github-repository-list main-menu-github-list" id="main-menu-github-list">${githubRepositoryRowsHtml()}</div>
              ${githubAuth.connected
                ? `<button class="secondary-button main-menu-github-refresh" id="main-menu-github-refresh" type="button">${escapeHtml(t('menu.githubRefresh'))}</button>`
                : `<button class="primary-button" id="main-menu-github-connect" type="button">${icons.github}<span>${escapeHtml(t('menu.githubConnect'))}</span></button>`}
            </div>
          </section>
        </div>
      </div>
      <footer class="main-menu-footer"><span><i></i>${escapeHtml(footerStatus)}</span></footer>
    </section>
  </div>`;
  syncMainMenuRuntimeState();
  document.querySelector<HTMLButtonElement>('#main-menu-current')?.addEventListener('click', () => {
    const current = getWorkspace();
    if (current) void activateWorkspace(current, true);
  });
  document.querySelector<HTMLButtonElement>('#main-menu-pick')?.addEventListener('click', () => {
    void pickAndOpenWorkspace(true, true);
  });
  const menuList = document.querySelector<HTMLElement>('#main-menu-workspace-list');
  if (menuList) bindMainMenuWorkspaceList(menuList);
  document.querySelector<HTMLButtonElement>('#main-menu-github-connect')?.addEventListener('click', () => { void connectGithubAccount(); });
  document.querySelector<HTMLButtonElement>('#main-menu-github-refresh')?.addEventListener('click', () => { void loadGithubRepositories(true); });
  document.querySelector<HTMLElement>('#main-menu-github-list')?.addEventListener('click', (event) => {
    const fullName = (event.target as HTMLElement).closest<HTMLElement>('[data-github-repository]')?.dataset.githubRepository;
    if (!fullName) return;
    const repository = githubRepositories.find((candidate) => candidate.fullName === fullName);
    if (!repository) return;
    void openOrCloneGithubRepository(repository, true).catch((error) => {
      showToast(t('toast.openRepoFail', { name: repository.fullName, error: String(error) }), true);
    });
  });
  void loadGithubRepositories();
  document.querySelector<HTMLButtonElement>('#main-menu-signin')?.addEventListener('click', () => { void openAccountsModal(); });
  document.querySelector<HTMLButtonElement>('#main-menu-create')?.addEventListener('click', () => openWorkspaceModal(true, true));
  document.querySelector<HTMLButtonElement>('#main-menu-clone')?.addEventListener('click', () => openCloneRepositoryModal(true, true));
  document.querySelector<HTMLButtonElement>('#main-menu-settings')?.addEventListener('click', openSettingsModal);
  (document.querySelector<HTMLButtonElement>('#main-menu-current') ?? document.querySelector<HTMLButtonElement>('#main-menu-pick'))?.focus();
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
  modalRoot.innerHTML = `<div class="modal-backdrop" id="runtime-backdrop"><section class="modal-panel"><div class="modal-heading"><div><span class="eyebrow">${escapeHtml(t('runtime.eyebrow'))}</span><h2>${escapeHtml(t('runtime.title'))}</h2></div><button class="modal-close" id="runtime-close" type="button">${icons.close}</button></div><p class="modal-copy">${escapeHtml(t('runtime.copy', { shell: activeShellName() }))}</p><div class="runtime-details"><div><span>${escapeHtml(t('chrome.workspace'))}</span><strong>${escapeHtml(workspace?.name ?? t('chrome.noWorkspace'))}</strong></div><div><span>${escapeHtml(t('chrome.path'))}</span><strong>${escapeHtml(workspace?.path ?? '—')}</strong></div><div><span>${escapeHtml(t('runtime.liveSessions'))}</span><strong>${liveSessionCount}</strong></div></div><div class="runtime-session-list">${sessions.length ? sessions.map((session) => `<div class="runtime-session-row"><span class="session-avatar">${escapeHtml(session.name.charAt(0))}</span><span><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.cwd)}</small></span><button class="text-action" data-runtime-focus="${session.id}" type="button">${escapeHtml(t('runtime.focus'))}</button><button class="text-action text-action-danger" data-runtime-close="${session.id}" type="button">${escapeHtml(t('common.close'))}</button></div>`).join('') : `<div class="workspace-list-empty">${escapeHtml(t('runtime.noSessions'))}</div>`}</div><div class="modal-actions"><button class="primary-button" id="runtime-done" type="button">${escapeHtml(t('runtime.done'))}</button></div></section></div>`;
  const close = (): void => { modalRoot.innerHTML = ''; };
  document.querySelector<HTMLButtonElement>('#runtime-close')!.addEventListener('click', close);
  document.querySelector<HTMLButtonElement>('#runtime-done')!.addEventListener('click', close);
  document.querySelectorAll<HTMLButtonElement>('[data-runtime-focus]').forEach((button) => button.addEventListener('click', () => { activateSession(button.dataset.runtimeFocus ?? ''); close(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-runtime-close]').forEach((button) => button.addEventListener('click', async () => { await closeSession(button.dataset.runtimeClose ?? ''); openRuntimeModal(); }));
}

function openCommandPalette(): void {
  modalRoot.innerHTML = `<div class="modal-backdrop" id="palette-backdrop"><form class="modal-panel command-palette" id="palette-form"><div class="modal-heading"><div><span class="eyebrow">${escapeHtml(t('palette.eyebrow'))}</span><h2>${escapeHtml(t('palette.title'))}</h2></div><button class="modal-close" id="palette-close" type="button">${icons.close}</button></div><input class="field-input palette-input" id="palette-input" placeholder="${escapeHtml(t('palette.ph'))}" autocomplete="off"/><div class="palette-list">${sessions.map((session) => `<button type="button" data-palette-session="${session.id}">${icons.terminal}<span><strong>${escapeHtml(session.name)}</strong><small>${escapeHtml(session.cwd)}</small></span>${icons.chevron}</button>`).join('') || `<span class="palette-empty">${escapeHtml(t('palette.empty'))}</span>`}</div></form></div>`;
  const paletteList = document.querySelector<HTMLElement>('.palette-list');
  if (paletteList) {
    const commands = [
      ['new-agent', 'New Agent CLI', 'Launch an installed CLI in a real PTY'],
      ['composer', 'Open Chat', 'Focus the agent chat with editor context'],
      ['inline-edit', 'Inline Edit', 'Edit the current selection with the agent'],
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
    else if (command === 'composer') focusComposer();
    else if (command === 'inline-edit') startInlineEdit();
    else if (command === 'new-terminal') openSessionMenu();
    else if (command === 'open-file') void openSearchModal();
    else if (command === 'switch-workspace') openMainMenu();
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
      else showToast(t('toast.selectAgentFirst'), true);
    } else if (command === 'kill-agent') {
      if (activeSessionId) void closeSession(activeSessionId);
      else showToast(t('toast.selectProcessFirst'), true);
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
    if (value) showToast(t('toast.selectShellFirst'), true);
  });
  paletteInput.focus();
}

async function openSearchModal(): Promise<void> {
  const workspace = getWorkspace();
  if (!workspace) {
    showToast(t('toast.needWorkspaceSearch'), true);
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
      setWidth(startWidth + moveEvent.clientX - startX);
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
    setWidth(layoutState.inspectorWidth + (event.key === 'ArrowRight' ? 16 : -16));
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
  aiAccountsCard.addEventListener('click', () => { void openAccountsModal(); });
  document.querySelector<HTMLButtonElement>('#asa-accounts')?.addEventListener('click', () => { void openAccountsModal(); });
  document.querySelector<HTMLButtonElement>('#titlebar-layout-picker')?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.shiftKey) {
      openLayoutPicker();
      return;
    }
    toggleDesignMode();
  });
  nativeAgentForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendNativeAgentMessage();
  });
  nativeAgentInput.addEventListener('input', resizeNativeAgentInput);
  nativeAgentProvider.addEventListener('change', () => {
    syncComposerPlaceholder();
    renderComposerUsage();
    renderComposerModel();
    renderComposerAccount();
  });
  document.querySelector<HTMLButtonElement>('#composer-account')?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (document.querySelector('.account-picker-menu')) {
      closeAccountPicker();
      return;
    }
    openAccountPicker();
  });
  nativeAgentModel.addEventListener('click', (event) => {
    event.stopPropagation();
    if (nativeAgentModel.getAttribute('aria-expanded') === 'true') {
      closeModelPicker();
      return;
    }
    openModelPicker();
  });
  nativeAgentEfforts.addEventListener('click', (event) => {
    const effort = (event.target as HTMLElement).closest<HTMLElement>('[data-effort]')?.dataset.effort;
    const account = providerAccounts.find((item) => item.id === nativeAgentProvider.value && item.connected);
    const selected = selectedModelChoice(account);
    if (!effort || !account || !selected || !selected.option.efforts.includes(effort)) return;
    setSelectedChoice(account.id, selected.option.id, effort);
  });
  document.querySelector<HTMLButtonElement>('#composer-usage')?.addEventListener('click', () => { void openAccountsModal(); });
  resizeNativeAgentInput();
  syncComposerPlaceholder();
  nativeAgentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendNativeAgentMessage();
    }
  });
  nativeAgentCancel.addEventListener('click', () => { void cancelNativeAgent(); });
  document.querySelector<HTMLButtonElement>('#composer-hide')?.addEventListener('click', () => { toggleComposer(); });
  document.querySelector<HTMLButtonElement>('#titlebar-composer-toggle')?.addEventListener('click', () => { toggleComposer(); });
  document.querySelector<HTMLButtonElement>('#titlebar-focus-mode')?.addEventListener('click', toggleFocusMode);
  document.querySelector<HTMLButtonElement>('#titlebar-zen-ai')?.addEventListener('click', toggleZenAi);
  document.querySelector<HTMLButtonElement>('#ai-attach-context')?.addEventListener('click', () => { void openSearchModal(); });
  const composerMic = document.querySelector<HTMLButtonElement>('#composer-mic');
  const composerSttLang = document.querySelector<HTMLSelectElement>('#composer-stt-lang');
  const composerTts = document.querySelector<HTMLButtonElement>('#composer-tts');
  if (composerMic && composerSttLang) {
    bindComposerSpeech({
      input: nativeAgentInput,
      mic: composerMic,
      lang: composerSttLang,
      resize: resizeNativeAgentInput,
      toast: showToast,
      canStart: () => {
        if (!comesSession?.email || !comesSession.token) return 'Inicia sesión en ComesADE para usar voz.';
        if (isUnlimitedSpeechQuota(speechQuota, comesSession.email)) return null;
        if (!speechQuota || (speechQuota.limit ?? 0) <= 0) return 'Necesitas un plan Starter, Pro o Advanced para usar voz.';
        if ((speechQuota.remaining ?? 0) < 1) {
          return 'Se agotaron los tokens de voz. Se reinician al pagar la suscripción.';
        }
        return null;
      },
      transcribe: transcribeComesSpeech,
      listening: document.querySelector<HTMLElement>('#composer-listening'),
      listeningBars: document.querySelector<HTMLElement>('#composer-listening-bars'),
    });
    syncSttLangButton();
    composerSttLang.addEventListener('change', syncSttLangButton);
  }
  document.querySelector<HTMLButtonElement>('#composer-stt-lang-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (document.querySelector('.stt-lang-menu')) {
      closeSttLangPicker();
      return;
    }
    openSttLangPicker();
  });
  composerTts?.addEventListener('click', (event) => {
    event.preventDefault();
    speakAgentReply();
  });
  document.querySelector<HTMLButtonElement>('#composer-accounts')?.addEventListener('click', () => { void openAccountsModal(); });
  document.querySelector<HTMLButtonElement>('#composer-changes')?.addEventListener('click', () => { setInspectorTab('git'); });
  document.querySelector<HTMLButtonElement>('#composer-commit-action')?.addEventListener('click', () => { openComposerCommitModal(); });
  document.querySelector<HTMLButtonElement>('#composer-git-branch')?.addEventListener('click', () => { void openGitBranchMenu(); });
  document.querySelectorAll<HTMLButtonElement>('[data-activity]').forEach((button) => {
    button.addEventListener('click', () => { setActivity(button.dataset.activity ?? 'explorer'); });
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
    else showToast(t('toast.noActiveSessionClose'), true);
  });
  onClick('#inspector-tab-files', () => setInspectorTab('explorer'));
  onClick('#inspector-tab-tools', () => setView('tools'));
  */
  document.querySelector<HTMLButtonElement>('#titlebar-layout')?.addEventListener('click', toggleSidebar);
  document.querySelector<HTMLButtonElement>('#titlebar-more')?.addEventListener('click', () => openMainMenu());
  document.querySelector<HTMLButtonElement>('#titlebar-back')?.addEventListener('click', () => navigateViewHistory(-1));
  document.querySelector<HTMLButtonElement>('#titlebar-forward')?.addEventListener('click', () => navigateViewHistory(1));
  document.querySelector<HTMLButtonElement>('#titlebar-update')?.addEventListener('click', openAppUpdateModal);
  document.querySelector<HTMLButtonElement>('#titlebar-account')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleAccountMenu();
  });
  document.querySelector<HTMLButtonElement>('#titlebar-inspector-toggle')?.addEventListener('click', toggleInspector);
  document.querySelector<HTMLButtonElement>('#split-pane-btn-left')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#split-pane-btn-right')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#close-pane-btn-left')?.addEventListener('click', () => {
    if (activeSessionId) void closeSession(activeSessionId);
    else showToast(t('toast.noActiveTerminal'), true);
  });
  document.querySelector<HTMLButtonElement>('#close-pane-btn-right')?.addEventListener('click', () => {
    if (activeSessionId) void closeSession(activeSessionId);
    else showToast(t('toast.noActiveTerminal'), true);
  });
  document.querySelector<HTMLButtonElement>('#sidebar-filter-btn')?.addEventListener('click', toggleSidebarSessionFilter);
  document.querySelector<HTMLButtonElement>('#sidebar-help')?.addEventListener('click', openHelpModal);
  document.querySelector<HTMLButtonElement>('#sidebar-feedback')?.addEventListener('click', openFeedbackModal);
  document.querySelector<HTMLButtonElement>('#sidebar-stats')?.addEventListener('click', openStatsModal);
  document.querySelector<HTMLButtonElement>('#refresh-workspace-btn')?.addEventListener('click', () => {
    if (!getWorkspace()) { showToast(t('toast.needWorkspaceRefresh'), true); return; }
    void Promise.all([syncRuntimeSessions(), refreshWorkspacePanels()])
      .then(() => showToast(t('toast.workspaceRefreshed')))
      .catch((error) => showToast(t('toast.workspaceRefreshFail', { error: String(error) }), true));
  });
  document.querySelector<HTMLButtonElement>('#inspector-view-sort')?.addEventListener('click', toggleFileSort);
  document.querySelector<HTMLButtonElement>('#inspector-more')?.addEventListener('click', openInspectorActionsMenu);
  document.querySelector<HTMLButtonElement>('#floating-layout-toggle')?.addEventListener('click', toggleInspector);
  document.querySelector<HTMLButtonElement>('#filter-names-btn')?.addEventListener('click', () => setInspectorFilterMode('names'));
  document.querySelector<HTMLButtonElement>('#filter-content-btn')?.addEventListener('click', () => setInspectorFilterMode('content'));
  commandForm.addEventListener('submit', async (event) => { event.preventDefault(); const command = commandInput.value.trim(); if (!command || !activeSessionId || !getWorkspace()) { showToast(t('toast.needWorkspaceShell'), true); return; } try { await writeToSession(activeSessionId, `${command}\r`); commandInput.value = ''; terminals.get(activeSessionId)?.terminal.focus(); } catch (error) { showToast(String(error), true); } });
  document.querySelector<HTMLButtonElement>('#summary-sessions')?.addEventListener('click', () => {
    setView('terminals');
    terminalArea.scrollIntoView({ block: 'nearest' });
    if (activeSessionId) terminals.get(activeSessionId)?.terminal.focus();
    else if (getWorkspace()) openSessionMenu();
    else showToast(t('toast.needWorkspaceOpenTerminal'), true);
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
      showToast(t('toast.noActiveFolder'), true);
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
  inspectorGitContent.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const stagePath = target.closest<HTMLElement>('[data-git-stage]')?.dataset.gitStage;
    const unstagePath = target.closest<HTMLElement>('[data-git-unstage]')?.dataset.gitUnstage;
    const discardPath = target.closest<HTMLElement>('[data-git-discard]')?.dataset.gitDiscard;
    const path = target.closest<HTMLElement>('[data-git-path]')?.dataset.gitPath;
    const workspace = getWorkspace();
    if (!workspace) return;
    const root = gitActionRoot() ?? workspace.path;
    if (stagePath) {
      void invoke('stage', { path: root, paths: [stagePath] }).then(() => refreshGitPanel()).catch((error) => showToast(String(error), true));
      return;
    }
    if (unstagePath) {
      void invoke('unstage', { path: root, paths: [unstagePath] }).then(() => refreshGitPanel()).catch((error) => showToast(String(error), true));
      return;
    }
    if (discardPath) {
      void (async () => {
        if (!(await askConfirm('Esto descartará los cambios reales del archivo. ¿Continuar?', { title: 'Descartar cambios', confirmLabel: 'Descartar', danger: true }))) return;
        try {
          await invoke('discard', { path: root, paths: [discardPath] });
          await refreshGitPanel();
        } catch (error) {
          showToast(String(error), true);
        }
      })();
      return;
    }
    if (path) void loadGitDiff(path);
  });
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
  document.querySelector<HTMLButtonElement>('#git-branch-status')?.addEventListener('click', () => {
    if (!currentGitStatus?.branch) return;
    setInspectorTab('git');
    void openGitBranchMenu();
  });
  gitList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const stagePath = target.closest<HTMLElement>('[data-git-stage]')?.dataset.gitStage;
    const unstagePath = target.closest<HTMLElement>('[data-git-unstage]')?.dataset.gitUnstage;
    const discardPath = target.closest<HTMLElement>('[data-git-discard]')?.dataset.gitDiscard;
    const path = target.closest<HTMLElement>('[data-git-path]')?.dataset.gitPath;
    const workspace = getWorkspace();
    if (!workspace) return;
    if (stagePath) {
      void invoke('stage', { path: gitActionRoot() ?? workspace.path, paths: [stagePath] }).then(() => refreshGitPanel()).catch((error) => showToast(String(error), true));
      return;
    }
    if (unstagePath) {
      void invoke('unstage', { path: gitActionRoot() ?? workspace.path, paths: [unstagePath] }).then(() => refreshGitPanel()).catch((error) => showToast(String(error), true));
      return;
    }
    if (discardPath) {
      void (async () => {
        if (!(await askConfirm('Esto descartará los cambios reales del archivo. ¿Continuar?', { title: 'Descartar cambios', confirmLabel: 'Descartar', danger: true }))) return;
        try {
          await invoke('discard', { path: gitActionRoot() ?? workspace.path, paths: [discardPath] });
          await refreshGitPanel();
        } catch (error) {
          showToast(String(error), true);
        }
      })();
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
        showToast(t('toast.worktreeMergeBusy', { name: owner.name }), true);
        return;
      }
      void (async () => {
        if (!(await askConfirm('Esto fusionará la rama real ' + mergeBranch + ' en el workspace principal. ¿Continuar?', { title: 'Fusionar worktree', confirmLabel: 'Fusionar' }))) return;
        try {
          await invoke('merge_worktree', { path: workspace.path, branchName: mergeBranch });
          await refreshGitPanel();
          showToast(t('toast.worktreeMerged'));
        } catch (error) {
          showToast(t('toast.worktreeMergeFail', { error: String(error) }), true);
          void refreshGitPanel();
        }
      })();
      return;
    }
    const path = target.closest<HTMLElement>('[data-remove-worktree]')?.dataset.removeWorktree;
    if (!path || !workspace) return;
    const owner = sessions.find((session) => Boolean(session.worktree && sameFsPath(session.worktree, path) && session.status === 'running'));
    if (owner) {
      showToast(t('toast.worktreeRemoveBusy', { name: owner.name }), true);
      return;
    }
    void (async () => {
      if (!(await askConfirm('Esto eliminará el worktree Git real y su carpeta. ¿Continuar?', { title: 'Quitar worktree', confirmLabel: 'Eliminar', danger: true }))) return;
      try {
        await invoke('worktree_remove', { path: workspace.path, worktreePath: path });
        await refreshWorktrees();
      } catch (error) {
        showToast(String(error), true);
      }
    })();
  });
  gitCommit.addEventListener('click', async () => {
    const workspace = getWorkspace();
    const message = gitCommitMessage.value.trim();
    if (!workspace || !message) {
      showToast(t('toast.commitNeedBoth'), true);
      return;
    }
    try {
      await invoke('commit', { path: activeProjectRoot() ?? workspace.path, message });
      gitCommitMessage.value = '';
      await refreshGitPanel();
      showToast(t('toast.commitCreated'));
    } catch (error) {
      showToast(t('toast.commitFail', { error: String(error) }), true);
    }
  });
  workspaceList.addEventListener('click', (event) => {
    const manage = (event.target as HTMLElement).closest<HTMLElement>('[data-workspace-manage]');
    if (manage) {
      event.preventDefault();
      event.stopPropagation();
      openWorkspaceManageMenu(event as MouseEvent, manage.dataset.workspaceManage ?? '');
      return;
    }
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
  document.querySelector<HTMLButtonElement>('#start-explore')?.addEventListener('click', () => {
    focusComposer('Explora este workspace y resume cómo está organizado el código, con archivos reales.');
  });
  document.querySelector<HTMLButtonElement>('#start-build')?.addEventListener('click', () => {
    focusComposer('Quiero construir una feature. Propón un plan y empieza por los archivos reales de este workspace.');
  });
  document.querySelector<HTMLButtonElement>('#sidebar-tab-plugins')?.addEventListener('click', () => { void openAccountsModal(); });
  document.querySelector<HTMLButtonElement>('#sidebar-tab-projects')?.addEventListener('click', () => {
    if (layoutState.sidebarCollapsed) {
      layoutState.sidebarCollapsed = false;
      applyLayout();
      saveLayout();
    }
  });
  document.querySelector<HTMLButtonElement>('#tools-new-localhost')?.addEventListener('click', openLocalhostMenu);
  document.querySelector<HTMLButtonElement>('#tools-new-browser')?.addEventListener('click', openBrowserMenu);
  document.querySelector<HTMLButtonElement>('#design-mode-toggle')?.addEventListener('click', () => toggleDesignMode());
  document.querySelector<HTMLElement>('#design-toolbar')?.addEventListener('click', (event) => {
    const tool = (event.target as HTMLElement).closest<HTMLElement>('[data-design-tool]')?.dataset.designTool;
    if (tool === 'select' || tool === 'draw') {
      designTool = tool;
      renderDesignToolbar();
      if (designModeEnabled) void injectDesignPicker();
      return;
    }
    const remove = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-pick]')?.dataset.removePick;
    if (remove != null) {
      designPicks.splice(Number(remove), 1);
      renderDesignToolbar();
    }
  });
  document.querySelector<HTMLElement>('#composer-captures')?.addEventListener('click', (event) => {
    const remove = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-pick]')?.dataset.removePick;
    if (remove == null) return;
    designPicks.splice(Number(remove), 1);
    renderDesignToolbar();
  });
  document.querySelector<HTMLButtonElement>('#design-clear')?.addEventListener('click', () => {
    designPicks = [];
    renderDesignToolbar();
  });
  document.querySelector<HTMLButtonElement>('#design-to-chat')?.addEventListener('click', sendDesignPicksToChat);
  document.querySelector<HTMLButtonElement>('#open-workspace-menu')?.addEventListener('click', () => openMainMenu());
  document.querySelector<HTMLButtonElement>('#sidebar-open-workspaces')!.addEventListener('click', () => openMainMenu());
  activeWorkspaceCard.addEventListener('click', () => openMainMenu());
  document.querySelector<HTMLButtonElement>('#sidebar-settings')!.addEventListener('click', openSettingsModal);
  document.querySelector<HTMLButtonElement>('#rail-settings')?.addEventListener('click', openSettingsModal);
  document.querySelector<HTMLButtonElement>('#sidebar-search')?.addEventListener('click', () => { void openSearchModal(); });
  document.querySelector<HTMLButtonElement>('#sidebar-runtime')?.addEventListener('click', openRuntimeModal);
  document.querySelector<HTMLButtonElement>('#sidebar-new-session')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#header-new-session')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#header-new-agent')?.addEventListener('click', () => { focusComposer(); });
  document.querySelector<HTMLButtonElement>('#workspace-summary-agent')?.addEventListener('click', () => { focusComposer(); });
  document.querySelector<HTMLButtonElement>('#asa-new-agent')?.addEventListener('click', () => { void openAgentMenu(); });
  document.querySelector<HTMLButtonElement>('#asa-new-terminal')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#terminal-new')?.addEventListener('click', openSessionMenu);
  document.querySelector<HTMLButtonElement>('#terminal-empty-new')?.addEventListener('click', () => { void createSession(); });
  document.querySelector<HTMLButtonElement>('#workspace-lock-open')?.addEventListener('click', () => openMainMenu());
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
    if (event.key === 'Escape' && accountMenuRoot.innerHTML) {
      event.preventDefault();
      closeAccountMenu();
      return;
    }
    if (mainMenuOpen) return;
    if (terminalOwnsKeyboard(event) && !(event.ctrlKey && event.key === 'Tab')) return;
    const key = event.key.toLowerCase();
    const primary = primaryModifier(event);
    if (primary && event.shiftKey && key === 'd') { event.preventDefault(); toggleDesignMode(); return; }
    if (primary && event.shiftKey && key === 'p') { event.preventDefault(); openCommandPalette(); return; }
    if (primary && event.altKey && key === 'z') { event.preventDefault(); toggleZenAi(); return; }
    if (primary && event.altKey && key === 'f') { event.preventDefault(); toggleFocusMode(); return; }
    if (primary && key === 'l') { event.preventDefault(); toggleComposer(true); return; }
    if (primary && key === 'k' && !event.shiftKey) { event.preventDefault(); startInlineEdit(); return; }
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
  loadComesSession();
  loadSelectedAgentModels();
  loadWorkspaces();
  loadLayout();
  loadSessionDefinitions();
  notesLoadedWorkspaceId = undefined;
  updateWorkspaceView();
  if (document.getElementById('main-menu-backdrop')) openMainMenu();
}

function bootMotionReduced(): boolean {
  return app.classList.contains('motion-off') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function loadBootLogo(): Promise<HTMLImageElement> {
  const image = document.querySelector<HTMLImageElement>('#boot-logo');
  if (!image) return Promise.reject(new Error('No hay logo de arranque.'));
  if (image.complete && image.naturalWidth > 0) return Promise.resolve(image);
  return new Promise((resolve, reject) => {
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('No se pudo cargar el logo.')), { once: true });
  });
}

function explodeBootLogo(image: HTMLImageElement, canvas: HTMLCanvasElement): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve();
  const sample = 168;
  const offscreen = document.createElement('canvas');
  offscreen.width = sample;
  offscreen.height = sample;
  const off = offscreen.getContext('2d');
  if (!off) return Promise.resolve();
  off.drawImage(image, 0, 0, sample, sample);
  const pixels = off.getImageData(0, 0, sample, sample).data;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(window.innerWidth * dpr));
  const height = Math.max(1, Math.round(window.innerHeight * dpr));
  canvas.width = width;
  canvas.height = height;
  canvas.hidden = false;
  const logoBox = image.getBoundingClientRect();
  const originX = (logoBox.left + logoBox.width / 2) * dpr;
  const originY = (logoBox.top + logoBox.height / 2) * dpr;
  const logoScale = (Math.max(logoBox.width, logoBox.height) / sample) * dpr;
  const reach = Math.hypot(window.innerWidth, window.innerHeight) * dpr;
  const particles: { x: number; y: number; vx: number; vy: number; size: number; r: number; g: number; b: number; a: number }[] = [];
  const step = 4;
  const cx = sample / 2;
  const cy = sample / 2;
  for (let y = 0; y < sample; y += step) {
    for (let x = 0; x < sample; x += step) {
      const index = (y * sample + x) * 4;
      const alpha = pixels[index + 3];
      if (alpha < 36) continue;
      if (pixels[index] < 16 && pixels[index + 1] < 16 && pixels[index + 2] < 22) continue;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy) || 1;
      const burst = 0.55 + Math.random() * 1.15;
      particles.push({
        x: originX + dx * logoScale,
        y: originY + dy * logoScale,
        vx: (dx / dist) * burst * reach,
        vy: ((dy / dist) * burst - 0.08) * reach,
        size: Math.max(1.4, step * logoScale * 0.72),
        r: pixels[index],
        g: pixels[index + 1],
        b: pixels[index + 2],
        a: alpha / 255,
      });
    }
  }
  const duration = 1100;
  const started = performance.now();
  return new Promise((resolve) => {
    const frame = (now: number): void => {
      const elapsed = now - started;
      const t = Math.min(1, elapsed / duration);
      ctx.clearRect(0, 0, width, height);
      for (const particle of particles) {
        const px = particle.x + particle.vx * t;
        const py = particle.y + particle.vy * t + 90 * dpr * t * t;
        ctx.fillStyle = `rgba(${particle.r},${particle.g},${particle.b},${particle.a * (1 - t)})`;
        ctx.fillRect(px, py, particle.size, particle.size);
      }
      if (t < 1) {
        window.requestAnimationFrame(frame);
        return;
      }
      ctx.clearRect(0, 0, width, height);
      canvas.hidden = true;
      resolve();
    };
    window.requestAnimationFrame(frame);
  });
}

async function playBootSplash(): Promise<void> {
  const splash = document.querySelector<HTMLElement>('#boot-splash');
  const logo = document.querySelector<HTMLImageElement>('#boot-logo');
  const canvas = document.querySelector<HTMLCanvasElement>('#boot-pixels');
  const wordmark = document.querySelector<HTMLElement>('#boot-wordmark');
  if (!splash || !logo || !canvas || !wordmark) return;
  splash.classList.add('is-visible');
  let skipped = false;
  const skip = (): void => { skipped = true; };
  splash.addEventListener('click', skip);
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') skip();
  };
  window.addEventListener('keydown', onKey);
  try {
    await loadBootLogo().catch(() => undefined);
    logo.classList.add('is-in');
    await waitMs(bootMotionReduced() ? 280 : 720);
    if (!skipped && !bootMotionReduced()) {
      logo.classList.add('is-out');
      await explodeBootLogo(logo, canvas);
    } else {
      logo.classList.add('is-out');
    }
    wordmark.hidden = false;
    wordmark.classList.add('is-in');
    await waitMs(bootMotionReduced() ? 420 : 980);
  } finally {
    splash.removeEventListener('click', skip);
    window.removeEventListener('keydown', onKey);
  }
}

async function dismissBootSplash(): Promise<void> {
  const splash = document.querySelector<HTMLElement>('#boot-splash');
  if (!splash) return;
  splash.classList.add('is-done');
  await waitMs(bootMotionReduced() ? 80 : 380);
  splash.remove();
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
        showToast(t('toast.watcherFail', { error: String(error) }), true);
      }
    }

    try {
      const leftover = await invoke<SessionInfo[]>('list_sessions');
      await Promise.all(leftover.map((session) => invoke('close_session', { sessionId: session.id }).catch(() => undefined)));
      for (const session of leftover) ignoredSessionIds.add(session.id);
      await syncRuntimeSessions();
    } catch (error) {
      showToast(t('toast.runtimeFail', { error: String(error) }), true);
    }

    try {
      [detectedAgents, detectedShells] = await Promise.all([
        invoke<AgentDefinition[]>('detect_agents'),
        invoke<ShellDefinition[]>('detect_shells'),
      ]);
      agentsDetectionReady = true;
      normalizeDefaultShell();
      render();
      void refreshProviderAccounts().then(() => loadProviderUsage());
    } catch (error) {
      showToast(t('toast.detectFail', { error: String(error) }), true);
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
    showToast(t('toast.eventsFail', { error: String(eventsResult.reason) }), true);
  }

  try {
    await hydration;
    refreshPersistedUi();
  } catch {
    // hydrateNativePersistence ya conserva el fallback de localStorage.
  }

  void refreshGithubAuth();
  void refreshProviderAccounts();
  await finishAuthorizedStartup();
}

async function initialize(): Promise<void> {
  document.body.classList.add('boot-pending');
  bindInteractions();
  loadSelectedAgentModels();
  renderGithubAuthState();
  renderProviderAccountCard();
  loadSettings();
  const languageTask = refreshAppLanguage({ waitForIp: true });
  loadWorkspaces();
  loadLayout();
  loadSessionDefinitions();
  updateWorkspaceView();
  setLocalRuntimeState('LOCAL / STARTING');
  setApiConnectionState('API / CHECKING');
  startApiMonitor();
  startAppUpdateChecker();
  try {
    await playBootSplash();
  } finally {
    await languageTask;
    bootSplashActive = false;
    loadComesSession();
    openMainMenu();
    await waitForPaint();
    await dismissBootSplash();
    document.body.classList.remove('boot-pending');
  }
  try {
    await finishStartup();
    await refreshComesSubscription();
  } catch (error) {
    showToast(t('toast.bootFail', { error: String(error) }), true);
  }
  if (!hasActiveSubscription() || document.getElementById('main-menu-backdrop')) openMainMenu();
  void Promise.all([refreshGithubAuth(), refreshProviderAccounts()]).then(() => {
    if (document.getElementById('main-menu-backdrop') || !hasActiveSubscription()) openMainMenu();
  });
}

async function connectEvents(): Promise<UnlistenFn[]> {
  const outputUnlisten = await listen<TerminalOutput>('terminal-output', (event) => handleOutput(event.payload));
  const statusUnlisten = await listen<TerminalStatusEvent>('terminal-status', (event) => handleStatus(event.payload));
  const exitUnlisten = await listen<TerminalExit>('terminal-exit', (event) => handleExit(event.payload));
  const fileUnlisten = await listen<WorkspaceFileChange>('workspace-file-change', (event) => handleWorkspaceFileChange(event.payload));
  const agentDeltaUnlisten = await listen<{ requestId: string; text: string }>('agent-delta', (event) => handleAgentDelta(event.payload));
  const agentToolUnlisten = await listen<{ requestId: string; name: string; input: string; output: string }>('agent-tool', (event) => handleAgentTool(event.payload));
  const agentDoneUnlisten = await listen<{ requestId: string; error: string | null }>('agent-done', (event) => handleAgentDone(event.payload));
  const oauthUnlisten = await listen<ProviderStatus>('provider-oauth-complete', (event) => {
    applyProviderStatus(event.payload);
  });
  const usageUnlisten = await listen<UsageSnapshot>('agent-usage', (event) => {
    applyUsageSnapshot(event.payload);
  });
  const designUnlisten = await listen<DesignPick>('design-pick', (event) => handleDesignPick(event.payload));
  return [outputUnlisten, statusUnlisten, exitUnlisten, fileUnlisten, agentDeltaUnlisten, agentToolUnlisten, agentDoneUnlisten, oauthUnlisten, usageUnlisten, designUnlisten];
}

void initialize();
