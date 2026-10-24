/**
 * Sandbox contract `sandbox@1`: a single-select, brokered extension point (extensions may not
 * `requires` it; the kernel's `SandboxService` consumes it). The provider implements only the
 * primitives below; the kernel builds `glob` / `grep` / `edit` from `exec` plus `readFile` /
 * `writeFile`.
 */

/** Sandbox extension point ref. */
export const SANDBOX_EXTENSION_POINT = "sandbox@1";

/** 沙箱内允许模型访问的根目录。 */
export const SANDBOX_ROOTS = ["/workspace", "/skills", "/tmp"] as const;

const MAX_PATH_LENGTH = 4096;

/** 沙箱资源与出站限制。 */
export interface SandboxLimits {
  cpu: number;
  memoryMb: number;
  diskMb: number;
  egress: "none" | "allowlist" | "open";
  /** 出站白名单（`egress` 为 `allowlist` 时生效）；每项须通过 {@link validateAllowHost}。 */
  allowHosts: string[];
}

/** 提供方的实例句柄。 */
export interface SandboxHandle {
  /** 提供方的实例 id。 */
  id: string;
}

/** 命令执行结果。 */
export interface ExecResult {
  /** 超时或在执行中被中止为 null（此时 `timedOut` 分别为 true / false）。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * 实例在提供方那边确定已经不在了（容器被删、E2B 沙箱过期）。`exec` / `readFile` / `writeFile` / `stat`
 * 发现实例不在时必须抛它（而不是普通 Error），内核据此重建沙箱并重试一次；只是暂时连不上时抛普通错误。
 */
export class SandboxGoneError extends Error {
  readonly sandboxGone = true as const;

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "SandboxGoneError";
  }
}

/** 鸭子类型判断（不用 instanceof），兼容插件自带另一份 plugin-sdk 副本的情况。 */
export function isSandboxGoneError(e: unknown): e is SandboxGoneError {
  return (
    e instanceof Error &&
    e.name === "SandboxGoneError" &&
    (e as { sandboxGone?: unknown }).sandboxGone === true
  );
}

/**
 * `sandbox@1` 的实现（由沙箱插件提供，如 Docker、E2B）。
 * 实例确定不在时：`resume` 返回 `gone`；`exec` / `readFile` / `writeFile` / `stat` 抛 {@link SandboxGoneError}；
 * `suspend` / `destroy` 照常成功。
 *
 * **自动启动**：实例还在、但已停止 / 暂停（被内核之外的原因停掉：宿主机重启、守护进程重启、沙箱里的进程把
 * 自己的 init 弄停了、休眠扫描停了实例却没来得及记下 `suspended`……）时，`exec` / `readFile` / `writeFile` /
 * `stat` 必须先透明地把它启动起来（同 `resume`，文件保留）再执行，而不是报错——内核只信自己记的 `running`。
 *
 * **命令时限在沙箱里也要生效**：`exec` 除了在提供方这边按 `timeoutMs` 停掉命令，还必须让沙箱里的命令自己在
 * `timeoutMs` 之后不久（几秒的余量）被杀掉。内核副本崩溃时提供方这边的计时随之消失，断开连接也不会结束命令；
 * 沙箱里的时限保证它不会无限期地与下一个持锁方的命令同时运行。
 *
 * **中止**：每个方法都必须及时响应 `signal`（已中止就立即失败，进行中被中止就尽快以中止原因结束）——内核在锁丢失、
 * 运行被中止或超时时靠它停下，不响应就可能与新的持锁方同时操作同一实例。`exec` 被中止时必须杀掉正在跑的命令
 * （连同它派生的进程），而不只是不再等待它的输出；命令启动后才被中止的 `exec` 以 `exitCode: null`、
 * `timedOut: false` 正常 resolve（带上已收集的输出），不 reject。调用时 signal 已中止则立即 reject。
 */
