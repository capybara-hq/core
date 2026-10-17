import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createDb, kernelDb } from "@capybara-hq/kernel";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readPassword } from "../src/commands/admin-create.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PW = "cli-secret-password-123";

let pg: TestContainer;

beforeAll(async () => {
  pg = await startTestPostgres();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});

/** 测试库的环境变量：剥掉父进程的 CAPYBARA_*，Redis 给一个不可达地址（admin create 不应连接它）。 */
function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("CAPYBARA_")) env[k] = v;
  }
  return {
    ...env,
    CAPYBARA_DB__URL: pg.url,
    CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
    CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  };
}

/** 以子进程执行 `pnpm capybara <args>`，stdin 写入给定内容后关闭。 */
function run(
  args: string[],
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--silent", "capybara", ...args], {
      cwd: REPO_ROOT,
      env: testEnv(),
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
