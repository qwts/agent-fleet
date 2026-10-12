// Container runtimes on SSH hosts, shared by both ssh providers. Probing is
// read-only: `version` and `ps` with a fixed JSON format. Nothing here ever
// launches a daemon, and a runtime failure never errors the host — it is
// recorded on the runtime's own record and probing continues.
import { sanitizeId, sanitizeText } from '../sanitize.mjs';

export const CONTAINER_RUNTIMES = Object.freeze(['docker', 'podman']);
export const MAX_CONTAINERS = 100;

// Extra host-shaped records ride the ssh collect `into` object under this
// symbol, so status.mjs can expand them without touching the report shape.
// Symbols never reach JSON output, and the key is only set when runtimes are
// listed, so the default stays byte-identical.
export const EXTRA_RECORDS = Symbol('extraRecords');

// providerOptions type-checks the array; this checks its values. Returns a
// problem string, or null when the option is fine.
export function validateContainers(options) {
  const list = options.containers;
  if (list === undefined || !Array.isArray(list)) return null;
  const seen = new Set();
  for (const entry of list) {
    if (!CONTAINER_RUNTIMES.includes(entry)) return `containers must be "docker" and/or "podman", got ${JSON.stringify(entry)}`;
    if (seen.has(entry)) return `containers lists "${entry}" twice`;
    seen.add(entry);
  }
  return null;
}

// Probe each listed runtime in order, appending host-shaped records to `out`
// as they complete, so a timeout keeps the runtimes already probed. Never
// throws on a runtime failure: exec only rejects on timeout or a lost
// connection, which propagates like any other probe's partial state.
export async function collectContainers(exec, { hostName, provider, runtimes, presenceCheck = [] }, out = []) {
  for (const runtime of runtimes) {
    if (presenceCheck.includes(runtime)) {
      const found = await exec(['command', '-v', runtime]);
      if (found.code !== 0 || found.stdout.trim() === '') {
        out.push(runtimeRecord(hostName, provider, runtime, 'absent'));
        continue;
      }
    }
    out.push(...(await probeRuntime(exec, hostName, provider, runtime)));
  }
  return out;
}

async function probeRuntime(exec, hostName, provider, runtime) {
  const version = await exec([runtime, 'version', '--format', '{{json .}}']);
  const server = versionServer(version.stdout);
  if (server === true) {
    const ps = await exec([runtime, 'ps', '--all', '--no-trunc', '--format', '{{json .}}']);
    // A cap-truncated ps stream may still parse (its first rows are whole),
    // but the listing is incomplete, so no partial row may be reported.
    if (ps.truncatedOutput) return [runtimeRecord(hostName, provider, runtime, 'unavailable')];
    const rows = parsePsOutput(ps.stdout);
    if (rows === null) return [runtimeRecord(hostName, provider, runtime, 'unavailable')];
    const truncated = rows.length > MAX_CONTAINERS;
    let unknownSeen = 0;
    return [
      runtimeRecord(hostName, provider, runtime, 'ok', truncated),
      ...rows.slice(0, MAX_CONTAINERS).flatMap((row) => {
        const record = containerRecord(hostName, provider, runtime, row, () => `unknown-${++unknownSeen}`);
        return record === null ? [] : [record];
      }),
    ];
  }
  if (server === false) return [runtimeRecord(hostName, provider, runtime, 'stopped')];
  // The version output says nothing usable. An empty answer to a failed
  // version call means the binary is not there; anything else garbled means
  // the runtime answered but could not be understood.
  if (version.code !== 0 && version.stdout.trim() === '') return [runtimeRecord(hostName, provider, runtime, 'absent')];
  return [runtimeRecord(hostName, provider, runtime, 'unavailable')];
}

// true when the version JSON names a Server section, false when it parses
// but names none, null when it is not a version object at all.
export function versionServer(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed.Server !== undefined && parsed.Server !== null ? true : false;
}

// The ps format prints one JSON object per line, but a whole-output array is
// accepted too. Returns the row list, or null when the output is unparsable.
// Oversized output never reaches parsing: the SSH runner flags a stream cut
// by its byte cap with truncatedOutput, which probeRuntime reads as
// unavailable without touching the partial rows.
export function parsePsOutput(text) {
  const raw = String(text ?? '');
  if (raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return null;
  } catch {
    // Not one JSON value: fall through to JSON-lines.
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return rows.length > 0 ? rows : null;
}

function runtimeRecord(hostName, provider, runtime, state, truncated = false) {
  return {
    name: `${hostName}/${runtime}`,
    provider,
    reachable: true,
    error: null,
    workload: { kind: 'container-runtime', runtime, state, truncated },
  };
}

// Rows that are not objects, or name no id, are skipped. Every string goes
// through the sanitizer; createdAt stays a plain string because the runtimes
// print local timestamps, never ISO. A sanitized id that fails the id
// pattern would collide on 'unknown', so each listing numbers them
// unknown-1, unknown-2, … in row order; valid ids stay the first 12 chars.
function containerRecord(hostName, provider, runtime, row, nextUnknownId = () => 'unknown') {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (typeof row.ID !== 'string' || row.ID === '') return null;
  const clean = sanitizeId(row.ID);
  const shortId = clean === 'unknown' ? nextUnknownId() : clean.slice(0, 12);
  return {
    name: `${hostName}/${runtime}/${shortId}`,
    provider,
    reachable: true,
    error: null,
    workload: {
      kind: 'container',
      runtime,
      id: shortId,
      image: sanitizeText(row.Image),
      state: sanitizeText(row.State),
      status: sanitizeText(row.Status),
      createdAt: sanitizeText(row.CreatedAt),
    },
  };
}
