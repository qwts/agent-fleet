# ADR-0002: Claude Code push trial (commit statuses)

**Status:** Trial in progress (owner decision, 2026-10-13).
**Date:** 2026-10-13

## Context

[ADR-0001](ADR-0001-read-only-fleet-status.md) §1 says no host pushes
anything, and §6 defers Claude Code cloud sessions ("push only, until a
list API is documented") because Claude documents no list API: sessions
show at claude.ai/code and in `claude --teleport`, while setup scripts,
repo hooks and MCP run in the session
([docs](https://code.claude.com/docs/en/cloud-environments)). The owner
chose a push design for this gap and picked option C for the first
step: a trial in which Claude Code cloud sessions report themselves by
pushing GitHub commit statuses, which agent-fleet then reads back. This
record amends ADR-0001 §1/§6 for the trial scope only: nothing else may
push, and the poller side still only reads. Earlier records are not
rewritten; this one supersedes them where they conflict, and is itself
superseded if the trial ends or promotes.

## Decisions

### 1. A command hook posts the status, never an HTTP hook

The session-side hook is a command hook only. An HTTP hook would post
the full input, including prompts, to a URL; a command hook posts only
what the command sends: `state=success` with context
`agent-fleet/claude-code` and a description in the
`v=1;s=;b=;st=;n=` encoding (§3), on the session branch HEAD, via the
GitHub proxy already available in the session. No new secret is placed
in the session.

### 2. agent-fleet reads GET-only with a read-only PAT from the Keychain

The `claude-code-status` provider sends only `GET` requests (branch
listing, then one combined-status read per branch) with a fine-grained
personal access token holding only read-only "Commit statuses" plus the
automatic "Metadata". The token lives in the control Mac's login
Keychain and is read at run time with `/usr/bin/security`; it is never
in the config, never in the environment, and never logged, printed or
stored by agent-fleet. Owner steps are in
[docs/claude-code-status.md](../claude-code-status.md).

### 3. Rows are unverified claims, capped, parsed and sanitized

Each status row is a self-report from a session, so every row is treated
as an unverified claim: records carry `workload.reported: true`, and an
idle/stale override keeps the raw value in `workload.reportedState`.
Descriptions are strict-parsed (exact keys in exact order, `v` exactly
`1`, a known state, an integer sequence, 140 chars at most); anything
else is skipped silently and never echoed. Branch enumeration is capped
by `maxBranches`, and the account record says `truncated: true` instead
of silently dropping branches. Untrusted fields are sanitized, and only
`https:` `claude.ai` session URLs survive. Rows never trigger actions:
an unreachable API or a bad row is reported on the account record, never
fatal to the other hosts.

### 4. Freshness: idle after 30 minutes, stale after 24 hours

A session whose newest status is older than `idleAfterMinutes` (default
30) reports `idle`; older than `staleAfterHours` (default 24) reports
`stale`. `ended` is never overridden. An unreadable timestamp keeps the
reported state.

### 5. Trial scope: one private repo, named nowhere but the operator config

The trial covers one private repository. Its name appears only in the
operator's config file; it is never in code, tests, docs or this
record. Only repositories running the hook report anything; a clean
poll leaves a null workload, and empty `repos` polls nothing.

### 6. Unknowns going in

- VM-level hook installation is unverified; the trial path is per-repo
  `.claude/settings.json`.
- No documented branch prefix for Claude Code sessions, so the provider
  enumerates branches instead of matching names.
- The empirical acceptance test is one owner-run session: its status
  must appear in `agent-fleet status` with the right session, branch
  and state.

### 7. Exit criteria

If the trial proves useful, option A — a Cloudflare Worker receiver —
is next. If it does not, the trial ends: remove the provider block from
the config and the hook from the trial repo (see
[docs/claude-code-status.md](../claude-code-status.md)), leaving the
poller harmless with empty `repos`.

## Consequences

- For the trial scope, fleet status is no longer pull-only: the
  session-side hook writes one commit status per event, while
  agent-fleet itself still only reads.
- The fleet view covers only sessions in repos running the hook; every
  other Claude Code session stays dark until a list API is documented.
- The hook itself lands in the trial repo via a separate PR, outside
  this change.
