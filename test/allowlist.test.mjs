import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProbeNotAllowed, assertAllowed, toRemoteCommand } from '../src/allowlist.mjs';
import { collect as collectLinux } from '../src/providers/ssh-linux.mjs';
import { collect as collectMac } from '../src/providers/ssh-mac.mjs';

const allowed = [
  ['cat', '/etc/os-release'],
  ['cat', '.config/agent-bot/config.json'],
  ['cat', '/Applications/Genius Bar.app/Contents/Resources/components/agent-bot/package.json'],
  ['test', '-f', '.local/state/agent-bot/agent-identities/sop-persona.json'],
  ['readlink', '/opt/homebrew/opt/agent-bot'],
  ['readlink', '-f', '/usr/local/bin/agent-bot'],
  ['defaults', 'read', '/System/Library/CoreServices/SystemVersion', 'ProductVersion'],
  ['defaults', 'read', '/Library/Preferences/SystemConfiguration/preferences', 'System'],
  ['launchctl', 'list'],
  ['systemctl', '--user', 'is-active', 'agent-bot-daemon', 'agent-comms-broker'],
  ['command', '-v', 'agent-bot'],
  ['agent-bot', '--version'],
  ['/home/me/.local/bin/agent-bot', '--version'],
];

const refused = [
  [],
  ['agent-bot', 'doctor'],
  ['agent-bot', 'bootstrap'],
  ['agent-bot', 'doctor', '--version'],
  ['agent-bot', 'keyd', 'status'],
  ['/opt/homebrew/bin/agent-bot', 'update'],
  ['brew', '--version'],
  ['/opt/homebrew/bin/brew', '--version'],
  ['brew', 'list'],
  ['keyd', '--version'],
  ['agent-bot-keyd', '--version'],
  ['managed-machine', '--version'],
  ['node', '--version'],
  ['rm', '--version'],
  ['sudo', 'cat', '/etc/shadow'],
  ['sh', '-c', 'id'],
  ['defaults', 'write', 'com.example', 'k', 'v'],
  ['defaults', 'delete', 'com.example'],
  ['defaults', 'read', '-currentHost'],
  ['launchctl', 'load', '/Library/LaunchAgents/x.plist'],
  ['launchctl', 'bootstrap', 'gui/501', 'x.plist'],
  ['launchctl', 'kickstart', '-k', 'gui/501/x'],
  ['launchctl', 'list', 'com.example'],
  ['systemctl', '--user', 'start', 'agent-bot-daemon'],
  ['systemctl', '--user', 'restart', 'agent-bot-daemon'],
  ['systemctl', 'is-active', 'sshd'],
  ['systemctl', '--user', 'is-active', '--now', 'x'],
  ['cat', '-v', '/etc/passwd'],
  ['cat', '/etc/os-release', '/etc/hostname'],
  ['cat', '../../etc/shadow'],
  ['cat', '/etc/../etc/shadow'],
  ['cat', '/etc/os-release; reboot'],
  ['cat', '$(reboot)'],
  ['cat', '`reboot`'],
  ['cat', "/tmp/a'b"],
  ['cat', '/tmp/a\nreboot'],
  ['cat', '/tmp/a|tee'],
  ['cat', '/tmp/a>b'],
  ['cat', '~/.ssh/id_ed25519'],
  ['test', '-w', '/etc'],
  ['readlink', '-n', '-f', '/x'],
  ['command', 'agent-bot'],
  ['command', '-v', 'agent-bot;id'],
  ['tee', '/tmp/x'],
  ['touch', '/tmp/x'],
  ['cp', '/a', '/b'],
  ['agent-bot', '--version', 'extra'],
];

test('every allowed probe shape passes', () => {
  for (const argv of allowed) assert.deepEqual(assertAllowed(argv), argv);
});

test('anything that could write, install, prompt or escape is refused', () => {
  for (const argv of refused) assert.throws(() => assertAllowed(argv), ProbeNotAllowed, JSON.stringify(argv));
  for (const bad of [null, 'cat /etc/hosts', [1, 2], ['cat', '']]) assert.throws(() => assertAllowed(bad), ProbeNotAllowed);
});

test('remote commands are single-quoted argument by argument', () => {
  assert.equal(toRemoteCommand(['cat', '/Applications/Genius Bar.app/x']), "'cat' '/Applications/Genius Bar.app/x'");
  assert.throws(() => toRemoteCommand(['launchctl', 'load', 'x']), ProbeNotAllowed);
});

test('the providers issue only allowed commands, whatever the host answers', async () => {
  for (const collect of [collectMac, collectLinux]) {
    const seen = [];
    const exec = async (argv) => {
      assertAllowed(argv);
      seen.push(argv);
      // Hostile answers: paths and versions full of shell syntax.
      if (argv[0] === 'command') return { code: 0, stdout: '/x/agent-bot; reboot\n' };
      return { code: 0, stdout: '$(reboot) 1.2.3' };
    };
    const report = await collect(exec, collect === collectMac ? { launchdLabels: ['com.example.daemon'] } : {});
    assert.ok(seen.length >= 5);
    assert.equal(report.components.find((c) => c.source === 'path').path, null);
  }
});
