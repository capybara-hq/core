---
"@capybara-hq/web": patch
---

The conversation page shows background Bash tasks: the properties panel's background section lists running tasks next to the sub-agents (a sub-agent's own tasks nested under it) with stop, a task opens its output in the right panel (`#bg-<taskId>`, read again every 2 s while it runs), a background `Bash` row reads "In background" and links its task, `TaskOutput` / `TaskStop` rows name the task, and a finished task is a one-line notice in the thread.
