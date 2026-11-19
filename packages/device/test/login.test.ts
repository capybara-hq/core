import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import {
  networkLoginLine,
  OUTSIDE_SANDBOX_LOGIN_LINE,
  OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE,
  OUTSIDE_SANDBOX_RISK_TEXT,
  restrictedUnavailableLoginLine,
  SANDBOX_ONLY_LOGIN_LINE,
} from "../src/commands/login.js";
import { logout } from "../src/commands/logout.js";

import { pidPath, writePid } from "../src/pid.js";
import { PolicyStore } from "../src/policy-store.js";
import { policyLockPath, policyPath, readPolicy } from "../src/state.js";

/** The owner ceiling a new setup writes (B-14). */
/** A new install's owner ceiling: in the sandbox only, the open network, the workspace reach. */
const NEW_INSTALL = { outsideSandbox: false, network: "open", restrictedProjectReach: "workspace" };
/** An old `mode: sandbox` file, converted never wider: the allowlist network kept. */
const OLD_SANDBOX = {
  outsideSandbox: false,
  network: "allowlist",
  restrictedProjectReach: "workspace",
};
/** An old (version 1) policy file with `mode: auto`. */
const writeOldAutoPolicy = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    policyPath(dir),
    `${JSON.stringify({ allowedDomains: [], allowCredentials: [], cpu: null, memoryMb: null, mode: "auto" }, null, 2)}\n`,
    { mode: 0o600 },
  );
};

interface Seen {
  path: string;
  csrf: string | undefined;
  body: unknown;
}

let server: Server;
let base: string;
let seen: Seen[];
let tokenAnswers: Array<{ status: number; body: unknown }>;
let home: string;
let out: string[];
let err: string[];
let sleeps: number[];
let opened: string[];

const pending = {
  status: 400,
  body: { error: { code: "device_sign_in.authorization_pending", message: "wait" } },
};

beforeEach(async () => {
  seen = [];
  home = mkdtempSync(join(tmpdir(), "device-login-"));
  out = [];
  err = [];
  sleeps = [];
  opened = [];
  tokenAnswers = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw === "" ? undefined : JSON.parse(raw);
      seen.push({ path: req.url ?? "", csrf: req.headers["x-capybara-csrf"] as string, body });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.url === "/api/v1/device/authorize") {
        send(200, {
          deviceCode: "cap_dvc_x",
          userCode: "BCDF-GHJK",
          verificationUri: `${base}/device`,
          verificationUriComplete: `${base}/devices/link?code=BCDF-GHJK`,
          interval: 5,
          expiresIn: 600,
        });
      } else if (req.url === "/api/v1/device/token") {
        const a = tokenAnswers.shift() ?? pending;
        send(a.status, a.body);
      } else send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(home, { recursive: true, force: true });
});

/** What the OS sandbox check answers (login and mode never run the real one in tests). */
let sandbox: { ok: true } | { ok: false; reason: string } = { ok: true };
beforeEach(() => {
  sandbox = { ok: true };
});

/** `ps` for a test: every pid is a capybara-device that started long ago. */
const ourPs = () => ({ command: "node /x/bin/capybara-device.mjs start", started: new Date(0) });

const run = (
  argv: string[],
  platform: NodeJS.Platform = "linux",
  kill: typeof process.kill | undefined = undefined,
) =>
  runCli(argv, {
    ...(kill && { kill }),
    ps: ourPs,
    sandboxAvailable: () => sandbox,
    env: { XDG_CONFIG_HOME: join(home, "cfg") },
    home,
    platform,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    openBrowser: (u) => opened.push(u),
  });

const granted = {
  status: 200,
  body: {
    credential: "cap_dev_secret",
    orgId: "org-1",
    deviceId: "env-1",
    connectUrl: "wss://x.test/device/connect",
    reconnectGraceSeconds: 90,
  },
};
const stateDir = () => join(home, "cfg", "capybara-device");
const credFile = () => join(stateDir(), "credential.json");
/** Whether the owner allows running outside the sandbox, as the hello's owner report says. */
const helloOutside = () => new PolicyStore(stateDir()).current().ownerCeiling.outsideSandbox;

