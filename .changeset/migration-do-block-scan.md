---
"@capybara-hq/kernel": patch
---

迁移检查扫描 `DO $$ … $$` 块体：块体里的 RENAME / 删列等破坏性语句不再被美元引用抹掉而静默通过。`DO` 块须在 `DO` 行正上方写 `-- capybara:allow-destructive <原因>`，否则报 `do-block`（块体有破坏性语句时另报 `destructive`）。`splitSqlStatements` 的结果新增 `bodies`（美元引用原文），新增导出 `isDestructiveBody`。
