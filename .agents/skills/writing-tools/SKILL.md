---
name: writing-tools
description: 'Use when adding or modifying tools for an agent: extension tools via ctx.tools.register (reference plugins/todo), kernel builtin tools, and the rules shared by connector tools. Covers tool naming and keys, English descriptions and actionable error text (the pnpm check tool design rules), annotations, defaultPolicy and policy_source, ToolError and kind (circuit breaker), timeouts and abort, output size and archiving (read_tool_output, {"$output": id}), InputRequired and resume, tool_search, tool definition drift and review; the builtin sandbox tools sandbox_* (sandboxToolPolicy) and the skill tools skill_load (also <plugin>:<name>) / skill_write (writePolicy, change approval), pinned skills (skills.pinned); the builtin agent tool (sub-agents); PLUGIN_UNLOADED_TOOL_ERROR when an extension is disabled mid-call; and extension hooks in a tool call (tool.preExecute, tool.postExecute). For connectors see writing-connectors.'
---

# Writing tools

**Where this goes after the repository split** (phase A3b, spec §6.2): the official plugins move to `capybara-hq/plugins` and the author half of this skill moves with them; author tooling is `capybara-plugin pack | check` (`@capybara-hq/plugin-tools`, `.agents/skills/writing-plugins` "Toolchain"; in core `pnpm pack-plugin` and `pnpm check`). **Stays in core**: kernel builtin tools (`sandbox_*`, `skill_load` / `skill_write`), policy, archiving, `tool_search`, drift review and resume, tested on the `fake-tools-ui` and `fake-connector` extensions of `@capybara-hq/testing`. Moves: "Extension tools" and the description / error rules as an extension author applies them (the tool design check runs in `capybara-plugin check`), with `plugins/todo`.

## What this skill covers

Adding or modifying tools for an agent. Covers extensions registering tools with ctx.tools.register (reference plugins/todo), kernel builtin tools, and the rules shared by connector tools. Tool naming and keys, English descriptions and actionable error text (the pnpm check tool design rules), annotations and default policy, defaultPolicy and policy_source, ToolError and kind (unavailable counts toward the circuit breaker), timeouts and abort, output size and archiving (limited to the conversation, read_tool_output, {"$output": id}), InputRequired and resume, tool_search (catalog, loaded set, descriptions are searchable), tool definition drift and review, extensions must be enabled in the org; the builtin sandbox tools sandbox_* (per-tool timeouts and spill thresholds, sandboxToolPolicy, first-use / recreate notices) and the skill tools skill_load / skill_write (catalog snapshot, R3 fixed ask for shared agents, the writePolicy switch for private agents, change approval, customSkills does not affect skill_write); the tool error when an extension is disabled / upgraded mid-call (PLUGIN_UNLOADED_TOOL_ERROR); and where extension hooks sit in a tool call (tool.preExecute denial text hookDeniedText, tool.postExecute). For writing connectors see writing-connectors.

General extension authoring (manifest, config, ctx, the multi-replica prohibitions, dual-replica tests) is in `.agents/skills/writing-extensions`; this skill covers only what is specific to tools. Reference implementations:

