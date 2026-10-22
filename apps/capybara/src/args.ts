import { parseArgs } from "node:util";

/** 进程可运行的角色。 */
export const ROLES = ["api", "worker", "gateway"] as const;
export type Role = (typeof ROLES)[number];

/** 解析后的命令行。 */
export type Command =
  | { command: "start"; roles?: Role[] }
  | { command: "migrate" }
  | { command: "admin-create"; login: string; displayName: string; email?: string }
  | { command: "admin-grant"; login: string; grant: boolean }
  | { command: "plugins-review" }
  | { command: "plugins-approve"; name: string; yes: boolean }
  | { command: "plugins-list" }
  | { command: "plugins-install"; target: string; yes: boolean }
  | { command: "plugins-state"; name: string; action: "enable" | "disable" | "uninstall" }
  | { command: "help" };

export const USAGE = `Usage:
  capybara start [--role api,worker,gateway]   Start the kernel (roles override config "roles")
  capybara migrate                             Run kernel and plugin migrations, then exit
  capybara admin create --login <login> --display-name <name> [--email <email>]
                                               Create an enterprise admin; reads the password
                                               (one line) from stdin, e.g.
                                               echo "$PW" | capybara admin create ...
  capybara admin grant <login>                 Make a local account an enterprise admin
  capybara admin revoke <login>                Revoke enterprise admin from a local account
                                               (the last active one cannot be revoked)
  capybara plugins list                        List the deployment's plugins and their status
  capybara plugins install <file.tgz | npm:<name>[@<version>]> [--yes]
                                               Store a plugin package (in PostgreSQL), show its
                                               permission review and install it or switch to
                                               that version (asks for confirmation unless
                                               --yes); a new install starts disabled
  capybara plugins enable <name>               Enable an installed plugin on the deployment
  capybara plugins disable <name>              Disable an installed plugin on the deployment
  capybara plugins uninstall <name>            Remove a disabled plugin's install record (its
                                               data is kept)
  capybara plugins review                      List plugins awaiting permission approval and
                                               the permissions they add (runs kernel
                                               migrations first)
  capybara plugins approve <name> [--yes]      Approve a plugin's current permissions (asks for
                                               confirmation unless --yes)
                                               The plugins commands write PostgreSQL, then
                                               notify running replicas over Redis (they apply
                                               the change without a restart)
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
  if (command !== "plugins" && v.yes !== undefined) {
    throw new UsageError("--yes is only valid for plugins approve and plugins install");
  }
  if (command === "plugins") {
    const [sub, ...args] = rest;
    const subs = ["list", "install", "enable", "disable", "uninstall", "review", "approve"];
    if (sub === undefined) {
      throw new UsageError(`missing plugins command (expected one of ${subs.join(", ")})`);
    }
    if (!subs.includes(sub)) {
      throw new UsageError(`unknown plugins command "${sub}"`);
    }
    if (v.role !== undefined) throw new UsageError("--role is only valid for start");
    for (const opt of ["login", "display-name", "email"] as const) {
      if (v[opt] !== undefined) throw new UsageError(`--${opt} is only valid for admin create`);
    }
    if (sub !== "approve" && sub !== "install" && v.yes !== undefined) {
      throw new UsageError("--yes is only valid for plugins approve and plugins install");
    }
    if (sub === "review" || sub === "list") {
      if (args.length > 0) throw new UsageError(`unexpected argument "${args[0]}"`);
      return { command: sub === "review" ? "plugins-review" : "plugins-list" };
    }
    const [name, ...extra] = args;
    if (name === undefined || name.trim() === "") {
      throw new UsageError(
        sub === "install"
          ? "plugins install needs a package (<file.tgz> or npm:<name>[@<version>])"
          : `plugins ${sub} needs a plugin name`,
      );
    }
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
    if (sub === "install") return { command: "plugins-install", target: name, yes: v.yes === true };
    if (sub === "approve") return { command: "plugins-approve", name, yes: v.yes === true };
    return { command: "plugins-state", name, action: sub as "enable" | "disable" | "uninstall" };
  }
  if (command === "admin") {
    const [sub, ...extra] = rest;
    if (sub === undefined) {
      throw new UsageError("missing admin command (expected one of create, grant, revoke)");
    }
    if (sub !== "create" && sub !== "grant" && sub !== "revoke") {
      throw new UsageError(`unknown admin command "${sub}"`);
    }
    if (v.role !== undefined) throw new UsageError("--role is only valid for start");
    if (sub === "grant" || sub === "revoke") {
      for (const opt of ["login", "display-name", "email"] as const) {
        if (v[opt] !== undefined) throw new UsageError(`--${opt} is only valid for admin create`);
      }
      const [login, ...more] = extra;
      if (login === undefined || login.trim() === "") {
        throw new UsageError(`admin ${sub} needs a login`);
      }
      if (more.length > 0) throw new UsageError(`unexpected argument "${more[0]}"`);
      return { command: "admin-grant", login, grant: sub === "grant" };
    }
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
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
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
}
