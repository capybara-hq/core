import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type Channel,
  ChannelSendError,
  type ChannelSendFailure,
  type ChannelWebhook,
  type InboundEvent,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * 假 IM 平台的 `channel@1`（连 `@capybara-hq/testing` 的 startFakeChannelServer）。真实渠道插件（Slack / 飞书）照这个形状写：
 * - verify：`POST <platformUrl>/bot/verify` 校验应用凭据，拿到机器人 id 与租户；
 * - connect：`GET <platformUrl>/connect` 拿一条 NDJSON 长连接，逐行交给 `onEvent`；平台关闭连接后自行重连，
 *   连接请求失败（非 200）时抛错（内核据此记录 last_error 并退避重试）；signal 中止时返回；
 * - send / update：POST 给平台并透传 `idempotencyKey`（平台据此去重）与 `locale`；429 / 5xx 抛可重试的
 *   `ChannelSendError`（带平台给的等待时长），其他失败抛不可重试的（带平台给的失败原因 `reason`）。
 * 所有请求带 `x-pid`，让平台知道是哪个进程（副本）发起的。
 */
export const FakeImConnection = z.object({
  platformUrl: z.string().url(),
  appId: z.string().min(1),
  tenant: z.string().min(1).default("t1"),
  appSecret: secret(z.string().min(1)),
  /**
   * Optional secret (also tests PATCH secret semantics); the webhook signing secret: webhook
   * requests are signed `x-fake-signature: sha256=<hex HMAC-SHA256(webhookToken, raw body)>`.
   */
  webhookToken: secret(z.string().min(1).optional()),
  /** 被中止后拖这么久才返回（模拟不及时退出的插件）。 */
  lingerMs: z.number().int().nonnegative().default(0),
});
type ConnConfig = z.infer<typeof FakeImConnection>;

const headers = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "x-pid": String(process.pid),
  ...extra,
});

// capybara:allow-module-state a read-only constant set
const REASONS = new Set<ChannelSendFailure>(["auth", "target_gone", "rejected", "too_large"]);

/**
 * Waits `ms` or until `signal` aborts. Extensions may not use timers (plugin-timer rule), so
 * `AbortSignal.timeout` does the timing, as in the real channel extensions.
 */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = AbortSignal.timeout(ms);
    const done = () => {
      signal?.removeEventListener("abort", done);
      timer.removeEventListener("abort", done);
      resolve();
    };
    signal?.addEventListener("abort", done, { once: true });
    timer.addEventListener("abort", done, { once: true });
  });

/**
 * POST 给平台：429 / 5xx → 可重试的 ChannelSendError（带平台给的等待时长），其他非 200 → 不可重试
 * （带平台给的失败原因）。
 */
