# Conversation send: instant feedback, a working line, queue by default

Status: approved in chat (2026-11-04, rc2 acceptance)
Amends: `docs/design/spec.md` §6.16.2 (composer keys and placeholder), §6.16.14 (queue); adds a
working line to §6.16; amends `2026-11-03-web-query-cache-design.md` §6 (what a send writes to the
cache).

## 0. Why

During rc2 acceptance (2026-11-04), measured from the Enter key against a kernel 37–120 ms away:

- From `/chat`, the first message stays in the composer for 2.7 s. The create POST takes 2.1 s.
  After it returns, the page still waits about 0.5 s for the sidebar groups to be invalidated
  (`useAppMutation` awaits the invalidation before `onSuccess` navigates). The new page then
  reads the row, events, queue, files and contributions again, although the POST answered
  with the row and the event.
- A follow-up message stays in the composer for 1.6 s, the POST's duration. The stream shows the
  user bubble at 0.9 s, so the same text shows twice for 0.7 s.
- The send button is only disabled while the POST is in flight. It has no busy look.
- From the user bubble to the first output there is nothing on screen for 4.3–4.4 s.
- On the first visit to a new conversation, the stream opens only after the events GET. A fast
  reply can finish before the stream opens and then appears whole, without streaming.
- While a run is going, ↵ interjects and ⌘↵ queues. The person expects the opposite: by default a
  message waits for the next turn, as on Claude's web app, and a deliberate action sends it now.

## 1. Decisions taken with the user

| # | Decision |
|---|---|
| D1 | While a run is going (or waits for a person), ↵ queues the message for after the turn, and ⌘↵ (Ctrl+↵ off macOS) sends it now, as an interjection. Each queued message keeps its "立即发送" / "Send now" action. |
| D2 | From the person's send until the run's first output, the thread shows a **working line**: a Capybara-style loading mark (the pixel capybara of §3, animated) and a rotating caption. It has no timer. The thinking row keeps its seconds. |

## 2. Behaviour

### 2.1 Instant send (my call: the shape)

- On send, the composer clears at once and the message shows at once as a **pending user
  bubble**. The bubble has the user-bubble look plus the pending state of the queued-message
  pattern. The send button never waits on the POST.
- The pending bubble is per view and keyed by the message's `clientMessageId`, which the composer
  already sends. When the log delivers the `user_message` with that id, from the POST answer or
  the stream, whichever comes first, the pending bubble is replaced in the same frame. The text
  never shows twice.
- **Failure**: if the POST fails, the pending bubble goes away and the text and attachments come
  back to the composer, with the error shown as today (a toast or the composer's error). A
  retry keeps the same `clientMessageId` (dedupe, §6.16.2).
- **First message from `/chat`**:
  - The new-conversation view switches at once to the conversation layout. It is the same
    `ConversationPage` template, so nothing shifts: the pending bubble, then the working line.
  - When the create POST answers, the cache is seeded with the answer: the row into
    `conversationQuery`, and every event the create wrote (the answer's `events`, from seq 1: a
    `model_switched` before the message when the send switched model or effort; `event` stays
    for compatibility) into `eventsQuery` through `appendEvents`.
  - The page then navigates with `router.replace` to `/chat/<id>`. The groups invalidation is
    not awaited before navigating.
  - `/chat/<id>` paints from the seeded cache, and its stream opens right away from the
    event's seq.
  - Queue, files and sandbox are empty for a new conversation: seed them empty, as known
    answers, so they are not read.
- **Follow-up**: the POST's event goes through `appendEvents`. That already exists; it now also
  drops the pending bubble.

### 2.2 The working line (design §6.16.24, new)

- **When**: from a send (the pending bubble) or a run start, until the run's first output: a
  thinking row, prose, a tool, a sub-agent, an approval, a question, a connect block, or the run
  row when the run ends without output. It sits where that output will appear, after the last
  user bubble. It shows again after a tool result while the model has not answered yet. Exactly
  one shows per conversation.
- **Look**:
  - A tool line (`row.dense`, mono `small` `muted`, gap `space.2`).
  - The **mark**: the pixel capybara of §3 at pixel unit 1 (14×10), `accent`, `crispEdges`, in
    a 16 px box. It walks: two frames swap the legs (rows 9–10 of the bitmap) every 400 ms.
  - The **caption**, rotating every 2.4 s: 规划中… / 执行中… / 斟酌中… / 整理中… (en: Planning… /
    Working… / Pondering… / Composing…), starting at the first entry. The text changes in place:
    no slide, no fade beyond `motion.fast`.
  - No timer.
- **Reduced motion**: the mark stands still (frame 1) and the caption stays on its first entry.
- **A11y**: `role="status"` with the caption as its accessible text, announced once, not on each
  rotation (`aria-live="polite"` on a hidden copy that holds the first caption only).
- Exactly the existing tokens, no new colours.
- It is a design component (`WorkingLine`), with a state list (`default`, `reduced-motion`),
  a size table, a `/dev/ui/reference/working-line` block and a reference HTML block. The
  `ConversationPage` thread renders it from a prop. The web decides when to show it, from the
  log and the pending bubble.

### 2.3 Queue by default (D1)

- Composer keys while a run is going: ↵ calls the queue action and ⌘↵ / Ctrl+↵ calls send
  (interject). With no run going, ↵ sends as today, and ⌘↵ also sends.
- The placeholder while running is "按 ↵ 加入队列，按 ⌘↵ 立即发送" / "↵ to queue, ⌘↵ to send now"
  (Ctrl+↵ off macOS).
- A queued message shows instantly in the queue list, optimistically, with the same pending and
  failure rule as 2.1.
- The send button while running stays Stop (§6.16.2). Queuing is the keyboard's default. With
  an empty composer, the button is Stop; with text, it is still Stop, and ↵ queues. My call: no
  second button, as today.

### 2.4 The stream opens early

- `/chat/<id>` opens its stream as soon as it knows a seq to resume from: the cached last seq
  (a seeded new conversation, a return visit), else after the events GET, as today.

## 3. Non-goals

- Making the POST faster: kernel latency, as with the query-cache spec.
- Changing the queue's kernel semantics (`POST …/queue`, one per run after the turn).

## 4. Tests

- Composer:
  - ↵ while running calls queue, and ⌘↵ calls send.
  - With no run going, ↵ sends.
  - The placeholder copy.
- Instant send:
  - The composer is empty and the pending bubble shows in the same tick as Enter, before the
    POST resolves.
  - When the `user_message` arrives, by stream or by POST, the pending bubble goes and the text
    shows once.
  - A failed POST restores the text and drops the bubble.
- First message from `/chat`:
  - `/chat/<id>` paints the bubble with zero GETs for row, events, queue and files after
    navigating.
  - The stream opens from the event's seq.
  - The navigation does not wait for the groups.
- Working line:
  - It shows after a send until the first output, and again after a tool result.
  - It is gone once the run ends.
  - Reduced motion is static.
  - It is announced once.
  - Design: state coverage, size table and fidelity.
- e2e (`apps/web/e2e`): send from `/chat`; the composer is empty within 100 ms; the working line
  is visible before the first token; the reply streams (at least two text growth steps).
