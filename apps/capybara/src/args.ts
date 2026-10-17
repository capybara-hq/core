import { parseArgs } from "node:util";

/** 进程可运行的角色。 */
export const ROLES = ["api", "worker", "gateway"] as const;
export type Role = (typeof ROLES)[number];

/** 解析后的命令行。 */
export type Command =
  | { command: "start"; roles?: Role[] }
  | { command: "migrate" }
  | { command: "admin-create"; login: string; displayName: string; email?: string }
  | { command: "help" };

export const USAGE = `Usage:
  capybara start [--role api,worker,gateway]   Start the kernel (roles override config "roles")
  capybara migrate                             Run kernel and plugin migrations, then exit
  capybara admin create --login <login> --display-name <name> [--email <email>]
                                               Create an enterprise admin; reads the password
                                               (one line) from stdin, e.g.
                                               echo "$PW" | capybara admin create ...
  capybara help                                Show this help`;

/** 命令行参数错误。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** 解析 `capybara <command> [options]`；未知命令、未知选项、缺必填选项或非法角色抛 UsageError。 */
export function parseCli(argv: string[]): Command {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const [command, ...rest] = parsed.positionals;
  const v = parsed.values;
  if (command === undefined || command === "help" || v.help) {
    return { command: "help" };
  }
  if (command === "admin") {
    const [sub, ...extra] = rest;
    if (sub === undefined) throw new UsageError('missing admin command (expected "create")');
    if (sub !== "create") throw new UsageError(`unknown admin command "${sub}"`);
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
    if (v.role !== undefined) throw new UsageError("--role is only valid for start");
    if (v.login === undefined || v.login.trim() === "") throw new UsageError("--login is required");
    if (v["display-name"] === undefined || v["display-name"].trim() === "") {
      throw new UsageError("--display-name is required");
    }
    return {
      command: "admin-create",
      login: v.login,
      displayName: v["display-name"],
      ...(v.email !== undefined && { email: v.email }),
    };
  }
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  for (const opt of ["login", "display-name", "email"] as const) {
    if (v[opt] !== undefined) throw new UsageError(`--${opt} is only valid for admin create`);
  }
  if (command === "migrate") {
    if (parsed.values.role !== undefined) throw new UsageError("--role is only valid for start");
    return { command: "migrate" };
  }
  if (command === "start") {
    const raw = parsed.values.role;
    if (raw === undefined) return { command: "start" };
    const roles = raw
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r !== "");
    if (roles.length === 0) throw new UsageError("--role must list at least one role");
    for (const r of roles) {
      if (!(ROLES as readonly string[]).includes(r)) {
        throw new UsageError(`unknown role "${r}" (expected ${ROLES.join(", ")})`);
      }
    }
    return { command: "start", roles: [...new Set(roles)] as Role[] };
  }
  throw new UsageError(`unknown command "${command}"`);
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    // 刻意不提供 --password：密码只从 stdin 读，避免进 shell 历史与进程列表
    options: {
      role: { type: "string" },
      login: { type: "string" },
      "display-name": { type: "string" },
      email: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}
