---
"@capybara-hq/plugin-sdk": minor
---

Embed tokens and plugin route callers gain a `share` scope (file previewers on a share page); `FilePreviewArgs` is a union on `source` (`conversation` | `share`), with the shared fields exported as `FilePreviewArgsBase`.
