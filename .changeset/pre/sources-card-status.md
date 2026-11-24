---
"@capybara-hq/capybara": patch
---

A marketplace source card shows a short state (OK, Failed) beside its name and the entry count and
last refresh, or the error sentence, under it, so the name is no longer cut off. A list page that has
both a source filter and field filters draws them on one row (the plugin market's 市场源 button sits
after its source filter).
An update through the import page shows the installed → staged versions in the review's chip for a
plugin without an extension too (it read 安装 v<new>).
The plugin market's card state names the installed version only (the 更新到 button carries the
newer one), and a card's state takes at most half its head, cut with an ellipsis, so a long state
never squeezes the name away.
The plugin review follows the approved mockup: 完整说明 and 许可证全文 are one row of small links
under the facts, a connector template is one row whose host line opens its description and full
endpoint (no 端点详情 line), skills and agent templates open their texts from an inline link, and
the dependencies lose their explanatory sentence. The design system gains `DisclosureLinks`.
