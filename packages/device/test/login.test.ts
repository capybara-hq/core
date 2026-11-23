import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE,
  outsideSandboxLoginLine,
  outsideSandboxRiskText,
  projectReachLoginLine,
  restrictedUnavailableLoginLine,
  sandboxOnlyLoginLine,
} from "../src/commands/login.js";
import { logout } from "../src/commands/logout.js";
import { connectionDir, listConnections } from "../src/connections.js";

import { ownerReportPath } from "../src/owner-report.js";
import { pidPath, writePid } from "../src/pid.js";
import { PolicyStore } from "../src/policy-store.js";
import {
  type Credential,
  credentialPath,
  MISSING_POLICY_OWNER_CEILING,
  policyLockPath,
  policyPath,
  readCredential,
  readPolicy,
  writeCredential,
  writePolicy,
} from "../src/state.js";

/** The owner ceiling a new setup writes (B-14). */
/** A new install's owner ceiling: in the sandbox only, the open network, the whole machine. */
const NEW_INSTALL = { outsideSandbox: false, network: "open", projectReach: "machine" };
/** An owner's sandbox-only policy with the allowlist network. */
const SANDBOX_ONLY = {
  outsideSandbox: false,
  network: "allowlist",
  projectReach: "workspace",
};
const OUTSIDE_ALLOWED = { outsideSandbox: true, network: "open", projectReach: "machine" };
/** An existing policy file whose owner allows running outside the sandbox. */
const writeOutsideAllowedPolicy = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    policyPath(dir),
    `${JSON.stringify({ version: 4, ownerCeiling: OUTSIDE_ALLOWED }, null, 2)}\n`,
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
/** Whether the host's /usr/bin/python3 is executable, as the docker-mode check sees it. */
let hostPython = true;

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
  hostPython = true;
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
    hostProbes: { isExecutable: () => hostPython, commandLineTools: () => hostPython },
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
/** The machine directory: one directory per connection under connections/. */
const machineDir = () => join(home, "cfg", "capybara-device");
/** The connection directory of a device (the granted one by default). */
const stateDir = (deviceId = "env-1") => connectionDir(machineDir(), deviceId);
const credFile = () => join(stateDir(), "credential.json");
/** Whether the owner allows running outside the sandbox, as the hello's owner report says. */
const helloOutside = () => new PolicyStore(stateDir()).current().ownerCeiling.outsideSandbox;
/** A token answer for another device. */
const grantedAs = (body: Record<string, unknown>) => ({
  status: 200,
  body: { ...granted.body, ...body },
});
/** The old single-connection layout: credential.json directly in the machine directory. */
const flatCredential = (): Credential => ({
  url: base,
  connectUrl: "wss://x.test/device/connect",
  credential: "cap_dev_secret",
  orgId: "org-1",
  deviceId: "env-1",
  dir: join(home, "capybara-device", "env-1"),
  mode: "os",
  reconnectGraceSeconds: 90,
  maxFrameBytes: 16_777_216,
});

