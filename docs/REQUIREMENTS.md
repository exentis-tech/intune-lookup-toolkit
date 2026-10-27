# Requirements

## Workstation

| Item | Requirement | Notes |
|---|---|---|
| Operating system | Windows 10 / 11, Windows Server 2016 or later | macOS and Linux work with PowerShell 7 |
| PowerShell | Windows PowerShell **5.1** with .NET Framework **4.7.2+**, or PowerShell **7.2+** | No modules required |
| Browser | Current Microsoft Edge, Google Chrome or Mozilla Firefox | Clipboard buttons need a normal (non-private) tab on some browsers |
| Local port | One free TCP port on loopback, `8089` by default | Set with `ListenPrefix` |
| Execution policy | Must allow the script to run | `Start-Lookup.cmd` uses `-ExecutionPolicy Bypass` for this process only |

### Windows: listening on 127.0.0.1

`server.ps1` uses `System.Net.HttpListener`. On some Windows builds a non-administrator can only listen on `http://localhost:<port>/`. If startup reports *access denied*, either set `"ListenPrefix": "http://localhost:8089/"` or reserve the address once from an elevated prompt (the server prints the exact command):

```cmd
netsh http add urlacl url=http://127.0.0.1:8089/ user=DOMAIN\username
```

## Network

Outbound HTTPS (TCP 443) to:

| Host | Purpose |
|---|---|
| `login.microsoftonline.com` | Token requests (client-credentials flow) |
| `graph.microsoft.com` | Microsoft Graph v1.0 |

Through a proxy: set `ProxyUrl`, and `UseDefaultProxyCredentials: true` if the proxy authenticates with your Windows account. For national clouds set `AuthorityHost` and `GraphBaseUrl`.

## Microsoft Entra ID

### App registration

- Single-tenant app registration with a **client secret** (or supply it at runtime with the `IAD_CLIENT_SECRET` environment variable).
- **Application** permissions on Microsoft Graph, with **admin consent**:

| Permission | Used for | Graph calls (all `GET`) |
|---|---|---|
| `DeviceManagementManagedDevices.Read.All` | Intune devices | `/deviceManagement/managedDevices`, `/deviceManagement/managedDevices/{id}` |
| `Device.Read.All` | Entra devices and object IDs | `/devices`, `/devices/{id}` |
| `User.Read.All` | Users, locations, departments | `/users`, `/users/{id or UPN}` |
| `GroupMember.Read.All` | Groups and their members | `/groups`, `/groups/{id}/members`, `/groups/{id}/transitiveMembers` |
| `Organization.Read.All` *(optional)* | Tenant name in the header | `/organization` |

`Directory.Read.All` covers devices, users and groups in one permission if you prefer. Write permissions are never needed — the server refuses every write anyway.

The server prints the permissions in its token at every start and warns about missing ones; the page shows a banner too.

### Roles

| Task | Role |
|---|---|
| Create the app registration and secret | Application Administrator / Cloud Application Administrator (or app owner) |
| Grant admin consent | Global Administrator or Privileged Role Administrator |
| Run the tool | Anyone who can read `config.json` — protect it like an admin credential |

Application permissions are tenant-wide and are not limited by Intune RBAC or scope tags.

### Licensing

A tenant with Microsoft Intune and Entra ID. No extra licences are needed for the calls this tool makes.