async function post(c: ConnConfig, path: string, body: unknown, signal: AbortSignal) {
  const res = await fetch(`${c.platformUrl}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 200) return res;
  const b = (await res.json().catch(() => ({}))) as {
    retryAfterMs?: number | null;
    reason?: string | null;
  };
  const retryable = res.status === 429 || res.status >= 500;
  const reason = REASONS.has(b.reason as ChannelSendFailure)
    ? (b.reason as ChannelSendFailure)
    : undefined;
  throw new ChannelSendError(`platform returned ${res.status}`, {
    retryable,
    ...(typeof b.retryAfterMs === "number" && { retryAfterMs: b.retryAfterMs }),
    ...(!retryable && reason !== undefined && { reason }),
  });
}

/** 读一条 NDJSON 长连接直到平台关闭；每行一个入站事件。 */
async function pump(body: ReadableStream<Uint8Array>, onEvent: (e: InboundEvent) => Promise<void>) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line !== "") {
        try {
          await onEvent(JSON.parse(line) as InboundEvent);
        } catch {
          // 处理失败：真实平台会因未确认而重投；测试里由平台手动重推
        }
      }
      nl = buf.indexOf("\n");
    }
  }
}

/** Constant-time check of `x-fake-signature` against HMAC-SHA256(secret, body). */
function signatureOk(header: string | undefined, secret: string, body: Uint8Array): boolean {
  if (header === undefined) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Webhook inbound of the fake platform (see `signFakeWebhook` in `@capybara-hq/testing`): every
 * request must be signed with `webhookToken` (missing secret or bad signature → reject 401);
 * `{ type: "challenge", challenge }` echoes `{ challenge }`; `{ type: "events", events }` hands the
 * events to the kernel with the ack body `ok`; anything else → reject 400.
 */
export const fakeImWebhook: ChannelWebhook = {
  async handle({ config, request }) {
    const c = config as ConnConfig;
    if (c.webhookToken === undefined) return { kind: "reject", status: 401 };
    if (!signatureOk(request.headers["x-fake-signature"], c.webhookToken, request.body)) {
      return { kind: "reject", status: 401 };
    }
    let msg: { type?: unknown; challenge?: unknown; events?: unknown };
    try {
      msg = JSON.parse(new TextDecoder().decode(request.body)) as typeof msg;
    } catch {
      return { kind: "reject", status: 400 };
    }
    if (msg.type === "challenge" && typeof msg.challenge === "string") {
      return {
        kind: "respond",
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ challenge: msg.challenge }),
        },
      };
    }
    if (msg.type === "events" && Array.isArray(msg.events)) {
      return {
        kind: "events",
        events: msg.events as InboundEvent[],
        ack: { status: 200, headers: { "content-type": "text/plain" }, body: "ok" },
      };
    }
    return { kind: "reject", status: 400 };
  },
};

/**
 * 按能力开关造一个假渠道（chan-mini / chan-noedit 复用，只是插件名与 features 不同）。
 * `opts.webhook` adds {@link fakeImWebhook} (only `fake-im` has it; the others test "unsupported").
 */
export const makeFakeImChannel = (
  features: Channel["features"],
  opts: { webhook?: boolean } = {},
): Channel => ({
  ...(opts.webhook === true && { webhook: fakeImWebhook }),
  connectionSchema: FakeImConnection,
  features,
  async verify({ config, signal }) {
    const c = config as ConnConfig;
    const res = await fetch(`${c.platformUrl}/bot/verify`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ appId: c.appId, appSecret: c.appSecret, tenant: c.tenant }),
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`invalid app credentials (platform returned ${res.status})`);
    }
    return (await res.json()) as { botUserId: string; botName: string; tenantId: string };
  },
  async connect({ connectionId, config, onEvent, signal }) {
    const c = config as ConnConfig;
    while (!signal.aborted) {
      try {
        const res = await fetch(
          `${c.platformUrl}/connect?connection=${encodeURIComponent(connectionId)}`,
          { signal, headers: headers({ "x-app-id": c.appId }) },
        );
        if (res.status !== 200 || !res.body) {
          await res.body?.cancel();
          throw new Error(`connect failed with status ${res.status}`);
        }
        await pump(res.body, onEvent);
      } catch (e) {
        if (signal.aborted) {
          // the signal is already aborted: linger without it
          if (c.lingerMs > 0) await pause(c.lingerMs);
          return;
        }
        throw e;
      }
      // The platform closed the connection: reconnect shortly
      await pause(50, signal);
    }
  },
  async send({ config, target, message, signal, idempotencyKey, locale }) {
    const c = config as ConnConfig;
    const body = { appId: c.appId, target, message, idempotencyKey, locale };
    const res = await post(c, "/send", body, signal);
    return (await res.json()) as { messageId: string };
  },
  async update({ config, target, message, messageId, signal, idempotencyKey, locale }) {
    const c = config as ConnConfig;
    const body = { appId: c.appId, target, message, messageId, idempotencyKey, locale };
    const res = await post(c, "/update", body, signal);
    await res.body?.cancel();
  },
});
