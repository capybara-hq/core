---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

New builtin tool `TaskList`, offered with `Bash` like `TaskOutput` and `TaskStop`: it lists the
conversation's own background tasks (running first, then the 20 most recently finished, with id,
description, status, elapsed time, exit code and output file) and the sub-agents it dispatched.
Read-only and allowed by default; `status: "running"` lists only what still runs. `TaskOutput`'s
not-found error and the `Bash` description point to it.
