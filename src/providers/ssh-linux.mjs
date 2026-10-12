// Linux over SSH: cloud VMs and the headless agent-bot bundle under
// systemd --user.
import { packageVersion, probePathAgentBot, probePersona, probeProfile } from './common.mjs';

export const DEFAULTS = Object.freeze({
  // install.sh's default prefix, relative to HOME.
  bundlePrefix: '.local/share/agent-bot',
  systemdUnits: ['agent-bot-daemon', 'agent-comms-broker'],
});

export const expects = Object.freeze(['agent-bot']);

export async function collect(exec, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const report = { system: {}, components: [], profile: null, persona: null, services: [] };

  // The first probe doubles as the reachability check.
  const osRelease = await exec(['cat', '/etc/os-release']);
  const os = osRelease.code === 0 ? parseOsRelease(osRelease.stdout) : {};
  const hostname = await exec(['cat', '/proc/sys/kernel/hostname']);
  report.system = {
    os: os.NAME ?? 'Linux',
    osVersion: os.VERSION_ID ?? null,
    hostname: hostname.code === 0 ? hostname.stdout.trim() || null : null,
  };

  const bundled = await exec(['cat', `${opts.bundlePrefix}/lib/agent-bot/package.json`]);
  report.components.push({ id: 'agent-bot', source: 'linux-bundle', version: bundled.code === 0 ? packageVersion(bundled.stdout) : null });
  report.components.push(await probePathAgentBot(exec));
  report.profile = await probeProfile(exec);
  report.persona = await probePersona(exec);

  if (opts.systemdUnits.length > 0) {
    // is-active prints one state per unit and exits non-zero unless all are
    // active, so the output, not the exit code, is the answer.
    const result = await exec(['systemctl', '--user', 'is-active', ...opts.systemdUnits]);
    const states = result.stdout.trim().split('\n').map((s) => s.trim());
    const known = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading']);
    report.services = opts.systemdUnits.map((id, i) => ({ id, state: known.has(states[i]) ? states[i] : 'unknown' }));
  }
  return report;
}

export function parseOsRelease(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}
