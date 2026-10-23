---
name: writing-apps
description: 写企业目录里的连接器模板包（capybara.kind = connector-template）、技能包（kind = skill）或应用包（kind = app，app.yaml：插件 + 连接器模板 + 技能），或改内核的目录导入、组织安装与卸载（packages/kernel/src/directory）时使用：package.json 的 capybara 段、app.yaml 的 schema 与 lock（npm 名 + 范围 + 精确版本 + sha512）、editableEndpoint 与 defaultToolPolicies 怎么写、导入（prepare / confirm、deployPlugins）与组织安装 / 卸载的语义、JSON Schema 在 packages/plugin-sdk/schemas/、M6 不支持应用升级。写插件本身见 writing-plugins，写连接器插件见 writing-connectors。
---

# 写应用包与连接器模板

企业目录（D9 / D16 / D17）里的包统一是 npm-pack tgz，`package.json` 带 `capybara` 段，`kind` 四种（C21）：

| kind | 内容 | 条目名 | 谁装 |
|---|---|---|---|
| `plugin` | 插件包（见 `.agents/skills/writing-plugins`「插件包」） | 插件清单名 | 企业管理员装到部署；组织「安装」= 在本组织启用 |
| `connector-template` | 连接器模板：引用一个连接器插件，预设端点与认证（不含凭据） | 去掉 scope 的 npm 包名 | 组织管理员（填凭据即建连接器） |
| `skill` | 技能：包根放 `SKILL.md` 与其他文件 | `SKILL.md` 的 `name` | 组织管理员（导入为组织技能） |
| `app` | 应用：`app.yaml` 组合插件 + 连接器模板 + 技能 | `app.yaml` 的 `name` | 企业管理员导入（一次审阅全部插件权限）；组织管理员安装 |

连接器模板与技能另接受 zip（根目录放 `package.json`）。非插件包一律不许安装脚本、`dependencies` / `peerDependencies`
等依赖字段（不执行、不安装）；`version` 必须是 semver。格式与校验是 SDK 的纯函数：`packages/plugin-sdk/src/plugin-package.ts`
（`parsePackageSection`、`validateConnectorTemplate`）、`app-manifest.ts`（`parseAppManifest`）、`catalog.ts`（清单）。
内核读包在 `packages/kernel/src/directory/archive.ts`（包一律当作恶意输入，全部校验通过之前什么都不写）。

**JSON Schema**：`packages/plugin-sdk/schemas/app.v1.schema.json`（`app.yaml`）与 `catalog-index.v1.schema.json`（目录清单
`index.json`）由 `pnpm gen:package-schemas` 从 zod schema 生成，`pnpm check`（`check:package-schemas`）保证不漂移。改了
`AppManifestSchema` / `CatalogIndexSchema` 要重新生成。JSON Schema 表达不了的规则（lock 版本满足范围、名字 / id / 路径唯一、
模板引用的插件已列出、模板的静态规则、路径安全）只由 `parseAppManifest` / `parseCatalogIndex` 判定，外部 CI 校验清单时也要跑它们。

## 连接器模板（C30）

```json
{
  "name": "@acme/crm-mcp",
  "version": "1.0.0",
  "capybara": {
    "kind": "connector-template",
    "publisher": "Acme",
    "description": "Acme CRM over MCP",
    "displayName": { "zh": "Acme CRM", "en": "Acme CRM" },
    "template": {
      "plugin": "connector-mcp",
      "pluginVersion": "^0.1.0",
      "connector": "mcp",
      "endpoint": { "url": "https://mcp.acme.example/mcp" },
      "editableEndpoint": ["url"],
      "auth": { "type": "bearer", "ownership": "org" },
      "defaultToolPolicies": { "search": "allow", "delete_record": "deny" },
      "icon": "icon.svg"
    }
  }
}
```

- `plugin` / `connector`：连接器插件名与它的 `Connector.kind`。**导入时该连接器插件必须已在本副本加载**：内核按它的
  `endpointSchema` 校验端点，并确认 `editableEndpoint` 的每个路径都是端点 schema 里的字段；没加载就拒绝导入
  （`directory.invalid_package`）。组织安装时按当时加载的连接器再复核（没加载 → `directory.not_deployed`）。
