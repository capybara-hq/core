# M1 遗留事项（写 M2 计划时对照）

来源：M1 子代理执行记录中各任务审查推迟处理的轻微问题、最终整分支审查的复审观察，以及 M1 合并后用户对搁置项的裁决（2026-10-17）。已在 M1 最终修复波次中修掉的条目不在此列。

M2（计划 `2026-10-17-m2-agent-runtime.md`）已处理全部轻微项（用户裁决：M1 轻微项全部在 M2 处理），对应提交见文末「M2 已处理」；只剩「发版前处理」与下面「观察中」的偶发测试失败。

## 用户裁决：发版前处理（不纳入 M2）

- **R26** changeset 与 SDK 版本范围对齐：plugin-sdk 升 minor 后为 0.2.0，示例插件、`writing-plugins` 模板与测试 fixture 的 `sdk: "^0.1.0"` 需同步；私有包 `@capybara-hq/capybara` 的 changeset 需在 changeset 配置开 `privatePackages.version` 或删除。`SDK_VERSION` 同样在发版时调整。

## 观察中（偶发测试失败，暂不改动）

- `packages/testing/test/dual-replica.test.ts`：M1 期间高负载下偶发失败过一次。
- `packages/kernel/test/runtime/run-worker.test.ts`：M2 Task 16 的一次全量运行中失败过一次。
- `packages/kernel/test/plugins/org-config.http.test.ts`：M2 Task 3 的一次全量运行中在 beforeAll（容器启动）阶段失败过一次。

再次出现时记录失败输出与当时的负载，再定位修复。

## M2 已处理

| 遗留事项 | M2 任务 | 提交 |
|---|---|---|
| R24 改密码吊销全部个人访问令牌（与会话吊销在同一事务内） | Task 1 | `cd16a9d`、`ab8d443` |
| R25 登录限流按（登录名, IP）、IP、单登录名全局上限三键计数；被拒绝的尝试不再递增 | Task 1 | `cd16a9d`、`ab8d443` |
| `LoginBody.login` 无长度上限；改密码失败消耗共享的单 IP 登录额度（改为独立的 `reserveScoped` 额度） | Task 1 | `cd16a9d` |
| `@Public` 路由的凭据解析吞掉 PG / Redis 故障；公开路由元测试可被 handler 自抛 `auth.required` 掩盖 | Task 1 | `cd16a9d` |
| Cookie 认证的吊销检查与账号读取合并为一条查询；`SessionService.get()` 排除已过期会话；`setCurrentOrg` 对不存在的会话报错 | Task 1 | `cd16a9d` |
| `isLoginTaken` 只按约束名判断；`SettingsService.get` 逐键校验；R10 计时测试改为 spy；补「停用 vs 降级」并发测试 | Task 1 | `cd16a9d` |
| 清 Cookie 的 Path 断言；Bearer 与 Cookie 同时出现的测试 | Task 1 | `cd16a9d` |
| 凭邀请注册在 BEGIN 前算哈希；公开的接受邀请接口限流；`setupToken` 接口限流；CLI 交互输入密码不回显；`GET /admin/accounts` 返回 `next` 游标 | Task 1 | `cd16a9d` |
| `PUT /me/current-org` 先查后写不在事务内、加载全部成员关系 | Task 2 | `2a8ff46` |
| 服务令牌访问另一组织 HUMAN_ONLY 路由为 404、已删除与不存在组织的 404 逐字节相同（补测试）；管理员自降级（确认允许并写入技能） | Task 2 | `2a8ff46` |
| 邀请的冗余成员预检查 | Task 2 | `2a8ff46` |
| `createServiceAs` / `createService` 创建路径重复；`expiresAt` schema 重复且接受非 ISO 输入（`FutureIsoDate`） | Task 2 | `2a8ff46` |
| 插件配置：非事务读取、回滚测试未真正回滚、旧密钥行残留、已停用插件也校验、无记录时 `{}` | Task 2 | `2a8ff46` |
| 插件 HEAD 请求、插件作用域 Fastify 错误信封、畸形 `Host` 返回 400、失败日志路径脱敏 | Task 3 | `0ab3589` |
| ErrorFilter 缺测试；Nest「Mapped route」日志降为 debug；`kernel.test` 404 断言错误码 | Task 3 | `0ab3589` |
| 等待 listen 与关闭 HTTP 共用 10s；`ctx.db` 递归拦截 `destroy`；cleanup 测试断言 Redis / bus 关闭；`slow` fixture 的 deferred 改由测试创建；api-only 不消费改为事件驱动 | Task 3 | `0ab3589` |
| `load()` 中 `ctx.close()` 失败记 warn；`connectTimeoutMs` 条件展开收敛为 `pgConnectOptions`；插件 setup 永不返回时 `start()` 挂起写入 `writing-plugins`；`capybara migrate` 也检查密钥可达 | Task 3 | `0ab3589` |
| `adding-config` 写明整段 JSON 与逐字段环境变量冲突；补「不冲突」与忽略前缀的测试 | Task 3 | `0ab3589` |
| 非字符串密钥值不打码、只覆盖部署级、无嵌套密钥测试（数字 ≥ 4 位打码、布尔与短值不打码、组织密钥进有界集合、重叠密钥合并区间） | Task 3 | `0ab3589`、`bbf2e2c`、`84ac442`、`4adad48` |
| Nacos 鉴权（用户名 / 密码与 accessToken；M0 遗留） | Task 3 | `0ab3589` |
| 双副本验收未断言每个请求落在哪个副本（新增 `http.replicaId` → `x-capybara-replica` 响应头，`Harness.request` 返回 `replica`） | Task 18 | `4669cf7` |
| `m0-followups.md` 中 Task 11 那行措辞含糊；「M1 已处理」表的提交列是提交信息而非哈希；AGENTS.md 依赖链段落有未核实的说法（已逐包核对 package.json 并更正） | Task 18 | `4669cf7` |
| `AccountsService.update` 中 `Partial<Record>` 强转（改为 `Updateable<AccountsTable>`） | Task 18 修复轮 1 | `30067b3` |
| 重放两次轮换之前的 refresh token：补测试，固定现行行为（`refresh_invalid`，不吊销会话） | Task 18 修复轮 1 | `30067b3` |
| 停用账号用正确密码登录消耗登录额度（改为退还） | Task 18 修复轮 1 | `30067b3` |
| 停用账号与吊销会话 / 个人令牌不在同一事务（改为同一 PG 事务，Redis 标记提交后尽力写入） | Task 18 修复轮 1 | `30067b3` |
| 初始化、凭邀请注册在提交后才创建会话（改为同一事务内写会话行，提交后设 Cookie） | Task 18 修复轮 1 | `30067b3` |
| 两个已有账号并发接受同一邀请的测试没有打到带条件的 UPDATE（改为另一连接持组织行锁，确定性地让后到者走到条件 UPDATE） | Task 18 修复轮 1 | `30067b3` |
| ctx 关闭后 `bus.subscribe` 仍加入已清空的退订集合（改为明确报错，订阅中途关闭则自行退订） | Task 18 修复轮 1 | `30067b3` |
| `client.connect()` 期间的中止不主动取消（改为销毁正在建立的套接字） | Task 18 修复轮 1 | `30067b3` |
| 所有企业管理员被停用后初始化重新开放、停机时 bus / redis / pg 只剩约 3s 且 pg 销毁可能晚于 `stop()` 返回（写入 README「运维须知」） | Task 18 修复轮 1 | `30067b3` |
