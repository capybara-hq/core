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
 * `capybara admin create`：从 stdin 读一行密码（终端上不回显，见 readPassword） → 跑内核迁移（幂等）→ 建企业管理员。
 * 只连 PG，不连 Redis。退出码：0 成功 / 1 失败（用法错误的 2 由 parseCli 负责）。
 * 错误信息不回显密码：密码登记为日志密钥，stderr 输出里出现的密码一律打码。
 */
export async function runAdminCreate(
  opts: { login: string; displayName: string; email?: string },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: { stdin: PasswordInput; stderr: NodeJS.WritableStream } = {
    stdin: process.stdin,
    stderr: process.stderr,
  },
): Promise<number> {
  let password: string | undefined;
  const fail = (msg: string): number => {
    const safe = password ? msg.split(password).join("[REDACTED]") : msg;
    io.stderr.write(`capybara: admin create failed: ${safe}\n`);
    return 1;
  };
  password = await readPassword(io.stdin, io.stderr);
  if (password === undefined || password === "") {
    return fail("password is required: write it as one line to stdin");
  }
  log.addSecrets([password]);

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
    const orgs = new OrgsService(db, new SettingsService(db, log), new ApiTokenService(db));
    const account = await new SetupService(db, accounts, orgs).createEnterpriseAdmin({
      login: opts.login,
      password,
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
