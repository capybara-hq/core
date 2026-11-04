---
"@capybara-hq/web": patch
---

Sending in a conversation is instant: the composer clears on ↵ and the message shows at once as
a pending bubble, replaced by the logged message without showing twice; a failed send puts the
text and files back. A new conversation switches to the conversation layout at once and its page
paints from what the create answered. From the send until the first output a walking capybara
with a rotating caption ("规划中…" / "Planning…") shows where the answer will appear. While a run
is going ↵ now queues the message for after the turn and ⌘↵ / Ctrl+↵ sends it now; a queued
message shows in the queue at once.
