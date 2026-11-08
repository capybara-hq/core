import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

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
  body: { error: { code: "device.authorization_pending", message: "wait" } },
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
          verificationUriComplete: `${base}/device?code=BCDF-GHJK`,
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

const run = (argv: string[], platform: NodeJS.Platform = "linux") =>
  runCli(argv, {
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
    environmentId: "env-1",
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
    expect(out[0]).toContain(`${base}/device?code=BCDF-GHJK`);
    expect(opened).toEqual([`${base}/device?code=BCDF-GHJK`]);
    expect(seen.every((s) => s.csrf === "1")).toBe(true);
    expect(seen[0]?.body).toMatchObject({ os: "linux", name: expect.any(String) });
    expect(seen[1]?.body).toEqual({ deviceCode: "cap_dvc_x" });
    expect(statSync(credFile()).mode & 0o777).toBe(0o600);
    const cred = JSON.parse(readFileSync(credFile(), "utf8"));
    expect(cred).toMatchObject({
      url: base,
      credential: "cap_dev_secret",
      environmentId: "env-1",
      orgId: "org-1",
      mode: "os",
      reconnectGraceSeconds: 90,
      dir: join(home, "capybara-device", "env-1"),
    });
    for (const sub of ["workspace", "skills", "tmp"]) {
      expect(existsSync(join(cred.dir, sub))).toBe(true);
    }
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

  it("slows down on device.slow_down", async () => {
    const slow = { status: 400, body: { error: { code: "device.slow_down", message: "slow" } } };
    tokenAnswers = [slow, slow, granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(sleeps).toEqual([5000, 10000, 15000]);
  });

  it("stops on device.denied with exit 1", async () => {
    tokenAnswers = [{ status: 400, body: { error: { code: "device.denied", message: "no" } } }];
    expect(await run(["login", "--url", base])).toBe(1);
    expect(err.join("\n")).toContain("denied");
    expect(existsSync(credFile())).toBe(false);
  });

  it("stops on device.expired with exit 1", async () => {
    tokenAnswers = [{ status: 400, body: { error: { code: "device.expired", message: "old" } } }];
    expect(await run(["login", "--url", base])).toBe(1);
    expect(err.join("\n")).toContain("expired");
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
    expect(shown).toMatchObject({ loggedIn: true, environmentId: "env-1" });
    expect(JSON.stringify(shown)).not.toContain("cap_dev_secret");
    expect(await run(["logout"])).toBe(0);
    expect(existsSync(credFile())).toBe(false);
    expect(await run(["status"])).toBe(1);
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

  it("start is not implemented yet and exits 2", async () => {
    expect(await run(["start"])).toBe(2);
  });
});
