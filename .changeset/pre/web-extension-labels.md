---
"@capybara-hq/web": patch
---

Extension display names in the web: admin and org extension lists, the extension detail title and
breadcrumb (the id is muted meta), the channel plugin picker, the models page and every model select
read "OpenAI 兼容 / deepseek/deepseek-flash". The new check rule `web-ui-extension-label` forbids
provider labels built by hand outside `lib/extension-label.ts`.
