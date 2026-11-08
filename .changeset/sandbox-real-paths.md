---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

Sandbox tools use the instance's real paths: `validateSandboxPath`, `skillSandboxDir`,
`skillSandboxPath` and `renderSkillBody` take an optional instance root; the kernel builds every
model-visible path from the held instance's roots, tool descriptions say "the workspace directory",
and a conversation in an environment with other roots gets one `environment_paths` system line.
