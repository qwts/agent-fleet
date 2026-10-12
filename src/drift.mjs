// Drift: how a host differs from the release train in the config. The train
// names minimum component versions and what must be in place; drift is
// computed on the provider-neutral report, so it works for any provider.
import { ConfigError } from './config.mjs';
import { providers } from './providers/index.mjs';

const TRAIN_KEYS = new Set(['minimum', 'profileRequired', 'personaRequired', 'servicesRequired']);
const COMPONENT_ID = /^[a-z0-9][a-z0-9-]*$/;
// SemVer 2.0.0: no leading zeros in numbers, no empty identifiers.
const NUM = '0|[1-9]\\d*';
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function validateTrain(raw = {}) {
  for (const key of Object.keys(raw)) {
    if (!TRAIN_KEYS.has(key)) throw new ConfigError(`unknown train key "${key}"`);
  }
  const minimum = raw.minimum === undefined ? {} : raw.minimum;
  if (minimum === null || typeof minimum !== 'object' || Array.isArray(minimum)) throw new ConfigError('train.minimum must be an object');
  for (const [id, version] of Object.entries(minimum)) {
    if (!COMPONENT_ID.test(id)) throw new ConfigError(`train.minimum: bad component id "${id}"`);
    if (typeof version !== 'string' || !SEMVER.test(version)) throw new ConfigError(`train.minimum.${id} must be a version like 1.2.3`);
  }
  for (const key of ['profileRequired', 'personaRequired', 'servicesRequired']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new ConfigError(`train.${key} must be true or false`);
  }
  return Object.freeze({
    minimum: Object.freeze({ ...minimum }),
    profileRequired: raw.profileRequired ?? false,
    personaRequired: raw.personaRequired ?? false,
    servicesRequired: raw.servicesRequired ?? false,
  });
}

// Negative, zero or positive, like a sort comparator. Pre-releases sort
// before their release; build metadata is ignored.
export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new TypeError(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  if (pa[4] === pb[4]) return 0;
  if (pa[4] === undefined) return 1;
  if (pb[4] === undefined) return -1;
  return comparePrerelease(pa[4].split('.'), pb[4].split('.'));
}

// Identifier by identifier: numbers numerically and below text, text in ASCII
// order, and a shorter list first when all else is equal.
function comparePrerelease(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return a.length - b.length;
}

// Returns a list of drift items; an empty list means the host is on the train.
// An unreachable host has no drift: its status says it was not seen.
export function hostDrift(host, train) {
  if (!host.reachable) return [];
  // Workload records (API listings, container runtimes and containers) are
  // not machines, so the release train does not apply to them. Every API
  // provider expects nothing, so this changes no existing record.
  if (host.workload) return [];
  const drift = [];
  const components = host.components ?? [];
  const expected = providers[host.provider]?.expects ?? [];
  for (const [id, minimum] of Object.entries(train.minimum)) {
    const found = components.filter((c) => c.id === id && c.version);
    if (found.length === 0) {
      if (expected.includes(id) && !host.error) drift.push({ kind: 'missing', component: id, minimum });
      continue;
    }
    for (const c of found) {
      if (SEMVER.test(c.version) && compareVersions(c.version, minimum) < 0) {
        drift.push({ kind: 'behind', component: id, source: c.source, version: c.version, minimum });
      }
    }
  }
  if (train.profileRequired && host.profile && !host.profile.applied) {
    const missing = ['unmanagedAuthors', 'keydTeamId'].filter((k) => !host.profile[k]);
    drift.push({ kind: 'profile', missing });
  }
  if (train.personaRequired && host.persona && !host.persona.recorded) drift.push({ kind: 'persona' });
  if (train.servicesRequired) {
    for (const s of host.services ?? []) {
      if (s.state !== 'loaded' && s.state !== 'active') drift.push({ kind: 'service', service: s.id, state: s.state });
    }
  }
  return drift;
}

export function hostStatus(host) {
  if (!host.reachable) return 'unreachable';
  if (host.drift.length > 0) return 'drift';
  if (host.error) return 'partial';
  return 'ok';
}

export function describeDrift(item) {
  switch (item.kind) {
    case 'missing': return `${item.component} not found (train ${item.minimum})`;
    case 'behind': return `${item.component} ${item.source} ${item.version} < ${item.minimum}`;
    case 'profile': return `org profile not applied (missing ${item.missing.join(', ')})`;
    case 'persona': return 'no SOP persona recorded';
    case 'service': return `service ${item.service} ${item.state}`;
    default: return item.kind;
  }
}
