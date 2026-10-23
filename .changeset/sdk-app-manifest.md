---
"@capybara-hq/plugin-sdk": minor
---

应用包清单 `app.yaml`（schemaVersion 1，C31）：`AppManifest` / `AppPluginRef` / `AppConnectorTemplate`、`AppManifestSchema`、`parseAppManifest(yamlText, { isKnownConnectorPlugin? })`（不合法返回 `{ errors }`，从不抛错；YAML 重复键报错、别名数有上限、超过 256K 字符不解析；未知字段拒绝；跨字段规则：`lock.version` 满足 `version` 范围、插件名 / npm 包 / 模板 id / 技能路径唯一、技能路径安全且互不嵌套、模板引用的插件已列出或为已知连接器插件、模板 `pluginVersion` 被 lock 版本满足、模板静态规则复用 `validateConnectorTemplate`）、`APP_MANIFEST_SCHEMA_VERSION`、`APP_MANIFEST_LIMITS`（插件 ≤ 20、模板 ≤ 20、技能 ≤ 50）。导出 `SEMVER_VERSION_RE`、`SHA512_INTEGRITY_RE`。包里附带由 zod schema 生成的 `schemas/app.v1.schema.json`。
