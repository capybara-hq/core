import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export type FakeResponse =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status: 200; sse: { event?: string; data: string }[]; delayMs?: number }
  | { stall: true };

export interface FakeModelServer {
  url: string;
  requests: FakeRequest[];
  stop(): Promise<void>;
}

/** 本地假模型服务：供插件用原生协议编写夹具。 */
export async function startFakeModelServer(
  routes: (req: FakeRequest) => FakeResponse,
): Promise<FakeModelServer> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = raw === "" ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      const fake: FakeRequest = { path: req.url ?? "/", body, headers };
      requests.push(fake);
      let out: FakeResponse;
      try {
        out = routes(fake);
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
        return;
      }
      if ("stall" in out) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
      if ("json" in out) {
        res.writeHead(out.status, { ...out.headers, "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const payload = out.sse
        .map((e) => `${e.event !== undefined ? `event: ${e.event}\n` : ""}data: ${e.data}\n\n`)
        .join("");
      if (out.delayMs) {
        const t = setTimeout(() => res.end(payload), out.delayMs);
        res.on("close", () => clearTimeout(t));
      } else {
        res.end(payload);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
