---
"@capybara-hq/web": patch
---

接入指南 on 新建渠道 (once a plugin with a setup guide is picked) and on the channel detail page:
the plugin's steps, each template file filled in for the channel in a code block with 复制, and a
mode switch (长连接 / Webhook) when the guide has a file per mode. When a plugin upgrade changed
the setup since the connection was set up, the detail page says so (「Slack 插件更新了接入配置」)
with 「我已更新 Slack 应用」 to confirm.
