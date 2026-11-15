---
"@capybara-hq/kernel": minor
---

A conversation bound to a project shows the model the project's `AGENTS.md` and skills: each
`project_root` event renders at its position as a system message (after the agent's own
instructions, which win on a direct conflict; the skills listed as `project:<name>`; an
unavailable project as one line saying earlier project instructions and skills no longer apply),
and the latest one follows a compaction summary again. `Skill` loads `project:<name>` from the
root conversation's latest usable project by reading its `SKILL.md` on the device, and a logged
project with skills offers `Skill`. Full-run replays copy the run's `project_root` as recorded.
