# @capybara-hq/capybara

## 0.1.0-rc.1

### Patch Changes

- 4a7726f: `capybara` loads `.env` from the working directory before every command (variables already set in
  the environment win); `--env-file <path>` loads another file and `--no-env-file` none.
- 75d7a0c: `capybara start` logs with the configured format and outputs (`log.format`, `log.loki.*`) and
  flushes the Loki buffer before exiting. Optional OpenTelemetry tracing: with
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set, `capybara start`
  exports OTLP traces of HTTP, Nest, fetch, PostgreSQL, Redis and queue jobs, and log records carry
  `traceId` / `spanId`; without it no OpenTelemetry module is loaded.
- 6aaf28b: `capybara start` always runs the bootstrap step (when it is not done for the manifest), from the
  offline directory of config `bootstrap.dir` (default `./bootstrap`, `/app/bootstrap` in the image)
  or else downloading the pins from `packages.npmRegistry`; `--bootstrap-dir` is removed.
  `capybara bootstrap --dir` defaults to the same directory and downloads what it does not hold.
- 6ad094b: The kernel images no longer carry the bootstrap plugin packages: compose `init` (or the first
  `capybara start`) downloads them from npm (`CAPYBARA_PACKAGES__NPM_REGISTRY` for a mirror), and an
  offline deployment mounts a directory holding the pinned tgz files at `/app/bootstrap`
  (`CAPYBARA_BOOTSTRAP__DIR`). The `NPM_REGISTRY` and `NODE_USE_ENV_PROXY` build arguments are gone.
- Updated dependencies [75d7a0c]
- Updated dependencies [e69c9d6]
  - @capybara-hq/kernel@0.1.0-rc.1
