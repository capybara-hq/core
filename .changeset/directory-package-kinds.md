---
"@capybara-hq/plugin-sdk": minor
---

企业目录包种类（C21 / C30）：新增 `PackageKind`（`plugin` / `connector-template` / `skill` / `app`）与 `PACKAGE_KINDS`、`PluginPackageSection`（`CapybaraPackageSection` 的别名）、`ConnectorTemplateSpec` / `ConnectorTemplateSection` / `SkillPackageSection` / `AppPackageSection`（`manifest: "app.yaml"`，内容留给应用包）与联合类型 `PackageSection`；`parsePackageSection(pkg, hostSdkVersion)` 按 `capybara.kind` 校验 package.json（非插件包同样不许安装脚本与依赖字段，连接器模板的条目名 = 去掉 scope 的包名），`validateConnectorTemplate(t)` 校验模板的静态部分（认证预设按 `ConnectorAuthSchema`，strict，夹带 `token` 等即拒绝；端点预设任何层级不许有凭据样式的键；`editableEndpoint` 点路径；ownership 与 auth 一致；默认策略；icon 为包内 svg / png）。连接器认证方式的 zod schema 移到 SDK 导出为 `ConnectorAuthSchema`（内核连接器安装接口改为引用它）；导出插件名规则 `PLUGIN_NAME_RE`、`DIRECTORY_ITEM_NAME_RE`、`unscopedPackageName`、`CONNECTOR_TEMPLATE_LIMITS`、`APP_MANIFEST_FILE`。
