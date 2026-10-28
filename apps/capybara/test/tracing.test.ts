import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tracingEnabled } from "../src/tracing-env.js";
import { cleanEnv, REPO_ROOT } from "./support/cli.js";

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Env without CAPYBARA_* and OTEL_* variables. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = cleanEnv();
  for (const k of Object.keys(env)) if (k.startsWith("OTEL_")) delete env[k];
  return env;
}

describe("tracingEnabled", () => {
  it("is on only with an OTLP endpoint and not disabled", () => {
    expect(tracingEnabled({})).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: " " })).toBe(false);
    expect(tracingEnabled({ OTEL_SERVICE_NAME: "x" })).toBe(false);
    expect(tracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" })).toBe(true);
    expect(
      tracingEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://otel:4318/v1/traces" }),
    ).toBe(true);
    expect(
      tracingEnabled({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318",
        OTEL_SDK_DISABLED: "true",
      }),
    ).toBe(false);
  });
});

describe("capybara start and OpenTelemetry modules", () => {
  let dir: string;
  let hook: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cap-otel-"));
    hook = join(dir, "record-otel.mjs");
    // Records every resolved module under @opentelemetry (ESM imports and require alike).
    await writeFile(
      hook,
      `import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url.includes("/@opentelemetry/")) appendFileSync(process.env.OTEL_RECORD, r.url + "\\n");
    return r;
  },
});
`,
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function start(env: NodeJS.ProcessEnv, record: string) {
    await writeFile(record, "");
    const r = await run(
      "node",
      ["--import", hook, "apps/capybara/bin/capybara.mjs", "start", "--no-env-file"],
      { ...env, OTEL_RECORD: record },
    );
    // no db / redis / master key: start stops at the configuration, after tracing would start
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("cannot load configuration");
    return (await readFile(record, "utf8")).split("\n").filter((l) => l !== "");
  }

  it("without an endpoint no OpenTelemetry module is loaded", async () => {
    expect(await start(baseEnv(), join(dir, "off.txt"))).toEqual([]);
  }, 60_000);

  it("with an endpoint the SDK loads (control for the test above)", async () => {
    const loaded = await start(
      { ...baseEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" },
      join(dir, "on.txt"),
    );
    expect(loaded.some((u) => u.includes("/@opentelemetry/sdk-node/"))).toBe(true);
  }, 60_000);
});

describe("spans", () => {
  let pg: TestContainer;
  beforeAll(async () => {
    pg = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await pg?.stop();
  });

  it("an HTTP request, the pg query it makes and its log records share one trace", async () => {
    const r = await run(
      "pnpm",
      [
        "exec",
        "tsx",
        "--tsconfig",
        "tsconfig.base.json",
        "--conditions=@capybara-hq/source",
        "apps/capybara/test/support/tracing-fixture.ts",
      ],
      {
        ...baseEnv(),
        FIXTURE_DB_URL: pg.url,
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
        OTEL_SERVICE_NAME: "cap-test",
      },
    );
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1) as string) as {
      status: number;
      spans: Array<{
        name: string;
        kind: number;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        scope: string;
        resource: Record<string, unknown>;
      }>;
      logs: Array<Record<string, unknown>>;
    };
    expect(out.status).toBe(200);
    const byScope = (s: string) => out.spans.filter((x) => x.scope.includes(s));
    const client = byScope("undici")[0];
    const server = byScope("instrumentation-http").find((s) => s.kind === 1);
    const query = byScope("instrumentation-pg").find((s) => s.parentSpanId === server?.spanId);
    expect(client, JSON.stringify(out.spans)).toBeDefined();
    expect(server).toBeDefined();
    expect(query).toBeDefined();
    expect(server?.traceId).toBe(client?.traceId);
    expect(server?.parentSpanId).toBe(client?.spanId);
    expect(server?.resource).toMatchObject({
      "service.name": "cap-test",
      "capybara.roles": "api",
    });
    expect(server?.resource["service.version"]).toEqual(expect.any(String));
    const handled = out.logs.find((l) => l.msg === "handled");
    expect(handled?.traceId).toBe(server?.traceId);
    expect(handled?.spanId).toEqual(expect.any(String));
    expect(out.logs.find((l) => l.msg === "outside")).not.toHaveProperty("traceId");
  }, 120_000);
});
