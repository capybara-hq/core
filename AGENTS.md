# AGENTS.md

Capybara：开源的企业级 Agent 平台（TypeScript、pnpm monorepo、Apache-2.0）。内核只做配置 / 数据库 / 插件宿主 / HTTP，能力全部以插件形式提供。

## 目录地图

| 路径 | 说明 |
|---|---|
| `packages/plugin-sdk` | 插件 SDK：只含类型与纯函数，不得 import 其他 `@capybara-hq/*` |
| `packages/kernel` | 内核：配置、db、`ctx`、插件宿主、HTTP |
| `packages/testing` | 测试容器与双副本工具 |
| `packages/design` | Web 设计系统：token、组件、页面模板（规格 `docs/design/spec.md`） |
| `apps/capybara` | CLI |
| `apps/web` | Next 网页（私有包，经 `/api/*` 代理调内核 HTTP；须经 `server.mjs` 启动），只用 `@capybara-hq/design` 搭页面 |
| `plugins/*` | 官方插件（`example-counter` 是参考实现） |
| `tools/*` | 仓库内部工具与自定义检查 |
| `tools/pack-plugin` | 插件打包工具（`pnpm pack-plugin` / `pack-plugins`，esbuild 打成 npm-pack tgz 并生成静态清单） |
| `docs/` | 设计文档与计划 |
| `skills/` | 面向 Agent 的技能（`.claude/skills` 软链到此处） |


## 三层与依赖方向

内核 / 插件 / 外部应用 三层，依赖只能自上而下：

- 外部应用 -> 内核 HTTP 接口，不 import 内核内部代码。
- 插件 -> 只能 import `@capybara-hq/plugin-sdk` 与第三方 npm 包，**不能** import `@capybara-hq/kernel`。
- 内核 -> 实现 SDK 中声明的接口。

完整的包依赖链（只允许这些方向）：

- `plugins/*` -> `@capybara-hq/plugin-sdk`（测试可额外用 devDependency `@capybara-hq/testing`）
- `@capybara-hq/kernel` -> `@capybara-hq/plugin-sdk`
- `@capybara-hq/testing` -> `@capybara-hq/kernel`（`@capybara-hq/plugin-sdk` 为 peerDependency）
- `@capybara-hq/capybara`（CLI，负责组装核心镜像）-> `@capybara-hq/kernel`、`@capybara-hq/plugin-openai-compatible`、`@capybara-hq/plugin-object-store-s3`（核心镜像只内置这两个插件，以 `builtinPlugins` 传给内核，来源 `builtin`；CLI 只按模块路径解析它们，不 import 其代码；其余插件按插件包装进插件目录）
- `@capybara-hq/design` 不依赖任何 `@capybara-hq/*`
- `@capybara-hq/web` 只依赖 `@capybara-hq/design`，不依赖内核等其他包，只经 HTTP 调内核（属于「外部应用」层）
- `tools/checks` -> `@capybara-hq/kernel`（devDependency，读配置 schema 生成文档、校验插件包）；`tools/checks` -> `@capybara-hq/design`（devDependency，仅测试用，核对模板清单）；`tools/checks` -> `@capybara-hq/pack-plugin`、`@capybara-hq/plugin-sdk`（devDependency，`check:plugin-pack` 打包官方插件）
- `@capybara-hq/pack-plugin`（`tools/pack-plugin`，私有）-> `@capybara-hq/plugin-sdk`（测试另用 devDependency `@capybara-hq/kernel` 校验产物）
- `@capybara-hq/plugin-sdk` 不依赖任何 `@capybara-hq/*`

内核、CLI 与插件的测试把 `@capybara-hq/testing` 作为 devDependency，只在测试里用。`pnpm check:deps` 只检查插件与 SDK 的边界；内核、CLI、web 的依赖方向暂无自动检查，靠评审。

包名一律 `@capybara-hq/<name>`。

## 多副本纪律（生产环境多副本部署）

- `ctx` 不提供定时器、不提供进程内共享对象；周期性与延迟任务走队列。
- `ctx.kv` 写入必须带 TTL。
- 写入方与读取方可能不在同一个请求 / 进程的状态，不得放进程内存（进程内 Map、定时器、本地事件等一律不行），用 Redis / PG。
- BullMQ 队列名与 job id 不得含 `:`。

## 规则速记

