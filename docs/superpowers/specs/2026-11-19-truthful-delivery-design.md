# Truthful image schema and one delivery per content since the person last spoke

Status: draft for maintainer review (2026-11-19), revised after an adversarial review the same
day. Follows the image generation design (`2026-11-17-image-generation-design.md`). Kernel plus
`plugins/model-fake` (its fake images become distinct, see §4); no SDK, web or official-plugin
change.

## Intent

A conversation on argus (deepseek-flash, image model with `maxImages` 1) showed two ways the
platform misinforms the agent:

1. `GenerateImage` advertised `n` up to 4. The model asked for 2, the kernel refused ("n must be at
   most 1 for this model"), the model retried with 1. The schema offered something the org's model
   cannot do.
2. With `file_path`, `GenerateImage` stored the image and wrote a copy into the device. The model
   then called `Deliver` on that copy: a second artifact with identical bytes, shown twice on the
   web (and, with channel file delivery from core#377, sent twice to IM).

The fix is two general rules, not a case for this model or tool, and no prompt text that steers
the model: a tool's input schema states what the org can actually do, and the same bytes reach
the user once per **delivery scope** (defined in §2), with a factual result for the repeat.

## Goals

- A builtin's input schema can depend on the org. `GenerateImage` uses it for `n` (absent when the
  effective cap is 1, else `maximum` = cap) and `reference_images` (absent when the model takes
  none, else `maxItems` = min(4, the model's limit)).
- Within one delivery scope, a second delivery of identical bytes creates no artifact and returns a
  factual result naming the artifact already delivered. Applies to every producer that goes
  through `storeArtifacts` (`Deliver`, `GenerateImage`, later ones).
- `GenerateImage`'s result states only facts: what was generated and billed, what was delivered,
  what is a repeat, what the device copy is.

## Non-goals

- No conversation-wide dedupe: "send that file again" after the person speaks delivers again.
- No dedupe across a sub-agent tree (each conversation is its own scope, see edge cases).
- No change to the kernel's validation of `n` / references (it stays as the backstop), to channel
  delivery, or to how the event log renders for the model.
- `Agent`'s roster spec keeps its own path (`registry.ts:682-686`); moving it is out of scope.

## Current state (origin/main, 3e925cc67)

- `GENERATE_IMAGE_SPEC` is one static spec: `n` has `maximum: MAX_IMAGES` (4) and
  `reference_images` `maxItems: MAX_REFERENCES` (4)
  (`packages/kernel/src/tools/builtins/image/generate.ts:66-68`, `:95-107`). The real limits are
  refused in `ModelImages.prepare`: count `min(models.imageMaxPerCall, imageGeneration.maxImages)`
  (`packages/kernel/src/models/images.ts:297-299`), references `imageGeneration.maxReferenceImages`
  (`images.ts:301-307`, checked again before reading references at `generate.ts:252-254`).
- Org-dependent listing exists only as on/off: `BuiltinTool.unavailable(scope)`
  (`packages/kernel/src/tools/registry.ts:174`), for `GenerateImage` the predicate
  `imagePurposeUsable` (`generate.ts:229-233`, `packages/kernel/src/models/image-usable.ts:22-45`),
  which already resolves the purpose's model. Its second caller is the member-readable purpose
  availability the agent form reads (`packages/kernel/src/models/purposes.ts:277`): the two must
  keep sharing one predicate.
- The builtin loop of `resolve` (`registry.ts:672-698`, over `AGENT_BUILTIN_NAMES`, which lists
  `GenerateImage`: `tools/builtin-names.ts:120`) asks `unavailable`, then hashes the spec it adds
  (`builtinTool`, `registry.ts:340-344`). `builtinSpecs()` (`registry.ts:435`) serves static specs
  to `tools/info.ts:99` for display only.
- Tools are resolved per step (`packages/kernel/src/tools/pipeline.ts:916`) and the input is
  validated against the resolved spec (`pipeline.ts:1119`). Requests record tool specHashes and
  replays fetch definitions by hash, so a schema change needs no `DriftReason` (replay-evals skill:
  "A tool's input schema change ... needs none").
- Artifacts are not a table: `storeArtifacts` uploads each file, then appends `artifact_created`
  events (run id, `callId`, `sourcePath`) in one append
  (`packages/kernel/src/tools/builtins/artifacts.ts:51-102`; payload schema
  `packages/kernel/src/conversations/events.ts:1335-1344`). `sourcePath` groups versions in the
  conversation's files (`artifacts.ts:28-32`). `Deliver` calls it at
  `tools/builtins/sandbox/deliver.ts:157`, `GenerateImage` at `generate.ts:285-289`. Channel
  outbound sends each `artifact_created` (`packages/kernel/src/channels/outbound.ts:1143`); request
  building ignores them (`packages/kernel/src/runtime/context/build.ts:1078`).
- `EventLog.append` locks the conversation row `FOR UPDATE`, returns the existing event for an
  `idemKey` already in the log (or the batch's first for a key repeated in it), and returns events
  one-to-one with the input, without saying which are fresh
  (`packages/kernel/src/conversations/event-log.ts:179-184`, `:468-497`); the key is unique per
  conversation (`migrations/0006_conversations.sql:25-26`). Events of a run are indexed by
  `(conversation_id, run_id, seq)` (`migrations/0027_model_prices.sql:17-18`).
- A person's input reaches a conversation as `user_message` or as `question_answered` (outcome
  `answered`, or `skipped` when the starter sent a message instead) (`events.ts:701-712`,
  `:1306-1321`).
- `GenerateImage` usage is logged before the images are stored and is billed whatever happens to
  them (ruling R11, `generate.ts:261-262`). Its result: "Generated 1 image ... and delivered it to
  the user:", the artifacts, then "Written to the device: <path>" (`generate.ts:600`, `:677`).
- `plugins/model-fake` answers `n` images with the same bytes (`FAKE_PNG_BASE64`,
  `plugins/model-fake/src/script.ts:502-504`), so any test generating `n > 1` would dedupe.

## Design

### 1. Org-dependent builtin specs

`BuiltinTool` gains `specFor?: (scope: ToolListingScope) => Promise<ToolSpec> | ToolSpec`. Only
the `AGENT_BUILTIN_NAMES` loop of `resolve` calls it, after `unavailable` returned null; absent
means `spec`. `builtinTool` hashes the result as today. `builtinSpecs()` keeps the static spec
(display metadata only).

`imagePurposeUsable` becomes `imagePurposeState(deps, orgId)` returning
`{ usable: "usable" } & ImageInputCaps | { usable: "no-model" | "no-storage" }`. Both callers
(`GenerateImage.unavailable` and `ModelPurposesService.availability`) read `usable` from it, so the
single-predicate guarantee holds. `ImageInputCaps = imageInputCaps(config, gen)` =
`{ maxImages: min(imageMaxPerCall, gen.maxImages), maxReferenceImages: gen.maxReferenceImages }`,
also used by `prepare` for its refusals, so schema and refusal never disagree. The state is
memoised in `scope.memo` (computed when absent), so `unavailable` and `specFor` resolve the model
once per listing.

`GenerateImage.specFor` derives from the static spec: no `n` when `maxImages` is 1, else
`n.maximum` = `maxImages`; no `reference_images` when `maxReferenceImages` is 0, else
`maxItems` = min(4, `maxReferenceImages`). The description drops its reference-images sentence with the field; other fields are unchanged.

- Validation: the pipeline validates against the listed spec (`additionalProperties: false`), so
  an argument the org cannot serve is refused by the schema check. The `prepare` refusals stay as
  the backstop for a model changed between listing and call.
- Replay: the new spec has a new specHash, recorded with the request; old requests replay with
  their recorded definitions. No `DriftReason`, no new event; `tools_changed` is name-based and
  does not fire for a schema change.
- Platform tool: untouched (builtin specs are not Platform operations).

### 2. One delivery per content within a delivery scope

**Delivery scope** (the one term; "turn" is not used, it means a page of the web timeline
elsewhere): the current run of the conversation, after the person last spoke in it. Its
boundary `B` is the highest seq among this run's `user_message` events and `question_answered`
events with outcome `answered` or `skipped` (a skipped question in a sub-agent's conversation
marks the person's message to its tree), or the run's `run_started` seq when there is none. A new
run is always a new scope.

`artifact_created` gains `sha256` (hex). It is optional in the schema only because rows written
before cannot be backfilled (the bytes live in the object store); an event without it never
matches.

`storeArtifacts`, when the call has a run:

1. **Hash and dedupe in memory.** sha256 each file; a file whose hash equals an earlier file of
   the same call is that file's repeat and is not uploaded.
2. **Read the scope.** The run's `run_started` seq `S` from the run index (it carries the run id,
   `runtime/run-worker.ts:1279`); then one primary-key range read of the conversation's
   `user_message`, `question_answered` and `artifact_created` events with `seq >= S` (a
   `user_message` carries no run id, `conversations/conversations.service.ts:1766`, so the run
   index cannot find it). That gives `B` and the scope's artifacts (`seq > B`, this run's). It
   reads only events written since the run started.
3. **Decide repeats.** For file F with source path P: let M be the latest scope artifact with
   F's hash, L the latest scope artifact with source path P. F is a repeat of M when M exists and
   L does not come after M. So delivering v1, v2, then v1 again of one path delivers v1 again;
   `GenerateImage` then `Deliver` of its device copy (another path, no later artifact of it) is a
   repeat. A repeat is not uploaded.
4. **Upload and append the rest** as today, each event with idemKey
   `artifact:<runId>:<B>:<sha256>:<L.seq or 0>`. Two parallel calls that both saw no M compute the
   same key; the append's row lock and the unique key make the second get the first's event.
5. **One cleanup rule.** After the append, delete every uploaded object whose returned event's
   `artifactId` is not the one generated for it (best effort, as the failure path does); that file
   becomes a repeat of the returned event. `publishChanged` only when something new was stored.

Without a run (`ctx.runId` absent) nothing changes. No migration: the race key uses the existing
`idem_key` column.

`storeArtifacts` returns, per input file, `{ artifactId, name, size }` plus
`repeatOf?: { artifactId, name }`.

**Result texts** (success, never an error; one wording for every producer):

- `Deliver` repeat: "`report.pdf` has the same content as `poster.png` (artifact `<id>`), already
  delivered to the user since the person last spoke; no new artifact was created." Display:
  `已交付过（内容相同）report.pdf` / `Already delivered (same content): report.pdf`.
- `GenerateImage`, first line: "Generated N image(s) with `<provider>/<model>` at WxH." Then, when
  K ≥ 1 images are new: "Delivered K to the user:" and their lines as today. Then each repeat:
  "- image-2.png: same content as poster.png (artifact `<id>`), already delivered to the user since
  the person last spoke; no new artifact was created." When any repeat exists: "Usage is billed for N
  generated image(s)." (singular / plural by N) Display stays `生成图片 …` / `Generated images: …` in every case: the
  generation happened and was billed; the delivery facts are in the result text.
- Device line (§3) names the artifact each copy matches, the earlier one for a repeat.

Channel delivery needs nothing: no new `artifact_created`, nothing sent.

### 3. GenerateImage device line

"Also written to the device: out/a-1.png (same bytes as artifact `<id1>`), out/a-2.png (same
bytes as artifact `<id2>`)" (one image: "Also written to the device (same bytes as artifact
`<id>`): out/a.png"). A fact, no stated purpose. The failure lines are unchanged.

### 4. Distinct fake images

`model-fake` returns image `i` (0-based) as `FAKE_PNG_BASE64` for `i = 0` and, for `i > 0`, that
PNG with a `tEXt` chunk `index=<i>` before `IEND` (CRC by `node:zlib` `crc32`). A single image keeps
its bytes, so tests on one image are untouched; tests asserting sizes or bytes for `n > 1` are
audited. Changeset for `@capybara-hq/plugin-model-fake`.

## Edge cases

- **Sub-agents**: a child conversation has its own run and log, so its scope is its own; a parent
  re-delivering a child's file delivers again. Accepted (the child's result names what it delivered).
