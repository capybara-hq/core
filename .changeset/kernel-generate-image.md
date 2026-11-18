---
"@capybara-hq/kernel": patch
---

The builtin tool `GenerateImage` generates images with the organization's `image` purpose model and delivers them as artifacts of the conversation (all or none), records a `usage` event with purpose `image` and `outputImages` (never more than the images delivered; an answer whose usage is invalid fails as a server error before anything is recorded), and with `file_path` also writes them into the device with `Write`'s checks (the builtins' device entry, no directory, no overwrite of a file the conversation has not read), reviewed by the command review and the permission profile as a `Write`. It is listed only while the purpose maps to a usable image model and an object store is configured.
