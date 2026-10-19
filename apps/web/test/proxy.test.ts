import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dynamic, GET, PATCH, POST } from "../src/app/api/[...path]/route";
import { PEER_TOKEN_ENV, PEER_TOKEN_HEADER, sanitizeIncoming } from "../src/lib/peer";

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
});

describe("/api/[...path] 代理", () => {
  it("强制动态渲染", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("透传方法、路径、查询、请求头（去掉 host / connection）与 body；状态码、响应头、每条 set-cookie 原样返回", async () => {
    handler = (_req, res) => {
      res.setHeader("set-cookie", [
        "cap_at=a; Path=/; HttpOnly; SameSite=Lax",
        "cap_rt=r; Path=/api/v1/auth; HttpOnly; SameSite=Strict",
      ]);
      res.setHeader("x-upstream", "yes");
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"ok":true}');
    };
    const res = await POST(
      new Request("http://web.example/api/v1/auth/login?x=1&y=two", {
        method: "POST",
        headers: {
          cookie: "cap_at=old",
          "x-capybara-csrf": "1",
          "content-type": "application/json",
          connection: "keep-alive",
          "user-agent": "vitest-ua",
        },
        body: JSON.stringify({ login: "a", password: "b" }),
      }),
    );

    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/api/v1/auth/login?x=1&y=two");
    expect(s.headers.cookie).toBe("cap_at=old");
    expect(s.headers["x-capybara-csrf"]).toBe("1");
    expect(s.headers["user-agent"]).toBe("vitest-ua");
    expect(s.headers.host).not.toBe("web.example");
    expect(s.body).toBe('{"login":"a","password":"b"}');

    expect(res.status).toBe(201);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(res.headers.getSetCookie()).toEqual([
      "cap_at=a; Path=/; HttpOnly; SameSite=Lax",
      "cap_rt=r; Path=/api/v1/auth; HttpOnly; SameSite=Strict",
    ]);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("错误状态码与错误信封原样返回", async () => {
    handler = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"code":"auth.required","message":"x"}}');
    };
    const res = await GET(new Request("http://web.example/api/v1/me"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "auth.required", message: "x" } });
    expect(seen[0]?.method).toBe("GET");
  });

  it("带 body 的请求遇到上游 401 -> 原样返回 401（不能变成 502）", async () => {
    handler = (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"code":"auth.invalid_credentials","message":"x"}}');
    };
    const res = await POST(
      new Request("http://web.example/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-capybara-csrf": "1" },
        body: '{"login":"a","password":"wrong"}',
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "auth.invalid_credentials" } });
    expect(seen[0]?.body).toBe('{"login":"a","password":"wrong"}');
  });

  it("响应体以流透传：上游尚未结束时已能读到第一段（SSE 可用）", async () => {
    let finish: () => void = () => {};
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("data: first\n\n");
      finish = () => res.end("data: last\n\n");
    };
    const res = await GET(new Request("http://web.example/api/v1/stream"));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("buffered")), 2000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    finish();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("data: last\n\n");
  });

  it("上游不可达 -> 502 错误信封", async () => {
    const saved = process.env.CAPYBARA_KERNEL_URL;
    process.env.CAPYBARA_KERNEL_URL = "http://127.0.0.1:1";
    try {
      const res = await GET(new Request("http://web.example/api/v1/me"));
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: { code: "upstream_unavailable" } });
    } finally {
      process.env.CAPYBARA_KERNEL_URL = saved;
    }
  });
});

describe("请求体大小上限（CAPYBARA_WEB_MAX_BODY_BYTES）", () => {
  beforeEach(() => {
    process.env.CAPYBARA_WEB_MAX_BODY_BYTES = "16";
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    };
  });
  afterEach(() => {
    delete process.env.CAPYBARA_WEB_MAX_BODY_BYTES;
  });

  it("content-length 超限 -> 413 payload_too_large，不读 body、不转发", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled = true;
          c.enqueue(new TextEncoder().encode("x"));
          c.close();
        },
        // highWaterMark 0：只有真正 read() 时才 pull，`pulled` 才能证明 body 没被读。
      },
      new CountQueuingStrategy({ highWaterMark: 0 }),
    );
    const res = await POST(
      new Request("http://web.example/api/v1/x", {
        method: "POST",
        headers: { "content-length": "1000000" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(seen).toHaveLength(0);
    expect(pulled).toBe(false);
  });

  it("无 content-length 的流式 body 读到超限即中止 -> 413，不转发", async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        chunks++;
        if (chunks > 100) return c.close();
        c.enqueue(new TextEncoder().encode("0123456789"));
      },
    });
    const res = await POST(
      new Request("http://web.example/api/v1/x", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(seen).toHaveLength(0);
    expect(chunks).toBeLessThan(10);
  });

  it("恰好等于上限 -> 正常转发", async () => {
    const res = await POST(
      new Request("http://web.example/api/v1/x", { method: "POST", body: "0123456789abcdef" }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]?.body).toBe("0123456789abcdef");
  });
});

