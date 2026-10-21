# Capybara MVP 路线图

**Spec:** `docs/superpowers/specs/2026-10-17-capybara-architecture-design.md`

MVP 的验收场景：**`docker compose up` 起来，五分钟内接上 Slack 或飞书，连上一个 MCP 或 OpenAPI 应用，
在 IM 里和 agent 对话，agent 调用工具、遇到写操作发审批卡片、审批后继续。**

MVP 拆成 7 个里程碑。每个里程碑单独一份详细计划，**前一个完成后再写下一个**
（后一个的接口依赖前一个的真实代码）。每个里程碑结束时都是可运行、可测试的软件。

| 里程碑 | 交付 | 覆盖 spec 章节 | 可演示的结果 |
|---|---|---|---|
| **M0 地基** | 仓库骨架与工程 harness；配置（文件 / Nacos / 环境变量）；PG 迁移器；`ctx`（kv / lock / bus / queue / secrets / http）；插件宿主；双副本测试工具；第一批自动检查 | 1、2、8.2、8.5、13 | 示例插件在双副本下跑通；CI 全绿；每道检查有「证明会红」的用例 |
| **M1 身份与组织**（已完成，计划 `2026-10-17-m1-identity.md`，双副本验收 `packages/testing/test/m1-acceptance.test.ts`） | **先把内核 HTTP 层从 Hono 迁到 Nest + Fastify**；账号、外部身份、组织、成员、四种角色、企业管理员；本地账号登录；初始化向导与 `capybara admin create`；会话与令牌；组织级插件配置存储 | 3.1–3.5 | 建企业管理员 → 建组织 → 邀请成员 → 按角色鉴权 |
| **M2 Agent 运行时**（已完成，计划 `2026-10-17-m2-agent-runtime.md`，双副本验收 `packages/testing/test/m2-acceptance.test.ts`，网页 e2e `apps/web/e2e`） | Agent 定义与版本；会话事件日志；BullMQ 运行链路；LangGraph 默认 loop；流式广播；插话；中止；崩溃续跑；上下文压缩；`anthropic` 与 `openai` 供应商插件 + 一致性测试；**模型参数插件化 + `openai-compatible`**（`model-provider@2`：模型声明参数、agent 配置 `modelParams` / `fallbackParams`、网页表单按声明渲染；`openai-compatible` 以方言预设接 DeepSeek / Qwen 等 Chat Completions 服务）；最小网页聊天（Next web 服务的第一个页面） | 4、6.1–6.2 | 网页里和 agent 多轮对话，杀掉 worker 后自动续跑 |
| **M3 工具与连接器**（已完成，计划 `2026-10-18-m3-tools.md`，双副本验收 `packages/kernel/test/tools/m3-segment1.dual.test.ts`） | 工具运行时与执行管线（插件 `ctx.tools`、内置 `ask_user` / `read_tool_output`、`InputRequired` 续跑、输出存档按会话隔离）；工具策略与审批（三种审批范围、失败即拒绝、超时兜底、审计链、网页收件箱）；MCP（远程，含 OAuth 授权码 / 客户端凭据、elicitation、prompts、resources）与 OpenAPI 连接器（`connector@1`，按已复核的定义路由、`inspect` 与安装预览、网页安装向导）；认证适配与加密凭据（静态 / OAuth，组织或个人）；`tool_search`（目录 + 按需加载，组织可关）；工具定义漂移检测与复核；任务清单工具（`plugins/todo`）；`ModelRequest.toolChoice`；工具设计规范检查（描述非空、错误带修正方式）。**推迟**：插件 UI 扩展区与产物（artifact）插件（独立设计议题）→ 待定；IM 审批卡片 → M4；沙箱支撑的输出文件 → M5；`ctx.hooks` → M6 | 5、6.3–6.7、7.3 | agent 调 MCP / OpenAPI 应用，写操作触发审批 |
| **M4 渠道与生态插件**（进行中，计划 `2026-10-19-m4-channels.md`；第一段（Task 1–14）与第二段的插件和文档（Task 15–19）已完成，双副本验收 `packages/kernel/test/channels/m4-segment1.dual.test.ts`、`slack*.dual.test.ts`、`lark*.dual.test.ts`；第二段的假平台验收（Task 20）已完成，真实平台部分待用户提供凭据（清单 `m4-live-acceptance-checklist.md`）；第三段对话页改版与插件扩展界面（Task 21–27，设计 `docs/superpowers/specs/2026-10-21-chat-panel-plugin-ui-design.md`）已完成，双副本验收 `packages/kernel/test/ui/m4-segment3.dual.test.ts`，文档 `skills/writing-plugin-ui`；新组件的截图基线在 PR 分支上用 `visual-update` 生成） | **先做扩展模型第一组**（见下方须知）：清单 `optional` / `permissions`、按清单构造 `ctx`、`ctx.capabilities` 能力取用、组织启用时校验依赖、权限快照与 CLI 批准、`check:plugin-permissions`；`channel@1` / `identity-source@1` / `directory@1` 接口；Slack 插件（登录 + 通讯录 + bot，Socket Mode 选主）；飞书插件（先做 Lark 国际版，同上，长连接）；审批卡片；渠道身份映射；`openai-compatible` 方舟（Ark）方言；**第三段：对话页改版与插件扩展界面**（D13，先设计后实现）（2026-10-19 调整）。（2026-10-20 记录）**推迟**：成员页上匿名访客的角色 / 移除控件（网页尚无成员页）→ M6 管理后台；IM 里仅自己可见的回复（ephemeral，SDK 以后加可选字段）→ 待定；飞书国内版（`lark` 插件的 `region: feishu` 已预留）→ 待定；待真实平台确认的事项（Lark 卡片回调失败后是否重推、JSON 2.0 卡片渲染、长连接 WSS 主机、v2 token 返回码与部门分页稳定性，Slack Socket Mode 重连与限流）→ Task 20；嵌入应用消息桥改用 `MessagePort`（`init` 时经 `postMessage` 转交一个专用端口，之后的 `token` / `theme` 与子页面消息只走这个端口，不再靠 `load` 次数判断 iframe 是否已导航离开；现状是第一个触发 `load` 的文档收到 `init`，见 `skills/writing-plugin-ui`「消息桥」，Task 26 复审 N3）→ 待定；插件视图 `text` 块的 Markdown 渲染器（M4 按纯文本加换行显示、链接不可点，要先在设计系统新增组件，Ruling A36）→ 待定；插件视图里插件自己路由下的图片（M4 的 `image` 块只认 http(s) 绝对地址，Ruling A34）→ 待定；产物插件（「产物」标签与数据形状已留好，没有来源时隐藏）→ 待定；（2026-10-21 终审记录）渠道投递 / 入站队列的优先级（`DELIVER_PRIORITY` / `INBOUND_PRIORITY`）只有弱测试，缺「积压时入站先于投递」的行为测试 → M6；不带 `eventId` 的卡片点击（平台没给事件 id）不按点击去重，只靠卡片状态复核挡重复决定 → 待定；`features.cards: false` 且 `edit: true` 的组合缺专门测试、插件 README 缺「未配置 publicUrl 时卡片链接怎样」一句（Task 19 复审）→ 待定；Lark 卡片 Markdown 里列表 / 引用中的嵌套围栏按普通文本保守转义（嵌套代码块里会显示实体，外观问题；要精确需按容器块解析）→ 待定 | 3.2–3.5、9 | 在 Slack / 飞书里对话、点卡片审批 |
| **M5 沙箱与技能**（已完成，计划 `2026-10-21-m5-sandbox-skills.md`，三段双副本验收 `packages/kernel/test/sandbox/m5-segment2.dual.test.ts`（真实 Docker）、`packages/kernel/test/skills/m5-segment3.dual.test.ts`；真实环境部分待凭据与 Linux / CI 主机（清单 `m5-live-acceptance-checklist.md`）；文档 `skills/writing-sandbox-providers`、`skills/writing-object-store-providers`） | **第一段**：`object-store@1`（单选、中转）、`plugins/object-store-s3`（S3 兼容，开发与测试用 SeaweedFS）、`ctx.storage`（按插件与组织加前缀，`perm-storage`）；附件（预签名 POST 直传、finalize 核对）与媒体输入（`model-provider@2` 内追加 `image` / `document` 块，`vision` / `documents` 把关，请求媒体预算、`media_excluded`）。**第二段**：`sandbox@1` 接口；`SandboxService`（每对话一个、懒创建、Redis 锁 + 防护号、空闲休眠 / 连续运行上限 / 不活跃销毁、透明恢复与重建）；Docker 实现（runc / runsc，经 HAProxy socket 代理，出站白名单代理按解析后的 IP 挡内网）与 E2B 实现；内置工具 `sandbox_bash` / `read` / `write` / `edit` / `glob` / `grep` / `deliver`、产物（`artifact_created`）与网页「产物」「沙箱」标签。**第三段**：技能格式（兼容 Anthropic Agent Skills）与组织技能库（zip 上传）；日志里的技能目录快照与 `skill_load`（脚本复制进沙箱 `/skills/<name>/`）；`skill_write`、共享 agent 的技能变更审批与收件箱汇总。（2026-10-21 记录）**推迟**：真实环境验收：E2B live（含 14 条假设）、Docker runsc、CI linux/amd64 上的 Docker 用例、ark 方言的图片映射 → 凭据 / 主机到位后按清单补跑；Docker 默认 local 卷驱动不限制 `diskMb`（要硬限制须换支持 `size` 的卷驱动或宿主机配额）→ 待定；`sandbox_deliver` 把文件整个读进内存（≤ `sandbox.deliverMaxBytes`，默认 100MB）且没有副本级并发上限 → 待 `sandbox@1` 加流式读原语；出站与资源限制的修改只对之后新建的沙箱生效（Ruling M16）→ 契约变更待定；技能新版本复制进沙箱时旧版本独有的文件留在 `/skills/<name>/`、只标为可忽略（Ruling M18）→ 待 `sandbox@1` 加删除原语；沙箱被重建后已加载的技能文件不自动补回（模型按提示再 `skill_load`）→ 待定；E2B 的出站白名单只看 Host / SNI、不核对目的 IP，并放行到 8.8.8.8 的 DNS（Ruling M14）→ 待定（可走 E2B 的 `network.egressProxy` 接自己的代理）；按组织调整 cpu / 内存 / 磁盘限制（目前只有部署级配置；组织级出站已在 M5 实现：组织设置 `sandboxEgress`，Ruling M19）→ M6 管理后台；技能市场（D11）→ M6；音频 / 视频作为模型输入（D9）→ 待定；`media_excluded` 的排除范围收窄（先排除最新一条消息的媒体，而不是整次请求的全部）→ 待定；socket 代理的请求体检查只是正则兜底，按 JSON 解析的自写代理 → 待定；换沙箱提供方会泄漏旧提供方的实例（记在 `prev_*`，旧插件仍加载时才清理）→ 待定；按（agent, 用户）的持久工作区、K8s 沙箱实现（D2 / D4）→ 待定。**接受的取舍**：技能目录的变化在下一次运行开始才到模型（Ruling M17）；副本崩溃后同一对话的下一次沙箱调用最多等锁 TTL 60 秒（Ruling M15）；对话删除后沙箱由每小时的扫描销毁（最多滞后 1 小时，Ruling M10）；技能 zip 处理每个请求约 150MB 内存、不限并发（只有管理员能调） | 3.6、5.6、8.3 | agent 在沙箱里跑技能脚本；共享 agent 改技能进入待审 |
| **M6 评测、后台与发布** | 轨迹记录与回放评测；轨迹查看器；管理后台（模型 / 插件 / 应用 / 技能 / 成员），含**插件安装确认页（权限清单）**、**用途 → 模型映射**、**部署级插件配置入 PG**（文件 / Nacos 中出现的字段只读）；企业目录；docker compose 全量编排（api / worker / gateway / web / 依赖服务）；`ctx.hooks`（hook 链，与 `usage.report` 计量一并开放）（2026-10-19 调整）；`gemini` 供应商插件；**默认镜像只带 `openai-compatible`**（`anthropic`、`openai` 等其余供应商插件按需安装，发行文档说明如何加装）；插件 SDK 公开 API 快照检查；CLA 机器人 | 6.8、7.1–7.2、8.4、13.5 | 完整验收场景 |

