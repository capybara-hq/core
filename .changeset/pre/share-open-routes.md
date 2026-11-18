---
"@capybara-hq/kernel": minor
---

Public share link routes under `/api/v1/s/:code`: the share's metadata (with `render` and
`previewable` for the share page), its bytes (`/content`, always `application/octet-stream` under
a sandbox CSP, `?download=1` as an attachment), its text (`/text`), a bitmap in place (`/inline`)
and a redirect to its HTML document (`/html`). Every refusal is one 404 `share.not_found`; an
internal share needs a web session of an active member of the share's org (401
`share.sign_in_required` without one). A new `share-open` throttler allows 30 failed lookups per
client address in 10 minutes (successful opens are refunded), `share.opened` is audited at most
once per share and viewer per 10 minutes, and share codes are redacted from request logs.
