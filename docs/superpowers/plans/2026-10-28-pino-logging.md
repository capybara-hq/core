# Pino Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the kernel logs through pino: readable console in a terminal, JSON in containers, dev log files from the dev scripts (`tee` to `/tmp`), optional Loki push, and request / job context on every record.

**Architecture:** `createLogger` keeps its interface and redaction; records are redacted, then handed to a pino logger whose destinations are chosen from `log.*` config (pino-pretty or stdout JSON, the kernel's Loki pusher). An `AsyncLocalStorage` context feeds a pino `mixin`.

**Tech Stack:** pino, pino-pretty (exact versions, each published ≥ 2 weeks ago; `packages/kernel/package.json` dependencies), Nest + Fastify, vitest. (Revised: no pino-roll, the local file comes from the dev scripts; no pino-loki, see the spec's Loki note.)

**Spec:** `docs/superpowers/specs/2026-10-28-pino-logging-design.md`

## Global Constraints

- Config keys (follow `.agents/skills/adding-config`, regenerate `docs/config.md`): `log.level` (unchanged, hot), `log.format` `"auto"|"pretty"|"json"` default `"auto"`, `log.loki.url` optional URL, `log.loki.username` optional, `log.loki.password` optional secret, `log.loki.labels` record of strings default `{}`. Only `log.level` is hot.
- Dev log files: `pnpm dev:kernel` / `pnpm dev:web` tee to `/tmp/capybara-dev-kernel.log` / `/tmp/capybara-dev-web.log`.
- Redaction happens before pino: no output (console, Loki) ever sees an unredacted registered secret. Existing redaction tests must pass unchanged except the `ts` → `time` rename.
- `x-request-id` accepted only when it matches `^[A-Za-z0-9._-]{1,128}$`.
- Multi-replica discipline (AGENTS.md): no timers in `ctx`; transports run in pino's worker threads, which is fine for the kernel process.
- English comments / docs / commits; Conventional Commits, body ≤ 100 chars; `git -c user.name=Grant -c user.email=284885069@qq.com`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A secret registered after startup (org config saved later) is redacted in the Loki output too.
- Loki unreachable at start and mid-run: the kernel starts, serves, and does not flood stderr.
- A log call with a field named `time` / `level` / `msg` cannot overwrite the record's own.
- `pretty` with no TTY (piped) still prints one line per record without color codes.

---

### Task 1: pino core, console format, dev log files

**Files:** `packages/kernel/src/log.ts`, `packages/kernel/src/log-config.ts` (logger from config: format, roles), `packages/kernel/src/config/schema.ts`, `packages/kernel/src/kernel.ts`, `apps/capybara/src/cli.ts` and `commands/start.ts` where loggers are created, `docs/config.md`, root `package.json` (`dev:kernel` with `CAPYBARA_LOG__FORMAT=pretty ... 2>&1 | tee -i /tmp/capybara-dev-kernel.log`; `dev:web` tees to `/tmp/capybara-dev-web.log`), tests `packages/kernel/test/log*.test.ts`.

**Interfaces:** `createLogger(level, opts: { format?: "auto"|"pretty"|"json"; out?; isTTY?; loki?: LokiOptions; base?: Record<string, string>; write?: (line: string) => void; ... })` — keeps `write` for tests (JSON lines).

- [ ] Step 1: tests: record shape `{ time, level: "info", msg, role, ... }`; reserved keys not overwritten; `pretty` output is one line containing the level and msg, without ANSI colors when not a TTY and with them on a TTY; `auto` picks JSON without a TTY; `setLevel` still filters.
- [ ] Step 2: fail → implement → pass; update every test or doc that reads `ts` (`grep -rn '"ts"\|\.ts\b' packages/kernel/test` style search for log-line parsing).
- [ ] Step 3: commit `feat(kernel): log through pino with a pretty console`.

### Task 2: Loki

**Files:** `log.ts` + `log-loki.ts` (Loki pusher behind `pino.multistream` when `log.loki.url`), schema, tests with a local HTTP server standing in for Loki's push API (`/loki/api/v1/push`).

- [ ] Step 1: tests: records arrive at the fake push endpoint with labels `job`, `role`, `level` + configured; basic auth header when username/password set; fake server down → kernel logger keeps working, at most one stderr note per minute.
- [ ] Step 2: fail → implement → pass. Commit `feat(kernel): push logs to Loki when log.loki.url is set`.

### Task 3: request and job context, access log

**Files:** new `packages/kernel/src/log-context.ts` (`AsyncLocalStorage<Record<string, string>>`, `withLogContext(fields, fn)`, `logContext()`), `packages/kernel/src/http/app.ts` (Fastify `onRequest` / `onResponse` hooks: reqId, header echo, access line), queue worker entry points (where BullMQ processors run a job: set `jobId`, and `runId` in the run worker).

- [ ] Step 1: tests via `http.inject()`: a request gets `x-request-id`; a valid incoming id is echoed, an invalid one replaced; a record logged by a controller carries `reqId`; one access line per request, none for `/healthz`.
- [ ] Step 2: fail → implement → pass. Commit `feat(kernel): request ids and job context on every log record`.

### Task 4: Docs

**Files:** `AGENTS.md` (a short "Logs" note: `pnpm dev:kernel` / `pnpm dev:web` write `/tmp/capybara-dev-kernel.log` / `/tmp/capybara-dev-web.log`, pretty, one line per record; agents look there first when a dev kernel misbehaves), `README.md` dev section (`pnpm dev:kernel`), `docs/deploy/*.md` (Loki, `log.format`), changesets (`@capybara-hq/kernel` patch, `@capybara-hq/capybara` patch).

- [ ] Step 1: edit; `pnpm lint && pnpm typecheck && pnpm check` pass. Commit `docs: logging outputs`.

### Task 5: OpenTelemetry tracing (optional)

**Files:** `apps/capybara/src/main.ts` (new bin entry: env file, then tracing for `start` when `OTEL_EXPORTER_OTLP_ENDPOINT` / `..._TRACES_ENDPOINT` is set, then `cli.ts`), `tracing-env.ts`, `tracing.ts`, `shutdown.ts`, `bin/capybara.mjs` (points at main), `commands/start.ts` (exit after shutdown hooks), `packages/kernel/src/log-context.ts` (`setTraceContextSource`, `setJobWrapper`), `log-loki.ts` (marker header), `apps/capybara/package.json` (`@opentelemetry/*`, exact versions ≥ 2 weeks old), docs (AGENTS.md, `docs/deploy/README.md`).

- [ ] Step 1: tests: `tracingEnabled` env rules; a child `capybara start` without an endpoint resolves no `@opentelemetry/*` module, with one it loads the SDK; a fixture with an in-memory exporter gets an undici client span, the http server span under it and a pg span under the server span, and its log records carry the same `traceId`; the job wrapper runs inside the job context.
- [ ] Step 2: fail → implement → pass. Commit `feat(cli): optional OpenTelemetry tracing`.

