# `agent-fleet status --json`

The JSON report is a stable contract. Every host has the same keys whatever
its provider, so a new provider (a cloud one, for example) adds hosts, not
fields. A breaking change bumps `schemaVersion`.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-11T12:00:00.000Z",
  "tool": { "name": "agent-fleet", "version": "0.1.0" },
  "train": {
    "minimum": { "agent-bot": "0.10.62", "geniusbar": "0.1.71" },
    "profileRequired": true,
    "personaRequired": false,
    "servicesRequired": true
  },
  "summary": { "hosts": 2, "ok": 1, "drift": 0, "partial": 0, "unreachable": 1 },
  "hosts": [
    {
      "name": "mac-1",
      "provider": "ssh-mac",
      "status": "ok",
      "reachable": true,
      "error": null,
      "system": { "os": "macOS", "osVersion": "15.6.1", "hostname": "mac-1.lan" },
      "components": [
        { "id": "geniusbar", "source": "app", "version": "0.1.71", "path": "/Applications/GeniusBar.app", "resolved": null },
        { "id": "agent-bot", "source": "geniusbar", "version": "0.10.62", "path": null, "resolved": null },
        { "id": "agent-bot", "source": "homebrew", "version": "0.10.64", "path": null, "resolved": null },
        { "id": "agent-bot", "source": "path", "version": "0.10.64", "path": "/Users/admin/.local/bin/agent-bot", "resolved": "/opt/homebrew/Cellar/agent-bot/0.10.64/bin/agent-bot" }
      ],
      "profile": { "configFound": true, "applied": true, "unmanagedAuthors": true, "keydTeamId": true },
      "persona": { "recorded": true },
      "services": [{ "id": "com.example.agent-bot.daemon", "state": "loaded" }],
      "drift": []
    },
    {
      "name": "vm-1",
      "provider": "ssh-linux",
      "status": "unreachable",
      "reachable": false,
      "error": "unreachable: ssh: connect to host [host] port 22: Connection refused",
      "system": { "os": null, "osVersion": null, "hostname": null },
      "components": [],
      "profile": null,
      "persona": null,
      "services": [],
      "drift": []
    }
  ]
}
```

## Fields

- **`status`:** `ok`, `drift` (one or more `drift` items), `partial` (the
  host ran out of time after it was reached, so the report is incomplete), or
  `unreachable`.
- **`error`:** why a host is unreachable or partial, else `null`.
- **`components[]`:** one entry per copy found. `id` is the component
  (`agent-bot`, `geniusbar`); `source` is where that copy lives (`app`,
  `geniusbar`, `homebrew`, `linux-bundle`, `path`). `version` is `null` when
  the copy is not installed. `path` and `resolved` are set for the `PATH`
  copy (and `path` for the app).
- **`profile`:** presence of `settings.unmanagedAuthors` and
  `settings.keydTeamId` in the host's agent-bot config. Never their values.
  `null` when the host was not reached.
- **`persona.recorded`:** whether `sop-persona.json` exists.
- **`services[]`:** each configured launchd label (`loaded`, `not-loaded`,
  `unknown`) or systemd user unit (`active`, `inactive`, `failed`, …,
  `unknown`).
- **`drift[]`:** items with a `kind`:
  - `behind`: `component`, `source`, `version`, `minimum`
  - `missing`: `component`, `minimum` (only where the provider expects it)
  - `profile`: `missing` (the absent keys)
  - `persona`
  - `service`: `service`, `state`

The SSH target from the config is never in the report: in ssh's own error
text, its user and host are replaced with `[user]` and `[host]`.
