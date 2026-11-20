# Platform web parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, layer it under `wave-planned-subagent-development`.

**Goal:** What a person can do on the web, their agent can do through the `Platform` tool. Secrets
are typed by the person on the confirmation card. Files already in the conversation stand in for
uploads. A decision that stays on a web page is one tap away through a link card.

**Architecture:** Three mechanisms are added to the existing Platform tool and approval flow:
- **Person fields**: operations declare their target's secret fields; the card collects them;
  values travel browser → decision route → a sealed, read-once PG row → the resumed call.
- **File references**: `{fileId}` or a device `{path}`, resolved, size and type checked and
  sha256-bound at the card, read again and compared at run time.
- **Handoff views**: a new tool-result view kind the web renders as a link card (or a Connect
  button) and IM renders as a `bind` card.

Each mechanism moves its exclusions to operations and gains a fence rule.

**Tech Stack:** NestJS kernel (Kysely, zod 4, BullMQ outbox), Next web app with TanStack Query,
`packages/design`, vitest, `tools/checks` (oxc).

**Spec:** `docs/superpowers/specs/2026-11-19-platform-web-parity-design.md` (PR #440). Read it
with this plan. Where this plan and the spec disagree, the spec wins unless a ruling below says
why the code forces a different shape.

## Delivery

Three PRs, each from its own worktree off `origin/main` (`pnpm wt:new <branch> --from origin/main`).
Each PR has a changeset on `@capybara-hq/kernel` (web changes also `@capybara-hq/web`, design
changes `@capybara-hq/design`). The spec's PR split holds, with one move: the handoff view is
built in PR 2, because OAuth connect (§4.4) needs it, and PR 3 applies it to the import and
upload operations.

| PR | Branch | Tasks |
|---|---|---|
| 1 | `feat/platform-person-fields` | 1–9 |
| 2 | `feat/platform-connectors-members` | 10–13 |
| 3 | `feat/platform-files-handoffs` | 14–17 |

Suggested waves (execution may refine them in the ledger):
- PR 1: wave A = 1, 2, 3; wave B = 4, 5, 7; wave C = 6, 8, 9.
- PR 2: wave A = 10, 12; wave B = 11, 13.
- PR 3: wave A = 14; wave B = 15, 16; then 17.

`high` risk (reviewed alone, most capable model): 1, 2, 4, 5, 10, 12, 14.

## Rulings (where the code forces a choice the spec leaves open)

- **R1. Paths.** Person field paths are the dot paths the config routes already use in `values`
  (`deployment-config.ts:245`, `org-overrides.ts:157`). Secret **records** (`x-ui.secrets`, per-key
  `secretEntries`) are not person fields in this plan. An operation leaves `secretEntries` out
  (`omits`), and a target whose only missing secret is a record field is refused before the card
  with `platform.secret_record_web_only`, naming the web page. Cost if wrong: one follow-up to add
  `path[key]` addressing.
- **R2. Kernel route secrets.** No kernel route schema carries a secret marker today. This plan
  marks route fields with the SDK's `secret()` (`packages/plugin-sdk/src/secret.ts`, meta
  `{ secret: true }`; the kernel may import the SDK). The fields are:
  `SecretEntry.value`, `CredentialValue`, `CatalogConnectorInput.credential`,
  `CatalogConnectorInput.client.clientSecret` and the template-connector `config.credential` /
  `config.client.clientSecret`. Dynamic records (`values`, `config`, `extensionConfig`) cannot
  carry a marker, so the §4.1 runtime guard covers them.
- **R3. Connector credentials** are not in `endpointSchema` (`endpointCredentialIssues` refuses
  credentials there). The person fields of a connector come from its auth method
  (`tools/credentials.ts`):
  - `bearer` / `api_key` → `credential.token`;
  - `basic` → `credential.username`, `credential.password`;
  - `oauth_code` / `oauth_client` → `client.clientSecret` (`clientId` stays a param).
- **R4. Connector PATCH** carries no endpoint and no credential (`UpdateBody`, connectors.controller.ts:91).
  Its exclusion reason is wrong. It becomes `connectors.update` without `tools` (per-tool policy
  is the agent's own permission, §7.3), so `tools` is in `omits`.
- **R5. Decision route.** The route stays open to PATs for ordinary tool approvals (as today). An
  approval with person fields:
  - can be approved only in a web session (`auth.session_required`);
  - can be approved only by its `requested_for` person (others get the usual 404);
  - can never be approved from IM.
  
  A deny needs no values and works everywhere. A call with person fields whose ask would be a role
  escalation (`requested_for` null) is denied before the card: "This write needs the person you work
  for to enter values; they lack the role. Ask an admin to do it on the web."
- **R6. Always ask.** A call with person fields always asks:
  - never a remembered grant, a session grant or an `allow` policy override;
  - an unattended run (scheduled task) is refused, since no person is there to type.
  
  `CallPolicy` gains a field the pipeline honours before `decide`.
- **R7. Leak check reads PG, not memory.** One SQL query per submitted value:
  - `strpos(payload::text, $1) > 0` over `capybara.conversation_events`, for every conversation of
    the root conversation's tree (`conversationTree`), with `$1` = the value JSON-escaped
    (`JSON.stringify(v).slice(1, -1)`);
  - every event type counts, so over-matching only makes the refusal stricter;
  - the value is a bind parameter; the test proves no log line carries it.
- **R8. Policy step knows the call.** `CallPolicyContext` gains `callId` (the pipeline has
  `call.id` at pipeline.ts:1243). File references need it for the device reader's activation gate.
- **R9. Thumbnails.** The card's image thumbnail is made at the policy step with sharp (already a
  kernel dependency, 0.35.5): 160 px max edge, WebP q70. It is stored in the approval `detail` as
  a data URL, capped at 24 KiB, and left out when larger.
- **R10. Invitation link reveal** uses a second sealed table (`platform_sealed_reveals`, PR 2
  migration), read once on the web by the approver like the initial password. Generalizing
  `account_initial_passwords` would change an applied migration's meaning.

## Global Constraints

