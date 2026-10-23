import { vi } from "vitest";

export type Call = { url: string; method: string; body: unknown; headers: Headers };

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const noContent = () => new Response(null, { status: 204 });

/** 按 `METHOD path` 路由的 fetch 桩（path 含查询串时先按全路径匹配，再按不含查询串的路径匹配）。 */
export function stubApi(
  routes: Record<string, (call: Call) => Response | Promise<Response>>,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const call = { url, method, body: init?.body, headers: new Headers(init?.headers) };
      calls.push(call);
      const handler = routes[`${method} ${url}`] ?? routes[`${method} ${url.split("?")[0]}`];
      if (!handler) throw new Error(`unexpected ${method} ${url}`);
      return handler(call);
    }),
  );
  return calls;
}

/** 请求体（JSON）。 */
export const bodyOf = (c: Call | undefined): unknown =>
  c?.body === undefined ? undefined : JSON.parse(String(c.body));
