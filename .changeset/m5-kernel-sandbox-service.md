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
- 锁的防护：记录带 `generation`，锁内的每次状态写入都按它比较并加一；锁丢失时中止传给回调的 signal
  （回调第四个参数）。等锁超过 `sandbox.lockWaitSeconds`（默认 75，须大于锁 TTL 60 秒）报 `sandbox.busy`（409）。
- 回调抛 `SandboxGoneError` 时原地重建并重试一次；`recreated` 按 `had_instance` 判断，重建失败后仍为 true。
- 换提供方时旧实例记在 `prev_provider` / `prev_handle`，旧提供方仍加载时用它销毁；
  句柄为空（创建中途退出）时用可选的 `destroyByName` 清理；扫描失败的排在后面（`sweep_failed_at`）。
- 接手崩溃的前任（fix wave S2）：执行回调期间写 Redis 标记 `capk:sandbox-busy:<对话>`（TTL 为最长命令时间加
  10 分钟，结束后只删自己的）；拿到锁时标记还在，先调提供方可选的 `killAll` 杀掉前任遗留的命令（新建的沙箱不调；
  失败只记 warn）。
- 成员离职（移出、离开、通讯录同步）提交后，此人在该组织对话里还没销毁的沙箱由新的一次性维护任务
  `sandbox-destroy-for` 逐个 `destroyFor` 销毁（失败整批重试）；`OffboardResult` 新增 `sandboxConversations`。
- 每次拿到沙箱锁都先防护地把 `generation` 加一；内核自己续租并记下最后一次成功续租的时间，超过 TTL
  没有成功续租（续租报错也算）即视为锁丢失，中止回调与维护里提供方调用的 signal。
