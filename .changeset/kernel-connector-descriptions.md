---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Connector template descriptions in zh and en: component lists, the install wizard's templates
(`OrgCatalogTemplate`) and the import review (`PluginReviewTemplate`) carry `descriptionZh` next to
`description` (null when the template has one text). Connectors made from a platform template
return that template's description (`description`, `descriptionZh`; its current version, under the
same visibility gate as its icon; null for a custom connector), and the web shows it in the page
language on the connector cards of /connectors and at the top of the connector's detail page;
template cards, the admin template page, the plugin page and the install wizard pick the text for
the page language too.
