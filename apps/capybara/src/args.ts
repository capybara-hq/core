import { parseArgs } from "node:util";

/** 进程可运行的角色。 */
export const ROLES = ["api", "worker", "gateway"] as const;
export type Role = (typeof ROLES)[number];

/** 解析后的命令行。 */
export type Command =
  | { command: "start"; roles?: Role[] }
  | { command: "migrate" }
  | { command: "bootstrap"; dir?: string; manifest?: string }
  | {
      command: "admin-create";
      login: string;
      displayName: string;
      email?: string;
      /** Skip (exit 0) when an active enterprise admin already exists. */
      ifNone: boolean;
      /** Read the password from this file instead of stdin. */
      passwordFile?: string;
    }
  | { command: "admin-grant"; login: string; grant: boolean }
  | { command: "extensions-review" }
  | { command: "extensions-approve"; name: string; yes: boolean }
  | { command: "extensions-list" }
  | { command: "extensions-install"; target: string; yes: boolean }
  | { command: "extensions-state"; name: string; action: "enable" | "disable" | "uninstall" }
  | { command: "plugins-list" }
  | { command: "plugins-import"; target: string; yes: boolean; deployExtension: boolean }
  | { command: "help" };

export const USAGE = `Usage:
  capybara start [--role api,worker,gateway]   Start the kernel (roles override config "roles");
                                               runs the bootstrap step first unless it is done
  capybara migrate                             Run kernel and plugin migrations, then exit
  capybara bootstrap [--dir <path>] [--manifest <path>]
                                               Install the plugins bootstrap.json pins: a .tgz in
                                               --dir (default config bootstrap.dir, ./bootstrap)
                                               with the pinned sha512, else downloaded from
                                               packages.npmRegistry; --manifest replaces the
                                               bootstrap.json shipped with the kernel. Done once
                                               per manifest: a re-run does nothing
  capybara admin create --login <login> --display-name <name> [--email <email>]
                         [--if-none] [--password-file <path>]
                                               Create an enterprise admin; reads the password
                                               (one line) from stdin, e.g.
                                               echo "$PW" | capybara admin create ...
                                               --password-file reads it from a file instead
                                               (a trailing newline is stripped); --if-none
                                               exits 0 without changes when an active
                                               enterprise admin already exists
  capybara admin grant <login>                 Make a local account an enterprise admin
  capybara admin revoke <login>                Revoke enterprise admin from a local account
                                               (the last active one cannot be revoked)
  capybara extensions list                     List the deployment's extensions and their status
  capybara extensions install <file.tgz | npm:<name>[@<version>]> [--yes]
                                               Store an extension package (in PostgreSQL), show its
                                               permission review and install it or switch to
                                               that version (asks for confirmation unless
                                               --yes); a new install starts disabled
  capybara extensions enable <name>            Enable an installed extension on the deployment
  capybara extensions disable <name>           Disable an installed extension on the deployment
  capybara extensions uninstall <name>         Remove a disabled extension's install record (its
                                               data is kept)
  capybara extensions review                   List extensions awaiting permission approval and
                                               the permissions they add (runs kernel
                                               migrations first)
  capybara extensions approve <name> [--yes]   Approve an extension's current permissions (asks for
                                               confirmation unless --yes)
                                               The extensions commands write PostgreSQL, then
                                               notify running replicas over Redis (they apply
                                               the change without a restart)
  capybara plugins list                        List the plugins in the catalog (latest version,
                                               components, policy)
  capybara plugins import <file.tgz | npm:<name>[@<version>] | git:<url>[#<ref>][:<path>]>
                    [--deploy-extension] [--yes]
                                               Import a plugin into the catalog: shows the review
                                               (source, content digest, provenance, extension
                                               permissions, skills, connector templates,
                                               dependencies) and asks for confirmation unless
                                               --yes; --deploy-extension also installs and
                                               enables the plugin's extension on the deployment.
                                               git: reads a folder of an https repository (or
                                               owner/repo on GitHub) at a branch, tag or commit,
                                               under the marketplaces.* network rules
  capybara help                                Show this help`;

