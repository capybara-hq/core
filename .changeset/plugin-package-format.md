---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

插件包格式（npm-pack tgz，`package.json` 的 `capybara` 段带静态清单）：plugin-sdk 新增 `HOST_PROVIDED_PACKAGES`、`StaticPluginManifest`、`CapybaraPackageSection`、`validatePluginPackageJson`、`checkEntryImports`、`staticManifestOf`、`isSafePackagePath`；内核新增 `readPluginPackage`（大小、路径、链接、条目数、安装脚本、依赖字段、import 白名单、SDK 范围、版本一致等校验，不执行插件代码）、`permissionSetOfPackage`（静态清单 + 迁移 SQL 的权限集合）与 `extractPluginPackage`。新增仓库内打包工具 `pnpm pack-plugin` / `pnpm pack-plugins` 与检查 `check:plugin-pack`。
