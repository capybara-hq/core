---
"@capybara-hq/web": patch
"@capybara-hq/design": patch
---

The sandbox escalation approval card (conversation and inbox) says when approving starts a
background process: it keeps running outside the sandbox until it exits or is stopped, at most
its deadline in minutes. A command the command review admitted outside the OS sandbox now shows
" · Ran outside the sandbox" / " · 在沙箱外运行" on its tool row (design `ToolRowData.outsideSandbox`,
part `sandbox-word`), on done and failed rows.
