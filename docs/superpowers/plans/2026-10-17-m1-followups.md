# M1 遗留事项（写 M2 计划时对照）

来源：M1 子代理执行记录中各任务审查推迟处理的轻微问题、最终整分支审查的复审观察，以及 M1 合并后用户对搁置项的裁决（2026-10-17）。已在 M1 最终修复波次中修掉的条目不在此列。

## 用户裁决：纳入 M2

- **R24 改密码吊销个人访问令牌**：`PUT /me/password` 成功后，除吊销其他会话外，还要吊销该账号的全部个人访问令牌。
- **R25 登录限流按「登录名 + IP」计数**：避免任何人都能定向锁死一个已知登录名（如 `admin`）；另设一个更高的单登录名全局上限。
- **Nacos 鉴权**（M0 遗留）：用户名/密码与 accessToken。
- **下列全部轻微项**。

## 用户裁决：发版前处理（不纳入 M2）

- **R26** changeset 与 SDK 版本范围对齐：plugin-sdk 升 minor 后为 0.2.0，示例插件、`writing-plugins` 模板与测试 fixture 的 `sdk: "^0.1.0"` 需同步；私有包 `@capybara-hq/capybara` 的 changeset 需在 changeset 配置开 `privatePackages.version` 或删除。

## 轻微项（纳入 M2）

### HTTP 与插件分发
- 插件 GET 路由的 HEAD 请求返回 404（M0 的 Hono 会以 GET 处理 HEAD）。
- 插件作用域内 Fastify 自身的错误（如超过 1 MiB 的 413）不走内核错误信封。
- 畸形 `Host` 头被记成「plugin handler failed」并返回 500，应在 try 之前返回 400。
- `plugin handler failed` 日志记录原始路径，未经 `redactPath` 脱敏。
- ErrorFilter 的 ApiError / details / 5xx / 未知异常路径缺测试。
- NestLogAdapter 每次启动输出约 6 行 info 级「Mapped route」。
- `kernel.test` 的 404 断言只看状态码不看错误码。

### 生命周期
- 等待 listen 与关闭 HTTP 各占 10s 预算（最坏约 20s）。
- `ctx.db.connection().execute(cb)` 回调里拿到的 Kysely 未包裹，`destroy` 可达。
- `create-kernel-cleanup` 测试只断言 `db.destroy`，未断言 Redis 与 bus 关闭。
- `slow` fixture 的模块级 deferred 在重跑时不会重置。
- api-only 不消费任务的反向检查用固定 sleep。
- `load()` 中 `ctx.close()` 的错误被吞掉、未记日志。
- `connectTimeoutMs` 的条件展开在多处重复。
- 插件 setup 永不返回时 `start()` 永远挂起（资源已释放）——需文档说明。
- ctx 关闭后 `bus.subscribe` 仍会加入已清空的退订集合（无泄漏）。
- 各阶段都超时的最坏情况下 bus / redis / pg 只剩 2s，pg destroy 可能晚于 `stop()` 返回。
- `client.connect()` 期间的中止不会主动取消（受 `connectTimeoutMs` 约束）。
- `capybara migrate`（`PluginHost.migrateOnly`）不执行 `assertSecretsReachable`，问题插件的迁移仍可经 CLI 应用。

### 配置
- 整段 JSON 环境变量与逐字段环境变量同时设置会被判冲突——需在 `adding-config` 写明。
- 缺少固定「不冲突」情形与忽略前缀先于冲突检测的测试。
- 非字符串的密钥值不打码；只覆盖部署级配置；没有嵌套密钥的测试。

### 账号与会话
- `isLoginTaken` 还按表名兜底；`SettingsService.get` 一个键非法就丢掉全部键；计时测试标题写「一半」却断言 0.3；`update` 中 `Partial<Record>` 强转；缺「停用 vs 降级」并发测试。
- 重放两次轮换之前的 refresh token 只返回 `refresh_invalid`、不吊销会话（计划规定的分支，未测）。
- `SessionService.get()` 会返回已过期未吊销的会话；`setCurrentOrg` 对不存在的会话静默无操作。
- Cookie 认证的请求先查一次会话 `revoked_at` 再查账号，可合并为一次查询。

### 鉴权与登录
- `@Public` 路由的凭据解析会吞掉非鉴权错误（PG / Redis 故障被当作匿名）。
- R10 的单元测试基于计时。
- 公开路由元测试可被「处理函数自己抛 `auth.required`」掩盖。
- 清 Cookie 的 Path 未断言；缺 Bearer 与 Cookie 同时出现的测试。
- 每次登录尝试（含停用账号的正确密码）都消耗登录名额度；`LoginBody.login` 无长度上限。
- 改密码失败尝试也消耗共享的单 IP 登录额度（共享 NAT 下可能互相影响）。
- `dual-replica.test` 在高负载下偶发失败过一次——持续观察。

### 组织与邀请
- `PUT /me/current-org` 先查后写不在事务内，且为判断一个成员关系加载全部成员关系。
- 缺测试：服务令牌访问另一组织的 HUMAN_ONLY 路由应为 404；已删除组织与不存在组织的 404 响应逐字节相同。
- 管理员可以给自己降级（需确认是否有意）。
- 两个已有账号并发接受同一邀请的测试大多在分类阶段失败，没有真正打到带条件的 UPDATE（凭邀请注册的测试覆盖了）。
- 凭邀请注册时 scrypt 在事务内执行，连接处于 idle in transaction；应在 BEGIN 前算哈希。
- 公开的接受邀请接口没有限流，持有令牌者可探测登录名是否存在。
- 会话在接受邀请提交后才创建（非原子，可恢复）；成员预检查冗余。

### 初始化与管理
- `setupToken` 接口无限流；CLI 在终端交互输入时回显密码；`GET /admin/accounts` 不返回下一页游标。
- 所有企业管理员都经数据库被停用时，部署重新对未认证的初始化开放——需在运维文档说明。
- 停用账号与吊销凭据不在同一事务；初始化提交后才创建会话。

### 令牌
- `createServiceAs` 与 `createService` 的创建路径重复；`expiresAt` schema 重复；`z.coerce.date` 接受非 ISO 输入。

### 插件配置
- `get()` / `list()` 分别读配置行与密钥，非事务，可能读到更新一半的结果。
- 回滚测试在写入前就失败，未真正测回滚；schema 变化后旧密钥行残留；`get()` 对已停用插件也校验；无记录时 `enabled:false` 存成 `{}`。

### 文档与测试
- `m0-followups.md` 中 Task 11 那行措辞含糊；「M1 已处理」表的提交列是提交信息而非哈希；AGENTS.md 新增段落中有未核实的说法。
- 双副本验收测试未断言每个请求实际落在哪个副本上。
