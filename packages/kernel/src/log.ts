import type { Logger } from "@capybara-hq/plugin-sdk";
import { secretScalars } from "./config/fields.js";

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
  /**
   * 登记部署方（运维）给的密钥值：内核配置与插件部署级配置里的 secret 字段。此后日志消息与字段里出现这些值都替换为
   * `[REDACTED]`（顶层的 `ts` / `level` 不打码）。字符串与数字（转成字符串）登记，布尔不登记；
   * 数组与对象递归展开其中的标量；短于 4 个字符的值不登记（会误伤普通文本）。
   * 数值字段的字符串形式等于已登记值时同样打码。
   */
  addSecrets(values: readonly unknown[]): void;
  /**
   * 登记组织级插件配置里的密钥值（来源是组织管理员，不完全可信）：只登记长度 ≥ 12 的值，
   * 放在单独的有界集合里（默认最多 10000 个，满了淘汰最早登记的），防止任一租户用 `info` 这类短值
   * 遮蔽其他租户的日志，也防止集合无限增长；只在字段里打码，不动顶层 `msg`。展开规则同 `addSecrets`。
   */
  addOrgSecrets(values: readonly unknown[]): void;
}

const REDACTED = "[REDACTED]";
const RESERVED = new Set(["ts", "level", "msg"]);
/** 部署方密钥的最短登记长度：过短的值打码会误伤普通文本。 */
const MIN_SECRET_LEN = 4;
/** 组织来源密钥的最短登记长度。 */
const MIN_ORG_SECRET_LEN = 12;
/** 组织来源密钥集合的默认容量。 */
const ORG_SECRET_CAPACITY = 10_000;
/** 匹配器按前缀分桶的前缀长度（不超过两种最短登记长度）。 */
const PREFIX_LEN = MIN_SECRET_LEN;

/**
 * 编译后的打码匹配器：按值的前 `PREFIX_LEN` 个字符分桶，桶内按长度降序。扫描字符串时每个位置查一次桶、
 * 记下最长命中的区间，重叠或相邻的区间合并后替换；开销与字符串长度成正比，与登记的密钥数基本无关。
 */
function compileMatcher(values: Iterable<string>): (s: string) => string {
  const buckets = new Map<string, string[]>();
  for (const v of values) {
    const key = v.slice(0, PREFIX_LEN);
    const b = buckets.get(key);
    if (b) b.push(v);
    else buckets.set(key, [v]);
  }
  if (buckets.size === 0) return (s) => s;
  for (const b of buckets.values()) b.sort((a, c) => c.length - a.length);
  return (s) => {
    if (s.length < PREFIX_LEN) return s;
    // 每个位置都记下最长命中的区间 [i, i + len)，不跳过（否则先开始的密钥会吞掉与之重叠的后一个密钥的开头，
    // 使后者剩余部分明文输出）；重叠或相邻的区间合并后整段替换为一个 [REDACTED]。
    let out = "";
    let last = 0;
    let runStart = -1;
    let runEnd = -1;
    for (let i = 0; i <= s.length - PREFIX_LEN; i++) {
      const b = buckets.get(s.slice(i, i + PREFIX_LEN));
      const hit = b?.find((v) => s.startsWith(v, i));
      if (!hit) continue;
      const end = i + hit.length;
      if (runStart >= 0 && i <= runEnd) {
        if (end > runEnd) runEnd = end;
        continue;
      }
      if (runStart >= 0) {
        out += s.slice(last, runStart) + REDACTED;
        last = runEnd;
      }
      runStart = i;
      runEnd = end;
    }
    if (runStart < 0) return s;
    return out + s.slice(last, runStart) + REDACTED + s.slice(runEnd);
  };
}

/**
 * 用与 logger 相同的匹配器打码任意文本（工具结果等不经过日志的内容用）：登记规则同 `addOrgSecrets`——
 * 只取长度 ≥ 12 的值（Ruling A2），URL 形式的值另登记 `user:password@` 片段。没有可用的值时原样返回。
 */
export function createRedactor(values: readonly unknown[]): (s: string) => string {
  const set = new Set<string>();
  for (const v of secretScalars(values)) {
    for (const s of expandSecret(v)) if (s.length >= MIN_ORG_SECRET_LEN) set.add(s);
  }
  return compileMatcher(set);
}

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
 * 经 `addSecrets` 登记的部署方密钥在消息与字段的任何字符串里都被打码；经 `addOrgSecrets` 登记的组织来源密钥
 * 只在字段里打码，不动顶层 msg；顶层 ts / level 从不打码。
 * `opts.orgSecretCapacity` 为组织来源密钥集合的容量（测试用）；`opts.onMatcherBuild` 在每次重建匹配器时调用（测试用）。
 */
export function createLogger(
  level: string = "info",
  opts: {
    write?: (line: string) => void;
    orgSecretCapacity?: number;
    onMatcherBuild?: () => void;
  } = {},
): KernelLogger {
  let current = parseLevel(level);
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const orgCapacity = opts.orgSecretCapacity ?? ORG_SECRET_CAPACITY;
  /** 部署方密钥（数量由配置决定，不淘汰）。 */
  const secrets = new Set<string>();
  /** 组织来源密钥：Set 保持插入顺序，重复登记时移到末尾，满了从头淘汰（LRU）。 */
  const orgSecrets = new Set<string>();
  /** 字段用：两个集合的并集；任一集合变化后置空，下次打码时重建一次。 */
  let matcher: ((s: string) => string) | undefined;
  /** 顶层 msg 用：只含部署方密钥；部署方集合变化后置空。 */
  let deployMatcher: ((s: string) => string) | undefined;

  const redact = (s: string): string => {
    if (!matcher) {
      matcher = compileMatcher(new Set([...secrets, ...orgSecrets]));
      opts.onMatcherBuild?.();
    }
    return matcher(s);
  };
  /** 顶层 msg 只按部署方密钥打码：组织来源的值不能遮蔽日志消息。 */
  const redactMsg = (s: string): string => {
    if (!deployMatcher) {
      deployMatcher = compileMatcher(secrets);
      opts.onMatcherBuild?.();
    }
    return deployMatcher(s);
  };
  const isSecret = (v: string) => secrets.has(v) || orgSecrets.has(v);

  const serialize = (entry: Record<string, unknown>): string => {
    const seen = new WeakSet<object>();
    return JSON.stringify(entry, function (this: unknown, key, value: unknown) {
      if (this === entry && RESERVED.has(key)) {
        return key === "msg" && typeof value === "string" ? redactMsg(value) : value;
      }
      if (typeof value === "string") return redact(value);
      if ((typeof value === "number" || typeof value === "bigint") && isSecret(String(value))) {
        return REDACTED;
      }
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
      for (const v of secretScalars(values)) {
        for (const s of expandSecret(v)) {
          if (s.length >= MIN_SECRET_LEN && !secrets.has(s)) {
            secrets.add(s);
            matcher = undefined;
            deployMatcher = undefined;
          }
        }
      }
    },
    addOrgSecrets(values) {
      for (const v of secretScalars(values)) {
        for (const s of expandSecret(v)) {
          if (s.length < MIN_ORG_SECRET_LEN) continue;
          if (orgSecrets.has(s)) {
            // 刷新位置，不改变集合内容，无需重建匹配器
            orgSecrets.delete(s);
            orgSecrets.add(s);
            continue;
          }
          orgSecrets.add(s);
          while (orgSecrets.size > orgCapacity) {
            orgSecrets.delete(orgSecrets.values().next().value as string);
          }
          matcher = undefined;
        }
      }
    },
  };
}
