import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { secretValues } from "../src/config/fields.js";
import { resolveConfig } from "../src/config/load.js";
import { KernelConfigSchema } from "../src/config/schema.js";
import { createLogger } from "../src/log.js";
import { loggerOptionsFromConfig } from "../src/log-config.js";
import { createLokiStream } from "../src/log-loki.js";

interface Push {
  path: string;
  auth: string | undefined;
  body: { streams: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> };
}

/** A local stand-in for Loki's push API. */
async function fakeLoki(status = 204) {
  const pushes: Push[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => {
      pushes.push({
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(data),
      });
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    pushes,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const raw = {
  db: { url: "postgres://h/db" },
  redis: { url: "redis://h" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("Loki output", () => {
  it("pushes redacted records with job / role / level and the configured labels", async () => {
    const loki = await fakeLoki();
    servers.push(loki);
    const config = resolveConfig(
      {
        ...raw,
        roles: ["api", "worker"],
        log: { loki: { url: loki.url, labels: { env: "dev" } } },
      },
      {},
    );
    const lines: string[] = [];
    const log = createLogger(
      "debug",
      loggerOptionsFromConfig(config, { write: (l) => lines.push(l) }),
    );
    log.debug("debug both ways");
    log.info("hello", { a: 1 });
    log.addOrgSecrets(["org-secret-value-123"]); // registered after creation
    log.warn("careful", { token: "org-secret-value-123" });
    await log.flush();
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["debug both ways", "hello", "careful"]);
    const streams = loki.pushes.flatMap((p) => p.body.streams);
    expect(streams.find((s) => s.stream.level === "debug")?.values).toHaveLength(1);
    expect(loki.pushes[0]?.path).toBe("/loki/api/v1/push");
    expect(loki.pushes[0]?.auth).toBeUndefined();
    const info = streams.find((s) => s.stream.level === "info");
    const warn = streams.find((s) => s.stream.level === "warn");
    expect(info?.stream).toEqual({
      job: "capybara",
      role: "api,worker",
      level: "info",
      env: "dev",
    });
    const [ts, line] = (info?.values[0] ?? []) as [string, string];
    expect(ts).toMatch(/^\d{19}$/);
    expect(JSON.parse(line)).toMatchObject({ msg: "hello", a: 1, role: "api,worker" });
    const warnLine = warn?.values[0]?.[1] as string;
    expect(warnLine).toContain("[REDACTED]");
    expect(JSON.stringify(loki.pushes)).not.toContain("org-secret-value-123");
  });

  it("sends basic auth when username / password are set", async () => {
    const loki = await fakeLoki();
    servers.push(loki);
    const stream = createLokiStream({
      url: `${loki.url}/loki/api/v1/push`,
      username: "u1",
      password: "p@ss",
      labels: {},
      role: "api",
    });
    stream.write(
      `${JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "x" })}\n`,
    );
    await stream.flush();
    expect(loki.pushes[0]?.path).toBe("/loki/api/v1/push");
    expect(loki.pushes[0]?.auth).toBe(`Basic ${Buffer.from("u1:p@ss").toString("base64")}`);
  });

  it("batches on an interval without being flushed", async () => {
    const loki = await fakeLoki();
    servers.push(loki);
    const stream = createLokiStream({ url: loki.url, labels: {}, role: "api", intervalMs: 20 });
    stream.write(
      `${JSON.stringify({ time: new Date().toISOString(), level: "info", msg: "x" })}\n`,
    );
    for (let i = 0; i < 100 && loki.pushes.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(loki.pushes).toHaveLength(1);
    await stream.close();
  });

  it("Loki down or failing: logging keeps working, at most one stderr note per minute", async () => {
    const failing = await fakeLoki(500);
    servers.push(failing);
    for (const url of ["http://127.0.0.1:9", failing.url]) {
      const notes: string[] = [];
      let now = 0;
      const lines: string[] = [];
      const log = createLogger("info", {
        write: (l) => lines.push(l),
        loki: {
          url,
          labels: {},
          role: "api",
          onError: (m) => notes.push(m),
          now: () => now,
        },
      });
      for (let i = 0; i < 5; i++) {
        log.info(`line ${i}`);
        await log.flush();
        now += 10_000;
      }
      expect(lines).toHaveLength(5);
      expect(notes).toHaveLength(1);
      now += 60_000;
      log.info("later");
      await log.flush();
      expect(notes).toHaveLength(2);
      expect(notes[0]).toMatch(/Loki/);
    }
  });

  it("drops the oldest records when the buffer is full", async () => {
    const loki = await fakeLoki();
    servers.push(loki);
    const stream = createLokiStream({ url: loki.url, labels: {}, role: "api", maxBuffer: 3 });
    for (let i = 0; i < 5; i++) {
      stream.write(
        `${JSON.stringify({ time: new Date().toISOString(), level: "info", msg: `m${i}` })}\n`,
      );
    }
    await stream.flush();
    const msgs = loki.pushes
      .flatMap((p) => p.body.streams.flatMap((s) => s.values))
      .map((v) => JSON.parse(v[1]).msg);
    expect(msgs).toEqual(["m2", "m3", "m4"]);
  });

  it("config: label names are checked, the password is a secret", () => {
    expect(() =>
      resolveConfig(
        { ...raw, log: { loki: { url: "http://l", labels: { "bad-name": "x" } } } },
        {},
      ),
    ).toThrow(/labels/);
    const config = resolveConfig(raw, {
      CAPYBARA_LOG__LOKI__URL: "http://loki:3100",
      CAPYBARA_LOG__LOKI__USERNAME: "u",
      CAPYBARA_LOG__LOKI__PASSWORD: "loki-password-1",
    });
    expect(loggerOptionsFromConfig(config).loki).toMatchObject({
      url: "http://loki:3100",
      username: "u",
      password: "loki-password-1",
      role: "api,worker,gateway",
    });
    expect(secretValues(KernelConfigSchema, config)).toContain("loki-password-1");
    expect(loggerOptionsFromConfig(resolveConfig(raw, {})).loki).toBeUndefined();
  });
});
