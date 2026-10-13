// The user config file. It is the only place host names and other
// site-specific data live: the code ships none (ADR-0001).
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PROVIDERS = Object.freeze(['ssh-mac', 'ssh-linux', 'github-copilot', 'cursor', 'devin', 'claude-code-status']);
// Providers reached over SSH need a target; API providers take none.
const SSH_PROVIDERS = new Set(['ssh-mac', 'ssh-linux']);

export const DEFAULT_SSH = Object.freeze({
  connectTimeoutSeconds: 5,
  hostTimeoutSeconds: 30,
  concurrency: 8,
});

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'ssh', 'train', 'providers', 'hosts']);
const HOST_KEYS = new Set(['name', 'provider', 'target', 'port']);
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
// user@host, host, or user@[v6]; never an option, never shell syntax.
const SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/;

export class ConfigError extends Error {}

export function configPath({ env = process.env, explicit } = {}) {
  if (explicit) return path.resolve(explicit);
  if (env.AGENT_FLEET_CONFIG) return path.resolve(env.AGENT_FLEET_CONFIG);
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config');
  return path.join(base, 'agent-fleet', 'config.json');
}

export async function loadConfig(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new ConfigError(`no config at ${file}; copy examples/config.example.json there and list your hosts`);
    throw new ConfigError(`cannot read ${file}: ${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${error.message}`);
  }
  return validateConfig(raw);
}

export function validateConfig(raw) {
  if (!isObject(raw)) throw new ConfigError('config must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new ConfigError(`unknown config key "${key}"`);
  }
  if (raw.schemaVersion !== 1) throw new ConfigError('schemaVersion must be 1');

  const ssh = { ...DEFAULT_SSH };
  if (raw.ssh !== undefined) {
    if (!isObject(raw.ssh)) throw new ConfigError('ssh must be an object');
    for (const [key, value] of Object.entries(raw.ssh)) {
      if (!Object.hasOwn(DEFAULT_SSH, key)) throw new ConfigError(`unknown ssh key "${key}"`);
      if (!Number.isInteger(value) || value < 1 || value > 600) throw new ConfigError(`ssh.${key} must be an integer from 1 to 600`);
      ssh[key] = value;
    }
  }
  if (ssh.hostTimeoutSeconds <= ssh.connectTimeoutSeconds) {
    throw new ConfigError('ssh.hostTimeoutSeconds must be greater than ssh.connectTimeoutSeconds');
  }

  if (raw.train !== undefined && !isObject(raw.train)) throw new ConfigError('train must be an object');

  const providers = {};
  if (raw.providers !== undefined) {
    if (!isObject(raw.providers)) throw new ConfigError('providers must be an object');
    for (const [name, value] of Object.entries(raw.providers)) {
      if (!PROVIDERS.includes(name)) throw new ConfigError(`unknown provider "${name}"`);
      if (!isObject(value)) throw new ConfigError(`providers.${name} must be an object`);
      providers[name] = value;
    }
  }

  if (!Array.isArray(raw.hosts)) throw new ConfigError('hosts must be an array');
  const seen = new Set();
  const hosts = raw.hosts.map((host, index) => {
    const where = `hosts[${index}]`;
    if (!isObject(host)) throw new ConfigError(`${where} must be an object`);
    for (const key of Object.keys(host)) {
      if (!HOST_KEYS.has(key)) throw new ConfigError(`${where}: unknown key "${key}"`);
    }
    if (typeof host.name !== 'string' || !HOST_NAME.test(host.name)) throw new ConfigError(`${where}.name must be a short name of letters, digits, ".", "_" or "-"`);
    if (seen.has(host.name)) throw new ConfigError(`${where}: duplicate host name "${host.name}"`);
    seen.add(host.name);
    if (!PROVIDERS.includes(host.provider)) throw new ConfigError(`${where}.provider must be one of ${PROVIDERS.join(', ')}`);
    if (SSH_PROVIDERS.has(host.provider)) {
      if (typeof host.target !== 'string' || !SSH_TARGET.test(host.target) || host.target.startsWith('-')) {
        throw new ConfigError(`${where}.target must be host or user@host`);
      }
    } else if (host.target !== undefined || host.port !== undefined) {
      throw new ConfigError(`${where}: provider ${host.provider} takes no target or port`);
    }
    if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) {
      throw new ConfigError(`${where}.port must be an integer from 1 to 65535`);
    }
    return Object.freeze({ name: host.name, provider: host.provider, target: host.target, port: host.port });
  });

  return Object.freeze({ schemaVersion: 1, ssh: Object.freeze(ssh), train: raw.train ?? {}, providers, hosts });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