- `pluginVersion`（可选，semver 范围）：连接器插件的版本要求。导入时按本副本加载的版本核对（不满足 → `directory.invalid_package`），
  组织安装时（与列表的「可安装」）再按当时加载的版本核对（不满足 → `directory.not_deployed`，消息带版本）。应用包里的模板另按 lock 核对。
- `endpoint`：端点预设，所有组织都看得到，**任何层级都不许出现凭据样式的键**（`token`、`apiKey`、`secret`、`password`、
  `authorization`、`cookie` 等，比较时忽略大小写与 `-` / `_`），内核另按连接器安装的规则检查头 / query / URL 用户信息。
- `editableEndpoint`：组织安装时允许改的点路径（字母、数字、`_`、`-`，≤ 50 条，不重复，不能像凭据字段）。只列确实因组织而异
  的字段（如自托管服务的 `url`、某个租户 id）；改了没列出的路径 → 400 `validation_failed`。合并后的整个端点再按 schema、
  凭据检查与 OAuth 地址策略复核。
- `auth`：与连接器安装接口的认证方式同形（`ConnectorAuthSchema`：`none` / `bearer` / `basic` / `api_key` / `headers` /
  `oauth_code` / `oauth_client`），**不含凭据**（多出字段即拒绝）。组织只能填凭据：静态凭据经 `credential`，OAuth 经
  `client: { clientId, clientSecret? }`。`ownership` 缺省取 `auth.ownership`，给了必须一致；`auth.type = none` 时不能给。
- `defaultToolPolicies`：**本地工具名**（不带 `<slug>__`）→ `allow` / `ask` / `deny`。安装后工具快照里同名的工具用它作默认策略，
  记 `policy_source 'template'`（与管理员设定一样在漂移复核后保留）；不在清单里的工具照常按注解推导。授权码连接器安装时不列工具，
  首个成员连接、拿到第一份工具快照时再套用。拿不准就别写 `allow`。
- `icon`：包内 `.svg` / `.png`，≤ 64 KB，内容须真是 svg / png。图标只经内核路由给出（nosniff + CSP sandbox），网页只用 `<img>`。

## 应用包（C31）

`package.json`：`{ "name": "@acme/app-crm-suite", "version": "1.0.0", "capybara": { "kind": "app", "manifest": "app.yaml" } }`。

```yaml
schemaVersion: 1
name: crm-suite                # 目录条目名，^[a-z0-9][a-z0-9-]{0,63}$
version: 1.0.0                 # 必须等于 package.json 的 version
publisher: Acme
description: CRM tools for sales teams
displayName: { zh: CRM 套件, en: CRM Suite }
icon: icon.svg
plugins:                       # ≤ 20
  - name: crm                  # 插件清单名
    npm: "@acme/plugin-crm"
    version: ^1.0.0            # 部署里已装且满足范围的插件不动
    lock:
      version: 1.2.0           # 必须满足 version
      integrity: sha512-…==    # 该版本 tgz 的 sha512（npm 的 dist.integrity）
    optional: false            # 可选插件：组织安装时没装到部署 / 版本不满足就跳过（用到它的模板也跳过）
connectorTemplates:            # ≤ 20，template 与连接器模板包的 template 同形
    # template.plugin 引用部署里已有的连接器插件 connector-mcp（没列在 plugins 里），见下文 isKnownConnectorPlugin
  - id: crm-mcp
    displayName: { zh: CRM, en: CRM }
    template: { plugin: connector-mcp, connector: mcp, endpoint: { url: "https://…" }, auth: { type: bearer, ownership: org } }
skills:                        # ≤ 50，包内目录，各含 SKILL.md
  - path: skills/crm-notes
```

- **插件包不打进应用包**：内核导入时按 lock 从配置的 `packages.npmRegistry` 拉取 `lock.version`，**只认 `lock.integrity`**
  （`app.lock_mismatch`），不认 npm 元数据；拉下来的包与单独安装时完全相同（同一 sha256）。所以发版流程是：先把插件发到 npm，
  取 `dist.integrity` 写进 lock，再打应用包。离线部署要配 npm 镜像 / 私有 registry，否则应用包导入不可用。
