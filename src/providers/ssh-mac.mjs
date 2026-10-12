// macOS over SSH: GeniusBar's bundle, Homebrew's agent-bot, launchd.
import { packageVersion, parseVersion, probePathAgentBot, probePersona, probeProfile } from './common.mjs';

export const kind = 'ssh';

export const DEFAULTS = Object.freeze({
  geniusBarApp: '/Applications/GeniusBar.app',
  homebrewPrefixes: ['/opt/homebrew', '/usr/local'],
  // Site-specific launchd labels belong in the user config.
  launchdLabels: [],
});

export const expects = Object.freeze(['agent-bot', 'geniusbar']);

// Fields are filled into `into` as probes return, so a host that runs out of
// time partway still reports what was collected.
export async function collect(exec, options = {}, into = {}) {
  const opts = { ...DEFAULTS, ...options };
  const report = Object.assign(into, { system: {}, components: [], profile: null, persona: null, services: [] });

  // The first probe doubles as the reachability check.
  const osVersion = await exec(['defaults', 'read', '/System/Library/CoreServices/SystemVersion', 'ProductVersion']);
  report.system = { os: 'macOS', osVersion: osVersion.code === 0 ? osVersion.stdout.trim() : null, hostname: null };

  const prefs = await exec(['defaults', 'read', '/Library/Preferences/SystemConfiguration/preferences', 'System']);
  if (prefs.code === 0) report.system.hostname = macHostname(prefs.stdout);

  const app = opts.geniusBarApp;
  const appVersion = await exec(['defaults', 'read', `${app}/Contents/Info`, 'CFBundleShortVersionString']);
  report.components.push({ id: 'geniusbar', source: 'app', version: appVersion.code === 0 ? parseVersion(appVersion.stdout) : null, path: app });
  const bundled = await exec(['cat', `${app}/Contents/Resources/components/agent-bot/package.json`]);
  report.components.push({ id: 'agent-bot', source: 'geniusbar', version: bundled.code === 0 ? packageVersion(bundled.stdout) : null });

  // Homebrew's opt link points at Cellar/agent-bot/<version>[_<revision>].
  let brewVersion = null;
  for (const prefix of opts.homebrewPrefixes) {
    const link = await exec(['readlink', `${prefix}/opt/agent-bot`]);
    if (link.code === 0) {
      brewVersion = parseVersion(link.stdout.trim().split('/').pop().replace(/_\d+$/, ''));
      break;
    }
  }
  report.components.push({ id: 'agent-bot', source: 'homebrew', version: brewVersion });

  report.components.push(await probePathAgentBot(exec));
  report.profile = await probeProfile(exec);
  report.persona = await probePersona(exec);

  if (opts.launchdLabels.length > 0) {
    const list = await exec(['launchctl', 'list']);
    const loaded = list.code === 0 ? launchdLabels(list.stdout) : null;
    report.services = opts.launchdLabels.map((id) => ({ id, state: loaded === null ? 'unknown' : loaded.has(id) ? 'loaded' : 'not-loaded' }));
  }
  return report;
}

export function macHostname(text) {
  for (const key of ['HostName', 'LocalHostName', 'ComputerName']) {
    const match = new RegExp(`^\\s*${key} = "?([^";\\n]+)"?;`, 'm').exec(text);
    if (match) return match[1];
  }
  return null;
}

// `launchctl list` prints PID, status and label; only the labels are kept.
export function launchdLabels(text) {
  const labels = new Set();
  for (const line of text.split('\n').slice(1)) {
    const label = line.split('\t')[2]?.trim();
    if (label) labels.add(label);
  }
  return labels;
}
