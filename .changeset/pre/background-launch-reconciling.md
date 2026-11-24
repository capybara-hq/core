---
"@capybara-hq/kernel": patch
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

A background Bash start the kernel sent but could not confirm (a transport loss) no longer shows as
failed in the thread while the kernel reconciles it. Its result keeps the same error text for the
model and adds the display-only `launch_unconfirmed` view; the background tasks list gains
`starting`, and reconciling a start announces `changed: background`. The row reads "正在确认是否已启动"
/ "Confirming whether it started" until the task is confirmed running or ends, and becomes a
failed row only when the launch is given up, revoked or refused (#790).
