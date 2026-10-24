/**
 * 同源代理（`/api/*` 与 `/plugin-ui/*`）共用的小工具：内核地址、带上限地读请求体、413 响应。
 */

const DEFAULT_KERNEL_URL = "http://localhost:8080";

/** 默认请求体上限 1 MiB（与内核 Fastify 的 bodyLimit 一致）。 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** 内核地址（`CAPYBARA_KERNEL_URL`，默认 http://localhost:8080），去掉末尾的 `/`。 */
export function kernelUrl(): string {
  return (process.env.CAPYBARA_KERNEL_URL ?? DEFAULT_KERNEL_URL).replace(/\/+$/, "");
}

/** 部署配置的请求体上限（`CAPYBARA_WEB_MAX_BODY_BYTES`），没配或非法时取默认值。 */
export function configuredMaxBodyBytes(): number {
  const n = Number(process.env.CAPYBARA_WEB_MAX_BODY_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

export const tooLarge = (limit: number, headers?: HeadersInit) =>
  Response.json(
    { error: { code: "payload_too_large", message: `Request body exceeds ${limit} bytes` } },
    { status: 413, ...(headers !== undefined && { headers }) },
  );

/**
 * 读完请求体，超过 `limit` 字节立即中止并返回 `undefined`：先看 content-length（超限则一字节都不读），
 * 再边读边计数（没有或谎报 content-length 时兜底）。
 */
export async function readBody(
  req: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (req.body === null) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** 插件包上传的默认请求体上限 50 MiB（与内核 `packages.maxBytes` 的默认值一致）。 */
export const DEFAULT_MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

/**
 * 插件包上传的请求体上限（`CAPYBARA_WEB_MAX_PACKAGE_BYTES`；部署调大了内核 `packages.maxBytes` 时同步调大），
 * 没配或非法时取默认值。
 */
export function configuredMaxPackageBytes(): number {
  const n = Number(process.env.CAPYBARA_WEB_MAX_PACKAGE_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_PACKAGE_BYTES;
}

/**
 * 给请求体流加上限：边透传边计数，超过 `limit` 字节时让流出错（上游请求随之中止）。
 * `exceeded()` 供调用方在上游请求失败后区分「超限」与「上游不可达」。
 */
export function limitStream(
  body: ReadableStream<Uint8Array>,
  limit: number,
): { stream: ReadableStream<Uint8Array>; exceeded(): boolean } {
  let size = 0;
  let over = false;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) {
          over = true;
          controller.error(new Error(`Request body exceeds ${limit} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, exceeded: () => over };
}
