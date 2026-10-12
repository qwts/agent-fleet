import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigError, configPath, loadConfig } from './config.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const USAGE = `agent-fleet — read-only status of an agent-runtime fleet

Usage:
  agent-fleet status [--json] [--config PATH]
  agent-fleet --version
  agent-fleet --help

The config file defaults to $AGENT_FLEET_CONFIG, else
\${XDG_CONFIG_HOME:-~/.config}/agent-fleet/config.json.
agent-fleet never changes anything on any host.
`;

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (error) {
    stderr.write(`agent-fleet: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const [command, ...rest] = positionals;
  if (command !== 'status' || rest.length > 0) {
    stderr.write(`agent-fleet: unknown command "${positionals.join(' ')}"\n\n${USAGE}`);
    return 2;
  }

  let config;
  try {
    config = await loadConfig(configPath({ env, explicit: values.config }));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(`agent-fleet: ${error.message}\n`);
    return 2;
  }

  const report = {
    schemaVersion: 1,
    hosts: config.hosts.map((host) => ({ name: host.name, provider: host.provider, probed: false })),
  };
  if (values.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const host of report.hosts) stdout.write(`${host.name}  ${host.provider}  not probed\n`);
  }
  return 0;
}