- Extension tool: `plugins/todo` (one `write` tool, writes the whole list into the extension's schema, default allow).
- Connectors: `plugins/connector-mcp` (`connector@1`, connects a remote MCP service as a connector); `plugins/connector-openapi` (an HTTP API described by OpenAPI 3.0 / 3.1, one tool per operation, implements `inspect`).
- Kernel builtin tools: `packages/kernel/src/tools/builtins` (`ask_user`, `read_tool_output`, `tool_search`; the sandbox tools `sandbox_*`
  are in `builtins/sandbox/`; the skill tools `skill_load` / `skill_write`). See "Kernel builtin tools: sandbox and skills" below.

All tool execution goes through the kernel pipeline `packages/kernel/src/tools/pipeline.ts`: resolve `{"$output": id}` references -> ajv validates the arguments -> policy decision (allow / ask / deny) -> write `tool_call_started` -> execute (timeout + abort) -> render the result -> spill oversized results -> write `tool_result`. An extension only "does the work and returns the result"; approval, timeouts, archiving, audit and redaction are the kernel's job, and **must not be reimplemented in the extension**.

## Three tool sources and keys

The tool name (key) the model sees must match `^[a-zA-Z0-9_-]{1,64}$`:

| Source | key | Naming rule |
|---|---|---|
| builtin | the name itself: `ask_user`, `read_tool_output`, `tool_search`, `sandbox_bash`, `skill_load` | lowercase + underscores, **no dots** (Ruling M12) |
| extension | `<plugin>__<tool>`, e.g. `todo__write` | `spec.name` matches `^[a-zA-Z0-9_-]{1,40}$` (`EXTENSION_TOOL_NAME`) |
| connector | `<connectorSlug>__<tool>`, e.g. `docs__search` | slug `^[a-z][a-z0-9_]{0,23}$`, no consecutive / trailing underscores; the tool name is decided by the remote |

A key that is too long or contains illegal characters is **neither truncated nor guessed**: saving an agent reports `validation_failed`; a connector tool is disabled at install / refresh with the reason written in `issues`. Name tools with lowercase + underscore verb phrases (`write`, `search`, `delete_doc`), and don't write the extension name into the tool name again (the key already carries the prefix).

An agent definition selects tools by reference: `{kind:"builtin",name}`, `{kind:"plugin",plugin,name}` (stored refs keep the field names `kind:"plugin"` / `plugin`; the value is the extension name), `{kind:"connector",connectorId,tools:"all"|string[]}`. At runtime they are resolved live on every step (`ToolRegistry.forAgent`); unavailable tools (extension not enabled, connector disabled / deleted, tool pending review, etc.) are skipped and an English `reminder` is written (`The following tools are unavailable in this run: <key> (<reason>), …`); if the model still calls one it gets `Tool "<key>" is unavailable: <reason>.`, and the run does not fail.

## Extension tools: `ctx.tools.register`

```ts
import { defineExtension, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";

const SPEC: ToolSpec = {
  name: "write",
  description:
    "Create and update the task list for the current conversation. Use it for work with three or " +
    "more steps … Do not use it for a single trivial task.",
  inputSchema: { type: "object", properties: { /* … */ }, required: ["todos"], additionalProperties: false },
  defaultPolicy: "allow",
};

export default defineExtension({
  name: "todo",
  // …
  setup(ctx) {
    ctx.tools.register(SPEC, async (input, call) => {
      // call: { orgId, accountId, agentId, conversationId, callId, signal, resume? }
      // …validate, write ctx.db…
      return { content: [{ type: "text", text: "Todo list updated (3 items): …" }] };
    });
  },
});
```

- **Register only during `setup`**; calling it afterwards throws; names must be unique within an extension; `validateToolSpec` validates at registration (name, non-empty description, inputSchema is an object, `defaultPolicy` may only be `allow` / `ask`).
- **An extension tool is available only in orgs that have enabled the extension** (Ruling A5, unlike model providers): an org admin needs `PUT /api/v1/orgs/:orgId/extensions/<plugin> {"enabled": true}`. When not enabled, an agent can still save the reference (only that the extension is registered is checked), and at runtime it is treated as "unavailable" (see above). Connectors are deployment-level and need no per-org enabling.
- State in the handler follows the multi-replica discipline: persistent data goes in `ctx.db` (todo upserts one row per `conversationId`), not in a module-level Map.
- The handler **must respond to `call.signal`** (the signal merging the `tools.timeoutMs` timeout and the run abort): pass it to `fetch` / database queries and so on. The kernel races the handler, so a timeout result is returned on time even if you don't respond, but your side effects may still be running.
- Arguments have already been validated against `inputSchema` with ajv (2020-12) before the call; when invalid, the model gets all error paths + the full inputSchema and the handler is not called. In the handler, parse once more with zod to get types, and throw `ToolError` on a parse failure (see below).

## Descriptions and error text (model-visible, always English)

`pnpm check` (`check:tool-design`, `packages/plugin-tools/src/check/tool-design.ts`) checks statically:

| Rule id | Requirement |
|---|---|
| `tool-description` | The `spec.description` of `ctx.tools.register(spec, …)` and of builtin `BuiltinTool` literals is a string literal (may be joined with `+`, may reference a const in the same file), ≥ 20 characters, with no Chinese |
| `tool-error-actionable` | The msg of `new ToolError(msg)` is a literal / template (or a constant or function return value in the same file) and contains one of the suggestion verbs `use` / `call` / `retry` / `check` / `ask` / `pass` / `provide` |

Writing requirements beyond the checks:

- **A description covers three things**: what it does, when to use it, and when not to; for side effects, state them (e.g. "Each call replaces the whole list"). Give every inputSchema field a `description`, and give examples.
- **Errors give facts and a next step**: say what went wrong and what the model should do next (retry with different arguments, call another tool first, ask the user to handle it). Examples: `Invalid todos: pass an array of items with content, status and activeForm, where status is pending, in_progress or completed.`; `Authentication failed for this app; ask the user to reconnect it.`
- Don't echo credentials, internal paths or stack traces in errors; no fuzzy matching ("did you mean to call X").
- Text shown in the UI (form titles, field labels) may be given bilingually as `{ zh, en }` and goes through i18n; text for the model is English only.

## Annotations and default policy

`ToolSpec.annotations` (aligned with MCP): `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, `requiresUserInteraction`.

- Default policy: an extension / builtin tool that declares `defaultPolicy` uses it; otherwise it is derived from the annotations: `readOnlyHint: true` -> `allow`, everything else (including no annotations, and destructive) -> `ask` (`policyFromAnnotations`). A connector tool's policy is derived from the annotations at install time and stored in `connector_tools.default_policy`, and admins can change it.
- Declare `defaultPolicy: "allow"` only for a tool that truly has no side effects, or whose side effects land only in this conversation (such as todo); when unsure, don't declare it and let it go through `ask`.
- The final policy takes the strictest at **the moment of execution**: the org default policy, the agent's `toolPolicies` (which can only tighten to `ask` / `deny`), `requiresUserInteraction` and the R3 list (at least `ask`, and remembered grants don't apply to them; `skill_write` is fixed to ask for shared agents, and for private agents is fixed to ask only when `skills.writePolicy = "ask"`, see below); a user's remembered grant (allow for this conversation / from now on) can only let an `ask` through as `allow`, becomes invalid when the `spec_hash` changes, and never overrides `deny`.
- `ask` -> the kernel creates an approval and the run goes to `waiting` (it holds no conversation lock or quota), and resumes from the checkpoint after approval; rejection / timeout (`tools.approvalTimeoutHours`) / abort while waiting are all written as a rejection in `tool_result`. The extension doesn't need to care.
- **Deny reason and asking policy** (UI refresh B, Task 6): `POST …/approvals/:id/decision` takes an optional `reason` (trimmed, 1–500 characters, only with `deny`, else 400 `validation_failed`). It is stored (`approvals.deny_reason`, `denyReason` on the record), written to `approval_decided.reason` (at most 500 characters in the schema too) and given to the model as the denied call's result `An approver denied this tool call. Reason: <reason>` (in the log, so replay needs nothing; the first B events said `The user denied this tool call. Reason: …` and keep it; under role escalation the approver is an admin, not the requester). `approval_requested.policy` names the rule that asked, most specific first: `role` (R1 escalation), `agent` (`toolPolicies`), `connector` (the connector tool's policy), `fixed` (R3, `requiresUserInteraction`, `skill_write` on shared agents), `org` (the org `sandboxToolPolicy` made a sandbox tool ask), else `default` (the tool's own default); display only, absent in older logs (and `org` / `fixed` read as `default` in the first B events).
- **NUL bytes**: PostgreSQL jsonb rejects `\u0000`, so the event log stores every NUL in a payload string or key as U+FFFD (`payloadJson`, `conversations/event-log.ts`); a file read or command output with NUL reaches the model and the log as U+FFFD instead of failing the run. Views map NUL to U+FFFD too, and `sandbox_write` shows no diff when the old file has a NUL anywhere. A display-only read that fails never fails the tool. Diff views are capped at 2000 lines and 256 KB of line text (`TOOL_VIEW_DIFF_MAX_TEXT_BYTES`); `sandbox_write` reads at most 1 MiB of the old file for the diff.

## Display metadata: `title`, `keyArgs`, kinds and views

The conversation page shows a tool call as one row, "verb + source: title + key arguments" (design spec §6.16.9). What it reads, none of which reaches the model:

- **`ToolSpec.title`** (optional, 1–80 characters, one line, English or the tool's own wording): a short human title, e.g. "Search messages". It wins over the key on the row, but the approval block always shows the key too (and every argument), because the title is unreviewed text. No control, bidi or invisible characters (Unicode Cc / Cf: newlines, U+202E, U+2066–2069, U+200B, U+FEFF, U+200E/F, U+061C, tag characters, ...; ZWNJ U+200C and ZWJ U+200D are allowed, scripts and emoji sequences need them): `validateToolPresentation` rejects them; conversation titles (rename and generated) use the same rule (`packages/kernel/src/text.ts`). Remote titles are cleaned instead: the kernel (`sanitizeToolTitle` in `tools/drift.ts`, the authority every connector passes) removes Cf except ZWNJ / ZWJ, turns Cc into spaces, collapses whitespace, trims, cuts to 80 and then validates; a title that is empty afterwards is dropped. `connector-mcp` copies the MCP tool's `title` (or `annotations.title`) and cleans it the same way; the description fallback for a tool without a description stays. Builtins declare no title (the web has localized words per kind).
- **`ToolSpec.keyArgs`** (optional, at most 3 unique names, each a property of `inputSchema.properties`, no Cc / Cf characters): the input values shown in body color, in order, e.g. `["query", "channel"]`. Without it the web shows the first string argument. Builtins: `sandbox_bash` `command`, `sandbox_read` / `sandbox_write` / `sandbox_edit` / `sandbox_deliver` `path`, `sandbox_glob` `pattern`, `sandbox_grep` `pattern`, `path`, `skill_load` `name`, `tool_search` `query`.
- `validateToolPresentation` (SDK) checks both; `validateToolSpec` includes it, so an invalid one makes `ctx.tools.register` throw at setup naming the field. A connector's invalid `title` / `keyArgs` are dropped from the snapshot rather than disabling the tool.
- **Not part of the definition fingerprint**: `specHash` hashes the spec without `title` and `keyArgs` (`DISPLAY_ONLY_SPEC_FIELDS` in `tools/registry.ts`), so adding or changing them never changes a fingerprint, never sends a connector tool to drift review, never invalidates a remembered grant and never changes `model_call.request.tools`. A connector refresh that changes only these fields updates the stored definition in place, with no drift review and no audit row, only an info log line `connector.tool_display_updated` (connector id, tool name). `tool_specs` keeps whatever was stored first under a hash, so titles are never read from it: display reads current metadata, and eval or trajectory viewers must not show a title from `tool_specs` either (pinned by a test in `info.test.ts`). A pre-B extension written without the SDK types that already passed a top-level `title` gets a new fingerprint for that tool (grants and eval cases see a changed definition); `registry.test.ts` pins a literal hash of a fixed spec.
- **Kinds** (`ToolKind`, kernel `tools/info.ts`) pick the row verb and the group counts: `command` (`sandbox_bash`), `read` (`sandbox_read`), `edit` (`sandbox_write`, `sandbox_edit`), `search` (`sandbox_glob`, `sandbox_grep`), `connector` (every connector tool), `meta` (`tool_search`, `skill_load`, `skill_write`, `read_tool_output`, `ask_user`), `tool` (extension tools, `sandbox_deliver`, anything unknown).
- **The tools route**: `GET /api/v1/orgs/:orgId/conversations/:id/tools?keys=a,b` (`agents.use`, the same visibility as the events API: `conversation.not_found` otherwise; at most 100 keys of at most 200 characters, else 400 `validation_failed`) returns `{ tools: ToolInfo[] }` with `key`, `title`, `kind`, `keyArgs` and `source` (`{ kind: "builtin" }`, `{ kind: "extension", name }`, `{ kind: "connector", id, name }` or `{ kind: "unknown" }`). It reads the connector's current stored tool and the loaded extension's registration; an unknown key comes back as `kind: "tool"`, `title: null`, `keyArgs: []`, `source: { kind: "unknown" }`. Extension tools resolve deployment-wide, not per org: a tool of an extension not enabled in this org still answers `source: extension` with its title (old logs keep their labels; the data is not sensitive). A key whose prefix is both a loaded extension's name and a connector slug resolves to the extension; the registry's `claim()` reports that collision when an agent's tools are built, so here it only changes the label.
- **`sandbox_bash` `description`** (UI refresh B, Task 5): a required argument, a few words saying what the command is for; the shell row shows it instead of the command. A missing one is an ordinary validation error the model fixes. Replay matching ignores it, so recordings with and without it match.
- **`tool_result.view`** (UI refresh B, Task 5; builtins only, display only): `command` (`description`, `exitCode`, `timedOut`), `edit` (`path`, `created`, `added`, `removed`, a capped line diff) or `read` (`path`, line range). The row shows "Failed" for a non-zero exit or a timeout even though `isError` stays as before (timeout or abort only). The diff is capped at `TOOL_VIEW_DIFF_MAX_LINES` (2000) lines with `truncated: true`; a side over 1 MB gets counts only, and `sandbox_write` over a binary or over-10-MiB file carries no view. An invalid view is dropped with a warning (`ToolViewSchema`). Request building and compaction never read it.

## Results, `ToolError` and failure

- Return `{ content: ToolContent[], isError? }`. `text` is concatenated as is; for `image` / `resource_link` the model gets a type description (not dropped). `isError: true` means "the tool ran but the result is an error", and the content is still given to the model.
- Throw `ToolError(message)`: the message is given to the model **as is** (so it must be English and actionable). An optional second argument `{ kind: "unavailable" }` means the remote is unavailable (can't connect, HTTP 5xx) and is meaningful only for connectors; the default `kind: "error"` (argument errors, business errors, authentication failures, etc.) means the remote is reachable. Circuit breaker semantics (Ruling A15): the connector-level circuit breaker counts only "remote unavailable": timeouts, transport / connection errors (exceptions that are not `ToolError`), and `kind: "unavailable"`; a `ToolError` with `kind: "error"` and `isError` results both mean the remote is reachable and reset the count. Extension tools and builtin tools are not affected by the circuit breaker.
- **Display summary `display` (optional, for humans only)**: `{ content, display: { summary: { zh, en } } }`; the tool call line in the conversation stream shows this sentence (for example todo's "更新任务清单（3 项）" / "Updated task list (3 items)") instead of the raw input JSON. Both Chinese and English are required, each ≤ 200 code points (`validateToolDisplay`); the kernel drops an invalid one and logs a warning, and the result is written as usual. The summary goes into the log with the `tool_result` event (so a page refresh can restore it) and **does not go into the model context** (request rebuilding uses only content / isError), so don't put information the model needs only in the summary. Only summaries from extension tools, kernel builtin tools and the kernel's resources tools are honored; connector tool results are not trusted (the web falls back to "tool name + the first few input fields"). The builtin tools `ask_user` / `read_tool_output` / `tool_search` all give summaries.
- Throwing any other error: the model sees only `Tool <key> failed (<ErrorName>). The operation may not have completed; check before retrying or try another approach.`, and the error details go into the log (redacted). Don't rely on the exception message to pass information.
- Timeout: `Tool <key> timed out after <n>s. The operation may or may not have completed; verify before retrying.`
- **The extension providing a tool is taken down mid-call** (disabled / uninstalled / upgraded to a new instance on the deployment, C17): the kernel first stops accepting new calls, and waits for in-flight calls for up to `extensionHost.drainSeconds` (default 30 seconds); calls still unfinished at that point have `call.signal` aborted, and the model receives `PLUGIN_UNLOADED_TOOL_ERROR` (`extensions/inflight.ts`: `The plugin that provides this tool was disabled or upgraded while the call was running, so the call was aborted. Retry if the tool is still available.`). In later steps, an extension tool that this replica no longer has is treated as an unavailable tool (reason `Plugin tool does not exist`; when the org hasn't enabled it, `Plugin <name> is not enabled in this organization`). So the handler must honor `call.signal`, and long operations should be abortable and retryable.
- **Don't blindly rerun side effects** (spec 4.3): the kernel writes `tool_call_started` before executing. If the process crashes mid-execution, on resume the result of this call is written as `Result unknown: the call was interrupted before a result was recorded. Verify the outcome before retrying.`, and **your handler is not called again**. So the handler needn't be idempotent against "replay by the kernel", but the model may see "result unknown" and retry itself; where possible make write operations naturally idempotent (such as todo's whole-list overwrite).

## Output size and archiving

- When a rendered result exceeds `tools.outputSpillChars` (default 50000 characters), the full text is stored in the output archive (`tool_outputs`, kept for `tools.outputRetentionDays` days), and the model sees only the first `tools.outputPreviewChars` (default 2000) characters and a note: `[Output truncated: … Full output id: <id>. Use read_tool_output to page through it, or pass {"$output":"<id>"} as a tool argument.]`.
- The model uses the builtin tool `read_tool_output {id, offset?, limit?, charOffset?}` to read the archive page by page by line (each read at most `tools.maxResultReadChars`).
- A `{"$output": "<id>"}` anywhere in the arguments (an object with exactly this one key) is replaced with the full text of that archive before validation, so a large result can be passed straight to the next tool without going through the model context. The handler sees the replaced value.
- An archive **belongs only to the conversation that produced it**: `read_tool_output` and `$output` can read only archives of the same conversation (and the same org), and ids from other conversations are always treated as "not found or expired" (different conversations have different visibility scopes, so an id can't be used to read results across conversations).
- So an extension **should not truncate** large results or invent pagination itself; just return the full text. For truly unbounded data (a whole-database export), set a limit or pagination parameters at the tool level and say so in the description.

## Needing user input: `InputRequired` and resume

A handler can return `{ kind: "input_required", form, state? }` instead of a result: the kernel validates the form (`validateInputForm`; field schemas use only the ParamSchema subset, and enums can be `multiSelect` / `allowOther`), creates an input request, and the run pauses. After the user submits (or on timeout / cancel), the kernel **calls the handler again with the same input** and passes `call.resume = { state, answer }` (`answer` is `null` on timeout / cancel).

```ts
async (input, call) => {
  if (!call.resume) {
    return { kind: "input_required", form: { title: { zh: "确认", en: "Confirm" }, fields: [ /* … */ ] }, state: { step: 1 } };
  }
  if (call.resume.answer === null) throw new ToolError("The user did not answer; ask again later or try another approach.");
  // continue with call.resume.state / answer
}
```

- `state` must be JSON-serializable and ≤ 16 KB; it is stored in PG and the resume may happen on another replica, so **don't keep anything the resume needs in memory**.
- The same call may request input at most 3 times in a row; the 4th -> `Tool requested user input too many times.`
- The builtin `ask_user` is implemented with this mechanism and can serve as a reference.
- MCP connector elicitation (the remote asking the user for input mid-call) is turned by the kernel into the same input request: the kernel aborts the remote call, and after the user answers re-issues the call with the **same input**, and when the remote raises the same elicitation again it is answered with the answer (at most 3 rounds; if the remote stops asking or changes the schema the answer is unused, and side effects before the elicitation are redone once). This is between the connector and the kernel; details are in `.agents/skills/writing-connectors`, and extension tools are not involved.

## `tool_search`: the catalog and on-demand loading when there are many tools

When the number of available tools exceeds `tools.searchThresholdTools` (default 30) or the estimated tokens of their definitions exceed `tools.searchThresholdTokens` (default 8000), and the org setting `toolSearch` is `on` (the default; an admin changes it through `PATCH /api/v1/orgs/:orgId/settings {"toolSearch":"on"|"off"}`), the kernel enables `tool_search` for that agent (`ToolRegistry.forAgent` decides live on every step, and the registry appends it; it is not in the agent definition):

- The `tools` sent to the model contain only the builtin tools (`ask_user`, `read_tool_output`, `tool_search`, always fully loaded) and the full definitions of **loaded** tools; the remaining tools appear as a "catalog" in the second block of system: one line each, `- <key>: <first line of the description>` (truncated beyond 200 characters), sorted by key. The catalog depends only on the tool set and not on loading state, so the cache prefix is stable.
- The model calls `tool_search {query, limit?}` (`limit` defaults to 5, max 10): it scores **the tools in the catalog** deterministically by keyword (a word in the key weighs twice as much as one in the description, rarer words weigh more, ties are sorted by key), returns the full definitions (name, description, inputSchema) of the matching tools, and loads them into `tools` from the **next step** on.
- The loaded set = the union of all `tool_result.loadedTools` in the conversation log (including those before a compaction summary; ones no longer available this step are ignored), so it is reconstructed from the log alone. A tool just loaded by `tool_search` in the same step is rejected if called immediately (`Tool "<key>" is not loaded. Call tool_search first…`, since the model did not have its definition when forming that call); the same goes for calling a catalog tool that isn't loaded, and the kernel does not auto-load.

**What this means for tool authors**:

- **The description is searched, and is the only text in the catalog**: write the keywords for "what it does, the object, the action" (`create calendar event`), the **first line** must explain the tool's purpose on its own (the catalog takes only the first line); put the object and action words in the description or the tool name so the model can find it.
- Words in the tool name (key) weigh more, so naming with a verb phrase (`search_docs`) helps matching.
- Don't make a tool builtin or add it to the agent's system prompt just to "make sure the model always sees it"; when there are many tools it should go through the catalog anyway.
- In a small deployment (fewer tools than the thresholds) all tools are fully loaded as before, and `tool_search` doesn't appear.

## Tool definition drift and review

A connector tool's definition comes from the remote and may be changed (spec 7.3, against rug-pulls / tool poisoning). The kernel (`packages/kernel/src/tools/drift.ts`) re-runs `listTools` and compares with the snapshot every `tools.driftIntervalHours` hours, when the connector sends `onToolsChanged`, and when an admin calls `POST .../connectors/:connectorId/refresh`:

- A new tool -> `pending_review`;
- **Any spec change** (description, `inputSchema`, annotations, `connectorData`, i.e. `spec_hash` or the source changed; `connectorData` counts toward the hash) -> `pending_review`, the new definition is stored in `pending_spec` and the old one is kept for comparison; the same for a tool an admin had disabled; a definition that becomes non-compliant likewise goes only into `pending_spec` (the tool is disabled, approve is refused, reject clears it), and `spec` is always the definition that last passed review;
- A tool that has never been reviewed (`reviewed_at` is empty: new and pending review, or a rejected new tool) has no old definition to compare with, and when it changes again `spec` is replaced directly (still pending review);
- Disappearing -> `disabled` and marked `missing` (reappearing is treated as new).

`pending_review` / disabled tools do not enter `forAgent`: ones named by reference go into `unavailable` (the model is reminded every step), ones from a `tools: "all"` reference go into `hidden` (no reminder, and the model gets the factual reason when it calls one). An admin calls `POST .../connectors/:connectorId/tools/:name/review {action: "approve" | "reject"}`: approve adopts the new definition, enables it and records `reviewed_at`; reject disables it and keeps the old definition (a never-reviewed tool that is rejected keeps `reviewed_at` empty and can still be approved later); a tool pending review or never reviewed can't be enabled through PATCH. Grants are compared by `spec_hash`, so after the new definition is adopted the old "remembered grants" lapse naturally.

**Default policy and `policy_source`**: a connector tool's default policy (`connector_tools.default_policy`) is derived from the annotations (`policySource: "derived"`), `"admin"` if an admin changed it, and `"template"` if installed from a plugin's connector template and taken from the template's `defaultToolPolicies` (kept like `admin`, see `.agents/skills/writing-plugins`). When approve or a refresh adopts a new definition, `derived` ones are re-derived from the new annotations (annotations getting stricter, such as `readOnlyHint` becoming destructive, also turn it into ask and do not keep the old allow); `admin` ones are kept unless the tool's source (`source`) changed. Extension / builtin tools have no such layer: use `defaultPolicy` or annotations (see above).

Credentials used by the admin console checks: the org credential; for personal-credential connectors, it tries the personal credentials of up to 3 current members in turn (in descending order of the credential's last write time), and if there are none it skips and logs. Audit events `connector.tools_drifted` (only counts) / `connector.tool_reviewed`.

Connector authors should note: the output of `listTools` must be deterministic, otherwise it will trigger review again and again (see `.agents/skills/writing-connectors`).

## Kernel builtin tools: sandbox and skills

Builtin tools (`BuiltinTool`) have three optional extras over extension tools: `timeoutMs(input)` overrides `tools.timeoutMs`; `spillChars` gives a spill threshold lower than
`tools.outputSpillChars` (the smaller of the two is taken); `unavailable()` returns the English reason it is unavailable in this deployment (the registry reports
unavailable accordingly). The name of a new builtin tool must be added to `BUILTIN_TOOL_NAMES`. When a builtin tool writes its own events, use `ctx.runId` and a unique idempotency key, and commit them in
the same transaction as the business rows.

**Sandbox tools** (Ruling M12: keys contain no dots): `sandbox_bash`, `sandbox_read`, `sandbox_write`, `sandbox_edit`,
`sandbox_glob`, `sandbox_grep`, `sandbox_deliver`.

- They exist only when the agent definition references them explicitly (`DEFAULT_AGENT_TOOLS` does not include them); when the deployment has no sandbox extension they are reported unavailable (`unavailable()`).
- All go through `SandboxService.withSandbox` (one sandbox per conversation, created lazily, see `.agents/skills/writing-sandbox-providers`), passing the lock-linked
  signal to every provider call; paths go through `validateSandboxPath`, and `write` / `edit` reject `/skills`.
- Timeout: `sandbox_bash` = `min(timeoutSeconds ?? 120, sandbox.limits.maxCommandSeconds)` seconds plus a margin (margin =
  `tools.timeoutMs` + `sandbox.lockWaitSeconds`, covering lock waiting and creation / resume); a `timeoutSeconds` above the limit is rejected with an error.
  The other sandbox tools use only the margin (deliver twice). The provider's command time limit arrives first, the model gets `timedOut`, and the sandbox remains usable as usual.
- Spilling: `sandbox_bash`'s `spillChars` is 30000, and large output is read as usual through `read_tool_output` / `{"$output": id}`.
- Result prefix notices (English): on first use `Sandbox started for this conversation (first use)…`, on recreation
  `Sandbox was recreated; previous files are gone.`, and newly copied attachments list their paths. Before every call, attachments in the conversation that are ready are synced to
  `/workspace/attachments/`.
- Default policy is allow (the sandbox is isolated, D5); when the org setting `sandboxToolPolicy: "ask"` is set, bash / write / edit / deliver need approval,
  the setting is read **at the moment of execution**, and the read-only read / glob / grep are unaffected.
- `sandbox_deliver` puts a file into object storage (`kernel/<orgId>/artifacts/<conversation>/<id>`, limit `sandbox.deliverMaxBytes`),
  appends an `artifact_created` event, and the web "Artifacts" tab is rebuilt from the log.

**Skill tools**:

- `skill_load {name}` is not in the agent definition and is added automatically by the registry: it appears when the conversation log has a skill catalog snapshot `skills_catalog` (resolved from the
  agent version at run start, written only when it differs from the previous one, Ruling M17). It resolves the name to a skill id, version and `source` (object prefix) from the **latest snapshot**,
  fetches files strictly by `source`, and checks size and sha256. A skill with other files is copied into the sandbox at `/skills/<name>/` (read-only, scripts have no executable bit,
  the result tells you to run them with `sh` / `python3`; files left by older versions are listed as ignorable, Ruling M18); when the agent has no sandbox tools only the body is returned.
  The first catalog goes into the system cache segment, and later changes are rendered at their position as English reminders (append-only), so a change reaches the model only at **the start of the next run**.
- **Qualified names** (phase B, spec §9.3): `skill_load` also accepts `<plugin>:<name>` (Claude Code's namespace syntax, e.g. `superpowers:brainstorming`). An exact name wins; otherwise the prefix must equal the skill's `plugin` in the snapshot (the catalog item it was installed from), else the usual "not in the skills catalog" error listing the names. The catalog shown to the model keeps plain names, and the tool definition is unchanged (`maxLength: 64`, so a longer qualified name is refused by the schema while the plain one works). Skill bodies are never rewritten.
- **Pinned skills** (spec §9.1): the agent definition's `skills.pinned` (skill ids already selected through `orgSkills` or the agent's own skills; at most 3, SKILL.md of the current versions ≤ 32768 bytes, checked when the list changes: 400 `agent.pinned_invalid` with `{ skill, reason: not_selected | not_found | duplicate | too_many | too_large, totalBytes? }`; no default, so definitions without it gain no version). At run start the bodies are read from object storage (sha256-checked, bounded retry) and written into the `skills_catalog` snapshot (`pinned`), in the owner's order while they fit (the rest dropped with a warning); a storage failure fails the run before any model request (`storage.unavailable`, naming an unreadable skill for the owner), and pinned skills that keep changing during the read fail it with `conflict`. Requests render them after the catalog in the system segment, as "Pinned skill …" notices when the set or a version changes, and again after compaction, all from the log. A pinned skill needs no `skill_load`; calling it still copies the files into the sandbox. When the snapshot has a `claude-code` skill it also carries the fixed English tool-name map (`toolMap`, `runtime/context/claude-tools.ts`: `Bash` -> `sandbox_bash`, `Skill` -> `skill_load`, `Task` / `Agent` -> `agent` when the agent has it, else not available, …). See `.agents/skills/replay-evals` for the drift rules.
- **Manual skills and `/` invocations** (phase D, `docs/superpowers/specs/2026-10-27-phase-d-manual-skills-design.md`): a skill version records its invocation keys (`manifest.invocation`: `disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `argument-hint`, `arguments`). A **manual-only** version never enters the `skills_catalog` snapshot, its change reminders or the pinned skills (pinning one is 400 `agent.pinned_invalid` `manual_only`; a pinned skill whose new version is manual-only is dropped at run start with a warning). A person invokes a skill with `/name args` (`POST …/messages` `skill: { name }`, `skills/invoke.ts`); the rendered text is the message's `content[0]`, the non-model-visible `user_message.skill` records what ran. `skill_load` is offered once the log holds a catalog snapshot **or** any `user_message.skill`, so an agent whose skills are all manual-only can still copy an invoked skill's files; it loads an invoked manual-only skill by the version the message recorded (while the skill is still effective for the agent, else the "removed" text), and puts a line before a forked skill's body (run it through `agent` with its sub-agent type, or follow it yourself). Its spec (description, schema) is unchanged. A **forked** skill (`context: fork`) invoked by a person runs as a sub-agent (call id `skill-<seq>`, no `tool_call` in the parent's log; hooks and `usage.report` carry that `parent.callId`), and its report is the model-visible `skill_fork_result`.
- **`skill_write` and invocation keys** (phase D): the frontmatter of the written `SKILL.md` entry is dropped **except** the invocation keys, which are kept (the description says so; that changed its spec hash once, ordinary tool-definition drift). Writing a manual-only version removes the skill and its pinned entry from the conversation's catalog snapshot instead of adding it, and the result says only a person can invoke it; rejecting a draft never puts back a manual-only current version.
- `skill_write {name, description, files}` requires the agent definition to reference it explicitly (`builtin` / `skill_write`). The kernel
  synthesizes the SKILL.md frontmatter from name / description, accepts only text, ≤ 1 MiB in total, and at most 50 self-written skills per agent.
  - Private agent: default allow, directly generates a new version. The owner may set `skills.writePolicy: "ask"` in the agent definition (D10, absent means allow and
    is not written into the definition), in which case it is fixed to ask like a shared agent (remembered grants don't apply), but after confirmation it **takes effect directly** without a change request. `writePolicy`,
    like visibility, reads the agent's **current version** at the moment of execution (R5), so setting it to ask during a run takes effect on the next call; a shared agent goes through R3 + R4 whatever the value.
    The web shows this switch only on the form of a private agent.
  - Shared agent: on the R3 fixed-ask list, **in effect only for shared agents** (`R3_SHARED_AGENT_ONLY_TOOL_KEYS`, visibility is read live at execution time,
    and if it can't be read it is treated as shared), and remembered grants don't apply to it. After the initiator confirms, a change request is generated (`skills/changes.service.ts`), and until the owner approves it in the inbox
    only the initiating conversation can try it; another write in the same conversation supersedes the old request, and a write to the same skill from another conversation is refused.
  - The deployment setting `customSkills` set to `deny` only blocks org admins from uploading skill packages and **does not affect `skill_write`** (agent-level skills and shared agents' changes are
    guarded by R3 / R4).
  - On success a catalog snapshot is appended in the same transaction, so the next step of the same run can `skill_load`. Cost: when the conversation's first catalog appears mid-run,
    the next step's tool list gains `skill_load`, and the prompt cache is invalidated once.

## The `agent` builtin tool (sub-agents, phase C)

Spec `docs/superpowers/specs/2026-10-26-subagents-design.md` §4–§9; code `tools/builtins/agent.ts`, `runtime/subagents/*`.

- **Inputs** exactly `description` (1–80), `prompt`, `subagent_type` (default `general-purpose`), `model` (`inherit` / `fast` /
  `standard` / `capable`: tiers mapped to the purposes `subagent_*`, never a vendor model id; an unmapped tier runs on the parent's
  model, `tierFallback: true`) and `resume` (an `agentId`; not combined with `subagent_type` or `model`). `defaultPolicy: "allow"`,
  always loaded under `tool_search`, never offered to a child, and not offered at all when the agent's roster is empty.
- **Description varies with config**: it lists the roster (owner and plugin text made inert: `<` / `>` shown as `‹` / `›`) and the
  organization's `subagents.maxConcurrentPerRun`. So its spec hash changes when the roster or that limit changes: replays read specs
  by hash (no `DriftReason`), drift review covers connector tools only, and a remembered grant on `agent` (only relevant when an owner
  set it to `ask`) lapses with the hash, as for any spec change.
- **The pipeline handles it, not `run`**: no `tool_call_started`; after policy, approval and `tool.preExecute` it dispatches a child
  run and the step suspends with a `subagents` wait; the result (the child's final reply plus the status line `[agentId: … · status ·
  n tool calls · duration · tokens. …]`, tokens comma-grouped, durations `4s` / `1m 05s` / `1h 02m`) is written when the child ends.
  Refusals (unknown type, limits, a foreign or running `resume`, org agent gates) are `isError` results that start nothing.
- **Audit**: every dispatch is `subagent.dispatched`; the result is audited `tool.called` and fires `tool.postExecute` when it is
  written (also the stop texts of a stopped parent). Its `authorization` is set only when an approval allowed the call: the
  dispatch-time policy or grant decision is not recorded, and the pipeline does not guess.
- **Children** never get `agent`, `ask_user`, `sandbox_deliver` or `skill_write`. A child's policy is the parent agent's current version
  with the frozen template overlay (stricter wins; never looser); an org agent child uses that agent's current version, then the
  parent's policies. "Approve for this conversation" on a child is stored on the **parent** conversation, so it covers siblings'
  identical calls, and a session grant on the parent also satisfies a template's `ask` for the same tool (one conversation from the
  person's view). Approvals and questions go to the person who started the parent run.
- **Follow-ups** (`resume`) keep the child's frozen instructions and model, but the type must still be in the dispatching run's roster
  (else the unknown-type refusal), and the frozen tools and `orgSkills` are intersected with the current version (the parent run's;
  for an org agent child, that agent's current version), recorded as `user_message.dispatch.narrowed` and used by the child's run.
- **Sandbox**: children use the parent conversation's sandbox (`BuiltinCallContext.sandboxConversationId`) and may run commands at
  the same time; the `sandbox_bash` and `agent` descriptions warn that shell commands writing one file are not serialized (kernel file
  tools are, per path).

## Extension hooks around a tool call

Extensions can observe or deny tool calls through `ctx.hooks` (see "Hooks" in `.agents/skills/writing-extensions`).

- `tool.preExecute` runs after the tool policy and approval, and before `tool_call_started`. A policy
  denial never runs the tool: the call's `tool_result` is `hookDeniedText` (`Tool call blocked by the
  "<plugin>" policy hook: <reason>`, reason sanitized and cut to 500 characters, or a generic sentence
  for a hook error or timeout), written with the `hook_denied` event and a `hook.denied` audit row in
  one transaction. The denial is sticky per call: a resumed step reuses it and does not rerun hooks.
- `tool.postExecute` is observe-only and gets the result the model sees, that is, after output
  spilling (`content` is the spilled or truncated text, not the raw output).
- Hooks fire only for chat conversations and sub-agents (with `parent` set), never in eval replays (`RecordedToolPipeline` runs none).

## Connectors

A connector (`connector@1`) connects a remote service as a connector; the tools are decided by the remote, and the policy, approval, output archiving, drift and `tool_search` above all apply as usual. The contract, session lifecycle, auth injection, the circuit breaker semantics of `ToolError`, `connectorData` routing, `inspect`, elicitation and test fixtures are all in **`.agents/skills/writing-connectors`**. Reference implementations: `plugins/connector-mcp`, `plugins/connector-openapi`.

Key points: only `ToolError` with `kind: "unavailable"` counts toward the connector circuit breaker (see above); OAuth is entirely in the kernel, and a connector only does `auth()` / `onUnauthorized()`; the kernel redacts connector tool results and errors using the credentials injected for this call.

## Testing

- Extension unit tests: call the handler directly (constructing a `ToolCallContext`), see `plugins/todo/test/todo.test.ts`; for multi-replica read/write consistency use `createDualReplicaHarness`.
- Connector test fixtures (`startFakeMcpServer` / `startFakeOpenApiServer` / `startFakeOAuthServer`) are in `.agents/skills/writing-connectors`; drift detection is in `packages/kernel/test/tools/drift.test.ts`, and `tool_search` in `packages/kernel/test/tools/tool-search*.test.ts`.
- Kernel end-to-end: model-fake's `tool:<key>:<json>` directive makes the model call a given tool (such as `tool:todo__write:{"todos":[]}`), see `plugins/todo/test/kernel.http.test.ts` (an extension's tool through a real kernel, `startTestKernel` from `@capybara-hq/testing`), `packages/kernel/test/tools/mcp-e2e.test.ts` and the dual-replica acceptance `packages/kernel/test/tools/m3-segment1.dual.test.ts` (approval across replicas, approval timeout, result unknown after killing the worker, before and after extension enabling).
- Sandbox and skill tools: the real kernel + model-fake + the fake sandbox extension (`packages/kernel/test/fixtures/plugins/sandbox-fake`) + SeaweedFS,
  see `packages/kernel/test/tools/sandbox/sandbox-tools.test.ts`, `packages/kernel/test/skills/skills-runtime.test.ts`,
  `skill-write.test.ts`; dual-replica acceptance `plugins/sandbox-docker/test/sandbox-artifacts.dual.test.ts` (real Docker) and
  `packages/kernel/test/skills/m5-segment3.dual.test.ts` (skill change approved across replicas, scripts into the sandbox).
