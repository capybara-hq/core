---
"@capybara-hq/capybara": patch
---

Bash, its run_in_background field, TaskOutput and the background launch result now tell the model
when the background is the right place (servers, watchers, long jobs it does not need yet) and to run
a command whose result it needs in the foreground instead; TaskOutput is for reading logs (block
false for servers and watchers) and collecting output after the notification.
