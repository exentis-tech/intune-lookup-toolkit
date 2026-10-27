# Setup

1. [Register the app in Entra ID](#1-register-the-app-in-entra-id)
2. [Download the tool](#2-download-the-tool)
3. [Create config.json](#3-create-configjson)
4. [Start the server](#4-start-the-server)
5. [Troubleshooting](#troubleshooting)

Prerequisites: [REQUIREMENTS.md](REQUIREMENTS.md).

## 1. Register the app in Entra ID

If you already have an app registration your lookup scripts used, you can reuse it — just check its permissions in step 5.

1. **Microsoft Entra admin center** → **Identity** → **Applications** → **App registrations** → **New registration**.
2. **Name:** `Intune Lookup Toolkit` · **Supported account types:** *Accounts in this organizational directory only*. Leave **Redirect URI** empty. **Register**.
3. From **Overview** copy **Application (client) ID** → `ApplicationId` and **Directory (tenant) ID** → `TenantId`.
4. **Certificates & secrets** → **New client secret**, short lifetime (e.g. 90 days). Copy the **Value** (not the Secret ID) → `ClientSecret`.
5. **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**:
   - `DeviceManagementManagedDevices.Read.All`
   - `Device.Read.All`
   - `User.Read.All`
   - `GroupMember.Read.All`
   - `Organization.Read.All` (optional)
6. **Grant admin consent for <tenant>**. Every permission must show *Granted*.

## 2. Download the tool

```powershell
git clone https://github.com/exentis-tech/intune-lookup-toolkit.git C:\Tools\intune-lookup-toolkit
```

Or download the ZIP from GitHub and extract it, then unblock the files:

```powershell
Get-ChildItem C:\Tools\intune-lookup-toolkit -Recurse | Unblock-File
```

## 3. Create config.json

```powershell
cd C:\Tools\intune-lookup-toolkit
Copy-Item config.example.json config.json
notepad config.json
```

```json
{
  "TenantId": "contoso.onmicrosoft.com",
  "ApplicationId": "00000000-0000-0000-0000-000000000000",
  "ClientSecret": "paste-the-secret-value",
  "GraphBaseUrl": "https://graph.microsoft.com/v1.0",
  "GraphBetaBaseUrl": "https://graph.microsoft.com/beta",
  "ListenPrefix": "http://127.0.0.1:8089/",
  "AllowedOrigin": "",
  "RequestTimeoutSeconds": 60,
  "ProxyUrl": "",
  "UseDefaultProxyCredentials": false
}
```

The format is the same as [Intune App Decommission](https://github.com/exentis-tech/intune-app-decommission), so one file can serve both tools; extra keys such as `EnableRealDelete` are ignored here.

Protect the file:

```powershell
icacls config.json /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
```

**Keep the secret out of the file (optional):** remove `ClientSecret` and set it per session:

```powershell
$env:IAD_CLIENT_SECRET = Read-Host 'Client secret' -MaskInput   # PowerShell 7
.\server.ps1
```

## 4. Start the server

Double-click **`Start-Lookup.cmd`**, or:

```powershell
pwsh ./server.ps1                                      # PowerShell 7
powershell -ExecutionPolicy Bypass -File .\server.ps1   # Windows PowerShell 5.1
pwsh ./server.ps1 -ConfigPath D:\secure\tenant-b.json   # another tenant
pwsh ./server.ps1 -NoBrowser                            # don't open the browser
```

The browser opens on `http://127.0.0.1:8089/`. Check the startup output: **Signed in as** shows your app registration, **Permissions** lists what the token contains, lines starting with **Missing** tell you what to add. Keep the window open; **Ctrl+C** stops it. After a restart, reload the browser tab.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Config file not found` | Copy `config.example.json` to `config.json`, or pass `-ConfigPath`. |
| `'ClientSecret' is not set` | Empty or still a placeholder (`YOUR_…`, `PASTE_…`). |
| `AADSTS7000215` | Wrong secret — use the secret **Value**, not its ID. |
| `AADSTS7000222` | The secret has expired. |
| `AADSTS700016` | `ApplicationId` not found in that tenant. |
| `Missing: …` at startup | Permission not added as **Application** permission or no admin consent. Restart the server after granting (tokens are cached up to an hour). |
| `Could not listen … denied` | See *Listening on 127.0.0.1* in [REQUIREMENTS.md](REQUIREMENTS.md). |
| `Could not listen … in use` | Another instance or the decommission tool uses the port. Change `ListenPrefix`. |
| *The local server was restarted. Reload the page.* | The session token changed. Reload the tab. |
| Rows show **Error** with `HTTP 403` | The token lacks the permission for that lookup — see the table in [REQUIREMENTS.md](REQUIREMENTS.md). |
| Device found by name in Intune but **Intune only** | The Intune record has no Entra object (`azureADDeviceId` empty or zeros) — typical for personal Android devices. |
| **Valid · duplicates** | Several live devices share the name. Add a hint (serial or user) in a second column. |
| Copy buttons do nothing | The browser blocked the clipboard; use *Copy table* / *Export CSV*, or allow clipboard access for `127.0.0.1`. |
| `Running scripts is disabled on this system` | Use `Start-Lookup.cmd`, or `powershell -ExecutionPolicy Bypass -File .\server.ps1`. |
