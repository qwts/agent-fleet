# ADR-0001: Read-only fleet status, pulled over SSH, behind host providers

**Status:** Accepted (owner decisions relayed in chat, 2026-10-11). §6, the
no-SSH cloud model and the Copilot token, was accepted the same day.
**Date:** 2026-10-11

## Context

An agent-runtime fleet (agent-bot, GeniusBar, the identity daemons, the org
profile) runs on several Macs, on cloud VMs, and in vendor-hosted agent
sessions. The owner has no single view of what version each machine runs,
whether the org profile is applied, or which machines have drifted from the
current release. The cloud side is the largest blind spot.

## Decisions

### 1. Pull over SSH from a control Mac

`agent-fleet` runs on one control Mac and pulls status from each host with
the system `ssh`. Nothing is installed on the hosts and no host pushes
anything. SSH always runs with `BatchMode=yes`, a `ConnectTimeout`, no TTY and
no stdin, so it can never ask for a password or wait for input.
`StrictHostKeyChecking=accept-new` trusts a host key on first use only; a
changed key still fails.

### 2. v1 is read-only status, and changes nothing on any machine

Probes may only read files and run `--version`, `launchctl list`, `readlink`,
`defaults read` and `systemctl --user is-active`. They never run
`agent-bot doctor` or `bootstrap`, `keyd`, `managed-machine`, `brew`, or
anything else that installs, writes or prompts. This is enforced in code by an
allowlist of probe commands that every command passes before it reaches
`ssh`, and the allowlist has its own tests. Probes run in parallel with a
timeout per host. An unreachable host is reported, not fatal.

### 3. Public repository: no site data in code

The repository ships no host names, users, addresses or other site-specific
data. Hosts, the release train and any provider overrides live in a user
config file (`~/.config/agent-fleet/config.json` by default). Bonjour
discovery of `_ssh._tcp` may suggest hosts, but never adds them.

### 4. Hosts have providers, and the format is provider-neutral

Each configured host names a provider. v1 builds two:

- **`ssh-mac`:** macOS, GeniusBar's bundle, Homebrew's agent-bot, launchd.
- **`ssh-linux`:** cloud VMs and the headless Linux agent-bot bundle,
  including `systemctl --user is-active agent-bot-daemon agent-comms-broker`.

Both use the same SSH runner, allowlist and safety rules. A provider returns
the same report shape: system, components with versions, profile, persona and
services. Drift is computed on that shape. Adding a provider adds a module and
a name, and changes neither the config format nor the output format.

### 5. Language and CI

Node ESM with no dependencies, tested with `node --test`, matching the agent
runtime. CI runs on GitHub-hosted `ubuntu-latest` and `macos-latest` only,
with actions pinned by commit. Tests use a scratch `HOME` and a stubbed SSH
runner; no test opens a real connection.

## 6. Cloud: hosts with no SSH

### What can be observed today

Official vendor documentation only; anything else is marked unknown.

- **GitHub Copilot cloud agent.** REST `GET /agents/tasks` and
  `GET /agents/repos/{owner}/{repo}/tasks[/{task_id}]` (public preview) list
  tasks with `state`, `repository.id`, branch and pull request artifacts and
  timestamps; sessions add `head_ref`, `base_ref` and `model`. They take user
  tokens or fine-grained PATs with the "Agent tasks" read permission;
  **GitHub App installation tokens are not supported**
  ([docs](https://docs.github.com/en/rest/agent-tasks/agent-tasks)).
  `gh agent-task list|view` exists in preview; whether it has `--json` is
  unknown ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-from-cli)).
  agent-bot could run inside: `copilot-setup-steps.yml` runs any steps, and
  repo hooks fire on session start and end
  ([environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment),
  [hooks](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/use-hooks)),
  behind a default-on egress firewall with custom allowlists
  ([firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall)).
  Unknown: a runtime or image field, and how a session maps to its Actions run.
