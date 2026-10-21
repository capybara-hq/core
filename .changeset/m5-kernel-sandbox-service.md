---
"@capybara-hq/kernel": minor
---

按对话的沙箱服务（M5 T7）：

- `kernel.sandbox`（`SandboxService`）：在 `sandbox@1` 提供方之上每个对话一个沙箱，第一次使用才创建；
  同一对话的操作都在 Redis 锁 `capk:sandbox:<对话>` 下串行（TTL 60 秒、续租），多副本同时首次使用只创建一个。
  已休眠的下次使用时恢复；恢复返回 `gone`、已销毁或换了提供方时重建空沙箱（`recreated: true`）。
- 新表 `capybara.sandboxes`（迁移 `0023_sandboxes.sql`）。
- 维护队列新增 `sandbox-suspend-idle`（每分钟：空闲到期或连续运行超过 `maxRunningMinutes` 的休眠，
  正在执行命令的跳过）与 `sandbox-destroy-inactive`（每小时：不活跃到期、组织已删除、对话已删除的销毁）。
- 新配置 `sandbox.image` 与 `sandbox.limits.*`（`allowHosts` 每项按 `validateAllowHost` 校验）。
- 没有沙箱提供方时使用报 `sandbox.unavailable`（503）。
