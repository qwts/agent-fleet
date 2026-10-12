// Human-readable status: one block per host, then a summary line.
import { describeDrift } from './drift.mjs';

export function formatText(report) {
  const counts = {};
  for (const host of report.hosts) counts[host.status] = (counts[host.status] ?? 0) + 1;
  const summary = ['ok', 'drift', 'partial', 'unreachable'].filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(', ');
  return `${report.hosts.map(formatHost).join('\n')}\n${report.hosts.length} host${report.hosts.length === 1 ? '' : 's'}: ${summary || 'none configured'}\n`;
}

function formatHost(host) {
  const head = `${host.name} (${host.provider})${host.status && host.status !== 'unreachable' ? `  [${host.status.toUpperCase()}]` : ''}`;
  if (!host.reachable) return `${head}  UNREACHABLE  ${host.error ?? ''}\n`.replace(/ +\n$/, '\n');
  const lines = [];
  const system = host.system ?? {};
  lines.push(`${head}  ${system.os ?? '?'} ${system.osVersion ?? '?'}  hostname ${system.hostname ?? '?'}`);
  if (host.error) lines.push(`  error      ${host.error} (partial report)`);
  for (const c of host.components ?? []) {
    const where = c.resolved ? `  -> ${c.resolved}` : c.path && c.source === 'path' ? `  ${c.path}` : '';
    lines.push(`  ${c.id.padEnd(10)} ${c.source.padEnd(12)} ${c.version ?? 'not found'}${where}`);
  }
  if (host.profile) {
    const p = host.profile;
    const detail = !p.configFound ? 'no agent-bot config' : p.applied ? 'applied' : `not applied (unmanagedAuthors ${p.unmanagedAuthors ? 'set' : 'missing'}, keydTeamId ${p.keydTeamId ? 'set' : 'missing'})`;
    lines.push(`  profile    ${detail}`);
  }
  if (host.persona) lines.push(`  persona    ${host.persona.recorded ? 'recorded' : 'not recorded'}`);
  for (const s of host.services ?? []) lines.push(`  service    ${s.id} ${s.state}`);
  for (const d of host.drift ?? []) lines.push(`  DRIFT      ${describeDrift(d)}`);
  return `${lines.join('\n')}\n`;
}
