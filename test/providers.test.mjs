import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerOptions } from '../src/providers/index.mjs';
import { collect as collectLinux } from '../src/providers/ssh-linux.mjs';
import { collect as collectMac, macHostname } from '../src/providers/ssh-mac.mjs';
import { ConfigError } from '../src/config.mjs';
import { LINUX, MAC, fakeRun } from './helpers.mjs';

const execFor = (table) => {
  const run = fakeRun({ h: table });
  return (argv) => run({ name: 'h', target: 'h' }, argv, { timeoutMs: 1000 });
};

test('ssh-mac reports versions, PATH, profile, persona and launchd labels', async () => {
  const report = await collectMac(execFor(MAC), { launchdLabels: ['com.example.daemon', 'com.example.broker'] });
  assert.deepEqual(report.system, { os: 'macOS', osVersion: '15.6.1', hostname: 'studio.lan' });
  const version = (id, source) => report.components.find((c) => c.id === id && c.source === source).version;
  assert.equal(version('geniusbar', 'app'), '0.1.71');
  assert.equal(version('agent-bot', 'geniusbar'), '0.10.62');
  assert.equal(version('agent-bot', 'homebrew'), '0.10.64');
  const path = report.components.find((c) => c.source === 'path');
  assert.equal(path.version, '0.10.64');
  assert.equal(path.resolved, '/opt/homebrew/Cellar/agent-bot/0.10.64_1/libexec/agent-bot');
  assert.deepEqual(report.profile, { configFound: true, applied: true, unmanagedAuthors: true, keydTeamId: true });
  assert.deepEqual(report.persona, { recorded: true });
  assert.deepEqual(report.services, [{ id: 'com.example.daemon', state: 'loaded' }, { id: 'com.example.broker', state: 'not-loaded' }]);
});

test('no value from the agent-bot config, and no unlisted launchd label, reaches the report', async () => {
  for (const [collect, table] of [[collectMac, MAC], [collectLinux, LINUX]]) {
    const text = JSON.stringify(await collect(execFor(table), collect === collectMac ? { launchdLabels: ['com.example.daemon'] } : {}));
    assert.doesNotMatch(text, /SECRET/);
    assert.doesNotMatch(text, /com\.apple/);
  }
});

test('ssh-mac with nothing installed reports absence, not errors', async () => {
  const report = await collectMac(execFor({ 'defaults read /System/Library/CoreServices/SystemVersion ProductVersion': '14.0\n' }));
  assert.ok(report.components.every((c) => c.version === null));
  assert.deepEqual(report.profile, { configFound: false, applied: false, unmanagedAuthors: false, keydTeamId: false });
  assert.deepEqual(report.persona, { recorded: false });
  assert.deepEqual(report.services, []);
});

test('ssh-linux reports the bundle, systemd states and a partial profile', async () => {
  const report = await collectLinux(execFor(LINUX));
  assert.deepEqual(report.system, { os: 'Ubuntu', osVersion: '24.04', hostname: 'vm-1' });
  assert.equal(report.components.find((c) => c.source === 'linux-bundle').version, '0.10.60');
  assert.deepEqual(report.profile, { configFound: true, applied: false, unmanagedAuthors: false, keydTeamId: true });
  assert.deepEqual(report.persona, { recorded: false });
  assert.deepEqual(report.services, [{ id: 'agent-bot-daemon', state: 'active' }, { id: 'agent-comms-broker', state: 'inactive' }]);
});

test('os-release values may be single-quoted, double-quoted or bare', async () => {
  const report = await collectLinux(execFor({ ...LINUX, 'cat /etc/os-release': "NAME='Debian GNU/Linux'\nVERSION_ID=12\n" }));
  assert.equal(report.system.os, 'Debian GNU/Linux');
  assert.equal(report.system.osVersion, '12');
});

test('a broken agent-bot config is reported without its contents', async () => {
  const report = await collectLinux(execFor({ ...LINUX, 'cat .config/agent-bot/config.json': '{"settings": SECRET' }));
  assert.equal(report.profile.applied, false);
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test('macHostname prefers HostName, then LocalHostName, then ComputerName', () => {
  assert.equal(macHostname('    LocalHostName = "a";\n    ComputerName = "b c";\n'), 'a');
  assert.equal(macHostname('    ComputerName = "b c";\n'), 'b c');
  assert.equal(macHostname(''), null);
});

test('provider options merge over defaults and reject unknown keys and types', () => {
  assert.deepEqual(providerOptions('ssh-linux', { systemdUnits: ['x'] }).systemdUnits, ['x']);
  assert.equal(providerOptions('ssh-mac').geniusBarApp, '/Applications/GeniusBar.app');
  assert.throws(() => providerOptions('ssh-mac', { runDoctor: true }), ConfigError);
  assert.throws(() => providerOptions('ssh-mac', { launchdLabels: 'x' }), ConfigError);
  assert.throws(() => providerOptions('ssh-mac', { geniusBarApp: '' }), ConfigError);
});
