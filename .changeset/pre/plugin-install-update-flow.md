---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Updating an installed platform plugin to a newer version is one wizard: 更新到 vX on the admin
plugin list, the plugin's page and the marketplace tab stages the version and shows the import
review, then the platform update preview; one confirm applies both (`GET
/api/v1/admin/catalog/imports/:stagingId/update-preview`, `POST …/imports/:stagingId/update`).
Cancelling writes nothing; an update failing after the import says so (409
`plugin.imported_not_updated`) and leaves the platform on its version. An installed plugin is no
longer imported on its own; the 版本 tab moves the platform to another imported version (更新到 /
回退到). A plugin not installed yet shows 安装 instead of 导入 / 引入.