- Secrets never enter the event log, a tool result, the approval `input`/`detail`, an audit row or
  a log line; only field paths are recorded (`inputsProvided: ["apiKey"]`).
- The card asks only for fields the target schema marks secret (`x-secret` / `secret()` meta). Labels,
  descriptions and widgets come from the schema node, never from the model.
- Per value: 16 KiB at most. Per call: 32 person fields at most.
- Sealed inputs: AES-256-GCM through `Keyring.wrap` / `unwrap` (`ctx/secrets.ts`), AAD
  `capybara:platform-sealed-input:<approvalId>:<sorted paths joined by ",">`, TTL 15 minutes from
  the decision; cleaned hourly by the existing `InitialPasswordCleanupJob` (`@LockedCron("20 * * * *")`,
  `WorkerModule`).
- Leak check: values of 8 characters or more. Refusal copy (person, web):
  - en: "This value appeared in the conversation, so it counts as leaked. Create a new one at the provider and enter that."
  - zh: "这个值在对话里出现过，视为已泄露。请到服务商那里新建一个再填写。"
- Model-visible copy (English, exact):
  - secret in values: "Secret fields are entered by the person on the confirmation card; leave `<path>` out of values and list it in askPerson. A value passed in params has been seen by the model and counts as leaked: tell the person to rotate it."
  - leaked on card: "The person's `<path>` appeared in the conversation earlier and was refused as leaked; ask them to rotate it."
  - expired: "The values the person entered expired before they were applied; call the operation again."
  - result line per field: "`<path>`: entered by the person".
- IM card for a person-field approval: a `bind` card, text zh "需要在网页填写 N 项" / en "N fields to fill in on the web", URL = the conversation's web URL.
- Files: `AGENT_AVATAR_MAX_BYTES` (2 MiB, png/jpeg/webp); `SKILL_PACKAGE_UPLOAD_MAX_BYTES` (50 MiB, `application/zip`); `packages.maxBytes` for plugin and extension packages. A file over the limit is refused before the card.
- Operations call the same service methods the routes call; no new business logic in an op.
- Multi-replica: nothing in process; writes in `@Transactional()`; the sealed row is written in the decision transaction and consumed in the write's transaction.
- English for code, comments and model-facing text; UI copy through i18n (zh and en), zh says 平台 / 超级管理员 / 智能体.
- Migrations: next free numbers after `0168` at implementation time, expand-only, `IF NOT EXISTS`, schema `capybara`.
- New unit tests join `packages/kernel/test/unit-tests.json`; integration is the default list.
- Every removed exclusion becomes an operation or gets a §7.1 reason; `pnpm check:platform-ops` and `platform-parity.test.ts` stay green.

## Review Focus

1. **A person-field call that would run without a person**, such as a remembered `Platform` grant,
   an admin's `allow` override for the tool, or a scheduled task. Expected: the call still asks, or
   is refused in the unattended case (R6). Pinned in Task 4.
2. **The approval card reopened after the values expired**: the person approves, the run is queued
   behind a long step, and 15 minutes pass. Expected: the call returns the "expired" text, applies
   nothing, and a new call works. Pinned in Task 5.
