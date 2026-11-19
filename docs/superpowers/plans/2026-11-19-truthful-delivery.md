# Truthful Image Schema and One Delivery per Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> layered with this repo's `wave-planned-subagent-development` skill. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** `GenerateImage` lists only the `n` / `reference_images` the org's image model can serve,
and the same bytes reach the user once per delivery scope (the current run since the person last
spoke), with factual tool results.

**Architecture:** An optional `BuiltinTool.specFor(scope)` computed in the registry's builtin loop,
fed by one shared image-caps computation also used by `ModelImages.prepare`. `storeArtifacts`
hashes files, reads the run's events since `run_started`, skips repeats (version-aware by
`sourcePath`), and uses the event log's idemKey for the parallel race. model-fake returns distinct
bytes per image index.

**Tech Stack:** TypeScript, NestJS kernel, Kysely/PostgreSQL, vitest, node:crypto / node:zlib.

**Spec:** `docs/superpowers/specs/2026-11-19-truthful-delivery-design.md` (read it first; §
numbers below refer to it).

## Global Constraints

- Term: "delivery scope" / "since the person last spoke". Never "turn" in code, comments or texts.
- Model-visible texts in English, facts only, no instructions to the model (no "don't call
  Deliver"). Exact texts are in spec §2 and §3; copy them verbatim.
- No migration. `artifact_created.sha256` is `z.string().regex(/^[0-9a-f]{64}$/).optional()`.
- idemKey format: `artifact:<runId>:<B>:<sha256>:<Lseq>` (`Lseq` = 0 when none).
- No process state, no new lock, no timers (multi-replica discipline).
- `Agent`'s roster spec path stays as is; `specFor` is called only in the `AGENT_BUILTIN_NAMES`
  loop of `ToolRegistry.resolve`.
- Comments you write are English; a new unit test joins `packages/kernel/test/unit-tests.json`.
- Kernel changes carry a changeset bumping `@capybara-hq/kernel` (patch); model-fake one bumping
  `@capybara-hq/plugin-model-fake` (patch).
- Run vitest from the repo root: `pnpm exec vitest run <path>`.

## Review Focus

1. A person's mid-run `AskUserQuestion` answer, then re-delivery → must deliver again (T3 test).
2. Same path delivered v1, v2, v1 → three artifacts; v1, v1 → one (T3 test).
3. Two parallel `Deliver` of identical bytes in one step → one event, the loser's object deleted
   (T3 test).
4. Org with `imageMaxPerCall: 1` but model `maxImages: 4` → no `n` in the listed schema (T2 test).
5. `GenerateImage` with every image a repeat → header still counts N generated, the billing line, no "Delivered" line, no `artifact_created` (T4 test).

## Waves

| Wave | Task | Risk | Review |
|---|---|---|---|
| 1 | T1 model-fake distinct images (+ kernel test audit) | low | batched |
| 1 | T2 org-dependent `GenerateImage` spec, shared image caps | medium | batched |
| 1 | T3 delivery scope in `storeArtifacts`, `Deliver` repeat text | high (race / multi-replica) | alone, most capable model |
| 2 | T4 `GenerateImage` result and device line | medium | batched |

File sets in wave 1 are disjoint except one line: T1 owns `generate-image.test.ts`; T2 owns
`generate.ts` (spec / availability hunks) and the model files; T3 owns `artifacts.ts`, `events.ts`,
`event-log.ts`, `deliver.ts`, `sandbox/common.ts`, plus the `eventLog` pick at `generate.ts:199`. T4 needs
all three.

---

### Task 1: Distinct fake images

**Files:**
- Modify: `plugins/model-fake/src/script.ts:48-53`, `:501-505`
- Modify: `plugins/model-fake/src/index.ts:84-89` (doc comment: "n distinct 1×1 PNGs")
- Test: `plugins/model-fake/test/model-fake.test.ts:~513`
- Audit/modify: `packages/kernel/test/tools/generate-image.test.ts` (`n: 2` cases around
  `:410-452`, `:686-696`, `:773`), `packages/kernel/test/models/images.test.ts`,
  `packages/kernel/test/channels/outbound-files*.test.ts`, `packages/kernel/test/schedules/channel-delivery.test.ts`
- Create: `.changeset/model-fake-distinct-images.md`

**Interfaces:**
- Produces: `fakePng(index: number): string` (base64) exported from `plugins/model-fake/src/script.ts`;
  `fakePng(0) === FAKE_PNG_BASE64`.

- [ ] **Step 1: Write the failing test** in `model-fake.test.ts` replacing the `Array(3).fill`
  assertion:

```ts
it("returns n distinct valid PNGs, the first the shared sample", async () => {
  const res = await generate({ prompt: "a fox", n: 3 }); // existing helper of the file
  const data = res.images.map((i) => i.data);
  expect(data[0]).toBe(FAKE_PNG_BASE64);
  expect(new Set(data).size).toBe(3);
  for (const d of data) expect(Buffer.from(d, "base64").subarray(1, 4).toString()).toBe("PNG");
});
```

- [ ] **Step 2:** `pnpm exec vitest run plugins/model-fake/test/model-fake.test.ts` → FAIL (size 1).
- [ ] **Step 3: Implement `fakePng(index)`**: index 0 returns `FAKE_PNG_BASE64`; otherwise insert
  before the 12-byte `IEND` chunk a `tEXt` chunk (`length` BE u32, `"tEXt"`, `"index\0<i>"`, CRC32
  BE over type+data via `zlib.crc32`). Use it in the generator: `images: Array.from({ length: count },
  (_, i) => ({ mediaType: "image/png", data: word === "url" ? URL : fakePng(i) }))`.
- [ ] **Step 4:** run the model-fake tests → PASS.
- [ ] **Step 5: Audit kernel tests** that generate `n > 1` through model-fake: replace "every image is
  `PNG`" / `size: PNG.byteLength` for index ≥ 1 with the bytes of `fakePng(i)` decoded from the
  test's own copy (tests must not import the plugin: compute expected sizes from the stored object
  or assert `size > 0` and distinct `sha256`). Run:
  `pnpm exec vitest run packages/kernel/test/tools/generate-image.test.ts packages/kernel/test/models/images.test.ts packages/kernel/test/channels packages/kernel/test/schedules/channel-delivery.test.ts`
  → PASS.
