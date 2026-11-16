---
"@capybara-hq/capybara": patch
---

Replay guarantees zero drift only for logs written by the current format: the frozen
release-candidate texts and the drift reason `legacy_event` are gone, and a model call recorded
without a field the runtime always writes is refused with `eval.recording_unsupported`. The line
restored after a compaction now reads "Skills invoked earlier in this conversation", since it also
names the template skills the kernel writes at a sub-agent's start.
