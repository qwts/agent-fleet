// Every test gets a scratch HOME: nothing reads or writes the real one.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertAllowed } from '../src/allowlist.mjs';
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

// Tests never reach a real ssh, network or Keychain: without stubs every
// host is unreachable, every request fails and there is no token.
const noFetch = async () => { throw new Error('tests must stub fetch'); };
const noToken = async () => { throw new Error('tests must stub the token source'); };

export async function run(argv, { env, run: runner = fakeRun({}), fetchImpl = noFetch, tokenSource = noToken, ...deps } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    env,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    run: runner,
    fetchImpl,
    tokenSource,
    ...deps,
  });
  return { code, out, err };
}

// A stubbed ssh runner. Every argv still passes the real allowlist, so a
// provider that issued a forbidden command fails its test. `hosts` maps a
// host name to { [argv joined by spaces]: result | string } or to a function.
export function fakeRun(hosts, { calls = [] } = {}) {
  const run = async (host, argv, { timeoutMs }) => {
    assertAllowed(argv);
    calls.push({ host: host.name, argv, timeoutMs });
    const table = hosts[host.name];
    if (table === undefined) return { code: 255, stdout: '', stderr: `ssh: connect to host ${host.target} port 22: Connection refused`, timedOut: false };
    const hit = typeof table === 'function' ? await table(argv) : table[argv.join(' ')];
    if (hit === undefined) return { code: 1, stdout: '', stderr: '', timedOut: false };
    if (typeof hit === 'string') return { code: 0, stdout: hit, stderr: '', timedOut: false };
    return { stdout: '', stderr: '', timedOut: false, ...hit };
  };
  run.calls = calls;
  return run;
}

export const MAC = {
  'defaults read /System/Library/CoreServices/SystemVersion ProductVersion': '15.6.1\n',
  'defaults read /Library/Preferences/SystemConfiguration/preferences System': '{\n    System =     {\n        ComputerName = "Studio";\n        HostName = "studio.lan";\n    };\n}\n',
  'defaults read /Applications/GeniusBar.app/Contents/Info CFBundleShortVersionString': '0.1.71\n',
  'cat /Applications/GeniusBar.app/Contents/Resources/components/agent-bot/package.json': '{"name":"agent-bot-identity","version":"0.10.62"}',
  'readlink /opt/homebrew/opt/agent-bot': '../Cellar/agent-bot/0.10.64_1\n',
  'command -v agent-bot': '/Users/me/.local/bin/agent-bot\n',
  'readlink -f /Users/me/.local/bin/agent-bot': '/opt/homebrew/Cellar/agent-bot/0.10.64_1/libexec/agent-bot\n',
  '/Users/me/.local/bin/agent-bot --version': '0.10.64\n',
  'cat .config/agent-bot/config.json': JSON.stringify({ owner: 'SECRET-OWNER', settings: { unmanagedAuthors: ['SECRET-AUTHOR'], keydTeamId: 'SECRETTEAM', other: 'SECRET-OTHER' } }),
  'test -f .local/state/agent-bot/agent-identities/sop-persona.json': '',
  'launchctl list': 'PID\tStatus\tLabel\n123\t0\tcom.example.daemon\n-\t0\tcom.apple.thing\n',
};

export const LINUX = {
  'cat /etc/os-release': 'NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
  'cat /proc/sys/kernel/hostname': 'vm-1\n',
  'cat .local/share/agent-bot/lib/agent-bot/package.json': '{"version":"0.10.60"}',
  'cat .config/agent-bot/config.json': JSON.stringify({ settings: { keydTeamId: 'SECRETTEAM' } }),
  'systemctl --user is-active agent-bot-daemon agent-comms-broker': { code: 3, stdout: 'active\ninactive\n' },
};
