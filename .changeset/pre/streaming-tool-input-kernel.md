---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/plugin-model-fake": patch
"@capybara-hq/capybara": patch
---

Streaming tool input (spec 2026-11-26): the kernel forwards a provider's `tool_call_start` /
`tool_call_delta` as display-only `tool_start` / `tool_input` stream deltas and keeps them in the live
draft (`tools`, capped at 512 KiB per step); every stream event re-arms the idle watchdog, so a long
tool call no longer times out. For a builtin `Write` over a file the conversation already read
unchanged, the kernel reads a display-only base (`tool_base`) through a new `write_base` kernel read
that never wakes a device. Tool info returns each tool's `inputView`. `@capybara-hq/testing` gains
`checkToolStream` in the model conformance suite; model-fake streams every tool call's input and adds
the `streamtool:<ms>:<name>:<json>` directive.
