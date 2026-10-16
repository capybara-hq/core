import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, createNacosSource, loadConfig } from "../../src/index.js";

const MASTER_KEY = Buffer.alloc(32, 1).toString("base64");

interface Stub {
  server: Server;
  url: string;
  setContent(c: string): void;
  requests: string[];
  close(): Promise<void>;
}

async function startStub(initial: string): Promise<Stub> {
  let content = initial;
  const requests: string[] = [];
  const waiting = new Set<ServerResponse>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith("/nacos/v2/cs/config") && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: 0, message: "success", data: content }));
      return;
    }
    if (req.url === "/nacos/v1/cs/configs/listener" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const md5 = createHash("md5").update(content).digest("hex");
        const sent = decodeURIComponent(new URLSearchParams(body).get("Listening-Configs") ?? "");
        const changed = !sent.includes(md5);
        if (changed) {
          res.end("capybara.yaml%02DEFAULT_GROUP%02ns%01");
          return;
        }
        waiting.add(res);
        res.on("close", () => waiting.delete(res));
      });
      return;
    }
    res.statusCode = 404;
    res.end("secret-body");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `127.0.0.1:${port}`,
    requests,
    setContent(c) {
      content = c;
      for (const res of waiting) res.end("capybara.yaml%02DEFAULT_GROUP%02ns%01");
      waiting.clear();
    },
    async close() {
      for (const res of waiting) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const stubs: Stub[] = [];
afterEach(async () => {
  await Promise.all(stubs.splice(0).map((s) => s.close()));
});
async function stub(initial: string): Promise<Stub> {
  const s = await startStub(initial);
  stubs.push(s);
  return s;
}

describe("nacos source", () => {
  it("loads yaml from nacos", async () => {
    const s = await stub("http:\n  port: 9200\n");
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "capybara.yaml" });
    const raw = (await src.load()) as { http: { port: number } };
    expect(raw.http.port).toBe(9200);
  });

  it("unreachable fails fast", async () => {
    const s = await stub("");
    const url = s.url;
    await s.close();
    const src = createNacosSource({ server: url, namespace: "ns", dataId: "capybara.yaml" });
    await expect(src.load()).rejects.toThrow(/capybara\.yaml/);
    await expect(src.load()).rejects.toBeInstanceOf(ConfigError);
  });

  it("non-200 fails without leaking the body", async () => {
    const s = await stub("");
    const src = createNacosSource({
      server: `http://${s.url}/`,
      namespace: "ns",
      dataId: "x",
      fetch: (input, init) => fetch(String(input).replace("/v2/cs/config", "/nope"), init),
    });
    const err = await src.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain("secret-body");
    expect((err as Error).message).toContain("x");
  });

  it("invalid yaml has no excerpt", async () => {
    const s = await stub("a: [unclosed TOPSECRET\n");
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "capybara.yaml" });
    const err = await src.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain("TOPSECRET");
    expect((err as Error).message).toContain("capybara.yaml");
  });

  it("watch fires on change and stops after cancel", async () => {
    const s = await stub("http:\n  port: 9200\n");
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "capybara.yaml" });
    await src.load();
    const got: unknown[] = [];
    const next = new Promise<void>((resolve) => {
      const cancel = src.watch?.((raw) => {
        got.push(raw);
        resolve();
      });
      cancels.push(cancel as () => void);
    });
    await new Promise((r) => setTimeout(r, 100));
    s.setContent("http:\n  port: 9300\n");
    await next;
    expect(got).toEqual([{ http: { port: 9300 } }]);
    cancels.pop()?.();
    await new Promise((r) => setTimeout(r, 100));
    const count = s.requests.length;
    s.setContent("http:\n  port: 9400\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(s.requests.length).toBe(count);
    expect(got).toHaveLength(1);
  });
});

const cancels: Array<() => void> = [];
afterEach(() => {
  for (const c of cancels.splice(0)) c();
});

