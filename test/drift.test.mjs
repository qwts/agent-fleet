import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '../src/config.mjs';
import { compareVersions, describeDrift, hostDrift, hostStatus, validateTrain } from '../src/drift.mjs';

const train = validateTrain({ minimum: { 'agent-bot': '0.10.62', geniusbar: '0.1.71' }, profileRequired: true, personaRequired: true, servicesRequired: true });

const mac = (over = {}) => ({
  name: 'm',
  provider: 'ssh-mac',
  reachable: true,
  error: null,
  components: [
    { id: 'geniusbar', source: 'app', version: '0.1.71' },
    { id: 'agent-bot', source: 'geniusbar', version: '0.10.62' },
    { id: 'agent-bot', source: 'homebrew', version: '0.10.64' },
    { id: 'agent-bot', source: 'path', version: '0.10.64' },
  ],
  profile: { configFound: true, applied: true, unmanagedAuthors: true, keydTeamId: true },
  persona: { recorded: true },
  services: [{ id: 'com.example.daemon', state: 'loaded' }],
  ...over,
});

test('compareVersions orders numerically and puts pre-releases first', () => {
  assert.ok(compareVersions('0.10.9', '0.10.10') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3+build'), 0);
  assert.ok(compareVersions('1.2.3-rc.1', '1.2.3') < 0);
  assert.throws(() => compareVersions('x', '1.0.0'), TypeError);
});

test('a host on the train has no drift', () => {
  const host = mac();
  assert.deepEqual(hostDrift(host, train), []);
  assert.equal(hostStatus({ ...host, drift: [] }), 'ok');
});

test('every agent-bot below the minimum is flagged, by source', () => {
  const host = mac({ components: [
    { id: 'geniusbar', source: 'app', version: '0.1.70' },
    { id: 'agent-bot', source: 'geniusbar', version: '0.10.61' },
    { id: 'agent-bot', source: 'homebrew', version: '0.10.64' },
    { id: 'agent-bot', source: 'path', version: '0.10.62-rc.1' },
  ] });
  const drift = hostDrift(host, train);
  assert.deepEqual(drift.map(describeDrift), [
    'agent-bot geniusbar 0.10.61 < 0.10.62',
    'agent-bot path 0.10.62-rc.1 < 0.10.62',
    'geniusbar app 0.1.70 < 0.1.71',
  ]);
  assert.equal(hostStatus({ ...host, drift }), 'drift');
});

test('a missing component is drift only where the provider expects it', () => {
  const none = (provider) => ({ ...mac({ provider, components: [{ id: 'agent-bot', source: 'path', version: '0.10.64' }] }) });
  assert.deepEqual(hostDrift(none('ssh-mac'), train).map(describeDrift), ['geniusbar not found (train 0.1.71)']);
  assert.deepEqual(hostDrift(none('ssh-linux'), train), [], 'Linux has no GeniusBar');
  assert.deepEqual(hostDrift(mac({ components: [] }), train).map((d) => d.component), ['agent-bot', 'geniusbar']);
});

test('profile, persona and services are flagged when the train requires them', () => {
  const host = mac({
    profile: { configFound: true, applied: false, unmanagedAuthors: true, keydTeamId: false },
    persona: { recorded: false },
    services: [{ id: 'a', state: 'loaded' }, { id: 'b', state: 'not-loaded' }, { id: 'c', state: 'unknown' }],
  });
  assert.deepEqual(hostDrift(host, train).map(describeDrift), [
    'org profile not applied (missing keydTeamId)',
    'no SOP persona recorded',
    'service b not-loaded',
    'service c unknown',
  ]);
  assert.deepEqual(hostDrift(host, validateTrain({})), [], 'nothing is required by default');
});

test('unreachable and partial hosts', () => {
  assert.deepEqual(hostDrift({ reachable: false }, train), []);
  assert.equal(hostStatus({ reachable: false, drift: [] }), 'unreachable');
  const partial = mac({ error: 'timed out after 30s', components: [] });
  assert.deepEqual(hostDrift(partial, train).filter((d) => d.kind === 'missing'), [], 'not seen is not missing');
  assert.equal(hostStatus({ ...partial, drift: [] }), 'partial');
});

test('validateTrain rejects unknown keys, bad versions and bad flags', () => {
  for (const raw of [{ latest: true }, { minimum: [] }, { minimum: { 'agent-bot': '0.10' } }, { minimum: { 'Agent Bot': '1.0.0' } }, { profileRequired: 'yes' }]) {
    assert.throws(() => validateTrain(raw), ConfigError, JSON.stringify(raw));
  }
});
