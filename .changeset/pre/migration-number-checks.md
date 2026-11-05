---
"@capybara-hq/plugin-tools": patch
---

Two migration numbering rules: `capybara-plugin check` reports two files of one migrations
directory that share a number (`migration-duplicate-number`), and `--base <ref>` also fails when
the diff adds a migration numbered at or below the highest number of its directory at `<ref>`
(`migration-number-behind-base`; `checkMigrationNumbers` / `diffMigrationNumbers`).