describe("login", () => {
  it("polls until approved and writes a 0600 credential", async () => {
    tokenAnswers = [pending, pending, granted];
    expect(await run(["login", "--url", `${base}/`])).toBe(0);
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(out[0]).toContain("BCDF-GHJK");
    expect(out[0]).toContain(`${base}/devices/link?code=BCDF-GHJK`);
    expect(opened).toEqual([`${base}/devices/link?code=BCDF-GHJK`]);
    expect(seen.every((s) => s.csrf === "1")).toBe(true);
    expect(seen[0]?.body).toMatchObject({ os: "linux", name: expect.any(String) });
    expect(seen[1]?.body).toEqual({ deviceCode: "cap_dvc_x" });
    expect(statSync(credFile()).mode & 0o777).toBe(0o600);
    const cred = JSON.parse(readFileSync(credFile(), "utf8"));
    expect(cred).toMatchObject({
      url: base,
      credential: "cap_dev_secret",
      deviceId: "env-1",
      orgId: "org-1",
      mode: "os",
      reconnectGraceSeconds: 90,
      maxFrameBytes: 16_777_216,
      dir: join(home, "capybara-device", "env-1"),
    });
    for (const sub of ["workspace", "skills", "tmp", ".capybara-device"]) {
      expect(existsSync(join(cred.dir, sub))).toBe(true);
    }
  });

  it("a new credential resets a lost or corrupt owner-report sequence (B2 I4)", async () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "owner-report.json"), "{ corrupt");
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    // the new machine row starts a new sequence: the old sidecar is gone
    expect(existsSync(join(stateDir(), "owner-report.json"))).toBe(false);
  });

  it("stores the deployment's maxFrameBytes", async () => {
    tokenAnswers = [{ status: 200, body: { ...granted.body, maxFrameBytes: 4_194_304 } }];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(JSON.parse(readFileSync(credFile(), "utf8")).maxFrameBytes).toBe(4_194_304);
  });

  it("a new install writes the sandbox-only, open-network default and says how to widen it", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    // written, not just defaulted: version 3, in the sandbox only, the open network
    const file = JSON.parse(readFileSync(policyPath(stateDir()), "utf8"));
    expect(file).toMatchObject({ version: 3, ownerCeiling: NEW_INSTALL });
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(helloOutside()).toBe(false);
    expect(out.filter((l) => l === SANDBOX_ONLY_LOGIN_LINE)).toHaveLength(1);
    expect(SANDBOX_ONLY_LOGIN_LINE).toContain("capybara-device ceiling set --outside-sandbox on");
    expect(out).toContain(networkLoginLine("open"));
    expect(networkLoginLine("open")).toContain("--network allowlist");
    expect(out).not.toContain(OUTSIDE_SANDBOX_LOGIN_LINE);
    expect(out).not.toContain(OUTSIDE_SANDBOX_RISK_TEXT);
  });

  it("an organization without outside-sandbox runs gets the same default", async () => {
    tokenAnswers = [{ status: 200, body: { ...granted.body, outsideSandbox: "off" } }];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(out).toContain(SANDBOX_ONLY_LOGIN_LINE);
    expect(out).not.toContain(OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE);
    expect(out).not.toContain(OUTSIDE_SANDBOX_RISK_TEXT);
  });

  it("keeps an existing old auto policy (converted never wider) and says the org does not allow it", async () => {
    writeOldAutoPolicy(stateDir());
    tokenAnswers = [{ status: 200, body: { ...granted.body, outsideSandbox: "off" } }];
    expect(await run(["login", "--url", base])).toBe(0);
    // an existing policy is the owner's choice: login never rewrites it; old auto reads as
    // outside the sandbox on with the open network
    expect(JSON.parse(readFileSync(policyPath(stateDir()), "utf8")).mode).toBe("auto");
    expect(readPolicy(stateDir()).ownerCeiling).toEqual({
      outsideSandbox: true,
      network: "open",
      restrictedProjectReach: "os-user",
    });
    expect(out).toContain(OUTSIDE_SANDBOX_LOGIN_LINE);
    expect(out).toContain(OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE);
    expect(out).not.toContain(OUTSIDE_SANDBOX_RISK_TEXT);
  });

  it("keeps an existing old sandbox policy (converted never wider: the allowlist kept)", async () => {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(policyPath(stateDir()), `${JSON.stringify({ mode: "sandbox" })}\n`, {
      mode: 0o600,
    });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(JSON.parse(readFileSync(policyPath(stateDir()), "utf8"))).toEqual({ mode: "sandbox" });
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(OLD_SANDBOX);
    expect(out).toContain(SANDBOX_ONLY_LOGIN_LINE);
    expect(out).toContain(networkLoginLine("allowlist"));
    expect(networkLoginLine("allowlist")).toContain("capybara-device ceiling set --network open");
    expect(out).not.toContain(OUTSIDE_SANDBOX_RISK_TEXT);
  });

  it("prints the outside-sandbox line and the risk text once when the owner allows it", async () => {
    writeOldAutoPolicy(stateDir());
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(out).toContain(OUTSIDE_SANDBOX_LOGIN_LINE);
    expect(out.filter((l) => l === OUTSIDE_SANDBOX_RISK_TEXT)).toHaveLength(1);
    expect(out).not.toContain(SANDBOX_ONLY_LOGIN_LINE);
    expect(readPolicy(stateDir()).ownerCeiling.outsideSandbox).toBe(true);
    expect(helloOutside()).toBe(true);
  });

  it("reports a policy-lock failure, keeps the sandbox-only line and still writes the credential", async () => {
    // A live holder (this test process) keeps policy.json.lock fresh, so login waits about 2 s
    // for it instead of taking it over, then fails to write the default policy.
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(policyLockPath(stateDir()), String(process.pid), { mode: 0o600 });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(err.join("\n")).toContain("Cannot set the local policy");
    // the program's default without a file is the same ceiling
    expect(out).toContain(SANDBOX_ONLY_LOGIN_LINE);
    expect(existsSync(policyPath(stateDir()))).toBe(false);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(JSON.parse(readFileSync(credFile(), "utf8")).deviceId).toBe("env-1");
  }, 10_000);

  it("logging in again after the files were lost recreates the directory and marker", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    const dir = join(home, "capybara-device", "env-1");
    writeFileSync(join(dir, "workspace", "kept"), "x");
    rmSync(dir, { recursive: true });
    expect(await run(["logout"])).toBe(0);
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    for (const sub of ["workspace", "skills", "tmp", ".capybara-device"]) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
    expect(existsSync(join(dir, "workspace", "kept"))).toBe(false);
    // A lost root under a kept directory is recreated as well.
    expect(await run(["logout"])).toBe(0);
    rmSync(join(dir, "skills"), { recursive: true });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(existsSync(join(dir, "skills"))).toBe(true);
  });

  it("says sandboxed work cannot run when the OS sandbox is unavailable, and what to do", async () => {
    sandbox = { ok: false, reason: "bubblewrap is missing" };
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(out).toContain(SANDBOX_ONLY_LOGIN_LINE);
    expect(out).toContain(restrictedUnavailableLoginLine("bubblewrap is missing"));
    expect(JSON.parse(readFileSync(credFile(), "utf8")).deviceId).toBe("env-1");
  });

  it("--mode docker: the default without the OS sandbox check, no risk text outside the sandbox", async () => {
    sandbox = { ok: false, reason: "not needed in docker" };
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--mode", "docker"])).toBe(0);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(out).toContain(SANDBOX_ONLY_LOGIN_LINE);
    expect(out.some((l) => l.includes("not needed in docker"))).toBe(false);
    expect(await run(["logout"])).toBe(0);
    out.length = 0;
    writeOldAutoPolicy(stateDir());
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--mode", "docker"])).toBe(0);
    expect(out).toContain(OUTSIDE_SANDBOX_LOGIN_LINE);
    expect(out).not.toContain(OUTSIDE_SANDBOX_RISK_TEXT);
  });

  it("points at the installed login service instead of start", async () => {
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(home, ".config", "systemd", "user", "capybara-device.service"), "unit");
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(out.join("\n")).toContain("capybara-device service restart");
  });

  it("does not open the browser with --no-browser and honours --dir / --mode", async () => {
    tokenAnswers = [granted];
    const dir = join(home, "custom");
    expect(
      await run(["login", "--url", base, "--no-browser", "--dir", dir, "--mode", "docker"]),
    ).toBe(0);
    expect(opened).toEqual([]);
    expect(JSON.parse(readFileSync(credFile(), "utf8"))).toMatchObject({ dir, mode: "docker" });
    expect(existsSync(join(dir, "workspace"))).toBe(true);
  });

  it("slows down on device_sign_in.slow_down", async () => {
    const slow = {
      status: 400,
      body: { error: { code: "device_sign_in.slow_down", message: "slow" } },
    };
    tokenAnswers = [slow, slow, granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(sleeps).toEqual([5000, 10000, 15000]);
  });

  it("stops on device_sign_in.denied with exit 1", async () => {
    tokenAnswers = [
      { status: 400, body: { error: { code: "device_sign_in.denied", message: "no" } } },
    ];
    expect(await run(["login", "--url", base])).toBe(1);
    expect(err.join("\n")).toContain("denied");
    expect(existsSync(credFile())).toBe(false);
  });

  it("stops on device_sign_in.expired with exit 1", async () => {
    tokenAnswers = [
      { status: 400, body: { error: { code: "device_sign_in.expired", message: "old" } } },
    ];
    expect(await run(["login", "--url", base])).toBe(1);
    expect(err.join("\n")).toContain("expired");
  });

  it("replaces an unusable credential file with a warning", async () => {
    mkdirSync(join(home, "cfg", "capybara-device"), { recursive: true });
    writeFileSync(credFile(), "{not json", { mode: 0o600 });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(err.join("\n")).toContain("credential.json");
    expect(JSON.parse(readFileSync(credFile(), "utf8")).deviceId).toBe("env-1");

    await run(["logout"]);
    tokenAnswers = [granted];
    await run(["login", "--url", base]);
    await run(["logout"]);
    mkdirSync(join(home, "cfg", "capybara-device"), { recursive: true });
    writeFileSync(credFile(), "{}", { mode: 0o600 });
    chmodSync(credFile(), 0o644);
    err.length = 0;
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(err.join("\n")).toContain("readable by other users");
    expect(statSync(credFile()).mode & 0o777).toBe(0o600);
  });

  it("retries network and 5xx errors at the normal interval", async () => {
    tokenAnswers = [{ status: 503, body: {} }, pending, granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it("gives up once expiresIn has passed, even on slow_down", async () => {
    const slow = {
      status: 400,
      body: { error: { code: "device_sign_in.slow_down", message: "slow" } },
    };
    tokenAnswers = Array.from({ length: 100 }, () => slow);
    expect(await run(["login", "--url", base])).toBe(1);
    expect(err.join("\n")).toContain("expired");
    expect(sleeps.length).toBeLessThan(100);
  });

  it("refuses a second login", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(await run(["login", "--url", base])).toBe(1);
    expect(err.join("\n")).toContain("already logged in");
  });
});

describe("status and logout", () => {
  it("status reports not logged in", async () => {
    expect(await run(["status"])).toBe(1);
    expect(out).toEqual(["Not logged in."]);
    out.length = 0;
    expect(await run(["status", "--json"])).toBe(1);
    expect(JSON.parse(out[0] ?? "")).toEqual({ loggedIn: false });
  });

  it("status shows the login without the credential; logout removes it", async () => {
    tokenAnswers = [granted];
    await run(["login", "--url", base]);
    out.length = 0;
    expect(await run(["status", "--json"])).toBe(0);
    const shown = JSON.parse(out[0] ?? "");
    expect(shown).toMatchObject({ loggedIn: true, deviceId: "env-1" });
    expect(JSON.stringify(shown)).not.toContain("cap_dev_secret");
    expect(await run(["logout"])).toBe(0);
    expect(existsSync(credFile())).toBe(false);
    expect(await run(["status"])).toBe(1);
  });

  it("logout stops the running program before forgetting the credential", async () => {
    tokenAnswers = [granted];
    await run(["login", "--url", base]);
    const state = join(home, "cfg", "capybara-device");
    writePid(state, 999_001);
    const alive = new Set([999_001]);
    const sent: Array<[number, string | number | undefined]> = [];
    let credAtSigterm: boolean | undefined;
    const kill = ((pid: number, sig?: string | number) => {
      sent.push([pid, sig]);
      if (!alive.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (sig === "SIGTERM") {
        alive.delete(pid);
        credAtSigterm = existsSync(credFile());
      }
      return true;
    }) as typeof process.kill;
    out.length = 0;
    expect(await run(["logout"], "linux", kill)).toBe(0);
    expect(sent).toContainEqual([999_001, "SIGTERM"]);
    expect(credAtSigterm).toBe(true);
    expect(out[0]).toContain("Stopping the running capybara-device (pid 999001)");
    expect(existsSync(credFile())).toBe(false);
    expect(existsSync(pidPath(state))).toBe(true); // the program removes its own pid file
  });

  it("logout warns when the program does not exit in time, and still logs out", async () => {
    tokenAnswers = [granted];
    await run(["login", "--url", base]);
    const state = join(home, "cfg", "capybara-device");
    writePid(state, 999_002);
    const kill = (() => true) as unknown as typeof process.kill;
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await logout(state, {
      out: (l) => lines.push(l),
      err: (l) => errs.push(l),
      kill,
      ps: ourPs,
      sleep: async () => {},
      waitMs: 300,
    });
    expect(code).toBe(0);
    expect(errs[0]).toContain("still running");
    expect(existsSync(credFile())).toBe(false);
  });
});

describe("platform", () => {
  it("every command exits 1 on native Windows", async () => {
    for (const argv of [["login", "--url", base], ["status"], ["logout"], ["start"]]) {
      err.length = 0;
      expect(await run(argv, "win32")).toBe(1);
      expect(err[0]).toBe("capybara-device runs on macOS and Linux. On Windows use WSL or Docker.");
    }
  });

  it("policy set and show go through the state directory", async () => {
    expect(await run(["policy", "set", "allowedDomains", "a.com"])).toBe(0);
    out.length = 0;
    expect(await run(["policy"])).toBe(0);
    expect(JSON.parse(out[0] ?? "").allowedDomains).toEqual(["a.com"]);
  });
});
