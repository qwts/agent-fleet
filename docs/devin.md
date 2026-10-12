# The `devin` provider

Lists Devin sessions through the
[organizations sessions API](https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions)
(`GET /v3/organizations/{orgId}/sessions`) and reports each one as a record
in the same shape as a host
([ADR-0001 §6](decisions/ADR-0001-read-only-fleet-status.md)). It only sends
`GET` requests. See
[authentication](https://docs.devin.ai/api-reference/authentication) for how
the API key works.

## Owner steps (once, on the control Mac)

1. **Create the API key.** Create a service-user API key with **only** the
   `ViewOrgSessions` permission. Grant no other permissions. Copy the key;
   it is shown once.
2. **Put it in the login Keychain.** In Terminal:

   ```sh
   security add-generic-password -U \
     -s agent-fleet.devin -a agent-fleet \
     -T /usr/bin/security -w
   ```

   With `-w` last, `security` asks for the key instead of taking it on the
   command line, so it is not in your shell history. Paste it and press
   Return. `-T /usr/bin/security` lets agent-fleet read the item without a
   Keychain dialog; `-U` updates an existing item.
3. **Add a host to the config:**

   ```json
   {
     "schemaVersion": 1,
     "providers": {
       "devin": { "orgId": "org-..." }
     },
     "hosts": [
       { "name": "devin", "provider": "devin" }
     ]
   }
   ```

   Put your real org id in your own config only; it never goes in this
   repository. API hosts take no `target` or `port`. `--config PATH` takes
   precedence over `$AGENT_FLEET_CONFIG` and the XDG default
   (`${XDG_CONFIG_HOME:-~/.config}/agent-fleet/config.json`).

To rotate the key, create a new one and repeat step 2. To remove it:
`security delete-generic-password -s agent-fleet.devin -a agent-fleet`.

## Options

`providers.devin` takes:

- `orgId` (required): the organization id, which looks like `org-...`. It
  becomes part of the request path
  (`/v3/organizations/{orgId}/sessions`).
- `keychainService`, `keychainAccount`: the Keychain item (defaults
  `agent-fleet.devin` and `agent-fleet`).
- `maxAgents`: the most Devin sessions to list, default 100 (1 to 1000).
- `apiBase`: default `https://api.devin.ai`; must be `https`.

The key can't go in the config: `token` is an unknown key, and so an error.

## What it reports

One account record named after the host, then one record per session, named
`<host>/<session id>`, with `workload`:

- `state`: `new`, `claimed`, `running`, `exit`, `error`, `suspended` or
  `resuming`. Any other value is reported as `unknown`.
- `statusDetail`: the session's `status_detail`, else `null`.
- `pullRequestUrl`: the first pull request URL (`pull_requests[].pr_url`),
  else `null`. `pullRequestCount` is the number of pull requests.
- `repo`, `branch`: always `null`. The API exposes neither.
- `title`, `url`, `createdAt`, `updatedAt`. The timestamps arrive as unix
  seconds (`created_at`, `updated_at`) and are reported as ISO strings;
  out-of-range or non-integer values become `null`.
- `runtime`: always `null`. The API does not document one.

Sessions are listed oldest first with `end_cursor`/`has_next_page`
pagination. If the `maxAgents` cap is reached while another page remains,
the account record carries `workload.truncated: true` instead of silently
dropping sessions.

## Errors

Failures land on the account record's `error` and never stop the other hosts.
Messages are fixed per status, and no response body or key is ever echoed:

- 401: the key was rejected or has expired.
- 403: the key cannot list sessions.
- 403 with a `retry-after` header, or 429: rate limited, with the retry
  delay or reset time. agent-fleet does not retry; run it again later.
- 404: the organization or API path is not visible; it may have changed.
- 409: the request conflicts with the session state.
- 400, 422: the request was rejected.
- 5xx, network errors and timeouts: reported, try again later.
- A non-JSON response or an unexpected response shape: reported.
- No Keychain item: `token unavailable`, and no request is made.
