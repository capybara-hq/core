---
"@capybara-hq/kernel": patch
---

`extensionHost.dir` defaults to `.capybara/plugins` under the working directory instead of
`/var/lib/capybara/plugins`, so a kernel run from a source checkout can unpack its extensions
without root; the image keeps `/var/lib/capybara/plugins` (set by `CAPYBARA_EXTENSION_HOST__DIR`).