/** Options only `admin create` accepts. */
const ADMIN_CREATE_OPTIONS = [
  "login",
  "display-name",
  "email",
  "if-none",
  "password-file",
] as const;

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
  if (command !== "extensions" && command !== "plugins" && v.yes !== undefined) {
    throw new UsageError(
      "--yes is only valid for extensions approve, extensions install and plugins import",
    );
  }
  if (command !== "plugins" && v["deploy-extension"] !== undefined) {
    throw new UsageError("--deploy-extension is only valid for plugins import");
  }
  if (command !== "bootstrap") {
    for (const opt of ["dir", "manifest"] as const) {
      if (v[opt] !== undefined) throw new UsageError(`--${opt} is only valid for bootstrap`);
    }
  }
  if (command === "plugins") {
    const [sub, ...args] = rest;
    const subs = ["list", "import"];
    if (sub === undefined) {
      throw new UsageError(`missing plugins command (expected one of ${subs.join(", ")})`);
    }
    if (!subs.includes(sub)) throw new UsageError(`unknown plugins command "${sub}"`);
    if (v.role !== undefined) throw new UsageError("--role is only valid for start");
    for (const opt of ADMIN_CREATE_OPTIONS) {
      if (v[opt] !== undefined) throw new UsageError(`--${opt} is only valid for admin create`);
    }
    if (sub === "list") {
      if (args.length > 0) throw new UsageError(`unexpected argument "${args[0]}"`);
      if (v.yes !== undefined || v["deploy-extension"] !== undefined) {
        throw new UsageError("--yes and --deploy-extension are only valid for plugins import");
      }
      return { command: "plugins-list" };
    }
    const [target, ...extra] = args;
    if (target === undefined || target.trim() === "") {
      throw new UsageError(
        "plugins import needs a package (<file.tgz>, npm:<name>[@<version>] or git:<url>[#<ref>][:<path>])",
      );
    }
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
    return {
      command: "plugins-import",
      target,
      yes: v.yes === true,
      deployExtension: v["deploy-extension"] === true,
    };
  }
  if (command === "extensions") {
    const [sub, ...args] = rest;
    const subs = ["list", "install", "enable", "disable", "uninstall", "review", "approve"];
    if (sub === undefined) {
      throw new UsageError(`missing extensions command (expected one of ${subs.join(", ")})`);
    }
    if (!subs.includes(sub)) {
      throw new UsageError(`unknown extensions command "${sub}"`);
    }
    if (v.role !== undefined) throw new UsageError("--role is only valid for start");
    for (const opt of ADMIN_CREATE_OPTIONS) {
      if (v[opt] !== undefined) throw new UsageError(`--${opt} is only valid for admin create`);
    }
    if (sub !== "approve" && sub !== "install" && v.yes !== undefined) {
      throw new UsageError("--yes is only valid for extensions approve and extensions install");
    }
    if (sub === "review" || sub === "list") {
      if (args.length > 0) throw new UsageError(`unexpected argument "${args[0]}"`);
      return { command: sub === "review" ? "extensions-review" : "extensions-list" };
    }
    const [name, ...extra] = args;
    if (name === undefined || name.trim() === "") {
      throw new UsageError(
        sub === "install"
          ? "extensions install needs a package (<file.tgz> or npm:<name>[@<version>])"
          : `extensions ${sub} needs an extension name`,
      );
    }
    if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
    if (sub === "install")
      return { command: "extensions-install", target: name, yes: v.yes === true };
    if (sub === "approve") return { command: "extensions-approve", name, yes: v.yes === true };
    return { command: "extensions-state", name, action: sub as "enable" | "disable" | "uninstall" };
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
      for (const opt of ADMIN_CREATE_OPTIONS) {
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
    const passwordFile = v["password-file"];
    if (passwordFile !== undefined && passwordFile.trim() === "") {
      throw new UsageError("--password-file needs a path");
    }
    return {
      command: "admin-create",
      login: v.login,
      displayName: v["display-name"],
      ...(v.email !== undefined && { email: v.email }),
      ifNone: v["if-none"] === true,
      ...(passwordFile !== undefined && { passwordFile }),
    };
  }
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  for (const opt of ADMIN_CREATE_OPTIONS) {
    if (v[opt] !== undefined) throw new UsageError(`--${opt} is only valid for admin create`);
  }
  if (command === "migrate" || command === "bootstrap") {
    if (parsed.values.role !== undefined) throw new UsageError("--role is only valid for start");
    if (command === "migrate") return { command: "migrate" };
    for (const opt of ["dir", "manifest"] as const) {
      if (v[opt] !== undefined && v[opt].trim() === "") {
        throw new UsageError(`--${opt} needs a path`);
      }
    }
    return {
      command: "bootstrap",
      ...(v.dir !== undefined && { dir: v.dir }),
      ...(v.manifest !== undefined && { manifest: v.manifest }),
    };
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
    // Deliberately no --password: the password comes from stdin or --password-file, never argv
    // (it would land in shell history and the process list).
    options: {
      role: { type: "string" },
      login: { type: "string" },
      "display-name": { type: "string" },
      email: { type: "string" },
      "if-none": { type: "boolean" },
      "password-file": { type: "string" },
      yes: { type: "boolean", short: "y" },
      "deploy-extension": { type: "boolean" },
      dir: { type: "string" },
      manifest: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}
