import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KernelRequest, parseOwnerCeilingReport } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { readStrictOwnerCeiling } from "../src/exec/operation-types.js";
import { issueOwnerReport, ownerReportPath } from "../src/owner-report.js";
import { PolicyStore } from "../src/policy-store.js";
import { serveOperationV3 } from "../src/server-ops.js";
import {
  convertPolicyFile,
  DEFAULT_POLICY,
  policyMode,
  policyPath,
  readPolicyFile,
  SANDBOX_OWNER_CEILING,
  writeCredential,
  writePolicy,
} from "../src/state.js";

let root: string;
let state: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "device-owner-ceiling-"));
  state = join(root, "capybara-device");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeRaw = (value: unknown) => {
  writePolicy(state, DEFAULT_POLICY);
  writeFileSync(policyPath(state), `${JSON.stringify(value, null, 2)}\n`);
};
const onDisk = () => JSON.parse(readFileSync(policyPath(state), "utf8")) as Record<string, unknown>;
const strict = () =>
  readStrictOwnerCeiling({
    stateDir: state,
    deviceId: "dev",
    dir: join(root, "device"),
    home: join(root, "home"),
  });
const report = () =>
  issueOwnerReport({
    stateDir: state,
    deviceId: "dev",
    dir: join(root, "device"),
    home: join(root, "home"),
  });
