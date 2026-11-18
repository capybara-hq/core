---
"@capybara-hq/kernel": minor
---

Share a conversation file as a snapshot: `POST …/conversations/:id/files/:fileId/shares` copies the
file under `shares/<id>/<generation>` before its row is written, with a 10-character code; the
per-file list (with the share policy), "update to latest" (`POST …/shares/:shareId/refresh`),
revoke (`DELETE …/shares/:shareId`, creator or org admin; the snapshot's deletion is owed through
the outbox) and `GET …/shares?scope=mine|all`. The Platform tool gains `conversations.list-shares`
and `conversations.revoke-share`; the files list marks shared files (`shared`). A share view
carries `url`, the absolute link `<http.publicUrl>/s/<code>` (null without a public URL).
