// Human-readable status: one block per host, then a summary line.
import { describeDrift } from './drift.mjs';

export function formatText(report) {
  const summary = ['ok', 'drift', 'partial', 'unreachable'].filter((k) => report.summary[k]).map((k) => `${report.summary[k]} ${k}`).join(', ');
  return `${report.hosts.map(formatHost).join('\n')}\n${report.hosts.length} host${report.hosts.length === 1 ? '' : 's'}: ${summary || 'none configured'}\n`;
}

function formatHost(host) {
  const head = `${host.name} (${host.provider})${host.status && host.status !== 'unreachable' ? `  [${host.status.toUpperCase()}]` : ''}`;
  if (!host.reachable) return `${head}  UNREACHABLE  ${host.error ?? ''}\n`.replace(/ +\n$/, '\n');
  const lines = [];
  if (host.workload) return formatWorkload(head, host.workload);
  if (!host.system?.os && !host.components?.length) {
    // An API account record: reached, nothing to probe on it.
    return `${head}${host.error ? `  error ${host.error}` : '  reachable'}\n`;
  }
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

function formatWorkload(head, w) {
  const where = [w.repo, w.branch].filter(Boolean).join(' ');
  // A workload session is a third-party claim, not a local fact: mark it.
  const state = `${w.state}${w.reported ? ' (reported)' : ''}`;
  const lines = [`${head}  ${state}${where ? `  ${where}` : ''}`];
  if (w.title) lines.push(`  title      ${w.title}`);
  if (w.url) lines.push(`  url        ${w.url}`);
  return `${lines.join('\n')}\n`;
}
