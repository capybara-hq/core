---
"@capybara-hq/kernel": patch
---

Prompt suggestions: after a completed web run the worker sends one side request to the run's own
model (the run's last request plus the final reply and an instruction, `purpose: "suggestion"`),
fires the model hooks, logs a run-less `usage` event and stores the suggestion in a Redis key with
a bus message (queue `cap-kernel-suggestions`). On by default; the platform and org switches turn
it off.
