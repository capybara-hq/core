---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
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
`sourceFormat`, `translation`, `licenseText` and `licenseTruncated`; `capybara plugins import`
prints the report. The translator takes at most 100 distinct declared paths per component key
and parses each JSON file once.

Org installs and upgrades record each skill version's source format and pinned suggestion (an
upgrade that leaves a skill unchanged updates its current version's flag); the org and agent
skills lists return `plugin`, `sourceFormat`, `suggestPinned`, `entryBytes` and `tokenEstimate`.
A connector template with personal static auth asks the installer for their own credential:
install and upgrade planning answer 400 at `connectors.<id>.credential` instead of failing at the
connector step, and the install wizard asks for it.

Agent definitions take `skills.pinned` (at most 3 selected org skills or the agent's own skills,
SKILL.md total at most 32 KB); a refused list is 400 `agent.pinned_invalid` with one detail per
skill and reason.

The `skills_catalog` snapshot records each skill's plugin, the pinned skills' bodies (read from
storage at run start; a read failure fails the run with `storage.unavailable`) and, when a Claude
Code skill is present, the tool-name map; `skill_load` resolves `<plugin>:<name>`.

Requests render pinned skills (in the cached system segment, as mid-conversation notices and
after compaction) and the tool-name map from the log; step replays report `pinned_changed` when a
candidate pins other skills.

The web import review shows a Claude Code plugin's translation report (five groups with localized
reasons), its `repository` (display only), each skill's SKILL.md and the LICENSE text (collapsed),
and "suggest pinned" checkboxes (expanded when the plugin has a SessionStart hook) sent as
`pinnedSuggestions`; the catalog item shows the format, report and license (or that it was too
long), and the marketplaces page lists the entries a refresh skipped with the reason (the first
20 and how many more). Text with bidi or control characters gets a warning line.

The agent page pins skills: selected skills each get a "pin" checkbox (a plugin's suggested skill
is ticked when selected, a deselected skill is unpinned), with the token estimate, the count limit
and an over-32 KB warning; `agent.pinned_invalid` shows one line per skill and reason. A reply that
cannot read the agent's pinned skills, or whose pinned skills changed while it started, says so.
