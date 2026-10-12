// Provider registry. A provider exports collect(exec, options), its DEFAULTS
// and the component ids it expects; every provider returns the same report
// shape, so adding one changes neither the config nor the output format.
import { ConfigError } from '../config.mjs';
import * as cursor from './cursor.mjs';
import * as githubCopilot from './github-copilot.mjs';
import * as sshLinux from './ssh-linux.mjs';
import * as sshMac from './ssh-mac.mjs';

export const providers = Object.freeze({
  'ssh-mac': sshMac,
  'ssh-linux': sshLinux,
  'github-copilot': githubCopilot,
  cursor,
});

// Merge a provider's config block over its defaults. Keys and types must match
// the defaults; the values are paths and names, and every path still passes
// the probe allowlist when it is used.
export function providerOptions(name, raw = {}) {
  const { DEFAULTS } = providers[name];
  const options = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new ConfigError(`providers.${name}: unknown key "${key}"`);
    const want = Array.isArray(DEFAULTS[key]) ? 'array' : typeof DEFAULTS[key];
    const ok = want === 'array' ? Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
      : want === 'number' ? Number.isInteger(value)
        : typeof value === want && value.length > 0;
    if (!ok) throw new ConfigError(`providers.${name}.${key} must be ${want === 'array' ? 'an array of strings' : want === 'number' ? 'an integer' : `a ${want}`}`);
    options[key] = value;
  }
  const problem = providers[name].validateOptions?.(options);
  if (problem) throw new ConfigError(`providers.${name}: ${problem}`);
  return options;
}
