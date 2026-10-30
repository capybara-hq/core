import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { FastifyAdapter } from "@nestjs/platform-fastify";

/**
 * 把 `http.trustProxy` 配置转成 Fastify 的 trustProxy。布尔与 IP / CIDR 列表原样传入；
 * 跳数转成 `(addr, hop) => hop < n`：Fastify 5.12 起对 number 一律 fail closed（不信任任何一跳），
 * 所以由这里实现跳数语义——前提是服务只能经由这 n 层代理访问（配置说明里已写明，并推荐 CIDR 列表）。
 */
function fastifyTrustProxy(
  tp: boolean | number | string[],
): boolean | string[] | ((addr: string, hop: number) => boolean) {
  return typeof tp === "number" ? (_addr, hop) => hop < tp : tp;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The request id: a valid incoming `x-request-id`, else a random one. */
function requestId(req: { headers: IncomingHttpHeaders }): string {
  const h = req.headers["x-request-id"];
  return typeof h === "string" && REQUEST_ID.test(h) ? h : randomUUID();
}

/** The kernel's Fastify adapter: trusted proxies (`http.trustProxy`) and validated request ids. */
export function createKernelAdapter(
  trustProxy: boolean | number | string[] = false,
): FastifyAdapter {
  return new FastifyAdapter({
    trustProxy: fastifyTrustProxy(trustProxy),
    // x-request-id is read by requestId() (validated), never trusted as is
    requestIdHeader: false,
    genReqId: requestId,
  });
}
