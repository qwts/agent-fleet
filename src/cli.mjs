import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigError, configPath, loadConfig } from './config.mjs';
import { createSshRunner } from './ssh.mjs';
import { validateTrain } from './drift.mjs';
import { browse, suggestions } from './discover.mjs';
import { buildReport } from './report.mjs';
import { collectFleet } from './status.mjs';
import { formatText } from './format.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const USAGE = `agent-fleet — read-only status of an agent-runtime fleet

Usage:
  agent-fleet status [--json] [--config PATH]
  agent-fleet discover [--json] [--seconds N] [--config PATH]
  agent-fleet --version
  agent-fleet --help

The config file defaults to $AGENT_FLEET_CONFIG, else
\${XDG_CONFIG_HOME:-~/.config}/agent-fleet/config.json.
agent-fleet never changes anything on any host. discover only suggests
hosts seen over Bonjour (_ssh._tcp); it never adds them to the config.
`;

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, run, now = () => new Date(), browseImpl = browse } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        config: { type: 'string' },
        seconds: { type: 'string' },
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
  if (command === 'discover' && rest.length === 0) return discover(values, { env, stdout, stderr, browseImpl });
  if (command !== 'status' || rest.length > 0 || values.seconds !== undefined) {
    stderr.write(`agent-fleet: unknown command "${positionals.join(' ')}"\n\n${USAGE}`);
    return 2;
  }

  let config;
  let train;
  let hosts;
  try {
    config = await loadConfig(configPath({ env, explicit: values.config }));
    train = validateTrain(config.train);
    hosts = await collectFleet(config, { run: run ?? createSshRunner({ ssh: config.ssh }) });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(`agent-fleet: ${error.message}\n`);
    return 2;
  }

  const report = buildReport(hosts, { train, version: VERSION, now: now() });
  stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report));
  return 0;
}

async function discover(values, { env, stdout, stderr, browseImpl }) {
  const seconds = values.seconds === undefined ? 3 : Number(values.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
    stderr.write('agent-fleet: --seconds must be an integer from 1 to 60\n');
    return 2;
  }
  // The config is optional here: it only marks names already configured. A
  // missing default file is fine; a broken one is still an error.
  let hosts = [];
  const file = configPath({ env, explicit: values.config });
  if (values.config || existsSync(file)) {
    try {
      hosts = (await loadConfig(file)).hosts;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      stderr.write(`agent-fleet: ${error.message}\n`);
      return 2;
    }
  }
  const { names, error } = await browseImpl({ seconds });
  if (error) stderr.write(`agent-fleet: Bonjour browse failed: ${error}\n`);
  const found = suggestions(names, hosts);
  if (values.json) {
    stdout.write(`${JSON.stringify({ schemaVersion: 1, service: '_ssh._tcp', suggestions: found }, null, 2)}\n`);
  } else if (found.length === 0) {
    stdout.write('No _ssh._tcp adverts seen.\n');
  } else {
    for (const s of found) stdout.write(`${s.configured ? 'configured' : 'new       '}  ${s.name}  (${s.target})\n`);
    if (found.some((s) => !s.configured)) stdout.write('\nThese are suggestions only. Add a host to your config yourself to probe it.\n');
  }
  return error ? 1 : 0;
}
