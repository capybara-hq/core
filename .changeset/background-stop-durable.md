---
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/web": patch
---

A background task's stop is durable intent. The kernel records it (`cancel-pending`, who asked) before the device is asked and gives one attempt at most 20 s; when the device's machine is offline or does not answer, the stop stays owed and the poller delivers it once the device answers. `TaskStop` and the stop button return promptly: the tool says the stop is requested, and the panel says "等待设备响应后停止" / "Stops when the device answers" (`stopWaiting` on the task view) instead of spinning. On the device, an operation's private supervisor whose sandbox runtime teardown hangs (a proxied connection the remote never closes) is killed 5 s after its stop, so the machine answers the stop.