export interface SandboxProvider {
  /** `name` 形如 `cap-<conversationId>`。 */
  create(args: {
    name: string;
    image: string;
    limits: SandboxLimits;
    signal: AbortSignal;
  }): Promise<SandboxHandle>;
  /** `gone` 表示提供方那边已经没有这个实例。 */
  resume(h: SandboxHandle, signal: AbortSignal): Promise<"resumed" | "gone">;
  /** 文件必须保留。实例不存在也算成功。 */
  suspend(h: SandboxHandle, signal: AbortSignal): Promise<void>;
  /** 不存在也算成功。 */
  destroy(h: SandboxHandle, signal: AbortSignal): Promise<void>;
  /**
   * 可选：按 `create` 时的 `name`（`cap-<conversationId>`）销毁实例，不存在也算成功。
   * 内核在拿不到句柄时用它清理（例如 `create` 已在提供方那边完成、内核却在记下句柄前退出）。
   */
  destroyByName?(name: string, signal: AbortSignal): Promise<void>;
  /**
   * 可选：杀掉这个实例里经 `exec` 启动、仍在运行的全部命令（连同它们派生的、没有自己另起会话的进程）。
   * 内核在接手一个前任持锁方没有正常结束的沙箱（前任崩溃）时、第一次执行前调用，清掉前任遗留的命令；
   * 命令自己放到后台、另起会话的进程不保证被杀。实例已停止时同样先启动；不在时抛 {@link SandboxGoneError}。
   */
  killAll?(h: SandboxHandle, signal: AbortSignal): Promise<void>;
  /**
   * 执行一条命令。`maxOutputBytes` 是 stdout 与 stderr **合计**最多收集的字节，超出的丢弃、`truncated` 为 true。
   */
  exec(
    h: SandboxHandle,
    args: {
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
      signal: AbortSignal;
    },
  ): Promise<ExecResult>;
  /** 读文件（最多 `maxBytes` 字节，更长的截断、`truncated` 为 true）。不存在、或是目录时返回 null。 */
  readFile(
    h: SandboxHandle,
    path: string,
    opts: { maxBytes: number; signal: AbortSignal },
  ): Promise<{ data: Uint8Array; truncated: boolean } | null>;
  /** 父目录自动创建。 */
  writeFile(h: SandboxHandle, path: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  stat(
    h: SandboxHandle,
    path: string,
    signal: AbortSignal,
  ): Promise<{ size: number; isDir: boolean } | null>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦控制字符
const CONTROL = /[\u0000-\u001f\u007f]/;

/** 校验沙箱内路径：返回错误列表，空数组表示合法。 */
export function validateSandboxPath(p: string): string[] {
  if (typeof p !== "string" || p.length === 0) return ["path must be a non-empty string"];
  if (p.length > MAX_PATH_LENGTH) return [`path must be at most ${MAX_PATH_LENGTH} characters`];
  if (CONTROL.test(p)) return ["path must not contain control characters"];
  if (p.includes("\\")) return ["path must not contain backslashes"];
  if (!p.startsWith("/")) return ["path must be absolute"];
  if (p.includes("//")) return ["path must not contain empty segments"];
  const errors: string[] = [];
  for (const seg of p.split("/")) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // 非法百分号编码按字面处理
    }
    if (seg === ".." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      errors.push("path must not contain '..' segments");
      break;
    }
  }
  if (!SANDBOX_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) {
    errors.push(`path must be under ${SANDBOX_ROOTS.join(", ")}`);
  }
  return errors;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** 校验出站白名单主机名：小写、无协议与端口、可选前导 `*.`、IDN 只认 punycode。 */
export function validateAllowHost(h: string): string[] {
  if (typeof h !== "string" || h.length === 0) return ["host must be a non-empty string"];
  if (h.length > 253) return ["host must be at most 253 characters"];
  const name = h.startsWith("*.") ? h.slice(2) : h;
  if (name.length === 0) return ["wildcard must be followed by a domain"];
  const labels = name.split(".");
  if (labels.every((l) => LABEL.test(l))) {
    const tld = labels[labels.length - 1] as string;
    if (labels.length < 2) return ["host must have at least two labels (no single-label names)"];
    // 末段必须以字母开头：挡住 IPv4 的十进制 / 八进制 / 十六进制写法
    if (!/^[a-z]/.test(tld)) return ["host must not be an IP address literal"];
    if (["local", "internal", "localhost"].includes(tld)) {
      return ["host must not be in an internal-only domain (.local, .internal, .localhost)"];
    }
    return [];
  }
  return [
    "host must be a lowercase hostname without scheme, port or path (optional leading '*.'; IDN as punycode)",
  ];
}
