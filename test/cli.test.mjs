import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAC, fakeRun, run, scratchHome, writeConfig } from './helpers.mjs';

const config = {
  schemaVersion: 1,
  hosts: [
    { name: 'studio', provider: 'ssh-mac', target: 'me@studio.example' },
    { name: 'vm', provider: 'ssh-linux', target: 'vm.example' },
  ],
};

test('--help and no arguments print usage', async (t) => {
  const { env } = scratchHome(t);
  assert.equal((await run(['--help'], { env })).code, 0);
  const bare = await run([], { env });
  assert.equal(bare.code, 2);
  assert.match(bare.out, /agent-fleet status/);
});

test('--version prints the package version', async (t) => {
  const { env } = scratchHome(t);
  const { code, out } = await run(['--version'], { env });
  assert.equal(code, 0);
  assert.match(out, /^\d+\.\d+\.\d+\n$/);
});

test('unknown commands and flags exit 2', async (t) => {
  const { env } = scratchHome(t);
  assert.equal((await run(['restart'], { env })).code, 2);
  assert.equal((await run(['status', '--fix'], { env })).code, 2);
});

test('status without a config explains where to put one', async (t) => {
  const { env } = scratchHome(t);
  const { code, err } = await run(['status'], { env });
  assert.equal(code, 2);
  assert.match(err, /no config at .*agent-fleet\/config\.json/);
});

test('status lists the configured hosts', async (t) => {
  const { home, env } = scratchHome(t);
  writeConfig(home, config);
  const text = await run(['status'], { env });
  assert.equal(text.code, 0);
  assert.match(text.out, /studio \(ssh-mac\)  UNREACHABLE/);
  const json = await run(['status', '--json'], { env });
  assert.deepEqual(JSON.parse(json.out).hosts.map((h) => h.name), ['studio', 'vm']);
});

test('--config overrides the default path', async (t) => {
  const { home, env } = scratchHome(t);
  const file = writeConfig(home, config);
  const { code } = await run(['status', '--config', file], { env: { HOME: '/nonexistent' } });
  assert.equal(code, 0);
});

test('status probes reachable hosts and reports unreachable ones', async (t) => {
  const { home, env } = scratchHome(t);
  writeConfig(home, config);
  const stub = fakeRun({ studio: MAC });
  const text = await run(['status'], { env, run: stub });
  assert.equal(text.code, 0);
  assert.match(text.out, /studio \(ssh-mac\)  macOS 15\.6\.1  hostname studio\.lan/);
  assert.match(text.out, /agent-bot\s+homebrew\s+0\.10\.64/);
  assert.match(text.out, /profile\s+applied/);
  assert.match(text.out, /vm \(ssh-linux\)  UNREACHABLE  unreachable: /);
  const json = JSON.parse((await run(['status', '--json'], { env, run: stub })).out);
  assert.deepEqual(json.hosts.map((h) => h.reachable), [true, false]);
});
