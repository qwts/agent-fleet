// Suggest hosts from Bonjour `_ssh._tcp` adverts on the local network. It
// only browses on this machine and prints suggestions; it never adds a host
// to the config and never connects to anything (ADR-0001 §3).
import { spawn } from 'node:child_process';

// dns-sd browses until killed; avahi-browse -t stops on its own.
export function browseCommand(platform) {
  if (platform === 'darwin') return { bin: 'dns-sd', args: ['-B', '_ssh._tcp', 'local.'], parse: parseDnsSd };
  return { bin: 'avahi-browse', args: ['-t', '-p', '-k', '_ssh._tcp'], parse: parseAvahi };
}

export function browse({ platform = process.platform, seconds = 3, spawnImpl = spawn } = {}) {
  const { bin, args, parse } = browseCommand(platform);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ names: [], error: `${bin}: ${error.message}` });
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ names: parse(out), error: error ?? null });
    };
    let stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill('SIGTERM'); finish(); }, seconds * 1000);
    child.stdout.on('data', (d) => { if (out.length < 1024 * 1024) out += d; });
    child.on('error', (error) => finish(`${bin}: ${error.message}`));
    // Stopping dns-sd ourselves is the normal end; any other non-zero exit
    // is a failed browse.
    child.on('close', (code) => finish(!stopped && code !== 0 ? `${bin} exited with ${code ?? 'a signal'}` : undefined));
  });
}

export function parseDnsSd(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const match = /\sAdd\s+\d+\s+\d+\s+\S+\s+_ssh\._tcp\.\s+(.+?)\s*$/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

export function parseAvahi(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const fields = line.split(';');
    if (fields[0] === '+' && fields[4] === '_ssh._tcp') {
      names.add(fields[3].replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(Number(d))));
    }
  }
  return [...names].sort();
}

// A name is already configured when it matches a host's name or the host part
// of its target, with or without ".local".
export function suggestions(names, hosts) {
  const known = new Set();
  for (const host of hosts) {
    known.add(host.name.toLowerCase());
    known.add(host.target.split('@').pop().toLowerCase().replace(/\.local$/, ''));
  }
  return names.map((name) => {
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    return { name, target: `${slug}.local`, configured: known.has(name.toLowerCase()) || known.has(slug) };
  });
}
