# agent-fleet

Read-only status of an agent-runtime fleet — Macs and Linux VMs — pulled over
SSH from one control machine: versions, org profile, identity daemons, and
drift from a release train. It changes nothing on any host.

## Usage

```sh
mkdir -p ~/.config/agent-fleet
cp examples/config.example.json ~/.config/agent-fleet/config.json   # then list your hosts
node bin/agent-fleet.mjs status
node bin/agent-fleet.mjs status --json
```

Text output, one block per host:

```text
mac-1 (ssh-mac)  [DRIFT]  macOS 15.6.1  hostname mac-1.lan
  geniusbar  app          0.1.71
  agent-bot  geniusbar    0.10.61
  agent-bot  homebrew     0.10.64
  agent-bot  path         0.10.64  -> /opt/homebrew/Cellar/agent-bot/0.10.64/bin/agent-bot
  profile    applied
  persona    recorded
  service    com.example.agent-bot.daemon loaded
  DRIFT      agent-bot geniusbar 0.10.61 < 0.10.62

vm-1 (ssh-linux)  UNREACHABLE  unreachable: ssh: connect to host [host] port 22: Connection refused

2 hosts: 1 drift, 1 unreachable
```

`--json` prints the same report as a stable, provider-neutral document; see
[docs/json-output.md](docs/json-output.md). `status` exits 0 whenever it could
produce a report, drift or not, and 2 for usage or config errors.

## Discover

```sh
node bin/agent-fleet.mjs discover [--json] [--seconds 3]
```

Browses Bonjour `_ssh._tcp` adverts on the local network for a few seconds
(`dns-sd` on macOS, `avahi-browse` on Linux) and lists the names it saw,
marking those already in your config. It only suggests: it never edits the
config and never connects to a host.

## Config

```json
{
  "schemaVersion": 1,
  "ssh": { "connectTimeoutSeconds": 5, "hostTimeoutSeconds": 30, "concurrency": 8 },
  "train": { "minimum": { "agent-bot": "0.10.62", "geniusbar": "0.1.71" }, "profileRequired": true },
  "providers": {
    "ssh-mac": { "launchdLabels": ["com.example.agent-bot.daemon"] },
    "ssh-linux": { "systemdUnits": ["agent-bot-daemon", "agent-comms-broker"] }
  },
  "hosts": [
    { "name": "mac-1", "provider": "ssh-mac", "target": "admin@mac-1.example" },
    { "name": "vm-1", "provider": "ssh-linux", "target": "ubuntu@vm-1.example", "port": 22 }
  ]
}
```

Unknown keys are errors. `ssh-mac` also takes `geniusBarApp` and
`homebrewPrefixes`; `ssh-linux` takes `bundlePrefix`. SSH keys, users and
jump hosts come from your own `~/.ssh/config`; agent-fleet never handles a
password or a key.

The config file is `$AGENT_FLEET_CONFIG`, else
`${XDG_CONFIG_HOME:-~/.config}/agent-fleet/config.json`, or `--config PATH`.
Host names live only there; this repository ships none.

## What it reports

Each host has a provider, and every provider reports the same shape:

- **`ssh-mac`:** macOS version and hostname; GeniusBar's version and its
  bundled agent-bot (read from the app bundle); Homebrew's agent-bot (from the
  `opt` link); the agent-bot on `PATH` and where it resolves; launchd labels
  you list in `providers.ssh-mac.launchdLabels`.
- **`ssh-linux`:** OS and hostname; the Linux bundle's agent-bot; the
  agent-bot on `PATH`; `systemctl --user is-active` for
  `providers.ssh-linux.systemdUnits` (default `agent-bot-daemon`,
  `agent-comms-broker`).
- **`github-copilot`:** GitHub Copilot cloud agent tasks from the agent
  tasks REST API, one record per task with its state, repository, branch and
  pull request in `workload`. It reads a read-only token from the macOS
  Keychain; see [docs/github-copilot.md](docs/github-copilot.md).
- **`cursor`:** Cursor cloud agents from the Cloud Agents REST API, one
  record per agent with its state, repository, starting ref and timestamps
  in `workload`. It reads a read-only API key from the macOS Keychain;
  see [docs/cursor.md](docs/cursor.md).
- **`devin`:** Devin sessions from the organizations sessions API, one
  record per session with its state, status detail, first pull request URL
  and timestamps in `workload`. It reads a read-only API key from the
  macOS Keychain; see [docs/devin.md](docs/devin.md).
- **SSH providers:** whether the org profile is applied (`settings.unmanagedAuthors`
  and `settings.keydTeamId` present in `~/.config/agent-bot/config.json`;
  presence only, never values) and whether an SOP persona is recorded.

An unreachable host is reported, not fatal. Each host has one deadline
(`ssh.hostTimeoutSeconds`), and hosts are probed in parallel
(`ssh.concurrency`). "On PATH" means the `PATH` of a non-interactive SSH
session, which can be shorter than a login shell's.

## Drift and the release train

`train` in the config is the release the fleet should be on:

```json
"train": {
  "minimum": { "agent-bot": "0.10.62", "geniusbar": "0.1.71" },
  "profileRequired": true,
  "personaRequired": false,
  "servicesRequired": true
}
```

A host drifts when any copy of a component it reports (agent-bot from
GeniusBar, Homebrew, the Linux bundle or `PATH`) is below its minimum, when a
component its provider expects is missing (GeniusBar on Macs only), or when a
required profile, persona or service is not in place. Each host gets a status:
`ok`, `drift`, `partial` (it ran out of time), or `unreachable`.

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
- The `github-copilot` provider sends only `GET` requests, and its token
  never appears in config, output or errors.
- SSH is non-interactive: `BatchMode=yes`, a connect timeout, no TTY, no
  stdin, and `StrictHostKeyChecking=accept-new` for first use only.

See [ADR-0001](docs/decisions/ADR-0001-read-only-fleet-status.md) for the
decisions behind this, and for the roadmap to cloud hosts with no SSH
(GitHub Copilot cloud agent first).

## Development

Node 20 or later, no dependencies.

```sh
npm test
```

## License

MIT
