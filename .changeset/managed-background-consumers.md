---
"@capybara-hq/kernel": patch
---

Stage the consumers of managed background tasks: TaskOutput reads retained positional output by
the task's exact reference with a persisted byte cursor, a 4,096-byte parser history and bounded
multi-read assembly (whole characters on a live stream, replacement decoding at a verified end);
the HTTP output assembles the suffix ending at its probed total; TaskStop, the poller and the
finish use exact status, tail and stop with the five-second grace, keep already-exited, stopped,
cancel-pending and lost distinct, finish exactly once and retain uncertain records past pruning.
A same-call start retry no longer races scheduled recovery or starts a stopped task. Legacy
protocol-2 tasks are unchanged and the managed path stays unwired from Bash.
