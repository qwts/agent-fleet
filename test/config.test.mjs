import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConfigError, DEFAULT_SSH, configPath, loadConfig, validateConfig } from '../src/config.mjs';
import { scratchHome, writeConfig } from './helpers.mjs';

const host = { name: 'studio', provider: 'ssh-mac', target: 'me@studio.example' };

test('config path: explicit, then AGENT_FLEET_CONFIG, then XDG, then HOME', () => {
  assert.equal(configPath({ env: { HOME: '/h' }, explicit: '/x/c.json' }), '/x/c.json');
  assert.equal(configPath({ env: { HOME: '/h', AGENT_FLEET_CONFIG: '/e.json' } }), '/e.json');
  assert.equal(configPath({ env: { HOME: '/h', XDG_CONFIG_HOME: '/xdg' } }), path.join('/xdg', 'agent-fleet', 'config.json'));
  assert.equal(configPath({ env: { HOME: '/h' } }), path.join('/h', '.config', 'agent-fleet', 'config.json'));
});

test('a minimal config gets the ssh defaults', () => {
  const config = validateConfig({ schemaVersion: 1, hosts: [host] });
  assert.deepEqual(config.ssh, DEFAULT_SSH);
  assert.equal(config.hosts[0].target, 'me@studio.example');
});

test('both v1 providers are accepted', () => {
  const config = validateConfig({ schemaVersion: 1, hosts: [host, { name: 'vm', provider: 'ssh-linux', target: '203.0.113.9', port: 2222 }] });
  assert.deepEqual(config.hosts.map((h) => h.provider), ['ssh-mac', 'ssh-linux']);
});

test('rejects bad configs with a ConfigError', () => {
  const bad = [
    null,
    [],
    { hosts: [] },
    { schemaVersion: 2, hosts: [] },
    { schemaVersion: 1 },
    { schemaVersion: 1, hosts: [], extra: true },
    { schemaVersion: 1, hosts: [{ ...host, provider: 'telnet' }] },
    { schemaVersion: 1, hosts: [{ ...host, target: '-oProxyCommand=sh' }] },
    { schemaVersion: 1, hosts: [{ ...host, target: 'a;reboot' }] },
    { schemaVersion: 1, hosts: [{ ...host, target: 'host name' }] },
    { schemaVersion: 1, hosts: [{ ...host, name: '../x' }] },
    { schemaVersion: 1, hosts: [{ ...host, port: 0 }] },
    { schemaVersion: 1, hosts: [{ ...host, password: 'x' }] },
    { schemaVersion: 1, hosts: [host, host] },
    { schemaVersion: 1, hosts: [], ssh: { connectTimeoutSeconds: 0 } },
    { schemaVersion: 1, hosts: [], ssh: { connectTimeoutSeconds: 30, hostTimeoutSeconds: 10 } },
    { schemaVersion: 1, hosts: [], ssh: { bogus: 1 } },
    { schemaVersion: 1, hosts: [], providers: { 'ssh-windows': {} } },
  ];
  for (const raw of bad) assert.throws(() => validateConfig(raw), ConfigError, JSON.stringify(raw));
});

test('inherited property names are not mistaken for known keys', () => {
  for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
    const raw = JSON.parse(`{"schemaVersion":1,"hosts":[],"ssh":{"${key}":5}}`);
    assert.throws(() => validateConfig(raw), /unknown ssh key/, key);
  }
});

test('loadConfig reports a missing file and bad JSON as ConfigError', async (t) => {
  const { home } = scratchHome(t);
  await assert.rejects(loadConfig(path.join(home, 'none.json')), /no config at/);
  const file = writeConfig(home, '{not json');
  await assert.rejects(loadConfig(file), /not valid JSON/);
});

test('the shipped example config is valid', async () => {
  const config = await loadConfig(fileURLToPath(new URL('../examples/config.example.json', import.meta.url)));
  assert.equal(config.hosts.length, 3);
});
