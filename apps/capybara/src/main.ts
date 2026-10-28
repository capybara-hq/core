/**
 * CLI entry (bin/capybara.mjs imports this). Starts OpenTelemetry tracing for `capybara start`
 * when an OTLP endpoint is configured, before any kernel module (pg, ioredis, http, Nest) loads, so
 * the instrumentations can patch them; then runs the CLI. Without an endpoint no OpenTelemetry
 * module is imported at all.
 */
import { parseCli } from "./args.js";
import { loadEnvFile, takeEnvFileOption } from "./env-file.js";
import { tracingEnabled } from "./tracing-env.js";

const argv = process.argv.slice(2);
let command: ReturnType<typeof parseCli> | undefined;
try {
  // The CLI loads the env file again and reports errors; here it only has to see OTEL_* in it.
  const { argv: rest, file } = takeEnvFileOption(argv);
  loadEnvFile(file, process.cwd());
  command = parseCli(rest);
} catch {
  command = undefined;
}
if (command?.command === "start" && tracingEnabled(process.env)) {
  const { startTracing } = await import("./tracing.js");
  await startTracing({ env: process.env, ...(command.roles && { roles: command.roles }) });
}
await import("./cli.js");