3. **A key that is a substring of a longer token in the conversation**, or JSON-escaped (a key
   containing `"` or `\`). Expected: still refused as leaked (R7 escapes the same way the payload
   is stored). Pinned in Task 3.
4. **Two tabs approving the same card with different values.** Expected: one decision wins
   (`approval.already_decided` for the other). Only the winner's sealed row exists. Pinned in Task 5.
5. **A device file changed between the card and the run.** Expected: the call refuses with "The
   file changed after the person confirmed it; call the operation again." Nothing is stored.
   Pinned in Task 14.

---

## PR 1: person fields

### Task 1: Sealed inputs store

**Files:**
- Create: `packages/kernel/src/migrations/<NNNN>_platform_sealed_inputs.sql`
- Create: `packages/kernel/src/platform/sealed-inputs.ts`
- Modify: `packages/kernel/src/db/kernel-schema.ts` (table type), `packages/kernel/src/ctx/secrets.ts` (AAD helper), `packages/kernel/src/identity/initial-passwords.job.ts` (cleanup), `packages/kernel/src/platform/platform.module.ts` (provider)
- Test: `packages/kernel/test/platform/sealed-inputs.test.ts`

**Interfaces:**
- Produces:
  - `platformSealedInputAad(approvalId: string, paths: readonly string[]): string`;
  - `SEALED_INPUT_TTL_MS = 15 * 60 * 1000`;
  - `class SealedInputs` (`@Injectable`, injects `KernelDb`, `TransactionHost` as `txHost`, `KEYRING`):
    - `sealIn(row: { approvalId; recipientAccountId; conversationId; runId; callId }, values: Readonly<Record<string, string>>): Promise<void>`, transaction `mandatory`;
    - `consume<T>(approvalId: string, recipientAccountId: string, apply: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T>`, `@Transactional()`: locks, deletes and unwraps the row, then runs `apply` in the same transaction; throws `SealedInputsExpiredError` when the row is missing or past `expires_at`;
  - `deleteExpiredSealedInputs(db: KernelSchemaDb): Promise<number>`.

- [ ] **Step 1: Write the failing tests** (integration, one app):
  - `seals and consumes once`: `sealIn` then `consume` gets `{ apiKey: "k-123456789" }`; a second `consume` rejects `SealedInputsExpiredError`.
  - `stores no plaintext`: `SELECT ciphertext::text` does not contain the value.
  - `wrong recipient`: `consume` with another account rejects `SealedInputsExpiredError`.
  - `expired rows`: with `expires_at` set in the past, `consume` rejects and `deleteExpiredSealedInputs` returns 1.
  - `apply failure rolls back`: when `apply` throws, the row still exists afterwards.
  - `AAD binds paths`: a row whose stored paths are altered fails to unwrap and is treated as expired.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/platform/sealed-inputs.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Write the migration. Use the columns from spec §4.3 plus `paths text[] NOT NULL`. Add FKs as in `0090_initial_passwords.sql`: `approval_id` → `capybara.approvals(id)` ON DELETE CASCADE, recipient → accounts, conversation → conversations. Add an index on `expires_at`. Then implement `sealed-inputs.ts`. Values are stored as one JSON object wrapped with the AAD. Extend `InitialPasswordCleanupJob.cleanup()` to also call `deleteExpiredSealedInputs`, and log both counts.
- [ ] **Step 4:** Run the test. Expected: PASS. Run `pnpm check` for the migrations checks.
- [ ] **Step 5: Commit** `feat(kernel): add the sealed person inputs store`.

### Task 2: Person field rules (shared guard)

**Files:**
- Create: `packages/kernel/src/platform/person-fields.ts`
- Test: `packages/kernel/test/platform/person-fields.test.ts` (unit; add it to `unit-tests.json`)

**Interfaces:**
- Produces:
  ```ts
  export const PERSON_FIELD_MAX_BYTES = 16 * 1024;
  export const PERSON_FIELDS_MAX = 32;
  export interface PersonFieldSpec {
    path: string;                       // dot path, R1
    label: string;                      // from the node's x-ui.label / title, else the path
    description?: string;               // from x-ui.help / description
    multiline: boolean;                 // x-ui widget textarea, or a JSON-like secret
    required: boolean;
    isSet: boolean;                     // a stored value exists
    schema: Record<string, unknown>;    // the scrubbed JSON Schema node (no defaults/examples)
  }
  export interface PersonFieldTarget { target: { zh: string; en: string }; fields: PersonFieldSpec[]; recordOnly?: string[] }
  export const personFieldParams: { askPerson: z.ZodType<string[]>; clearSecrets: z.ZodType<string[]> }; // arrays of ≤200-char paths, ≤32 each, default []
  export function secretFieldsOf(jsonSchema: unknown, stored: ReadonlySet<string>): { fields: PersonFieldSpec[]; recordOnly: string[] };
  export type PersonFieldPlan = { ok: true; ask: PersonFieldSpec[]; clear: string[] } | { ok: false; message: string };
  export function planPersonFields(t: PersonFieldTarget, p: { values?: Record<string, unknown>; askPerson: string[]; clearSecrets: string[] }): PersonFieldPlan;
  export function checkPersonValue(spec: PersonFieldSpec, value: string): string | null; // null = valid, else an English problem
  ```

- [ ] **Step 1: Write the failing tests**:
  - `secretFieldsOf`: on `configJsonSchema(z.object({ baseUrl: z.string(), apiKey: secret(z.string()), nested: z.object({ token: secret(z.string()).optional() }) }))` it returns paths `["apiKey", "nested.token"]`, with `required` `[true, false]`. A secret record under `x-ui.secrets` goes to `recordOnly`.
  - `planPersonFields` refuses a secret in `values` with exactly the Global Constraints copy, with `<path>` = `apiKey`. The message contains no part of the value.
  - It refuses `askPerson: ["baseUrl"]` with "baseUrl is not a secret field of this target; only these can be asked: apiKey, nested.token".
  - It adds a required unset secret (`apiKey`, `isSet: false`) to `ask` when not named. It does not add a set one.
  - It refuses a path in both `askPerson` and `clearSecrets`.
  - It refuses more than 32 asks.
  - `checkPersonValue` refuses a value over 16 KiB (bytes, UTF-8) and one failing the node's `minLength` / `pattern`. It accepts a valid one.
- [ ] **Step 2:** Run `pnpm test:unit -- person-fields`. Expected: FAIL.
- [ ] **Step 3:** Implement. Validate the node with the kernel's existing JSON Schema validator; search for the one `deployment-config.ts` uses and reuse it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): add the person field rules for platform writes`.

### Task 3: Leak check

**Files:**
- Create: `packages/kernel/src/conversations/leak-check.ts`
- Modify: `packages/kernel/src/conversations/conversations.module.ts` (provider and export)
- Test: `packages/kernel/test/conversations/leak-check.test.ts`

**Interfaces:**
- Produces: `class ConversationLeakCheck` (`@Injectable`), with `leaked(conversationId: string, values: Readonly<Record<string, string>>): Promise<string[]>`. It returns the paths whose value (8 characters or more) appears in the root conversation's tree, per R7. Shorter values are never matched.

- [ ] **Step 1: Write the failing tests**:
  - A key in a user message → `["apiKey"]`.
  - A key in a sub-agent's tool result → found.
  - A key inside a longer token in an assistant message → found.
  - A key with `"` and `\` → found.
  - A key only in another conversation → `[]`.
  - A 7-character value present → `[]`.
  - The captured kernel log after the call contains no value.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement with `conversationTree` from `conversations/tree.ts`, run on the root conversation (`conversations.root_conversation_id`, or walk up `parent_conversation_id`). Use one `strpos` query per value, as a bind parameter.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): check entered values against the conversation`.

### Task 4: Tool and pipeline plumbing

**Files:**
- Modify: `packages/kernel/src/platform/operation.ts`, `packages/kernel/src/tools/builtins/platform.ts`, `packages/kernel/src/tools/registry.ts` (`CallPolicy`, `CallPolicyContext.callId`, `BuiltinCallContext.approvalId`), `packages/kernel/src/tools/pipeline.ts` (policy ctx, forced ask, approval `detail`, `approvalId` in the call context), `packages/kernel/src/tools/policy.ts`, `packages/kernel/src/tools/approvals.service.ts` (`request` takes `detail` for tool kind; `ApprovalView.personFields`), `packages/kernel/src/platform/method.ts` (model-visible method text)
- Test: `packages/kernel/test/platform/person-fields-e2e.test.ts`. Model it on `accounts-create-e2e.test.ts`, with a test-only operation registered through the registry's test seam.

**Interfaces:**
- Consumes: Task 1 `SealedInputs`, Task 2 `PersonFieldTarget`, `planPersonFields`, `personFieldParams`.
- Produces:
  - `PlatformOperation.personFields?(input: I, ctx: OperationContext): Promise<PersonFieldTarget>`.
  - `OperationContext.personInputs?: { paths: readonly string[]; apply<T>(fn: (values: Readonly<Record<string, string>>) => Promise<T>): Promise<T> }`, present when the approved call has person fields.
  - `CallPolicy.personFields?: { target: { zh: string; en: string }; fields: PersonFieldSpec[] }`. The asked fields only; the pipeline stores them in `approvals.detail.personFields` and `detail.target`.
  - `ApprovalView.personFields?: PersonFieldSpec[]` and `ApprovalView.personTarget?`.
  - `BuiltinCallContext.approvalId?: string`.

- [ ] **Step 1: Write the failing e2e tests** (model-fake script calling `Platform` with the test operation):
  - **Card.** A call with `askPerson: ["apiKey"]` creates an approval with `scopes: ["once"]` and `detail.personFields[0].path === "apiKey"`. Its `input` holds no value.
  - **Run (seeded).** After a sealed row is seeded and the approval approved, the op's `run` gets `personInputs.paths` `["apiKey"]` and `apply` yields the value. The tool result text contains "apiKey: entered by the person" and not the value.
  - **Values refused.** `values: { apiKey: "x" }` is denied before the card with the Global Constraints copy.
  - **R6 grants.** With a `tool_grants` row for `Platform:<op>` and a `Platform` tool policy override `allow`, the call still asks.
  - **R6 unattended.** The same call in an unattended run is refused: "This write needs the person to enter values on the web; it cannot run unattended."
  - **R5.** A call whose ask is a role escalation is denied with the R5 copy.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/platform/person-fields-e2e.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `callPolicy`, after availability, call `op.personFields` and `planPersonFields`. Deny with the plan's message, or with `platform.secret_record_web_only` (R1) when only record fields are missing. Return `personFields` with `remember: false`.
  - In `call`, build `personInputs` from `ctx.approvalId` and `SealedInputs.consume`. Map `SealedInputsExpiredError` to `ToolError` with the expired copy. Append the result lines.
  - In the pipeline, a `callPolicy.personFields` forces `ask` before grants. Refuse unattended runs. Pass `detail` into `approvals.request` and `approvalId` into the call context when `approvedHere`.
  - Add one paragraph to `PLATFORM_METHOD` explaining `askPerson` / `clearSecrets`.
- [ ] **Step 4:** Run the test, then `pnpm exec vitest run packages/kernel/test/platform`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): let platform writes ask the person for secret fields`.

### Task 5: Decision route takes the inputs

**Files:**
- Modify: `packages/kernel/src/tools/approvals.controller.ts` (`inputs` in `DecisionBody`), `packages/kernel/src/tools/approvals.service.ts` (`decideTx`), `packages/kernel/src/channels/actions.ts` (IM refusal), `packages/kernel/src/conversations/events.ts` (`approval_decided.inputsProvided?: string[]`, display only), `packages/kernel/src/errors.ts`
- Test: `packages/kernel/test/platform/person-fields-decide.test.ts`

**Interfaces:**
- Consumes: Task 1 `SealedInputs.sealIn`, Task 2 `checkPersonValue`, Task 3 `ConversationLeakCheck.leaked`, Task 4 `detail.personFields`.
- Produces:
  - `DecisionBody.inputs?: Record<string, string>` (≤32 keys, each ≤16 KiB; strict);
  - error codes:
    - `approval.inputs_invalid` (422, `details.fields: { path, problem }[]`);
    - `approval.input_leaked` (422, `details.fields: string[]`);
    - `approval.inputs_not_expected` (400);
    - reuse `auth.session_required`;
  - a leak refusal adds the paths to `approvals.detail.leakedFields` (paths only). If the call then ends without running (the person declines, or the approval expires), its tool result appends the Global Constraints "leaked on card" copy for each path, so the agent tells the person to rotate the key.

- [ ] **Step 1: Write the failing tests** (HTTP through the app):
  - **Approve.** Approve with valid inputs → 200. The sealed row exists. The `approval_decided` event has `inputsProvided: ["apiKey"]` and no value. The audit detail has `inputsProvided`. No row in `conversation_events` or `audit_events` contains the value.
  - **Missing input.** Approve without a required input → `approval.inputs_invalid`, and the approval stays `pending`.
  - **Undeclared path.** An input path not in `detail.personFields` → `approval.inputs_not_expected`.
  - **Leaked.** A value present in a user message → `approval.input_leaked` with `fields: ["apiKey"]`; still pending. A fresh value then → 200. A leak refusal followed by a deny → the tool result carries the "leaked on card" copy for `apiKey`.
  - **PAT.** Approve with a PAT → `auth.session_required`. Deny with a PAT → 200.
  - **IM.** An IM `card_action` approve on a person-field approval replies `cannotHandle`.
  - **Two tabs (Review Focus 4).** Two concurrent approves with different values → one 200, one `approval.already_decided`, and exactly one sealed row.
  - **Expired (Review Focus 2).** Approve, then move `expires_at` into the past before the resume → the tool result is the expired copy and the op's apply was never called. A new call then succeeds.
  - **Logs.** The captured request log for these calls contains no value.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement** in `decideTx`, after the pending/expiry checks, for a tool-kind approval with `detail.personFields`:
  - refuse a PAT (`actorTokenId` set) or `via: "im"` on approve;
  - validate with `checkPersonValue`;
  - run `leaked`;
  - `sealIn` before the status update.
  
  The leak check is a read inside the transaction; it is acceptable because it is bounded by one indexed scan per value. Measure it on a 5k-event conversation in the test and record the time in the report.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): accept person inputs with an approval decision`.

### Task 6: IM and inbox show web-only approvals

**Files:**
- Modify: `packages/kernel/src/channels/outbound.ts` (`approvalCardAt`), `packages/kernel/src/channels/cards.ts` (a `personFieldsCard` helper building a `bind` card), `packages/kernel/src/channels/phrases.ts` (zh/en copy from Global Constraints)
- Test: `packages/kernel/test/channels/approval-person-fields.test.ts` (fake-im)

**Interfaces:**
- Consumes: Task 4 `ApprovalView.personFields`.

- [ ] **Step 1: Write the failing test.** An approval with two person fields sends a `bind` card: text "需要在网页填写 2 项", URL ending in the conversation path, and no approval card. On a channel without card support, the text fallback has the same line and URL. Ordinary approvals are unchanged.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. The inbox needs no kernel change (it carries `ApprovalView`).
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): send web-only person field approvals to IM as a link`.

### Task 7: Design component: person field row

**Files:**
- Create: `packages/design/src/conversation/person-field.tsx` (export `PersonFieldRow`)
- Modify: `packages/design/src/conversation/hitl.tsx` (`ApprovalBlock` gains `personFields?: { path; label; description?; multiline; error?: string; value: string; onChange(v: string): void }[]` and `personTarget?: string`), the design index exports, the `/dev/ui` gallery entry, design i18n strings if the package has them
- Test: the design package's jsdom tests next to `hitl` (follow the existing `hitl` test file)

**Interfaces:**
- Produces: `PersonFieldRow` props `{ label: string; description?: string; multiline: boolean; value: string; error?: string; onChange(v: string): void; disabled?: boolean }`.
  - It renders a masked input (`type="password"`, `autocomplete="off"`) or a masked textarea, with an inline error.
  - It has no reveal toggle and no prefill.

- [ ] **Step 1: Write the failing tests:**
  - The row renders a password input with the label.
  - `onChange` fires.
  - The error text shows with `aria-invalid`.
  - `ApprovalBlock` with two fields renders two rows inside its existing box (`findNestedBoxes` finds none).
- [ ] **Step 2:** Run `pnpm exec vitest run packages/design`. Expected: FAIL.
- [ ] **Step 3:** Implement with the design tokens, per the `writing-web-ui` skill. Visual baselines are updated only by the `visual-update` workflow, so don't render them locally.
- [ ] **Step 4:** Run the tests and `pnpm check:web-ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(design): add the approval card person field row`.

### Task 8: Web approval card collects the inputs

**Files:**
- Modify: `apps/web/src/components/ApprovalCard.tsx` (local state for values, never persisted; pass `inputs` on approve; map `approval.inputs_invalid` / `approval.input_leaked` to per-field errors in place; clear values after success), `apps/web/src/lib/approvals.ts` (`decideApproval` body `inputs?`, `ApprovalView.personFields`), `apps/web/messages/{zh,en}.json`
- Test: `apps/web/test/approval-card-person-fields.test.tsx` (jsdom, `renderRouteWithCache` style as the existing ApprovalCard tests)

**Interfaces:**
- Consumes: Task 5 error codes and body, Task 7 `ApprovalBlock.personFields`.

- [ ] **Step 1: Write the failing tests:**
  - Approve is disabled until every field has a value.
  - Approve posts `{ decision: "approve", scope: "once", inputs: { apiKey: "…" } }`.
  - A 422 `approval.input_leaked` shows the leak copy under that field and keeps the card pending.
  - Deny posts no `inputs`.
  - The values are not in the query cache after success (`qc.getQueryCache()` serialized has no value).
- [ ] **Step 2:** Run `pnpm exec vitest run apps/web/test/approval-card-person-fields.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Put the zh/en copy in messages; `pnpm check:i18n` must pass (it now also catches unknown keys).
- [ ] **Step 4:** Run the tests and `pnpm check:web-ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): enter secret fields on the approval card`.

