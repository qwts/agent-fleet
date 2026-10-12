import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { browse, browseCommand, parseAvahi, parseDnsSd, suggestions } from '../src/discover.mjs';
import { run, scratchHome, writeConfig } from './helpers.mjs';

const DNS_SD = `Browsing for _ssh._tcp.local.
DATE: ---Sat 11 Oct 2026---
20:00:00.000  ...STARTING...
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
20:00:00.101  Add        3  14 local.               _ssh._tcp.           mac-1
20:00:00.102  Add        3  14 local.               _ssh._tcp.           Studio Mac
20:00:00.103  Add        2  15 local.               _ssh._tcp.           mac-1
20:00:00.104  Rmv        0  14 local.               _ssh._tcp.           gone
`;

const AVAHI = '+;eth0;IPv4;vm\\0321;_ssh._tcp;local\n+;eth0;IPv6;vm\\0321;_ssh._tcp;local\n+;eth0;IPv4;printer;_ipp._tcp;local\n';

test('dns-sd and avahi output parse to unique instance names', () => {
  assert.deepEqual(parseDnsSd(DNS_SD), ['Studio Mac', 'mac-1']);
  assert.deepEqual(parseAvahi(AVAHI), ['vm 1']);
  assert.equal(browseCommand('darwin').bin, 'dns-sd');
  assert.equal(browseCommand('linux').bin, 'avahi-browse');
});

test('suggestions mark names that are already configured', () => {
  const hosts = [{ name: 'studio', target: 'admin@mac-1.local' }];
  assert.deepEqual(suggestions(['mac-1', 'Studio Mac'], hosts), [
    { name: 'mac-1', target: 'mac-1.local', configured: true },
    { name: 'Studio Mac', target: 'studio-mac.local', configured: false },
  ]);
});

test('browse stops dns-sd after the timeout and parses what it saw', async () => {
  let killed = null;
  const spawnImpl = (bin, args) => {
    assert.deepEqual([bin, ...args], ['dns-sd', '-B', '_ssh._tcp', 'local.']);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = (signal) => { killed = signal; };
    setImmediate(() => child.stdout.emit('data', DNS_SD));
    return child;
  };
  const result = await browse({ platform: 'darwin', seconds: 0.02, spawnImpl });
  assert.deepEqual(result, { names: ['Studio Mac', 'mac-1'], error: null });
  assert.equal(killed, 'SIGTERM');
});

test('a browse command that fails is reported as an error', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', 1));
    return child;
  };
  const result = await browse({ platform: 'linux', seconds: 5, spawnImpl });
  assert.deepEqual(result, { names: [], error: 'avahi-browse exited with 1' });
});

test('discover prints suggestions and never touches the config', async (t) => {
  const { home, env } = scratchHome(t);
  const file = writeConfig(home, { schemaVersion: 1, hosts: [{ name: 'mac-1', provider: 'ssh-mac', target: 'mac-1.local' }] });
  const before = readFileSync(file, 'utf8');
  const browseImpl = async () => ({ names: ['mac-1', 'Studio Mac'], error: null });
  const text = await run(['discover'], { env, browseImpl });
  assert.equal(text.code, 0);
  assert.match(text.out, /configured\s+mac-1/);
  assert.match(text.out, /new\s+Studio Mac  \(studio-mac\.local\)/);
  assert.match(text.out, /suggestions only/);
  const json = JSON.parse((await run(['discover', '--json'], { env, browseImpl })).out);
  assert.deepEqual(json.suggestions.map((s) => s.configured), [true, false]);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('discover works without a config and reports a failed browse', async (t) => {
  const { env } = scratchHome(t);
  const ok = await run(['discover'], { env, browseImpl: async () => ({ names: [], error: null }) });
  assert.equal(ok.code, 0);
  assert.match(ok.out, /No _ssh\._tcp adverts seen/);
  const failed = await run(['discover'], { env, browseImpl: async () => ({ names: [], error: 'spawn dns-sd ENOENT' }) });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /Bonjour browse failed/);
  const partial = await run(['discover'], { env, browseImpl: async () => ({ names: ['mac-1'], error: 'dns-sd exited with 1' }) });
  assert.equal(partial.code, 1, 'partial suggestions do not hide a failure');
  assert.match(partial.out, /mac-1/);
  assert.equal((await run(['discover', '--seconds', '0'], { env })).code, 2);
});

test('discover reports a broken default config instead of ignoring it', async (t) => {
  const { home, env } = scratchHome(t);
  writeConfig(home, '{broken');
  const { code, err } = await run(['discover'], { env, browseImpl: async () => assert.fail('must not browse') });
  assert.equal(code, 2);
  assert.match(err, /not valid JSON/);
});
