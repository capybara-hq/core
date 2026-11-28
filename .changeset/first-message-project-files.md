---
"@capybara-hq/kernel": patch
---

`POST …/conversations/first-message` now forwards `projectFiles` (checked on the device and
logged as project file blocks, or refused with `conversation.project_file_unavailable`) and the
request's abort signal, like `POST …/conversations`.
