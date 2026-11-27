---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

A streaming `Write` from a model that sends `content` before `file_path` now gets a live diff: the
kernel guesses the file from the conversation's recent unchanged files, the row marks the path as a
guess until the path confirms it, and a wrong guess is withdrawn at once. `Write`'s `file_path`
description asks for the path first, and each streamed `Write` logs its input order.
