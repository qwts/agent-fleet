// Probe every configured host in parallel, each within its own deadline.
// A host that cannot be reached, or runs out of time, is reported with an
// error; it never stops the others.
import { ProbeNotAllowed } from './allowlist.mjs';
import { providerOptions, providers } from './providers/index.mjs';

class HostError extends Error {}

// Each config host yields one or more host records: an SSH host one, an API
// provider an account record plus one per workload it lists.
export async function collectFleet(config, { run, fetchImpl, tokenSource }) {
  // Options are built only for providers the fleet actually uses: a provider
  // with required options (such as devin's orgId) has invalid defaults, and
  // must not break fleets that never touch it.
  const used = new Set(config.hosts.map((host) => host.provider));
  const options = Object.fromEntries([...used].map((name) => [name, providerOptions(name, config.providers[name])]));
  const queue = config.hosts.map((host, index) => ({ host, index }));
  const results = new Array(config.hosts.length);
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const provider = providers[item.host.provider];
      results[item.index] = provider.kind === 'api'
        ? await provider.collect(item.host, { options: options[item.host.provider], fetchImpl, tokenSource, deadline: Date.now() + config.ssh.hostTimeoutSeconds * 1000 })
        : [await probeHost(item.host, options[item.host.provider], config.ssh, run)];
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.ssh.concurrency, queue.length) }, worker));
  return results.flat();
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
      throw new HostError(`${reached ? 'connection lost' : 'unreachable'}: ${redactTarget(firstLine(result.stderr), host) || 'ssh failed'}`);
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

// ssh names the destination in its errors; the report never carries the
// target from the config, so its user and host are replaced.
export function redactTarget(text, host) {
  const target = host.target ?? '';
  if (!target) return text;
  const at = target.lastIndexOf('@');
  const user = at > 0 ? target.slice(0, at) : null;
  const name = target.slice(at + 1);
  let out = text.split(target).join(user ? '[user]@[host]' : '[host]');
  if (user) out = out.split(`${user}@`).join('[user]@');
  return out.split(name).join('[host]');
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0].slice(0, 200);
}
