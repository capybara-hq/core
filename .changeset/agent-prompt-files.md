---
"@capybara-hq/kernel": minor
---

Agent definitions take the system prompt as named `.md` files (`instructionFiles`, 1–20 unique
names, at most 100 000 characters joined). The kernel joins them into `instructions`, which stays
the model-visible field (400 `agent.instructions_mismatch` when both are given and differ); a
definition without files reads as one `AGENTS.md`, and a new agent with no prompt gets a starter. `PATCH /agents/:id` with a definition but no `instructions` (and no
`instructionFiles`) now keeps the current prompt instead of clearing it.