- [ ] **Step 6: Changeset** `@capybara-hq/plugin-model-fake: patch` — "Image generation returns
  distinct bytes per image index."
- [ ] **Step 7: Commit** `test(model-fake): return distinct bytes per generated image`.

### Task 2: Org-dependent GenerateImage spec

**Files:**
- Modify: `packages/kernel/src/models/image-usable.ts` (whole file)
- Modify: `packages/kernel/src/models/images.ts:297-308` (`prepare` uses `imageInputCaps`)
- Modify: `packages/kernel/src/models/purposes.ts:277-281`
- Modify: `packages/kernel/src/tools/registry.ts:158-175` (field), `:675-686` (call)
- Modify: `packages/kernel/src/tools/builtins/image/generate.ts:66-68`, `:223-233`
- Test: `packages/kernel/test/tools/registry-builtin-unavailable.test.ts` (unit, already listed)
- Create test: `packages/kernel/test/tools/generate-image-spec.test.ts` (unit; add to `unit-tests.json`)
- Test: `packages/kernel/test/models/purposes.test.ts` (integration, `describe("purpose availability for a member")`)

**Interfaces:**
- Produces (`models/image-usable.ts`):
  - `interface ImageInputCaps { maxImages: number; maxReferenceImages: number }`
  - `imageInputCaps(limits: { imageMaxPerCall: number }, gen: { maxImages: number; maxReferenceImages: number }): ImageInputCaps`
  - `type ImagePurposeState = ({ usable: "usable" } & ImageInputCaps) | { usable: "no-model" | "no-storage" }`
  - `imagePurposeState(deps: { purposes; providers; storage; log; config: Pick<KernelConfigService, "get"> }, orgId: string, memo?: Map<string, unknown>): Promise<ImagePurposeState>`
    (memo key `"image-purpose-state"`). `imagePurposeUsable` is removed.
- Produces (`registry.ts`): `BuiltinTool.specFor?: (scope: ToolListingScope) => Promise<ToolSpec> | ToolSpec`.
- Produces (`generate.ts`): `generateImageSpec(caps: ImageInputCaps): ToolSpec` (pure).

- [ ] **Step 1: Failing unit tests** in `generate-image-spec.test.ts`:

