---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Connector template descriptions in zh and en: component lists, the install wizard's templates
(`OrgCatalogTemplate`) and the import review (`PluginReviewTemplate`) carry `descriptionZh` next to
`description` (null when the template has one text). Connectors made from a platform template return that template's description
(`templateDescription`, `templateDescriptionZh`; its current version, under the same visibility
gate as its icon; null for a custom connector). A connector may also carry its own description
(`description`, migration 0181 `connectors.description`, plain text up to 1024 characters): org
admins set it in the create body or by PATCH (null or blank clears it; audited in
`connector.updated`), and the Platform operations `connectors.create` / `connectors.update` take it
too. The web shows the own description, else the template's in the page language, on the connector
cards of /connectors and at the top of the connector's detail page; the add-connector wizard and the
connector's 设置 tab edit it (the template's text as the placeholder). Template cards, the admin
template page, the plugin page and the install wizard pick the text for the page language too.
