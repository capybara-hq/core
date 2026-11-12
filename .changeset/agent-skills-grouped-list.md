---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

The agent page's 组织技能 and the agent template's 技能 group the skills by where they come from
(each plugin, the org's own, the built-in ones), each group with a select-all box (checked/total,
mixed) and a filter for long lists; each row is the name and its badges on one line and the
description cut to one muted line with the full text on hover (new design `CheckList`). A badge
never shrinks or wraps, and a checked disabled checkbox keeps its check visible.
