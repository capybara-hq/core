import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dynamic, GET, POST } from "../src/app/api/[...path]/route";

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
