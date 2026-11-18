---
"@capybara-hq/kernel": patch
---

Dormant (the activation gate stays off): once the permission context is activated, a run start's
project knowledge read is a set of kernel reads under the run's claim while it is queued, each
narrowed to the project root, its `AGENTS.md` and its `.agents/skills`: with a restricted
read-only scope whenever the runtime enforces one, whatever the conversation's profile (a symlinked
`AGENTS.md`, skill directory or `SKILL.md` pointing outside the project is then no longer read);
under the conversation's Full access only on an isolated Full-only runtime (a cloud device, a local
machine in its Docker mode); and not at all on a host machine without restricted enforcement (the
project is recorded unreadable with the reason). A person's `/project:<skill>` renders a stub that
tells the agent to load the skill with `Skill` instead of reading the device at send time; an agent
without `Skill` lists no project skills and is refused (`skill_tool_off`). The device project
picker starts a stopped device for its owner before browsing it, and answers `device.not_running`
(409) when the instance stopped in between. Admission's working root falls back to the workspace
exactly as the command review does (no usable project snapshot, a root outside the reach or above
the home), with one shared project reach rule. A refused background start keeps the kernel's
reason in the task, never the provider's message. With the gate off nothing changes.
