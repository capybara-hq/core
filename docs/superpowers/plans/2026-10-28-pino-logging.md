# Pino Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the kernel logs through pino: readable console in a terminal, JSON in containers, an optional local JSON-lines file (on in dev via `.env.example`), optional Loki push, and request / job context on every record.

**Architecture:** `createLogger` keeps its interface and redaction; records are redacted, then handed to a pino logger whose destinations are chosen from `log.*` config (pino-pretty or stdout JSON, pino-roll file, pino-loki). An `AsyncLocalStorage` context feeds a pino `mixin`.

**Tech Stack:** pino, pino-pretty, pino-roll, pino-loki (exact versions, each published ≥ 2 weeks ago; add to `packages/kernel/package.json` dependencies), Nest + Fastify, vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-pino-logging-design.md`

## Global Constraints

- Config keys (follow `.agents/skills/adding-config`, regenerate `docs/config.md`): `log.level` (unchanged, hot), `log.format` `"auto"|"pretty"|"json"` default `"auto"`, `log.file` optional string, `log.loki.url` optional URL, `log.loki.username` optional, `log.loki.password` optional secret, `log.loki.labels` record of strings default `{}`. Only `log.level` is hot.
- File rotation: 20 MB per file, keep 5.
- Redaction happens before pino: no output (console, file, Loki) ever sees an unredacted registered secret. Existing redaction tests must pass unchanged except the `ts` → `time` rename.
- `x-request-id` accepted only when it matches `^[A-Za-z0-9._-]{1,128}$`.
- Multi-replica discipline (AGENTS.md): no timers in `ctx`; transports run in pino's worker threads, which is fine for the kernel process.
- English comments / docs / commits; Conventional Commits, body ≤ 100 chars; `git -c user.name=Grant -c user.email=284885069@qq.com`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A secret registered after startup (org config saved later) is redacted in the file and Loki outputs too.
- Loki unreachable at start and mid-run: the kernel starts, serves, and does not flood stderr.
- `log.file` in a directory that does not exist yet: created; unwritable path: a clear startup error naming the key.
- A log call with a field named `time` / `level` / `msg` cannot overwrite the record's own.
- `pretty` with no TTY (piped) still prints one line per record without color codes.

---

### Task 1: pino core, console format, local file

**Files:** `packages/kernel/src/log.ts`, `packages/kernel/src/config/schema.ts`, `packages/kernel/src/kernel.ts` (build the logger from config: format, file, roles), `apps/capybara/src/commands/*.ts` where loggers are created, `docs/config.md`, `.env.example` (`CAPYBARA_LOG__FILE=logs/capybara.log`), `.gitignore` (`logs/`), tests `packages/kernel/test/log*.test.ts`.

**Interfaces:** `createLogger(level, opts: { format?: "auto"|"pretty"|"json"; file?: string; loki?: LokiOptions; base?: Record<string, unknown>; write?: (line: string) => void; ... })` — keeps `write` for tests (JSON lines).

- [ ] Step 1: tests: record shape `{ time, level: "info", msg, role, ... }`; reserved keys not overwritten; redaction in file output (register a secret after creation, log it, read the file); file directory created; `pretty` output is one line containing the level and msg; `setLevel` still filters.
- [ ] Step 2: fail → implement → pass; update every test or doc that reads `ts` (`grep -rn '"ts"\|\.ts\b' packages/kernel/test` style search for log-line parsing).
- [ ] Step 3: commit `feat(kernel): log through pino with a pretty console and an optional local file`.

### Task 2: Loki

**Files:** `log.ts` (pino-loki target when `log.loki.url`), schema, tests with a local HTTP server standing in for Loki's push API (`/loki/api/v1/push`).

- [ ] Step 1: tests: records arrive at the fake push endpoint with labels `job`, `role`, `level` + configured; basic auth header when username/password set; fake server down → kernel logger keeps working, at most one stderr note per minute.
- [ ] Step 2: fail → implement → pass. Commit `feat(kernel): push logs to Loki when log.loki.url is set`.

### Task 3: request and job context, access log

**Files:** new `packages/kernel/src/log-context.ts` (`AsyncLocalStorage<Record<string, string>>`, `withLogContext(fields, fn)`, `logContext()`), `packages/kernel/src/http/app.ts` (Fastify `onRequest` / `onResponse` hooks: reqId, header echo, access line), queue worker entry points (where BullMQ processors run a job: set `jobId`, and `runId` in the run worker).

- [ ] Step 1: tests via `http.inject()`: a request gets `x-request-id`; a valid incoming id is echoed, an invalid one replaced; a record logged by a controller carries `reqId`; one access line per request, none for `/healthz`.
- [ ] Step 2: fail → implement → pass. Commit `feat(kernel): request ids and job context on every log record`.

### Task 4: Docs

**Files:** `AGENTS.md` (a short "Logs" note: dev writes `logs/capybara.log`, JSON lines, read with `jq`; agents look there first when a dev kernel misbehaves), `README.md` dev section, `docs/deploy/*.md` (Loki, `log.format`), changesets (`@capybara-hq/kernel` patch, `@capybara-hq/capybara` patch).

- [ ] Step 1: edit; `pnpm lint && pnpm typecheck && pnpm check` pass. Commit `docs: logging outputs`.
