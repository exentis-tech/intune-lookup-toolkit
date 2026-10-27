# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private reporting: **Security** tab → **Report a vulnerability**. Include the version, steps to reproduce and the expected impact.

## If you leaked a client secret

If `config.json` or a client secret was committed, pasted in an issue, or shared:

1. **Delete the secret** in Entra ID → App registrations → your app → Certificates & secrets.
2. Create a new one and update `config.json`.
3. Review the app's *Service principal sign-ins* in Entra ID.
4. Removing the file from Git history is not enough — the secret must be rotated.

## If you shared an export

CSV exports contain names, emails and device identifiers. Treat them as personal data and delete copies that were shared by mistake.

How the tool protects its credential: [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md).
