---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

Sandbox tools use the instance's real paths: `validateSandboxPath`, `skillSandboxDir`,
`skillSandboxPath` and `renderSkillBody` take an optional instance root, `validateSandboxPathShape`
checks a path without its roots, and device protocol roots must be clean absolute paths; the
kernel builds every model-visible path from the held instance's roots, tool descriptions say "the
workspace directory", and each conversation records its environment's directories in an
`environment_paths` system line on its first sandbox call and whenever they change.
