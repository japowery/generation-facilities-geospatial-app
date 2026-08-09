# Security policy

## Supported release

The supported release is the current `main` branch and the latest published version under `dist/` or GitHub Releases.

## Reporting a concern

Please do not publish sensitive data, credentials, or exploitation details in a public issue. Use a private GitHub Security Advisory for this repository when available. If that feature is not enabled, contact Jason Powery privately through the GitHub profile before public disclosure.

Include the affected version, a concise reproduction, impact, and any suggested mitigation. Do not include raw source extracts or confidential facility data in a report.

## Important distribution boundary

The static site and desktop executable are client-side artifacts. Any data delivered to them can be recovered by a user with access to the application. A password prompt inside the client is not a substitute for authenticated hosting, encryption, or per-user authorization.