### Task 9: Extension config operations, fence rule and docs

**Files:**
- Modify: `packages/kernel/src/platform/ops/extensions-admin.ops.ts` (deployment config), `packages/kernel/src/platform/ops/extensions.ops.ts` (org config and copy), `packages/kernel/src/platform/ops/plugins.ops.ts` (`plugin.needs_input` next step names `extensions.set-org-config`), `packages/kernel/src/admin/extensions.schemas.ts` and `packages/kernel/src/catalog/org-extension.schemas.ts` (export the config/overrides body schemas into `*_ROUTES`; mark `SecretEntry.value` with `secret()` per R2), `packages/kernel/src/platform/exclusions.ts` (remove the moved routes), `packages/kernel/src/platform/parity.ts` (new rule), `tools/checks/fixtures/platform-parity/cases.ts`, `tools/checks/test/platform-parity.test.ts`, `tools/checks/README.md`, `AGENTS.md` (Platform tool line), `.agents/skills/writing-kernel-api/SKILL.md`, `.agents/skills/writing-tools/SKILL.md`, the Platform agent docs topic if one covers operations (`platform/agent-docs.ts`)
- Test: `packages/kernel/test/platform/ops-extension-config.test.ts`

**Interfaces:**
- Consumes: Task 2 `personFieldParams`, `secretFieldsOf`; Task 4 `personFields` / `personInputs`.
- Produces these operations, each mirroring the route, with `secretEntries` in `omits` (R1):

  | Operation | Mirrors | Class | Calls |
  |---|---|---|---|
  | `extensions.platform-config` (read) | `GET /api/v1/admin/extensions/:name/config` | read | `deploymentConfigs.view` |
  | `extensions.platform-set-config` | `PUT …/admin/extensions/:name/config` | platform | `deploymentConfigs.put(name, {...values, ...entered, ...clears→null}, …)` |
  | `extensions.platform-clear-config` | `DELETE …/admin/extensions/:name/config` | platform, `rememberable: false` | `deploymentConfigs.clear` |
  | `extensions.org-config` (read) | `GET …/extensions/:extension/overrides` | read | `orgOverrides.view` |
  | `extensions.set-org-config` | `PUT /api/v1/orgs/:orgId/extensions/:extension` | org | `OrgExtensionSwitch.put` with `config` |
  | `extensions.take-org-config` | `POST …/overrides/take` | org | `orgOverrides.take` |
  | `extensions.save-org-config` | `PUT …/overrides` | org | `orgOverrides.save` |
  | `extensions.drop-org-config` | `DELETE …/overrides` | org, `rememberable: false` | `orgOverrides.reset` |

  - Parity rule `platform-op-secret-param`: a route body field with `secret()` meta must be in the op's `omits`, and the op must define `personFields`.
  - `GET …/admin/extensions/:name/org-overrides` stays `secret` (other orgs' copies), with its reason rewritten to the §7.1 meaning.

- [ ] **Step 1: Write the failing tests:**
  - **Acceptance 1 and 2 in-kernel.** `extensions.set-org-config` with `values: { baseUrl }` and `askPerson: ["apiKey"]`: the approval has the field. After a seeded sealed row and approval, the org config view shows `apiKey` set.
  - **Key grep.** A grep of `conversation_events`, `audit_events`, `approvals` and the captured log for the key finds nothing.
  - **Read op.** `extensions.platform-config` shows secrets as set or unset, never as values.
  - **Plugins precheck.** `plugins.set-enabled` with missing input returns `plugin.needs_input` whose next step names `extensions.set-org-config`.
  - **Fence.** A parity fixture whose op takes the route's `secret()` field as a param is red with `platform-op-secret-param`; the real tree is clean.
- [ ] **Step 2:** Run the kernel test and `pnpm exec vitest run tools/checks/test/platform-parity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Each op's `personFields` loads the target's config JSON Schema (`deploymentConfigs.view(name).schema` / `orgOverrides.view(...).schema`) and the stored-set paths, then calls `secretFieldsOf`.
  - Each `run` calls `ctx.personInputs.apply(values => service(...))` when present, else the service directly. Pass the audit detail `{ via: "agent", operation, agentConversationId, agentRunId, inputsProvided }` (spec §10) the way the existing ops pass `viaAgent(...)`.
  - Add the AGENTS.md sentence from the spec's "AGENTS.md rules touched" (Platform tool line) and the skill notes.
- [ ] **Step 4:** Run the tests, `pnpm check:platform-ops`, `pnpm check:agent-docs`, then `pnpm verify`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): configure extensions through the platform tool`. Add the changeset and open PR 1 (after the user says so).

---

## PR 2: connectors, channels, catalog installs, members, handoff view

### Task 10: Connector and catalog operations on person fields

**Files:**
- Modify: `packages/kernel/src/platform/ops/connectors.ops.ts`, `packages/kernel/src/platform/ops/org-plugins.ops.ts` (catalog install), `packages/kernel/src/tools/connectors.schemas.ts` (export create/preview/update/credential bodies into `CONNECTOR_ROUTES`; `secret()` on `CredentialValue`), `packages/kernel/src/catalog/org-catalog.schemas.ts` (R2 markers; route entries), `packages/kernel/src/platform/exclusions.ts`
- Create: `packages/kernel/src/platform/connector-person-fields.ts`: `connectorPersonFields(auth: ConnectorAuth, stored: ReadonlySet<string>): PersonFieldSpec[]` per R3, with fixed labels ("Token", "Username", "Password", "Client secret") and string schemas `minLength: 1`.
- Test: `packages/kernel/test/platform/ops-connectors-person-fields.test.ts`, plus a unit test `packages/kernel/test/platform/connector-person-fields.test.ts` (add it to `unit-tests.json`)

**Interfaces:**
- Consumes: Tasks 2 and 4.
- Produces these operations:

  | Operation | Mirrors | Class | Notes |
  |---|---|---|---|
  | `connectors.kinds` (read) | `GET …/connectors/kinds` | read | from `internal` |
  | `connectors.preview` (read) | `POST …/connectors/preview` | read | `credential` omitted; tools needing a credential come back unknown |
  | `connectors.create` | `POST …/connectors` | org | person fields per R3 |
  | `connectors.update` | `PATCH …/connectors/:connectorId` | org | `tools` omitted (R4) |
  | `connectors.set-org-credential` | `PUT …/credentials/org` | org | |
  | `connectors.set-my-credential` | `PUT …/credentials/me` | personal, `rememberable: false` | |
  | `connectors.clear-my-credential` | `DELETE …/credentials/me` | personal | |
  | `connectors.add-from-template` | `POST …/connector-templates/:templateId/connectors` | org | |
  | `plugins.install` | `POST …/catalog/:itemId/install` | org | connector credentials, client secrets and `extensionConfig` secrets as person fields, paths prefixed `connectors.<templateId>.` / `extensionConfig.` |
  | `plugins.configure-connectors` | `POST …/catalog/:itemId/connectors` | org | |
  | `connectors.guide-ack` | `POST …/connectors/:connectorId/guide-ack` | personal | card text = the statement confirmed |

- [ ] **Step 1: Write the failing tests:**
  - **Unit.** `connectorPersonFields` returns `credential.token` for bearer and api_key, `credential.username` + `credential.password` for basic, and `client.clientSecret` for oauth.
  - **Create.** `connectors.create` (bearer, fake connector) with `askPerson: ["credential.token"]`, then a seeded sealed row and approval: `connectors.get` shows the credential set.
  - **R4.** `connectors.update` refuses `tools`.
  - **Install.** `plugins.install` with a template connector: the person field path is `connectors.<templateId>.credential.token`.
  - **Exclusions.** The removed exclusions are gone. `check:platform-ops` and parity are clean.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Each `run` assembles the route body with entered values inside `personInputs.apply`.
- [ ] **Step 4:** Run, then `pnpm check:platform-ops`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): create and credential connectors through the platform tool`.

### Task 11: Channel operations

**Files:**
- Modify: `packages/kernel/src/platform/ops/channels.ops.ts`, `packages/kernel/src/channels/channels.schemas.ts` (route entries for `POST` and `GET schema/:plugin`), `packages/kernel/src/platform/exclusions.ts`
- Test: `packages/kernel/test/platform/ops-channels-create.test.ts`

**Interfaces:**
- Produces:
  - `channels.schema` (read; `channels.jsonSchema(plugin)`);
  - `channels.create` (org; person fields from the plugin connection schema via `secretFieldsOf`);
  - `channels.guide-ack` (personal; `POST …/channels/:connectionId/guide-ack`).

- [ ] **Step 1: Write the failing test.** `channels.create` against the fake channel plugin, with the app secret asked → the connection exists and its config view shows the secret as set. `channels.schema` shows `x-secret` and no values.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): create channels through the platform tool`.

