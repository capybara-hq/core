import type { InjectOptions, LightMyRequestResponse } from "fastify";
import type { KernelHttp } from "../../src/http/app.js";

/** 极简 Cookie 罐：从响应的 `set-cookie` 收集，生成请求的 `cookie` 头（不区分 Path，测试够用）。 */
export interface CookieJar {
  /** 收下响应里的 `set-cookie`；过期 / `Max-Age=0` / 空值视为删除。 */
  store(res: LightMyRequestResponse): void;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  /** `cookie` 请求头；罐空时为 undefined。 */
  header(): string | undefined;
  /** 复制一份独立的罐（模拟另一台设备持有旧 Cookie）。 */
  clone(): CookieJar;
}

/** 解析出的一条 `set-cookie`。 */
export interface SetCookie {
  name: string;
  value: string;
  /** 小写属性名 → 值（无值属性为 `true`）。 */
  attrs: Record<string, string | true>;
  raw: string;
}

/** 解析响应的全部 `set-cookie` 头。 */
export function setCookies(res: LightMyRequestResponse): SetCookie[] {
  const h = res.headers["set-cookie"];
  const list = h === undefined ? [] : Array.isArray(h) ? h : [String(h)];
  return list.map((raw) => {
    const [pair = "", ...rest] = raw.split(";");
    const eq = pair.indexOf("=");
    const attrs: Record<string, string | true> = {};
    for (const a of rest) {
      const i = a.indexOf("=");
      if (i < 0) attrs[a.trim().toLowerCase()] = true;
      else attrs[a.slice(0, i).trim().toLowerCase()] = a.slice(i + 1).trim();
    }
    return {
      name: pair.slice(0, eq).trim(),
      value: decodeURIComponent(pair.slice(eq + 1).trim()),
      attrs,
      raw,
    };
  });
}

export function cookieJar(initial: Record<string, string> = {}): CookieJar {
  const m = new Map(Object.entries(initial));
  const jar: CookieJar = {
    store(res) {
      for (const c of setCookies(res)) {
        const expires = typeof c.attrs.expires === "string" ? Date.parse(c.attrs.expires) : NaN;
        const removed =
          c.value === "" ||
          c.attrs["max-age"] === "0" ||
          (!Number.isNaN(expires) && expires <= Date.now());
        if (removed) m.delete(c.name);
        else m.set(c.name, c.value);
      }
    },
    get: (name) => m.get(name),
    set: (name, value) => {
      m.set(name, value);
    },
    delete: (name) => {
      m.delete(name);
    },
    header: () =>
      m.size === 0 ? undefined : [...m].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "),
    clone: () => cookieJar(Object.fromEntries(m)),
  };
  return jar;
}

/** `asUser` 返回的请求函数的选项：`csrf: false` 时不带 `X-Capybara-Csrf` 头。 */
export type UserRequest = InjectOptions & { csrf?: boolean };

/**
 * 以 Cookie 罐身份发请求：自动带上 `cookie` 头与 `X-Capybara-Csrf: 1`（`csrf: false` 关闭），
 * 并把响应里的 `set-cookie` 收进罐里。
 */
export function asUser(
  http: KernelHttp,
  jar: CookieJar,
): (opts: UserRequest) => Promise<LightMyRequestResponse> {
  return async ({ csrf = true, ...opts }) => {
    const cookie = jar.header();
    const res = await http.inject({
      ...opts,
      headers: {
        ...(cookie !== undefined && { cookie }),
        ...(csrf && { "x-capybara-csrf": "1" }),
        ...(opts.headers as Record<string, string> | undefined),
      },
    });
    jar.store(res);
    return res;
  };
}
