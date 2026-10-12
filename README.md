# agent-fleet

Read-only status of an agent-runtime fleet — Macs and Linux VMs — pulled over
SSH from one control machine: versions, org profile, identity daemons, and
drift from a release train. It changes nothing on any host.

Status: early. Probes are in place; drift and the full JSON contract land in
the next pull requests.

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

## What it reports

Each host has a provider. Both v1 providers report the same shape:

- **`ssh-mac`:** macOS version and hostname; GeniusBar's version and its
  bundled agent-bot (read from the app bundle); Homebrew's agent-bot (from the
  `opt` link); the agent-bot on `PATH` and where it resolves; launchd labels
  you list in `providers.ssh-mac.launchdLabels`.
- **`ssh-linux`:** OS and hostname; the Linux bundle's agent-bot; the
  agent-bot on `PATH`; `systemctl --user is-active` for
  `providers.ssh-linux.systemdUnits` (default `agent-bot-daemon`,
  `agent-comms-broker`).
- **Both:** whether the org profile is applied (`settings.unmanagedAuthors`
  and `settings.keydTeamId` present in `~/.config/agent-bot/config.json`;
  presence only, never values) and whether an SOP persona is recorded.

An unreachable host is reported, not fatal. Each host has one deadline
(`ssh.hostTimeoutSeconds`), and hosts are probed in parallel
(`ssh.concurrency`). "On PATH" means the `PATH` of a non-interactive SSH
session, which can be shorter than a login shell's.

## Safety contract

- Read-only. Probes may only read files and run `--version`,
  `launchctl list`, `readlink`, `defaults read` and
  `systemctl --user is-active`. Never `agent-bot doctor` or `bootstrap`,
  `keyd`, `managed-machine`, `brew`, or anything that installs, writes or
  prompts.
- Enforced by an allowlist (`src/allowlist.mjs`): every probe is an argv
  that must match one allowed shape before it reaches `ssh`, and every
  argument is quoted. Only `agent-bot` and `agent-comms` may be asked for
  `--version`. Paths a host reports back are checked the same way before use.
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
