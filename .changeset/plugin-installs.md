---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

插件安装记录、内容寻址包存储与本地同步：内核新增迁移 `0030_plugin_installs`（`plugin_packages` / `plugin_blobs` / `plugin_installs` / `plugin_replica_status`）、配置 `pluginHost.*` 与 `packages.*`、`StorageService.deployment()`（前缀 `deployment/`）、`PluginBlobs`、`PluginInstalls`（上传与 npm 导入、审阅结果与 `reviewHash`）、`syncPackage`、`fetchNpmPackage`、`newReplicaId`，以及 `POST /api/v1/admin/plugins/packages/{file,npm}`；插件宿主按「内置 → 配置声明 → 安装记录」加载，内置插件（`KernelOptions.builtinPlugins`）预先批准、始终启用。plugin-sdk 的 `validatePluginPackageJson` 增加 SDK 范围须有上界、`peerDependencies` 的 SDK 范围须等于 `capybara.sdk`、zod 范围须被宿主满足的校验。testing 新增 `startFakeNpmRegistry`。
