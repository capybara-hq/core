---
"@capybara-hq/capybara": patch
---

`capybara start` logs with the configured format and outputs (`log.format`, `log.loki.*`) and
flushes the Loki buffer before exiting. Optional OpenTelemetry tracing: with
`OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set, `capybara start`
exports OTLP traces of HTTP, Nest, fetch, PostgreSQL, Redis and queue jobs, and log records carry
`traceId` / `spanId`; without it no OpenTelemetry module is loaded.
