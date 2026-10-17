import { createHash } from "node:crypto";
import { setTimeout as sleepFor } from "node:timers/promises";
import { parse, YAMLParseError } from "yaml";
import { ConfigError, type ConfigSource } from "./types.js";

/** Nacos 配置来源的参数。 */
export interface NacosSourceOptions {
  server: string;
  namespace: string;
  dataId: string;
  /** 默认 `DEFAULT_GROUP`。 */
  group?: string;
  fetch?: typeof fetch;
  /** 单次读取配置的超时，默认 10000ms；超时抛 ConfigError（启动快速失败）。 */
  timeoutMs?: number;
  /** watch 出错后的退避间隔，默认 1000ms。 */
  backoffMs?: number;
  /**
   * Nacos 开启鉴权时的凭据：
   * - 用户名密码：先 `POST /nacos/v1/auth/login` 换取 accessToken，用到 `tokenTtl` 的 80% 后（或请求收到 403 时）重新登录；
   * - accessToken：直接使用，不调用登录接口（收到 403 即报错）。
   * 令牌以 `accessToken` 查询参数随每个配置 / 监听请求发送。
   */
  auth?: { username: string; password: string } | { accessToken: string };
}

const LONG_POLL_MS = 30_000;
/** 在令牌有效期的这个比例处续期。 */
const TOKEN_RENEW_RATIO = 0.8;
/** 登录响应缺少 tokenTtl 时假定的有效期（Nacos 默认 18000s）。 */
const DEFAULT_TOKEN_TTL_S = 18_000;
const LISTEN_TIMEOUT_MS = LONG_POLL_MS + 10_000;

