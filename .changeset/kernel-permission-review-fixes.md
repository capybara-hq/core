---
"@capybara-hq/kernel": patch
---

A background `Bash` call whose launch was revoked or given up before its start was confirmed no
longer says the task was not started and that nothing runs: the process may have started, so the
call says so, that any process it started is being stopped, and to check its effects before
calling `Bash` again. `TaskList`, `TaskOutput` and the finished-task message show such a task's
reason (`launch_unknown`, `launch_revoked`) as text, not as a raw code.
