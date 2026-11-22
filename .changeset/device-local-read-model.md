---
"@capybara-hq/device": minor
---

Sandboxed reads cover the machine minus secrets and other connections; project reach is a
per-connection setting `machine|paths|workspace` (with `projectPaths`); device protocol 6; policy
format 4.

Upgrading: a version 3 `policy.json` is refused when the program starts. Run
`capybara-device ceiling set ...` once: it rewrites the file from the closed policy (workspace
reach, allowlist network, nothing outside the sandbox, keep-awake off) and prints what it reset.
Allowed domains, credentials, resource limits and keep-awake must be set again.
