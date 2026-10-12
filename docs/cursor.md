# The `cursor` provider

Lists Cursor cloud agents through the
[Cloud Agents REST API](https://cursor.com/docs/cloud-agent/api/endpoints)
and reports each one as a record in the same shape as a host
([ADR-0001 §6](decisions/ADR-0001-read-only-fleet-status.md)). It only sends
`GET` requests.

## Owner steps (once, on the control Mac)

1. **Create the API key.** Following the
   [official API docs](https://cursor.com/docs/cloud-agent/api/endpoints),
   create an API key with read-only agent visibility. Grant nothing else.
   Copy the key; it is shown once.
2. **Put it in the login Keychain.** In Terminal:

   ```sh
   security add-generic-password -U \
     -s agent-fleet.cursor -a agent-fleet \
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
       "cursor": {}
     },
     "hosts": [
       { "name": "cursor", "provider": "cursor" }
     ]
   }
   ```

   API hosts take no `target` or `port`. `--config PATH` takes precedence
   over `$AGENT_FLEET_CONFIG` and the XDG default
   (`${XDG_CONFIG_HOME:-~/.config}/agent-fleet/config.json`).

To rotate the key, create a new one and repeat step 2. To remove it:
`security delete-generic-password -s agent-fleet.cursor -a agent-fleet`.

## Options

`providers.cursor` takes:

- `keychainService`, `keychainAccount`: the Keychain item (defaults
  `agent-fleet.cursor` and `agent-fleet`).
- `maxAgents`: the most agents to list, default 100 (1 to 1000).
- `apiBase`: default `https://api.cursor.com`; must be `https`.

The key can't go in the config: `token` is an unknown key, and so an error.

## What it reports

One account record named after the host, then one record per agent, named
`<host>/<agent id>`, with `workload`:

- `state`: `ACTIVE`, `IDLE` or `ARCHIVED`. Any other value is reported
  as `unknown`.
- `repo`: the first repository URL (`repos[].url`), else `null`.
- `branch`: that repository's starting ref (`repos[].startingRef`),
  else `null`.
- `title`, `url`, `createdAt`, `updatedAt`.
- `runtime`: always `null`. The API does not document one.

Agents are listed newest first with cursor-following pagination. If the
`maxAgents` cap is reached while another page remains, the account record
carries `workload.truncated: true` instead of silently dropping agents.

## Errors

Failures land on the account record's `error` and never stop the other hosts.
Messages are fixed per status, and no response body or key is ever echoed:

- 401: the key was rejected or has expired.
- 403: the key cannot list agents.
- 403 with a `retry-after` header, or 429: rate limited, with the retry
  delay or reset time. agent-fleet does not retry; run it again later.
- 404: the API path is not visible; it may have changed.
- 400, 422: the request was rejected.
- 5xx, network errors and timeouts: reported, try again later.
- A non-JSON response or an unexpected response shape: reported.
- No Keychain item: `token unavailable`, and no request is made.
