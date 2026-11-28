# Authoring: extension point trigger-source

<!-- generated:extension-point -->
- Name: `trigger-source` (a ref is `trigger-source@<major>`)
- Declares the events an extension emits and which people may see their subjects.
- Providers: several
- Enabled per org: yes
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: TriggerSource (`trigger-source.ts`), with `ctx.triggers` (`triggers.ts`)

Declare the event types the extension emits in `permissions.triggers.emit` (lower-case dotted names such as `item.created`, at most 64) and implement `TriggerSource.events()` with one `TriggerEventDeclaration` per type: a name, whether the event is directed at one agent, and its facts (a type, a name and whether automations may filter on it). Emit with `ctx.triggers.emit(event)`; the result says whether the `dedupeKey` was already seen (`duplicate`). An event carries the org, the subject (kind, id, title, optional url), scalar or string-list facts, a summary of at most 4096 UTF-8 bytes for the agent, and optionally the cause (the tool call, a handle made from one, or the account) and an audience for directed events. `emit` throws `TriggerError`: `type_not_declared`, `invalid_event` or `org_disabled`. An event that must not be lost is emitted from a `ctx.queue` job, where no tool call context exists: in the tool call, get `await ctx.triggers.causeOf(call)` (a handle valid for 24 hours, bound to the call's org and run and to this extension), put it in the job's payload, and emit with `cause: { handle }`, so the event keeps the call's chain depth and self-trigger check.

`visible` answers which of the given accounts may see a subject; the kernel only wakes agents of accounts it lists, and a throw or a missing answer means nobody. `subjectLink` optionally gives people a link to the subject. Automation filters are conjunctions over facts: `eq` compares scalars, `in` matches a scalar fact against a list, `contains` matches a list fact against a scalar, and a missing fact never matches.

A directed event (its declaration says so, and `audience` names a person and an agent) never reaches automations people made: it runs only through the audience person's acceptance rule for the source (`auto`, `confirm` or `off`; the person sets it on their own page and the org sets the default), so an assignment may be offered, accepted at once, or not accepted; the `run.lifecycle` hook reports the outcome (see `extensions`).

See `extensions` for the rules every extension follows.
