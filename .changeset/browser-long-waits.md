---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/design": patch
"@capybara-hq/web": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Watched input waits (plugins#207, browser long waits spec): an extension tool's `InputRequired`
may carry `watch: { deadlineMs }` and its registration a watcher (`ctx.tools.register(spec,
handler, { watch })`, `ToolWatcher`). The kernel parks the run as a question (no model turns, no
worker held) and polls the watcher every 10 s on the new `cap-kernel-tool-watch` queue; a settle
wakes the question (new status and card state `woken`), and `ctx.resume.outcome` tells the handler
how the round ended (`answered` / `woken` / `expired`). `ctx.deviceAccess.request` gains
`ifRunning` (`DeviceAccessError` `not_running`), forced for watchers, which never resume or start
anything. New config `tools.watchConcurrency` and `tools.maxWatchedWaitsPerAccount`; a watched
wait skipped by a message reads `WAIT_SKIPPED_TEXT`; the web draws a wait card with one end button.
The testing package gains the `fake-watch` fixture.
