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
| **M2 Agent 运行时** | Agent 定义与版本；会话事件日志；BullMQ 运行链路；LangGraph 默认 loop；流式广播；插话；中止；崩溃续跑；上下文压缩；`anthropic` 与 `openai` 供应商插件 + 一致性测试；最小网页聊天（Next web 服务的第一个页面） | 4、6.1–6.2 | 网页里和 agent 多轮对话，杀掉 worker 后自动续跑 |
| **M3 工具与连接器** | 工具运行时与执行管线；工具策略与审批（含三种审批范围、失败即拒绝）；MCP（远程）与 OpenAPI 连接器；认证适配与凭据；`tool_search`；工具定义漂移检测；任务清单工具；工具设计规范检查（描述非空、错误带修正方式） | 5、6.3–6.7、7.3 | agent 调 MCP / OpenAPI 应用，写操作触发审批 |
| **M4 渠道与生态插件** | `channel@1` / `identity-source@1` / `directory@1` 接口；Slack 插件（登录 + 通讯录 + bot，Socket Mode 选主）；飞书插件（同上，长连接）；审批卡片；渠道身份映射 | 3.2–3.5、9 | 在 Slack / 飞书里对话、点卡片审批 |
| **M5 沙箱与技能** | `sandbox@1` 接口；Docker 实现（runc / runsc，经 socket 代理）；懒创建与文件系统级休眠；技能格式、`skill_load`；agent 自写技能与 R1–R6 | 3.6、5.6、8.3 | agent 在沙箱里跑技能脚本；共享 agent 改技能进入待审 |
| **M6 评测、后台与发布** | 轨迹记录与回放评测；轨迹查看器；管理后台（模型 / 插件 / 应用 / 技能 / 成员）；企业目录；docker compose 全量编排（api / worker / gateway / web / 依赖服务）；`gemini` 供应商插件；插件 SDK 公开 API 快照检查；CLA 机器人 | 6.8、7.1–7.2、8.4、13.5 | 完整验收场景 |

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
