---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

Extension points list the majors the kernel accepts (`EXTENSION_POINTS[name].majors`). The kernel
refuses a plugin that provides an unsupported major (such as `sandbox@1`) with
`extension.unsupported_extension_point` and asks it to upgrade.
