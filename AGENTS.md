# AGENTS.md

Capybara：开源的企业级 Agent 平台（TypeScript、pnpm monorepo、Apache-2.0）。内核只做配置 / 数据库 / 插件宿主 / HTTP，能力全部以插件形式提供。

## 目录地图

| 路径 | 说明 |
|---|---|
| `packages/plugin-sdk` | 插件 SDK：只含类型与纯函数，不得 import 其他 `@capybara-hq/*` |
| `packages/kernel` | 内核：配置、db、`ctx`、插件宿主、HTTP |
| `packages/testing` | 测试容器与双副本工具 |
| `apps/capybara` | CLI |
| `plugins/*` | 官方插件 |
| `tools/*` | 仓库内部工具与自定义检查 |
| `docs/` | 设计文档与计划 |
| `skills/` | 面向 Agent 的技能（`.claude/skills` 软链到此处） |

（部分目录随后续里程碑逐步创建。）

## 三层与依赖方向

内核 / 插件 / 外部应用 三层，依赖只能自上而下：

- 外部应用 -> 内核 HTTP 接口，不 import 内核内部代码。
- 插件 -> 只能 import `@capybara-hq/plugin-sdk` 与第三方 npm 包，**不能** import `@capybara-hq/kernel`。
- 内核 -> 实现 SDK 中声明的接口。

包名一律 `@capybara-hq/<name>`。

## 多副本纪律（生产环境多副本部署）

- `ctx` 不提供定时器、不提供进程内共享对象；周期性与延迟任务走队列。
- `ctx.kv` 写入必须带 TTL。
- 写入方与读取方可能不在同一个请求 / 进程的状态，不得放进程内存（进程内 Map、定时器、本地事件等一律不行），用 Redis / PG。
- BullMQ 队列名与 job id 不得含 `:`。

## 规则速记

- 迁移：纯 SQL 文件，命名 `NNNN_<snake_desc>.sql`，建删对象必须带 `IF NOT EXISTS` / `IF EXISTS`；内核 schema 为 `capybara`，插件为 `plugin_<name>`（`-` 换 `_`）。详见 `skills/writing-migrations`（计划中，后续添加）。
- 配置：环境变量前缀 `CAPYBARA_`，嵌套用双下划线（`CAPYBARA_DB__URL` -> `db.url`），环境变量优先级最高；来源由 `CAPYBARA_CONFIG_SOURCE`（`file` / `nacos`）选择。详见 `skills/adding-config`（计划中，后续添加）。
- 国际化：给模型看的文案（提示词、工具描述、模型可见的错误）一律英文；界面文案走 i18n。
- 插件开发：详见 `skills/writing-plugins`（计划中，后续添加）。
- **能自动检查的规则以检查为准**：`pnpm check` 会逐步收录各项自定义检查，每道检查都有「违规 fixture 使其失败」的测试。

## 常用命令

```bash
pnpm install
pnpm lint        # biome check
pnpm typecheck   # tsc -b
pnpm test        # vitest run
pnpm check       # 自定义检查
docker compose -f docker/compose.dev.yaml up -d   # 本地 postgres + valkey
```

## 提交

Conventional Commits（commitlint 校验）；影响发布的改动附 changeset（`pnpm changeset`）。