describe("安装 / 预览应用的请求体上限（可带 2 MB 的 OpenAPI 文档）", () => {
  beforeEach(() => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    };
  });

  it("POST .../apps 与 .../apps/preview 放宽到 6 MiB；其他路由仍为默认 1 MiB", async () => {
    const big = "x".repeat(2_500_000);
    for (const path of ["/api/v1/orgs/o1/apps", "/api/v1/orgs/o1/apps/preview"]) {
      const res = await POST(
        new Request(`http://web.example${path}`, { method: "POST", body: big }),
      );
      expect(res.status, path).toBe(200);
    }
    expect(seen.map((r) => r.body?.length)).toEqual([2_500_000, 2_500_000]);
    for (const path of [
      "/api/v1/x",
      "/api/v1/orgs/o1/apps/a1/refresh",
      "/api/v1/orgs/o1/apps/x/y",
    ]) {
      const res = await POST(
        new Request(`http://web.example${path}`, { method: "POST", body: big }),
      );
      expect(res.status, path).toBe(413);
    }
    const patch = await PATCH(
      new Request("http://web.example/api/v1/orgs/o1/apps", { method: "PATCH", body: big }),
    );
    expect(patch.status).toBe(413);
    const huge = await POST(
      new Request("http://web.example/api/v1/orgs/o1/apps", {
        method: "POST",
        body: "x".repeat(6 * 1024 * 1024 + 1),
      }),
    );
    expect(huge.status).toBe(413);
  });
});

describe("请求头清理", () => {
  beforeEach(() => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("{}");
    };
  });

  it("Expect: 100-continue 不转发（否则 fetch 报错变 502）", async () => {
    const res = await POST(
      new Request("http://web.example/api/v1/x", {
        method: "POST",
        headers: { expect: "100-continue" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(seen[0]?.headers.expect).toBeUndefined();
  });

  it("未经自定义服务器（无可信标记）：客户端伪造的转发头全部丢弃，不带 x-forwarded-for", async () => {
    await GET(
      new Request("http://web.example/api/v1/me", {
        headers: {
          "x-forwarded-for": "1.2.3.4",
          forwarded: "for=1.2.3.4",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
          "x-forwarded-port": "443",
          "x-real-ip": "1.2.3.4",
          [PEER_TOKEN_HEADER]: "forged",
        },
      }),
    );
    const h = seen[0]?.headers ?? {};
    for (const k of [
      "x-forwarded-for",
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
      "x-real-ip",
      PEER_TOKEN_HEADER,
    ]) {
      expect(h[k], k).toBeUndefined();
    }
  });

  it("经自定义服务器（server.mjs 的 sanitizeIncoming）：伪造的 x-forwarded-for 被替换为真实对端地址", async () => {
    const token = "test-peer-token";
    process.env[PEER_TOKEN_ENV] = token;
    // 前置服务器模拟 server.mjs：先清理请求头，再交给路由处理器。
    const front = createServer(async (req, res) => {
      sanitizeIncoming(req, token);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
      }
      const out = await GET(new Request(`http://web.example${req.url}`, { headers }));
      res.writeHead(out.status);
      res.end(await out.text());
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    try {
      const { port } = front.address() as AddressInfo;
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/me`, {
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "x-real-ip": "1.2.3.4",
          forwarded: "for=1.2.3.4",
          [PEER_TOKEN_HEADER]: "forged",
        },
      });
      expect(r.status).toBe(200);
      const h = seen[0]?.headers ?? {};
      expect(h["x-forwarded-for"]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
      expect(h["x-real-ip"]).toBeUndefined();
      expect(h.forwarded).toBeUndefined();
      expect(h[PEER_TOKEN_HEADER]).toBeUndefined();
    } finally {
      delete process.env[PEER_TOKEN_ENV];
      front.closeAllConnections();
      await new Promise<void>((r) => front.close(() => r()));
    }
  });
});