### Task 12: Member management and invitation link reveal

**Files:**
- Create: `packages/kernel/src/migrations/<NNNN>_platform_sealed_reveals.sql`, `packages/kernel/src/platform/sealed-reveals.ts`, `packages/kernel/src/platform/sealed-reveals.controller.ts` (`POST /api/v1/orgs/:orgId/approvals/:approvalId/invitation-link`, `@SessionOnly()`, `@OrgAction("org.invitations.manage")`)
- Modify: `packages/kernel/src/platform/ops/orgs.ops.ts`, `packages/kernel/src/orgs/orgs.schemas.ts` (route entries), `packages/kernel/src/platform/exclusions.ts` (moved routes; the new reveal route is excluded as `secret`, delivering to a browser), the cleanup job (Task 1 file), `apps/web/src/components/InvitationLinkReveal.tsx` (mirror `InitialPasswordReveal.tsx`), `apps/web/src/components/ApprovalCard.tsx` (show it for `Platform:orgs.invite` approved by me), `apps/web/src/lib/approvals.ts`, messages
- Test: `packages/kernel/test/platform/ops-members.test.ts`, the web jsdom test next to the initial password reveal test

**Interfaces:**
- Produces these operations (class `org`, `rememberable: false`):
  - `orgs.invite`: `InvitationsService.create`. The result has the invitation without a token; the token is sealed for the approver (`SealedReveals.sealIn`, TTL 24 h like initial passwords).
  - `orgs.invitations` (read): `list`, with tokens stripped.
  - `orgs.revoke-invitation`.
  - `orgs.set-member-role`: refuses the actor's own account (`member.self`), an owner target or `role: "owner"` (`member.owner_untouchable`), and a role above the actor's (`member.role_above_actor`). The service's own checks stay.
  - `orgs.remove-member`: refuses self and owners the same way.
  - `SealedReveals.reveal(orgId, approvalId, accountId): Promise<{ url: string }>`, read-once like `InitialPasswords.reveal`, audited `org.invitation_link_shown`.

