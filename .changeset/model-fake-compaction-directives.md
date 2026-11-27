---
"@capybara-hq/plugin-model-fake": patch
---

model-fake scripts the in-context compaction call from the conversation's own user messages:
`compact-fail:<kind>` fails it, `compact-tool:<name>:<json>` answers with a tool call even under
`toolChoice: "none"`, `compact-cutoff:once` / `compact-cutoff:always` answer past the output cap.