```ts
const props = (c: ImageInputCaps) =>
  (generateImageSpec(c).inputSchema as { properties: Record<string, any> }).properties;
it("drops n when the cap is 1", () => expect(props({ maxImages: 1, maxReferenceImages: 2 }).n).toBeUndefined());
it("caps n at the effective maximum", () => expect(props({ maxImages: 2, maxReferenceImages: 2 }).n.maximum).toBe(2));
it("drops reference_images when the model takes none", () =>
  expect(props({ maxImages: 2, maxReferenceImages: 0 }).reference_images).toBeUndefined());
it("caps reference_images at min(4, model)", () => {
  expect(props({ maxImages: 2, maxReferenceImages: 2 }).reference_images.maxItems).toBe(2);
  expect(props({ maxImages: 2, maxReferenceImages: 9 }).reference_images.maxItems).toBe(4);
});
it("takes the config cap when below the model's", () =>
  expect(imageInputCaps({ imageMaxPerCall: 1 }, { maxImages: 4, maxReferenceImages: 0 }))
    .toEqual({ maxImages: 1, maxReferenceImages: 0 }));
```

  and in `registry-builtin-unavailable.test.ts`: a fake builtin with `specFor` returning a spec with
  a different description → `forAgent` lists that spec and its `specHash` equals `specHash(spec)`;
  a builtin whose `unavailable` returns a reason never has `specFor` called (`vi.fn` not called).
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/tools/generate-image-spec.test.ts packages/kernel/test/tools/registry-builtin-unavailable.test.ts` → FAIL.
- [ ] **Step 3: Implement** the Interfaces above. `prepare` refuses with `caps.maxImages` /
  `caps.maxReferenceImages` (texts unchanged). `generate.ts:252` keeps comparing with
  `prepared.info.maxReferenceImages` (same value). `GenerateImage.unavailable` and `.specFor` both
  call `imagePurposeState(deps, scope.orgId, scope.memo)`; `specFor` on a non-usable state (a race)
  returns the static spec. `ModelPurposesService.availability` reads `usable === "usable"`; its deps
  gain `config`. The registry loop: `let spec = b.specFor ? await b.specFor(scope) : b.spec;` before
  the existing `Agent` branch.
- [ ] **Step 4:** rerun step 2 → PASS; `pnpm typecheck`.
- [ ] **Step 5: Integration** in `purposes.test.ts`: with model-fake image model `maxImages: 1`,
  `maxReferenceImages: 0`, `app.get(ToolRegistry).forAgent(orgId, {...})` lists `GenerateImage`
  whose properties have neither `n` nor `reference_images`; with `maxImages: 3`, `n.maximum` is 3;
  the member availability still reads `image: true`. Run
  `pnpm exec vitest run packages/kernel/test/models/purposes.test.ts packages/kernel/test/models/images.test.ts` → PASS.
- [ ] **Step 6:** changeset `@capybara-hq/kernel: patch` — "GenerateImage lists only the image count
  and reference images the org's image model accepts."
- [ ] **Step 7: Commit** `feat(kernel): list GenerateImage arguments the org's image model accepts`.

