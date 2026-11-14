---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A call to a tool that the step's request did not load (ToolSearch mode) now carries a display-only
`not_loaded` view. It is expected behaviour — the kernel tells the model to load the tool with
`ToolSearch` and the model retries — so the conversation shows it as a neutral "需先加载工具" /
"Load the tool first" notice instead of a failure, and the tool group's header no longer counts it
as failed. The model-facing result is unchanged (`isError: true`, the same message).
