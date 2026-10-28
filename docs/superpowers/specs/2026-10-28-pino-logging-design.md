# Kernel logging on pino: pretty console, local file, Loki

Status: agreed with the maintainer on 2026-10-28 (conversation: "follow octok-platform": pino,
pino-pretty on the console, push to Loki when a URL is configured, and a local log file in
development so agents can read it).

## Today

`packages/kernel/src/log.ts` is a hand-written logger: one JSON line `{ ts, level, msg, ...fields }`
per call on stdout, with secret redaction (`addSecrets` / `addOrgSecrets` / `redact`, deployment
secrets in msg and fields, org secrets in fields only). Nest logs through `NestLogAdapter`. Nothing
is written to a file, there is no request log and no request id, and a person reading a terminal
gets raw JSON.

## Decision

Keep the `KernelLogger` interface (and the SDK `Logger` extensions get) and its redaction rules
unchanged; replace the sink with pino.

1. **Core.** `createLogger` builds a pino logger (`pino` exact version) whose records are already
   redacted by the existing matcher before they reach pino (redaction stays ours; pino's own
   `redact` paths are not used). Record shape on JSON outputs: `{ time, level, msg, ...fields }`
   with `level` as the label (`"info"`), `time` ISO 8601 — a documented change from `ts` (one
   field rename; tests and docs that read `ts` are updated). Error serialization, circular
   handling, reserved keys and `setLevel` (hot `log.level`) behave as today.
2. **Console.** New key `log.format`: `pretty` | `json` | `auto` (default `auto`: `pretty` when
   stdout is a TTY, else `json`). `pretty` goes through `pino-pretty` (single line per record,
   `translateTime: "SYS:HH:MM:ss.l"`, colors when TTY, message prefix
   `[role] [reqId=…] [plugin=…]` when present, like octok's `messageFormat`). Containers keep JSON
   on stdout (`auto` sees no TTY).
3. **Local file.** New key `log.file` (path, optional, resolved against the working directory).
   When set, every record is also appended there as JSON lines (always JSON, whatever
   `log.format` is), with size rotation (`pino-roll`: 20 MB, keep 5 files). `.env.example` sets
   `CAPYBARA_LOG__FILE=logs/capybara.log`; `logs/` is gitignored. AGENTS.md tells agents to read
   that file (with `jq`) when debugging a running dev kernel.
4. **Loki.** New keys `log.loki.url` (optional; setting it is the switch, as in octok),
   `log.loki.username` / `log.loki.password` (secret, optional basic auth) and
   `log.loki.labels` (record of strings, default `{}`); every record is also pushed with
   `pino-loki` (batched, JSON lines, labels `{ job: "capybara", role: <roles joined>, level }`
   plus the configured ones). A Loki outage never blocks or crashes the kernel (errors go to
   stderr at most once per minute). Not hot: restart to change.
5. **Request context.** An `AsyncLocalStorage` log context: the HTTP layer assigns `reqId`
   (incoming `x-request-id` when it matches `^[A-Za-z0-9._-]{1,128}$`, else a random id; echoed in
   the `x-request-id` response header) and queue workers set `jobId` / `runId` where a job runs.
   Every record logged inside the context carries those fields (a pino `mixin`). One access-log
   line per HTTP request at `info` (`method`, `url` without query string, `status`, `ms`, `reqId`),
   except `/healthz`, `/readyz` and SSE streams (logged when they close, at `debug`).
6. **Role.** Records carry `role` (the process's roles joined by `,`) so a single dev process
   running all three roles is still attributable at the process level.

All outputs are pino transports or destinations; secrets are redacted before any of them, so the
file and Loki get the same redacted records as the console.

## Not changed

Redaction semantics and their tests, the SDK `Logger` type, `ctx.log` for extensions, log levels.
