import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as route from "../src/app/plugin-ui/[...path]/route";
import { config as proxyConfig } from "../src/proxy";

// next-intl 的中间件依赖 Next 运行时（node 环境下解析不到 next/server）；这里只看 matcher
vi.mock("next-intl/middleware", () => ({ default: () => () => undefined }));

/**
 * `/plugin-ui/<plugin>/<rest>` 同源代理 → 内核 `/plugins/<plugin>/ui/<rest>`（审查重点 3）：
 * 只有 GET / POST（外加 CORS 预检 OPTIONS）；路径只能落在插件的 `/ui/` 下；不转发浏览器 Cookie；
 * 响应去掉 Set-Cookie，加 CSP（frame-ancestors 'self'、sandbox）、nosniff、no-referrer、ACAO *；流式透传。
 */

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

let server: Server;
let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  process.env.CAPYBARA_KERNEL_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  delete process.env.CAPYBARA_KERNEL_URL;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><p>ok</p>");
  };
});

const GET = route.GET as (req: Request) => Promise<Response>;
const POST = route.POST as (req: Request) => Promise<Response>;
const OPTIONS = route.OPTIONS as (req: Request) => Promise<Response>;

const url = (p: string) => `http://web.example${p}`;

function expectSecurityHeaders(res: Response) {
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).toContain("sandbox allow-scripts allow-forms");
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain("allow-same-origin");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("access-control-allow-credentials")).toBeNull();
}

describe("/plugin-ui/[...path] 代理", () => {
  it("强制动态渲染；只导出 GET / POST / OPTIONS", () => {
    expect(route.dynamic).toBe("force-dynamic");
    const exported = Object.keys(route).filter((k) => /^[A-Z]+$/.test(k));
    expect(exported.sort()).toEqual(["GET", "OPTIONS", "POST"]);
  });

  it("Next 的 Proxy（语言前缀）不拦截 /plugin-ui", () => {
    const re = new RegExp(`^${proxyConfig.matcher}$`);
    expect(re.test("/plugin-ui/example-board/board")).toBe(false);
    expect(re.test("/zh/agents")).toBe(true);
  });

  it("GET 转发到内核 /plugins/<plugin>/ui/<rest>（带查询串）；不转发 Cookie 与非白名单请求头", async () => {
    const res = await GET(
      new Request(url("/plugin-ui/example-board/cards?x=1"), {
        headers: {
          cookie: "cap_at=secret; other=1",
          authorization: "Bearer emb.tok",
          accept: "application/json",
          "x-capybara-csrf": "1",
          "x-custom": "nope",
          origin: "null",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.method).toBe("GET");
    expect(s.url).toBe("/plugins/example-board/ui/cards?x=1");
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers.authorization).toBe("Bearer emb.tok");
    expect(s.headers.accept).toBe("application/json");
    expect(s.headers["x-capybara-csrf"]).toBeUndefined();
    expect(s.headers["x-custom"]).toBeUndefined();
    expectSecurityHeaders(res);
  });

  it("POST 转发请求体与 content-type", async () => {
    const res = await POST(
      new Request(url("/plugin-ui/example-board/cards/abc"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: '{"status":"done"}',
      }),
    );
    expect(res.status).toBe(200);
    const s = seen[0] as Seen;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/plugins/example-board/ui/cards/abc");
    expect(s.body).toBe('{"status":"done"}');
    expect(s.headers["content-type"]).toBe("application/json");
  });

  it("响应去掉 Set-Cookie，并以代理的安全头覆盖上游的 CSP / CORS 头", async () => {
    handler = (_req, res) => {
      res.setHeader("set-cookie", ["cap_at=evil; Path=/", "x=1"]);
      res.setHeader("content-security-policy", "default-src *");
      res.setHeader("access-control-allow-origin", "https://evil.example");
      res.setHeader("access-control-allow-credentials", "true");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>x</p>");
    };
    const res = await GET(new Request(url("/plugin-ui/example-board/board")));
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get("content-security-policy")).not.toContain("default-src *");
    expectSecurityHeaders(res);
  });

  it("未声明的路由：内核 404 原样返回（仍带安全头）", async () => {
    handler = (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":{"code":"not_found","message":"Route not found"}}');
    };
    const res = await GET(new Request(url("/plugin-ui/example-board/nope")));
    expect(res.status).toBe(404);
    expect(seen[0]?.url).toBe("/plugins/example-board/ui/nope");
    expectSecurityHeaders(res);
  });

  it("非 /ui/ 路径、目录穿越、编码的斜杠 / 反斜杠、非法插件名、空路径 → 404，不转发", async () => {
    for (const p of [
      "/plugin-ui/example-board",
      "/plugin-ui/example-board/",
      "/plugin-ui/example-board/..%2finc",
      "/plugin-ui/example-board/%2e%2e/inc",
      "/plugin-ui/example-board/a/%2E%2E/%2E%2E/inc",
      "/plugin-ui/example-board/a%2fb",
      "/plugin-ui/example-board/a%5cb",
      "/plugin-ui/example-board//x",
      "/plugin-ui/example-board/%00",
      "/plugin-ui/Example/board",
      "/plugin-ui/../api/v1/me",
      "/plugin-ui/kernel/board",
      "/plugin-ui/a/board",
      "/plugin-ui/%2e%2e/board",
    ]) {
      const res = await GET(new Request(url(p)));
      expect(res.status, p).toBe(404);
      expectSecurityHeaders(res);
    }
    // WHATWG URL 先把 `..` 规范化掉：落到 /plugin-ui 之外的路径同样不转发
    expect(seen.filter((s) => !s.url.startsWith("/plugins/example-board/ui/"))).toEqual([]);
  });

  it("OPTIONS 预检：204，允许 GET / POST 与 Authorization、Content-Type 头，不带凭据", async () => {
    const res = await OPTIONS(
      new Request(url("/plugin-ui/example-board/cards"), {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "content-type",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(seen).toEqual([]);
    expect(
      (await OPTIONS(new Request(url("/plugin-ui/x/..%2fa"), { method: "OPTIONS" }))).status,
    ).toBe(404);
  });

  it("响应体以流透传：上游尚未结束时已能读到第一段（SSE 可用）", async () => {
    let finish: () => void = () => {};
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: ready\ndata: {}\n\n");
      finish = () => res.end("event: cards\ndata: {}\n\n");
    };
    const res = await GET(new Request(url("/plugin-ui/example-board/events")));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("buffered")), 2000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toBe("event: ready\ndata: {}\n\n");
    finish();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("event: cards\ndata: {}\n\n");
  });

  it("请求体超过 1 MiB → 413，不转发", async () => {
    const res = await POST(
      new Request(url("/plugin-ui/example-board/cards"), {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) },
        body: "x",
      }),
    );
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("上游不可达 → 502", async () => {
    const saved = process.env.CAPYBARA_KERNEL_URL;
    process.env.CAPYBARA_KERNEL_URL = "http://127.0.0.1:9";
    try {
      const res = await GET(new Request(url("/plugin-ui/example-board/board")));
      expect(res.status).toBe(502);
      expectSecurityHeaders(res);
    } finally {
      process.env.CAPYBARA_KERNEL_URL = saved;
    }
  });
});
