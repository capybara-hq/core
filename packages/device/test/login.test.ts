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
import { logout } from "../src/commands/logout.js";
import { pidPath, writePid } from "../src/pid.js";

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

const run = (
  argv: string[],
  platform: NodeJS.Platform = "linux",
  kill: typeof process.kill | undefined = undefined,
) =>
  runCli(argv, {
    ...(kill && { kill }),
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
const credFile = () => join(home, "cfg", "capybara-device", "credential.json");

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

  it("stores the deployment's maxFrameBytes", async () => {
    tokenAnswers = [{ status: 200, body: { ...granted.body, maxFrameBytes: 4_194_304 } }];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(JSON.parse(readFileSync(credFile(), "utf8")).maxFrameBytes).toBe(4_194_304);
  });

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
