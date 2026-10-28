---
"@capybara-hq/kernel": patch
---

The kernel logs through pino: records are `{ level, time, role, msg, ...fields }` (`time` replaces
`ts`), redacted as before. New config `log.format` (`auto` | `pretty` | `json`) and optional Loki
push (`log.loki.url` / `username` / `password` / `labels`). HTTP requests get a request id
(`x-request-id`) and an access line; records carry `reqId`, or `queue` / `jobId` / `runId` in jobs.
