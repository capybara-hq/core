import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { type Readable, Writable } from "node:stream";
import {
  AccountsService,
  ApiError,
  ApiTokenService,
  createDb,
  KERNEL_MIGRATIONS_DIR,
  KERNEL_SCHEMA,
  KernelConfigSchema,
  type KernelLogger,
  kernelDb,
  loadConfig,
  migrate,
  OrgsService,
  SettingsService,
  SetupService,
  secretValues,
} from "@capybara-hq/kernel";

/** 从输入流读第一行（去掉行尾 `\r`）；流在任何内容之前结束则为 undefined。 */
export function readLine(input: Readable): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, terminal: false });
    let done = false;
    rl.once("line", (line) => {
      done = true;
      rl.close();
      resolve(line.replace(/\r$/, ""));
    });
    rl.once("close", () => {
      if (!done) resolve(undefined);
    });
    input.once("error", reject);
  });
}

/** 可能是终端的输入流（`process.stdin` 在终端上是 `tty.ReadStream`）。 */
export type PasswordInput = Readable & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * 读密码。stdin 是终端时在 `output` 上提示 `Password: `，并以 terminal 模式的 readline 读取
 * （readline 会把终端切到 raw 模式），把它的回显写进一个丢弃一切的 muted 流——键入的密码不回显；
 * Ctrl-C 或输入结束而没有回车时为 undefined。stdin 不是终端（管道 / 重定向）时读第一行、不提示。
 */
export function readPassword(
  input: PasswordInput,
  output: NodeJS.WritableStream,
): Promise<string | undefined> {
  if (!input.isTTY) return readLine(input);
  output.write("Password: ");
  const muted = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output: muted, terminal: true });
    let settled = false;
    const finish = (v: string | undefined) => {
      if (settled) return;
      settled = true;
      output.write("\n");
      rl.close();
      resolve(v);
    };
    rl.once("line", (line) => finish(line));
    rl.once("SIGINT", () => finish(undefined));
    rl.once("close", () => finish(undefined));
    input.once("error", reject);
  });
}

/**
 * Read the password from a file (Docker / K8s secret): the whole content minus trailing newlines.
 * A missing or unreadable file throws with an English message naming the path.
 */
export async function readPasswordFile(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const reason =
      (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
    throw new Error(`cannot read password file ${path}: ${reason}`);
  }
  return text.replace(/[\r\n]+$/, "");
}

/**
 * `capybara admin create`：从 stdin 读一行密码（终端上不回显，见 readPassword），或用 `passwordFile` 从文件读
 * （去掉行尾换行）→ 跑内核迁移（幂等）→ 建企业管理员。
 * `ifNone`：已有活跃企业管理员时打印 `enterprise admin already exists; skipped` 并返回 0——这一检查在读密码之前，
 * 所以此时密码文件缺失也不报错；没有管理员时照常要求密码（文件缺失 → 1，P-7）。
 * 只连 PG，不连 Redis。退出码：0 成功 / 1 失败（用法错误的 2 由 parseCli 负责）。
 * 错误信息不回显密码：密码登记为日志密钥，stderr 输出里出现的密码一律打码。
 */
export async function runAdminCreate(
  opts: {
    login: string;
    displayName: string;
    email?: string;
    ifNone?: boolean;
    passwordFile?: string;
  },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: {
    stdin: PasswordInput;
    stdout?: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  } = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let password: string | undefined;
  const fail = (msg: string): number => {
    const safe = password ? msg.split(password).join("[REDACTED]") : msg;
    io.stderr.write(`capybara: admin create failed: ${safe}\n`);
    return 1;
  };
  /** Reads the password into `password`; returns an error message when there is none. */
  const obtainPassword = async (): Promise<string | undefined> => {
    if (opts.passwordFile !== undefined) {
      try {
        password = await readPasswordFile(opts.passwordFile);
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      if (password === "") return `password file ${opts.passwordFile} is empty`;
    } else {
      password = await readPassword(io.stdin, io.stderr);
      if (password === undefined || password === "") {
        return "password is required: write it as one line to stdin";
      }
    }
    log.addSecrets([password]);
    return undefined;
  };
  // Without --if-none the password comes first, so a missing one fails before touching PG.
  if (!opts.ifNone) {
    const err = await obtainPassword();
    if (err !== undefined) return fail(err);
  }

  let raw: ReturnType<typeof createDb> | undefined;
  try {
    const config = await loadConfig(env);
    log.addSecrets(secretValues(KernelConfigSchema, config));
    log.setLevel(config.log.level);
    const connectTimeoutMs = config.db.connectTimeoutMs;
    await migrate(
      config.db.url,
      { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
      { connectTimeoutMs },
    );
    raw = createDb(config.db.url, 2, (err) => log.error("pg idle client error", { err }), {
      connectTimeoutMs,
    });
    const db = kernelDb(raw);
    const accounts = new AccountsService(db);
    if (opts.ifNone) {
      if ((await accounts.countEnterpriseAdmins()) > 0) {
        (io.stdout ?? process.stdout).write("enterprise admin already exists; skipped\n");
        return 0;
      }
      const err = await obtainPassword();
      if (err !== undefined) return fail(err);
    }
    const orgs = new OrgsService(db, new SettingsService(db, log), new ApiTokenService(db));
    const account = await new SetupService(db, accounts, orgs).createEnterpriseAdmin({
      login: opts.login,
      password: password as string,
      displayName: opts.displayName,
      ...(opts.email !== undefined && { email: opts.email }),
    });
    log.info("enterprise admin created", { accountId: account.id, login: opts.login });
    return 0;
  } catch (e) {
    if (e instanceof ApiError) return fail(`${e.code}: ${e.message}`);
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    await raw?.destroy().catch(() => {});
  }
}