- [ ] **Step 1: Write the failing tests:**
  - An admin's agent invites a `member`; the result has no token; the approver reveals the link once; a second reveal is unavailable.
  - An admin cannot invite an `owner` (refused before the card), cannot change their own role, and cannot remove the owner.
  - A PAT reveal → `auth.session_required`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `pnpm check:platform-ops` and `pnpm check:web-ui`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): manage org members through the platform tool`.

### Task 13: Handoff view and OAuth connect

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts` (`ToolViewSchema` kind `handoff`: `{ kind: "handoff"; title: { zh; en }; target: { type: "link"; url: string } | { type: "connect"; connectorId: string } }`, with url a relative web path), `packages/kernel/src/platform/operation.ts` (`handoff?(input: I, result: unknown, ctx: OperationContext): HandoffView | null`), `packages/kernel/src/tools/builtins/platform.ts` (attach `view`; put the URL in the result text as `reviewUrl`), `packages/kernel/src/channels/outbound.ts` (forward a `tool_result` whose view is `handoff`/`link` as a `bind` card with the absolute URL; `connect` as the conversation link), `packages/kernel/src/platform/ops/connectors.ops.ts` (`connectors.connect`, personal, no `run` side effect: returns the state and the handoff), `apps/web/src/lib/timeline.ts` and the tool row component (render `HandoffCard`: title + `LinkButton`; `connect` calls the existing connect mutation and navigates to `authorizationUrl`), messages
- Test: `packages/kernel/test/platform/handoff-view.test.ts`, `packages/kernel/test/channels/handoff-card.test.ts`, `apps/web/test/handoff-card.test.tsx`