- **The person answers a question mid-run**: `B` moves past the answer; a re-delivery is new.
- **Two identical images in one answer**: step 1; the second is a repeat of the first, billed.
- **Same content, different name or path**: a repeat (no later artifact of the new path); the
  result names both files.
- **`Deliver` approved by the person through an `ask` policy, then found a repeat**: accepted; the
  person approved delivering that content, it is with the user, the result says so.
- **No run, abort**: unchanged; a repeat found in step 3 uploads nothing.
- **Org image model changes mid-run**: the next step lists the new schema; a call made against the
  old one hits the `prepare` backstop with its existing actionable error.

## Testing

- Unit: `GenerateImage.specFor` for count cap 1 (no `n`), 2, config cap below `maxImages`;
  references 0 (no `reference_images`), 2, 9 (`maxItems` 4); `imageInputCaps` shared by `prepare`;
  the repeat decision (M / L rule) as a pure function.
- Integration (kernel): `GenerateImage` with `file_path`, then `Deliver` of the copy → one
  artifact, the repeat text; the same after a new run, after a mid-run `user_message`, and after an
  answered `AskUserQuestion` → new artifacts; v1, v2, v1 of one path → three artifacts; two parallel
  `Deliver` of identical files in one step → one artifact, one object left; a listing for
  `maxImages: 1` / `maxReferenceImages: 0` offers neither field and a call with `n` fails
  validation; agent-form availability unchanged.
- model-fake: `n: 3` gives three distinct valid PNGs, the first equal to `FAKE_PNG_BASE64`.
- Replay: `reconstruct.test.ts` zero drift before and after (request building is unchanged).

## Open questions (with recommendations)

1. **Expose `specFor` to extension tools?** Recommend no: extension tools register their own spec
   and can re-register; keep it kernel-internal until a second need appears.
2. **Show repeats on the web?** Recommend no: the tool row's result already says it; a repeat adds
   no file.

## AGENTS.md rules touched

- **Tools.** English, actionable results; the repeat result is a fact, not an instruction.
- **Runtime and replay.** No new model-visible input outside tool results and tool definitions
  (both recorded); no `DriftReason`.
- **Multi-replica discipline.** Dedupe relies on the event log's row lock and unique idemKey, no
  process state, no new lock.
- **Migrations.** None (`sha256` is a payload field; the race key uses `idem_key`).
- **Tests.** model-fake stays the only plugin core tests load; its image bytes change for `n > 1`.
- **Language / i18n.** The `Deliver` repeat display is bilingual (zh / en) like other tool displays.
- No new AGENTS.md rule.
