---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Claude Code plugins import from git marketplaces with a translation report; agents can pin skills;
`skill_load` accepts `<plugin>:<name>`. `parseSkillMd` returns the whole parsed frontmatter
(`frontmatter`) next to the name, description and body.

Git marketplaces read Claude Code's `.claude-plugin/marketplace.json` (entries with an overlay of
their component fields and `strict`; npm, archive and command sources are listed as skipped) and
single Claude plugin repositories. A Claude Code plugin from git goes through the one import review
with `format: "claude-code"`, a five-group translation report (covered by `reviewHash`), connector
templates for its remote MCP servers and no extension; every review carries the root LICENSE text
and each skill's `suggestPinned`, and confirm takes `pinnedSuggestions`. Catalog versions record
`sourceFormat`, `translation` and `licenseText`; `capybara plugins import` prints the report.

Org installs and upgrades record each skill version's source format and pinned suggestion; the org
and agent skills lists return `plugin`, `sourceFormat`, `suggestPinned`, `entryBytes` and
`tokenEstimate`.

Agent definitions take `skills.pinned` (at most 3 selected org skills or the agent's own skills,
SKILL.md total at most 32 KB); a refused list is 400 `agent.pinned_invalid` with one detail per
skill and reason.

The `skills_catalog` snapshot records each skill's plugin, the pinned skills' bodies (read from
storage at run start; a read failure fails the run with `storage.unavailable`) and, when a Claude
Code skill is present, the tool-name map; `skill_load` resolves `<plugin>:<name>`.
