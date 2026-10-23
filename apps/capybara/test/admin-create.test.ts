import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createDb, kernelDb, verifyPassword } from "@capybara-hq/kernel";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readPassword } from "../src/commands/admin-create.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PW = "cli-secret-password-123";

let pg: TestContainer;
let tmp: string;

beforeAll(async () => {
  pg = await startTestPostgres();
  tmp = await mkdtemp(join(tmpdir(), "capybara-admin-create-"));
}, 120_000);
afterAll(async () => {
  await pg?.stop();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/** 测试库的环境变量：剥掉父进程的 CAPYBARA_*，Redis 给一个不可达地址（admin create 不应连接它）。 */
function testEnv(dbUrl: string = pg.url): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CAPYBARA_")) env[k] = v;
  }
  return {
    ...env,
    CAPYBARA_DB__URL: dbUrl,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

/** 以子进程执行 `pnpm capybara <args>`，stdin 写入给定内容后关闭。 */
function run(
  args: string[],
  stdin: string,
  dbUrl?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env: testEnv(dbUrl),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe("capybara admin create", () => {
  it("成功：退出码 0，库中该账号是企业管理员", async () => {
    const r = await run(
      ["admin", "create", "--login", "Admin", "--display-name", "The Admin", "--email", "a@x.io"],
      `${PW}\n`,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain(PW);
    const raw = createDb(pg.url, 1);
    try {
      const row = await kernelDb(raw)
        .selectFrom("identities")
        .innerJoin("accounts", "accounts.id", "identities.account_id")
        .select(["accounts.display_name", "accounts.email", "accounts.is_enterprise_admin"])
        .where("identities.source", "=", "local")
        .where("identities.external_id", "=", "admin")
        .executeTakeFirst();
      expect(row).toEqual({
        display_name: "The Admin",
        email: "a@x.io",
        is_enterprise_admin: true,
      });
    } finally {
      await raw.destroy();
    }
  }, 60_000);

  it("同名再执行 → 退出码 1，stderr 含 login 且不含密码", async () => {
    const r = await run(["admin", "create", "--login", "admin", "--display-name", "X"], `${PW}\n`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("login");
    expect(`${r.stdout}${r.stderr}`).not.toContain(PW);
  }, 60_000);

  it("缺 --login → 退出码 2", async () => {
    const r = await run(["admin", "create", "--display-name", "X"], `${PW}\n`);
    expect(r.code).toBe(2);
  }, 60_000);

  it("不接受命令行传密码 → 退出码 2，且不回显", async () => {
    const r = await run(
      ["admin", "create", "--login", "bob", "--display-name", "B", "--password", PW],
      "",
    );
    expect(r.code).toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toContain(PW);
  }, 60_000);

  it("stdin 为空 → 退出码 1", async () => {
    const r = await run(["admin", "create", "--login", "carol", "--display-name", "C"], "");
    expect(r.code).toBe(1);
  }, 60_000);

  it("密码过短 → 退出码 1，错误不含密码", async () => {
    const r = await run(["admin", "create", "--login", "dave", "--display-name", "D"], "shortpw\n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Password");
    expect(`${r.stdout}${r.stderr}`).not.toContain("shortpw");
  }, 60_000);
});

/** Number of accounts in the given database. */
async function countAccounts(url: string): Promise<number> {
  const raw = createDb(url, 1);
  try {
    const r = await kernelDb(raw)
      .selectFrom("accounts")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  } finally {
    await raw.destroy();
  }
}

/** Stored password hash of a local login. */
async function passwordHash(url: string, login: string): Promise<string | undefined> {
  const raw = createDb(url, 1);
  try {
    const row = await kernelDb(raw)
      .selectFrom("identities")
      .innerJoin("local_passwords", "local_passwords.account_id", "identities.account_id")
      .select("local_passwords.password_hash")
      .where("identities.source", "=", "local")
      .where("identities.external_id", "=", login)
      .executeTakeFirst();
    return row?.password_hash;
  } finally {
    await raw.destroy();
  }
}

describe("capybara admin create --if-none / --password-file (admin exists)", () => {
  it("--if-none with an existing enterprise admin exits 0 without creating an account", async () => {
    // Runs after the describe above created "admin" in the same database.
    const before = await countAccounts(pg.url);
    expect(before).toBeGreaterThan(0);
    const r = await run(
      ["admin", "create", "--login", "second", "--display-name", "S", "--if-none"],
      "",
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("enterprise admin already exists; skipped");
    expect(await countAccounts(pg.url)).toBe(before);
  }, 60_000);

  it("a missing password file exits 1 with an English error", async () => {
    const missing = join(tmp, "does-not-exist");
    const r = await run(
      ["admin", "create", "--login", "erin", "--display-name", "E", "--password-file", missing],
      "",
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read password file");
    expect(r.stderr).toContain(missing);
  }, 60_000);
});

describe("capybara admin create --if-none / --password-file (fresh database)", () => {
  let fresh: TestContainer;
  beforeAll(async () => {
    fresh = await startTestPostgres();
  }, 120_000);
  afterAll(async () => {
    await fresh?.stop();
  });

  it("--if-none without an admin still requires a readable password file", async () => {
    const r = await run(
      [
        "admin",
        "create",
        "--login",
        "root",
        "--display-name",
        "Root",
        "--if-none",
        "--password-file",
        join(tmp, "missing"),
      ],
      "",
      fresh.url,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read password file");
  }, 60_000);

  it("--if-none without an admin creates one, stripping the trailing newline of the file", async () => {
    const file = join(tmp, "pw");
    await writeFile(file, `${PW}\n`);
    const r = await run(
      [
        "admin",
        "create",
        "--login",
        "root",
        "--display-name",
        "Root",
        "--if-none",
        "--password-file",
        file,
      ],
      "",
      fresh.url,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toContain(PW);
    expect(await countAccounts(fresh.url)).toBe(1);
    const hash = await passwordHash(fresh.url, "root");
    expect(hash).toBeDefined();
    expect(await verifyPassword(hash as string, PW)).toBe(true);
  }, 60_000);
});

describe("readPassword", () => {
  /** 收集写入内容的输出流。 */
  function sink(): PassThrough & { text: () => string } {
    const out = new PassThrough();
    let buf = "";
    out.on("data", (d) => {
      buf += String(d);
    });
    return Object.assign(out, { text: () => buf });
  }

  it("stdin 是 TTY：提示 Password:、进入 raw 模式且不回显输入", async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(),
    });
    const out = sink();
    const p = readPassword(input, out);
    input.write("s3cret-passw0rd\r");
    expect(await p).toBe("s3cret-passw0rd");
    expect(input.setRawMode).toHaveBeenCalledWith(true);
    expect(out.text()).toContain("Password: ");
    expect(out.text()).not.toContain("s3cret");
  });

  it("stdin 不是 TTY：读第一行，不提示", async () => {
    const input = new PassThrough();
    const out = sink();
    const p = readPassword(input, out);
    input.end("piped-password\nignored\n");
    expect(await p).toBe("piped-password");
    expect(out.text()).toBe("");
  });

  it("TTY 上在回车前结束输入 → undefined", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const p = readPassword(input, sink());
    input.end();
    expect(await p).toBeUndefined();
  });
});
