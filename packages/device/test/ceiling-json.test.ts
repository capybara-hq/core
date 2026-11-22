import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { connectionDir } from "../src/connections.js";
import { DEFAULT_POLICY, writeCredential, writePolicy } from "../src/state.js";

let root: string;
let state: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "device-ceiling-json-"));
  state = connectionDir(join(root, "capybara-device"), "dev");
  writePolicy(state, {
    ...DEFAULT_POLICY,
    ownerCeiling: { outsideSandbox: true, network: "open", restrictedProjectReach: "os-user" },
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const show = async () => {
  const out: string[] = [];
  const code = await runCli(["ceiling", "show", "--json"], {
    env: { XDG_CONFIG_HOME: root },
    home: join(root, "home"),
    platform: "darwin",
    out: (l) => out.push(l),
    err: (l) => out.push(l),
  });
  return { code, out };
};

describe("ceiling show --json", () => {
  it("needs a connection: with none it exits 1", async () => {
    const { code } = await show();
    expect(code).toBe(1);
  });

  it("carries the strict revision when logged in", async () => {
    writeCredential(state, {
      url: "https://x.test",
      connectUrl: "wss://x.test/device/connect",
      credential: "cap_dev_secret",
      orgId: "org-1",
      deviceId: "dev",
      dir: join(root, "device"),
      mode: "os",
      reconnectGraceSeconds: 90,
      maxFrameBytes: 16_777_216,
    });
    const { out } = await show();
    const parsed = JSON.parse(out[0] ?? "");
    expect(parsed).toMatchObject({
      outsideSandbox: true,
      network: "open",
      projectReach: "os-user",
    });
    expect(parsed.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(out.join("")).not.toContain("cap_dev_secret");
  });
});
