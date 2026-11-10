---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A message from the run's starter skips the run's pending questions: the question becomes `skipped`
(migration 0108), `question_answered` carries `outcome: "skipped"` and `skippedBySeq`, the run
resumes at once and the kernel writes a fixed result (the tool is not called again; MCP elicitation
and extension input requests too); the message follows as an ordinary user message. Every question
write locks the conversation row first. IM question cards carry `textReply` (`plain` in a DM,
`mention` in a group thread) and the `skipped` state; trajectories show the skip.
