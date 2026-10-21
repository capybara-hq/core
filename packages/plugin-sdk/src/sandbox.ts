/**
 * 沙箱契约 `sandbox@1`：单选、中转能力（插件不得 `requires`，由内核 `SandboxService` 取用）。
 * 提供方只实现下面的原语；`glob` / `grep` / `edit` 由内核用 `exec` 加 `readFile` / `writeFile` 组合。
 */

/** 沙箱能力引用。 */
export const SANDBOX_CAPABILITY = "sandbox@1";

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
  /** 超时或被中止为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/** `sandbox@1` 的实现（由沙箱插件提供，如 Docker、E2B）。 */
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
  /** 文件必须保留。 */
  suspend(h: SandboxHandle, signal: AbortSignal): Promise<void>;
  /** 不存在也算成功。 */
  destroy(h: SandboxHandle, signal: AbortSignal): Promise<void>;
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
  if (labels.every((l) => LABEL.test(l))) return [];
  return [
    "host must be a lowercase hostname without scheme, port or path (optional leading '*.'; IDN as punycode)",
  ];
}
