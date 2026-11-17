---
"@capybara-hq/kernel": patch
---

Add the recorded permission context request boundary: every agent-history request construction (a retry, a fallback, the rebuild after a forced compaction, wrap-up) records the root's current permission context and builds from the complete log read after it; a revoked execution reaches the run worker unchanged and every other failure ends the run with a named `run.permission_context_*` error before anything is sent. Full-run replays now feed the target run's recorded context into generated requests. The managed device context writer records marked device paths before a managed operation's preparation and user callback, checked against the held instance, generation and installed binding. Both live producers stay dormant behind one activation gate until the paired runtime cutover.
