---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": patch
---

Conversation process blocks, kernel side: `ToolInfo` gains `icon` (the step kind the web draws
on the process rail); a tool result's card records its `placement` and Markdown `text`; channel
connections gain `process_display` (`detailed`, `brief`, `off`; migration 0185), and a run shows
in IM as one progress card edited in place (narration on its status line, the answer and blocking
cards as new messages, handoffs merged after the answer), or as text edited in place on a channel
that does not declare `features.progress`; a channel without edits gets a start message and
throttled milestones (none in `brief`). A run that finishes with no answer after its last
narration sends that narration as its answer. The fake-im fixture declares `features.progress`.
