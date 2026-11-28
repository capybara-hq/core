# @ conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development with the
> wave-planned-subagent-development layer to implement this plan task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** let a person reference up to three of their own conversations from the composer's `@`
menu; the kernel resolves each reference at send time into a bounded English digest logged in the
`user_message`, and the bubble shows the references as chips linking to `/chat/<id>`.

**Spec:** `docs/superpowers/specs/2026-11-28-at-conversation-design.md` (issue #1029). Read its
Decisions, Facts and Design sections before any task; this plan does not restate them.

**Architecture:** a new optional body field `conversationRefs: [{id}]` (max 3) on the shared
`MessageFields`, resolved in `resolveExtra` (outside the transaction, after the `clientMessageId`
retry check) into one text block per reference built by a pure `conversationRefText`; blocks come
after the project file lines and before uploaded file blocks, named by
`payload.conversationRefs`. Request building and replay read nothing new (no `DriftReason`). One
partial index migration for the latest `compaction_summary`. The design system gets the conversation
chip in the attachment strip and the bubble (a link), and the `chats` row form of `ComposerMenu`;
the web adds a 会话 group to `@` on the existing title search route.

**Tech stack:** NestJS kernel (zod DTOs, `@Transactional`, kysely), SQL migrations, React design
system (`packages/design`), Next web app with TanStack Query (`apps/web`), vitest, Playwright.

## Wave plan

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Kernel send path + migration | — | `packages/kernel/src/conversations/**`, `errors.ts`, migration `0196_*` (renumber before push), kernel tests, `reconstruct.test.ts`, replay-evals skill, composer menus spec §5, kernel changeset | high (trust boundary, replay, migration) | 1 | alone, most capable |
| 2 Design components | — | `packages/design/src/conversation/{composer-menu,composer,bubble,…}.tsx`, design i18n, design tests, `docs/design/spec.md`, `docs/design/reference/src/**`, `apps/web/src/dev/catalog/**` | normal | 1 | batched, mid |
| 3 Web @ group, drafts, bubble | 1 (body field, error codes, payload), 2 (component props) | `apps/web/src/components/conversation/**`, `apps/web/src/lib/{conversations,timeline}.ts`, queries, web i18n, web tests, writing-web-ui skill, composer menus spec §4, `@capybara-hq/capybara` changeset | normal | 2 | batched, mid |
| 4 Acceptance (controller) | 2, 3 | compare in the Linux Playwright image, blind review, `apps/web/visual/accepted.ts`, three size classes | normal | 3 | controller |

## Task 1: Kernel send path, digest, migration (high)

**Files:**
- Modify: `packages/kernel/src/conversations/conversations.controller.ts` (`MessageFields`,
  `textRule`, create forwarding), `permission-profiles.controller.ts` (first-message forwards
  `conversationRefs`; `projectFiles` already forwarded since #1032), `conversations.service.ts`
  (`resolveExtra`, `postUserMessage` payload), `events.ts` (`payload.conversationRefs` type),
  the errors registry (`conversation.reference_unavailable`, `conversation.reference_self`, zh/en).
- Create: `packages/kernel/src/conversations/conversation-ref.ts` (constants `MAX_CONVERSATION_REFS
  = 3`, `REF_TURN_MESSAGES = 12`, `REF_SUMMARY_MAX = 12_000`, `REF_MESSAGE_MAX = 1_500`,
  `REF_BLOCK_MAX = 16_000`; pure `conversationRefText`; the reader), migration
  `packages/kernel/src/migrations/0196_conversation_events_compaction_summary_idx.sql`.
- Tests: unit test for `conversationRefText` bounds/clipping (add to the unit list), integration
  `packages/kernel/test/conversations/conversation-refs-send.test.ts`, a case in
  `packages/kernel/test/evals/reconstruct.test.ts` ("referenced conversations"), a classifier case in
  `packages/kernel/test/sandbox/review-classifier.test.ts`.

- [ ] Run `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` first; record green.
- [ ] Field, `textRule`, duplicates collapse, forwarding on create and first-message.
- [ ] Resolution per spec §1: `readable()` rules plus `kind = 'chat'`, same org/account, not deleted,
      agent visible; one refusal code for every unavailable case (`details: [{id}]`), `reason:
      "empty"` without a `user_message`, `reference_self` for the conversation written in; nothing
      written on refusal; a retry reads nothing.
- [ ] Digest per spec §2 (summary + later turns, or title + excerpt; running note; closing
      `conversations.events` line; bounds), payload `conversationRefs: [{id, title, source,
      upToSeq}]`, block order after project file lines.
- [ ] Migration (writing-migrations skill): partial index `IF NOT EXISTS`, no RLS (no `org_id`);
      the summary lookups in `skill-load.ts` / the new reader use it.
- [ ] Classifier keeps reading `content[0]` + project file lines only (test proves the new blocks
      are ignored).
- [ ] Re-run reconstruct (zero drift), the new tests, `pnpm test:unit`, typecheck.
- [ ] Docs: replay-evals skill "Referenced conversations" bullet; composer menus spec §5 correction
      (send routes are exclusions; the field lives in the shared `MessageFields`).
- [ ] Changeset `@capybara-hq/kernel: patch`.

## Task 2: Design components (normal)

Follow writing-web-ui's change flow (spec → reference blocks → catalog → component → tests).

- [ ] `docs/design/spec.md` §6.16.30 (`ComposerMenu` `chats` row) and §6.16.6 (user bubble
      conversation chip): states, size tables, compact form (spec §4 table).
- [ ] Reference blocks in `docs/design/reference/src/` for the new states.
- [ ] Attachment strip conversation chip (`chats` icon + title, truncation, refused mark like a
      missing project file) and `BubbleAttachments` link chip (`kind: "conversation"`, `href`,
      through the DesignProvider `link`, no download button, compact wraps).
- [ ] Catalog states with `RefBlock`s of the same ids; jsdom tests (strip, bubble, compact).
- [ ] Design i18n (zh: 会话, 未命名会话; never 企业 / agent).

## Task 3: Web (normal)

- [ ] `conversationMentionQuery` `defineQuery` on `GET /orgs/:orgId/conversations?q=&limit=6`,
      same debounce / IME hold as files; drop the current conversation; ≤ 5 rows; group 会话 after
      files, before connector resources; empty query lists recent.
- [ ] Strip chips, draft identity / retry / restore (`ComposerBar`, `first-message-attempt.ts`,
      `NewConversation`) carry `conversationRefs`; refusal marks the chip with the error copy.
- [ ] `userText` shows `content[0]` with `conversationRefs`; `Thread` bubble chips link
      `/chat/<id>` from `payload.conversationRefs`.
- [ ] Web API types / parity (`check:web-api-parity`), i18n zh/en, tests.
- [ ] writing-web-ui skill (`@` groups); composer menus spec §4 (会话 group).
- [ ] Changeset `@capybara-hq/capybara: patch`.

## Task 4: Acceptance (controller)

- [ ] `COMPARE=<components>` in `mcr.microsoft.com/playwright:v1.64.1-noble` against a local
      `next start` (not port 3000); blind image review; fix severe/moderate; `ACCEPTED`.
- [ ] Check the three size classes (compact < 600, medium, expanded) headless.
- [ ] `pnpm verify --fast` + changed tests; renumber the migration against origin/main; merge
      origin/main; push; ready PR "Refs #1029"; `reference-update` / `visual-update`; push a commit
      to start CI; watch `ci-ok`.

## Progress

- Worktree `.claude/worktrees/feat-at-conversation`, branch `feat/at-conversation` from origin/main
  f9ac5f9cc.
- Plan written (837d90000).
- Wave 1: Task 1 kernel 45f62d4a8 + a071d97c3; Task 2 design e10e15f8d cherry-picked as 6d4b3d5dd
  (built in worktree feat-at-conversation-design). Reconstruct 65/65 before, 66/66 after.
- Reviews: T1 (opus) no Critical; Important: skill-invocation user_message quoted as skill body;
  Minors: SQL filter for text rows + anyUser test, create retry test, clipMiddle over limit. Quote
  delimiter hardening skipped (approved format). T2 (sonnet): 6 Minors. Fixes dispatched.
- Web copy for the two error codes (apps/web/messages) belongs to Task 3; Task 3 also must make
  `userText` show content[0] when payload.conversationRefs is present. Task 3 runs in worktree
  feat-at-conversation-web, cherry-picked back.