describe("nacos source robustness", () => {
  it("watch delivers a change that landed between load() and watch()", async () => {
    const s = await stub("http:\n  port: 9200\n");
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "capybara.yaml" });
    await src.load();
    s.setContent("http:\n  port: 9300\n");
    const got = await new Promise<unknown>((resolve) => {
      cancels.push(src.watch?.(resolve) as () => void);
    });
    expect(got).toEqual({ http: { port: 9300 } });
  });

  it("backoff does not leak abort listeners and cancel stops requests", async () => {
    const s = await stub("a: 1\n");
    let listenerCalls = 0;
    const warnings: string[] = [];
    const onWarn = (w: Error) => warnings.push(w.name);
    process.on("warning", onWarn);
    const src = createNacosSource({
      server: s.url,
      namespace: "ns",
      dataId: "capybara.yaml",
      backoffMs: 1,
      fetch: async (input, init) => {
        if (String(input).includes("/listener")) {
          listenerCalls++;
          return new Response("x", { status: 500 });
        }
        return fetch(input, init);
      },
    });
    const errors: Error[] = [];
    await src.load();
    const cancel = src.watch?.(
      () => {},
      (e) => errors.push(e),
    ) as () => void;
    cancels.push(cancel);
    while (listenerCalls < 15) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setImmediate(r));
    process.off("warning", onWarn);
    expect(warnings).not.toContain("MaxListenersExceededWarning");
    expect(errors[0]).toBeInstanceOf(ConfigError);
    cancel();
    await new Promise((r) => setTimeout(r, 20));
    const n = listenerCalls;
    await new Promise((r) => setTimeout(r, 50));
    expect(listenerCalls).toBe(n);
  });

  it("load times out when nacos never responds", async () => {
    const hang = createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const port = (hang.address() as AddressInfo).port;
    try {
      const src = createNacosSource({
        server: `127.0.0.1:${port}`,
        namespace: "ns",
        dataId: "capybara.yaml",
        timeoutMs: 100,
      });
      const err = await src.load().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/capybara\.yaml.*timed out|timed out.*capybara\.yaml/);
    } finally {
      hang.closeAllConnections();
      await new Promise<void>((r) => hang.close(() => r()));
    }
  });

  it("onError fires for invalid yaml pushed during watch, scrubbed", async () => {
    const s = await stub("a: 1\n");
    const src = createNacosSource({
      server: s.url,
      namespace: "ns",
      dataId: "capybara.yaml",
      backoffMs: 20,
    });
    await src.load();
    const err = new Promise<Error>((resolve) => {
      cancels.push(src.watch?.(() => {}, resolve) as () => void);
    });
    await new Promise((r) => setTimeout(r, 50));
    s.setContent("a: [unclosed TOPSECRET\n");
    const e = await err;
    expect(e).toBeInstanceOf(ConfigError);
    expect(e.message).not.toContain("TOPSECRET");
  });

  it("onChange exceptions go to onError", async () => {
    const s = await stub("a: 1\n");
    const src = createNacosSource({
      server: s.url,
      namespace: "ns",
      dataId: "capybara.yaml",
      backoffMs: 20,
    });
    await src.load();
    const err = new Promise<Error>((resolve) => {
      cancels.push(
        src.watch?.(() => {
          throw new Error("boom SECRET");
        }, resolve) as () => void,
      );
    });
    await new Promise((r) => setTimeout(r, 50));
    s.setContent("a: 2\n");
    const e = await err;
    expect(e.message).not.toContain("SECRET");
  });
});

describe("loadConfig with nacos", () => {
  it("nacos values apply and env still overrides", async () => {
    const s = await stub("http:\n  port: 9200\nlog:\n  level: debug\n");
    const env = {
      CAPYBARA_DB__URL: "postgres://u:p@localhost/db",
      CAPYBARA_REDIS__URL: "redis://localhost:6379",
      CAPYBARA_MASTER_KEY: MASTER_KEY,
      CAPYBARA_CONFIG_SOURCE: "nacos",
      CAPYBARA_NACOS_SERVER: s.url,
      CAPYBARA_NACOS_NAMESPACE: "ns",
      CAPYBARA_NACOS_DATA_ID: "capybara.yaml",
      CAPYBARA_HTTP__PORT: "9500",
    };
    const config = await loadConfig(env);
    expect(config.http.port).toBe(9500);
    expect(config.log.level).toBe("debug");
  });

  it("missing nacos variable names it", async () => {
    await expect(
      loadConfig({ CAPYBARA_CONFIG_SOURCE: "nacos", CAPYBARA_NACOS_SERVER: "x" }),
    ).rejects.toThrow(/CAPYBARA_NACOS_NAMESPACE/);
  });
});