- 模板的 `plugin` 必须列在 `plugins` 里，或是部署里已有的连接器插件；给了 `pluginVersion` 时锁定版本必须满足它（只对列在 `plugins` 里的插件核对）。
  「部署里已有」由调用方经 `parseAppManifest(yaml, { isKnownConnectorPlugin: (name) => … })` 告诉解析器：内核导入时传入「本副本已加载、
  提供 `connector@1` 的插件」；**不传这个选项时，模板只能引用 `plugins` 里列出的插件**，上例这样引用内置 / 已装的 `connector-mcp`
  会报 `connectorTemplates.0.template.plugin: connector plugin connector-mcp is not listed in plugins …`。外部 CI 校验应用包时，
  按目标部署里有哪些连接器插件给这个回调（如 `(n) => ["connector-mcp", "connector-openapi"].includes(n)`），或把连接器插件也列进 `plugins`。
- 未知字段一律拒绝（拼错字段报错，不是忽略）；YAML 重复键报错，`app.yaml` ≤ 256K 字符。
- 一次导入的总字节（应用包 + 全部插件包，校验时都在内存里）≤ `directory.maxBundleBytes`（缺省 4 × `packages.maxBytes`），
  超出 → 413 `app.bundle_too_large`。
- 应用里的 agent 模板推迟（C32）；不支持 stdio MCP。

### 企业导入：prepare → confirm（`/api/v1/admin/directory/apps/*`）

- `POST apps/prepare/file`（原始字节）或 `apps/prepare/npm {package, version?}`，或从清单引入 app 类条目：解包、校验全部组件、
  按 lock 下载全部插件，**全部通过之前什么都不写**；然后插件入包存储（来源 `directory`）、文件进对象存储、写 24 小时的暂存，
  返回审阅：每个插件的 action（`install` 部署上没有 / `upgrade` 已装但不满足范围、按 lock 换 / `keep` 已装且满足范围，或内置 /
  配置声明的插件）、权限与相对当前快照的增减、迁移警告、敏感项，以及模板与技能清单。内置 / 配置声明的插件不满足范围 →
  `app.plugin_conflict`；降级到有未执行迁移的版本 → `plugin.downgrade_unsupported`。
- `POST apps/:stagingId/confirm {reviewHash, deployPlugins}`：`reviewHash` 须与审阅一致，按此刻的部署状态重算（审阅后插件被装 /
  升级 / 换包 → `app.review_stale`）；为 `install` 的插件写权限快照（审计 `plugin.permissions_approved` 带 `app`），建目录条目版本。
  - `deployPlugins: true`：`upgrade` 的插件同样写快照；提交后先把插件全部装到部署、再全部启用（各副本 reconcile，不重启），
    逐个返回结果，失败不回滚已提交的条目；`upgrade` 没装上的恢复原快照（审计 `plugin.permissions_restored`），旧版本继续跑。
  - `deployPlugins: false`：只建条目，不动部署，也**不为 `upgrade` 的插件写快照**（快照必须对应实际运行的版本，F-O）。之后要用
    这个应用，企业管理员到插件后台按条目版本里的 sha256 装（`POST /api/v1/admin/plugins/:name/install {sha256}` → 需要时
    `…/approve` → `…/enable`）；必选插件没装到部署时，组织安装返回 `directory.not_deployed`。
- 过期的暂存由维护任务 `app-staging-cleanup`（每小时）清理；已入库的插件包留在内容寻址的包存储里，没有安装记录引用就不会被加载。

### 组织安装与卸载（`/api/v1/orgs/:orgId/directory/:itemId/install`、`app-installs`）

- 安装应用要同时有 `org.plugins.manage`、`connectors.manage`、`skills.manage`（组织行锁内复核）；条目策略 `disabled` →
  `directory.item_disabled`，`needs_approval` 且本组织没有授予 → 202 并建（或升级）待企业管理员批准的申请，否则 201。
