---
"@capybara-hq/kernel": minor
---

The permission reviews carry the client build (client extensions spec §5.4). `GET
/api/v1/admin/catalog/items/:id` gives each version `client`: its extension package's build (files
by manifest key with their sizes in load order, `totalBytes`, `apiVersion`; null without one), so
the confirmation of an org's upload shows the pending package's files and sizes. The org extension
list and `PUT …/extensions/:extension` give org admins `client`, the running package's build, for
the Sheet's 客户端代码 group; members never get it.
