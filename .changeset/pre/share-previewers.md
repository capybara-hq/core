---
"@capybara-hq/kernel": minor
---

File previewers on a share page: the share metadata lists the org's extension previewers that take
the snapshot, `GET /api/v1/s/:code/previews/:plugin/:previewerId` renders a view previewer for the
snapshot (`source: "share"`), and `POST /api/v1/s/:code/embed-token/:plugin/:previewerId` mints a
share-scoped embed token (`scope: "share"`, no account or role). Such a token verifies only for a
`file.preview` contribution, only while the share is live at its generation and the extension is
enabled in the share's org, and never for `/api`. HTML over 20 MiB on a share now renders as a
download, and a failed `share.opened` audit no longer suppresses the next one.
