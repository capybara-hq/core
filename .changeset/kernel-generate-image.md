---
"@capybara-hq/kernel": patch
---

The builtin tool `GenerateImage` generates images with the organization's `image` purpose model and delivers them as artifacts of the conversation (all or none), records a `usage` event with purpose `image` and `outputImages`, and with `file_path` also writes them into the device, reviewed by the command review as a `Write`. It is listed only while the purpose maps to a usable image model and an object store is configured.
