---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

The SDK ships agent docs (`agent-docs/`: platform concepts, plugin format, skills, agent and
connector templates, tool naming, writing an extension, one topic per extension point), served by
the kernel's `AgentDocs`. `ExtensionPointInfo` gains `description`, and `package.json` is an
exported subpath. `check:agent-docs` keeps the generated field tables in step with the schemas.