**Interfaces:**
- Produces: `type HandoffView` (exported from `operation.ts`), consumed by Task 16.

- [ ] **Step 1: Write the failing tests:**
  - **Kernel.** `connectors.connect` returns a result whose text says "The person was shown a Connect button; check connectors.get for the connection state." and whose `tool_result` event has `view.kind === "handoff"`. The view is not model-visible (request building ignores it; run the replay-evals zero-drift fixture tests).
  - **IM.** The fake channel receives a `bind` card with the absolute URL.
  - **Web.** The card renders the title. `link` opens the URL. `connect` posts `…/connectors/:id/connect` and navigates.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Remove the `POST …/connectors/:connectorId/connect` exclusion: its operation mirrors it, and the browser-bound start stays in the web card. Keep `GET /api/v1/oauth/callback` as `secret`.
- [ ] **Step 4:** Run the tests and the zero-drift tests (`replay-evals` skill). Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): pop up handoff link cards from platform results`. Add the changeset and open PR 2 (after the user says so).

---

## PR 3: files instead of uploads, handoffs everywhere, re-audit

### Task 14: File references

**Files:**
- Create: `packages/kernel/src/platform/file-ref.ts`
- Modify: `packages/kernel/src/platform/operation.ts` (`fileRef?(input: I): { ref: FileRef; limits: FileLimits } | null`), `packages/kernel/src/tools/builtins/platform.ts` (policy step reads, checks, hashes and thumbnails; `detail.file`; run re-reads and compares), `packages/kernel/src/tools/registry.ts` (R8), `packages/kernel/src/tools/pipeline.ts` (pass `callId`)
- Test: `packages/kernel/test/platform/file-ref.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const FileRefSchema: z.ZodType<FileRef>; // { fileId: uuid } | { path: absolute string ≤ 4096 }
  export interface FileLimits { maxBytes: number; contentTypes?: readonly string[] }
  export interface ResolvedFile { name: string; contentType: string; size: number; sha256: string; bytes: Uint8Array }
  export class FileRefs { // @Injectable
    resolve(ref: FileRef, limits: FileLimits, ctx: { orgId; conversationId; actorAccountId; callId; signal }): Promise<ResolvedFile>;
  }
  // card detail: { name, size, sha256, contentType, thumbnail?: string /* data URL, R9 */ }
  ```
  - `fileId` goes through `findConversationFile`; `path` through `SandboxFileReader.read` (its device and path rules).
  - Over the limit → `ToolError` "The file is <n> bytes; this operation takes at most <max>." Wrong type → "…takes <types>."
  - At run time a different sha256 → `ToolError` "The file changed after the person confirmed it; call the operation again."

- [ ] **Step 1: Write the failing tests:**
  - A conversation attachment resolves with its sha256.
  - A device path resolves through the sandbox-fake device.
  - An over-limit file is denied before the card (no approval row).
  - An image gets a thumbnail ≤ 24 KiB.
  - **Review Focus 5.** The device file is rewritten after approval → the change error, and nothing is stored.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): take conversation and device files in platform writes`.