### Task 3: Delivery scope in storeArtifacts (high risk: review alone)

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts:1335-1344` (`sha256` optional)
- Modify: `packages/kernel/src/tools/builtins/artifacts.ts` (whole `storeArtifacts`)
- Create: `packages/kernel/src/tools/builtins/delivery-scope.ts` (pure decision)
- Modify: `packages/kernel/src/conversations/event-log.ts` (new read method)
- Modify: `packages/kernel/src/tools/builtins/sandbox/common.ts:~123` and
  `packages/kernel/src/tools/builtins/image/generate.ts:199` (add `readDeliveryScope` to the
  `eventLog` picks; the one line T3 touches in `generate.ts`, a hunk T2 does not edit)
- Modify: `packages/kernel/src/tools/builtins/sandbox/deliver.ts:155-166`
- Modify: `.agents/skills/writing-tools/SKILL.md` (one bullet under the builtins: delivery scope)
- Create test: `packages/kernel/test/tools/delivery-scope.unit.test.ts` (unit; add to `unit-tests.json`)
- Create test: `packages/kernel/test/tools/delivery-scope.test.ts` (integration, one app)

**Interfaces:**
- Consumes: `EventLog.append` (returns events one-to-one, existing event for a known idemKey).
- Produces (`delivery-scope.ts`):
  - `interface ScopeArtifact { seq: number; artifactId: string; name: string; sha256?: string; sourcePath: string }`
  - `interface DeliveryScope { boundary: number; artifacts: ScopeArtifact[] }`
  - `EventLog.readDeliveryScope(conversationId: string, runId: string): Promise<DeliveryScope>`
    (in `event-log.ts`; the sandbox tool deps have no db, every caller has the event log)
  - `findRepeat(scope: DeliveryScope, sha256: string, sourcePath: string): { repeatOf: ScopeArtifact | null; lastOfSource: number }`
- Produces (`artifacts.ts`): `StoredArtifact` gains `repeatOf?: { artifactId: string; name: string }`;
  `ArtifactStoreDeps.eventLog` becomes `Pick<EventLog, "append" | "readDeliveryScope">` (+ optional
  `publishChanged`); return stays one entry per input file, in order. `REPEAT_TEXT(name, prior: { name; artifactId })` exported:
  ``${name} has the same content as ${prior.name} (artifact ${prior.artifactId}), already delivered to the user since the person last spoke; no new artifact was created.``

- [ ] **Step 1: Failing unit tests** (`delivery-scope.unit.test.ts`) for `findRepeat`:

```ts
const a = (seq: number, sha: string, src: string) =>
  ({ seq, artifactId: `id${seq}`, name: `n${seq}`, sha256: sha, sourcePath: src });
it("a repeat of the latest same-content artifact", () =>
  expect(findRepeat({ boundary: 0, artifacts: [a(5, "A", "generated/c/x.png")] }, "A", "/w/x.png").repeatOf?.seq).toBe(5));
it("v1, v2, v1 of one path delivers again", () =>
  expect(findRepeat({ boundary: 0, artifacts: [a(5, "A", "/w/f"), a(7, "B", "/w/f")] }, "A", "/w/f"))
    .toEqual({ repeatOf: null, lastOfSource: 7 }));
it("v1, v1 is a repeat", () =>
  expect(findRepeat({ boundary: 0, artifacts: [a(5, "A", "/w/f")] }, "A", "/w/f").repeatOf?.seq).toBe(5));
it("an artifact without sha256 never matches", () =>
  expect(findRepeat({ boundary: 0, artifacts: [{ ...a(5, "A", "/w/f"), sha256: undefined }] }, "A", "/w/f").repeatOf).toBeNull());
```

- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/tools/delivery-scope.unit.test.ts` → FAIL.
- [ ] **Step 3: Implement `findRepeat`** (M = latest with the hash, L = latest with the path; repeat
  iff M and not L.seq > M.seq) and **`EventLog.readDeliveryScope`**: `S` = seq of the run's `run_started`
  (`conversation_events` where `conversation_id`, `run_id`, `type = 'run_started'`; none → `S = 0`);
  then events with `seq >= S` and `type in ('user_message','question_answered','artifact_created')`
  ordered by seq; `boundary` = max seq of `user_message` and of `question_answered` whose
  `payload->>'outcome' in ('answered','skipped')`, else `S`; `artifacts` = `artifact_created` with
  `seq > boundary`.
- [ ] **Step 4:** unit tests → PASS.
- [ ] **Step 5: Failing integration tests** (`delivery-scope.test.ts`, model-fake scripted tool calls,
  sandbox-fake device, fake object store as in `generate-image.test.ts`):
  - `"a second Deliver of the same bytes in a run is a repeat"`: two `Deliver` steps of two device
    paths with equal bytes → one `artifact_created` (with `sha256`), second result equals
    `REPEAT_TEXT(...)`, one object in the store.
  - `"a new run delivers again"`, `"a mid-run user message starts a new scope"`,
    `"an answered AskUserQuestion starts a new scope"` → two artifacts each.
  - `"v1, v2, v1 of one path delivers three times"`.
  - `"parallel identical Deliver calls store one artifact"`: one step with two `Deliver` calls of
    equal files → one `artifact_created`, both results name it, `store.objects` has one key.
  - `"without a run nothing is deduped"`: direct `storeArtifacts` with `runId` undefined twice → two.
