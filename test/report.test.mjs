import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINUX, MAC, fakeRun, run, scratchHome, writeConfig } from './helpers.mjs';

const HOST_KEYS = ['name', 'provider', 'status', 'reachable', 'error', 'system', 'components', 'profile', 'persona', 'services', 'drift'];
const COMPONENT_KEYS = ['id', 'source', 'version', 'path', 'resolved'];

const config = {
  schemaVersion: 1,
  train: { minimum: { 'agent-bot': '0.10.62' }, profileRequired: true },
  providers: { 'ssh-mac': { launchdLabels: ['com.example.daemon'] } },
  hosts: [
    { name: 'studio', provider: 'ssh-mac', target: 'studio.example' },
    { name: 'vm', provider: 'ssh-linux', target: 'vm.example' },
    { name: 'gone', provider: 'ssh-mac', target: 'gone.example' },
  ],
};

async function report(t) {
  const { home, env } = scratchHome(t);
  writeConfig(home, config);
  const { code, out } = await run(['status', '--json'], { env, run: fakeRun({ studio: MAC, vm: LINUX }), now: () => new Date('2026-10-11T12:00:00Z') });
  assert.equal(code, 0);
  return JSON.parse(out);
}

test('the JSON report has a fixed top level', async (t) => {
  const r = await report(t);
  assert.deepEqual(Object.keys(r), ['schemaVersion', 'generatedAt', 'tool', 'train', 'summary', 'hosts']);
  assert.equal(r.schemaVersion, 1);
  assert.equal(r.generatedAt, '2026-10-11T12:00:00.000Z');
  assert.equal(r.tool.name, 'agent-fleet');
  assert.deepEqual(r.summary, { hosts: 3, ok: 1, drift: 1, partial: 0, unreachable: 1 });
  assert.deepEqual(r.train, { minimum: { 'agent-bot': '0.10.62' }, profileRequired: true, personaRequired: false, servicesRequired: false });
});

test('every host has the same keys, whatever its provider or reachability', async (t) => {
  const r = await report(t);
  for (const host of r.hosts) {
    assert.deepEqual(Object.keys(host), HOST_KEYS, host.name);
    assert.deepEqual(Object.keys(host.system), ['os', 'osVersion', 'hostname']);
    for (const c of host.components) assert.deepEqual(Object.keys(c), COMPONENT_KEYS);
  }
  const gone = r.hosts.find((h) => h.name === 'gone');
  assert.equal(gone.status, 'unreachable');
  assert.deepEqual(gone.system, { os: null, osVersion: null, hostname: null });
  assert.equal(gone.profile, null);
  assert.deepEqual(gone.components, []);
});

test('drift is structured, and no config value or ssh target leaks', async (t) => {
  const r = await report(t);
  const studio = r.hosts.find((h) => h.name === 'studio');
  assert.equal(studio.status, 'ok', 'a version equal to the minimum is on the train');
  assert.deepEqual(studio.drift, []);
  const vm = r.hosts.find((h) => h.name === 'vm');
  assert.deepEqual(vm.drift, [{ kind: 'behind', component: 'agent-bot', source: 'linux-bundle', version: '0.10.60', minimum: '0.10.62' }, { kind: 'profile', missing: ['unmanagedAuthors'] }]);
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /SECRET/);
  assert.doesNotMatch(text, /studio\.example|vm\.example/);
});
