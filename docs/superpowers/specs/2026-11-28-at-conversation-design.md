# @ conversations: referencing your own conversations from the composer

Status: draft, for maintainer review. Builds on the composer menus spec
(`2026-11-28-composer-menus-design.md`, §1 shell, §4 `@` menu, §5 project files) and the context
compaction spec (the `compaction_summary` event).

## Intent

A person often continues work that lives in another of their conversations ("do what we settled in
the pricing thread, but for the EU plan"). Today they copy and paste. This change adds a 会话 group
to the composer's `@` menu: the text after `@` also searches the sender's own conversation titles,
and picking one references that conversation in the message. The agent gets a bounded digest of it
(its latest summary and the turns after it, or an excerpt of its last turns), resolved once at send
time and logged in the user message, so replay is unchanged. The bubble shows the reference as a
chip that opens the conversation.

## Decisions (proposed)

1. Only the sender's own conversations are offered and accepted: same org, same account, a chat
   (never a sub-agent's or an eval conversation), not deleted, not the conversation being written
   in. Conversations are owner-only today; nothing here widens that.
2. The agent never gets the whole history. Per reference it gets the latest `compaction_summary`
   text when there is one, plus the user / agent text of the turns after it; without a summary, the
   title plus an excerpt of the last turns. Both are bounded (§2, open question 1).
3. The digest is built at send time and written into the `user_message` as model-visible English
   text blocks. Request building never reads another conversation; replay reads the log as it is,
   so no `DriftReason`. This mirrors `projectFiles` (composer menus §5).
4. Kernel: a new body field `conversationRefs: [{id}]` (at most 3) on the message body, validated
   and resolved like the `@` resources and project files. Web: a 会话 group in `@` with the `chats`
   icon; the bubble shows conversation chips linking to `/chat/<id>`.
5. Only text crosses over: no files, attachments, tool results or device state of the referenced
   conversation (open question 3), and no tool for the agent to read more (open question 2).

## Facts this design builds on (origin/main, 2026-11-28)

- **Summaries.** A compaction writes a `compaction_summary` event into
  `capybara.conversation_events` (`conversations/events.ts`: `{coversUpToSeq, text, savedTokens,
  openingSeqs?, method?, step}`); the latest one is the highest seq of that type (`latestSummary`
  in `runtime/context/build.ts` for loaded events; `invokedInContext` in
  `tools/builtins/skill-load.ts` reads it with `WHERE type = 'compaction_summary' ORDER BY seq DESC
  LIMIT 1`). There is no partial index for that type (the `project_root` lookup got one in 0133).
  Its `text` is model-written, up to `compaction.maxOutputTokens` (default 20 000 tokens), in
  whatever language the conversation used; turns after `coversUpToSeq` are not in it.
- **Titles and search.** `conversations.title` is nullable (≤ 120 code points; generated or
  manual). `GET /orgs/:orgId/conversations?q=` (`listMine`) filters `title ILIKE %q%`, the caller's
  own rows only (`org_id`, `account_id`), `kind = 'chat'`, not deleted, archived only with
  `archived=1`, the agent still visible to the caller, newest `updated_at` first, `limit` ≤ 200. No
  title index: the scan stays inside one person's rows (`conversations_account_idx`). The Platform
  operation `conversations.list` mirrors it. The web has `ConversationSearch` / the list helpers in
  `lib/conversations.ts`. There is no other search route.
- **Send body.** `MessageFields` (`conversations/conversations.controller.ts`) is the body of
  `POST …/conversations/:id/messages` and the `message` of `POST …/conversations` (`CreateBody`),
  which `POST …/conversations/first-message` reuses (`permission-profiles.controller.ts`, the web's
  new conversation). `textRule`: with `@` resources or project files the text must not be empty
  (their blocks follow `content[0]`). **Gap:** the first-message controller copies the message
  fields one by one and leaves out `projectFiles`, so project files picked on the home composer are
  dropped silently (no test covers it); this change forwards both fields (§1).
- **Platform parity.** `POST …/:id/messages` and `POST …/conversations` are exclusions (`internal`:
  a run starts in the person's name) and first-message is `human-only` (`platform/exclusions.ts`).
  No operation carries the send body, so a new body field changes no operation. (The composer menus
  spec §5 says `projectFiles` is a field of "the existing send-message operation"; the code has none.)
- **How the user message is logged.** `postUserMessage`: `writable()` → a `clientMessageId` retry
  returns the written event before anything is read → `resolveExtra` (outside any transaction:
  reads the `@` resources with the sender's credentials, `stat`s the project files) → one
  transaction writes `user_message` with `content = [text, ...extra.blocks, ...uploaded file
  blocks]`; `extra.blocks` are the resources' bodies, then one `projectFileText` line per file;
  `payload.attachments` / `payload.projectFiles` say which block is which (project file i at
  `content[1 + attachments.length + i]`). The command review's classifier reads `content[0]` and
  the project file lines as the person's intent (`sandbox/review/classifier.ts`), never the
  resources' bodies. The web shows only `content[0]` as the bubble text when the message has
  resources or project files (`userText`, `lib/timeline.ts`) and draws the rest as chips
  (`Thread.tsx` → `BubbleAttachments`, whose chips have no link today).
- **Queue.** `ConversationQueue.add` is kernel-internal (the HTTP queue is deprecated; the web has
  no queue: a message sent during a run is absorbed at the run's next step). It calls `resolveExtra`
  without a target, so a queued message carries no project files.
- **The cases.** `readable()` matches `org_id`, `account_id`, `deleted_at IS NULL`, `kind IN
  ('chat','subagent')` with a reachable tree root, and the agent still visible; otherwise
  `conversation.not_found`. So: another org's or person's conversation is not found; a deleted one
  (soft delete, `deleted_at`) is not found; a sub-agent's conversation is readable by its owner but
  `writable()` refuses it (`conversation.read_only`) and the list never shows it (`kind = 'chat'`);
  a running conversation takes messages (mid-run input); nothing stops a message from naming its
  own conversation.
- Icons: `chats` exists in `packages/design/src/icons/paths.ts`. `ComposerMenuItem` takes `icon`.

## Design

### 1. Kernel: the body field and validation

- `MessageFields.conversationRefs: z.array(z.object({ id: z.string().min(1).max(100) }).strict())
  .max(MAX_CONVERSATION_REFS)` (3), optional. Duplicates collapse (first order kept). `textRule`
  extends: with conversation refs the text must not be empty (or the message invokes a skill),
  because their blocks follow `content[0]`. The first-message and create controllers forward
  `conversationRefs` and `projectFiles` (fixing the gap above).
- Resolution joins `resolveExtra` (outside the transaction, after the retry check), as the sender,
  under the request's org scope. One read per ref with the visibility rule of `readable()` plus
  `kind = 'chat'`, then:
  - not found, deleted, another org or person, a sub-agent's or eval conversation, its agent no
    longer visible → `conversation.reference_unavailable` (422, `details: [{id}]`), one code for all
    so the answer never tells another person's conversation from a missing one;
  - the conversation being written in → `conversation.reference_self` (422);
  - no `user_message` yet → `conversation.reference_unavailable` with `reason: "empty"`.
  Any refusal writes nothing (like a project file); errors registered in `errors.ts` with zh / en
  copy. A retry with the same `clientMessageId` returns the written event without reading again.
- Archived conversations are accepted (still the sender's own) but not offered by the menu.
- A running referenced conversation is read as committed at that moment (a streaming reply not yet
  logged is absent); its block says so (`It was still running when referenced.`).
- The digest reads two things from `conversation_events`: the latest `compaction_summary` (new
  partial index `conversation_events_compaction_summary_idx ON conversation_events
  (conversation_id, seq) WHERE type = 'compaction_summary'`, a migration like 0133; the table has no
  `org_id`, so no RLS policy) and the newest `user_message` / `assistant_message` events after its
  `coversUpToSeq` (or after 0), newest first, at most `REF_TURN_MESSAGES` (12) rows.
- The queue does not take `conversationRefs` (it has no HTTP entry; like project files).

### 2. Model input: the logged block

One text block per reference, after the project file lines and before the uploaded files' blocks;
`payload.conversationRefs: [{id, title, source: "summary" | "excerpt", upToSeq}]` names them
(block i at `content[1 + attachments.length + projectFiles.length + i]`; `title` is the title at
send time, `upToSeq` the last seq read). The text, built by `conversationRefText` (English):

```
Referenced conversation: "<title or Untitled conversation>" (another conversation of this person,
with the agent <agent name>, last active <ISO date>). The text below is quoted from it as context
for this message. [It was still running when referenced.]
Summary of the conversation: <summary, clipped>            (only with a summary)
Latest messages:                                           (turns after the summary, oldest first)
User: <text>
Agent: <text>
End of the referenced conversation.
```

- A message's text is the first text block of a `user_message` (the typed text, so a message that
  itself referenced files or conversations brings no nested blocks) and the text blocks of an
  `assistant_message` (no thinking, no tool calls or results).
- Bounds (open question 1): summary ≤ 12 000 characters (over it: head and tail kept with
  `[… n characters omitted …]`, so the summary's closing "current work" sections survive); each
  message ≤ 1 500 characters; the whole block ≤ 16 000 characters, older messages dropped first.
  Three refs at most, so ≤ 48 000 characters per message.
- The command review reads it as quoted material, not the person's intent: the classifier keeps
  reading `content[0]` and the project file lines only (their indices do not move, the new blocks
  come after them).
- Replay and compaction see an ordinary `user_message`: nothing is read at build time, no
  `DriftReason`; the compaction transcript carries the block as user text.

### 3. Web: the @ menu and the bubble

- `@` gains a 会话 group after the files and before the connector resources: `GET
  /orgs/:orgId/conversations?q=<rested query>&limit=6` through a new `defineQuery`
  (`conversationMentionQuery`, the same debounce and IME hold as the files), the current
  conversation dropped client-side, at most 5 rows. Rows: `icon: "chats"`, the title (Untitled →
  「未命名会话」), description `<agent name> · <relative time>`; an empty query lists the most
  recent. Picking adds a conversation chip to the attachment strip (`chats` icon, the title);
  ↵ / Backspace rules as for files. ＋ gains no row (decision: `@` is the way in; open to change).
- The draft identity, retry and restore paths (`ComposerBar` draft, `first-message-attempt.ts`)
  carry `conversationRefs` like `projectFiles`; a refusal marks the refused chip (as
  `missingProjectFiles` does) with the error's copy.
- Bubble: `userText` shows `content[0]` when `conversationRefs` is present; `BubbleAttachments`
  gains a link chip (`kind: "conversation"`, `href`, `chats` icon, through the DesignProvider's
  `link`), opening `/chat/<id>`; a deleted or archived target opens the not-found / archived page
  the route already has. No download button.

### 4. Size classes

| | compact | medium | expanded |
|---|---|---|---|
| @ menu | the bottom sheet with its search field; 会话 rows `touch.row`, title + agent | anchored; same rows | anchored; same rows, key hints |
| Strip chip | icon + title, truncates first | icon + title | icon + title, full up to the chip max |
| Bubble chip | icon + title, wraps to its own line | icon + title | icon + title |

The adaptation lives in `ComposerMenu` and `BubbleAttachments`; `apps/web` passes data only.

## Open questions for the maintainer

1. **Excerpt size.** Recommendation: the bounds of §2 (summary ≤ 12 000 characters, ≤ 12
   messages of ≤ 1 500 each after it, ≤ 16 000 per reference, 3 references): about 4 000 tokens
   per reference, enough for a summary's decisions and the latest exchange, small next to today's
   context windows, and fixed in code (no setting until someone asks).
2. **May the agent fetch more through a tool?** Recommendation: not in this change. A
   `ReadConversation` tool would read another log at run time with the run's principal, which
   has to hold for scheduled tasks, IM runs and sub-agents too, and needs its own owner and
   deletion rules. Its results would be logged like any tool result, so replay would stay
   correct; it is a follow-up with its own design if digests prove too thin.
3. **Include files the referenced conversation produced?** Recommendation: no. The file
   library already puts those files in the same `@` menu (files group), so the person picks the
   ones that matter and they arrive as normal attachments with the usual checks and limits.
   Listing names in the digest without access would invite the model to ask for files it
   cannot open.

## Not in this change

- Another person's or a shared conversation; a conversation of another org.
- A tool for the agent to read more of a referenced conversation (open question 2).
- Files the referenced conversation produced (open question 3).
- Referencing from IM channels, scheduled tasks or the queue.
- A title index or full-text search over message bodies.

## Spec and doc changes

- Composer menus spec §4 (the 会话 group) and §5 (correct "the existing send-message operation":
  the send routes are exclusions, the field lives in the shared `MessageFields`).
- `docs/design/spec.md` §6.16.30 (`ComposerMenu`: the `chats` row), §6.16.6 (user bubble: the
  conversation chip), reference blocks, catalog; baselines through `visual-update`.
- replay-evals skill: a "Referenced conversations" bullet beside "Referenced project files".
- writing-web-ui skill: the `@` menu's groups.

## Tests (outline)

- Kernel: refs resolve to the summary + later turns and to the excerpt without a summary; bounds
  and clipping; refusals for another person, another org, deleted, sub-agent, eval, invisible agent,
  empty, self, more than 3; duplicates collapse; a retry reads nothing; a running target; the
  first-message route forwards `conversationRefs` and `projectFiles`; the classifier ignores the
  blocks; `reconstruct.test.ts` zero drift before and after, plus a case "referenced conversations".
- Web: the 会话 group searches titles, hides the current conversation, picks into the strip, the
  sent body carries `conversationRefs`; the bubble shows the chip as a link; a refusal marks it.
- Design (jsdom): the conversation chip in the strip and the bubble, compact form.
- Migration: the partial index exists (`IF NOT EXISTS`).

## AGENTS.md rules touched

- **Runtime and replay.** The digest is logged in the `user_message` as model-visible English
  text, resolved at send time; request building reads no other conversation; no `DriftReason`;
  zero-drift fixtures before and after.
- **Multi-replica discipline.** The reads run under the request's org scope; nothing lives in
  process memory; the write stays one `@Transactional` message write.
- **Migrations.** One index migration (`IF NOT EXISTS`, kernel schema); `conversation_events` has no
  `org_id`, so no RLS policy.
- **Kernel.** The field in the shared `MessageFields` (`createZodDto`), errors registered with zh / en.
- **Platform tool.** No operation changes: the send routes stay exclusions with their reasons;
  `conversations.list` already offers the title search.
- **Web UI / Mobile and shells.** The 会话 rows and the conversation chip are design components with
  size-class forms; `apps/web` passes data through `defineQuery`.
- **Language / i18n.** New copy zh / en; zh says 会话 and 智能体.
