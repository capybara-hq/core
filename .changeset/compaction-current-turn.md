---
"@capybara-hq/kernel": patch
---

Context compaction handles long single-turn work and small windows:

- A long tool loop under one user message is compacted inside the turn, at a tool-pair boundary,
  instead of only being trimmed. The person's message stays verbatim: the summary records which
  messages started the run (`compaction_summary.openingSeqs`) and requests show them again after the
  summary text, so the next requests stay append-only.
- A request the hard fit guard trims keeps a usable output cap: the cap is clamped after the trim,
  from the input actually sent, and the safety reserve is kept on every path.
- Models with a small window or an output cap close to their window get sane planning bounds
  (output at most half the window, reserve at most an eighth), so they no longer compact and trim
  on every step. The reactive trim targets 70/80/90% of the fit target and is skipped when none is
  reachable.
- Every compaction in a step gets its own idempotency keys, so a proactive summary and a forced one
  in the same step are both recorded with their usage.
- When the guard cannot fit a request (for example a fallback model with a smaller window), it
  compacts once with that model before failing with `run.context_too_large`; a sub-agent whose
  budget that compaction uses up stops before the request.
