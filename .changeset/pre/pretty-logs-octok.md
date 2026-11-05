---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Readable logs in the octok layout.

- **Pretty console:** `[2026-10-30 12:00:00.000 +0800] INFO: [pid=…] - [traceId=…] [reqId=…]
  [queue=…] [jobId=…] [runId=…] [context=…] [plugin=…] msg`, each bracket only when present, with the
  other fields as indented `key: value` lines below instead of trailing JSON, and an error's stack
  below its message. The access line reads `GET /api/v1/me 401 2ms`. The process roles are no longer
  on every line (the start line names them; JSON records keep `role`).
- **Context per class:** every kernel class's records carry `context` = its class name (JSON too).
  `KernelLogger` gains `child(fields)`.
- **Nest's own lines** (`Mapped {/api/v1/…, GET} route` and module loading at startup) are logged at
  `info` with Nest's context, as octok does; they were at `debug`.
- **Colors:** `FORCE_COLOR=1` forces colors in pretty output, `NO_COLOR=1` turns them off.
  `pnpm dev:kernel` forces them in the terminal and strips them from `/tmp/capybara-dev-kernel.log`.
