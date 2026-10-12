// The status report: one fixed shape for every provider, so JSON consumers
// never branch on host type. docs/json-output.md is its contract; bump
// schemaVersion on any breaking change.
import { hostDrift, hostStatus } from './drift.mjs';

export const SCHEMA_VERSION = 1;
const STATUSES = ['ok', 'drift', 'partial', 'unreachable'];

export function buildReport(hosts, { train, version, now = new Date() }) {
  const shaped = hosts.map((host) => shapeHost(host, train));
  const summary = { hosts: shaped.length };
  for (const status of STATUSES) summary[status] = shaped.filter((h) => h.status === status).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    tool: { name: 'agent-fleet', version },
    train,
    summary,
    hosts: shaped,
  };
}

function shapeHost(host, train) {
  const drift = hostDrift(host, train);
  const system = host.system ?? {};
  return {
    name: host.name,
    provider: host.provider,
    status: hostStatus({ ...host, drift }),
    reachable: host.reachable,
    error: host.error ?? null,
    system: { os: system.os ?? null, osVersion: system.osVersion ?? null, hostname: system.hostname ?? null },
    components: (host.components ?? []).map((c) => ({
      id: c.id,
      source: c.source,
      version: c.version ?? null,
      path: c.path ?? null,
      resolved: c.resolved ?? null,
    })),
    profile: host.profile
      ? { configFound: host.profile.configFound, applied: host.profile.applied, unmanagedAuthors: host.profile.unmanagedAuthors, keydTeamId: host.profile.keydTeamId }
      : null,
    persona: host.persona ? { recorded: host.persona.recorded } : null,
    services: (host.services ?? []).map((s) => ({ id: s.id, state: s.state })),
    drift,
  };
}
