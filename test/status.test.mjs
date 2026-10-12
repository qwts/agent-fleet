import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { collectFleet } from '../src/status.mjs';
import { LINUX, MAC, fakeRun } from './helpers.mjs';

const config = (hosts, ssh = {}) => validateConfig({ schemaVersion: 1, ssh, hosts });
const mac = (name) => ({ name, provider: 'ssh-mac', target: `${name}.example` });

test('an unreachable host is reported and the others still are', async () => {
  const run = fakeRun({ a: MAC, c: LINUX });
  const hosts = await collectFleet(config([mac('a'), mac('b'), { name: 'c', provider: 'ssh-linux', target: 'c.example' }]), { run });
  assert.deepEqual(hosts.map((h) => [h.name, h.reachable]), [['a', true], ['b', false], ['c', true]]);
  assert.match(hosts[1].error, /^unreachable: ssh: connect to host b\.example/);
  assert.equal(run.calls.filter((c) => c.host === 'b').length, 1, 'no further probes after the first fails');
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
});

test('each probe gets only the time left on the host deadline', async () => {
  const run = fakeRun({ a: MAC });
  await collectFleet(config([mac('a')], { connectTimeoutSeconds: 2, hostTimeoutSeconds: 10 }), { run });
  assert.ok(run.calls.every((c) => c.timeoutMs > 0 && c.timeoutMs <= 10_000));
});
