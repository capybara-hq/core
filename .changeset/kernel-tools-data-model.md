---
"@capybara-hq/kernel": minor
---

新增工具相关数据表（迁移 `0010_tools.sql`：`apps`、`app_tools`、`tool_grants`、`conversation_tool_grants`、`approvals`、`questions`、`tool_outputs`，`runs.status` 增加 `waiting`，`orgs.settings`）、`tools` 配置段与 `http.publicUrl`；组织动作新增 `apps.manage`（admin）、`apps.use`（guest）、`approvals.decide`（guest），均仅限用户主体；错误码 `app.*`、`approval.*`、`question.*`、`tool_output.not_found`、`credential.missing`。

应用凭据（`Credentials`）：信封加密存入 `capybara.secrets`（命名空间 `kernel`，键前缀 `credentials:app:`），支持 bearer / api_key / basic / headers 静态认证注入，读出的值登记日志打码，缺凭据抛 `CredentialMissing`（`credential.missing`）。

应用管理与工具注册表：新增 `/api/v1/orgs/:orgId/apps`（`GET` 列表 / 详情用 `apps.use`；安装、`PATCH`、软删、`POST /:appId/refresh`、`PUT /:appId/credentials/org` 用 `apps.manage`；`PUT|DELETE /:appId/credentials/me` 用 `apps.use`，只动本人的个人凭据）。安装时可带 `credential`，先用它（不落库）连接连接器并 `listTools` 拍快照，连接失败返回 502 `app.connect_failed`（消息只含上游错误类名）且不写任何数据，成功后应用、工具快照、凭据与审计在同一事务写入；工具默认策略按注解推导（只读 → allow，其余 → ask），`spec_hash` 为规范化 JSON 的 sha256 前 16 位；slug 由名称推导或显式给出（`^[a-z][a-z0-9_]{0,23}$`，不含连续 / 结尾下划线），冲突 409 `app.slug_taken`；工具 key（`<slug>__<tool>`）超过 64 字符或含非法字符时该工具停用并在响应 `issues` 与工具的 `issue` 中给出原因，不截断。`ToolRegistry.forAgent` 解析内置 / 插件 / 应用工具，过滤停用、待复核、已删除、插件未在本组织启用等情况并返回 `unavailable` 原因；`connector(kind)` 按 `Connector.kind` 查找连接器。`Kernel.tools` 暴露注册表与凭据服务。

Agent 定义可引用工具：`tools` 接受内置（`{kind:"builtin",name}`）/ 插件（`{kind:"plugin",plugin,name}`）/ 应用（`{kind:"app",appId,tools:"all"|string[]}`）引用（M2 保存的 `tools: []` 仍合法），新增 `toolPolicies`（按工具 key 只能收紧为 `ask` / `deny`）；创建时省略 `tools` 默认带 `ask_user`、`read_tool_output`，修改不注入默认值。保存时校验引用存在（内置按 `BUILTIN_TOOL_NAMES`，插件须已注册，应用须属本组织且未删除、点名工具须存在）、key 不冲突、`toolPolicies` 的键属于该 agent，否则 400 `validation_failed`（path `tools.<i>` / `toolPolicies.<key>`）。运行时每步经 `ToolRegistry.forAgent` 解析工具，按 key 排序放进 `ModelRequest.tools`（收尾调用不带工具），`model_call.request.tools` 记录 `{key, specHash}`，token 估算计入工具定义；有不可用工具时写英文 `reminder`（`The following tools are unavailable in this run: …`，同一 run 内内容不变不重复写），运行不失败。新增事件 `tool_call_started`、`tool_result`，构建请求时 `tool_result` 还原为紧随其 assistant 消息的 user 消息（同一步合并、按调用顺序）。`ModelStepDeps` 新增 `tools`，`ModelStepInput` / `LoopContext` 新增 `orgId`。
