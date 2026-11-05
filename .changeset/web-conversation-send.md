---
"@capybara-hq/web": patch
"@capybara-hq/kernel": patch
---

Sending in a conversation is instant: the composer clears on ↵ and the message shows at once as
a pending bubble, replaced by the logged message without showing twice; a failed send puts the
text and files back. A new conversation switches to the conversation layout at once and its page
paints from what the create answered. From the send until the first output a walking capybara
with a rotating caption ("规划中…" / "Planning…") shows where the answer will appear. While a run
is going ↵ now queues the message for after the turn and ⌘↵ / Ctrl+↵ sends it now; a queued
message shows in the queue at once.

`POST /conversations` with a first message now also answers `events`: every event the create
wrote, in seq order (a `model_switched` before the message when the send switched model or
effort), so the new conversation paints without reading its log again.
