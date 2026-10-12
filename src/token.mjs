// Where API providers get their token. The default reads one generic password
// from the control Mac's login Keychain with /usr/bin/security; tests inject
// their own source, so no test ever touches a real Keychain.
//
// The token is returned to the caller and nothing else: it is never logged,
// printed, cached on disk or put in an error message.
import { execFile } from 'node:child_process';

export class TokenUnavailable extends Error {}

// A token source is async ({ service, account }) -> string.
export function keychainTokenSource({ execFileImpl = execFile, platform = process.platform, timeoutMs = 10_000 } = {}) {
  return ({ service, account }) => new Promise((resolve, reject) => {
    if (platform !== 'darwin') {
      reject(new TokenUnavailable('the Keychain token source needs macOS'));
      return;
    }
    execFileImpl('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      // security's own messages are not passed on: only a fixed description.
      if (error) {
        reject(new TokenUnavailable(`no token in the Keychain for service "${service}", account "${account}" (see the provider doc for setup steps)`));
        return;
      }
      const token = String(stdout).trim();
      if (!token) reject(new TokenUnavailable(`the Keychain item for service "${service}" is empty`));
      else resolve(token);
    });
  });
}

// Remove a secret from text before it can reach output.
export function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.split(secret).join('[redacted]') : s;
}
