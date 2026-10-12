import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ProbeNotAllowed } from '../src/allowlist.mjs';
import { createSshRunner, sshArgs } from '../src/ssh.mjs';

const host = { name: 'h', target: 'me@h.example', port: 2222 };
const ssh = { connectTimeoutSeconds: 5 };

function fakeChild({ code = 0, stdout = '', hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = null;
  child.kill = (signal) => { child.killed = signal; setImmediate(() => child.emit('close', null)); };
  if (!hang) setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', code); });
  return child;
}

test('ssh is non-interactive and the target comes after --', () => {
  const args = sshArgs(host, ssh, ['launchctl', 'list']);
  for (const opt of ['BatchMode=yes', 'ConnectTimeout=5', 'StrictHostKeyChecking=accept-new', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ForwardAgent=no']) {
    assert.ok(args.includes(opt), opt);
  }
  assert.ok(args.includes('-T') && args.includes('-n'));
  assert.ok(!args.includes('StrictHostKeyChecking=no'));
  assert.deepEqual(args.slice(-3), ['--', 'me@h.example', "'launchctl' 'list'"]);
  assert.deepEqual(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2), ['-p', '2222']);
});

test('the runner refuses a forbidden probe before spawning anything', async () => {
  let spawned = false;
  const run = createSshRunner({ ssh, spawnImpl: () => { spawned = true; return fakeChild(); } });
  await assert.rejects(() => run(host, ['agent-bot', 'doctor'], { timeoutMs: 1000 }), ProbeNotAllowed);
  await assert.rejects(() => run(host, ['brew', 'upgrade'], { timeoutMs: 1000 }), ProbeNotAllowed);
  assert.equal(spawned, false);
});

test('the runner closes stdin and returns output and exit code', async () => {
  let seen;
  const run = createSshRunner({ ssh, spawnImpl: (bin, args, opts) => { seen = { bin, args, opts }; return fakeChild({ code: 0, stdout: '15.6\n' }); } });
  const result = await run(host, ['defaults', 'read', '/System/Library/CoreServices/SystemVersion', 'ProductVersion'], { timeoutMs: 1000 });
  assert.deepEqual(result, { code: 0, stdout: '15.6\n', stderr: '', timedOut: false });
  assert.equal(seen.bin, 'ssh');
  assert.equal(seen.opts.stdio[0], 'ignore');
});

test('a probe past its timeout is killed and reported as ssh failure', async () => {
  let child;
  const run = createSshRunner({ ssh, spawnImpl: () => (child = fakeChild({ hang: true })) });
  const result = await run(host, ['launchctl', 'list'], { timeoutMs: 20 });
  assert.equal(result.code, 255);
  assert.equal(result.timedOut, true);
  assert.equal(child.killed, 'SIGKILL');
});

test('a missing ssh binary is a failure, not a crash', async () => {
  const run = createSshRunner({ ssh, spawnImpl: () => { const c = fakeChild({ hang: true }); setImmediate(() => c.emit('error', new Error('spawn ssh ENOENT'))); return c; } });
  const result = await run(host, ['launchctl', 'list'], { timeoutMs: 1000 });
  assert.equal(result.code, 255);
  assert.match(result.stderr, /ENOENT/);
});
