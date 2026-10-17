import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
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

interface AuthStub {
  url: string;
  /** 每个请求：方法、路径（不含查询串）与 accessToken 查询参数。 */
  requests: { method: string; path: string; token: string | null; form?: URLSearchParams }[];
  logins(): number;
  /** 作废已签发的令牌：之后带旧令牌的请求返回 403。 */
  revoke(): void;
  loginStatus: number;
  tokenTtl: number;
  close(): Promise<void>;
}

/** 开启鉴权的 Nacos 桩：用户名 `nacos`、密码 `p@ss-SECRET-9`，令牌 `tok-<n>`。 */
async function startAuthStub(content: string): Promise<AuthStub> {
  const valid = new Set<string>();
  let issued = 0;
  const waiting = new Set<ServerResponse>();
  const state = { loginStatus: 200, tokenTtl: 18_000 };
  const requests: AuthStub["requests"] = [];
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => resolve(body));
    });
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    const token = u.searchParams.get("accessToken");
    if (u.pathname === "/nacos/v1/auth/login" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      requests.push({ method: "POST", path: u.pathname, token, form });
      if (
        state.loginStatus !== 200 ||
        form.get("username") !== "nacos" ||
        form.get("password") !== "p@ss-SECRET-9"
      ) {
        res.statusCode = state.loginStatus === 200 ? 403 : state.loginStatus;
        res.end("unknown user! p@ss-SECRET-9");
        return;
      }
      issued++;
      const t = `tok-${issued}`;
      valid.add(t);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accessToken: t, tokenTtl: state.tokenTtl, globalAdmin: false }));
      return;
    }
    requests.push({ method: req.method ?? "", path: u.pathname, token });
    if (token === null || !valid.has(token)) {
      await readBody(req);
      res.statusCode = 403;
      res.end("user not found!");
      return;
    }
    if (u.pathname === "/nacos/v2/cs/config" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: 0, message: "success", data: content }));
      return;
    }
    if (u.pathname === "/nacos/v1/cs/configs/listener" && req.method === "POST") {
      await readBody(req);
      waiting.add(res);
      res.on("close", () => waiting.delete(res));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const s: AuthStub = {
    url: `127.0.0.1:${port}`,
    requests,
    logins: () => requests.filter((r) => r.path === "/nacos/v1/auth/login").length,
    revoke: () => valid.clear(),
    get loginStatus() {
      return state.loginStatus;
    },
    set loginStatus(v) {
      state.loginStatus = v;
    },
    get tokenTtl() {
      return state.tokenTtl;
    },
    set tokenTtl(v) {
      state.tokenTtl = v;
    },
    async close() {
      for (const res of waiting) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  stubs.push(s as unknown as Stub);
  return s;
}

const AUTH = { username: "nacos", password: "p@ss-SECRET-9" };
const configReqs = (s: AuthStub) => s.requests.filter((r) => r.path === "/nacos/v2/cs/config");

describe("nacos auth", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("username/password: logs in first, config and listener requests carry accessToken", async () => {
    const s = await startAuthStub("http:\n  port: 9300\n");
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "d", auth: AUTH });
    expect(((await src.load()) as { http: { port: number } }).http.port).toBe(9300);
    expect(s.requests.map((r) => r.path)).toEqual(["/nacos/v1/auth/login", "/nacos/v2/cs/config"]);
    const login = s.requests[0];
    expect(login?.form?.get("username")).toBe("nacos");
    expect(login?.form?.get("password")).toBe("p@ss-SECRET-9");
    expect(login?.token).toBeNull();
    expect(configReqs(s)[0]?.token).toBe("tok-1");

    const stop = src.watch?.(() => {}) ?? (() => {});
    try {
      const deadline = Date.now() + 5_000;
      while (!s.requests.some((r) => r.path.endsWith("/listener")) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const listener = s.requests.find((r) => r.path === "/nacos/v1/cs/configs/listener");
      expect(listener?.token).toBe("tok-1");
      expect(s.logins()).toBe(1);
    } finally {
      stop();
    }
  });

  it("403 on a config request re-logs in once and succeeds", async () => {
    const s = await startAuthStub("a: 1\n");
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "d", auth: AUTH });
    await src.load();
    s.revoke();
    expect(await src.load()).toEqual({ a: 1 });
    expect(s.logins()).toBe(2);
    expect(configReqs(s).map((r) => r.token)).toEqual(["tok-1", "tok-1", "tok-2"]);
  });

  it("login rejected: load() fails fast naming the server, without the password", async () => {
    const s = await startAuthStub("a: 1\n");
    s.loginStatus = 403;
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "d", auth: AUTH });
    const err = await src.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(s.url);
    expect((err as Error).message).toContain("403");
    expect((err as Error).message).not.toContain("p@ss-SECRET-9");
    expect(configReqs(s)).toEqual([]);
  });

  it("static accessToken: never calls the login endpoint", async () => {
    const s = await startAuthStub("a: 1\n");
    // 桩只认自己签发的令牌：先登录一次拿到 tok-1，再作为静态令牌使用
    await createNacosSource({ server: s.url, namespace: "ns", dataId: "d", auth: AUTH }).load();
    s.requests.length = 0;
    const src = createNacosSource({
      server: s.url,
      namespace: "ns",
      dataId: "d",
      auth: { accessToken: "tok-1" },
    });
    expect(await src.load()).toEqual({ a: 1 });
    expect(s.logins()).toBe(0);
    expect(configReqs(s)[0]?.token).toBe("tok-1");
  });

  it("renews the token at 80% of tokenTtl", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-17T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    const s = await startAuthStub("a: 1\n");
    s.tokenTtl = 2;
    const src = createNacosSource({ server: s.url, namespace: "ns", dataId: "d", auth: AUTH });
    await src.load();
    expect(s.logins()).toBe(1);
    vi.setSystemTime(t0 + 1_500);
    await src.load();
    expect(s.logins()).toBe(1);
    vi.setSystemTime(t0 + 1_700);
    await src.load();
    expect(s.logins()).toBe(2);
    expect(configReqs(s).map((r) => r.token)).toEqual(["tok-1", "tok-1", "tok-2"]);
  });

  it("loadConfig reads CAPYBARA_NACOS_USERNAME / _PASSWORD", async () => {
    const s = await startAuthStub("http:\n  port: 9400\n");
    const config = await loadConfig({
      CAPYBARA_DB__URL: "postgres://u:p@localhost/db",
      CAPYBARA_REDIS__URL: "redis://localhost:6379",
      CAPYBARA_MASTER_KEY: MASTER_KEY,
      CAPYBARA_CONFIG_SOURCE: "nacos",
      CAPYBARA_NACOS_SERVER: s.url,
      CAPYBARA_NACOS_NAMESPACE: "ns",
      CAPYBARA_NACOS_DATA_ID: "d",
      CAPYBARA_NACOS_USERNAME: "nacos",
      CAPYBARA_NACOS_PASSWORD: "p@ss-SECRET-9",
    });
    expect(config.http.port).toBe(9400);
    expect(s.logins()).toBe(1);
  });

  it("CAPYBARA_NACOS_USERNAME without _PASSWORD names the missing variable", async () => {
    await expect(
      loadConfig({
        CAPYBARA_CONFIG_SOURCE: "nacos",
        CAPYBARA_NACOS_SERVER: "x",
        CAPYBARA_NACOS_NAMESPACE: "ns",
        CAPYBARA_NACOS_DATA_ID: "d",
        CAPYBARA_NACOS_USERNAME: "nacos",
      }),
    ).rejects.toThrow(/CAPYBARA_NACOS_PASSWORD/);
  });
});
