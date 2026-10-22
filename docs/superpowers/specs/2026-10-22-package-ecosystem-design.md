# 扩展包与市场设计（含 Claude Code 插件兼容）

- 日期：2026-10-22
- 状态：草案，待用户审阅（2026-10-22 用户选定：组织内应用原地升级纳入本期）
- 时机：**M7 合并之后**开工，暂称 M8。不插入、不改动 M6 / M7 的计划。
- 基线：
  - M6 计划 `docs/superpowers/plans/2026-10-22-m6-eval-admin.md` 的 C11 / C21–C32、D14、D16、D17：插件包、四种目录包、目录来源、应用包、组织安装与卸载；
  - M7 的 `ctx.hooks`、官方清单仓库上线；
  - M5 的技能（目录快照、`skill_load`、`/skills/<name>/`）。
- 开工前须对照 M6 / M7 合并后的实际代码修订本文（见第 10 节）。本文写的表名、接口名以 M6 计划为准，实现中可能有出入。

## 0. 背景

起因：想在 Capybara 里使用 [obra/superpowers](https://github.com/obra/superpowers)（MIT，一套给编码 agent 用的流程技能）。核对后发现：

- 它的每个技能都符合 Agent Skills 格式，M5 的技能机制能直接上传使用；
- 但它是以 **Claude Code 插件**的形式分发的：一个仓库就是一个市场（`.claude-plugin/marketplace.json`），插件清单是 `.claude-plugin/plugin.json`，再按约定目录放 `skills/`、`hooks/` 等；
- 它最关键的两样东西 Capybara 没有：一是会话开始时的强制注入（SessionStart hook 把 `using-superpowers` 全文塞进上下文），二是子 agent（`subagent-driven-development`、`dispatching-parallel-agents` 依赖它）；
- 同一个仓库里还并排放着 `.codex-plugin/`、`.cursor-plugin/` 等目录：各平台的插件清单各写一份，**所有平台共用的只有 `skills/`**。

用户的要求（2026-10-22）：

1. 兼容 Claude Code 插件格式；
2. 同时定义 Capybara 自己的 `.capybara-plugin/`；
3. 借鉴 Claude Code 的做法，**把一个仓库当作市场**；Capybara 官方提供一个市场；
4. 对已有的扩展能力做整体评估，**不重复造轮子**，形成一套完整的机制；
5. 名字可以改（`app.yaml` 改成 `plugin.yaml` 也行），由设计者定。

## 1. 目标、非目标、反目标

**目标**

- 一个组合包概念（「应用」），可以从三种形式读入：Capybara 原生 tgz、Capybara 原生仓库目录、Claude Code 插件目录。读入后走同一条审阅、目录、组织安装、卸载的流程。
- 一种市场概念（「目录来源」），可以是 https 上的一份清单文件（M6 已有），也可以是一个 git 仓库；仓库里的市场清单可以是 Capybara 格式或 Claude Code 格式。
- 官方市场改为仓库形式。
- 补上让 superpowers 这类包真正生效所需的运行时能力：常驻技能、限定名解析、工具名对照；子 agent 单独设计（第 7 节）。

**非目标**

- 不执行 Claude Code 的 hooks（shell 命令、http、prompt 等任何类型）。内核不在自己的主机上跑第三方命令。
- 不支持 stdio MCP（M6 C32 已接受）。
- 不支持 Claude Code 的 LSP、output styles、themes、monitors、`bin/`、`settings.json`、`userConfig`、channels 等与本地 IDE / 终端相关的部分。
- 不把 Claude Code「插件」翻译成 Capybara「插件」（进程内代码）。Claude 插件里没有可供 Capybara 加载的代码。
- 不做公共市场服务（hub）。市场就是仓库，和 D16 的思路一致。
- 本期不兼容 Codex、Cursor 等其他平台的清单。读取器按格式分开写，以后要加再加。
- 安装时不构建代码（D14 不变）。

**反目标**（技术上能跑通也算失败的情况）

- 出现两条并行的安装路径。例如 Claude 包绕过目录、审阅或卸载台账，或者原生仓库形式和 tgz 形式各有一套数据。
- 一个 Claude 包「安装成功」，但其中一部分悄悄没生效。凡是没翻译的东西，都必须在审阅页上逐项列出并说明原因。
- 内核因为市场仓库有新提交就悄悄拉取并启用新内容。C25 的「先浏览、引入时才物化、新版本须手动引入」继续适用。

## 2. 已有扩展机制盘点（以 M7 完成后为准）

| 机制 | 是什么 | 谁装 | 本设计怎么用 |
|---|---|---|---|
| 插件（D14） | 进程内运行的 npm 代码；npm-pack tgz，`package.json` 的 `capybara` 段；权限清单 | 企业管理员 | **不变**。应用可以引用插件，但只能引用已构建的产物（npm / 归档 + integrity） |
| 连接器插件 / 连接器模板（C30） | 协议适配（MCP、OpenAPI）/ 端点 + 认证预设，不含凭据 | 模板由企业管理员导入，连接器由组织安装 | **不变**。Claude 的 `.mcp.json` 远程服务翻译成连接器模板 |
| 技能（M5，C21） | Agent Skills 格式 | 组织管理员 / agent | **不变**，新增「常驻」与「来源应用」两项元数据（第 6 节） |
| 应用（C31） | 组合包 `app.yaml`：插件 + 连接器模板 + 技能 | 企业导入一次审阅，组织安装、卸载按组件台账 | **成为唯一的组合包**。新增仓库形式与 Claude 翻译两个读入口（第 3、5 节），补上组织内原地升级（第 6.5 节） |
| 目录与策略（C22、T23、T26） | 部署级条目、三档策略、成员申请 | 企业管理员 / 组织 | **不变**。新来源的条目落进同一张表 |
| 目录来源（D16、C25、C26、T24） | https 上的 `index.json`、ETag 刷新、按 sha512 引入 | 企业管理员 | 来源新增 **git 仓库**一种；清单格式升 v2（第 4 节），v1 照旧可读 |
| `ctx.hooks`（M7） | 进程内 JS 中间件链 | 随插件 | **不用于翻译 Claude hooks**。Claude 的 SessionStart 注入改由「常驻技能」承担 |
| agent 定义 | 指令、模型、工具、技能 | agent 负责人 | 新增 `skills.pinned`（第 6 节）；以后加子 agent 模板（第 7 节） |

**结论**：真正新增的只有这些——

- git 来源；
- 两个读取器：原生仓库形式、Claude 翻译；
- 市场清单 v2；
- 常驻技能、限定名、工具名对照；
- 子 agent（另起设计）。

其余全部复用。

## 3. 命名与格式

### 3.1 命名（设计者的决定）

- 仓库里的目录名遵循生态惯例，叫 **`.capybara-plugin/`**，和 `.claude-plugin/`、`.codex-plugin/` 并排放。多平台仓库的作者只需多加一个目录。
- 目录里有两个文件：
  - **`app.yaml`**：组合包清单，与 C31 的 tgz 根目录文件同名；
  - **`marketplace.yaml`**：市场清单。
- 产品内部概念**不改**：组合包在界面和文档里仍叫「应用」，「插件」仍只指进程内代码（D14、D17）。
- 不采用 `plugin.yaml` 的理由：在 Capybara 里，「插件」已经指进程内代码，用户可见的接口、权限、CLI 都这么叫。组合包的文件再叫 plugin，同一个词就会指两种东西。目录名里的 `plugin` 只是生态惯例，文档里说明一句即可。

### 3.2 应用清单 v2（`app.yaml`）

v2 是 C31 v1 的超集，tgz 形式与仓库形式共用同一个 schema 和解析器。

```yaml
schemaVersion: 2
name: superpowers                 # ^[a-z0-9][a-z0-9-]{0,63}$
version: 7.0.1                    # semver
publisher: Jesse Vincent
description: …                    # ≤ 1024
displayName: { zh: …, en: … }     # 可选
icon: ./assets/icon.svg           # 可选，包内路径
license: MIT                      # 可选，SPDX
homepage: https://…               # 可选
plugins:                          # 可选，同 v1：引用已构建的插件产物
  - { name: todo, npm: "@capybara-hq/plugin-todo", version: "^1", lock: { version: 1.2.0, integrity: "sha512-…" } }
connectorTemplates:               # 可选，同 v1；也可写成 connectors/*.yaml，每个文件一项
  - { id: docs, displayName: {…}, template: {…} }
skills:                           # 可选；省略时自动扫描 skills/*/SKILL.md
  - { path: ./skills/brainstorming }
  - { path: ./skills/using-superpowers, pinned: true }   # 新增：建议常驻（第 6 节）
agents: []                        # 预留：子 agent 模板（第 7 节），v2 先不接受非空值
```

- **仓库形式**：文件放在 `<包根>/.capybara-plugin/app.yaml`，其中的路径相对**包根**（不是相对 `.capybara-plugin/`）。路径必须以 `./` 开头，且不能越出包根。
- **tgz 形式**（C31）：`app.yaml` 放在包根，`package.json` 的 `capybara` 段不变。读取器接受 v1 与 v2。
- **v2 相对 v1 的变化**：
  - `skills` 可以省略（自动扫描）；
  - 新增 `pinned`、`license`、`homepage`、`agents`（预留）；
  - 连接器模板可以拆成多个文件。
- 同一个包根下同时有 `.capybara-plugin/app.yaml` 和 `.claude-plugin/plugin.json` 时，**以 Capybara 的为准**，Claude 清单不读，审阅页注明一句。作者写了原生清单，说明他明确要这样装。

## 4. 市场：目录来源扩展到 git 仓库

### 4.1 来源的两种形态

| 形态 | 地址 | 清单文件 | 刷新 |
|---|---|---|---|
| http（D16，已有） | https URL，可配镜像 | v1 `index.json` 或 v2 `marketplace.yaml` / `.json` | ETag，同 C26 |
| **git（新增）** | https git 地址；`owner/repo` 简写展开为 `https://github.com/owner/repo.git`；可选分支或标签（缺省为默认分支） | 仓库根目录下依次查找：`.capybara-plugin/marketplace.yaml` → `.claude-plugin/marketplace.json` → 单个包（见下） | 定期取分支最新提交；提交没变就跳过 |

- **单包仓库**：仓库根目录没有市场清单，但有 `.capybara-plugin/app.yaml`、`.claude-plugin/plugin.json`，或者有 `skills/` 目录，就当作只有一个条目的市场。企业管理员贴任何一个仓库地址都能用。
- git 来源的每次刷新都记下提交 sha。浏览和引入都基于这个 sha 读内容（C25：浏览只缓存清单，引入时才下载并物化）。
- **git 访问的约束**（具体实现方式由实现者定，可以用 git 客户端库，也可以用托管平台的归档接口）：
  - 只用 https，不跟随跨主机重定向；
  - 默认拒绝回环和私有地址，配置项与连接器、清单的 `allowInsecureLoopback` 同理；
  - 只取单个提交的浅克隆或归档，不拉子模块、不拉 LFS；
  - 有总大小、文件数、超时上限，沿用 `packages.maxBytes` 等配置；
  - 可选的访问令牌存 secrets，与 C26 企业清单的令牌相同。
- 离线部署：把仓库镜像到内部 GitLab，来源地址指向镜像即可。
- **指向其他仓库或主机的条目**（设计者的决定）：
  - 允许，Claude 市场普遍这样用；
  - 抓取时与来源本身遵守同样的约束（https、地址检查、大小上限）；
  - 审阅页与目录记录写明**实际的主机、仓库与提交 sha**；条目没有锁定 `commit` 时标注「跟随分支」；
  - 企业管理员可以配置可选的主机白名单 `catalogs.allowedHosts`，缺省不限制。配了白名单后，白名单外的条目在浏览时就显示为不可引入。
- **直接从 git 导入单个包**（设计者的决定）：与文件导入一样是一次性操作，不建来源行，不跟踪更新。目录条目记录来源 `git` 加上仓库、提交 sha 与路径，之后走同一套审阅和物化流程。需要跟踪更新时，把这个仓库加为来源。

### 4.2 市场清单 v2（`marketplace.yaml`）

```yaml
schemaVersion: 2
name: capybara-official
owner: { name: Capybara, url: https://… }
description: …
entries:
  - kind: app                       # app | skill | connector-template | plugin
    name: superpowers
    summary: { en: …, zh: … }
    version: 7.0.1                  # 可选；缺省取包内声明（第 4.4 节）
    minKernel: 1.0.0                # 可选
    permissions: { keys: [], sensitive: [] }   # 可选，只用于展示（同 C26）
    source:                         # 四选一
      path: ./apps/superpowers      # 同一仓库内，按本次刷新的提交读取
      # git: { url: https://github.com/obra/superpowers.git, ref: main, commit: <40 位>, path: . }
      # npm: { package: "@x/y", version: 1.2.0, integrity: "sha512-…" }
      # archive: { url: https://…/x.tgz, integrity: "sha512-…" 或 "sha256-…" }
```

- **代码插件**（`kind: plugin`）只能用 `npm` 或 `archive`，并且必须带 integrity。D14 规定安装时不构建，git 来源拿不到构建产物。
- `git` 源写了 `commit` 时按它取，否则按 `ref` 取当时的最新提交，并在条目上记下实际的 sha。
- v1 `index.json`（D16）继续可读，因为 M7 发布后会有外部部署在用。两个版本解析成同一个内部条目结构；v1 的「每个条目多个版本」照旧可用。
- JSON Schema 放 `packages/plugin-sdk/schemas/marketplace.v2.schema.json`，纳入 `check:package-schemas`（T24）。

### 4.3 官方市场

- 官方市场改为仓库形式：`capybara-hq/marketplace`。名字由 D16 的 `capybara-hq/catalog` 改来，M7 如果已经用了 catalog，就沿用它。
- 仓库里放 `.capybara-plugin/marketplace.yaml`：
  - 声明性的条目（技能、连接器模板、应用）直接放在仓库里；
  - 代码插件指向 npm，并带 integrity，由发布 CI 写入。
- 配置 `catalogs.official.*` 增加 `type: git | http`，默认值改为这个仓库；`enabled: false` 仍表示离线模式。
- 如果 M7 已经按 http `index.json` 上线了官方清单，可以过渡：仓库的 CI 同时生成 `index.json`，旧部署照旧可用。

### 4.4 版本与「有新版本」

- **条目版本**按这个顺序取：条目上写的 `version` → 包内清单声明的版本（`app.yaml` / `plugin.json` / `package.json`）→ 都没有时用 `0.0.0-git.<sha12>`（归档来源为 `0.0.0-sha256.<12>`）。
- **内容摘要**：引入时对规范化的文件树算 sha256（按路径排序，算路径和内容），连同来源的提交 sha 一起记进 `directory_item_versions`。
- **同版本内容变化**：仓库前进后，版本号没变但内容摘要变了，界面显示「同版本内容已变化」。企业管理员再引入时，版本记为 `<version>+git.<sha12>`（semver 构建元数据），不覆盖已引入的版本。
- 其余同 C25：只提示，不自动拉取。

## 5. Claude Code 插件翻译

### 5.1 原则

- 翻译发生在**引入时**（C25 的物化那一步），得到的是一份内存中的应用清单 v2 加一份**翻译报告**。之后完全走 C31 / T26 的应用流程。
- **白名单翻译**：只翻译下表列出的部分，其余全部列为「已忽略」，并写明原因。Claude Code 的格式在不断增加字段，对不认识的字段不报错，只列出来。
- 不修改技能文件的内容（不改写正文里的工具名、限定名等）。需要的适配放在运行时做（第 6 节）。这样内容摘要与上游一致，也便于审计。
- 格式依据：Claude Code 文档的 plugins manifest、marketplace、components、hooks、MCP 各页（2026-10-22 核对，见附录 A）。实现前须按当时的文档再核对一遍，并用 `claude plugin validate` 做对照测试。

### 5.2 包级字段

| Claude（`plugin.json`，可选文件） | 应用清单 v2 |
|---|---|
| `name`（必填） | `name`；不符合 `^[a-z0-9][a-z0-9-]{0,63}$` 时拒绝，并给出原因 |
| `version` | 合法 semver 时作为 `version`，否则按第 4.4 节的规则生成 |
| `description` / `displayName` | `description` / `displayName.en`（zh 留空） |
| `author.name` | `publisher`；没有时用市场的 `owner.name` |
| `license` / `homepage` / `repository` | 同名字段（`repository` 只展示） |
| 没有 `plugin.json` | 按默认目录布局读；名字取市场条目名，单包仓库则取仓库名 |
| 市场条目上的组件字段与 `strict` | 按 Claude 文档的合并规则处理：`strict: true` 时把条目上的字段追加到 `plugin.json`；`strict: false` 且两边都声明了组件时视为冲突，拒绝 |

### 5.3 组件

| Claude 组件 | 处理 | 报告里怎么写 |
|---|---|---|
| `skills/*/SKILL.md`，以及 `plugin.json` 里 `skills` 指定的路径；根目录单个 `SKILL.md` | **导入为技能**，校验沿用 M5（name 规则、XML 标签、大小）。frontmatter 的 `disable-model-invocation: true` 见下一行 | 已导入 N 个 |
| `disable-model-invocation: true` 的技能、`commands/` 下的命令 | **不导入**：它们要用户手动调用，Capybara 现在没有这个入口（第 8 节 D 期） | 「需要用户手动调用，暂不支持」 |
| `.mcp.json` / `mcpServers` 里 `http` / `streamable-http` 类型的服务 | **翻译为连接器模板**（`connector-mcp`）：`url` 进端点预设；`headers` 里的 `${VAR}` 变成认证预设中组织安装时要填的字段（`Authorization: Bearer ${X}` 对应 bearer）；`oauth` 对应 MCP OAuth；`url` 里含 `${VAR}` 时把 `url` 设为 `editableEndpoint`，并提示管理员补全 | 已翻译 / 需安装时补全 |
| `sse`（已废弃）、`ws`、`stdio`、`.mcpb` / `.dxt` 包 | 忽略（`sse` 是否支持以 `connector-mcp` 当时的能力为准） | 「不支持的传输方式」 |
| `agents/*.md` | A、B 期忽略；C 期翻译为子 agent 模板（第 7 节） | 「子 agent 暂不支持」 |
| `hooks/hooks.json` / `hooks` | **永不执行**。报告列出每个事件和处理器类型。只要出现 `SessionStart`，就提示管理员「这个包可能依赖会话开始时注入内容，请在下方把相应技能设为常驻」 | 「已忽略：hooks」+ 提示 |
| `dependencies`（依赖别的 Claude 插件） | 本期忽略 | 列出依赖名，提示可以另行引入 |
| `lspServers`、`outputStyles`、`themes`、`monitors`、`workflows`、`bin/`、`settings.json`、`userConfig`、`channels` 等 | 忽略 | 「不适用于 Capybara」 |
| 技能正文里的 `${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`、`${user_config.*}` | 不改写 | 警告「技能引用了 Claude Code 的变量，相关脚本可能无法运行」 |
| 技能 frontmatter 的 `context: fork`（要求作为子 agent 运行） | A、B 期**不导入**；C 期按子 agent 处理。当作普通技能导入会改变它的含义 | 「需要子 agent，暂不支持」 |
| 技能 frontmatter 的 `allowed-tools`、`disallowed-tools`、`model`、`effort` | 导入，但忽略这些键：Capybara 的工具权限由 agent 与策略决定，模型由 agent 决定 | 警告「已忽略的限制：…」 |
| 技能 frontmatter 的 `user-invocable: false` | 正常导入（它只是不给用户手动调用，模型照常可用） | — |

### 5.4 存什么、摘要算什么（设计者的决定）

- 目录条目版本保存**上游原始文件树**（字节不变），外加两样派生物：
  - 翻译生成的应用清单 v2；
  - 翻译报告。
- 组织安装时用保存的清单，不重新翻译。翻译器升级只影响之后引入的版本。
- **内容摘要**（第 4.4 节）只算上游原始文件树，所以「同版本内容已变化」只反映上游的变化，不会因为翻译器改了就误报。
- 管理员在审阅页做的选择（「建议常驻」）单独存为该版本的**审阅选择**：
  - 不进内容摘要；
  - 进 C31 的 `reviewHash`；
  - 引入同一条目的下一个版本时，作为默认值带过去（技能名还在的话）。
- 原生的仓库形式同样保存原始文件树，没有翻译报告。

### 5.5 审阅页

审阅页沿用 C31 的一次审阅，新增：

- **翻译报告**：已导入、已转换、需补全、已忽略、警告五组，每项写明原因。
- **常驻建议**：列出包里的技能，管理员可以勾选「建议常驻」，结果写进物化后清单的 `pinned`。如果包里有 SessionStart hook，这一栏默认展开。
- 许可证与来源：仓库地址、提交 sha、许可证名。LICENSE 文本随条目版本一起保存，可以展开查看。
- 技能正文可以逐个展开阅读。本期不承诺自动的提示词注入扫描，那是 §7.4 公共市场的事。

## 6. 运行时补齐（让翻译过来的技能能用）

### 6.1 常驻技能

替代 Claude Code 的 SessionStart 注入。这是 Capybara 原生的机制，原生包也可以用。

- **agent 定义**新增 `skills.pinned: string[]`，内容是技能 id，必须是这个 agent 已经选中的技能。负责人在 agent 编辑页设置。
  - 选中一个带「建议常驻」标记的技能时，界面默认帮他勾上「常驻」，他可以取消。
- **上限**（设计者的决定，实现时可以调整）：每个 agent 最多 3 个常驻技能，正文合计 ≤ 32 KB。超出时保存会被拒绝。
- **日志**：`skills_catalog` 快照事件新增 `pinned: [{ id, version, name, body }]`，正文写进日志。「模型看到的一切都进日志」，回放才能由日志还原。
- **渲染**：
  - system 缓存段在技能目录之后追加一段英文说明加上各个常驻技能的正文；
  - 对话已经发过请求之后，常驻集合才变化时，与现有的目录变更提醒一样，在当前位置追加一条 system 消息，已发送的前缀不变（与 `systemSkillsCatalog` / `skillsChangeText` 的规则一致）；
  - 压缩之后按 `skillsCurrentText` 的方式补上当前的常驻正文。
- 常驻技能仍可以用 `skill_load` 加载（用于把附带文件复制进沙箱）。

- **共享 agent**（设计者的决定）：改常驻列表是负责人编辑 agent 定义，与改选中的技能一样，会产生新的 agent 版本，不走 R3 / R4 的技能变更审批。R4 管的是 agent 自己用 `skill_write` 改技能内容，这一条不变。常驻技能有了新版本时，与现在的技能版本更新一样，各对话在下一次运行开始时生效。

### 6.2 技能的来源与同名冲突（设计者的决定）

M6 T26 的规则是：组织安装应用时，如果已有同名的组织技能，就给它加一个新版本。对来自外部来源的应用，这会让一个包悄悄覆盖组织自己的技能或另一个应用的技能；而常驻技能的正文会进每一次对话，风险最大。所以：

- 技能记录新增「来源」：`own`（组织自己上传或 agent 写的），或者 `app:<目录条目 id>`。
- 应用安装时遇到同名技能：
  - 来源是**同一个目录条目**：加新版本（重装、升级的情形）；
  - 来源不同：**安装失败**，返回 `app.skill_conflict`，列出冲突的名字，什么都不改。
  - 技能名在 `/skills/<name>/` 和按名加载里都必须唯一，所以不做按应用分命名空间的存储。冲突由组织先处理（删除或改名原有技能），之后再装。
- 这一条修改了 T26 对外部来源应用的行为。实现时，如果 M6 已经按「加新版本」上线，就把规则收紧，并为已有数据写迁移：已有的应用技能按 `app_install_components` 回填来源。

### 6.3 限定名解析

- 目录快照的每一项带上来源应用名 `app`（来源为 `app:<条目>` 时取该条目的名字，例如 `superpowers`）。
- `skill_load` 接受 `<app>:<name>`：前缀等于该技能的来源应用名时，按 `<name>` 解析；否则照旧返回「不在目录里」，并列出可用的名字。
- 目录里仍只显示不带前缀的名字。这一条让 superpowers 正文里 `superpowers:test-driven-development` 之类的引用能直接加载，不必改写文件内容。

### 6.4 工具名对照

- 技能记录新增「来源格式」（`capybara` / `claude-code`）。当目录快照里有来源格式为 `claude-code` 的技能时，快照带上一段英文的工具对照说明。
- 对照说明写进快照事件，不在渲染时现拼，所以以后改了对照文本也不影响回放。
- 对照内容（实现时按当时的内置工具核对）：
  - `Bash` → `sandbox_bash`；`Read` / `Write` / `Edit` / `Glob` / `Grep` → 对应的 `sandbox_*` 工具；
  - `Skill` → `skill_load`；
  - `TodoWrite` → `todo` 插件的工具（如果启用了）；
  - `AskUserQuestion` → `ask_user`；
  - `Task` / `Agent`（子 agent）→ C 期之后对应子 agent 工具；在那之前写明「当前不可用，请自己按顺序完成」；
  - 其余工具在 Capybara 里没有对应，写明「不可用」。
- 另外建议向 superpowers 上游提交一份 `references/capybara-tools.md`，它本身就有按平台的工具对照机制。这是对外协作，不是本设计的前提。

### 6.5 组织内应用原地升级（2026-10-22 用户选定）

M6 C31 不支持升级（先卸载再重装）。仓库市场会频繁产生新版本，所以本期补上原地升级，放在 A 期。

- **入口**：组织已装的应用，在目录里有更新的已引入版本时显示「可升级」。升级受该条目的策略约束，与安装相同：`needs_approval` 时走同样的申请审批，`disabled` 时不能升级。也允许「升级」到更旧的已引入版本，用作回退。
- **两步**：
  1. **预览**：内核比较当前版本与目标版本的应用清单，返回组件差异和需要填的输入；
  2. **确认**：组织管理员带上 `diffHash` 确认，不符时返回 409，与 `reviewHash` 同理。
- **按组件处理**：

| 组件 | 新增 | 变化 | 移除 |
|---|---|---|---|
| 插件 | 在本组织启用（须已装到部署，否则 `directory.not_deployed`） | 版本范围变化：部署上的版本须满足新范围，否则同上 | 按卸载规则：本次安装新建、且没有别处在用才停用，否则保留并说明原因 |
| 技能（按名字对应） | 新建，来源为本条目 | 加新版本（第 6.2 节「同一条目」的规则）；agent 的选中与常驻按 id 不变，各对话下一次运行时生效 | 按卸载规则：被 agent 选中的保留，并标注「已不在应用中」 |
| 连接器模板（按模板 id 对应） | 新建连接器，需要填凭据（预览里列出） | 用模板控制的字段（端点预设、认证预设、默认策略）更新已有连接器，凭据保留；认证方式或必填凭据变了，就要求重新填写（预览里列出）；工具定义照常走快照与漂移复核（§7.3） | 按卸载规则：被 agent 引用的保留 |

- **默认策略**：组织改过的工具策略（`policy_source` 不是 `template`）保持不变，只更新仍是模板默认值的那些。
- **失败回退**：任一步失败时，整个安装回到原版本，组件在功能上与升级前一致：
  - 本次新建的组件撤销；
  - 加了新版本的技能把当前版本指回原来的版本；
  - 被修改的连接器恢复原来的字段。

  `app_installs` 的状态与版本不变，错误只记步骤与错误码（同 T26）。
- **并发**：同一个安装同时只能有一个升级或卸载在进行，状态记为 `upgrading`，并加分布式锁。
- **审计**：`app.upgraded`，`detail` 包含 `from`、`to` 与组件差异。
- 回放不受影响：技能新版本、常驻正文都通过下一次运行开始时的目录快照进日志。

## 7. 子 agent（C 期，另起设计文档）

superpowers 的 `subagent-driven-development`、`dispatching-parallel-agents`、`requesting-code-review` 都依赖子 agent，Claude 插件的 `agents/` 也需要一个落点。这里只定方向和约束，细节另写一份设计：

- **形态**：内置工具（名字待定）。父 agent 用它发起一次子运行，参数是子 agent 模板（来自应用的 `agents`，或 agent 自己的定义）和任务说明；子运行的最终结果作为工具结果返回。
- **多副本**：子运行是独立的队列任务，父运行不能在进程里等它。父调用走与 `InputRequired` 类似的挂起、续跑机制：子运行结束后触发父运行继续。
- **日志**：子运行有自己的事件日志（子对话），父日志里只记派发事件和结果。轨迹查看器能从父对话跳到子对话。
- **权限只收不放**：子 agent 的工具是父 agent 工具的子集，策略不能比父 agent 宽；审批仍然交给发起对话的人。
- **限额**：派发深度为 1（子 agent 不能再派发）；每次父运行有并发上限和 token 上限，计入父对话的用量。
- **沙箱**：默认与父对话共用同一个沙箱，因为 superpowers 的工作流需要在同一份工作区里接力。是否支持隔离由那份设计文档决定。
- **翻译**：Claude 的 `agents/*.md`（`name`、`description`、`model`、`tools`、`skills`、`maxTurns` 等）翻译为子 agent 模板。`model` 按用途映射（扩展模型 §4.2），不写死模型 id。
- 应用清单 v2 的 `agents` 到那时才接受非空值。

## 8. 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| **A** | git 来源；市场清单 v2（读写 Capybara 格式）；应用清单 v2 与仓库形式；单包仓库；从 git 直接导入单个包；官方市场改为仓库形式；技能来源与同名冲突（第 6.2 节）；组织内应用原地升级（第 6.5 节） | M6 目录与来源、M7 官方清单 |
| **B** | Claude 读取器（`marketplace.json`、`plugin.json`、技能、`.mcp.json` 远程服务）；翻译报告与审阅页；常驻技能；限定名解析；工具名对照 | A |
| **C** | 子 agent（先写设计文档）；应用的 `agents`；Claude `agents/` 翻译 | B |
| **D**（可选） | 用户手动调用技能的入口（对话框里的 `/` 菜单）；之后再导入 `commands/` 与 `disable-model-invocation` 技能 | B |

**验收场景**：

- **A 期**：
  - 企业管理员把一个测试市场仓库加为来源，刷新后能看到条目；
  - 引入一个仓库内的应用（技能 + 连接器模板），以及一个 npm 插件条目（integrity 不符时被拒绝）；
  - 仓库前进后显示「同版本内容已变化」；
  - 引入新版本后，组织原地升级：
    - 技能加了新版本，agent 的选中与常驻不变；
    - 连接器凭据保留；
    - 被 agent 选中、而新版本里已移除的技能保留；
  - 在连接器那一步注入失败时，整个安装回到原版本；
  - 另一个应用带了同名技能时安装失败（`app.skill_conflict`）；
  - 双副本验收。
- **B 期**：
  - 把 `obra/superpowers` 加为来源，引入 superpowers，审阅页的翻译报告列出 hooks、命令等被忽略的部分；
  - 管理员勾选 `using-superpowers` 为常驻后，组织安装；
  - agent 选用这些技能，并把 `using-superpowers` 设为常驻；
  - 用户提一个新功能需求时，模型先 `skill_load` 了 `brainstorming`（用 `superpowers:brainstorming` 也能加载）；
  - 回放这次对话的请求与原始请求一致。
- **C 期**：superpowers 的 `subagent-driven-development` 在 Capybara 里跑通一个小计划。

每期按惯例写详细计划（writing-plans），由用户审阅后执行。

## 9. 风险与取舍

- **Claude Code 格式变化快**：用白名单翻译加「已忽略」报告来应对，格式变化最多导致新字段被忽略，不会导致装错。
- **跟踪分支的市场是「首次信任」**：git 来源跟踪分支时，内容由提交 sha 和内容摘要锁定，但第一次的内容是否可信，靠企业管理员在审阅时判断。这与 D16 只信清单 sha512 的强度不同，界面上注明来源类型。
- **Claude 市场的 npm 来源没有 integrity**：引入时记录 registry 给出的 integrity，并标注「来源未锁定内容」（设计者的决定）。之后同版本再拉取时，以记录的值为准。
- **常驻技能会占上下文**：用上限控制，并在 agent 编辑页显示常驻正文的 token 估算。
- **翻译过来的技能是写给编码 agent 的**：比如 git worktree、合并分支，在没有仓库的沙箱里意义不大。这是内容层面的问题，不是平台问题：审阅页如实展示，由组织决定给哪些 agent 用。

## 10. 开工前对照（M7 合并后）

- M6 的 `directory_items` / `directory_item_versions` / `catalog_sources` / `catalog_entries` / `app_installs` 的实际字段，以及 `parseCatalogIndex`、`AppManifest`、`AppImport`、`AppInstaller` 的实际接口。
- M7 的官方清单是否已经上线、用的是什么地址和格式（决定第 4.3 节的过渡方式）。
- `connector-mcp` 是否支持 SSE、OAuth 的具体形状（决定第 5.3 节）。
- 技能目录快照事件当时的结构，以及常驻正文加入后对缓存段的影响。
- 内置工具当时的名字（工具对照文本）。
- Claude Code 文档当时的字段（附录 A）。

## 附录 A：Claude Code 格式要点（2026-10-22 核对）

来源：code.claude.com 文档的 plugins manifest reference、marketplace reference、loading、components、hooks、MCP 各页。

- **`plugin.json`**：
  - 文件可选，只有 `name` 必填（kebab-case）；
  - 组件路径必须以 `./` 开头且不能越出插件根；`skills` 路径是追加到默认的 `skills/`，`commands` / `agents` 是替换默认目录，`hooks` / `mcpServers` 是合并；
  - 默认布局：`skills/<name>/SKILL.md`、`commands/`、`agents/`、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`output-styles/`、`bin/`、`settings.json`；根目录的单个 `SKILL.md` 当作一个技能。
- **`marketplace.json`**：
  - 必填 `name`、`owner.name`、`plugins`；条目必填 `name`、`source`；
  - `source` 的形式：相对路径、`github`（`repo` / `ref` / `sha`）、`url`（git，`ref` / `sha`）、`git-subdir`（`url` / `path` / `ref` / `sha`）、`npm`（`package` / `version` / `registry`）、`archive`（`url` / `sha256`）、`command`；`sha` 与 `ref` 同时出现时以 `sha` 为准；
  - `strict` 缺省为 true，含义是条目上的组件字段追加到 `plugin.json`；
  - 版本按这个顺序取：清单的 `version` → 条目的 `version` → 来源派生（git 用提交 sha 前 12 位，归档用 sha256）。
- **命名空间**：技能 `<plugin>:<name>`，命令 `<plugin>:<file>`，agent `<plugin>:<name>`。
- **命令**是旧格式，已被技能取代，两者的 frontmatter 相同。技能 frontmatter 有 `disable-model-invocation`、`user-invocable`、`allowed-tools`、`model`、`context` 等。
- **agents** 的 frontmatter：`name`、`description`、`model`、`tools`、`disallowedTools`、`skills`、`maxTurns`、`isolation` 等。
- **hooks**：`{"hooks": {"<事件>": [{"matcher", "hooks": [{"type": "command" | "http" | "mcp_tool" | "prompt" | "agent", …}]}]}}`，事件包括 SessionStart、PreToolUse、PostToolUse、Stop 等三十余种。
- **`.mcp.json`**：传输方式有 `stdio`、`http`（`streamable-http`）、`sse`（已废弃）、`ws`；`url` / `headers` 里可以写 `${VAR}` 与 `${VAR:-默认值}`。
