import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProbeNotAllowed, allowedShapes, assertAllowed } from '../src/allowlist.mjs';
import { ConfigError, validateConfig } from '../src/config.mjs';
import { validateTrain } from '../src/drift.mjs';
import { EXTRA_RECORDS, parsePsOutput, versionServer } from '../src/providers/containers.mjs';
import { providerOptions } from '../src/providers/index.mjs';
import { collect as collectLinux } from '../src/providers/ssh-linux.mjs';
import { collect as collectMac } from '../src/providers/ssh-mac.mjs';
import { buildReport } from '../src/report.mjs';
import { sanitizeId } from '../src/sanitize.mjs';
import { collectFleet } from '../src/status.mjs';
import { LINUX, MAC, fakeRun } from './helpers.mjs';

const DOCKER_VERSION = 'docker version --format {{json .}}';
const DOCKER_PS = 'docker ps --all --no-trunc --format {{json .}}';
const PODMAN_VERSION = 'podman version --format {{json .}}';
const PODMAN_PS = 'podman ps --all --no-trunc --format {{json .}}';

const serverVersion = JSON.stringify({ Client: { Version: '28.0.0' }, Server: { Version: '28.0.0' } });
const clientOnlyVersion = JSON.stringify({ Client: { Version: '28.0.0' } });
const row = (id, overrides = {}) => JSON.stringify({
  ID: id,
  Image: 'img:latest',
  State: 'running',
  Status: 'Up 2 hours',
  CreatedAt: '2026-09-01 12:00:00 +0000 UTC',
  ...overrides,
});
const ID64 = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

function stubbed(table) {
  const calls = [];
  const run = fakeRun({ h: table }, { calls });
  const exec = (argv) => run({ name: 'h', target: 'h' }, argv, { timeoutMs: 1000 });
  return { exec, calls };
}

test('the four container shapes are allowed and listed', () => {
  const shapes = [
    ['docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}'],
    ['docker', 'version', '--format', '{{json .}}'],
    ['podman', 'ps', '--all', '--no-trunc', '--format', '{{json .}}'],
    ['podman', 'version', '--format', '{{json .}}'],
  ];
  for (const argv of shapes) assert.deepEqual(assertAllowed(argv), argv);
  for (const name of [
    'docker version --format {{json .}}',
    'docker ps --all --no-trunc --format {{json .}}',
    'podman version --format {{json .}}',
    'podman ps --all --no-trunc --format {{json .}}',
  ]) assert.ok(allowedShapes().includes(name), name);
});

test('container near-misses are refused', () => {
  const misses = [
    ['docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}', 'extra'],
    ['docker', 'exec', 'mycontainer', 'ls'],
    ['docker', 'logs', 'mycontainer'],
    ['docker', 'ps', '--all', '--no-trunc', '--format', '{{.Names}}'],
    ['docker', 'ps', '--no-trunc', '--format', '{{json .}}'],
    ['docker', 'version', '--format', '{{json .}}$(reboot)'],
    ['podman', 'run', 'alpine'],
    ['docker', 'desktop', 'status'],
    ['podman', 'ps', '--all', '--no-trunc', '--format', '{{json .}} '],
  ];
  for (const argv of misses) assert.throws(() => assertAllowed(argv), ProbeNotAllowed, JSON.stringify(argv));
});

