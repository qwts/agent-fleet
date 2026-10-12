# AGENTS.md

Canonical, vendor-neutral agent context for this repository, per [ENG-0006](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0006-agentic-primitives-governance.md).

Read-only fleet status: versions, org profile, identity daemons, and drift from a release train. It changes nothing on any host. Public, MIT-licensed; host names, users, and addresses live only in the operator's config file, never in this repository.

<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/qwts-agent-sop/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the reviewed
[shared agent skills](https://github.com/qwts/qwts-agent-sop/blob/main/skills/README.md)
index. This repository is governed by
[qwts-agent-sop](https://github.com/qwts/qwts-agent-sop) — its
[shared SOPs](https://github.com/qwts/qwts-agent-sop/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/qwts-agent-sop/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->

## What is specific to this repository

- **Safety contract (mandatory — extend, don't drop):** probes may only read
  files and run `--version`, `launchctl list`, `readlink`, `defaults read`
  and `systemctl --user is-active`. Never `agent-bot doctor` or `bootstrap`,
  `keyd`, `managed-machine`, `brew`, or anything that installs, writes or
  prompts. Enforced by the allowlist in `src/allowlist.mjs`, which has its
  own tests. Full contract: [README.md](README.md#safety-contract) and
  [ADR-0001](docs/decisions/ADR-0001-read-only-fleet-status.md).
- **No site data in code:** hosts, the release train, and provider overrides
  live in the operator config (`$AGENT_FLEET_CONFIG`, else
  `~/.config/agent-fleet/config.json`, else `--config PATH`). Unknown config
  keys are errors. Tokens never appear in config, output, or errors; cloud
  providers read them from the control Mac's login Keychain at run time.
- **Provider shape:** every provider returns the same report shape, so adding
  one changes neither the config format nor the output format. Registry:
  `src/providers/index.mjs`. Cloud providers send only `GET` requests.
- **Language and CI:** Node 20+, ESM, no dependencies, `npm test`
  (`node --test test/*.test.mjs`). Tests use a scratch `HOME` and stubbed
  runners; no test opens a real connection or touches a real Keychain.