- 迁移：纯 SQL 文件，命名 `NNNN_<snake_desc>.sql`，建删对象必须带 `IF NOT EXISTS` / `IF EXISTS`；内核 schema 为 `capybara`，插件为 `plugin_<name>`（`-` 换 `_`）。详见 [skills/writing-migrations](skills/writing-migrations/SKILL.md)。
- 配置：环境变量前缀 `CAPYBARA_`，嵌套用双下划线（`CAPYBARA_DB__URL` -> `db.url`），环境变量优先级最高；来源由 `CAPYBARA_CONFIG_SOURCE`（`file` / `nacos`）选择。详见 [skills/adding-config](skills/adding-config/SKILL.md)。插件部署配置另可由企业管理员在后台存 PG（优先级 环境变量 > 文件 / Nacos > PG > 默认值，启动配置里有的字段只读；不合法 = 插件待配置，不让内核启动失败），见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)「两级配置」。
- 国际化：给模型看的文案（提示词、工具描述、模型可见的错误）一律英文；界面文案走 i18n。
- 界面：页面 = 模板 + design 组件，apps/web 不写样式（无 className / style / .css / 颜色字面量），详见 [skills/writing-web-ui](skills/writing-web-ui/SKILL.md)；规则由 `pnpm check:web-ui` 检查。
- 插件开发：详见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)，参考实现 `plugins/example-counter`。插件包 = npm-pack tgz（`pnpm pack-plugin` / `pack-plugins`，单文件 ESM、只有 SDK 与 zod 由宿主提供、动态 import 只许字面量），校验见 `packages/kernel/src/plugins/package.ts`。
- 内核 HTTP 用 NestJS + Fastify：领域类不依赖 Nest，构造参数显式 `@Inject`；插件不依赖 Nest。详见 [skills/writing-kernel-api](skills/writing-kernel-api/SKILL.md)。
- 运行时：会话事件日志是唯一事实源，模型看到的一切都进日志（任一次模型请求都能由日志加 agent 版本还原），发给模型的历史只追加。代码在 `packages/kernel/src/runtime`。
- 模型供应商插件（含媒体块 image / document：能力声明把关、上限与占位都在内核，插件收不到 `ref`）：详见 [skills/writing-model-providers](skills/writing-model-providers/SKILL.md)。
- 工具（`ctx.tools`、描述与错误文案、默认策略、输出存档、`tool_search`、漂移复核；内置的 `sandbox_*` 与技能工具 `skill_load` / `skill_write`，key 不含点，`skill_write` 对共享 agent 固定确认，私有 agent 默认不确认、可设 `skills.writePolicy: "ask"`）：详见 [skills/writing-tools](skills/writing-tools/SKILL.md)，参考实现 `plugins/todo`。
- 沙箱（`sandbox@1`：中止要杀命令、确定不在才抛 `SandboxGoneError`、已停止的自动启动、沙箱内也有命令时限、`killAll`、同名替换、`/skills` 只读、出站 `open` 须 `allowOpenEgress`；锁、休眠、销毁由内核 `SandboxService` 负责；socket 代理绝不发布到宿主机地址）：详见 [skills/writing-sandbox-providers](skills/writing-sandbox-providers/SKILL.md)，参考实现 `plugins/sandbox-docker`、`plugins/sandbox-e2b`。
- 对象存储（`object-store@1` / `ctx.storage`：键前缀 `plugins/<插件>/<orgId>/` 与 `kernel/<orgId>/` 由内核加，预签名上传的大小必须由存储端拒绝，键不能含 `${`，用了 `ctx.storage` 须声明 `permissions.storage`）：详见 [skills/writing-object-store-providers](skills/writing-object-store-providers/SKILL.md)，参考实现 `plugins/object-store-s3`。
- 连接器（远端服务实例，旧称「应用」；协议由提供 `connector@1` 的**连接器插件**实现，如 MCP / OpenAPI；不支持 stdio MCP）：详见 [skills/writing-connectors](skills/writing-connectors/SKILL.md)，参考实现 `plugins/connector-mcp`、`plugins/connector-openapi`。
- 渠道、第三方登录、通讯录（`channel@1` / `identity-source@1` / `directory@1`：身份键 `<插件>:<租户>`、onEvent 后才确认、卡片规范、防 @所有人、长连接与选主由内核负责）：详见 [skills/writing-channels](skills/writing-channels/SKILL.md)，参考实现 `plugins/slack`、`plugins/lark`。
- 插件界面（`ctx.ui`：对话页右侧标签与「扩展」页面；渲染 schema 视图不卡加载，嵌入应用要批准、是敏感项，令牌只认本插件、`/api` 不认）：详见 [skills/writing-plugin-ui](skills/writing-plugin-ui/SKILL.md)，参考实现 `plugins/todo`（视图）、`plugins/example-board`（嵌入应用）。
- 评测与回放（轨迹、评测集、单步 / 整轮回放、评委）：事件日志是唯一事实源，改请求构建（`runtime/context/build.ts`、`model-call.ts`）前后都要跑零漂移夹具测试，新的模型可见输入必须进日志并加 `DriftReason`；整轮回放只用记录的工具结果、从不执行工具；评测走队列 `cap-kernel-evals`，组织并发与 token 上限。详见 [skills/replay-evals](skills/replay-evals/SKILL.md)。
- 插件包与生命周期：插件包 = npm-pack tgz，安装 / 启用 / 停用 / 升级 / 卸载都不重启（PG 期望状态 + 各副本 reconcile，按实例记账撤销、可选 `dispose` 与 `ctx.signal`、在途调用排空 `pluginHost.drainSeconds`）；插件迁移只做扩展；插件进程内全权运行，权限审批是治理不是沙箱。详见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)。
- 企业目录与目录来源：目录条目四种（插件 / 连接器模板 / 技能 / 应用），策略 允许 / 需审批 / 禁用；来源 = 官方清单、企业清单、手动上传；清单与应用清单的 JSON Schema 在 `packages/plugin-sdk/schemas/`（`pnpm gen:package-schemas` 生成，`check:package-schemas` 防漂移），下载一律按清单（或应用 lock）的 sha512 校验，不认 npm 元数据。
- 应用包（`app.yaml`：插件按 npm 名 + 范围 + lock 引用、内联连接器模板、技能打在包里；组织安装只撤 / 只删本次新建且别处不在用的组件；M6 不支持升级）与连接器模板：详见 [skills/writing-apps](skills/writing-apps/SKILL.md)。
- **能自动检查的规则以检查为准**：`pnpm check` 会逐步收录各项自定义检查，每道检查都有「违规 fixture 使其失败」的测试。

## 常用命令

```bash
pnpm install
pnpm lint        # biome check
pnpm typecheck   # tsc -b
pnpm test        # vitest run
pnpm exec vitest run <路径>   # 单个测试：从仓库根跑（根配置带 @capybara-hq/source 条件，双副本测试需要）；别用 pnpm --filter <包> exec vitest
pnpm check       # 自定义检查
docker compose -f docker/compose.dev.yaml up -d   # 本地 postgres + valkey
```

## 提交

Conventional Commits（commitlint 校验）；影响发布的改动附 changeset（`pnpm changeset`）。
