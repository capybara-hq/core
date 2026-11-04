# pre-tool-rename

`conversation.json` is a genuine recording made by the release-candidate code (commit
`02b9634b`, before the tool names were aligned with Claude Code): `{ model, snapshot, requests }`,
the same shape as `../pre-rename/mcp-conversation.json`. `requests` are the requests the model
provider actually received, in order. It is never edited.

What it holds: one conversation, one agent, 21 runs on a model with a 5000-token window.

- every old builtin that runs under model-fake: the sandbox bash / read / write / edit / glob / grep
  tools, the skill load tool, tool search and the tool-output reader (the last on a 20 000-line
  archived output); `sandbox_deliver`, `skill_write`, `ask_user` and `agent` are not in it (they need
  an attachment store round trip, a person's answer or a sub-agent, which add nothing to the key mapping);
- a connector tool `docs__search` (fake MCP server) and an extension tool `tools-probe__echo` (with its approval);
- a pinned skill, a `claude-code` skill (so the snapshot carries the old tool map), a second version of a
  skill (the "Updated skills" notice), a person-invoked skill (`/fix-bug 12`) and a compaction that covers it
  (the "Skills the user invoked earlier" line).

## Recipe

Do not regenerate it with current code. At a scratch `git worktree add --detach <dir> 02b9634b`
(`pnpm install` there), copy the header and helpers of `packages/kernel/test/evals/reconstruct.test.ts`
(its first 380 lines: the kernel with `MODEL_FAKE`, `TOOLS_PROBE`, `SANDBOX_FAKE`, the object store, `seedSkill`,
`snapshotOf`, `captureProviderRequests`) into a throwaway test, add the `fake-connector` extension
with `startFakeMcpServer`, and drive the conversation with model-fake directives
(`tool:<key>:<json>`, `long:<n>`, a message with `skill: { name }`). At the end write
`{ model: <ModelInfo of the model>, snapshot: await snapshotOf(conv), requests: capture.sent }`
as JSON after `expectZeroDrift` passes. Remove the worktree afterwards.