test('ssh-mac reports a running docker daemon and its containers', async () => {
  const { exec, calls } = stubbed({
    ...MAC,
    'command -v docker': '/usr/local/bin/docker\n',
    [DOCKER_VERSION]: serverVersion,
    [DOCKER_PS]: `${row(ID64)}\n${row('1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef')}\n`,
  });
  const report = await collectMac(exec, { launchdLabels: ['com.example.daemon'], containers: ['docker'] }, {}, { name: 'studio' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.equal(extra.length, 3);
  assert.deepEqual(extra[0], {
    name: 'studio/docker',
    provider: 'ssh-mac',
    reachable: true,
    error: null,
    workload: { kind: 'container-runtime', runtime: 'docker', state: 'ok', truncated: false },
  });
  assert.equal(extra[1].name, 'studio/docker/abcdef123456');
  assert.deepEqual(extra[1].workload, {
    kind: 'container',
    runtime: 'docker',
    id: 'abcdef123456',
    image: 'img:latest',
    state: 'running',
    status: 'Up 2 hours',
    createdAt: '2026-09-01 12:00:00 +0000 UTC',
  });
  assert.equal(extra[2].name, 'studio/docker/1234567890ab');
  assert.deepEqual(report.system, { os: 'macOS', osVersion: '15.6.1', hostname: 'studio.lan' });
  assert.ok(calls.some((c) => c.argv.join(' ') === DOCKER_PS));
});

test('ssh-mac docker is absent when command -v fails, without touching the runtime', async () => {
  const { exec, calls } = stubbed({ ...MAC });
  const report = await collectMac(exec, { containers: ['docker'] }, {}, { name: 'studio' });
  assert.deepEqual((report[EXTRA_RECORDS] ?? []).map((r) => r.workload), [
    { kind: 'container-runtime', runtime: 'docker', state: 'absent', truncated: false },
  ]);
  assert.ok(!calls.some((c) => c.argv[0] === 'docker'), 'version and ps never run');
});

test('ssh-linux reports absent for a missing binary without a command -v probe', async () => {
  const { exec, calls } = stubbed({
    ...LINUX,
    [DOCKER_VERSION]: { code: 127, stdout: '', stderr: 'docker: command not found' },
  });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  assert.deepEqual((report[EXTRA_RECORDS] ?? []).map((r) => r.workload.state), ['absent']);
  assert.ok(!calls.some((c) => c.argv.join(' ') === 'command -v docker'), 'no presence probe on linux');
  assert.ok(!calls.some((c) => c.argv.join(' ') === DOCKER_PS)), 'no ps after a missing binary';
});

test('a version without a Server section is stopped, and ps never runs', async () => {
  const { exec, calls } = stubbed({ ...LINUX, [PODMAN_VERSION]: { code: 1, stdout: `${clientOnlyVersion}\n`, stderr: 'Cannot connect' } });
  const report = await collectLinux(exec, { containers: ['podman'] }, {}, { name: 'vm' });
  assert.deepEqual((report[EXTRA_RECORDS] ?? []).map((r) => r.workload.state), ['stopped']);
  assert.ok(!calls.some((c) => c.argv[0] === 'podman' && c.argv[1] === 'ps'));
});

test('unparsable ps output is unavailable, never a host error', async () => {
  const { exec } = stubbed({ ...LINUX, [DOCKER_VERSION]: serverVersion, [DOCKER_PS]: 'not json at all{{{' });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.equal(extra.length, 1);
  assert.equal(extra[0].workload.state, 'unavailable');
  assert.equal(report.error, undefined);
});

test('oversized ps output, cut mid-row by the byte cap, is unavailable', async () => {
  // The SSH runner caps stdout at 1 MiB (src/ssh.mjs); a stream cut there
  // ends mid-JSON-row, which must parse as unavailable, not partial rows.
  const cut = row('a'.repeat(64)).slice(0, 40);
  const { exec } = stubbed({ ...LINUX, [DOCKER_VERSION]: serverVersion, [DOCKER_PS]: cut });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.equal(extra.length, 1);
  assert.equal(extra[0].workload.state, 'unavailable');
  assert.equal(report.error, undefined);
});

test('a cap-truncated ps is unavailable even when its rows parse', async () => {
  // The first rows of a cut stream are whole JSON, so they would parse; the
  // truncatedOutput flag is what marks the listing incomplete.
  const { exec } = stubbed({
    ...LINUX,
    [DOCKER_VERSION]: serverVersion,
    [DOCKER_PS]: { code: 0, stdout: `${row(ID64)}\n`, stderr: '', timedOut: false, truncatedOutput: true },
  });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.equal(extra.length, 1);
  assert.equal(extra[0].workload.state, 'unavailable');
  assert.equal(report.error, undefined);
});

test('ids failing the id pattern get distinct unknown-N names in row order', async () => {
  const good = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const { exec } = stubbed({
    ...LINUX,
    [DOCKER_VERSION]: serverVersion,
    [DOCKER_PS]: `${row('not an id!')}\n${row(good)}\n${row('y'.repeat(300))}\n`,
  });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.deepEqual(extra.map((r) => r.name), [
    'vm/docker',
    'vm/docker/unknown-1',
    `vm/docker/${good.slice(0, 12)}`,
    'vm/docker/unknown-2',
  ]);
  assert.deepEqual(extra.slice(1).map((r) => r.workload.id), ['unknown-1', good.slice(0, 12), 'unknown-2']);
});

test('container ids go through sanitizeId', async () => {
  // BEL and bidi marks are stripped; the raw bytes must never reach the
  // record name or the workload id.
  const controlId = 'abc\x07def123456789';
  const bidiId = 'ab\u200ecd0011223344';
  const overlongId = `zz${'z'.repeat(300)}`;
  assert.equal(sanitizeId(controlId), 'abcdef123456789');
  assert.equal(sanitizeId(bidiId), 'abcd0011223344');
  assert.equal(sanitizeId(overlongId), 'unknown');
  const { exec } = stubbed({
    ...LINUX,
    [DOCKER_VERSION]: serverVersion,
    [DOCKER_PS]: `${row(controlId)}\n${row(bidiId)}\n${row(overlongId)}\n`,
  });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.deepEqual(extra.map((r) => r.name), [
    'vm/docker',
    'vm/docker/abcdef123456',
    'vm/docker/abcd00112233',
    'vm/docker/unknown-1',
  ]);
  for (const [record, raw] of [[extra[1], controlId], [extra[2], bidiId]]) {
    assert.equal(record.workload.id, sanitizeId(raw).slice(0, 12));
  }
  assert.equal(extra[3].workload.id, 'unknown-1');
  assert.ok(!extra.some((r) => r.name.includes('\x07') || r.name.includes('\u200e')));
});

test('at most 100 containers per runtime, extras flagged truncated', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `id${String(i).padStart(62, '0')}`);
  const { exec } = stubbed({ ...LINUX, [DOCKER_VERSION]: serverVersion, [DOCKER_PS]: ids.map((id) => row(id)).join('\n') });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.equal(extra.length, 101);
  assert.equal(extra[0].workload.truncated, true);
  assert.equal(extra[0].workload.state, 'ok');
  assert.equal(extra[100].name, `vm/docker/${ids[99].slice(0, 12)}`);
});

