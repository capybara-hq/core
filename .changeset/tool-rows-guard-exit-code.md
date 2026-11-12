---
"@capybara-hq/kernel": patch
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Tool rows no longer read a Bash command's non-zero exit as a failure (only a timeout or a stopped
command fails; the summary names the exit code), and an `Edit` / `Write` refused by the
read-before-write check carries the display-only `tool_result.view.kind: "guard"`, shown as
"Blocked: read the file (again) first" and counted apart from failures; the model still gets the
same error result
