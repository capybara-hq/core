import { afterEach, describe, expect, it } from "vitest";
import type { Route } from "../../src/ctx/create-ctx.js";
import { createHttpApp, type KernelHttpApp } from "../../src/http/app.js";
import { createLogger, type KernelLogger } from "../../src/log.js";

const apps: KernelHttpApp[] = [];

async function app(
  log: KernelLogger = createLogger("info", { write: () => {} }),
): Promise<KernelHttpApp> {
  const a = await createHttpApp({
    log,
    health: {
      checks: { pg: async () => {}, redis: async () => {} },
      isStopping: () => false,
      log,
    },
    serveApi: true,
    servePlugins: true,
  });
  apps.push(a);
  return a;
}

const route = (method: Route["method"], path: string, handler: Route["handler"]): Route => ({
  method,
  path,
  handler,
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("插件路由分发", () => {
  it("passes method, query, headers and raw body", async () => {
    const a = await app();
    a.mountPlugins([
      route("POST", "/plugins/p/echo", async (req) =>
        Response.json({
          method: req.method,
          url: req.url,
          ct: req.headers.get("content-type"),
          body: await req.text(),
        }),
      ),
    ]);
    const r = await a.inject({
      method: "POST",
      url: "/plugins/p/echo?x=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "a=1&b=2",
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.method).toBe("POST");
    expect(body.url).toContain("/plugins/p/echo?x=1");
    expect(body.ct).toBe("application/x-www-form-urlencoded");
    expect(body.body).toBe("a=1&b=2");
  });

  it("strips kernel session cookies cap_at / cap_rt before the plugin handler", async () => {
    const a = await app();
    a.mountPlugins([
      route("GET", "/plugins/p/cookie", async (req) =>
        Response.json({ cookie: req.headers.get("cookie") }),
      ),
    ]);
    const r = await a.inject({
      method: "GET",
      url: "/plugins/p/cookie",
      headers: { cookie: "cap_at=secret-at; theme=dark; cap_rt=secret-rt;x=1" },
    });
    expect(r.json()).toEqual({ cookie: "theme=dark; x=1" });
    const only = await a.inject({
      method: "GET",
      url: "/plugins/p/cookie",
      headers: { cookie: "cap_at=secret-at; cap_rt=secret-rt" },
    });
    expect(only.json()).toEqual({ cookie: null });
    const lookalike = await a.inject({
      method: "GET",
      url: "/plugins/p/cookie",
      headers: { cookie: "cap_atx=1; xcap_rt=2" },
    });
    expect(lookalike.json()).toEqual({ cookie: "cap_atx=1; xcap_rt=2" });
  });

  it("body over 1 MiB is rejected with 413 before the handler", async () => {
    const a = await app();
    let called = false;
    a.mountPlugins([
      route("POST", "/plugins/p/big", async () => {
        called = true;
        return new Response(null, { status: 204 });
      }),
    ]);
    const r = await a.inject({
      method: "POST",
      url: "/plugins/p/big",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(r.statusCode).toBe(413);
    expect(called).toBe(false);
    // 插件作用域的 Fastify 错误同样映射为内核错误信封
    expect((r.json() as { error: { code: string } }).error.code).toBe("payload_too_large");
  });

  it("HEAD falls back to the GET route without a body", async () => {
    const a = await app();
    a.mountPlugins([route("GET", "/plugins/p/page", async () => new Response("page body"))]);
    const r = await a.inject({ method: "HEAD", url: "/plugins/p/page" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("");
  });

  it("malformed Host is 400 validation_failed without an error log", async () => {
    const lines: Record<string, unknown>[] = [];
    const a = await app(createLogger("debug", { write: (l) => lines.push(JSON.parse(l)) }));
    let called = false;
    a.mountPlugins([
      route("GET", "/plugins/p/x", async () => {
        called = true;
        return new Response("x");
      }),
    ]);
    const r = await a.inject({ method: "GET", url: "/plugins/p/x", headers: { host: "a b" } });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(called).toBe(false);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("plugin handler failure log redacts tokens in the path", async () => {
    const lines: Record<string, unknown>[] = [];
    const a = await app(createLogger("info", { write: (l) => lines.push(JSON.parse(l)) }));
    a.mountPlugins([
      route("GET", "/plugins/p/hook/:token", async () => {
        throw new Error("boom");
      }),
    ]);
    const r = await a.inject({ method: "GET", url: "/plugins/p/hook/cap_SECRETtoken?q=cap_x" });
    expect(r.statusCode).toBe(500);
    const failed = lines.filter((l) => l.msg === "plugin handler failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.path).toBe("/plugins/p/hook/:redacted");
    expect(JSON.stringify(lines)).not.toContain("SECRETtoken");
  });

  it("binary body arrives intact", async () => {
    const a = await app();
    a.mountPlugins([
      route("PUT", "/plugins/p/bin", async (req) =>
        Response.json([...new Uint8Array(await req.arrayBuffer())]),
      ),
    ]);
    const r = await a.inject({
      method: "PUT",
      url: "/plugins/p/bin",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from([0, 255, 1]),
    });
    expect(r.json()).toEqual([0, 255, 1]);
  });

  it("json body is not pre-parsed", async () => {
    const a = await app();
    a.mountPlugins([
      route("POST", "/plugins/p/json", async (req) => new Response(await req.text())),
    ]);
    const r = await a.inject({
      method: "POST",
      url: "/plugins/p/json",
      headers: { "content-type": "application/json" },
      payload: '{"a":1}',
    });
    expect(r.body).toBe('{"a":1}');
  });

  it("copies status, headers and multiple set-cookie", async () => {
    const a = await app();
    a.mountPlugins([
      route(
        "GET",
        "/plugins/p/h",
        async () =>
          new Response("x", {
            status: 201,
            headers: [
              ["x-a", "1"],
              ["set-cookie", "a=1"],
              ["set-cookie", "b=2"],
            ],
          }),
      ),
    ]);
    const r = await a.inject({ method: "GET", url: "/plugins/p/h" });
    expect(r.statusCode).toBe(201);
    expect(r.headers["x-a"]).toBe("1");
    expect(r.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(r.body).toBe("x");
  });

  it("streams response body", async () => {
    const a = await app();
    a.mountPlugins([
      route("GET", "/plugins/p/stream", async () => {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode("he"));
            c.enqueue(enc.encode("llo"));
            c.close();
          },
        });
        return new Response(stream);
      }),
    ]);
    const r = await a.inject({ method: "GET", url: "/plugins/p/stream" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hello");
  });

  it("handler error is 500 without detail", async () => {
    const a = await app();
    a.mountPlugins([
      route("GET", "/plugins/p/boom", async () => {
        throw new Error("secret-detail");
      }),
    ]);
    const r = await a.inject({ method: "GET", url: "/plugins/p/boom" });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.code).toBe("internal");
    expect(r.body).not.toContain("secret-detail");
  });

  it("route params syntax", async () => {
    const a = await app();
    a.mountPlugins([route("GET", "/plugins/p/items/:id", async () => new Response("item"))]);
    const r = await a.inject({ method: "GET", url: "/plugins/p/items/42" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("item");
  });

  it("unmatched and unmounted are 404", async () => {
    const a = await app();
    const before = await a.inject({ method: "GET", url: "/plugins/p/echo" });
    expect(before.statusCode).toBe(404);
    expect(before.json().error.code).toBe("not_found");
    a.mountPlugins([route("GET", "/plugins/p/echo", async () => new Response("ok"))]);
    expect((await a.inject({ method: "GET", url: "/plugins/p/echo" })).statusCode).toBe(200);
    for (const url of ["/plugins/p/nope", "/echo", "/nope"]) {
      const r = await a.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code, url).toBe("not_found");
    }
    // 方法不匹配同样 404
    const post = await a.inject({ method: "POST", url: "/plugins/p/echo" });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe("not_found");
  });

  it("mount outside prefix throws", async () => {
    const a = await app();
    expect(() => a.mountPlugins([route("GET", "/x", async () => new Response("x"))])).toThrow(
      "/plugins/",
    );
  });

  it("mountPlugins may be called once", async () => {
    const a = await app();
    a.mountPlugins([]);
    expect(() => a.mountPlugins([])).toThrow();
  });

  it("close waits for in-flight requests; closeAllConnections forces it", async () => {
    const a = await app();
    apps.splice(apps.indexOf(a), 1); // 本用例自己关闭
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => {
      entered = r;
    });
    a.mountPlugins([
      route("GET", "/plugins/p/hang", () => {
        entered();
        return new Promise<Response>(() => {});
      }),
    ]);
    const port = await a.listen(0);
    const req = fetch(`http://127.0.0.1:${port}/plugins/p/hang`);
    req.catch(() => {});
    await inHandler;
    let closed = false;
    const closing = a.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(false);
    a.closeAllConnections();
    await closing;
    await expect(req).rejects.toThrow();
  });

  it("serves health endpoints and records routes", async () => {
    const a = await app();
    const h = await a.inject({ method: "GET", url: "/healthz" });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ ok: true });
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, pg: "ok", redis: "ok" });
    const urls = a.routes().map((x) => `${x.method} ${x.url}`);
    expect(urls).toContain("GET /healthz");
    expect(urls).toContain("GET /readyz");
  });
});
