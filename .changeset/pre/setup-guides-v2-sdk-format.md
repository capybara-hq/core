---
"@capybara-hq/plugin-sdk": minor
---

Setup guides v2: a guide is a Markdown document `guides/<id>.md` (optional `guides/<id>.zh.md`)
declared in `plugin.json` `setupGuides` as `{ id, place, template? }`. The SDK adds the place
registry (`channel-connection`, `connector-template`; modes, audiences, typed variables), the
parser (`parseSetupGuide`: title, `::: mode` / `::: audience` sections, `::check` lines, titled
code fences), the validator (`validateSetupGuide`, including zh parity), the renderer
(`renderSetupGuide`: substitution into the parsed tree, link policy, raw HTML as text, blocks) and
the drift hash (`setupGuideHash`, code blocks and check lines only). The v1 steps-and-files format
and its helpers are removed.
