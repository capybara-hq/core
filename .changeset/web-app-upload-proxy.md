---
"@capybara-hq/web": patch
---

代理：应用包上传 `POST /api/v1/admin/directory/apps/prepare/file` 与插件包、目录包上传一样放宽到 `CAPYBARA_WEB_MAX_PACKAGE_BYTES` 并流式透传。
