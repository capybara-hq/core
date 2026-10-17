import { parseArgs } from "node:util";

/** 进程可运行的角色。 */
export const ROLES = ["api", "worker", "gateway"] as const;
export type Role = (typeof ROLES)[number];

/** 解析后的命令行。 */
export type Command =
  | { command: "start"; roles?: Role[] }
  | { command: "migrate" }
  | { command: "help" };

export const USAGE = `Usage:
  capybara start [--role api,worker,gateway]   Start the kernel (roles override config "roles")
  capybara migrate                             Run kernel and plugin migrations, then exit
  capybara help                                Show this help`;

/** 命令行参数错误。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** 解析 `capybara <command> [options]`；未知命令、未知选项或非法角色抛 UsageError。 */
export function parseCli(argv: string[]): Command {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const [command, ...rest] = parsed.positionals;
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  if (command === undefined || command === "help" || parsed.values.help) {
    return { command: "help" };
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
    options: { role: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
}
