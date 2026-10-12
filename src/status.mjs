// Probe every configured host in parallel, each within its own deadline.
// A host that cannot be reached, or runs out of time, is reported with an
// error; it never stops the others.
import { ProbeNotAllowed } from './allowlist.mjs';
import { providerOptions, providers } from './providers/index.mjs';

class HostError extends Error {}

export async function collectFleet(config, { run }) {
  const options = Object.fromEntries(Object.keys(providers).map((name) => [name, providerOptions(name, config.providers[name])]));
  const queue = config.hosts.map((host, index) => ({ host, index }));
  const results = new Array(config.hosts.length);
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      results[item.index] = await probeHost(item.host, options[item.host.provider], config.ssh, run);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.ssh.concurrency, queue.length) }, worker));
  return results;
}

async function probeHost(host, options, ssh, run) {
  const base = { name: host.name, provider: host.provider, reachable: false, error: null };
  const deadline = Date.now() + ssh.hostTimeoutSeconds * 1000;
  let reached = false;
  const exec = async (argv) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new HostError(`timed out after ${ssh.hostTimeoutSeconds}s`);
    const result = await run(host, argv, { timeoutMs });
    if (result.code === 255) {
      if (result.timedOut) throw new HostError(reached ? `timed out after ${ssh.hostTimeoutSeconds}s` : 'unreachable: timed out');
      throw new HostError(`${reached ? 'connection lost' : 'unreachable'}: ${firstLine(result.stderr) || 'ssh failed'}`);
    }
    reached = true;
    return result;
  };
  const partial = {};
  try {
    await providers[host.provider].collect(exec, options, partial);
    return { ...base, reachable: true, ...partial };
  } catch (error) {
    if (error instanceof HostError || error instanceof ProbeNotAllowed) return { ...base, ...(reached ? partial : {}), reachable: reached, error: error.message };
    throw error;
  }
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0].slice(0, 200);
}
