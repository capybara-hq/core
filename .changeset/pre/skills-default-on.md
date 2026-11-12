---
"@capybara-hq/capybara": minor
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
---

Skills are on by default and pinning is gone. Every skill on in an org is on for every agent unless
the agent's new `disabledSkills` turns it off (a plugin's skills by name, a whole plugin as `"all"`
including skills it gains later, or a skill without a plugin by id); builtin skills, the agent's
own and its shared skills cannot be turned off. `skills.orgSkills` and `skills.pinned` are removed
from the agent definition (refused on save; migration 0116 rewrites every agent version), run start
no longer injects pinned skill bodies (an old conversation gets a "Pinned skills removed" notice),
and `agent.pinned_invalid` is gone. A sub-agent template's `skills` become one logged line telling
the child to load them with `Skill` first. `plugin.json` `skills[].pinned` and the import confirm's
`pinnedSuggestions` are removed; the skill APIs drop `suggestPinned`, `entryBytes` and
`tokenEstimate` and the library list gains `builtin`; the Claude Code import reports a
`session_start_hook` warning instead of a pin hint. The Platform tool's `agents.create` /
`agents.update` take `disabledSkills`, and `platform.me` lists the agent's skills.
