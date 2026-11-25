---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
---

A device's first tool call no longer hangs in silence until the tool's time limit:

- `ToolSpec.timeoutMs`: an extension tool can declare its own time limit, from 1 s to 10 min
  (`TOOL_TIMEOUT_MIN_MS`, `TOOL_TIMEOUT_MAX_MS`). It replaces `tools.timeoutMs` for that tool.
- A tool call that times out while `ctx.deviceAccess.ensureService` is still starting the device
  says that the device was still starting and the request never reached its target. It no longer
  uses the generic "may or may not have completed" text.
- The dial-in relay adds the reconnect grace only while the machine is disconnected. A connected
  machine that does not answer is given up at the deadline plus a short margin, with
  `DialInAnswerTimeoutError`. `capybara-device` now answers an expired lifecycle or operation
  request with a typed `unknown` error instead of staying silent.
- The sandbox logs each lifecycle step (resume, create, recreate) with its duration and outcome.
  It also logs relay give-ups and aborted lease or relay waits.
- A device service launch is reviewed by its own rule, `allow.service` ("Starts a device service
  declared by the extension, from its code directory."), instead of `allow.dev`.
