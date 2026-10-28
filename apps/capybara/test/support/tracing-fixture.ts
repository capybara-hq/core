// Run in a child process by tracing.test.ts: starts tracing (in-memory exporter) before the kernel
// loads, then serves one HTTP request that queries PG through the kernel's pool and logs a record,
// called with fetch. Prints the spans and the log records as one JSON line.
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { runShutdownHooks } from "../../src/shutdown.js";
import { startTracing } from "../../src/tracing.js";

const exporter = new InMemorySpanExporter();
await startTracing({
  env: process.env,
  roles: ["api"],
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const { createServer } = await import("node:http");
const { createDb, createLogger } = await import("@capybara-hq/kernel");
const db = createDb(process.env.FIXTURE_DB_URL as string, 1);
const lines: string[] = [];
const log = createLogger("info", { write: (l) => lines.push(l) });

const server = createServer((_req, res) => {
  void db.introspection.getSchemas().then(
    () => {
      log.info("handled");
      res.end("ok");
    },
    (e: unknown) => {
      res.statusCode = 500;
      res.end(String(e));
    },
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address() as { port: number };
const res = await fetch(`http://127.0.0.1:${port}/hello`);
await res.text();
await new Promise<void>((r) => server.close(() => r()));
await db.destroy();
log.info("outside");
// collect before shutting down: the in-memory exporter forgets its spans on shutdown
const spans = exporter.getFinishedSpans().map((s) => ({
  name: s.name,
  kind: s.kind,
  traceId: s.spanContext().traceId,
  spanId: s.spanContext().spanId,
  parentSpanId: s.parentSpanContext?.spanId,
  scope: s.instrumentationScope.name,
  resource: s.resource.attributes,
}));
await runShutdownHooks();
process.stdout.write(
  `${JSON.stringify({ status: res.status, spans, logs: lines.map((l) => JSON.parse(l)) })}\n`,
);
