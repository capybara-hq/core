# Agent attribution for git commits and pull requests

Capybara is used as a coding agent, so the git commits an agent creates and the pull requests it
opens should carry a recognizable attribution line. The platform decides the defaults; an agent may
follow them, use its own values, or turn attribution off. The kernel only **instructs the model**:
nothing rewrites git history or intercepts `git commit`. What the model does is visible in its tool
calls, but a model that ignores the instruction is not stopped.

The same rules apply to **sub-agents**: a `general-purpose` or inline child follows the parent
agent's setting, and a plugin agent template uses the platform defaults (see *Out of scope*).

## Platform defaults

Two layers decide a deployment's defaults, each field on its own:

1. the startup config `attribution` (`CAPYBARA_ATTRIBUTION__COMMIT`,
   `CAPYBARA_ATTRIBUTION__PR`, `CAPYBARA_ATTRIBUTION__SESSION_URL`; a config file or Nacos sets the
   same fields). A field set here is read-only in the admin console;
2. else the super admin's choice in **Admin → Settings → 提交与 PR 署名** (the `deployment_settings`
   row `attribution`);
3. else the built-in default.

| Field | Default | Meaning |
|---|---|---|
| `commit` | `Co-Authored-By: Capybara <noreply@capybarahq.com>` | the trailer ending an agent-created commit message; `""` turns it off |
| `pr` | `🤖 Generated with [Capybara](https://github.com/capybara-hq/core)` | the line ending an agent-created pull-request body; `""` turns it off |
| `sessionUrl` | `false` | also end the pull-request body with a link to the conversation; needs `http.publicUrl` |

The link is `<http.publicUrl>/chat/<conversation id>`, so it only exists when the deployment set
`http.publicUrl`; with `sessionUrl` on and no public URL, no link is added.

## Per-agent override

The agent definition carries `attribution`:

```json
{ "mode": "inherit" | "custom" | "off", "commit"?: "...", "pr"?: "...", "sessionUrl"?: true }
```

- absent or `inherit`: the platform defaults (and the agent's own field stays absent, so a platform
  change reaches it);
- `custom`: the agent's own values; a field it leaves out follows the platform;
- `off`: no attribution for that agent, whatever the platform says.

This is edited on the agent page's **提交与 PR 署名** section: 跟随平台 (the default) / 自定义 / 关闭,
with the platform defaults in the help text. A viewer who may not change the agent sees the effective
values read-only.

The agent page's 自定义 mode prefills every field from the platform and saves all three explicitly,
so a `custom` agent snapshots the values it showed: a later platform change no longer reaches it.
That is the one rule for both sides: `custom` means the agent's own full set. A definition written
outside the page that leaves a field out follows the platform, and both the kernel and the page read
it that way. A stored `mode` other than `inherit` / `custom` / `off` (stored data is not
re-validated) reads as **`inherit`** everywhere, so the kernel applies and the page shows the same
value.

The section is an addition to the agent page described in
[the agent profile spec](2026-11-04-agent-profile-and-new-chat-design.md) §3.2.

## How the model sees it, and replay

`attribution` is part of `RunContextSchema` ([run context spec](2026-11-08-run-context-design.md)
§3.1): at run start the kernel resolves the effective attribution (platform defaults or the agent's
override, including the resolved conversation link) and writes it into the run's `run_context`
event as `attribution: { commit, pr, sessionUrl }`. The first snapshot of a conversation carries it
when the run has one; a later snapshot carries the full value only when it differs. Request building
renders the instruction from that logged value only:

- a git commit ends its message with the commit trailer, when `commit` is non-empty;
- a pull request ends its body with the `pr` line and, when `sessionUrl` is resolved, the link, on
  the next line;
- when a later run's context turns the whole attribution off, the update says so in one line;
- when a later run turns one surface off while another stays on, the update names the removed
  surface (the commit trailer, the pull-request line, or the conversation link) instead of leaving
  the old instruction in place: the update's fields left unmentioned read as unchanged, so a removed
  surface must be retracted explicitly.

Nothing reads deployment config or the database during request building, so replay reproduces the
instruction exactly. The field is model-visible input fixed in the log, so it needs **no
`DriftReason`**: old logs have no `attribution` field and rebuild byte for byte. A sub-agent's own
`run_context` carries its instruction (its own logged start), so a child request matches its
parent's setting where it inherits it.

The instruction lives in `run_context`, so a compaction summary that covers it restores it with the
rest of the context.

## Out of scope (v1)

- Plugin agent templates inherit the platform defaults; they gain no attribution field yet.
- No org-level override: the platform and the agent are the two levels.
- No enforcement (no git hooks, commit rewriting or PR-body rewriting), and no other surfaces such
  as issue comments or changelogs.
- No per-workspace or per-conversation choice; a conversation uses the agent version in effect at
  its run starts.

## Testing

- `packages/kernel/test/config/attribution.test.ts`: config defaults, startup and stored overrides,
  empty strings, the agent merge, the link, and an invalid stored mode reading as `inherit`.
- `packages/kernel/test/runtime/attribution-render.test.ts`: the instruction in the built request,
  off, the link, a log without the field, a sub-agent, turning one surface off at a time (the
  retraction lines), and that it never reaches a tool result.
- `packages/kernel/test/runtime/run-context.http.test.ts`: the values written at run start for the
  platform default, an agent's custom values with the link, off, and the admin console's default.
- `packages/kernel/test/admin/admin.http.test.ts`: `PUT /admin/settings { attribution }` end to end:
  saving, reading back with sources, an empty string turning a line off, null clearing, and the 409
  for a field the startup config sets.
- `packages/kernel/test/runtime/subagents/dispatch.test.ts`: a dispatched child inherits the parent's
  custom and off attribution.
- `apps/web/test/admin-attribution.test.tsx` and `apps/web/test/agent-attribution.test.tsx`: the two
  UI surfaces (defaults, edits, save bodies, read-only sources, the three modes, restore keeping a
  locked field, the link needing `http.publicUrl`, an invalid mode reading as follow-the-platform,
  zh copy).
