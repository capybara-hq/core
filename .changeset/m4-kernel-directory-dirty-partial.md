---
"@capybara-hq/kernel": patch
---

通讯录同步（Ruling A32）：移除阶段前 GET 脏标记（不取走），本轮持锁期间来过 `directory_changed` 时按不完整处理、
不移除任何人（审计 `partialReason: "changed_during_sync"`），移除留给随后的补跑。