### Task 15: Upload operations

**Files:**
- Modify: `packages/kernel/src/conversations/attachments.service.ts` (`createFromBytes(orgId, accountId, purpose: "agent-avatar" | "skill-package", file: { name; contentType; bytes: Uint8Array }): Promise<{ id: string }>`: `put` into the purpose's key family (no presign), then a `ready` row with the same TTLs and pending caps), `packages/kernel/src/platform/ops/agents.ops.ts`, `agent-skills.ops.ts`, `skills.ops.ts`, `org-plugins.ops.ts` or `plugins.ops.ts`, `catalog-admin.ops.ts`, `extensions-admin.ops.ts`, `components.ops.ts`, the matching `*.schemas.ts` route entries, `packages/kernel/src/platform/exclusions.ts`
- Test: `packages/kernel/test/platform/ops-uploads.test.ts`, a case in `test/attachments/` for `createFromBytes`

**Interfaces:**
- Consumes: Task 14 `FileRefSchema`, `FileRefs`, `ResolvedFile`.
- Produces (spec §5 table):
  - `agents.update-profile`: `avatar` gains `{ kind: "file", file }` → `createFromBytes("agent-avatar")` → `profiles.update(..., { avatar: { kind: "upload", uploadId } })`.
  - `agents.upload-skill`: `AgentSkillsService.register(actor, bytes)`.
  - `skills.create-from-file`: `createFromBytes("skill-package")` → `skills.upload`.
  - `plugins.upload`: `OrgPluginUploads.prepare`.
  - `plugins.import-file`: `PluginImport.prepare(actor, bytes, { kind: "file", ref: "upload" })`.
  - `extensions.upload-package`: `installs.ingestFile`.
  - `components.upload-skill-version`: `PlatformComponents.uploadSkillVersion`.

  Upload routes' `uploadId`-style fields go in `omits`, and `file` in `extras`.

- [ ] **Step 1: Write the failing tests:**
  - **Acceptance 3.** Avatar from a `GenerateImage` artifact.
  - **Acceptance 4.** A skill zip at a device path → the org has the skill.
  - Each other op runs on a fixture package.
  - A 3 MiB avatar is denied before the card.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `pnpm check:platform-ops`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): mirror upload routes with file references`.

### Task 16: Handoffs on import and upload operations, card file row

**Files:**
- Modify: `packages/kernel/src/platform/ops/marketplaces.ops.ts`, `catalog-admin.ops.ts`, the Task 15 ops that stage a review (`plugins.upload`, `plugins.import-file`, `extensions.upload-package`), `extensions-admin.ops.ts` (pending permission confirmations link to their page), `apps/web/src/components/ApprovalCard.tsx` (file row: name, size, sha256 first 12 hex, thumbnail from `detail.file`, using existing card parts), messages
- Test: extend `packages/kernel/test/platform/handoff-view.test.ts`; `apps/web/test/approval-card-file.test.tsx`

**Interfaces:**
- Consumes: Task 13 `HandoffView`, Task 14 card detail.

- [ ] **Step 1: Write the failing tests:**
  - `marketplaces.import` returns `view.kind === "handoff"` with url `/admin/plugins/import?staging=<id>` and title zh "审阅插件 X 的权限" / en "Review the permissions of plugin X".
  - `plugins.import-npm`, `plugins.import-git`, `plugins.upload`, `plugins.import-file` and `extensions.upload-package` do the same with their page.
  - The web card shows the file row.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Find each review page's path in `apps/web/src/app`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): link import and upload reviews from the conversation`.

### Task 17: Fence rules and exclusion re-audit

**Files:**
- Modify: `tools/checks/src/platform-ops.ts` (`platform-op-upload`, `platform-op-handoff` in `PLATFORM_OP_RULES` and the header), `tools/checks/fixtures/platform-ops/{clean,violations}/…`, `tools/checks/test/platform-ops.test.ts`, `tools/checks/README.md`, `packages/kernel/src/platform/exclusions.ts` (every remaining reason restated to §7.1; `internal` reasons name the operation that gives the same facts), `AGENTS.md` (the upload half of the Platform tool sentence), the two skills
- Test: `tools/checks/test/platform-ops.test.ts`

**Interfaces:**
- Rules:
  - `platform-op-upload`: an exclusion whose reason or category mentions `upload`, `multipart` or `raw bytes` is red. Only the three attachment routes are exempt (`POST …/attachments`, `…/finalize`, `GET …/attachments/limits`), and they must use category `internal` with a reason naming "a person's file into a conversation".
  - `platform-op-handoff`: an operation whose description contains "on the web" together with "confirm" or "review" must define `handoff`.

- [ ] **Step 1: Write the failing tests.** Violation fixtures:
  - a transport exclusion "Uploads … as multipart bytes" → `platform-op-upload` at its line;
  - an op description "the person confirms on the web" without `handoff` → `platform-op-handoff`.
  
  The clean fixture stays clean.
- [ ] **Step 2:** Run `pnpm exec vitest run tools/checks/test/platform-ops.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the rules, then fix the real tree until `pnpm check:platform-ops` is clean. Both rules scan the full tree on PRs, because they are cheap source scans; say so in the PR description and the README entry.
- [ ] **Step 4:** Run the tests, `pnpm check`, then `pnpm verify`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(checks): fence uploads and handoffs in platform operations`. Add the changeset and open PR 3 (after the user says so).

## After each PR merges

Release through the Version Packages PR. Upgrade prod to the released images (standing grant), then
run the spec §11 acceptance for that PR's items on prod:
- PR 1: items 1, 2, and the person-field refusals of 5;
- PR 2: the IM item of 5, members, connectors;
- PR 3: items 3, 4, the link card item of 5, and 6.

Record the results in the line's memory note.