- **Cursor cloud agents.** REST `GET /v1/agents` and
  `GET /v1/agents/{id}/runs` give status, repos, starting ref, branches and PR
  URLs ([docs](https://cursor.com/docs/cloud-agent/api/endpoints)).
  `.cursor/environment.json` runs install and start commands
  ([docs](https://cursor.com/docs/cloud-agent/setup)); egress can be
  allowlisted ([docs](https://cursor.com/docs/cloud-agent/security-network)).
  Unknown: whether hooks or MCP run there.
- **OpenAI Codex cloud.** `codex cloud list --json` gives id, status,
  environment and title
  ([docs](https://learn.chatgpt.com/docs/developer-commands?surface=cli));
  setup scripts run in the environment, and agent-phase internet is off by
  default with a domain allowlist
  ([docs](https://learn.chatgpt.com/docs/cloud/internet-access)). Unknown: a
  REST list API, and branch fields.
- **Claude Code cloud sessions.** No documented list API; sessions show at
  claude.ai/code and in `claude --teleport`. Setup scripts, repo hooks and
  MCP run in the session, with network levels up to a custom allowlist
  ([docs](https://code.claude.com/docs/en/cloud-environments)). Unknown: any
  status, repo or branch listing API.
- **Devin.** `GET /v1/sessions` and session details give status, pull request
  URL and timestamps
  ([docs](https://docs.devin.ai/api-reference/v1/sessions/retrieve-details-about-an-existing-session));
  blueprints install tools into the snapshot
  ([docs](https://docs.devin.ai/onboard-devin/environment/blueprints)).
  Unknown: repo and branch fields.
- **Grok Bot, OpenAI dots, Meta Muse (vendor-hosted VMs).** No API or CLI is
  documented; status is in each app's UI
  ([Grok Bot](https://docs.x.ai/grok-bot/computer-and-apps),
  [dots](https://learn.chatgpt.com/docs/dots),
  [Muse](https://www.meta.com/help/artificial-intelligence/1047255454427887/)).
  Unknown: whether user tooling can be installed and persist, egress
  controls, and any API.
- **Containers.** Not researched for v1; a later provider.

### The no-SSH model

The options the owner chose from:

1. **Vendor-API pollers per provider (recommended to start).** The control Mac
   reads each vendor's list API with a read-only token and maps sessions into
   the same report shape. It stays read-only and installs nothing in sessions.
   It sees only what each vendor exposes, and Grok Bot, dots and Muse stay dark.
2. **In-session push to a store the owner controls.** agent-bot, installed by
   each environment's setup step or hook, writes a status record to a store
   the owner owns. It sees agent-bot's own state from inside, but it needs
   egress allowlists, a write credential in every session, and setup in every
   repository, and it only covers vendors that run user tooling.
3. **Both, phased (recommended end state).** Pollers first, which give a
   baseline listing; push later, as an opt-in where agent-bot already runs
   inside, joined to the listing by repository and branch.
4. **Do nothing for cloud yet.** The vendor UIs stay the only view.

**Decision (owner, 2026-10-11):** option 3, both, phased. Pollers come first,
starting with the GitHub Copilot cloud agent; in-session push comes later.

### The Copilot token

**Decision (owner, 2026-10-11):** a fine-grained personal access token that
the owner creates, with only read-only "Agent tasks" and "Metadata"
permissions. It lives in the control Mac's login Keychain and is read at run
time with `/usr/bin/security`. It is never in the config, never in the
environment, and never logged, printed or stored by agent-fleet. GitHub App
installation tokens, such as the agent bots', are not accepted by the agent
tasks API. A user-token device flow and reusing the `gh` login were the other
options; the first needs a new App, and the second has undocumented scopes for
this API. The owner steps are in [docs/github-copilot.md](../github-copilot.md).

The provider sends only `GET` requests. Each task becomes one record in the
same report shape as a host, with its details in `workload`. The API is a
public preview: its errors and rate limits are reported on the account record,
never fatal.

### Roadmap

1. **v1:** `ssh-mac`, `ssh-linux` (this record).
2. **GitHub Copilot cloud agent:** `github-copilot`, a poller over the agent
   tasks REST API (built).
3. **Cursor cloud agents and Devin (built):** pollers over their documented REST APIs.
4. **Codex cloud (next):** poller over `codex cloud list --json`.
5. **Claude Code cloud sessions:** push only, until a list API is documented.
6. **Grok Bot, dots, Muse:** UI only until an API is documented; revisit push
   if user tooling can be installed.
7. **Containers.**

## Consequences

- The owner gets a fleet view without giving any tool write access to any
  machine.
- Probes that would need anything outside the allowlist, including
  `agent-bot doctor`, are out of scope until a later record allows them.
- A non-interactive SSH session sees a short `PATH`; "agent-bot on PATH"
  reports that `PATH`, which can differ from a login shell's.
