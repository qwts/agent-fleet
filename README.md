# agent-fleet

Read-only status of an agent-runtime fleet — Macs and Linux VMs — pulled over
SSH from one control machine: versions, org profile, identity daemons, and
drift from a release train. It changes nothing on any host.

Status: early. The CLI and config are in place; probes, drift and full JSON
output land in the next pull requests.

## Usage

```sh
mkdir -p ~/.config/agent-fleet
cp examples/config.example.json ~/.config/agent-fleet/config.json   # then list your hosts
node bin/agent-fleet.mjs status
node bin/agent-fleet.mjs status --json
```

The config file is `$AGENT_FLEET_CONFIG`, else
`${XDG_CONFIG_HOME:-~/.config}/agent-fleet/config.json`, or `--config PATH`.
Host names live only there; this repository ships none.

## Safety contract

- Read-only. Probes may only read files and run `--version`,
  `launchctl list`, `readlink`, `defaults read` and
  `systemctl --user is-active`. Never `agent-bot doctor` or `bootstrap`,
  `keyd`, `managed-machine`, `brew`, or anything that installs, writes or
  prompts.
- SSH is non-interactive: `BatchMode=yes`, a connect timeout, no TTY, no
  stdin, and `StrictHostKeyChecking=accept-new` for first use only.

See [ADR-0001](docs/decisions/ADR-0001-read-only-fleet-status.md) for the
decisions behind this.

## Development

Node 20 or later, no dependencies.

```sh
npm test
```

## License

MIT