describe("login --json", () => {
  const events = () => out.map((l) => JSON.parse(l) as Record<string, unknown>);

  it("emits verification then done, opens no browser, human lines go to stderr", async () => {
    tokenAnswers = [pending, granted];
    expect(await run(["login", "--url", base, "--json"])).toBe(0);
    expect(events()).toEqual([
      {
        event: "verification",
        url: `${base}/devices/link?code=BCDF-GHJK`,
        userCode: "BCDF-GHJK",
        expiresIn: 600,
      },
      {
        event: "done",
        deviceId: "env-1",
        orgId: "org-1",
        dir: join(home, "capybara-device", "env-1"),
        replaced: false,
      },
    ]);
    expect(opened).toEqual([]);
    expect(err.join("\n")).toContain("Logged in. Device env-1");
  });

  it("prints no credential", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--json"])).toBe(0);
    expect(out.join("\n")).not.toContain("cap_dev_secret");
    expect(out.join("\n")).not.toContain("cap_dvc_x");
    expect(err.join("\n")).not.toContain("cap_dev_secret");
  });

  it("an invalid URL ends with an invalid_url error event", async () => {
    expect(await run(["login", "--url", "not a url", "--json"])).toBe(2);
    expect(events()).toEqual([
      { event: "error", code: "invalid_url", message: expect.any(String) },
    ]);
  });

  it("logging in again into a served device replaces its credential in place, keeping directory and policy", async () => {
    const dir = join(home, "x");
    tokenAnswers = [grantedAs({ deviceId: "dev-a" })];
    expect(await run(["login", "--url", base, "--dir", dir])).toBe(0);
    writePolicy(stateDir("dev-a"), { ...readPolicy(stateDir("dev-a")), keepAwake: "connected" });
    out.length = 0;
    tokenAnswers = [grantedAs({ deviceId: "dev-a", credential: "new" })];
    expect(await run(["login", "--url", base, "--json"])).toBe(0);
    expect(readCredential(stateDir("dev-a"))).toMatchObject({ credential: "new", dir });
    expect(readPolicy(stateDir("dev-a")).keepAwake).toBe("connected");
    expect(events().at(-1)).toMatchObject({
      event: "done",
      deviceId: "dev-a",
      dir,
      replaced: true,
    });
    expect(readdirSync(join(machineDir(), "connections"))).toEqual(["dev-a"]);
  });

  it.each([
    ["another deployment", { url: "localhost" }],
    ["another organization", { orgId: "org-2" }],
  ])("the same device id from %s is refused and nothing is written", async (_, change) => {
    const dir = join(home, "x");
    tokenAnswers = [grantedAs({ deviceId: "dev-a" })];
    expect(await run(["login", "--url", base, "--dir", dir])).toBe(0);
    const conn = stateDir("dev-a");
    writePolicy(conn, { ...readPolicy(conn), keepAwake: "connected" });
    writeFileSync(ownerReportPath(conn), '{"seq":7}\n', { mode: 0o600 });
    const before = [credentialPath(conn), policyPath(conn), ownerReportPath(conn)].map((f) =>
      readFileSync(f, "utf8"),
    );
    out.length = 0;
    const url = "url" in change ? base.replace("127.0.0.1", "localhost") : base;
    tokenAnswers = [
      grantedAs({
        deviceId: "dev-a",
        credential: "cap_dev_other",
        ...("orgId" in change && change),
      }),
    ];
    expect(await run(["login", "--url", url, "--json", "--dir", join(home, "y")])).toBe(1);
    const last = events().at(-1);
    expect(last).toMatchObject({ event: "error", code: "device_id_in_use" });
    expect(String(last?.message)).toContain("capybara-device logout -c dev-a");
    expect(
      [credentialPath(conn), policyPath(conn), ownerReportPath(conn)].map((f) =>
        readFileSync(f, "utf8"),
      ),
    ).toEqual(before);
    expect(existsSync(join(home, "y"))).toBe(false);
  });

  it.each([
    ["the same directory", (d: string) => d],
    ["a directory inside it", (d: string) => join(d, "nested")],
    ["a directory containing it", (d: string) => join(d, "..")],
  ])(
    "a new connection's --dir overlapping another connection's (%s) is refused",
    async (_, pick) => {
      const dir = join(home, "work", "a");
      tokenAnswers = [grantedAs({ deviceId: "dev-a", deviceName: "Laptop" })];
      expect(await run(["login", "--url", base, "--dir", dir])).toBe(0);
      out.length = 0;
      tokenAnswers = [grantedAs({ deviceId: "dev-b", credential: "cap_dev_b" })];
      expect(await run(["login", "--url", base, "--json", "--dir", pick(dir)])).toBe(1);
      const last = events().at(-1);
      expect(last).toMatchObject({ event: "error", code: "work_dir_overlap" });
      expect(String(last?.message)).toContain(`Laptop (dev-a)`);
      expect(String(last?.message)).toContain("--dir");
      expect(readdirSync(join(machineDir(), "connections"))).toEqual(["dev-a"]);
      expect(existsSync(join(dir, "nested"))).toBe(false);
    },
  );

  it("a --dir reaching another connection's directory through a symlink is refused", async () => {
    const dir = join(home, "work", "a");
    tokenAnswers = [grantedAs({ deviceId: "dev-a" })];
    expect(await run(["login", "--url", base, "--dir", dir])).toBe(0);
    symlinkSync(join(home, "work"), join(home, "link"));
    out.length = 0;
    tokenAnswers = [grantedAs({ deviceId: "dev-b" })];
    expect(
      await run(["login", "--url", base, "--json", "--dir", join(home, "link", "a", "x")]),
    ).toBe(1);
    expect(events().at(-1)).toMatchObject({ event: "error", code: "work_dir_overlap" });
  });

  it.each([
    ["inside the machine directory", () => join(machineDir(), "w")],
    ["containing the machine directory", () => home],
  ])("a --dir %s is refused", async (_, pick) => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--json", "--dir", pick()])).toBe(1);
    const last = events().at(-1);
    expect(last).toMatchObject({ event: "error", code: "work_dir_overlap" });
    expect(String(last?.message)).toContain(machineDir());
    expect(existsSync(credFile())).toBe(false);
  });

  it("logging in again keeps the connection's own directory: no overlap with itself", async () => {
    const dir = join(home, "work", "a");
    tokenAnswers = [grantedAs({ deviceId: "dev-a" })];
    expect(await run(["login", "--url", base, "--dir", dir])).toBe(0);
    tokenAnswers = [grantedAs({ deviceId: "dev-a", credential: "new" })];
    expect(await run(["login", "--url", base, "--dir", dir])).toBe(0);
    expect(readCredential(stateDir("dev-a"))).toMatchObject({ credential: "new", dir });
  });

  it("an empty device or org name is not stored", async () => {
    tokenAnswers = [grantedAs({ deviceName: "", orgName: "" })];
    expect(await run(["login", "--url", base])).toBe(0);
    const cred = readCredential(stateDir());
    expect(cred).toBeDefined();
    expect(cred).not.toHaveProperty("deviceName");
    expect(cred).not.toHaveProperty("orgName");
  });

  it.each(["../evil", "a/b", "x".repeat(129)])(
    "the device id %j is not a safe path segment: refused and nothing is written",
    async (deviceId) => {
      tokenAnswers = [grantedAs({ deviceId })];
      expect(await run(["login", "--url", base, "--json"])).toBe(1);
      expect(events().at(-1)).toMatchObject({ event: "error", code: "invalid_device_id" });
      expect(existsSync(join(machineDir(), "evil"))).toBe(false);
      expect(existsSync(join(home, "cfg", "evil"))).toBe(false);
      expect(existsSync(join(machineDir(), "connections"))).toBe(false);
      expect(existsSync(join(home, "capybara-device"))).toBe(false);
      expect(out.join("\n")).not.toContain("cap_dev_secret");
    },
  );

  it("a symlinked connections/ is refused before anything is created at its target", async () => {
    const target = join(home, "elsewhere");
    mkdirSync(target, { recursive: true });
    mkdirSync(machineDir(), { recursive: true, mode: 0o700 });
    symlinkSync(target, join(machineDir(), "connections"));
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--json"])).toBe(1);
    expect(events().at(-1)).toMatchObject({ event: "error", code: "machine_dir_unusable" });
    expect(readdirSync(target)).toEqual([]);
  });

  it("a symlinked credential.json is replaced, not followed", async () => {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const real = join(home, "real-credential.json");
    writeCredential(home, { ...flatCredential(), credential: "cap_dev_old", dir: join(home, "w") });
    renameSync(join(home, "credential.json"), real);
    symlinkSync(real, credFile());
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(err.join("\n")).toContain("is a symlink");
    // a new connection: the default directory, not the symlink target's
    expect(readCredential(stateDir())?.dir).toBe(join(home, "capybara-device", "env-1"));
  });

  it("a relative and a normalised absolute --dir of the served connection say nothing", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    const dir = join(home, "capybara-device", "env-1");
    out.length = 0;
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--dir", `${dir}/../env-1/`])).toBe(0);
    expect(out.some((l) => l.includes("already serves"))).toBe(false);
  });

  it("an expired code ends with an error event", async () => {
    tokenAnswers = [
      { status: 400, body: { error: { code: "device_sign_in.expired", message: "gone" } } },
    ];
    expect(await run(["login", "--url", base, "--json"])).toBe(1);
    const last = events().at(-1);
    expect(last).toMatchObject({ event: "error", code: "device_sign_in.expired" });
    expect(existsSync(credFile())).toBe(false);
  });

  it("a denied login ends with an error event", async () => {
    tokenAnswers = [
      { status: 400, body: { error: { code: "device_sign_in.denied", message: "no" } } },
    ];
    expect(await run(["login", "--url", base, "--json"])).toBe(1);
    expect(events().at(-1)).toMatchObject({ event: "error", code: "device_sign_in.denied" });
  });
});

