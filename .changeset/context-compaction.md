---
"@capybara-hq/kernel": minor
---

Long conversations are now compacted before they overflow the model's context window. A new
platform settings section (and an org override) controls the trigger threshold, the recent turns
kept in full, the reserve and the summary output cap; a request that still does not fit is trimmed
by a deterministic, recorded fit plan, and a provider that rejects an estimated-to-fit request gets
reactive compaction and progressively smaller trims (70%, then 80%, then 90% of the window).

The summary follows Claude Code's nine-section template (only the `<summary>` block is stored), and
a transcript too large for one summary call is summarised in chunks with real `i/N` progress on the
conversation stream. `compaction_summary` gains `savedTokens` (what the compaction saved; the web
divider uses it), and a chunked compaction logs one `usage` event per call
(`purpose: "compaction"` with `chunk` / `chunks`), billed and reported like any other compaction
call. `POST …/conversations/:id/compact` starts a manual compact run
(`run_started.trigger: "compact"`, no model step); the web conversation's title menu and the
`/compact` command use it. Eval planning and trajectory step pairing skip compact runs, whose chunk
usages still sum into the run's totals.

The compaction knobs moved from the environment to the deployment and org settings:
`CAPYBARA_RUNTIME__COMPACTION_THRESHOLD` and `CAPYBARA_RUNTIME__KEEP_RECENT_TURNS` are removed and
have no effect any more. Set the threshold and the recent turns kept in full on the platform's
compaction settings, or in the org's override, instead.
