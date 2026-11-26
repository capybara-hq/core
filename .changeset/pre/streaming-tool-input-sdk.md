---
"@capybara-hq/plugin-sdk": minor
---

Stream events for tool calls and a display-only input preview. `ModelStreamEvent` gains
`tool_call_start` (`id`, `name`) and `tool_call_delta` (`id`, raw argument JSON `input`); a provider
may emit them while the model writes a call, and `message_complete` stays the source of truth.
`ToolSpec.inputView` (`ToolInputView`: `file_write`, `file_edit`, `command`, `text`) names the
string input properties the UI previews while they stream, checked by `validateToolPresentation`.
