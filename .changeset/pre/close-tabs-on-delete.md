---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Deleting a conversation now tells its device's services right away: the kernel owes a
conversation-deleted notice in the deleting transaction and delivers it to every running extension
service of the device (an offline device gets it once it is back; a stopped service once it runs
again within the restore window). The SDK's device service protocol gains the notice
(`encodeConversationDeleted`, `parseConversationDeleted`) and `DEVICE_SERVICE_RESTORE_MAX_AGE_MS`,
the window within which a service may restore saved state. The browser plugin uses it to close a
deleted conversation's tabs at once.
