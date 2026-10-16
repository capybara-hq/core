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
}

const LONG_POLL_MS = 30_000;
const LISTEN_TIMEOUT_MS = LONG_POLL_MS + 10_000;

function normalizeServer(server: string): string {
  const withScheme = /^https?:\/\//i.test(server) ? server : `http://${server}`;
  return withScheme.replace(/\/+$/, "");
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/** 从 Nacos 读取 YAML 配置并可长轮询监听变更。错误信息含 server 与 dataId，但不含响应体或 YAML 内容。 */
export function createNacosSource(opts: NacosSourceOptions): ConfigSource {
  const server = normalizeServer(opts.server);
  const group = opts.group ?? "DEFAULT_GROUP";
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const backoffMs = opts.backoffMs ?? 1_000;
  const where = `Nacos '${server}' dataId '${opts.dataId}'`;
  /** 最近一次读到的内容 md5：load() 记录，watch() 据此起步，避免漏掉 load 与 watch 之间的变更。 */
  let lastMd5: string | undefined;

  async function fetchText(signal?: AbortSignal): Promise<string> {
    const qs = new URLSearchParams({ dataId: opts.dataId, group, namespaceId: opts.namespace });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${server}/nacos/v2/cs/config?${qs}`, { signal: combined });
    } catch {
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
      res = await doFetch(`${server}/nacos/v1/cs/configs/listener`, {
        method: "POST",
        headers: {
          "Long-Pulling-Timeout": String(LONG_POLL_MS),
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(LISTEN_TIMEOUT_MS)]),
      });
    } catch {
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
