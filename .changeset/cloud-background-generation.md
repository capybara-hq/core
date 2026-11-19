---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

`SandboxBackground.start` takes an optional `instanceGeneration`: the kernel passes its generation
of the held instance to a cloud provider, which cannot know it otherwise (it is allocated after
`create` returns) yet must name it in the reference the kernel acknowledges. Without it no cloud
background start could ever be acknowledged. A bound local device is not told; it knows its own.