describe("login", () => {
  it("polls until approved and writes a 0600 credential", async () => {
    tokenAnswers = [pending, pending, granted];
    expect(await run(["login", "--url", `${base}/`])).toBe(0);
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(out[0]).toContain("BCDF-GHJK");
    expect(out[0]).toContain(`${base}/devices/link?code=BCDF-GHJK`);
    expect(opened).toEqual([`${base}/devices/link?code=BCDF-GHJK`]);
    expect(seen.every((s) => s.csrf === "1")).toBe(true);
    // the sign-in names the protocol: the confirm page offers the providers that serve it
    expect(seen[0]?.body).toMatchObject({
      os: "linux",
      name: expect.any(String),
      protocol: "capybara-device/6",
    });
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
    // written, not just defaulted: version 4, in the sandbox only, the open network
    const file = JSON.parse(readFileSync(policyPath(stateDir()), "utf8"));
    expect(file).toMatchObject({ version: 4, ownerCeiling: NEW_INSTALL, projectPaths: [] });
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(helloOutside()).toBe(false);
    expect(out.filter((l) => l === sandboxOnlyLoginLine("env-1"))).toHaveLength(1);
    expect(sandboxOnlyLoginLine("env-1")).toContain(
      "capybara-device ceiling set --outside-sandbox on -c env-1",
    );
    expect(out).toContain(networkLoginLine("open", "env-1"));
    expect(networkLoginLine("open", "env-1")).toContain("--network allowlist -c env-1");
    // the new setup's machine reach, as `ceiling show` names it
    expect(out.filter((l) => l.startsWith("Project reach: "))).toEqual([
      projectReachLoginLine("machine", 0, "env-1"),
    ]);
    expect(projectReachLoginLine("machine", 0, "env-1")).toMatch(/^Project reach: machine \(/);
    expect(out).not.toContain(outsideSandboxLoginLine("env-1"));
    expect(out).not.toContain(outsideSandboxRiskText("env-1"));
  });

  it("an organization without outside-sandbox runs gets the same default", async () => {
    tokenAnswers = [{ status: 200, body: { ...granted.body, outsideSandbox: "off" } }];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(out).toContain(sandboxOnlyLoginLine("env-1"));
    expect(out).not.toContain(OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE);
    expect(out).not.toContain(outsideSandboxRiskText("env-1"));
  });

  it("keeps an existing policy allowing outside the sandbox and says the org does not allow it", async () => {
    writeOutsideAllowedPolicy(stateDir());
    tokenAnswers = [{ status: 200, body: { ...granted.body, outsideSandbox: "off" } }];
    expect(await run(["login", "--url", base])).toBe(0);
    // an existing policy is the owner's choice: login never rewrites it
    expect(JSON.parse(readFileSync(policyPath(stateDir()), "utf8"))).toEqual({
      version: 4,
      ownerCeiling: OUTSIDE_ALLOWED,
    });
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(OUTSIDE_ALLOWED);
    expect(out).toContain(outsideSandboxLoginLine("env-1"));
    expect(out).toContain(OUTSIDE_SANDBOX_NOT_ALLOWED_LOGIN_LINE);
    expect(out).not.toContain(outsideSandboxRiskText("env-1"));
  });

  it("keeps an existing sandbox-only policy with the allowlist network", async () => {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const existing = { version: 4, ownerCeiling: SANDBOX_ONLY };
    writeFileSync(policyPath(stateDir()), `${JSON.stringify(existing)}\n`, {
      mode: 0o600,
    });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(JSON.parse(readFileSync(policyPath(stateDir()), "utf8"))).toEqual(existing);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(SANDBOX_ONLY);
    expect(out).toContain(sandboxOnlyLoginLine("env-1"));
    expect(out).toContain(networkLoginLine("allowlist", "env-1"));
    expect(networkLoginLine("allowlist", "env-1")).toContain(
      "capybara-device ceiling set --network open -c env-1",
    );
    expect(out).not.toContain(outsideSandboxRiskText("env-1"));
  });

  it("prints the project reach of an existing policy", async () => {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const listed = mkdtempSync(join(tmpdir(), "login-project-"));
    try {
      const existing = {
        version: 4,
        ownerCeiling: { ...SANDBOX_ONLY, projectReach: "paths" },
        projectPaths: [listed],
      };
      writeFileSync(policyPath(stateDir()), `${JSON.stringify(existing)}\n`, { mode: 0o600 });
      tokenAnswers = [granted];
      expect(await run(["login", "--url", base])).toBe(0);
      expect(out).toContain(projectReachLoginLine("paths", 1, "env-1"));
      expect(projectReachLoginLine("paths", 1, "env-1")).toMatch(
        /^Project reach: paths \(1 listed;/,
      );
      expect(projectReachLoginLine("workspace", 0, "env-1")).toMatch(
        /^Project reach: workspace \(/,
      );
    } finally {
      rmSync(listed, { recursive: true, force: true });
    }
  });

  it("prints the outside-sandbox line and the risk text once when the owner allows it", async () => {
    writeOutsideAllowedPolicy(stateDir());
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(out).toContain(outsideSandboxLoginLine("env-1"));
    expect(out.filter((l) => l === outsideSandboxRiskText("env-1"))).toHaveLength(1);
    expect(out).not.toContain(sandboxOnlyLoginLine("env-1"));
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
    // no file: every reader sees the closed missing-file ceiling (start writes it), never open
    expect(out).toContain(sandboxOnlyLoginLine("env-1"));
    expect(existsSync(policyPath(stateDir()))).toBe(false);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(MISSING_POLICY_OWNER_CEILING);
    expect(JSON.parse(readFileSync(credFile(), "utf8")).deviceId).toBe("env-1");
  }, 10_000);

  it("logging in again after the files were lost recreates the directory and marker", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    const dir = join(home, "capybara-device", "env-1");
    writeFileSync(join(dir, "workspace", "kept"), "x");
    rmSync(dir, { recursive: true });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    for (const sub of ["workspace", "skills", "tmp", ".capybara-device"]) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
    expect(existsSync(join(dir, "workspace", "kept"))).toBe(false);
    // A lost root under a kept directory is recreated as well.
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
    expect(out).toContain(sandboxOnlyLoginLine("env-1"));
    expect(out).toContain(restrictedUnavailableLoginLine("bubblewrap is missing", "env-1"));
    expect(JSON.parse(readFileSync(credFile(), "utf8")).deviceId).toBe("env-1");
  });

  it("--mode docker: the default without the OS sandbox check, no risk text outside the sandbox", async () => {
    sandbox = { ok: false, reason: "not needed in docker" };
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--mode", "docker"])).toBe(0);
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
    expect(out).toContain(sandboxOnlyLoginLine("env-1"));
    expect(out.some((l) => l.includes("not needed in docker"))).toBe(false);
    out.length = 0;
    writeOutsideAllowedPolicy(stateDir());
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--mode", "docker"])).toBe(0);
    expect(out).toContain(outsideSandboxLoginLine("env-1"));
    expect(out).not.toContain(outsideSandboxRiskText("env-1"));
  });

  it("--mode docker without the host python3: refused with the fix, before the deployment is asked", async () => {
    hostPython = false;
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--mode", "docker"])).toBe(1);
    expect(err.join("\n")).toContain("/usr/bin/python3");
    expect(err.join("\n")).toContain("sudo apt install python3");
    expect(seen).toEqual([]);
    expect(existsSync(credFile())).toBe(false);
    out.length = 0;
    err.length = 0;
    expect(await run(["login", "--url", base, "--mode", "docker"], "darwin")).toBe(1);
    expect(err.join("\n")).toContain("xcode-select --install");
    // OS mode never needs it
    err.length = 0;
    expect(await run(["login", "--url", base])).toBe(0);
  });

  it("--mode docker on macOS without the command line tools: refused though the shim exists", async () => {
    hostPython = true;
    const tools = false;
    const r = await runCli(["login", "--url", base, "--mode", "docker"], {
      ps: ourPs,
      sandboxAvailable: () => sandbox,
      hostProbes: { isExecutable: () => true, commandLineTools: () => tools },
      env: { XDG_CONFIG_HOME: join(home, "cfg") },
      home,
      platform: "darwin",
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      sleep: async () => {},
      openBrowser: () => {},
    });
    expect(r).toBe(1);
    expect(err.join("\n")).toContain("xcode-select --install");
    expect(seen).toEqual([]);
  });

  it("re-login of a docker device without python3 writes the credential and warns", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--mode", "docker"])).toBe(0);
    hostPython = false;
    out.length = 0;
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(out.join("\n")).toContain("Warning:");
    expect(out.join("\n")).toContain("/usr/bin/python3");
    expect(JSON.parse(readFileSync(credFile(), "utf8"))).toMatchObject({ mode: "docker" });
  });

  it("a new docker device beside another connection is refused late, leaving no directory", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    hostPython = false;
    err.length = 0;
    tokenAnswers = [grantedAs({ deviceId: "env-2" })];
    expect(await run(["login", "--url", base, "--mode", "docker"])).toBe(1);
    expect(err.join("\n")).toContain("Nothing was stored");
    expect(existsSync(stateDir("env-2"))).toBe(false);
  });

  it("re-login of an os device passing --mode docker is not refused or warned", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    hostPython = false;
    out.length = 0;
    tokenAnswers = [granted];
    const code = await run(["login", "--url", base, "--mode", "docker"]);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.join("\n")).not.toContain("Warning:");
    expect(JSON.parse(readFileSync(credFile(), "utf8"))).toMatchObject({ mode: "os" });
  });

  it("points at the installed login service instead of start", async () => {
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    const unitDir = join(home, ".config", "systemd", "user");
    writeFileSync(join(unitDir, "capybara-device@.service"), "unit");
    mkdirSync(join(unitDir, "default.target.wants"), { recursive: true });
    writeFileSync(join(unitDir, "default.target.wants", "capybara-device@env-1.service"), "");
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(out.at(-1)).toContain("capybara-device service restart -c env-1");
  });

  it("without a login service it says how to start this connection", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(out.at(-1)).toContain("capybara-device start -c env-1");
    expect(out.at(-1)).toContain("capybara-device service install -c env-1");
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
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(credFile(), "{not json", { mode: 0o600 });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(err.join("\n")).toContain("credential.json");
    expect(JSON.parse(readFileSync(credFile(), "utf8")).deviceId).toBe("env-1");

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

  it("a second login adds a second connection", async () => {
    const other = base.replace("127.0.0.1", "localhost");
    tokenAnswers = [grantedAs({ deviceId: "dev-a" })];
    expect(await run(["login", "--url", base])).toBe(0);
    tokenAnswers = [grantedAs({ deviceId: "dev-b", credential: "cap_dev_b" })];
    expect(await run(["login", "--url", other])).toBe(0);
    expect(listConnections(machineDir()).map((c) => [c.deviceId, c.host])).toEqual([
      ["dev-a", new URL(base).host],
      ["dev-b", new URL(other).host],
    ]);
    expect(readCredential(stateDir("dev-a"))?.credential).toBe("cap_dev_secret");
    for (const id of ["dev-a", "dev-b"]) {
      expect(statSync(stateDir(id)).mode & 0o777).toBe(0o700);
      expect(statSync(join(stateDir(id), "credential.json")).mode & 0o777).toBe(0o600);
      expect(readPolicy(stateDir(id)).ownerCeiling).toEqual(NEW_INSTALL);
    }
    expect(statSync(join(machineDir(), "connections")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(machineDir(), "machine.json"), "utf8"))).toEqual({
      version: 1,
    });
  });

  it("--dir or --mode differing from the served connection is not applied, and says so", async () => {
    tokenAnswers = [grantedAs({ orgName: "Acme", deviceName: "Laptop" })];
    expect(await run(["login", "--url", base])).toBe(0);
    const dir = join(home, "capybara-device", "env-1");
    out.length = 0;
    tokenAnswers = [grantedAs({ credential: "new", orgName: "Acme", deviceName: "Laptop" })];
    expect(
      await run(["login", "--url", base, "--dir", join(home, "other"), "--mode", "docker"]),
    ).toBe(0);
    expect(readCredential(stateDir())).toMatchObject({ credential: "new", dir, mode: "os" });
    expect(existsSync(join(home, "other"))).toBe(false);
    expect(out).toContain(
      `This machine already serves device env-1 (${new URL(base).host} · Acme · Laptop (env-1)): ` +
        `it keeps its directory ${dir} and mode os. Log out of it first to change them.`,
    );
    // the same values say nothing
    out.length = 0;
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base, "--dir", dir, "--mode", "os"])).toBe(0);
    expect(out.some((l) => l.includes("already serves"))).toBe(false);
  });

  it("stores the device and organization names from the token", async () => {
    tokenAnswers = [grantedAs({ deviceName: "Laptop", orgName: "Acme" })];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(readCredential(stateDir())).toMatchObject({ deviceName: "Laptop", orgName: "Acme" });
    // a device without a name (null) stores none
    tokenAnswers = [grantedAs({ deviceName: null, orgName: "Acme" })];
    expect(await run(["login", "--url", base])).toBe(0);
    const cred = readCredential(stateDir());
    expect(cred?.orgName).toBe("Acme");
    expect(cred && "deviceName" in cred).toBe(false);
  });

  it("the old flat credential.json does not stop a login and is left untouched", async () => {
    writeCredential(machineDir(), flatCredential());
    writeFileSync(policyPath(machineDir()), `${JSON.stringify({ mode: "auto" })}\n`, {
      mode: 0o600,
    });
    const before = readFileSync(join(machineDir(), "credential.json"), "utf8");
    tokenAnswers = [grantedAs({ credential: "new" })];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(readFileSync(join(machineDir(), "credential.json"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(policyPath(machineDir()), "utf8"))).toEqual({ mode: "auto" });
    expect(readCredential(stateDir())?.credential).toBe("new");
    // the connection gets its own new-install policy, not the flat one
    expect(readPolicy(stateDir()).ownerCeiling).toEqual(NEW_INSTALL);
  });

  it("tightens a machine directory other users can read to 0700", async () => {
    mkdirSync(machineDir(), { recursive: true, mode: 0o755 });
    chmodSync(machineDir(), 0o755);
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(statSync(machineDir()).mode & 0o777).toBe(0o700);
  });

  it("a machine.json of another format version stops the login before the browser opens", async () => {
    mkdirSync(machineDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(machineDir(), "machine.json"), `${JSON.stringify({ version: 2 })}\n`, {
      mode: 0o600,
    });
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(1);
    expect(err.join("\n")).toContain("format version 2");
    expect(opened).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("status and logout", () => {
  it("status reports not logged in", async () => {
    expect(await run(["status"])).toBe(1);
    expect(out).toEqual(["No connection. Run capybara-device login --url <url>."]);
    out.length = 0;
    expect(await run(["status", "--json"])).toBe(1);
    expect(JSON.parse(out[0] ?? "")).toEqual({ connections: [], unreadable: [] });
  });

  const loggedIn = (deviceId = "env-1") => {
    const connDir = connectionDir(machineDir(), deviceId);
    mkdirSync(connDir, { recursive: true, mode: 0o700 });
    writeCredential(connDir, { ...flatCredential(), deviceId });
    return connDir;
  };

  it("status shows the login without the credential; logout removes it", async () => {
    const connDir = loggedIn();
    expect(await run(["status", "--json"])).toBe(0);
    const shown = JSON.parse(out[0] ?? "");
    expect(shown.connections[0]).toMatchObject({ deviceId: "env-1" });
    expect(JSON.stringify(shown)).not.toContain("cap_dev_secret");
    expect(await run(["logout"])).toBe(0);
    expect(existsSync(join(connDir, "credential.json"))).toBe(false);
  });

  it("logout stops the running program before forgetting the credential", async () => {
    const state = loggedIn();
    const credFile = () => join(state, "credential.json");
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
    const state = loggedIn();
    const credFile = () => join(state, "credential.json");
    writePid(state, 999_002);
    const kill = (() => true) as unknown as typeof process.kill;
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await logout(
      { stateDir: state, deviceId: "env-1" },
      {
        out: (l) => lines.push(l),
        err: (l) => errs.push(l),
        home,
        platform: "linux",
        kill,
        ps: ourPs,
        sleep: async () => {},
        waitMs: 300,
      },
    );
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

  it("policy set and show go through the connection's directory", async () => {
    tokenAnswers = [granted];
    expect(await run(["login", "--url", base])).toBe(0);
    expect(await run(["policy", "set", "allowedDomains", "a.com"])).toBe(0);
    out.length = 0;
    expect(await run(["policy"])).toBe(0);
    expect(JSON.parse(out[0] ?? "").allowedDomains).toEqual(["a.com"]);
  });
});