function normalizeServer(server: string): string {
  const withScheme = /^https?:\/\//i.test(server) ? server : `http://${server}`;
  return withScheme.replace(/\/+$/, "");
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/**
 * 从 Nacos 读取 YAML 配置并可长轮询监听变更。错误信息含 server 与 dataId，但不含响应体、YAML 内容或凭据。
 * 鉴权见 `NacosSourceOptions.auth`：令牌按需续期（每次请求前检查是否到了续期时刻），不起定时器。
 */
export function createNacosSource(opts: NacosSourceOptions): ConfigSource {
  const server = normalizeServer(opts.server);
  const group = opts.group ?? "DEFAULT_GROUP";
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const backoffMs = opts.backoffMs ?? 1_000;
  const where = `Nacos '${server}' dataId '${opts.dataId}'`;
  /** 最近一次读到的内容 md5：load() 记录，watch() 据此起步，避免漏掉 load 与 watch 之间的变更。 */
  let lastMd5: string | undefined;

  const auth = opts.auth;
  /** 用户名密码方式登录得到的令牌与应续期的时刻。 */
  let token: { value: string; renewAt: number } | undefined;
  /** 进行中的登录：并发请求共享同一次登录。 */
  let loggingIn: Promise<string> | undefined;

  /**
   * 用户名密码登录，返回 accessToken。错误信息含 server，不含凭据与响应体。
   * 只受自身超时约束、不接调用方的中止信号：并发请求共享同一次登录，不能因其中一个调用方取消而让其他调用方失败。
   */
  async function login(creds: { username: string; password: string }): Promise<string> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const failed = (why: string) => new ConfigError(`Nacos '${server}' login failed: ${why}`);
    let res: Response;
    try {
      res = await doFetch(`${server}/nacos/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: creds.username, password: creds.password }),
        signal: timeout,
      });
    } catch {
      throw failed(timeout.aborted ? `timed out after ${timeoutMs}ms` : "cannot reach server");
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw failed(`HTTP ${res.status}`);
    }
    let body: { accessToken?: unknown; tokenTtl?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw failed("non-JSON response");
    }
    if (typeof body.accessToken !== "string" || body.accessToken === "") {
      throw failed("response has no accessToken");
    }
    const ttlS =
      typeof body.tokenTtl === "number" && body.tokenTtl > 0 ? body.tokenTtl : DEFAULT_TOKEN_TTL_S;
    token = { value: body.accessToken, renewAt: Date.now() + ttlS * 1000 * TOKEN_RENEW_RATIO };
    return body.accessToken;
  }

  /** 当前可用的令牌：无鉴权返回 undefined；用户名密码方式在未登录、到续期时刻或 `force` 时重新登录。 */
  async function accessToken(force = false): Promise<string | undefined> {
    if (!auth) return undefined;
    if ("accessToken" in auth) return auth.accessToken;
    if (!force && token && Date.now() < token.renewAt) return token.value;
    loggingIn ??= login(auth).finally(() => {
      loggingIn = undefined;
    });
    return loggingIn;
  }

  /**
   * 带令牌发请求：`accessToken` 作为查询参数附加到 URL。用户名密码方式收到 403 时重新登录并重试一次。
   * 网络错误原样抛出（由调用方转成带上下文的 ConfigError）。
   */
  async function authedFetch(url: string, init: RequestInit): Promise<Response> {
    const withToken = (t: string | undefined) =>
      t === undefined
        ? url
        : `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams({ accessToken: t })}`;
    const sent = await accessToken();
    const res = await doFetch(withToken(sent), init);
    if (res.status !== 403 || !auth || !("username" in auth)) return res;
    await res.body?.cancel().catch(() => {});
    // 别的并发请求可能已换了新令牌：直接用新的；否则强制重新登录
    const fresh = token && token.value !== sent ? token.value : await accessToken(true);
    return doFetch(withToken(fresh), init);
  }

  async function fetchText(signal?: AbortSignal): Promise<string> {
    const qs = new URLSearchParams({ dataId: opts.dataId, group, namespaceId: opts.namespace });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await authedFetch(`${server}/nacos/v2/cs/config?${qs}`, { signal: combined });
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      if (timeout.aborted) throw new ConfigError(`${where} timed out after ${timeoutMs}ms`);
      throw new ConfigError(`cannot reach ${where}`);
    }
    if (res.status !== 200) {
      throw new ConfigError(`${where} returned HTTP ${res.status}`);
    }
    let body: { code?: unknown; data?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      if (timeout.aborted) throw new ConfigError(`${where} timed out after ${timeoutMs}ms`);
      throw new ConfigError(`${where} returned a non-JSON response`);
    }
    if (body.code !== 0 || typeof body.data !== "string") {
      throw new ConfigError(`${where} returned no config content (code ${String(body.code)})`);
    }
    return body.data;
  }

  function parseYaml(text: string): unknown {
    try {
      return parse(text) ?? {};
    } catch (e) {
      if (e instanceof YAMLParseError) {
        const pos = e.linePos?.[0];
        const at = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
        throw new ConfigError(`invalid YAML from ${where}${at}`);
      }
      throw new ConfigError(`invalid YAML from ${where}`);
    }
  }

  async function listen(md5Sent: string, signal: AbortSignal): Promise<boolean> {
    const entry = [opts.dataId, group, md5Sent, opts.namespace].join("\u0002");
    const body = new URLSearchParams({ "Listening-Configs": `${entry}\u0001` });
    let res: Response;
    try {
      res = await authedFetch(`${server}/nacos/v1/cs/configs/listener`, {
        method: "POST",
        headers: {
          "Long-Pulling-Timeout": String(LONG_POLL_MS),
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(LISTEN_TIMEOUT_MS)]),
      });
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`cannot reach ${where} (listener)`);
    }
    if (res.status !== 200) throw new ConfigError(`${where} listener returned HTTP ${res.status}`);
    return (await res.text()).trim().length > 0;
  }

  return {
    async load(): Promise<unknown> {
      const text = await fetchText();
      lastMd5 = md5(text);
      return parseYaml(text);
    },

    watch(onChange, onError): () => void {
      const ac = new AbortController();
      const report = (e: unknown): void => {
        if (ac.signal.aborted) return;
        const err = e instanceof ConfigError ? e : new ConfigError(`watch failed for ${where}`);
        try {
          onError?.(err);
        } catch {
          // 错误回调自身的异常不能打断监听循环
        }
      };
      void (async () => {
        while (!ac.signal.aborted) {
          try {
            if (lastMd5 === undefined) lastMd5 = md5(await fetchText(ac.signal));
            if (!(await listen(lastMd5, ac.signal))) continue;
            const text = await fetchText(ac.signal);
            const next = md5(text);
            if (next === lastMd5) continue;
            lastMd5 = next;
            const raw = parseYaml(text);
            if (ac.signal.aborted) return;
            try {
              onChange(raw);
            } catch (e) {
              throw new ConfigError(
                `onChange handler failed for ${where}: ${e instanceof Error ? e.name : "error"}`,
              );
            }
          } catch (e) {
            if (ac.signal.aborted) return;
            report(e);
            try {
              await sleepFor(backoffMs, undefined, { signal: ac.signal });
            } catch {
              return;
            }
          }
        }
      })();
      return () => ac.abort();
    },
  };
}
