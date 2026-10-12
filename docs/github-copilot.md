# The `github-copilot` provider

Lists GitHub Copilot cloud agent tasks through the
[agent tasks REST API](https://docs.github.com/en/rest/agent-tasks/agent-tasks)
(public preview) and reports each one as a record in the same shape as a host
([ADR-0001 §6](decisions/ADR-0001-read-only-fleet-status.md)). It only sends
`GET` requests.

## Owner steps (once, on the control Mac)

1. **Create the token.** On GitHub, go to Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token.
   - Resource owner: the account or organization whose agent tasks you want.
   - Repository access: all repositories, or the ones Copilot works in.
   - Repository permissions: **Agent tasks: Read-only**. **Metadata:
     Read-only** is added automatically. Grant nothing else.
   - Choose an expiry, and generate. Copy the token; GitHub shows it once.
2. **Put it in the login Keychain.** In Terminal:

   ```sh
   security add-generic-password -U \
     -s agent-fleet.github-copilot -a agent-fleet \
     -T /usr/bin/security -w
   ```

   With `-w` last, `security` asks for the token instead of taking it on the
   command line, so it is not in your shell history. Paste it and press
   Return. `-T /usr/bin/security` lets agent-fleet read the item without a
   Keychain dialog; `-U` updates an existing item.
3. **Add a host to the config:**

   ```json
   {
     "providers": {
       "github-copilot": { "repos": [] }
     },
     "hosts": [
       { "name": "copilot", "provider": "github-copilot" }
     ]
   }
   ```

To rotate the token, generate a new one and repeat step 2. To remove it:
`security delete-generic-password -s agent-fleet.github-copilot -a agent-fleet`.

## Options

`providers.github-copilot` takes:

- `keychainService`, `keychainAccount`: the Keychain item (defaults
  `agent-fleet.github-copilot` and `agent-fleet`).
- `repos`: `owner/repo` names to list. Empty (the default) lists every task
  the token's owner can see, via `GET /agents/tasks`.
- `maxTasks`: the most tasks to list, default 100.
- `apiBase`: default `https://api.github.com`; must be `https`.

The token can't go in the config: `token` is an unknown key, and so an error.

## What it reports

One account record named after the host, then one record per task, named
`<host>/<task id>`, with `workload`:

- `state`: `queued`, `in_progress`, `completed`, `failed`, `idle`,
  `waiting_for_user`, `timed_out` or `cancelled`. Any other value is reported
  as `unknown`.
- `repo`: `owner/name` (looked up from the repository id, needs Metadata),
  else `id:<n>`.
- `branch`, `baseBranch`: from the task's branch artifact.
- `pullRequestId`: the id in the task's pull artifact.
- `title`, `url`, `createdAt`, `updatedAt`.
- `runtime`: always `null`. The API does not document one; the runner comes
  from the repository's `copilot-setup-steps.yml`.

## Errors

Failures land on the account record's `error` and never stop the other hosts.
Messages are fixed per status, and no response body or token is ever echoed:

- 401: the token was rejected or has expired.
- 403: the token lacks Agent tasks or Metadata read access.
- 403 with `x-ratelimit-remaining: 0`, or 429: rate limited, with the reset
  time or `retry-after`. agent-fleet does not retry; run it again later.
- 404: the preview API or the repository is not visible to this token.
- 5xx, network errors and timeouts: reported, try again later.
- No Keychain item: `token unavailable`, and no request is made.