## 后续里程碑须知

- **扩展模型**（设计 `docs/superpowers/specs/2026-10-18-extension-model-design.md`，第 9 节为分期）：M4、M5、M6 的计划须按该文档展开对应任务。M4 的权限清单必须在 Slack / 飞书插件之前落地，并把 M3 的 `ctx.tools` 纳入声明；M6「SDK 公开 API 快照检查」之前清单格式须稳定。`ctx.models`、向量 / 重排不在 MVP（记忆、知识库不做），随第一个消费方排期。方舟方言（`openai-compatible` 加 `ark`）已排入 M4 完成（2026-10-19 调整）。
- **M6 编排 web 镜像**：web 必须经 `apps/web/server.mjs` 启动（`node server.mjs`，即 `pnpm --filter @capybara-hq/web start`）。它丢弃客户端伪造的转发头、把 `x-forwarded-for` 改写为真实对端地址再交给 `/api` 代理；Next 的 `output: "standalone"` 产物自带 `server.js`、不经过它，与此不兼容，镜像不能用 standalone 输出。web 后面的内核设 `http.trustProxy: 1`（只信任 web 这一跳），否则登录限流看到的是 web 主机地址。

## M0 锁定的技术选型

设计文档第 10 节留给实施计划的选择，在 M0 定下：

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | Node.js 24 LTS | 当前 LTS |
| 包管理与 monorepo | pnpm workspaces | 团队熟悉；不额外引入 Turborepo，等构建变慢再加 |
| HTTP | ~~Hono~~ → **NestJS + Fastify**（2026-10-17 改定，M1 第一个任务迁移） | 与团队技术栈一致；插件契约不暴露框架，M0 的 `ctx` / 插件宿主不受影响 |
| 前端 | **Next**（独立 web 服务） | 与团队技术栈一致；前后端分开发版 |
| 数据库访问 | Kysely + **纯 SQL 迁移文件** | 迁移是 SQL 文件才能被 13.3 的迁移检查静态审查；插件也用 SQL 迁移 |
| 校验 | Zod 4 | 配置 schema、插件清单 |
| Redis 客户端 / 队列 | ioredis / BullMQ | |
| 测试 | Vitest + Testcontainers（PG、Valkey） | 集成测试用真实依赖，不 mock 数据库 |
| lint / 格式化 | Biome | |
| 版本 | Changesets；提交信息 commitlint（Conventional Commits） | spec 13.3 |
| CI | GitHub Actions | spec 13.4 |

依赖一律安装当时的最新稳定版，以 lockfile 为准。
