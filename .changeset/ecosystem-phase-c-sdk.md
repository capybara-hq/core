---
"@capybara-hq/plugin-sdk": patch
---

Sub-agents (package ecosystem phase C), additive:

- Hooks: `HookScope.parent` and `UsageReportPayload.parent` (`HookParentScope`: the parent
  conversation, run and call) are set when a hook fires in a sub-agent; `conversationKind` stays
  `chat` for sub-agents.
- `sandbox@1`: `SandboxProvider.concurrentExec`, an optional `tag` on `exec` (`SANDBOX_TAG_RE`) and
  `killTagged(handle, tags, signal)`. A provider that declares `concurrentExec` must implement
  `killTagged`, run commands of several holders at once and start a stopped instance idempotently
  under concurrent calls; a provider without them keeps today's one-command-at-a-time behavior.
- Plugin agent templates: `agents/<name>.md` (`AgentTemplate`, `parseAgentTemplate`,
  `AGENT_TEMPLATE_LIMITS`, `AGENT_TEMPLATE_NAME_RE`, `AgentTemplateTier`), listed in `plugin.json`
  `agents` (`PluginAgentRef`) or scanned, at most 64 per plugin (`PLUGIN_MANIFEST_LIMITS.agents`);
  the `plugin.json` JSON Schema is regenerated.