- **应用里的插件按应用条目的策略判定，不看各插件条目的 needs_approval / allow**（C22）。**例外（裁决 M-5，覆盖 C22 的应用途径）**：
  插件自己的目录条目（`kind = plugin`、同名）设为 `disabled` 是总开关，任何途径都不能在组织里新启用这个插件——直接启用、经插件条目、
  经含它的应用都不行。含它的应用组织安装时返回 403 `directory.item_disabled`（消息点名插件；本组织已启用的不受影响），导入含它的应用包
  审阅时同样拒绝（`directory.item_disabled`）。要停掉某个插件，禁用它自己的条目即可，不必逐个禁用含它的应用。
- 插件判定（列表的「可安装」与安装同一套，按确认时写进条目版本 `resolved.plugins` 的范围与 `optional`）：必选插件没装到部署、或加载的版本
  不满足 `app.yaml` 的范围 → `directory.not_deployed`（消息带部署的版本与要求的范围）；可选插件遇到这些情况（或插件条目被禁用）就跳过，
  模板的 `plugin` 是被跳过的可选插件时该模板也跳过。跳过的插件与模板在安装结果 `installed.skipped`（`{ plugins, connectorTemplates }`）
  与审计 `app.installed` 里列出。
- 请求体：`{ version?, app: { connectors: { <模板 id>: {…} }, pluginConfigs?: { <插件名>: <组织级配置> } } }`。`pluginConfigs` 只认 `app.yaml`
  `plugins` 里的插件名（别的 → 400 `validation_failed`），**只用于本次新启用的插件**：本组织已启用的插件记为原有，配置不动；新启用时按该插件的
  `config.org` schema 校验（同 `PUT /orgs/:orgId/plugins/:plugin`），需要组织级配置才能启用的插件不给就装不上。
- 依次：在本组织启用插件（按 requires 排序，提供方在前；本组织已启用的记为原有）→ 按模板建连接器（请求体 `app.connectors[<模板 id>]`
  给 `name?` / `slug?` / `endpoint?`（只限 `editableEndpoint`）/ `credential?` 或 `client?`）→ 导入技能（同名组织技能已存在则新增
  一个版本，记为原有并记下版本号）。每个组件建好就记进 `app_install_components`（新建 / 原有）。**任一步失败按相反顺序撤销本次
  新建的组件**，安装记 `failed`，返回 502 `app.install_failed`。
- 卸载（`DELETE app-installs/:installId`，同样要三项权限）**只移除本次新建且别处不在用的组件**，保留项与原因写进报告：
  `pre_existing`（原来就有）、`used_by_agents`（技能被 agent 选中 / 连接器被 agent 引用）、`used_by_other_install`（本组织别的应用
  安装也用到，所有权交给最早的那个安装）、`used_by_connectors`（插件提供的连接器仍有连接器在用）、`used_by_plugins`（别的已启用插件
  依赖它）。卸载 `failed` 的安装、或超过 `directory.staleInstallMinutes`（默认 30）仍是 `installing` 的安装（副本中途崩溃）时按回滚清理
  （已有技能上新增的版本也退回）；还在安装中的 → `app.install_in_progress`。
- **M6 不支持应用升级**：新版本要先卸载再安装。

## 写包时的检查清单

1. 连接器模板：先在开发部署里装好、启用对应的连接器插件，再导入模板；端点预设与 `editableEndpoint` 用该插件的 `endpointSchema` 核对。
2. 应用：插件先发 npm，lock 写 `dist.integrity`；`app.yaml` 的 `version` 与 `package.json` 一致；技能目录各有 `SKILL.md`。
3. 本地校验：SDK 的 `parsePackageSection(pkg, SDK_VERSION)` 与 `parseAppManifest(yaml, { isKnownConnectorPlugin })` 返回无 `errors`
   （模板引用的连接器插件没列在 `plugins` 里时必须给 `isKnownConnectorPlugin`，见上文）。
4. 测试参考：`packages/kernel/test/directory/`（`archive`、`directory`、`app-import`、`app-install`、`org`、`requests`、`catalogs`）与
   双副本验收 `m6-segment3.dual.test.ts`；从仓库根跑 `pnpm exec vitest run <路径>`。
