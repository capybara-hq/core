---
"@capybara-hq/kernel": patch
---

配置文档：`docs/config.md` 增加「网页层（apps/web）的环境变量」一节（`CAPYBARA_KERNEL_URL`、`CAPYBARA_WEB_MAX_BODY_BYTES`、`CAPYBARA_WEB_MAX_PACKAGE_BYTES` 等）；`packages.maxBytes` 的说明注明网页层上传另受 `CAPYBARA_WEB_MAX_PACKAGE_BYTES` 限制，两者一起调。
