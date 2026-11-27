---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

Media refs name a file id: `MediaSource`'s `ref` variant is `{ kind: "ref"; fileId }` (was
`attachmentId`), checked by `validateMediaBlock` and the new `isFileId`.
`FilePreviewConversationArgs.conversationId` is optional: it is absent for a library file previewed
outside a conversation. The kernel logs new refs as `fileId` and reads a ref logged before the
rename (`attachmentId`, the same id) as an alias, so old logs rebuild unchanged.
