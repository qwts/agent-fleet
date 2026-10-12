// The only way a probe reaches a host. Non-interactive by construction:
// BatchMode, a connect timeout, no TTY, stdin closed, and a key accepted on
// first use only (ADR-0001 §1).
import { spawn } from 'node:child_process';
import { assertAllowed, toRemoteCommand } from './allowlist.mjs';

const MAX_OUTPUT = 1024 * 1024;

export function sshArgs(host, { connectTimeoutSeconds }, argv) {
  const args = [
    '-T', '-n',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'LogLevel=ERROR',
  ];
  if (host.port) args.push('-p', String(host.port));
  args.push('--', host.target, toRemoteCommand(argv));
  return args;
}

// Returns run(host, argv, { timeoutMs }) -> { code, stdout, stderr, timedOut }.
// code 255 is ssh's own failure: the host was not reached.
export function createSshRunner({ ssh, spawnImpl = spawn, sshBin = 'ssh' }) {
  return async function run(host, argv, { timeoutMs }) {
    assertAllowed(argv);
    const args = sshArgs(host, ssh, argv);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let child;
      try {
        child = spawnImpl(sshBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' } });
      } catch (error) {
        resolve({ code: 255, stdout: '', stderr: error.message, timedOut: false });
        return;
      }
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d; });
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: timedOut ? 255 : (code ?? 255), stdout, stderr, timedOut });
      };
      child.on('error', (error) => { stderr += error.message; finish(255); });
      child.on('close', finish);
    });
  };
}
