import { createHash } from "node:crypto";
import { parse, YAMLParseError } from "yaml";
import { ConfigError, type ConfigSource } from "./load.js";

/** Nacos 配置来源的参数。 */
export interface NacosSourceOptions {
  server: string;
  namespace: string;
  dataId: string;
  /** 默认 `DEFAULT_GROUP`。 */
  group?: string;
  fetch?: typeof fetch;
}

const LONG_POLL_MS = 30_000;
const BACKOFF_MS = 1_000;

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
  const where = `Nacos '${server}' dataId '${opts.dataId}'`;

  async function fetchText(signal?: AbortSignal): Promise<string> {
    const qs = new URLSearchParams({
      dataId: opts.dataId,
      group,
      namespaceId: opts.namespace,
    });
    let res: Response;
    try {
      res = await doFetch(`${server}/nacos/v2/cs/config?${qs}`, signal ? { signal } : {});
    } catch {
      throw new ConfigError(`cannot reach ${where}`);
    }
    if (res.status !== 200) {
      throw new ConfigError(`${where} returned HTTP ${res.status}`);
    }
    let body: { code?: unknown; data?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
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

  async function listen(lastMd5: string, signal: AbortSignal): Promise<boolean> {
    const entry = [opts.dataId, group, lastMd5, opts.namespace].join("\u0002");
    const body = new URLSearchParams({ "Listening-Configs": `${entry}\u0001` });
    const res = await doFetch(`${server}/nacos/v1/cs/configs/listener`, {
      method: "POST",
      headers: {
        "Long-Pulling-Timeout": String(LONG_POLL_MS),
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      signal,
    });
    if (res.status !== 200) throw new Error(`listener HTTP ${res.status}`);
    return (await res.text()).trim().length > 0;
  }

  return {
    async load(): Promise<unknown> {
      return parseYaml(await fetchText());
    },

    watch(onChange: (raw: unknown) => void): () => void {
      const ac = new AbortController();
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          ac.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      void (async () => {
        let lastMd5: string | undefined;
        while (!ac.signal.aborted) {
          try {
            if (lastMd5 === undefined) {
              lastMd5 = md5(await fetchText(ac.signal));
            }
            const changed = await listen(lastMd5, ac.signal);
            if (!changed) continue;
            const text = await fetchText(ac.signal);
            lastMd5 = md5(text);
            if (ac.signal.aborted) return;
            onChange(parseYaml(text));
          } catch {
            if (ac.signal.aborted) return;
            await sleep(BACKOFF_MS);
          }
        }
      })();
      return () => ac.abort();
    },
  };
}