- [ ] **Step 6:** `pnpm exec vitest run packages/kernel/test/tools/delivery-scope.test.ts` → FAIL.
- [ ] **Step 7: Implement `storeArtifacts`** per spec §2 steps 1-5: hash (`createHash("sha256")`)
  and in-call dedupe → `readDeliveryScope` (only when `ctx.runId`) → `findRepeat` per remaining file
  → upload non-repeats → one `append` with `idemKey` `artifact:${runId}:${boundary}:${sha}:${lastOfSource}`
  and `sha256` in the payload → for each returned event whose `artifactId` differs from the generated
  one, delete that object (best effort) and mark the file `repeatOf` the returned event → abort /
  failure path unchanged → `publishChanged` only if a fresh event exists.
  `deliver.ts`: a `repeatOf` result returns `REPEAT_TEXT(name, repeatOf)` with display
  `display(\`已交付过（内容相同）${clip(name, 160)}\`, \`Already delivered (same content): ${clip(name, 160)}\`)`.
- [ ] **Step 8:** rerun steps 2 and 6, plus
  `pnpm exec vitest run packages/kernel/test/tools/sandbox packages/kernel/test/channels/outbound-files.test.ts packages/kernel/test/evals/reconstruct.test.ts` → PASS.
- [ ] **Step 9:** skill bullet in `writing-tools`: "Delivery scope: `storeArtifacts` delivers the same
  bytes once per run since the person last spoke (`user_message`, answered / skipped question);
  a repeat creates no artifact and returns the repeat text; version-aware by `sourcePath`."
  Changeset `@capybara-hq/kernel: patch`.
- [ ] **Step 10: Commit** `feat(kernel): deliver the same content once since the person last spoke`.

### Task 4: GenerateImage result and device line

**Files:**
- Modify: `packages/kernel/src/tools/builtins/image/generate.ts:290-297` (pass stored with
  `repeatOf` to the device copy), `:555-621` (`copyToDevice` line), `:666-688` (`resultText`)
- Test: `packages/kernel/test/tools/generate-image.test.ts`

**Interfaces:**
- Consumes: `StoredArtifact.repeatOf`, `REPEAT_TEXT` (T3); `generateImageSpec` (T2); `fakePng` bytes (T1).

- [ ] **Step 1: Failing tests** in `generate-image.test.ts`:
  - `"result counts generated images and lists delivered ones"`: `n: 2` → first line
    `Generated 2 images with model-fake/<model> at 1x1.`, second `Delivered 2 to the user:`.
  - `"a repeated image names the earlier artifact and billing"`: generate `name: "poster"`, then in
    the same run `Deliver` nothing and call again with a script returning the same bytes (prompt
    word that yields `fakePng(0)`, `n: 1`) → no new `artifact_created`, a line
    `- image.png: same content as poster.png (artifact <id>), already delivered to the user since the person last spoke; no new artifact was created.`,
    a line `Usage is billed for 1 generated image.`, no `Delivered` line, one more `usage` event.
  - `"device line names the matching artifact"`: `file_path: "out/a.png"` →
    `Also written to the device (same bytes as artifact <id>): <abs path>`; `n: 2` →
    `Also written to the device: <p1> (same bytes as artifact <id1>), <p2> (same bytes as artifact <id2>)`.
  - `"GenerateImage then Deliver of its device copy is a repeat"` → one `artifact_created`.
  - `"n the listing does not offer fails validation"`: model `maxImages: 1`, a scripted call with
    `n: 2` → the pipeline's validation error, no image model call.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/tools/generate-image.test.ts` → FAIL.
- [ ] **Step 3: Implement** the texts verbatim from spec §2 / §3. Grammar: "1 image" / "N images";
  "Delivered K to the user:" only when K ≥ 1; the billing line only when a repeat exists, worded
  `Usage is billed for ${n} generated ${n === 1 ? "image" : "images"}.`. Repeat lines reuse `REPEAT_TEXT`'s clause
  after `- ${name}: ` (same wording, lower-case "same content as"). `copyToDevice` gets the artifact
  id per file (fresh or `repeatOf`) and builds the line; failure lines unchanged. Display unchanged.
- [ ] **Step 4:** rerun step 2 → PASS; then `CAPYBARA_TEST_WORKERS=4 pnpm verify` → green.
- [ ] **Step 5: Commit** `feat(kernel): state GenerateImage deliveries, repeats and device copies as facts`.
