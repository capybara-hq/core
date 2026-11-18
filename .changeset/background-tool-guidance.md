---
"@capybara-hq/capybara": patch
---

Bash, its run_in_background field, TaskOutput and the background launch result now tell the model
when the background is the right place (servers, watchers, long jobs it does not need yet), to run
a command whose result it needs in the foreground instead, not to pipe background commands through
tail or nest nohup, and to read servers' logs with TaskOutput block false.
