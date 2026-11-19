---
"@capybara-hq/kernel": minor
---

Serve HTML files as sandboxed documents (file sharing spec §4): the conversation's owner mints a
five-minute document token (`POST …/files/:fileId/html-token`, delivered files and uploads), and
the public `GET /api/v1/html/<token>` streams the stored bytes under a `sandbox` CSP (no same
origin, no connections, scripts / styles / fonts / images from the platform CDN allowlist only),
re-checking the owner's access or the share's liveness on every load. HTML over 20 MiB is not
rendered. `Deliver`'s description now asks for self-contained HTML reports.
