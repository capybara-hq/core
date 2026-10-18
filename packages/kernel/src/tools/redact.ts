import type { AuthInjection } from "@capybara-hq/plugin-sdk";
import { createRedactor } from "../log.js";

/**
 * 工具结果打码（Review Focus 3）：远端服务可能把收到的凭据回显在结果或错误里，而工具结果会进事件日志、
 * 工具输出存档并发给模型。管线在写入之前，用「本次调用实际注入的凭据」打码——值是精确已知的（不依赖进程内
 * logger 的打码集合，多副本下同样成立），匹配器与 logger 共用（`createRedactor`，只取长度 ≥ 12 的值，Ruling A2）。
 */

const SCHEME = /^(?:Bearer|Basic|Token)\s+(.+)$/i;

/** 一次注入里可能被回显的凭据值：头 / query 的值，`<scheme> <token>` 里的 token，Basic 解码后的串与密码。 */
export function injectionSecrets(inj: AuthInjection): string[] {
  const out: string[] = [];
  for (const v of [...Object.values(inj.headers), ...Object.values(inj.query ?? {})]) {
    out.push(v);
    const m = SCHEME.exec(v);
    if (!m) continue;
    const token = m[1] as string;
    out.push(token);
    if (/^basic\s/i.test(v)) {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      out.push(decoded);
      const i = decoded.indexOf(":");
      if (i >= 0) out.push(decoded.slice(i + 1));
    }
  }
  return out;
}

/** 递归替换值里所有字符串（对象键不动）。 */
export function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, redact);
    return out;
  }
  return value;
}

/** 由若干次注入构造打码函数。 */
export function redactorFor(injections: readonly AuthInjection[]): (s: string) => string {
  return createRedactor(injections.flatMap(injectionSecrets));
}
