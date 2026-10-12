// Every test gets a scratch HOME: nothing reads or writes the real one.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.mjs';

export function scratchHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-fleet-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: { HOME: home } };
}

export function writeConfig(home, config) {
  const dir = path.join(home, '.config', 'agent-fleet');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return file;
}

export async function run(argv, { env, ...deps } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    ...deps,
  });
  return { code, out, err };
}
