/**
 * OpenTelemetry tracing for `capybara start`, loaded only when an OTLP endpoint is configured
 * (see tracing-env.ts and main.ts). Must run before any kernel module is imported.
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { isSpanContextValid, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { addShutdownHook } from "./shutdown.js";

/**
 * Modules the ESM loader hook (import-in-the-middle) wraps so the instrumentations can patch them
 * when they are imported from ESM. Everything else is left alone (no cost, no breakage).
 */
const ESM_HOOKED = ["pg", "ioredis", "@nestjs/core", "http", "https", "node:http", "node:https"];

/** Header the kernel's Loki pusher sets: its pushes are not traced. */
const LOG_PUSH_HEADER = "x-capybara-log-push";
const PROBE = /^\/(healthz|readyz)(\?|$)/;

/** The CLI package version (package.json sits one level above src/ and dist/). */
function cliVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function headersText(headers: unknown): string {
  return (Array.isArray(headers) ? headers.join("\n") : String(headers ?? "")).toLowerCase();
}

export interface StartTracingOptions {
  env: NodeJS.ProcessEnv;
  /** `--role`, when given; else `CAPYBARA_ROLES` is reported as is (the config may still differ). */
  roles?: readonly string[];
  /** Replaces the OTLP exporter (tests: an in-memory exporter). */
  spanProcessors?: SpanProcessor[];
}

/**
 * Starts the OpenTelemetry Node SDK: OTLP http/protobuf trace exporter (configured by the standard
 * `OTEL_*` variables: endpoint, headers, sampler, ...), service name `OTEL_SERVICE_NAME` or
 * `capybara`, and spans for incoming and outgoing HTTP (http, undici / fetch), Nest handlers, pg
 * and ioredis (only inside another span, so background polling makes no root spans), plus one
 * consumer span per BullMQ job (the kernel's job wrapper). Log records carry `traceId` / `spanId`
 * while a span is active. Metrics and OTel logs stay off unless their own variables ask for them.
 * Exporter errors are left to the SDK (never thrown into the kernel); the SDK is shut down, errors
 * swallowed, before the process exits.
 */
export async function startTracing(opts: StartTracingOptions): Promise<{
  shutdown(): Promise<void>;
}> {
  const env = opts.env;
  // tracing only, unless the operator asked for more
  env.OTEL_METRICS_EXPORTER ??= "none";
  env.OTEL_LOGS_EXPORTER ??= "none";
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url, {
    data: { include: ESM_HOOKED },
  });
  const roles = opts.roles?.join(",") ?? env.CAPYBARA_ROLES;
  const version = cliVersion();
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "capybara",
    resource: resourceFromAttributes({
      ...(version !== undefined && { "service.version": version }),
      ...(roles !== undefined && roles !== "" && { "capybara.roles": roles }),
    }),
    ...(opts.spanProcessors
      ? { spanProcessors: opts.spanProcessors }
      : { traceExporter: new OTLPTraceExporter() }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => PROBE.test(req.url ?? ""),
      }),
      new UndiciInstrumentation({
        ignoreRequestHook: (req) => headersText(req.headers).includes(LOG_PUSH_HEADER),
      }),
      new NestInstrumentation(),
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();

  // Imported only now: the kernel's modules must load after the instrumentations are in place.
  const { setJobWrapper, setTraceContextSource } = await import("@capybara-hq/kernel");
  setTraceContextSource(() => {
    const ctx = trace.getActiveSpan()?.spanContext();
    if (!ctx || !isSpanContextValid(ctx)) return undefined;
    return { traceId: ctx.traceId, spanId: ctx.spanId };
  });
  const tracer = trace.getTracer("capybara");
  setJobWrapper((queue, job, fn) =>
    tracer.startActiveSpan(
      `${queue} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": "bullmq",
          "messaging.operation.type": "process",
          "messaging.destination.name": queue,
          ...(job.id !== undefined && { "messaging.message.id": job.id }),
        },
      },
      async (span: Span) => {
        try {
          return await fn();
        } catch (e) {
          if (e instanceof Error) span.recordException(e);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw e;
        } finally {
          span.end();
        }
      },
    ),
  );

  let stopped: Promise<void> | undefined;
  const shutdown = () => {
    stopped ??= sdk.shutdown().catch(() => {});
    return stopped;
  };
  addShutdownHook(shutdown);
  return { shutdown };
}
