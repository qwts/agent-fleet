import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, validateConfig } from '../src/config.mjs';
import { collectFleet, redactTarget } from '../src/status.mjs';
import { LINUX, MAC, fakeRun } from './helpers.mjs';

const config = (hosts, ssh = {}) => validateConfig({ schemaVersion: 1, ssh, hosts });
const mac = (name) => ({ name, provider: 'ssh-mac', target: `${name}.example` });

test('an unreachable host is reported and the others still are', async () => {
  const run = fakeRun({ a: MAC, c: LINUX });
  const hosts = await collectFleet(config([mac('a'), mac('b'), { name: 'c', provider: 'ssh-linux', target: 'c.example' }]), { run });
  assert.deepEqual(hosts.map((h) => [h.name, h.reachable]), [['a', true], ['b', false], ['c', true]]);
  assert.match(hosts[1].error, /^unreachable: ssh: connect to host \[host\] port 22/);
  assert.equal(run.calls.filter((c) => c.host === 'b').length, 1, 'no further probes after the first fails');
});

test('ssh error text never carries the target', () => {
  const host = { target: 'admin@mac-1.example' };
  assert.equal(redactTarget('ssh: Could not resolve hostname mac-1.example: nodename', host), 'ssh: Could not resolve hostname [host]: nodename');
  assert.equal(redactTarget('admin@mac-1.example: Permission denied (publickey).', host), '[user]@[host]: Permission denied (publickey).');
  assert.equal(redactTarget('connect to host 203.0.113.9 port 22', { target: '203.0.113.9' }), 'connect to host [host] port 22');
});

test('hosts are probed in parallel, up to the concurrency limit', async () => {
  let active = 0;
  let peak = 0;
  const slow = async (argv) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return MAC[argv.join(' ')] === undefined ? { code: 1 } : { code: 0, stdout: MAC[argv.join(' ')] };
  };
  const names = ['a', 'b', 'c', 'd', 'e'];
  const run = fakeRun(Object.fromEntries(names.map((n) => [n, slow])));
  await collectFleet(config(names.map(mac), { concurrency: 3 }), { run });
  assert.equal(peak, 3);
});

test('a host that runs out of time is reported with a partial result', async () => {
  const run = fakeRun({
    a: (argv) => argv[0] === 'launchctl'
      ? { code: 255, timedOut: true }
      : MAC[argv.join(' ')] === undefined ? { code: 1 } : MAC[argv.join(' ')],
  });
  const hosts = await collectFleet(validateConfig({ schemaVersion: 1, providers: { 'ssh-mac': { launchdLabels: ['x'] } }, hosts: [mac('a')] }), { run });
  assert.equal(hosts[0].reachable, true);
  assert.match(hosts[0].error, /timed out after 30s/);
  assert.equal(hosts[0].system.osVersion, '15.6.1', 'what was collected before the timeout is kept');
  assert.equal(hosts[0].components.find((c) => c.source === 'homebrew').version, '0.10.64');
  assert.equal(hosts[0].profile.applied, true);
});

test('an SSH-only fleet still validates provider blocks no host uses', async () => {
  const bad = [
    [{ cursor: { token: 'secret' } }, /unknown key "token"/],
    [{ devin: { orgId: 'bad' } }, /orgId/],
    [{ devin: { orgId: 'org-test123', maxAgents: 5000 } }, /maxAgents/],
  ];
  for (const [providers, message] of bad) {
    const cfg = validateConfig({ schemaVersion: 1, providers, hosts: [mac('a')] });
    await assert.rejects(collectFleet(cfg, { run: () => assert.fail('bad options must fail before probing') }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, message);
      return true;
    });
  }
});

test('an SSH-only fleet with no provider blocks loads fine', async () => {
  const run = fakeRun({ a: MAC });
  const hosts = await collectFleet(config([mac('a')]), { run });
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].reachable, true);
});

test('each probe gets only the time left on the host deadline', async () => {
  const run = fakeRun({ a: MAC });
  await collectFleet(config([mac('a')], { connectTimeoutSeconds: 2, hostTimeoutSeconds: 10 }), { run });
  assert.ok(run.calls.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 10_000));
});
