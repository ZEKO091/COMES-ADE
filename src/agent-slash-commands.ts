export type SlashMode = 'local' | 'forward';

export type SlashCommand = {
  /** Command name without leading slash */
  name: string;
  mode: SlashMode;
  labelKey: string;
  hintKey: string;
  /** When selected from the menu, insert `/name ` so the user can type args */
  needsArgs?: boolean;
  /** When selected from the menu, submit immediately */
  autoSend?: boolean;
};

export type ParsedSlashCommand = {
  name: string;
  args: string;
  mode: SlashMode;
  command: SlashCommand;
};

const local = (
  name: string,
  labelKey: string,
  hintKey: string,
  extra: Partial<Pick<SlashCommand, 'needsArgs' | 'autoSend'>> = {},
): SlashCommand => ({
  name,
  mode: 'local',
  labelKey,
  hintKey,
  autoSend: extra.autoSend ?? true,
  needsArgs: extra.needsArgs,
});

const forward = (
  name: string,
  labelKey: string,
  hintKey: string,
  extra: Partial<Pick<SlashCommand, 'needsArgs' | 'autoSend'>> = {},
): SlashCommand => ({
  name,
  mode: 'forward',
  labelKey,
  hintKey,
  autoSend: extra.autoSend ?? true,
  needsArgs: extra.needsArgs,
});

/** Local commands shared by every provider (compact is provider-specific). */
const LOCAL_CORE: SlashCommand[] = [
  local('help', 'slash.help', 'slash.helpHint'),
  local('clear', 'slash.clear', 'slash.clearHint'),
  local('model', 'slash.model', 'slash.modelHint'),
  local('account', 'slash.account', 'slash.accountHint'),
];

const LOCAL_COMPACT = local('compact', 'slash.compact', 'slash.compactLocalHint');

const ANTHROPIC_FORWARD: SlashCommand[] = [
  forward('compact', 'slash.compact', 'slash.compactForwardHint'),
  forward('cost', 'slash.cost', 'slash.costHint'),
  forward('config', 'slash.config', 'slash.configHint'),
  forward('memory', 'slash.memory', 'slash.memoryHint'),
  forward('init', 'slash.init', 'slash.initHint'),
  forward('review', 'slash.review', 'slash.reviewHint'),
  forward('permissions', 'slash.permissions', 'slash.permissionsHint'),
  forward('doctor', 'slash.doctor', 'slash.doctorHint'),
];

/** Cursor CLI slash commands. `/model` stays local (picker / set by id). */
const CURSOR_FORWARD: SlashCommand[] = [
  forward('edit', 'slash.edit', 'slash.editHint', { needsArgs: true, autoSend: false }),
  forward('ask', 'slash.ask', 'slash.askHint', { needsArgs: true, autoSend: false }),
  forward('fix', 'slash.fix', 'slash.fixHint'),
  forward('reset', 'slash.reset', 'slash.resetHint'),
];

function withLocalCompact(commands: SlashCommand[]): SlashCommand[] {
  return [...commands, LOCAL_COMPACT];
}

/**
 * Catalog for the active provider.
 * Claude: `/compact` is forward only. API-only providers: `/compact` is local.
 * `/clear` `/help` `/model` `/account` are always local.
 */
export function slashCommandsForProvider(providerId: string): SlashCommand[] {
  switch (providerId) {
    case 'anthropic':
      return [...LOCAL_CORE, ...ANTHROPIC_FORWARD];
    case 'cursor':
      return withLocalCompact([...LOCAL_CORE, ...CURSOR_FORWARD]);
    default:
      // openai, xai, gemini, deepseek, glm, kimi, openrouter, github, …
      return withLocalCompact([...LOCAL_CORE]);
  }
}

/** When the composer value is only `/` + optional token (no spaces), return the filter token. */
export function slashMenuQuery(value: string): string | null {
  const match = value.match(/^\/(\S*)$/);
  return match ? match[1] : null;
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter((command) => command.name.toLowerCase().startsWith(q));
}

/**
 * Parse a full composer message as a known slash command.
 * `/model` without args is always local (opens picker) even if a forward variant existed.
 */
export function parseSlashCommand(text: string, providerId: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();
  const command = slashCommandsForProvider(providerId).find((item) => item.name === name);
  if (!command) return null;

  if (name === 'model' && !args) {
    return { name, args, mode: 'local', command: { ...command, mode: 'local' } };
  }

  return { name, args, mode: command.mode, command };
}

export function formatSlashInsertion(command: SlashCommand): string {
  return command.needsArgs ? `/${command.name} ` : `/${command.name}`;
}
