# Security model

The tool holds a credential that can read every device, user and group in the tenant. This page explains how it is contained.

## Architecture

```
┌──────────────┐  same origin, X-IAD-Session  ┌───────────────────────────┐  Bearer (app-only)  ┌─────────────────┐
│  Browser UI  │ ───────────────────────────► │ server.ps1 (127.0.0.1)    │ ──────────────────► │ Microsoft Graph │
│  index.html  │ ◄─────────────────────────── │ · config.json             │ ◄────────────────── │  v1.0, GET only │
│  js/*.js     │                              │ · token cache (memory)    │                     └─────────────────┘
└──────────────┘                              │ · read-only allowlist     │  client credentials ┌─────────────────┐
                                              └───────────────────────────┘ ──────────────────► │ Entra ID token  │
                                                                                                └─────────────────┘
```

- `server.ps1` reads `config.json`, requests an app-only token (`client_credentials`, scope `https://graph.microsoft.com/.default`), keeps it in memory and refreshes it before it expires.
- The browser never receives the client secret or the Graph token. It calls `/graph/v1.0/...` on the local server, which checks and forwards each request.
- The UI is plain HTML, CSS and JavaScript with no third-party code, served with a strict Content Security Policy.

## Controls enforced by the server

| Control | Detail |
|---|---|
| Read-only | Only `GET`, and `POST /$batch` whose sub-requests are all `GET`, are forwarded. Every other verb is refused (`405 ReadOnly`), whatever the config says. |
| Read allowlist | `GET` only on `/devices`, `/users`, `/groups`, `/organization` and `/deviceManagement/managedDevices` (and their children). Mail, files, sites, apps, policies, applications… are refused. |
| Loopback only | `ListenPrefix` must be `127.0.0.1`, `localhost` or `::1`; anything else stops the server at startup. |
| Host check | Requests with an unexpected `Host` header are rejected (DNS-rebinding protection). |
| Origin check | Requests with a foreign `Origin` are rejected. `AllowedOrigin: "*"` is ignored; only an exact origin can be allowed. |
| Session token | A random 256-bit token per start; every `/graph/*` call must send it in `X-IAD-Session`. Other websites can't read it (same-origin policy, no CORS). |
| Static files | Only `index.html`, `css/*.css`, `js/*.js` and `docs/*.png|svg` are served — never `config.json`, scripts or tests. Paths are resolved and checked against the tool folder. |
| Headers | `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. |

These are covered by the end-to-end tests in `tests/server.test.js`, which run on Windows PowerShell 5.1 and PowerShell 7 in CI.

## Data handling

- Results stay in the browser tab's memory. Nothing is written to disk unless you click *Export CSV*.
- The only browser storage used is your column choice per tool (`localStorage`).
- Exported CSVs neutralise spreadsheet formulas. `*.csv` is git-ignored so exports aren't committed by accident.

## Your responsibilities

- **Protect `config.json`**: admin workstation, restricted ACL, never commit or share it. Prefer `IAD_CLIENT_SECRET` over a secret on disk.
- **Short secret lifetime**, rotate immediately if it may have leaked.
- **Least privilege**: grant only the read permissions in [REQUIREMENTS.md](REQUIREMENTS.md). Don't reuse an app registration that also has write permissions if you can avoid it.
- **Treat exports as personal data**: they contain names, emails and device identifiers.
- **Stop the server** when you're done.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