const cli = async (
  argv: string[],
  opts: { tty?: boolean; answer?: string; beforeWrite?: () => void } = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { XDG_CONFIG_HOME: root },
    home: join(root, "home"),
    platform: "darwin",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdinIsTTY: opts.tty === true,
    ask: async () => opts.answer ?? "n",
    ...(opts.beforeWrite && { beforeCeilingWrite: opts.beforeWrite }),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

describe("version-2 local owner policy", () => {
  it("converts old auto and sandbox exactly, keeping domains, resources and unknown keys", () => {
    writeRaw({
      allowedDomains: ["a.test"],
      allowCredentials: ["GH"],
      cpu: 2,
      memoryMb: null,
      mode: "auto",
      future: { kept: true },
    });
    expect(readPolicyFile(state).legacy).toBe(true);
    expect(convertPolicyFile(state)).toBe("converted");
    expect(onDisk()).toEqual({
      future: { kept: true },
      version: 2,
      allowedDomains: ["a.test"],
      allowCredentials: ["GH"],
      cpu: 2,
      memoryMb: null,
      ownerCeiling: { fullAccess: true, restrictedProjectReach: "os-user" },
    });
    expect(convertPolicyFile(state)).toBe("current");

    writeRaw({ allowedDomains: [], mode: "sandbox" });
    convertPolicyFile(state);
    expect(onDisk().ownerCeiling).toEqual({
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
    expect(onDisk().mode).toBeUndefined();
  });

  it("refuses corruption and a mixed or unknown format without writing", () => {
    for (const bad of [
      { version: 2, allowedDomains: [], ownerCeiling: { fullAccess: "yes" } },
      { version: 2, allowedDomains: [] },
      {
        version: 2,
        mode: "auto",
        ownerCeiling: { fullAccess: true, restrictedProjectReach: "os-user" },
      },
      { version: 3, ownerCeiling: { fullAccess: true, restrictedProjectReach: "os-user" } },
      { mode: "open" },
    ]) {
      writeRaw(bad);
      const before = readFileSync(policyPath(state), "utf8");
      expect(() => convertPolicyFile(state)).toThrow();
      expect(readFileSync(policyPath(state), "utf8")).toBe(before);
    }
  });

  it("keeps Full and project reach independent in the strict reader", async () => {
    writePolicy(state, {
      ...DEFAULT_POLICY,
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "os-user" },
    });
    const c = await strict();
    expect(c.fullAccess).toBe(false);
    expect(c.restrictedProjectReach).toBe("os-user");
    writePolicy(state, {
      ...DEFAULT_POLICY,
      ownerCeiling: { fullAccess: true, restrictedProjectReach: "workspace" },
    });
    const d = await strict();
    expect(d.fullAccess).toBe(true);
    expect(d.restrictedProjectReach).toBe("workspace");
    expect(policyMode(readPolicyFile(state).policy)).toBe("auto");
  });

  it("the strict reader refuses an unconverted old-format policy", async () => {
    writeRaw({ allowedDomains: [], mode: "auto" });
    await expect(strict()).rejects.toThrow(/old format/);
  });

  it("a write through the store converts the file to version 2", () => {
    writeRaw({ allowedDomains: ["a.test"], mode: "sandbox" });
    new PolicyStore(state).update((p) => ({ ...p, allowedDomains: ["b.test"] }));
    expect(onDisk().version).toBe(2);
    expect(onDisk().ownerCeiling).toEqual({
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
  });
});

describe("owner report sequence sidecar", () => {
  it("advances the sequence once per newly observed policy revision", async () => {
    writePolicy(state, DEFAULT_POLICY);
    const first = report();
    expect(parseOwnerCeilingReport(first)).toEqual(first);
    expect(first.sequence).toBe(0);
    expect(JSON.parse(readFileSync(ownerReportPath(state), "utf8"))).toEqual({
      sequence: 0,
      lastPublishedRevision: first.revision,
    });
    // issuing again changes neither the revision nor the sequence (the sidecar is not policy input)
    const again = report();
    expect(again).toEqual(first);
    // an edit with identical visible fields is still a new revision
    writePolicy(state, DEFAULT_POLICY);
    const edited = report();
    expect(edited.revision).not.toBe(first.revision);
    expect(edited.sequence).toBe(1);
    expect({ ...edited, revision: first.revision, sequence: 0 }).toEqual(first);
  });

  it("reports owner fields exactly", async () => {
    writePolicy(state, {
      ...DEFAULT_POLICY,
      allowedDomains: ["*.example.com"],
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "os-user" },
    });
    const r = report();
    expect(r).toMatchObject({
      version: 2,
      fullAccess: false,
      restrictedProjectReach: "os-user",
      restrictedAllowedDomains: ["*.example.com"],
    });
  });

  it("blocks on a corrupt sidecar instead of restarting at zero", async () => {
    writePolicy(state, DEFAULT_POLICY);
    report();
    writePolicy(state, DEFAULT_POLICY);
    writeFileSync(ownerReportPath(state), "{ nope");
    expect(() => report()).toThrow(/owner-report\.json/);
    writeFileSync(ownerReportPath(state), JSON.stringify({ sequence: -1 }));
    expect(() => report()).toThrow(/owner-report\.json/);
  });

  it("issues no report for a missing, old-format or invalid policy", async () => {
    expect(() => report()).toThrow();
    writeRaw({ allowedDomains: [], mode: "auto" });
    expect(() => report()).toThrow();
    expect(existsSync(ownerReportPath(state))).toBe(false);
  });
});

describe("capybara-device ceiling", () => {
  it("M1: the widening check runs on the locked policy, not an earlier read", async () => {
    writePolicy(state, {
      ...DEFAULT_POLICY,
      ownerCeiling: { fullAccess: true, restrictedProjectReach: "os-user" },
    });
    // the narrowing lands after `ceiling set` read the policy but before it writes
    const r = await cli(
      ["ceiling", "set", "--full-access", "allow", "--project-reach", "os-user"],
      {
        beforeWrite: () =>
          writePolicy(state, {
            ...DEFAULT_POLICY,
            ownerCeiling: { fullAccess: false, restrictedProjectReach: "workspace" },
          }),
      },
    );
    expect(r.code).toBe(2);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual({
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
  });

  it("M2: show says the reach is not enforced on protocol 2; mode auto says it sets OS-user reach", async () => {
    writePolicy(state, {
      ...DEFAULT_POLICY,
      ownerCeiling: { fullAccess: true, restrictedProjectReach: "workspace" },
    });
    const shown = await cli(["ceiling", "show"]);
    expect(shown.out).toMatch(/project reach takes effect only/i);
    const auto = await cli(["mode", "auto", "--yes"]);
    expect(auto.out).toMatch(/project reach: os-user/i);
  });

  it("shows the owner ceiling and the network baseline separately", async () => {
    writePolicy(state, {
      ...DEFAULT_POLICY,
      allowedDomains: ["a.test"],
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "os-user" },
    });
    writeCredential(state, {
      url: "https://x.test",
      connectUrl: "wss://x.test",
      credential: "c",
      orgId: "o",
      deviceId: "dev",
      dir: join(root, "device"),
      mode: "os",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1048576,
    });
    const r = await cli(["ceiling", "show"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Full access: denied/);
    expect(r.out).toMatch(/Project reach: os-user/);
    expect(r.out).toMatch(/Restricted network baseline: a\.test/);
    expect(r.out).toMatch(/Revision: [0-9a-f]{64}/);
    expect(r.out).toMatch(/organization/i);
  });

  it("narrows directly and requires both fields", async () => {
    writePolicy(state, DEFAULT_POLICY);
    expect((await cli(["ceiling", "set", "--full-access", "deny"])).code).toBe(2);
    const r = await cli([
      "ceiling",
      "set",
      "--full-access",
      "deny",
      "--project-reach",
      "workspace",
    ]);
    expect(r.code).toBe(0);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual({
      fullAccess: false,
      restrictedProjectReach: "workspace",
    });
  });

  it("widening needs --yes or a confirmed terminal answer", async () => {
    writePolicy(state, {
      ...DEFAULT_POLICY,
      ownerCeiling: { fullAccess: false, restrictedProjectReach: "workspace" },
    });
    const refused = await cli([
      "ceiling",
      "set",
      "--full-access",
      "allow",
      "--project-reach",
      "workspace",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/--yes/);
    expect(readPolicyFile(state).policy.ownerCeiling.fullAccess).toBe(false);
    const declined = await cli(
      ["ceiling", "set", "--full-access", "deny", "--project-reach", "os-user"],
      { tty: true, answer: "n" },
    );
    expect(declined.code).toBe(1);
    expect(readPolicyFile(state).policy.ownerCeiling.restrictedProjectReach).toBe("workspace");
    const confirmed = await cli(
      ["ceiling", "set", "--full-access", "deny", "--project-reach", "os-user"],
      { tty: true, answer: "y" },
    );
    expect(confirmed.code).toBe(0);
    expect(confirmed.out).toMatch(/outside the device's workspace/);
    const yes = await cli([
      "ceiling",
      "set",
      "--full-access",
      "allow",
      "--project-reach",
      "os-user",
      "--yes",
    ]);
    expect(yes.code).toBe(0);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual({
      fullAccess: true,
      restrictedProjectReach: "os-user",
    });
  });
});

describe("staged policy op with owner reports", () => {
  const policyReq = (args: Record<string, unknown>, op = "policy", id = "q1") =>
    ({ type: "req", id, op, args, deadlineMs: 1000 }) as KernelRequest;
  const source = { accountId: "acc", accountName: "Ann", via: "web" };
  const setup = () => {
    writePolicy(state, DEFAULT_POLICY);
    const store = new PolicyStore(state);
    const calls: string[] = [];
    const owner = {
      store,
      report: () => {
        calls.push("report");
        return report();
      },
      reconcile: async () => {
        calls.push("reconcile");
      },
    };
    const backend = {} as MacOperationBackend;
    return { owner, calls, backend };
  };

  it("narrows only, reconciles before answering, and answers with the new owner report", async () => {
    const { owner, calls, backend } = setup();
    const res = await serveOperationV3(
      backend,
      { id: "dev" },
      policyReq({ opId: "op1", source, ownerCeiling: { fullAccess: false } }),
      new AbortController().signal,
      undefined,
      owner,
    );
    expect(res).toMatchObject({
      ok: true,
      result: {
        policy: { mode: "sandbox" },
        ownerCeiling: { fullAccess: false, restrictedProjectReach: "os-user", sequence: 0 },
      },
    });
    expect(calls).toEqual(["reconcile", "report"]);
    const status = await serveOperationV3(
      backend,
      { id: "dev" },
      policyReq({ opId: "op1" }, "policyStatus", "q2"),
      new AbortController().signal,
      undefined,
      owner,
    );
    expect(status).toMatchObject({
      ok: true,
      result: { outcome: "applied", ownerCeiling: { fullAccess: false } },
    });
  });

  it("refuses any widening over the wire and writes nothing", async () => {
    const { owner, calls, backend } = setup();
    writePolicy(state, { ...DEFAULT_POLICY, ownerCeiling: { ...SANDBOX_OWNER_CEILING } });
    for (const ownerCeiling of [{ fullAccess: true }, { restrictedProjectReach: "os-user" }]) {
      const res = await serveOperationV3(
        backend,
        { id: "dev" },
        policyReq({ opId: `w${calls.length}`, source, ownerCeiling }),
        new AbortController().signal,
        undefined,
        owner,
      );
      expect(res.ok).toBe(false);
    }
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual(SANDBOX_OWNER_CEILING);
    expect(calls).toEqual([]);
  });
});

describe("owner-denied paths in canonical form", () => {
  it("denies a symlinked home's secrets and a symlinked ~/.aws by their real paths too", async () => {
    const real = join(root, "real-home");
    mkdirSync(join(real, ".ssh"), { recursive: true });
    const awsData = join(root, "aws-data");
    mkdirSync(awsData);
    symlinkSync(real, join(root, "home"));
    symlinkSync(awsData, join(real, ".aws"));
    writePolicy(state, DEFAULT_POLICY);
    const denied = (await strict()).restrictedDeniedReadRoots;
    const canonicalRoot = realpathSync(root);
    for (const path of [
      join(root, "home", ".ssh"),
      join(canonicalRoot, "real-home", ".ssh"),
      join(canonicalRoot, "aws-data"),
      // a secret path that does not exist yet: its real parent plus the missing name
      join(canonicalRoot, "real-home", ".kube"),
      // the device's own state directory, by its real path (runtime files live under it)
      realpathSync(state),
    ])
      expect(denied).toContain(path);
  });
});
