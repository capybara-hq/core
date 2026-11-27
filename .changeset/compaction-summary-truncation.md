---
"@capybara-hq/kernel": patch
---

A compaction summary cut off at the output token limit is no longer stored. The summary call is
asked once more for a shorter summary from the start (only the `<summary>` block, at most about
2,000 words, less under a small summary cap); if that is cut off too, the compaction fails with
`compaction_failed` and its backoff, naming the chunk in a chunked compaction, so a half summary
is never passed on to the next chunk.
