# 插件、扩展与市场设计（术语重构、仓库即市场、Claude Code 插件兼容）

- 日期：2026-10-22
- 状态：草案，待用户审阅（第二轮审阅问题已处理）
- 时机：**M7 合并之后**开工，暂称 M8。不插入、不改动 M6 / M7 的计划；术语重构也在 M7 之后做（2026-10-22 用户决定），对已发布的名字留兼容期。
- 基线：
  - M6 计划 `docs/superpowers/plans/2026-10-22-m6-eval-admin.md` 的 C11 / C21–C32、D13–D17：插件包、目录包、目录来源、应用包、组织安装与卸载；
  - M7 的 `ctx.hooks`、官方清单、发布；
  - M5 的技能：目录快照、`skill_load`、`/skills/<name>/`。
- 开工前须对照 M6 / M7 合并后的实际代码修订本文（见第 15 节）。文中的表名、接口名以 M6 计划为准，实现中可能有出入。

## 0. 背景

起因：想在 Capybara 里使用 [obra/superpowers](https://github.com/obra/superpowers)（MIT，一套给编码 agent 用的流程技能）。核对后发现：

- 它的每个技能都符合 Agent Skills 格式，M5 的技能机制能直接上传使用；
- 但它是以 **Claude Code 插件**的形式分发的：一个仓库就是一个市场（`.claude-plugin/marketplace.json`），插件清单是 `.claude-plugin/plugin.json`，再按约定目录放 `skills/`、`agents/`、`hooks/`、`.mcp.json` 等；
- 它最依赖的两样东西 Capybara 没有：
  - 对话开始时的强制注入：SessionStart hook 把 `using-superpowers` 全文塞进上下文；
  - 子 agent：`subagent-driven-development`、`dispatching-parallel-agents` 依赖它。
- 同一个仓库里还并排放着 `.codex-plugin/`、`.cursor-plugin/` 等目录：各平台的插件清单各写一份，**所有平台共用的只有 `skills/`**。
- 在生态里，「插件」指的是组合包。而 Capybara 至今把进程内代码叫插件，把组合包叫「应用」，两边的叫法对不上。

用户的要求与决定（2026-10-22）：

1. 兼容 Claude Code 插件格式，同时定义 Capybara 自己的 `.capybara-plugin/`；
2. 借鉴 Claude Code，**把一个仓库当作市场**；Capybara 官方提供一个市场；
3. 对已有的扩展机制做整体评估，**不重复造轮子**，形成一套完整的机制；
4. 文件一律用 JSON，不用 YAML；
5. 官方维护一个仓库 **`capybara-hq/plugins`**：
   - 官方扩展的源码都移出 core，放进这个仓库；
   - 市场清单也放在这个仓库，所有内置组件都在其中声明；
   - 由 GitHub Actions 发布到 npm。
   
   仓库名和市场名无关，「能当市场」只是仓库多放了一份清单；
6. core 带一份初始化 JSON，声明默认安装哪些组件、哪个版本，部署初始化时按它安装核心依赖；
7. **术语重构**：
   - 「插件」改指组合包（技能 + agent + hooks + MCP + 扩展 + …）；
   - 原来的插件（进程内代码）改叫「扩展」；
   - 「能力」改叫「扩展点」，只指带版本的契约；
   - `ctx.*` 改叫「平台接口」；
   - 改名在 M7 之后做；
8. 组织内已安装的插件支持原地升级。

## 1. 术语

### 1.1 新旧对照

| 新术语 | 英文 | 含义 | 原来叫 |
|---|---|---|---|
| **插件** | plugin | 安装和分发的单位，等同于 Claude Code 的插件。清单 `.capybara-plugin/plugin.json`。可以包含下面的组件，可以依赖别的插件 | 应用（D17 的组合包） |
| **扩展** | extension | 插件里进程内运行的代码：`ctx`、权限清单、审批、实现和使用扩展点。一个插件最多含一个扩展 | 插件（D14） |
| **扩展点** | extension point | 平台定义的、带主版本号的契约，如 `channel@1`。扩展**实现**它（`provides`）或**使用**它（`requires` / `optional`） | 能力（capability） |
| **注册项** | registration | 扩展经平台接口注册的东西：工具、hook、HTTP 路由、界面、数据表。没有版本号，在权限清单里声明 | — |
| **平台接口** | platform API | `ctx.db`、`ctx.kv`、`ctx.storage`、`ctx.models` 等 | 平台能力 |
| 技能 | skill | 不变 | |
| 连接器模板 | connector template | 端点 + 认证预设。对应 Claude 插件里的远程 MCP | 不变（C30） |
| 连接器 | connector | 组织里配置好的远端服务实例 | 不变（D17） |
| agent 模板 | agent template | 插件里的 agent 定义，用于子 agent（第 11 节） | — |
| **市场** | marketplace | 一份市场清单，列出可引入的插件和取得方式。可以放在 git 仓库或 https 上 | 目录来源（`catalog_sources`） |
| **企业目录** | catalog | 部署内已引入、可供组织安装的插件 | 企业目录（英文标识符原为 `directory`） |
| 预装插件 | bootstrap plugin | core 初始化清单声明、部署初始化时安装的插件 | 内置插件（D13） |
| 对话 / 会话 | conversation / session | 「对话」专指和 agent 的交流；「会话」只指登录会话 | 界面上两者混用 |
| 外部应用 | external app | 架构三层里经 HTTP 调内核的第三方系统。「应用」只剩这一个含义 | 「应用」原有三种含义 |
| 嵌入页面 | embed | 扩展提供的 iframe 界面 | 嵌入应用 |

- 英文 `directory` 留给通讯录扩展点 `directory@1`，企业目录改用 `catalog`。原来的 `catalog_sources` / `catalog_entries` 改名为市场。
- 模型的 `capabilities.vision` / `documents` 等是模型自身的特性，不受「能力」改名影响。

### 1.2 现有扩展点（M6 登记表 `CAPABILITIES`，改名后为 `EXTENSION_POINTS`）

| 扩展点 | 用途 | 数量 | 取用方式 | 按组织启用 |
|---|---|---|---|---|
| `model-provider@2` | 模型供应商 | 多个 | 中转 | 否 |
| `connector@1` | 连接器协议（MCP、OpenAPI） | 多个 | 中转 | 否 |
| `channel@1` | IM 渠道 | 多个 | 直通 | 是 |
| `identity-source@1` | 第三方登录 | 多个 | 直通 | 否（部署级） |
| `directory@1` | 通讯录同步 | 多个 | 直通 | 是 |
| `sandbox@1` | 沙箱 | 单个 | 中转 | 否 |
| `object-store@1` | 对象存储 | 单个 | 中转 | 否 |
| `secret-store@1` | 密钥存储 | 单个 | 中转 | 否 |
| `config-source@1` | 启动配置来源 | 单个 | 直通 | 否 |
| `counter@1` | 测试示例 | 多个 | 直通 | 否 |

- 预留：`embedding-provider@1`、`rerank-provider@1`。
- 「中转」指只能经平台接口使用，拿不到实现本身；「直通」指可以经 `ctx.capabilities`（改名后为 `ctx.extensionPoints`）直接取用。
- 注册项（工具、hook 挂载点、路由、界面、数据表）不是扩展点。

## 2. 目标、非目标、反目标

**目标**

- **只有一种安装单位：插件。** 插件可以从三种形式读入：
  - tgz（npm 或归档）；
  - 仓库目录（`.capybara-plugin/`）；
  - Claude Code 插件目录（翻译）。

  读入后走同一条引入、审阅、企业目录、组织安装、升级、卸载的流程。
- **只有一种来源：市场。** 市场可以是 https 上的一份清单，也可以是一个 git 仓库；仓库里的市场清单可以是 Capybara 格式或 Claude Code 格式。
- **两个仓库**：core 只留平台本身；官方插件全部在 `capybara-hq/plugins`，同时也是官方市场。
- **初始化**：core 按初始化清单预装核心插件。
- **运行时补齐**：补上让 superpowers 这类插件真正生效所需的能力，即常驻技能、限定名解析、工具名对照；子 agent 单独设计（第 11 节）。
- **术语重构**：在 M7 之后完成，对已发布的名字留兼容期。

**非目标**

- 不执行 Claude Code 的 hooks（shell 命令、http、prompt 等任何类型）。内核不在自己的主机上跑第三方命令。Capybara 的 hook 只能由扩展经 `ctx.hooks` 提供。
- 不支持 stdio MCP（M6 C32 已接受）。
- 不支持 Claude Code 的 LSP、output styles、themes、monitors、`bin/`、`settings.json`、`userConfig`、channels 等与本地 IDE / 终端相关的部分。
- 不做公共市场服务（hub）。市场就是仓库，和 D16 的思路一致。
- 本期不兼容 Codex、Cursor 等其他平台的清单。读取器按格式分开写，以后要加再加。
- 安装时不构建代码（D14 不变）。

**反目标**（技术上能跑通也算失败的情况）

- 出现两条并行的安装路径。例如 Claude 插件绕过审阅或卸载台账，或者仓库形式和 tgz 形式各有一套数据。
- 一个 Claude 插件「安装成功」，但其中一部分悄悄没生效。凡是没翻译的东西，都必须在审阅页上逐项列出并说明原因。
- 内核因为市场仓库有新提交就悄悄拉取并启用新内容。C25 的「先浏览、引入时才物化、新版本须手动引入」继续适用。
- 术语重构让已经部署的系统或第三方扩展在升级后无法工作。

## 3. 已有机制怎样并入（以 M7 完成后为准）

| 现有机制 | 并入后 |
|---|---|
| 插件包（D14：npm-pack tgz，`package.json` 的 `capybara` 段，单文件 ESM，权限清单） | 成为插件里的**扩展组件**；打包规则、权限清单、审批、无重启生命周期（D15）不变。旧格式的 tgz 读作「只含扩展的插件」 |
| 连接器模板包、技能包（C21） | 读作「只含一个组件的插件」 |
| 应用包（C31 `app.yaml`） | 读作「插件 + 依赖」：清单里引用的插件变成插件依赖，模板、技能变成组件 |
| 企业目录（`directory_items`，四种 kind，三档策略，成员申请） | 改名为 `catalog_items`，kind 只剩 plugin；策略、申请、审批不变 |
| 目录来源（D16 `catalog_sources`、`index.json`） | 改名为市场；新增 git 形态与清单 v2；v1 照旧可读 |
| 组织安装应用（T26 `app_installs` 与组件台账） | 成为**组织安装插件**的唯一流程；组件台账照旧；补上原地升级（第 10 节） |
| 内置插件（D13） | 改为预装插件，由初始化清单声明（第 7 节） |
| `ctx.hooks`（M7） | 不变，属于扩展的注册项；不用于翻译 Claude hooks |
| agent 定义 | 新增 `skills.pinned`（第 9 节），以后加子 agent 模板（第 11 节） |

**真正新增的只有这些**：

- 统一的插件清单；
- git 形态的市场；
- Claude 读取器；
- 常驻技能、限定名、工具名对照；
- 组织内原地升级；
- 初始化清单；
- 子 agent（另起设计）。

其余都是复用和改名。

## 4. 插件格式

### 4.1 布局与清单

插件是一个目录（仓库形式），或者是这个目录打成的 tgz（npm / 归档形式）：

```
<插件根>/
  .capybara-plugin/plugin.json    插件清单（可选，见下）
  skills/<name>/SKILL.md          技能（缺省自动扫描）
  connectors/<id>.json            连接器模板（缺省自动扫描）
  agents/<name>.json              agent 模板（预留，第 11 节）
  extension/                      扩展：构建好的单文件 ESM、迁移、界面静态文件
  package.json                    发到 npm 时需要；name / version 与清单一致
```

`plugin.json`（JSON Schema 为 `packages/plugin-sdk/schemas/plugin.v1.schema.json`，可以写 `$schema`）：

```jsonc
{
  "schemaVersion": 1,
  "name": "superpowers",                                // ^[a-z0-9][a-z0-9-]{0,63}$
  "version": "7.0.1",                                   // semver
  "publisher": "Jesse Vincent",
  "description": "…",                                   // ≤ 1024
  "displayName": { "zh": "…", "en": "…" },              // 可选
  "icon": "./assets/icon.svg",                          // 可选
  "license": "MIT",                                     // 可选，SPDX
  "homepage": "https://…",                              // 可选
  "dependencies": [                                     // 可选：依赖的插件
    { "name": "todo", "version": "^1" }
  ],
  "skills": [                                           // 可选；省略时自动扫描 skills/*/SKILL.md
    { "path": "./skills/using-superpowers", "pinned": true }   // pinned：建议常驻（第 9.1 节）
  ],
  "connectorTemplates": [ ],                            // 可选；省略时自动扫描 connectors/*.json，每项同 C30
  "agents": [],                                         // 预留，非空时拒绝，直到第 11 节落地
  "extension": {                                        // 可选：有扩展时由打包工具生成，不手写
    "entry": "./extension/index.mjs",
    "manifest": { },                                    // 静态扩展清单，同 D14 的 StaticPluginManifest
    "migrations": "./extension/migrations",
    "ui": "./extension/ui"
  }
}
```

（注释只是说明，真实文件是严格的 JSON。）

- **清单可选**：没有 `plugin.json` 时，按默认布局读取，名字取市场条目名（单包仓库取仓库名），版本按第 5.4 节的规则生成。这和 Claude Code 一致。只含技能的插件可以什么都不写。
- **路径**：清单里的路径相对插件根，必须以 `./` 开头，不能越出插件根。
- **依赖**：
  - 只写插件名和 semver 范围；
  - 解析时在企业目录里找已引入、满足范围的版本，审阅页列出解析结果；
  - 找不到时，企业导入照样可以完成，但组织安装会被拒绝，并提示要先引入哪个插件；
  - 不再像 C31 那样在清单里锁 integrity，因为依赖的每个插件在引入时都已按自己的来源校验过。（设计者的决定）
- **扩展**：
  - D14 的打包工具（`pack-plugin`，改名后为 `pack-extension` 或并入新的打包命令）构建 `extension/index.mjs`，并把静态扩展清单写进 `plugin.json` 的 `extension.manifest`；
  - 加载时照旧核对静态清单和模块导出的清单是否一致；
  - 一个插件最多一个扩展。
- **从 git 读取的插件**：如果含扩展，仓库里必须有构建好的 `extension/index.mjs`（像 GitHub Actions 那样把产物提交进仓库），否则拒绝，并说明「插件含扩展但没有构建产物」。
- **同时有 `.capybara-plugin/` 和 `.claude-plugin/` 时**，以 Capybara 的为准，审阅页注明一句。

### 4.2 旧格式的读取（M7 已发布的格式）

| 旧格式 | 读作 |
|---|---|
| D14 插件 tgz（`package.json` 的 `capybara.kind = "plugin"`） | 只含扩展的插件 |
| C21 技能包 / 连接器模板包 | 只含一个组件的插件 |
| C31 应用包（`app.yaml` 或 `app.json`） | 插件：引用的插件变成 `dependencies`（lock 信息只用于展示），模板和技能变成组件 |
| D16 `index.json` | 市场清单 v1 |

旧格式只读，新包、文档、官方仓库一律用新格式。

### 4.3 审阅与权限

- 引入插件时只有一次审阅（沿用 C31 的一次审阅与 `reviewHash`）：
  - 扩展的权限清单（敏感项高亮）；
  - 技能正文（可以逐个展开）；
  - 连接器模板的端点与认证要求；
  - 依赖的解析结果；
  - 来源（主机、仓库、提交 sha 或 integrity）；
  - 许可证；
  - Claude 插件另有翻译报告（第 8.4 节）。
- **权限审批针对扩展**：只含声明性组件的插件不需要批准权限，只审阅内容。
- 扩展升级时权限变多，照 D15 / §7.3 的规则需要重新批准。

## 5. 市场

### 5.1 两种形态

| 形态 | 地址 | 清单文件 | 刷新 |
|---|---|---|---|
| http（D16，已有） | https URL，可配镜像 | v1 `index.json` 或 v2 `marketplace.json` | ETag，同 C26 |
| **git（新增）** | https git 地址；`owner/repo` 简写展开为 `https://github.com/owner/repo.git`；可选分支或标签，缺省为默认分支 | 仓库根目录下依次查找：`.capybara-plugin/marketplace.json` → `.claude-plugin/marketplace.json` → 单个插件（见下） | 定期取分支最新提交；提交没变就跳过 |

- **单包仓库**：仓库根目录没有市场清单，但是一个插件（有 `.capybara-plugin/plugin.json`、`.claude-plugin/plugin.json`，或者有 `skills/` 目录），就当作只有一个条目的市场。企业管理员贴任何一个仓库地址都能用。
- 每次刷新都记下提交 sha，浏览和引入都基于这个 sha（C25：浏览只缓存清单，引入时才下载并物化）。
- **git 访问的约束**（实现方式由实现者定，可以用 git 客户端库，也可以用托管平台的归档接口）：
  - 只用 https，不跟随跨主机重定向；
  - 默认拒绝回环和私有地址，配置项与连接器、清单的 `allowInsecureLoopback` 同理；
  - 只取单个提交的浅克隆或归档，不拉子模块、不拉 LFS；
  - 有总大小、文件数、超时上限，沿用 `packages.maxBytes` 等配置；
  - 可选的访问令牌存 secrets，与 C26 的企业清单令牌相同。
- **离线部署**：把仓库镜像到内部 GitLab，来源地址指向镜像即可。
- **指向其他仓库或主机的条目**（设计者的决定）：
  - 允许，Claude 市场普遍这样用；
  - 抓取时遵守同样的约束；
  - 审阅页与企业目录记录写明**实际的主机、仓库与提交 sha**，没有锁定 `commit` 时标注「跟随分支」；
  - 企业管理员可以配置可选的主机白名单 `marketplaces.allowedHosts`，缺省不限制。配了以后，白名单外的条目显示为不可引入。
- **直接从 git 导入单个插件**（设计者的决定）：与文件导入一样是一次性操作，不建市场，不跟踪更新。企业目录记下仓库、提交 sha 与路径，之后走同一套审阅和物化流程。需要跟踪更新时，把这个仓库加为市场。

### 5.2 市场清单 v2（`marketplace.json`）

```jsonc
{
  "schemaVersion": 2,
  "name": "capybara-official",                          // 市场名，界面显示用，与仓库名无关
  "owner": { "name": "Capybara", "url": "https://…" },
  "description": "…",
  "plugins": [
    {
      "name": "superpowers",
      "summary": { "en": "…", "zh": "…" },
      "version": "7.0.1",                               // 可选；缺省取插件内声明（第 5.4 节）
      "minKernel": "1.0.0",                             // 可选
      "permissions": { "keys": [], "sensitive": [] },   // 可选，只用于展示（同 C26）
      "source": { "path": "./plugins/superpowers" }     // 四选一，见下
    }
  ]
}
```

条目列表叫 `plugins`，和 Claude 的 `marketplace.json` 一致。`source` 四选一：

| 形式 | 写法 | 说明 |
|---|---|---|
| 同仓库路径 | `{ "path": "./plugins/x" }` | 按本次刷新的提交读取 |
| git | `{ "git": { "url": "https://…", "ref": "main", "commit": "<40 位>", "path": "." } }` | `ref`、`commit`、`path` 可选；写了 `commit` 就按它取，否则取 `ref` 当时的最新提交并记下 sha |
| npm | `{ "npm": { "package": "@x/y", "version": "1.2.0", "integrity": "sha512-…" } }` | |
| 归档 | `{ "archive": { "url": "https://…/x.tgz", "integrity": "sha512-… 或 sha256-…" } }` | |

- **来源不限插件内容**：任何来源都可以，只要取到的内容是合法插件。含扩展的插件必须带构建产物，见第 4.1 节。
- v1 `index.json`（D16）继续可读，解析成同一个内部结构；v1 的「每个条目多个版本」照旧可用。
- JSON Schema：`packages/plugin-sdk/schemas/marketplace.v2.schema.json`，纳入 `check:package-schemas`（T24）。

### 5.3 版本与「有新版本」

- **条目版本**与 Claude Code 的顺序一致（设计者的决定），Capybara 格式与 Claude 格式都这样取：插件清单（`plugin.json` / `package.json`）→ 市场条目上写的 `version` → 都没有时用 `0.0.0-git.<sha12>`（归档来源为 `0.0.0-sha256.<12>`）。
- **新旧比较**：按 semver 比较，忽略构建元数据；只差构建元数据（如 `1.0.0` 与 `1.0.0+git.abc`）的两个版本，以引入企业目录的先后为新旧。版本范围匹配也忽略构建元数据。
- **内容摘要**：引入时对规范化的文件树算 sha256（按路径排序，算路径和内容），连同来源的提交 sha 或 integrity 一起记进企业目录的版本记录。
- **同版本内容变化**：仓库前进后，版本号没变但内容摘要变了，界面显示「同版本内容已变化」。企业管理员再引入时，版本记为 `<version>+git.<sha12>`（semver 构建元数据），不覆盖已引入的版本。
- 其余同 C25：只提示，不自动拉取。

### 5.4 存什么（设计者的决定）

- 企业目录的每个版本保存**上游原始文件树**（字节不变），外加：
  - 规范化后的插件清单（原生插件即为原清单，Claude 插件为翻译结果）；
  - 翻译报告（只有 Claude 插件有）。
- 组织安装时用保存的清单，不重新翻译。翻译器升级只影响之后引入的版本。
- 内容摘要只算原始文件树，所以翻译器改了不会误报「内容已变化」。
- 管理员在审阅页做的选择（如「建议常驻」）存为该版本的**审阅选择**：
  - 不进内容摘要，进 `reviewHash`；
  - 引入同一插件的下一个版本时，作为默认值带过去。

## 6. 仓库与发布

### 6.1 两个仓库

| 仓库 | 放什么 | 发布 |
|---|---|---|
| `capybara-hq/core`（现在这个） | `plugin-sdk`、内核、`testing`、`design`、CLI、web、检查与打包工具、`bootstrap.json`；只为测试服务的假扩展（如 `model-fake`） | SDK、testing、打包与检查工具发到 npm；内核与 web 打成镜像 |
| **`capybara-hq/plugins`** | 全部官方插件的源码（含扩展的和纯声明性的），以及 `.capybara-plugin/marketplace.json` | 含扩展的插件由 GitHub Actions 构建、带 provenance 发到 npm；纯声明性插件直接从仓库读取 |

- **从 core 移出的**：
  - 模型供应商（`anthropic`、`openai`、`openai-compatible`，M7 的 `gemini`）；
  - 渠道（`slack`、`lark`）；
  - 连接器协议（`connector-mcp`、`connector-openapi`）；
  - 沙箱（`sandbox-docker`、`sandbox-e2b`）；
  - 对象存储（`object-store-s3`）；
  - `todo`；
  - 参考实现 `example-counter`、`example-board` 跟着搬走，在插件仓库里当范例。（设计者的决定）
- **市场名与仓库名无关**：清单里的 `name` 是 `capybara-official`，界面显示为「Capybara 官方」。
- **发布流程**：
  1. 插件改动合并到 `plugins` 仓库的 main；
  2. CI 对改动的插件运行检查（`check:plugin-permissions`、打包校验、双副本测试）；
  3. CI 打包、发到 npm；
  4. 机器人在同一仓库提交，把新版本和 integrity 写回 `marketplace.json`。

  纯声明性插件不发 npm，`marketplace.json` 直接用同仓库路径。
- **core 要提供给插件仓库的**：
  - 已发布的 `plugin-sdk`、`testing`（双副本工具、假平台）；
  - 打包与检查工具（以 npm 包或 CLI 的形式）；
  - M7 的「SDK 公开 API 快照检查」变得更关键：插件仓库依赖的是已发布的 SDK 版本。
- **跨仓库的代价**：改扩展点契约时，要在两个仓库分别提 PR。缓解办法：
  - `plugins` 仓库的 CI 每晚拿 core 的 main 构建一次，跑全部插件的测试；
  - core 的 CI 拿 `bootstrap.json` 锁定的预装插件做冒烟测试。
- 开发模式（D15）：core 本地开发时，可以配置额外的插件工作区目录（例如指向本地 clone 的 `plugins` 仓库），直接加载源码。具体由实现者定。

### 6.2 core 仓库自身的规则变化

- `AGENTS.md` 的目录地图与依赖方向更新：`plugins/*` 不再在 core 里；`check:deps` 的插件边界检查改为对插件仓库生效，由打包与检查工具提供。
- `skills/writing-plugins` 等面向扩展作者的技能，搬到 `plugins` 仓库，或者随 SDK 一起发布。core 只保留和内核开发相关的部分。

## 7. 预装插件与初始化清单

core 带一份初始化清单，声明默认装哪些插件、哪个版本。部署初始化时按它安装核心依赖，这是部署初始化的必经一步。它替代 D13 的「镜像内置插件」。

**`packages/kernel/bootstrap.json`**（随 core 发版，打进镜像）：

```jsonc
{
  "schemaVersion": 1,
  "marketplace": {                                       // 对应的官方市场提交，用于核对
    "url": "https://github.com/capybara-hq/plugins.git",
    "commit": "<40 位>"
  },
  "plugins": [
    { "name": "openai-compatible", "version": "1.4.0", "integrity": "sha512-…", "required": true },
    { "name": "object-store-s3",   "version": "1.1.0", "integrity": "sha512-…", "required": true }
  ]
}
```

- **字段**（设计者的决定）：
  - `required: true` 表示核心依赖：
    - 装到部署，并在**所有组织**（现有的和以后新建的）自动启用，与 C14 的内置插件相同；
    - 部署和组织两级都不能停用或卸载，只能由企业管理员升级。
  - `required: false` 表示默认装到部署并引入企业目录，组织照常自己选择安装；企业管理员之后可以移除。
- **纯声明性插件也可以预装**：发版时把它打成 tgz，和含扩展的插件一样打进镜像；清单项用内容摘要（第 5.3 节）核对，不用 npm integrity。
- **与官方市场一致**：每一项都必须出现在 `marketplace.commit` 那一版的官方市场里，版本一致；含扩展的插件 integrity 一致，纯声明性插件内容摘要一致。
  - core 的发版 CI 增加检查 `check:bootstrap`，需要网络，只在发版流水线里跑；
  - 检查要有违规 fixture 使其失败的测试。
- **离线可用**：构建镜像时从 npm 取这些 tgz 打进镜像。初始化时从镜像取，按 integrity 校验，**不联网**。

**初始化步骤**：

- 由 `capybara init` 执行（也可以合进 `capybara migrate`，由实现者定）。内核启动时如果发现还没初始化，也会自动执行一次。
- 幂等，并持有 PG 咨询锁，多副本同时启动时只有一个副本真正执行。
- 按清单逐项引入企业目录，并把含扩展的插件装到部署：
  - 权限快照来源记为 `bootstrap`，预先批准，并写审计；
  - 结果与从市场引入的记录完全同形，来源标为 `bootstrap`。
- 之后这些插件与其他插件**同样管理**：在官方市场里看得到、可以升级。

**core 升级时**（新的 `bootstrap.json` 调高了某个插件的版本）：

- 已装版本低于清单版本，且安装来源是 `bootstrap`（管理员没有手动升到更高版本）时，初始化步骤把它升到清单版本。core 发版已经为这个版本背书，所以权限变多也预先批准，并写审计。（设计者的决定）
- 已装版本高于清单版本时不动，**不降级**。
- 清单新增的插件照常安装；清单删掉的插件不自动卸载，只失去 `required` 标记。

## 8. Claude Code 插件翻译

### 8.1 原则

- 两边结构几乎一一对应：Claude 插件 → Capybara 插件，逐个组件转换。
- 翻译发生在**引入时**（物化那一步），得到规范化的插件清单和翻译报告，之后走同一条流程。
- **白名单翻译**：只翻译下表列出的部分，其余全部列为「已忽略」，并写明原因。Claude Code 的格式在不断增加字段，不认识的字段不报错，只列出来。
- 不修改技能文件的内容（不改写正文里的工具名、限定名等）。需要的适配放在运行时做（第 9 节）。
- 格式依据见附录 A（2026-10-22 核对）。实现前须按当时的文档再核对一遍，并用 `claude plugin validate` 做对照测试。

### 8.2 插件级字段

| Claude（`plugin.json`，可选文件） | Capybara 插件清单 |
|---|---|
| `name`（必填） | `name`；不符合 `^[a-z0-9][a-z0-9-]{0,63}$` 时拒绝，并给出原因 |
| `version` | 合法 semver 时照用，否则按第 5.3 节的规则生成 |
| `description` / `displayName` | `description` / `displayName.en`（zh 留空） |
| `author.name` | `publisher`；没有时用市场的 `owner.name` |
| `license` / `homepage` / `repository` | 同名字段（`repository` 只展示） |
| `dependencies` | `dependencies`：依赖的插件需要另行引入，审阅页提示 |
| 没有 `plugin.json` | 按默认目录布局读；名字取市场条目名，单包仓库取仓库名 |
| 市场条目上的组件字段与 `strict` | 按 Claude 文档的合并规则：`strict: true` 时把条目上的字段追加到 `plugin.json`；`strict: false` 且两边都声明了组件时视为冲突，拒绝 |

### 8.3 组件

| Claude 组件 | 处理 | 报告 |
|---|---|---|
| `skills/*/SKILL.md`、`plugin.json` 里 `skills` 指定的路径、根目录单个 `SKILL.md` | **导入为技能**，校验沿用 M5（name 规则、XML 标签、大小） | 已导入 N 个 |
| `disable-model-invocation: true` 的技能、`commands/` 下的命令 | **不导入**：它们要用户手动调用，Capybara 现在没有这个入口（第 12 节 D 期） | 「需要用户手动调用，暂不支持」 |
| 技能 frontmatter 的 `context: fork`（要求作为子 agent 运行） | A、B 期不导入，C 期按子 agent 处理。当作普通技能导入会改变它的含义 | 「需要子 agent，暂不支持」 |
| 技能 frontmatter 的 `allowed-tools`、`disallowed-tools`、`model`、`effort` | 导入，但忽略这些键：工具权限由 agent 与策略决定，模型由 agent 决定 | 警告「已忽略的限制：…」 |
| 技能 frontmatter 的 `user-invocable: false` | 正常导入 | — |
| `.mcp.json` / `mcpServers` 里 `http` / `streamable-http` 类型的服务 | **翻译为连接器模板**（`connector-mcp`）：`url` 进端点预设；`headers` 里的 `${VAR}` 变成组织安装时要填的认证字段（`Authorization: Bearer ${X}` 对应 bearer）；`oauth` 对应 MCP OAuth；`url` 含 `${VAR}` 时把 `url` 设为可编辑，并提示安装时补全 | 已翻译 / 需安装时补全 |
| `sse`（已废弃）、`ws`、`stdio`、`.mcpb` / `.dxt` 包 | 忽略（`sse` 以 `connector-mcp` 当时是否支持为准） | 「不支持的传输方式」 |
| `agents/*.md` | A、B 期忽略；C 期翻译为 agent 模板（第 11 节） | 「子 agent 暂不支持」 |
| `hooks/hooks.json` / `hooks` | **永不执行**。报告列出每个事件和处理器类型。出现 `SessionStart` 时提示「这个插件可能依赖对话开始时注入内容，请在下方把相应技能设为常驻」 | 「已忽略：hooks」+ 提示 |
| `lspServers`、`outputStyles`、`themes`、`monitors`、`workflows`、`bin/`、`settings.json`、`userConfig`、`channels` 等 | 忽略 | 「不适用于 Capybara」 |
| 技能正文里的 `${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}`、`${user_config.*}` | 不改写 | 警告「技能引用了 Claude Code 的变量，相关脚本可能无法运行」 |

Claude 插件里没有可供 Capybara 加载的代码，所以翻译结果**不含扩展**，不需要批准权限。

### 8.4 审阅页的翻译报告

- 分已导入、已转换、需补全、已忽略、警告五组，每项写明原因。
- **常驻建议**：列出插件里的技能，管理员可以勾选「建议常驻」。插件里有 SessionStart hook 时，这一栏默认展开。
- 许可证与来源：仓库地址、提交 sha、许可证名；LICENSE 文本随版本保存，可以展开查看。
- 本期不承诺自动的提示词注入扫描，那是 §7.4 公共市场的事。

## 9. 运行时补齐

### 9.1 常驻技能

替代 Claude Code 的 SessionStart 注入。这是 Capybara 原生的机制，原生插件也可以用。

- **agent 定义**新增 `skills.pinned: string[]`，内容是技能 id，必须是这个 agent 已经选中的技能。负责人在 agent 编辑页设置。
  - 选中一个带「建议常驻」标记的技能时，界面默认勾上「常驻」，负责人可以取消。
- **上限**（设计者的决定，实现时可以调整）：每个 agent 最多 3 个常驻技能，正文合计 ≤ 32 KB；超出时保存会被拒绝。agent 编辑页显示常驻正文的 token 估算。
- **日志**：`skills_catalog` 快照事件新增 `pinned: [{ id, version, name, body }]`，正文写进日志，回放才能由日志还原。
- **渲染**：
  - system 缓存段在技能目录之后追加一段英文说明，加上各个常驻技能的正文；
  - 对话已经发过请求之后，常驻集合或某个常驻技能的**正文**变了（加入、移除、出了新版本），与现有的目录变更提醒一样，在当前位置追加一条 system 消息，已发送的前缀不变（设计者的决定）：
    - 新加入或新版本的，消息里带完整正文，并写明「替代之前的版本」；
    - 移除的，只写名字；
    - 历史只追加，不改写已发送的前缀。代价是上下文会增长，由常驻上限和压缩兜住：压缩之后只保留当前版本；
  - 压缩之后按 `skillsCurrentText` 的方式补上当前的常驻正文。
- 常驻技能仍可以用 `skill_load` 加载（用于把附带文件复制进沙箱）。
- **共享 agent**（设计者的决定）：改常驻列表是负责人编辑 agent 定义，会产生新的 agent 版本，不走 R3 / R4 的技能变更审批。R4 管的是 agent 自己用 `skill_write` 改技能内容。常驻技能出了新版本时，各对话在下一次运行开始时生效。

### 9.2 技能的来源与同名冲突（设计者的决定）

M6 T26 的规则是：组织安装应用时，如果已有同名的组织技能，就给它加一个新版本。对外部来源的插件，这会让一个插件悄悄覆盖组织自己的技能或另一个插件的技能；而常驻技能的正文会进每一次对话，风险最大。所以：

- 技能记录新增「来源」：`own`（组织自己上传或 agent 写的），或者 `plugin:<企业目录条目 id>`。
- 安装插件时遇到同名技能：
  - 来源是**同一个插件**：加新版本（重装、升级的情形）；
  - 来源不同：**安装失败**，返回 `plugin.skill_conflict`，列出冲突的名字，什么都不改。
- 技能名在 `/skills/<name>/` 和按名加载里都必须唯一，所以不按插件分命名空间存储。冲突由组织先处理（删除或改名原有技能），之后再装。
- 这一条收紧了 T26 的行为。已有数据按组件台账回填来源。

### 9.3 限定名解析

- 目录快照的每一项带上来源插件名 `plugin`（来源为 `plugin:<条目>` 时取该插件的名字，例如 `superpowers`）。
- `skill_load` 接受 `<plugin>:<name>`：前缀等于该技能的来源插件名时，按 `<name>` 解析；否则照旧返回「不在目录里」，并列出可用的名字。
- 目录里仍只显示不带前缀的名字。superpowers 正文里 `superpowers:test-driven-development` 之类的引用因此可以直接加载，Claude Code 自己也是这个命名空间写法。

### 9.4 工具名对照

- 技能记录新增「来源格式」（`capybara` / `claude-code`）。目录快照里有来源格式为 `claude-code` 的技能时，快照带上一段英文的工具对照说明。
- 对照说明写进快照事件，不在渲染时现拼，所以以后改了对照文本也不影响回放。
- 对照内容（实现时按当时的内置工具核对）：
  - `Bash` → `sandbox_bash`；`Read` / `Write` / `Edit` / `Glob` / `Grep` → 对应的 `sandbox_*` 工具；
  - `Skill` → `skill_load`；
  - `TodoWrite` → `todo` 插件的工具（如果启用了）；
  - `AskUserQuestion` → `ask_user`；
  - `Task` / `Agent`（子 agent）→ C 期之后对应子 agent 工具，在那之前写明「当前不可用，请自己按顺序完成」；
  - 其余写明「不可用」。
- 另外建议向 superpowers 上游提交一份 `references/capybara-tools.md`，它本身有按平台的工具对照机制。这是对外协作，不是本设计的前提。

## 10. 组织内插件的安装、升级与卸载

**安装与卸载**：沿用 T26 应用安装的流程与组件台账，对象从「应用」变成「插件」。插件的依赖先于插件本身安装，依赖记为组件，卸载规则不变：

- 只移除本次新建、且没有别处在用的组件；
- 保留的组件在报告里写明原因。

**依赖的目录策略**（设计者的决定）：

- 审批由被安装的插件的策略决定，与 C22 的应用规则相同。一次安装只走一次申请审批，依赖不再单独审批。
- 例外：依赖的企业目录条目被设为 `disabled` 时，安装被拒绝，并提示是哪个依赖。「禁用」是企业管理员的明确禁止，不应被绕过。

**版本归属**（2026-10-22 用户选定）：

- **含扩展的插件跟随部署版本**：
  - 扩展是进程内代码，整个部署同一时间只跑一个版本（D15）。企业管理员在部署上升级插件（并按需重新批准权限）后，扩展立即对所有组织生效；
  - 各组织的声明性组件（技能、连接器、依赖）仍停在原版本，界面提示「部署已升级到 vX，请升级本组织的插件」，组织管理员确认后按下面的原地升级更新这些组件；
  - 组织只能升级到部署上当前的版本，不能自己回退；
  - 安装记录分别记下组织的版本与部署的版本，两者不同时显示为「待升级」；
  - 扩展的作者要容忍声明性组件暂时落后一个版本，这与 D15 滚动升级时新旧副本混跑的要求同理，写进扩展作者指南。
- **纯声明性插件**（只有技能、连接器模板等）：各组织自由选择企业目录里已引入的任何版本，也可以回退。

**原地升级**（2026-10-22 用户选定）：

- **入口**：组织已装的插件，在企业目录里有更新的已引入版本时显示「可升级」。
  - 升级受该条目的策略约束，与安装相同：`needs_approval` 时走申请审批，`disabled` 时不能升级；
  - 纯声明性插件也允许「升级」到更旧的已引入版本，用作回退；含扩展的插件的目标版本只能是部署上当前的版本。
- **两步**：
  1. 预览：内核比较当前版本与目标版本的插件清单，返回组件差异和需要填的输入；
  2. 确认：组织管理员带上 `diffHash` 确认，不符时返回 409。
- **按组件处理**：

| 组件 | 新增 | 变化 | 移除 |
|---|---|---|---|
| 扩展 | 在本组织启用（扩展须已装到部署，否则 `catalog.not_deployed`） | 部署上已经是目标版本（见上方「版本归属」），组织侧无事可做 | 按卸载规则：本次安装启用的、且没有别处在用才停用 |
| 依赖插件 | 按安装流程装上 | 新范围须能在企业目录里解析到，否则失败 | 按卸载规则 |
| 技能（按名字对应） | 新建，来源为本插件 | 加新版本；agent 的选中与常驻按 id 不变，各对话下一次运行时生效 | 被 agent 选中的保留，并标注「已不在插件中」 |
| 连接器模板（按 id 对应） | 新建连接器，需要填凭据（预览里列出） | 用模板控制的字段（端点预设、认证预设、默认策略）更新已有连接器，凭据保留；认证方式或必填凭据变了才要求重填；工具定义照常走快照与漂移复核（§7.3） | 被 agent 引用的保留 |

- **默认策略**：组织改过的工具策略（`policy_source` 不是 `template`）保持不变，只更新仍是模板默认值的那些。
- **失败回退**：任一步失败时，组织的声明性组件回到原版本，在功能上与升级前一致（扩展属于部署，不在回退范围内）：
  - 本次新建的组件撤销；
  - 加了新版本的技能把当前版本指回原来的版本；
  - 被修改的连接器恢复原来的字段。

  安装记录的状态与版本不变，错误只记步骤与错误码。
- **并发**：同一个安装同时只能有一个升级或卸载在进行（状态 `upgrading`，加分布式锁）。
- **审计**：`plugin.upgraded`，`detail` 包含 `from`、`to` 与组件差异。

## 11. 子 agent（C 期，另起设计文档）

superpowers 的 `subagent-driven-development`、`dispatching-parallel-agents`、`requesting-code-review` 都依赖子 agent，Claude 插件的 `agents/` 也需要一个落点。这里只定方向和约束：

- **形态**：内置工具（名字待定）。父 agent 用它发起一次子运行，参数是 agent 模板（来自插件的 `agents`，或 agent 自己的定义）和任务说明；子运行的最终结果作为工具结果返回。
- **多副本**：子运行是独立的队列任务，父运行不能在进程里等它。父调用走与 `InputRequired` 类似的挂起、续跑机制：子运行结束后触发父运行继续。
- **日志**：子运行有自己的事件日志（子对话），父日志里只记派发事件和结果。轨迹查看器能从父对话跳到子对话。
- **权限只收不放**：子 agent 的工具是父 agent 工具的子集，策略不能比父 agent 宽；审批仍交给发起对话的人。
- **限额**：派发深度为 1；每次父运行有并发上限和 token 上限，计入父对话的用量。
- **沙箱**：默认与父对话共用同一个沙箱，因为 superpowers 的工作流需要在同一份工作区里接力。是否支持隔离由那份设计决定。
- **翻译**：Claude 的 `agents/*.md`（`name`、`description`、`model`、`tools`、`skills`、`maxTurns` 等）翻译为 agent 模板；`model` 按用途映射（扩展模型 §4.2），不写死模型 id。
- 插件清单的 `agents` 到那时才接受非空值。

## 12. 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| **0 术语与格式** | 第 13 节的改名与兼容层；插件清单 v1（`plugin.json`）与旧格式读取；企业目录只剩插件一种 kind；组织安装从「应用」切到「插件」；更新总设计、扩展模型设计、AGENTS.md 与各技能指南里的术语 | M7 |
| **A 仓库与市场** | git 形态的市场；市场清单 v2；单包仓库；从 git 直接导入；建立 `capybara-hq/plugins`，把官方插件移出 core，GitHub Actions 发 npm 并写回清单；初始化清单与预装插件；技能来源与同名冲突；组织内原地升级 | 0 |
| **B Claude 兼容** | Claude 读取器（`marketplace.json`、`plugin.json`、技能、`.mcp.json` 远程服务）；翻译报告与审阅页；常驻技能；限定名解析；工具名对照 | A |
| **C 子 agent** | 先写设计文档；插件的 `agents`；Claude `agents/` 翻译 | B |
| **D（可选）** | 用户手动调用技能的入口（对话框里的 `/` 菜单）；之后再导入 `commands/` 与 `disable-model-invocation` 技能 | B |

**验收场景**：

- **0 期**：
  - M7 发布版本装好的部署（含第三方扩展、旧格式的应用与技能包）升级到新版本后，全部照常工作；
  - 用 `definePlugin` 写的第三方扩展无须修改就能加载；
  - 旧格式的 tgz 仍能引入；
  - 回放 M7 时期的对话，请求与原始请求一致。
- **A 期**：
  - 企业管理员把一个测试市场仓库加为市场，刷新后能看到插件；
  - 引入一个纯声明性插件（技能 + 连接器模板），以及一个含扩展的 npm 插件（integrity 不符时被拒绝）；
  - 仓库前进后显示「同版本内容已变化」；
  - 组织原地升级：技能加新版本，agent 的选中与常驻不变；连接器凭据保留；被 agent 选中、而新版本里已移除的技能保留；
  - 在连接器那一步注入失败时，整个安装回到原版本；
  - 另一个插件带了同名技能时安装失败；
  - 断网的全新部署执行初始化后，预装插件已安装、批准、可用，并在官方市场里显示「已安装」；两个副本同时启动时只执行一次；
  - 换上调高了预装版本的 core 后再初始化，预装插件升到新版本；管理员已经手动升得更高的不动；
  - core 仓库里已经没有 `plugins/*`，官方插件全部从 `capybara-hq/plugins` 经 npm 安装；
  - 双副本验收。
- **B 期**：
  - 把 `obra/superpowers` 加为市场，引入 superpowers，翻译报告列出 hooks、命令等被忽略的部分；
  - 管理员勾选 `using-superpowers` 为常驻后，组织安装；agent 选用这些技能，并把 `using-superpowers` 设为常驻；
  - 用户提一个新功能需求时，模型先加载了 `brainstorming`（用 `superpowers:brainstorming` 也能加载）；
  - 回放这次对话的请求与原始请求一致。
- **C 期**：superpowers 的 `subagent-driven-development` 在 Capybara 里跑通一个小计划。

每期按惯例写详细计划（writing-plans），由用户审阅后执行。

## 13. 术语重构与兼容（0 期）

原则：

- **对外已发布的名字**（SDK 导出、包格式、HTTP 接口、配置项、CLI）保留旧名作为别名或只读兼容，至少保留一个大版本，并在文档里标明废弃；
- **内部名字**（表、内部模块、界面文案）直接改；
- **日志与审计照 C27 的做法不改**：事件 payload 字段名、已有审计 action、模型可见的文案都保持原样，避免回放漂移；新事件、新审计用新名。
- **新旧含义撞名的名字不做别名**（设计者的决定）：`/admin/plugins`、`capybara plugins` 等旧名指代码、新名指插件，同一个名字不能既是旧资源的别名又是新资源。
  - 这些名字随 0 期所在的大版本直接切换到新含义，在发行说明里列出迁移对照；
  - 只有不撞名的旧名（如 `/admin/directory`、`catalogs.*` 配置键、`definePlugin`）保留别名。
  - 外部调用方只有持个人令牌的脚本和外部应用，大版本说明足以覆盖。
- **滚动升级**（设计者的决定）：照总设计 §8.5「升级不停机」，0 期的表改名分两个版本发布：
  - 第一个版本新建表或视图并双写；
  - 第二个版本切读并删旧表；
  - 中间允许新旧副本混跑。
  - `app_installs` → `plugin_installs` 依赖于旧的 `plugin_installs` 先改名为 `extension_installs`，所以排在第二个版本。

| 范围 | 改动 | 兼容 |
|---|---|---|
| SDK | `definePlugin` → `defineExtension`；`PluginManifest` → `ExtensionManifest`；`CapabilityRef` / `CAPABILITIES` → `ExtensionPointRef` / `EXTENSION_POINTS`；`ctx.capabilities` → `ctx.extensionPoints` | 旧名作为废弃别名导出；清单字段 `provides` / `requires` / `optional` 不变 |
| SDK 包名 | `@capybara-hq/plugin-sdk` 保留：它本来就是「做插件的 SDK」 | — |
| 包格式 | 新增 `.capybara-plugin/plugin.json`；`package.json` 的 `capybara` 段只作旧格式读取 | 第 4.2 节 |
| 表 | `plugin_installs` / `plugin_packages` / `plugin_permission_snapshots` 等指代码的表 → `extension_*`；`directory_items` → `catalog_items`；`catalog_sources` / `catalog_entries` → `marketplaces` / `marketplace_entries`；`app_installs` → `plugin_installs`（改名先后顺序由迁移计划保证） | 迁移内完成，照 writing-migrations 的「扩展 → 收缩」两步 |
| HTTP 接口 | `/admin/plugins`（管代码）→ `/admin/extensions`；`/admin/directory` → `/admin/catalog`；`/admin/catalogs` → `/admin/marketplaces`；新的 `/admin/plugins` 与 `/orgs/:id/plugins` 管插件 | 旧路由保留一个大版本，返回 `Deprecation` 头 |
| 配置 | `catalogs.*` → `marketplaces.*`；`pluginConfig.<名>` → `extensionConfig.<名>`；`pluginPermissions.*` → `extensionPermissions.*` | 旧键照读并打废弃告警 |
| CLI | `capybara plugins …` 管插件；新增 `capybara extensions review/approve` | 旧命令转发并提示 |
| 界面 | 管理后台「插件」页改为插件列表，扩展作为插件的详情；「嵌入应用」→「嵌入页面」；指对话的「会话」→「对话」（如「本对话内都允许」） | — |
| 文档 | 总设计、扩展模型设计（含「名字保持插件，不叫扩展」那条改写）、AGENTS.md、各技能指南 | — |

## 14. 风险与取舍

- **术语重构范围大**：用兼容层与 0 期的升级验收兜底；改名单独成期，不和功能混在一起。
- **两个仓库带来协作成本**：契约改动要跨仓库提 PR；用 SDK 公开 API 快照检查和每晚的跨仓库构建发现问题。
- **Claude Code 格式变化快**：用白名单翻译加「已忽略」报告应对，最多导致新字段被忽略，不会装错。
- **跟踪分支的市场是「首次信任」**：内容由提交 sha 和内容摘要锁定，但第一次的内容是否可信，靠企业管理员审阅时判断。这比 D16 只信清单 sha512 弱，界面上注明来源类型。
- **Claude 市场的 npm 来源没有 integrity**：引入时记录 registry 给出的 integrity，并标注「来源未锁定内容」；之后同版本再拉取时，以记录的值为准。（设计者的决定）
- **常驻技能会占上下文**：用上限控制，并显示 token 估算。
- **翻译过来的技能是写给编码 agent 的**：比如 git worktree、合并分支，在没有仓库的沙箱里意义不大。审阅页如实展示，由组织决定给哪些 agent 用。

## 15. 开工前对照（M7 合并后）

- M6 的企业目录、市场（目录来源）、应用导入与安装相关表的实际字段，以及 `parseCatalogIndex`、`AppManifest`、`AppImport`、`AppInstaller` 的实际接口。
- M7 发布了哪些对外的名字（SDK 导出、HTTP 路由、配置键、CLI），决定第 13 节的兼容清单。
- M7 的官方清单是否已经上线、用的是什么地址和格式；镜像怎样带内置插件；CLI 有哪些初始化命令。这些决定第 6、7 节的过渡方式，以及 `init` 与 `migrate` 的关系。
- M7 发布时有没有外部包在用 `app.yaml`。
- `connector-mcp` 是否支持 SSE，OAuth 的具体形状。
- 技能目录快照事件当时的结构，以及常驻正文加入后对缓存段的影响。
- 内置工具当时的名字（工具对照文本）。
- Claude Code 文档当时的字段（附录 A）。

## 附录 A：Claude Code 格式要点（2026-10-22 核对）

来源：code.claude.com 文档的 plugins manifest reference、marketplace reference、loading、components、hooks、MCP 各页。

- **`plugin.json`**：
  - 文件可选，只有 `name` 必填（kebab-case）；
  - 组件路径必须以 `./` 开头，不能越出插件根；`skills` 是追加到默认的 `skills/`，`commands` / `agents` 是替换默认目录，`hooks` / `mcpServers` 是合并；
  - 默认布局：`skills/<name>/SKILL.md`、`commands/`、`agents/`、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`output-styles/`、`bin/`、`settings.json`；根目录单个 `SKILL.md` 当作一个技能；
  - 有 `dependencies` 字段，可以依赖别的插件。
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
