# Contributing

Bug reports, ideas and pull requests are welcome.

## Ground rules

- **Never** include a tenant ID, client secret, `config.json`, CSV exports, or real user / device names in issues, pull requests or screenshots. Use the demo tenant or redact.
- The tool is **read-only**. New lookups must only need `GET` calls; add their paths to the server's read allowlist (`$ReadAllow` in `server.ps1`) with tests.
- Keep it dependency-free: one PowerShell script, plain HTML/CSS/JavaScript, no build step.
- `server.ps1` must keep working on Windows PowerShell 5.1 (no `??`, ternaries or other PowerShell 7-only syntax).

## Development

```bash
# UI with the built-in demo tenant (no Microsoft tenant needed)
python3 -m http.server 8080        # open http://localhost:8080 → "Try the demo tenant"

npm test                           # lookup logic against the demo tenant
npm run test:server                # server.ps1 end to end (needs pwsh, or PWSH=powershell)
```

## Project layout

| Path | What it is |
|---|---|
| `server.ps1` | Local read-only backend: config, app-only token, Graph proxy, allowlist |
| `js/app.js` | Tools, input handling, CSV import |
| `js/lookups.js` | Device / user / group lookups and matching |
| `js/table.js` | Results table: filter, sort, copy, export, send-to |
| `js/graph.js` | Graph client: `$batch`, paging, retries |
| `js/mock.js` | Demo tenant, also used by the tests |
| `tests/` | Unit and end-to-end tests |
| `docs/` | Documentation and screenshots |

## Pull requests

1. Fork, branch, change.
2. Run `npm test` and `npm run test:server`.
3. Update the docs and `CHANGELOG.md` if behaviour changes.
4. Describe what you tested (demo tenant, test tenant, PowerShell version).
