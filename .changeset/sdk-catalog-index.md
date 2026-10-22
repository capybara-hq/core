---
"@capybara-hq/plugin-sdk": minor
---

目录清单格式（schemaVersion 1）：`CatalogIndex` / `CatalogEntry` / `CatalogVersion`、`CatalogIndexSchema`、`parseCatalogIndex`（不合法返回 `{ errors }`，从不抛错；跨字段规则：(kind, name) 唯一、版本唯一、`sensitive` ⊆ `keys`、plugin 版本必填 `minSdk`）、`compatibleVersions`、`CATALOG_SCHEMA_VERSION`、`CATALOG_LIMITS`，导出 `NPM_PACKAGE_NAME_RE`。包里附带由 zod schema 生成的 `schemas/catalog-index.v1.schema.json`（`pnpm gen:package-schemas` 生成，`check:package-schemas` 防漂移）。
