---
"@capybara-hq/plugin-sdk": minor
---

`sandbox@2` replaces `sandbox@1`: a provider makes an environment's file system
(`createFileSystem`, `destroyFileSystem`, `destroyFileSystemByName`, `FileSystemGoneError`) apart from
its instances, which attach to it and may be destroyed while the files stay; `create` takes an
optional `image` (without it the provider uses its own published image); skill paths carry a
digest (`/skills/<name>@<digest12>/`).