test('a whole-output JSON array parses, and bad rows are skipped', async () => {
  assert.deepEqual(parsePsOutput(JSON.stringify([{ ID: 'a' }, { ID: 'b' }])).length, 2);
  assert.deepEqual(parsePsOutput(''), []);
  assert.equal(parsePsOutput('garbage'), null);
  const { exec } = stubbed({
    ...LINUX,
    [DOCKER_VERSION]: serverVersion,
    [DOCKER_PS]: `${row('good00000000000000000000000000000000000000000000000000000001')}\n42\n${JSON.stringify({ Image: 'x' })}\n`,
  });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.equal(extra.length, 2, 'one runtime record plus the single good row');
  assert.equal(extra[1].name, 'vm/docker/good00000000');
});

test('strings are sanitized and local timestamps are kept verbatim', async () => {
  const { exec } = stubbed({
    ...LINUX,
    [DOCKER_VERSION]: serverVersion,
    [DOCKER_PS]: `${row(ID64, { Image: '[31mimg', CreatedAt: '2026-09-01 12:00:00 +0000 UTC' })}\n`,
  });
  const report = await collectLinux(exec, { containers: ['docker'] }, {}, { name: 'vm' });
  const workload = (report[EXTRA_RECORDS] ?? [])[1].workload;
  assert.equal(workload.image, '[31mimg');
  assert.equal(workload.createdAt, '2026-09-01 12:00:00 +0000 UTC');
});

test('a runtime failure never errors the host and never stops other runtimes', async () => {
  const { exec } = stubbed({
    ...LINUX,
    [DOCKER_VERSION]: { code: 127, stdout: '', stderr: 'not found' },
    [PODMAN_VERSION]: serverVersion,
    [PODMAN_PS]: `${row(ID64)}\n`,
  });
  const report = await collectLinux(exec, { containers: ['docker', 'podman'] }, {}, { name: 'vm' });
  const extra = report[EXTRA_RECORDS] ?? [];
  assert.deepEqual(extra.map((r) => [r.name, r.workload.state]), [
    ['vm/docker', 'absent'],
    ['vm/podman', 'ok'],
    [`vm/podman/${ID64.slice(0, 12)}`, 'running'],
  ]);
});

test('podman on ssh-mac goes straight to version, with no command -v', async () => {
  const { exec, calls } = stubbed({ ...MAC, [PODMAN_VERSION]: serverVersion, [PODMAN_PS]: '' });
  const report = await collectMac(exec, { containers: ['podman'] }, {}, { name: 'studio' });
  assert.equal((report[EXTRA_RECORDS] ?? [])[0].workload.state, 'ok');
  assert.ok(!calls.some((c) => c.argv[0] === 'command' && c.argv[2] === 'podman'));
});

