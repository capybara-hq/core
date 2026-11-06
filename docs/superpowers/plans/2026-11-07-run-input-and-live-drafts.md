# Messages during a run and live drafts — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with
> wave-planned-subagent-development (main's `.agents/skills/wave-planned-subagent-development`).

**Goal:** no message queue — a message sent during a run is an interjection the timeline shows where the
model took it in; a reload or navigation resumes a streaming reply without a gap.

**Spec:** `docs/superpowers/specs/2026-11-07-run-input-and-live-drafts-design.md` (D1–D5).

## Global constraints

- Branch `docs/plugin-component-management`, worktree `.claude/worktrees/docs-plugin-component-management`.
  Local commits only (`git -c user.name=Grant -c user.email=284885069@qq.com commit`), Conventional
  Commits, body ≤ 100, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only your paths.
- A dev web + kernel run from this worktree: don't start/stop them; no `next build` / Playwright here.
- Multi-replica rules (AGENTS.md): no in-process shared state across requests; Redis writes after any
  commit; BullMQ ids without `:`; every Redis key has a TTL.
- The event log stays the single source of truth; no model-visible change; zero-drift fixture tests
  (`reconstruct.test.ts`, `rename-compat.test.ts`) pass before and after.
- UI: styles only in packages/design (spec.md, reference block, accepted.ts); copy zh+en per spec.md §7.1.
- Checks per task: lint, typecheck, `pnpm check`, vitest of the touched packages (kernel tests need the
  running PG/Redis; dual-replica helpers from `@capybara-hq/testing`).

## Interfaces fixed by this plan

- Redis key `run-draft:<runId>:<step>` → JSON `{ text: string; thinking: string }`, TTL 600 s refreshed
  on write; writes coalesced to ≤ 1 per 200 ms per step plus one at step end; deleted when the step's
  `assistant_message` or a `step_reset` is published.
- Bus delta: `{ kind: "delta", runId, step, delta: "text" | "thinking" | "step_reset", text?, offset? }` —
  `offset` now on thinking deltas too (characters of that channel before the delta).
- SSE: after the open catch-up, `event: draft` `data: { runId, step, text, thinking }` per step of an
  active run whose `assistant_message` is not in the log.
- HTTP: `GET /api/v1/orgs/:orgId/conversations/:id/runs/:runId/draft` → `{ drafts: { step, text,
  thinking }[] }` (stream access rules; 404 for an unknown run of the conversation).
- `POST …/queue` during or outside a run behaves as `POST …/messages` and answers `{ event }`.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Kernel live drafts | — | runtime/run-worker.ts (sink), new runtime/run-drafts.ts, runtime/stream.ts, runtime/stream.controller.ts (draft route) | high (multi-replica, Redis) | 1 | own, most capable |
| 2 Kernel queue → interjection | — | conversations/queue.service.ts, conversations.controller.ts (queue routes), AGENTS.md "Runtime" | normal | 1 | batched |
| 3 Web timeline placement | — | apps/web/src/lib/timeline.ts (+ its tests) | normal | 1 | batched |
| 4 Web stream resume | 1 | apps/web/src/lib/stream.ts, lib/query/conversation.ts if needed | normal | 2 | batched |
| 5 Web composer without queue | 2, batch-3 Task W done | ComposerBar / useQueue / ConversationView, design composer hint, messages | normal | 2 | batched |
| 6 e2e + docs | 1–5 | apps/web/e2e (new spec), writing-web-ui / replay-evals notes, changesets | normal | 3 | final review |

## Tasks

### Task 1 — kernel live drafts (spec §3.2)
- `RunDrafts` provider (`runtime/run-drafts.ts`, `@Injectable`, Redis via the infra Redis client):
  `append(runId, step, channel, text)` (in-memory coalescing buffer per step inside the worker process
  for ≤ 200 ms, flushed by the run's own step loop — no `setInterval`: flush on the next delta past the
  window and at step end), `clear(runId, step)`, `read(runId)` → steps with drafts.
- `sinkFor` adds `offset` to thinking deltas and feeds `RunDrafts`; step end and `step_reset` clear.
- Stream open: after catch-up, read drafts of the conversation's active run(s) not finalized in the log
  and write `event: draft` frames before forwarding deltas.
- Draft route with the stream's access check.
- Tests: coalescing (fake clock), TTL set, clear at step end/reset, snapshot frame on open (active vs
  finished), route access and 404, dual-replica (run on A, viewer on B gets the draft).

### Task 2 — kernel queue routes as interjections (spec §3.1)
- `POST …/queue` → the same path as `postUserMessage` (interjection while active), answering `{ event }`;
  leftover-item routes unchanged; the dispatcher keeps draining leftovers after each run.
- AGENTS.md "Runtime": replace the queued-messages sentence; release note in the kernel changeset.
- Tests: queue POST during a run logs a user_message absorbed by the next step; leftovers drain.

### Task 3 — web timeline placement (spec §4, D4)
- In `buildEventTimeline`, a user message with `seq` greater than the `absorbedUpToSeq` of the
  model_call steps logged after it is placed before the first model_call whose `absorbedUpToSeq` ≥ its
  seq; not absorbed while a run is active → `pending` entry after the live draft; run ended unabsorbed →
  before the next run's first step.
- Tests: the maintainer's case (interjection during a streaming single-step reply) live and from the log;
  absorbed after a tool step; pending; next-run trigger.

### Task 4 — web stream resume (spec §4)
- `stream.ts`: `event: draft` replaces that step's draft (ignored if finalized); deltas dropped when
  `offset + len ≤ draft length`; a gap fetches `…/runs/:runId/draft` through a `defineQuery` /
  plain fetch inside the stream helper (stream opener is exempt from web-query-no-direct-read) and then
  applies; tests for snapshot, duplicate drop, gap refetch, finalized ignore.

### Task 5 — web composer without a queue (spec §4)
- While a run is active ↵ and ⌘↵ post a message (no queue call); remove the queue list, its controls and
  `useQueue` (leftover items render as pending bubbles from `GET …/queue` until drained); hint copy
  「运行中发送的消息会在下一步交给智能体」 / "Messages sent while it works reach it at its next step"; design
  composer hint/state updated in spec.md.
- Tests: ↵ during a run posts `…/messages`; no queue UI; leftover pending bubbles.

### Task 6 — e2e and docs
- e2e: send during a streaming reply (fake model with a slow script), the bubble below the reply;
  reload mid-stream resumes with no gap; two running conversations switched back and forth.
- writing-web-ui / replay-evals skill notes; changesets (kernel patch, web).

## Review focus
1. A viewer on another replica during a long stream: the draft exists and is current within 200 ms.
2. Thinking and text interleaved in one step: offsets per channel, no cross-channel dedupe.
3. A run aborted mid-step: no stale draft shown after the abort event.
4. Leftover queued items from before the change still get sent.
5. Reload exactly at step end: either the final message or the draft, never both.
