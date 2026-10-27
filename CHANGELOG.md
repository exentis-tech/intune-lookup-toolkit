# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · versioning: [SemVer](https://semver.org/).

## [1.0.0] - 2026-10-27

First public release. Replaces a set of standalone PowerShell lookup scripts with one read-only web tool.

### Added
- **Devices**: resolve any mix of device names, serial numbers, Entra device IDs, Entra object IDs and Intune device IDs to every identifier plus serial, primary user, ownership, OS, compliance, management state and last check-in. Intune and Entra records are linked through `azureADDeviceId`; duplicates are ranked by hint, management state, link, enabled state and recency. *Best match* or *Every match*. Optional primary-user details (country, usage location, department…).
- **Users**: details and location by UPN, mail, display name or object ID; or every Intune device they are primary user of, with all three device IDs.
- **Groups**: users and/or devices of groups by name or ID, optionally through nested groups, de-duplicated with source groups.
- Results table: status chips, text filter, sort, column picker (remembered), click-to-copy cells, copy a column in four formats, row selection with Shift-range, copy as table for Excel, CSV export, send a column to another tool.
- Paste with hint column (Tab, `;` or `,`), header-line detection, duplicate removal, CSV import with column picker, drag and drop.
- `server.ps1`: reads `config.json` (same format as Intune App Decommission), client-credentials token, read-only Graph proxy with allowlist, session token, loopback only, Windows PowerShell 5.1 and PowerShell 7, proxy support.
- Demo tenant, unit tests, end-to-end server tests, CI on Linux and Windows.