test('versionServer distinguishes server, client-only and garbage', () => {
  assert.equal(versionServer(serverVersion), true);
  assert.equal(versionServer(clientOnlyVersion), false);
  assert.equal(versionServer('{"Server":null}'), false);
  assert.equal(versionServer('garbage'), null);
  assert.equal(versionServer(''), null);
  assert.equal(versionServer('[1]'), null);
});

test('default empty containers leave existing records identical', async () => {
  const opts = { launchdLabels: ['com.example.daemon'] };
  const before = JSON.stringify(await collectMac(stubbed(MAC).exec, opts, {}, { name: 'studio' }));
  const after = JSON.stringify(await collectMac(stubbed(MAC).exec, { ...opts, containers: [] }, {}, { name: 'studio' }));
  assert.equal(after, before);
  const { exec, calls } = stubbed(MAC);
  await collectMac(exec, opts, {}, { name: 'studio' });
  assert.ok(!calls.some((c) => c.argv[0] === 'docker' || c.argv[0] === 'podman'));
  const run = fakeRun({ a: MAC });
  const hosts = await collectFleet(validateConfig({ schemaVersion: 1, hosts: [{ name: 'a', provider: 'ssh-mac', target: 'a.example' }] }), { run });
  assert.equal(hosts.length, 1);
});

test('container options accept the runtimes and reject unknown or duplicate entries', () => {
  assert.deepEqual(providerOptions('ssh-linux', { containers: ['docker', 'podman'] }).containers, ['docker', 'podman']);
  assert.deepEqual(providerOptions('ssh-mac', { containers: [] }).containers, []);
  assert.throws(() => providerOptions('ssh-linux', { containers: ['docker', 'docker'] }), ConfigError);
  assert.throws(() => providerOptions('ssh-linux', { containers: ['crio'] }), ConfigError);
  assert.throws(() => providerOptions('ssh-mac', { containers: ['docker', 'open'] }), ConfigError);
  assert.throws(() => providerOptions('ssh-linux', { containers: 'docker' }), ConfigError);
});

test('the fleet expands container records in the existing shape, with no drift', async () => {
  const run = fakeRun({
    vm: {
      ...LINUX,
      [DOCKER_VERSION]: serverVersion,
      [DOCKER_PS]: `${row(ID64)}\n`,
    },
  });
  const config = validateConfig({
    schemaVersion: 1,
    train: { minimum: { 'agent-bot': '0.10.62' }, profileRequired: true },
    providers: { 'ssh-linux': { containers: ['docker'] } },
    hosts: [{ name: 'vm', provider: 'ssh-linux', target: 'vm.example' }],
  });
  const hosts = await collectFleet(config, { run });
  assert.deepEqual(hosts.map((h) => h.name), ['vm', 'vm/docker', `vm/docker/${ID64.slice(0, 12)}`]);
  const report = buildReport(hosts, { train: config.train, version: '0.1.0', now: new Date('2026-10-11T12:00:00Z') });
  assert.deepEqual(Object.keys(report.hosts[1]), ['name', 'provider', 'status', 'reachable', 'error', 'system', 'components', 'profile', 'persona', 'services', 'workload', 'drift']);
  assert.deepEqual(report.hosts[1].workload, { kind: 'container-runtime', runtime: 'docker', state: 'ok', truncated: false });
  for (const host of report.hosts.slice(1)) {
    assert.equal(host.status, 'ok');
    assert.deepEqual(host.drift, []);
  }
  assert.deepEqual(report.summary, { hosts: 3, ok: 2, drift: 1, partial: 0, unreachable: 0 });
});

test('a container timeout is partial and keeps the runtimes already probed', async () => {
  const table = {
    ...MAC,
    'command -v docker': '/usr/bin/docker\n',
    [DOCKER_VERSION]: serverVersion,
    [DOCKER_PS]: `${row(ID64)}\n`,
    [PODMAN_VERSION]: serverVersion,
  };
  const run = fakeRun({
    a: (argv) => argv[0] === 'podman' && argv[1] === 'ps' ? { code: 255, stdout: '', stderr: '', timedOut: true } : table[argv.join(' ')],
  });
  const config = validateConfig({
    schemaVersion: 1,
    providers: { 'ssh-mac': { containers: ['docker', 'podman'] } },
    hosts: [{ name: 'a', provider: 'ssh-mac', target: 'a.example' }],
  });
  const hosts = await collectFleet(config, { run });
  assert.equal(hosts[0].reachable, true);
  assert.match(hosts[0].error, /timed out after 30s/);
  assert.deepEqual(hosts.map((h) => h.name), ['a', 'a/docker', `a/docker/${ID64.slice(0, 12)}`]);
});
