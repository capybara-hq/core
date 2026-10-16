import type { Logger } from "@capybara-hq/plugin-sdk";

/** 日志级别，按严重程度递增。 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const LEVELS = LOG_LEVELS;
/** 日志级别。 */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 内核 logger：在插件 Logger 之上增加 debug、运行时改级别与登记需打码的密钥值。 */
export interface KernelLogger extends Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  readonly level: LogLevel;
  /** 修改级别；非法级别抛错且保持原级别。 */
  setLevel(level: string): void;
  /** 登记密钥值：此后任何日志的消息与字段里出现这些值都替换为 `[REDACTED]`。 */
  addSecrets(values: string[]): void;
}

const REDACTED = "[REDACTED]";
const RESERVED = new Set(["ts", "level", "msg"]);
/** 过短的值打码会误伤普通文本，不予登记。 */
const MIN_SECRET_LEN = 4;

function isLevel(v: string): v is LogLevel {
  return (LEVELS as readonly string[]).includes(v);
}

function parseLevel(v: string): LogLevel {
  if (!isLevel(v)) throw new Error(`invalid log level "${v}" (expected ${LEVELS.join(", ")})`);
  return v;
}

/**
 * URL 形式的密钥（连接串）另外登记 `user:password@` 片段：同一凭据可能以别的 host / 参数出现。
 * 不单独登记裸密码——开发环境常见「密码 = 用户名 = 库名 = schema 名」，会把正常字段全部打码。
 */
function expandSecret(value: string): string[] {
  const out = [value];
  try {
    const u = new URL(value);
    if (u.password) out.push(`${u.username}:${u.password}@`);
  } catch {
    // 不是 URL
  }
  return out;
}

/**
 * 创建结构化 JSON logger：每条日志写一行 `{ ts, level, msg, ...fields }`。
 * 字段不能覆盖 ts / level / msg；Error 序列化为 name / message / stack；
 * 经 `addSecrets` 登记的值在整行任何字符串里都被打码。
 */
export function createLogger(
  level: string = "info",
  opts: { write?: (line: string) => void } = {},
): KernelLogger {
  let current = parseLevel(level);
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const secrets = new Set<string>();

  const redact = (s: string): string => {
    let out = s;
    // 长的先替换，避免短值（如密码）先替换后长值（整串）匹配不上
    for (const v of [...secrets].sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.replaceAll(v, REDACTED);
    }
    return out;
  };

  const serialize = (entry: Record<string, unknown>): string => {
    const seen = new WeakSet<object>();
    return JSON.stringify(entry, (_key, value: unknown) => {
      if (typeof value === "string") return redact(value);
      if (value instanceof Error) {
        const e: Record<string, unknown> = {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
        if (value.cause !== undefined) e.cause = value.cause;
        return e;
      }
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  };

  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS.indexOf(lvl) < LEVELS.indexOf(current)) return;
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), level: lvl, msg };
    for (const [k, v] of Object.entries(fields ?? {})) if (!RESERVED.has(k)) entry[k] = v;
    let line: string;
    try {
      line = serialize(entry);
    } catch {
      line = serialize({ ts: entry.ts, level: lvl, msg, logError: "unserializable fields" });
    }
    write(line);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    get level() {
      return current;
    },
    setLevel(l) {
      current = parseLevel(l);
    },
    addSecrets(values) {
      for (const v of values) {
        for (const s of expandSecret(v)) if (s.length >= MIN_SECRET_LEN) secrets.add(s);
      }
    },
  };
}
