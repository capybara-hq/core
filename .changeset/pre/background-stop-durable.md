---
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/web": patch
---

A background task's stop is durable intent. The kernel records it (`cancel-pending`, who asked) before the device is asked and gives one attempt at most 20 s; when the device's machine is offline or does not answer, the stop stays owed and the poller delivers it once the device answers. `TaskStop` and the stop button return promptly: the tool says the stop is requested, and the panel says why the recorded stop still waits ("停止已记录，等待设备执行", "等待设备响应后停止", "设备未能停止，将自动重试"; `stopWaiting` and `stopFailure` on the task view) instead of spinning. The poller delivers owed stops per device side by side, so one silent machine never delays another device's stops. On the device, an operation's private supervisor whose sandbox runtime teardown hangs (a proxied connection the remote never closes) is killed 5 s after its stop, with the command's process group, so the machine answers the stop.
