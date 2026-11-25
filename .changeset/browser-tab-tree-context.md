---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Browser tabs owned per conversation, core part. `ToolCallContext.rootConversationId` gives every
tool handler the root of its conversation tree (set by the kernel). A viewer stream on a device
service now starts with a kernel-written viewer context message (`DeviceServiceViewerContext`,
`encodeViewerContext`, `parseViewerContext`: the ticket's conversation and its root); a later
`{"kind":"viewer"}` from the panel is never context. `ctx.deviceAccess.answerHandoff` takes
`handoffConversationId` and answers a sub-agent's handoff from the root's panel, only within the
scope conversation's tree. `@capybara-hq/testing`: `FakeDialInMachine.streamOpenGate` holds a
`stream-open` answer for ordering tests. During a rolling upgrade, viewer tickets minted by an older
replica are refused (a ticket lives 60 s; reopen the panel).
The browser plugin's panel Done / Cancel needs the browser release that passes
`handoffConversationId`; upgrade both together.
