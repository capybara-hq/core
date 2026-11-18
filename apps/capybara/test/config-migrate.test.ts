import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCli } from "../src/args.js";
import { cleanEnv, runCliInProcess } from "./support/cli.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "capybara-config-migrate-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ORIGINAL = `# deployment config
db:
  url: postgres://u:secret-password@db/capybara # keep me
devices:
  # who may run with Full permission
  autoMode: off
  maxPersonal: 3
sandbox:
  limits:
    egress: allowlist
`;

async function migrate(text: string, env: NodeJS.ProcessEnv = {}, name = "in.yaml") {
  const input = join(dir, name);
  const output = join(dir, `${name}.out.yaml`);
  await writeFile(input, text);
  const r = await runCliInProcess(
    ["--no-env-file", "config", "migrate-permissions", "--in", input, "--out", output],
    { ...cleanEnv(), ...env },
  );
  const converted = await readFile(output, "utf8").catch(() => undefined);
  return { ...r, input, output, converted };
}

describe("capybara config migrate-permissions (B1)", () => {
  it("parses only with an explicit input and output file", () => {
    expect(parseCli(["config", "migrate-permissions", "--in", "a", "--out", "b"])).toEqual({
      command: "config-migrate-permissions",
      input: "a",
      output: "b",
    });
    expect(() => parseCli(["config", "migrate-permissions", "--in", "a"])).toThrow(/--out/);
    expect(() => parseCli(["config", "migrate-permissions", "--out", "b"])).toThrow(/--in/);
    expect(() => parseCli(["config", "nope"])).toThrow(/unknown config command/);
    expect(() => parseCli(["start", "--in", "a"])).toThrow(/only valid for config/);
  });

  it("renames the old key in place, keeping unrelated keys, values and comments", async () => {
    const r = await migrate(ORIGINAL);
    expect(r.code, r.stderr).toBe(0);
    expect(r.converted).toBe(ORIGINAL.replace("autoMode: off", "fullAccess: off"));
    expect(r.stdout).toContain("devices.autoMode -> devices.fullAccess");
    // the input stays as it was; no unrelated secret is printed
    expect(await readFile(r.input, "utf8")).toBe(ORIGINAL);
    expect(r.stdout + r.stderr).not.toContain("secret-password");
  });

  it("drops an old key equal to the new one; refuses a conflicting or invalid one", async () => {
    const same = await migrate(
      "devices:\n  autoMode: allowed\n  fullAccess: allowed\n",
      {},
      "same",
    );
    expect(same.code, same.stderr).toBe(0);
    expect(same.converted).toBe("devices:\n  fullAccess: allowed\n");
    const conflict = await migrate("devices:\n  autoMode: allowed\n  fullAccess: off\n", {}, "c");
    expect(conflict.code).toBe(1);
    expect(conflict.stderr).toMatch(/devices\.autoMode.*devices\.fullAccess/s);
    expect(conflict.converted).toBeUndefined();
    const invalid = await migrate("devices:\n  autoMode: maybe\n", {}, "invalid");
    expect(invalid.code).toBe(1);
    expect(invalid.converted).toBeUndefined();
  });

  it("names the environment variables to rename, without editing the environment", async () => {
    const env = { CAPYBARA_DEVICES__AUTO_MODE: "off", CAPYBARA_MASTER_KEY: "very-secret" };
    const r = await migrate("log:\n  level: info\n", env, "env");
    expect(r.code, r.stderr).toBe(0);
    expect(r.converted).toBe("log:\n  level: info\n");
    expect(r.stdout).toMatch(/CAPYBARA_DEVICES__AUTO_MODE.*CAPYBARA_DEVICES__FULL_ACCESS/s);
    expect(r.stdout + r.stderr).not.toContain("very-secret");
    const both = await migrate(
      "log:\n  level: info\n",
      {
        CAPYBARA_DEVICES__AUTO_MODE: "off",
        CAPYBARA_DEVICES__FULL_ACCESS: "allowed",
      },
      "env-conflict",
    );
    expect(both.code).toBe(1);
    expect(both.stderr).toMatch(/CAPYBARA_DEVICES__AUTO_MODE/);
  });

  it("never overwrites an existing output file", async () => {
    const input = join(dir, "exists.yaml");
    const output = join(dir, "exists.out.yaml");
    await writeFile(input, ORIGINAL);
    await writeFile(output, "keep");
    const r = await runCliInProcess(
      ["--no-env-file", "config", "migrate-permissions", "--in", input, "--out", output],
      cleanEnv(),
    );
    expect(r.code).toBe(1);
    expect(await readFile(output, "utf8")).toBe("keep");
  });
});
