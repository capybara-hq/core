---
"@capybara-hq/capybara": patch
---

File library: files belong to the person and conversations refer to them; bytes are per-org blobs
deduplicated by sha256 and shared by files and shares (no more copies per share). A new Files page
(`/files`, nav 文件) lists the person's uploads and agent deliveries with a preview, details,
share, download, delete and upload; the conversation's file panel links to it. A daily blob sweep
frees bytes nothing refers to (deleted files keep their bytes for `files.deletedRetentionDays`,
default 30), and a one-off hashing job merges migrated duplicates. The Platform tool gains
`files.list`, `files.get`, `files.usage`, `files.delete` (handoff to the Files page) and
`files.add` (a conversation file into the library).
