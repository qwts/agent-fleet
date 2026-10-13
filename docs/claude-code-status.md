# The `claude-code-status` provider

Reads Claude Code cloud sessions back from the GitHub commit statuses a
session-side hook posts (one `agent-fleet/claude-code` status per
session branch) and reports each one as a record in the same shape as a
host ([ADR-0001 §6](decisions/ADR-0001-read-only-fleet-status.md),
trial: [ADR-0002](decisions/ADR-0002-claude-code-push-trial.md)). It
only sends `GET` requests: branch listing, then one combined-status
read per branch.

## Owner steps (once, on the control Mac)

1. **Create the token.** On GitHub, go to Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token.
   - Resource owner: the account or organization that owns the trial
     repository.
   - Repository access: only the trial repository.
   - Repository permissions: **Commit statuses: Read-only**. **Metadata:
     Read-only** is added automatically. Grant nothing else.
   - Choose an expiry, and generate. Copy the token; GitHub shows it once.
2. **Put it in the login Keychain.** In Terminal:

   ```sh
   security add-generic-password -U \
     -s agent-fleet.claude-code-status -a agent-fleet \
     -T /usr/bin/security -w
   ```

   With `-w` last, `security` asks for the token instead of taking it on the
   command line, so it is not in your shell history. Paste it and press
   Return. `-T /usr/bin/security` lets agent-fleet read the item without a
   Keychain dialog; `-U` updates an existing item.
3. **Add a host to the config:**

   ```json
   {
     "schemaVersion": 1,
     "providers": {
       "claude-code-status": { "repos": ["owner/repo"] }
     },
     "hosts": [
       { "name": "claude-code", "provider": "claude-code-status" }
     ]
   }
   ```

   Replace `owner/repo` with the trial repository. API hosts take no
   `target` or `port`. `--config PATH` takes precedence over
   `$AGENT_FLEET_CONFIG` and the XDG default
   (`${XDG_CONFIG_HOME:-~/.config}/agent-fleet/config.json`).

To rotate the token, generate a new one and repeat step 2. To remove it:
`security delete-generic-password -s agent-fleet.claude-code-status -a agent-fleet`.

## Options

`providers.claude-code-status` takes:

- `keychainService`, `keychainAccount`: the Keychain item (defaults
  `agent-fleet.claude-code-status` and `agent-fleet`).
- `repos`: `owner/repo` names to read. Empty (the default) polls nothing;
  the account record carries a `no repositories configured` note.
- `maxBranches`: the most branches to enumerate across all repos, default
  100 (1 to 1000). Once the cap is reached, later repos are not polled
  and the account record carries `truncated: true`.
- `idleAfterMinutes`: default 30 (1 to 1000000).
- `staleAfterHours`: default 24 (1 to 1000000).
- `apiBase`: default `https://api.github.com`; must be `https`.

The token can't go in the config: `token` is an unknown key, and so an error.

## The description contract

The hook posts `state=success` with context `agent-fleet/claude-code`
on the session branch HEAD, with the session in the description:

```text
v=1;s=<session id>;b=<branch>;st=<state>;n=<sequence>
```

- `s`: the session id, looking like `cse_...` (8 to 64 letters/digits).
- `b`: the session branch; must equal the enumerated branch name.
- `st`: one of `started`, `working`, `waiting`, `failed`, `ended`.
- `n`: a non-negative integer sequence number.
- The whole description is at most 140 chars.

Parsing is strict: exact keys in exact order, `v` exactly `1`, and every
rule above. Anything else is skipped silently and never echoed. A status
pointing at a different branch than the one it was read from is
skipped. Duplicates (one session id seen on several branches) keep the
status with the latest `created_at`.

## What it reports

One account record named after the host, then one record per session,
named `<host>/<session id>`, with `workload`:

- Account: `kind: claude-code-account`, `reportedSessions`,
  `truncated`, and a `note` when no repos are configured. A clean poll
  with no sessions leaves a null workload.
- Session: `kind: claude-code-session`, `sessionId`, `repo`, `branch`,
  `state`, `seq`, `url`, `updatedAt`.
- `reported: true` on every session: rows are unverified claims from
  the session, not observed facts.
- `state` is the reported state, overridden to `idle` past
  `idleAfterMinutes` or `stale` past `staleAfterHours`, with the raw
  value kept in `reportedState`. `ended` is never overridden, and an
  unreadable timestamp keeps the reported state.
- `url` is the hook's session URL only when it is an `https:` link on
  `claude.ai`; anything else reports `null`.

## Errors

Failures land on the account record's `error` and never stop the other hosts.
Messages are fixed per status, and no response body or token is ever echoed:

- 401: the token was rejected or has expired.
- 403: the token lacks Commit statuses or Metadata read access.
- 403 with `x-ratelimit-remaining: 0`, or 429: rate limited, with the reset
  time or `retry-after`. agent-fleet does not retry; run it again later.
- 404: the repository or branch is not visible to this token.
- 400, 422: the request was rejected.
- 5xx, network errors and timeouts: reported, try again later.
- A non-JSON response or an unexpected response shape: reported.
- No Keychain item: `token unavailable`, and no request is made.

## Coverage

Only repositories running the hook report sessions; every other Claude
Code session stays dark. The hook itself is not part of this change: it
lands in the trial repository via a separate PR (per-repo
`.claude/settings.json`), and no documented branch prefix exists, so the
provider enumerates branches. The empirical acceptance test is one
owner-run session appearing in `agent-fleet status` with the right
session, branch and state.

## Ending the trial

Remove the `claude-code-status` block from `providers` (and its host
from `hosts`), and remove the hook from the trial repository. With empty
`repos` the provider polls nothing; with no host it runs nothing.
