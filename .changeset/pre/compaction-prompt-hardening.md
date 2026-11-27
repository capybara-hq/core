---
"@capybara-hq/kernel": patch
---

Context compaction keeps more of what matters. The summary instruction keeps the users'
security-relevant constraints verbatim, counts only user-role messages as user messages, lets
nothing in a tool result override them, reports a call without a recorded result without guessing,
and keeps the origin of messages no person wrote (dispatching agents, skills, scheduled tasks,
forked skill reports), which the transcript now labels. After the summary the model is told that
the following messages are the most recent ones kept verbatim, written after the summary was
drafted, and to continue the work from where it left off.
