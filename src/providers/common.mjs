// Probes both SSH providers share. Each takes exec(argv) -> { code, stdout }
// and returns part of the provider-neutral host report.

import { isAllowed } from '../allowlist.mjs';

// Relative to the remote HOME, where ssh starts.
export const AGENT_BOT_CONFIG = '.config/agent-bot/config.json';
export const SOP_PERSONA = '.local/state/agent-bot/agent-identities/sop-persona.json';

const VERSION = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

export function parseVersion(text) {
  return VERSION.exec(String(text ?? ''))?.[1] ?? null;
}

export function packageVersion(text) {
  try {
    const version = JSON.parse(text).version;
    return typeof version === 'string' ? parseVersion(version) : null;
  } catch {
    return null;
  }
}

// The org profile is applied when both settings exist. Only their presence
// leaves this function: no value from the file is ever reported.
export async function probeProfile(exec) {
  const result = await exec(['cat', AGENT_BOT_CONFIG]);
  if (result.code !== 0) return { configFound: false, applied: false, unmanagedAuthors: false, keydTeamId: false };
  let settings = null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)) settings = parsed.settings;
  } catch {
    return { configFound: true, applied: false, unmanagedAuthors: false, keydTeamId: false, error: 'config.json is not valid JSON' };
  }
  const has = (key) => settings !== null && Object.hasOwn(settings, key) && settings[key] !== null && settings[key] !== '';
  const unmanagedAuthors = has('unmanagedAuthors');
  const keydTeamId = has('keydTeamId');
  return { configFound: true, applied: unmanagedAuthors && keydTeamId, unmanagedAuthors, keydTeamId };
}

export async function probePersona(exec) {
  const result = await exec(['test', '-f', SOP_PERSONA]);
  return { recorded: result.code === 0 };
}

// Which agent-bot a non-interactive shell finds on PATH, where its symlinks
// lead, and what it says its version is.
export async function probePathAgentBot(exec) {
  const found = await exec(['command', '-v', 'agent-bot']);
  const path = found.code === 0 ? found.stdout.trim().split('\n')[0] : '';
  if (!path.startsWith('/')) return { id: 'agent-bot', source: 'path', version: null, path: null, resolved: null };
  // The host chose this path, so it is checked like any other input.
  if (!isAllowed(['readlink', '-f', path])) return { id: 'agent-bot', source: 'path', version: null, path: null, resolved: null, error: 'PATH entry has unsafe characters' };
  const link = await exec(['readlink', '-f', path]);
  const version = await exec([path, '--version']);
  return {
    id: 'agent-bot',
    source: 'path',
    version: version.code === 0 ? parseVersion(version.stdout) : null,
    path,
    resolved: link.code === 0 ? link.stdout.trim() || null : null,
  };
}
