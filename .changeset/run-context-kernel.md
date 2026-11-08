---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-model-fake": patch
---

Agents know who they are and who they talk to (run context): run start writes a `run_context`
event (the agent version's name and description, the org, today's date, the time zone and language
of the person whose message started the run; a sub-agent's own name and who dispatched it), first
in full, then only what changed; the model sees it as a system message at its position and in full
again after a compaction summary. Every message records its sender (display name and org role; an
anonymous IM guest by IM name) and a sender line names it when the sender changes. Messages take
the browser's `timeZone` and `locale`; `GET` / `PUT /api/v1/me/preferences` sets a person's time
zone, the org settings an org default (`timeZone`). The agent definition gains `description`
(saved as a version; the profile PATCH no longer takes it). model-fake reads a message's script
without the sender line.
