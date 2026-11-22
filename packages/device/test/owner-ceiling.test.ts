import {
  chmodSync,
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
import {
  type KernelRequest,
  parseOwnerCeilingReport,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCreateStaged, runCli } from "../src/cli.js";
import {
  CEILING_NEEDS_YES,
  CEILING_OTHER_CONNECTIONS_TEXT,
  CEILING_WIDENING_TEXT,
} from "../src/commands/ceiling.js";
import { connectionDir, connectionsDir, machineDirOfConnection } from "../src/connections.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import {
  readStrictOwnerCeiling,
  readStrictOwnerCeilingSync,
  within,
} from "../src/exec/operation-types.js";
import { issueOwnerReport, ownerReportPath } from "../src/owner-report.js";
import { PolicyStore } from "../src/policy-store.js";
import { serveOperationV3 } from "../src/server-ops.js";
import {
  DEFAULT_POLICY,
  defaultWorkDir,
  type OwnerCeilingPolicy,
  type Policy,
  policyPath,
  readCredential,
  readPolicyFile,
  writeCredential,
  writePolicy,
} from "../src/state.js";

/** The widest owner ceiling: outside the sandbox on, the open network, the whole machine. */
const FULL_OWNER_CEILING: OwnerCeilingPolicy = Object.freeze({
  outsideSandbox: true,
  network: "open",
  projectReach: "machine",
});
/** The narrowest owner ceiling. */
const SANDBOX_OWNER_CEILING: OwnerCeilingPolicy = Object.freeze({
  outsideSandbox: false,
  network: "allowlist",
  projectReach: "workspace",
});
/** The policy these tests were written against: outside the sandbox on, the open network. */
const FULL_POLICY: Policy = { ...DEFAULT_POLICY, ownerCeiling: { ...FULL_OWNER_CEILING } };
let root: string;
/** The machine directory: the program state root holding every connection. */
let machine: string;
let state: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "device-owner-ceiling-"));
  machine = join(root, "capybara-device");
  state = connectionDir(machine, "dev");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeRaw = (value: unknown) => {
  writePolicy(state, FULL_POLICY);
  writeFileSync(policyPath(state), `${JSON.stringify(value, null, 2)}\n`);
};
const onDisk = () => JSON.parse(readFileSync(policyPath(state), "utf8")) as Record<string, unknown>;
/** What {@link writePolicy} writes for `policy`, as a plain object. */
const onDiskOf = (policy: Policy) => {
  writePolicy(state, policy);
  return onDisk();
};
const strict = () =>
  readStrictOwnerCeiling({
    stateDir: state,
    stateRoot: machine,
    deviceId: "dev",
    dir: join(root, "device"),
    home: join(root, "home"),
  });
const report = () =>
  issueOwnerReport({
    stateDir: state,
    stateRoot: machine,
    deviceId: "dev",
    dir: join(root, "device"),
    home: join(root, "home"),
  });
const cli = async (
  argv: string[],
  opts: { tty?: boolean; answer?: string; beforeWrite?: () => void } = {},
) => {
  if (readCredential(state) === undefined) {
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
  }
  const out: string[] = [];
  const err: string[] = [];
  // other connections may exist: always name this one
  const code = await runCli([...argv, "-c", "dev"], {
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

describe("local owner policy format", () => {
  it("a new policy reads the whole machine and lists no project paths", () => {
    expect(DEFAULT_POLICY.ownerCeiling.projectReach).toBe("machine");
    expect(DEFAULT_POLICY.projectPaths).toEqual([]);
  });

  it("a missing policy file reads as the workspace reach", () => {
    const { policy, extra } = readPolicyFile(state);
    expect(policy.ownerCeiling).toEqual(SANDBOX_OWNER_CEILING);
    expect(policy.projectPaths).toEqual([]);
    expect(extra).toEqual({});
  });

  it("round-trips projectReach and projectPaths, keeping unknown keys", () => {
    writePolicy(
      state,
      {
        ...FULL_POLICY,
        ownerCeiling: { outsideSandbox: false, network: "open", projectReach: "paths" },
        projectPaths: ["/src/a", "/src/b"],
      },
      { future: { kept: true } },
    );
    expect(onDisk()).toEqual({
      future: { kept: true },
      version: 4,
      allowedDomains: [],
      allowCredentials: [],
      cpu: null,
      memoryMb: null,
      ownerCeiling: { outsideSandbox: false, network: "open", projectReach: "paths" },
      keepAwake: "while-busy",
      projectPaths: ["/src/a", "/src/b"],
    });
    const read = readPolicyFile(state);
    expect(read.policy.ownerCeiling.projectReach).toBe("paths");
    expect(read.policy.projectPaths).toEqual(["/src/a", "/src/b"]);
    expect(read.extra).toEqual({ future: { kept: true } });
    // absent project paths read as none
    const { projectPaths: _, ...rest } = onDisk();
    writeRaw(rest);
    expect(readPolicyFile(state).policy.projectPaths).toEqual([]);
  });

  it("refuses another version, a bad reach and relative or unnormalized project paths", () => {
    const good = onDiskOf(FULL_POLICY);
    for (const version of [3, 2, undefined, "4", 5]) {
      writeRaw({ ...good, version });
      expect(() => readPolicyFile(state)).toThrow(policyPath(state));
      expect(() => readPolicyFile(state)).toThrow(/capybara-device ceiling set/);
    }
    const ceiling = good.ownerCeiling as Record<string, unknown>;
    for (const bad of [
      { ...good, ownerCeiling: { ...ceiling, projectReach: "os-user" } },
      { ...good, ownerCeiling: { ...ceiling, projectReach: undefined } },
      {
        ...good,
        ownerCeiling: {
          outsideSandbox: true,
          network: "open",
          restrictedProjectReach: "os-user",
        },
      },
      { ...good, ownerCeiling: { ...ceiling, projectPaths: [] } },
      { ...good, ownerCeiling: { ...ceiling, network: "any" } },
      { ...good, projectPaths: ["rel"] },
      { ...good, projectPaths: ["/a/../b"] },
      { ...good, projectPaths: ["/a/"] },
      { ...good, projectPaths: ["/a//b"] },
      { ...good, projectPaths: ["/a/./b"] },
      { ...good, projectPaths: [""] },
      { ...good, projectPaths: ["/a\0b"] },
      { ...good, projectPaths: ["/a", "/a"] },
      { ...good, projectPaths: ["/"] },
      { ...good, projectPaths: "/a" },
      { ...good, projectPaths: [1] },
      { ...good, projectPaths: Array.from({ length: 101 }, (_, i) => `/p${i}`) },
    ]) {
      writeRaw(bad);
      expect(() => readPolicyFile(state), JSON.stringify(bad).slice(0, 200)).toThrow(
        policyPath(state),
      );
    }
    writeRaw({ ...good, projectPaths: Array.from({ length: 100 }, (_, i) => `/p${i}`) });
    expect(readPolicyFile(state).policy.projectPaths).toHaveLength(100);
    // the writer refuses what the reader would refuse, writing nothing
    writePolicy(state, FULL_POLICY);
    const before = readFileSync(policyPath(state), "utf8");
    expect(() => writePolicy(state, { ...FULL_POLICY, projectPaths: ["/a/"] })).toThrow(
      /projectPaths/,
    );
    expect(readFileSync(policyPath(state), "utf8")).toBe(before);
  });

  it("keeps outside the sandbox, network and project reach independent in the strict reader", async () => {
    writePolicy(state, {
      ...FULL_POLICY,
      allowedDomains: ["a.test"],
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "machine" },
    });
    expect(await strict()).toMatchObject({
      outsideSandbox: false,
      network: "allowlist",
      allowedDomains: ["a.test"],
      projectReach: "machine",
    });
    writePolicy(state, {
      ...FULL_POLICY,
      ownerCeiling: { outsideSandbox: true, network: "open", projectReach: "workspace" },
    });
    expect(await strict()).toMatchObject({
      outsideSandbox: true,
      network: "open",
      projectReach: "workspace",
    });
  });

  it("the strict reader, the store and a policy write refuse another version without writing", async () => {
    writeRaw({ ...onDiskOf(FULL_POLICY), version: 3 });
    const before = readFileSync(policyPath(state), "utf8");
    await expect(strict()).rejects.toThrow(/capybara-device ceiling set/);
    expect(() => new PolicyStore(state)).toThrow(/capybara-device ceiling set/);
    const store = new PolicyStore(state, { initial: FULL_POLICY });
    expect(() => store.update((p) => ({ ...p, allowedDomains: ["b.test"] }))).toThrow(
      /capybara-device ceiling set/,
    );
    expect((await cli(["policy", "add", "allowedDomains", "b.test"])).code).toBe(1);
    expect((await cli(["ceiling", "show"])).code).toBe(1);
    expect(readFileSync(policyPath(state), "utf8")).toBe(before);
  });

  it("ceiling set replaces another version from the closed policy, a widening confirmed", async () => {
    writeRaw({
      version: 3,
      allowedDomains: ["a.test"],
      ownerCeiling: { outsideSandbox: true, network: "open", restrictedProjectReach: "os-user" },
    });
    const narrowing = await cli(["ceiling", "set", "--project-reach", "workspace"]);
    expect(narrowing.code).toBe(0);
    // keep-awake off: the rewrite widens nothing
    expect(onDisk()).toEqual({
      version: 4,
      allowedDomains: [],
      allowCredentials: [],
      cpu: null,
      memoryMb: null,
      ownerCeiling: SANDBOX_OWNER_CEILING,
      keepAwake: "off",
      projectPaths: [],
    });
    expect(narrowing.out.split("\n")).toContain(
      `Replaced ${policyPath(state)} (format 3, this program reads format 4): allowed domains, ` +
        "credentials, resource limits and keep-awake are back to their defaults; set them again " +
        "with capybara-device policy / keep-awake.",
    );
    // a newer format is named too, and a current file gets no notice
    writeRaw({ ...onDiskOf(FULL_POLICY), version: 5 });
    const newer = await cli(["ceiling", "set", "--project-reach", "workspace"]);
    expect(newer.code).toBe(0);
    expect(newer.out).toContain("(format 5, this program reads format 4)");
    const current = await cli(["ceiling", "set", "--project-reach", "workspace"]);
    expect(current.code).toBe(0);
    expect(current.out).not.toContain("Replaced");
    writeRaw({ version: 3, ownerCeiling: {} });
    const refused = await cli(["ceiling", "set", "--network", "open"]);
    expect(refused.code).toBe(2);
    expect(onDisk().version).toBe(3);
    const yes = await cli(["ceiling", "set", "--network", "open", "--yes"]);
    expect(yes.code).toBe(0);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual({
      ...SANDBOX_OWNER_CEILING,
      network: "open",
    });
  });
});

describe("owner report sequence sidecar", () => {
  it("issues with another connection unreadable: only sandboxed work is refused", async () => {
    writePolicy(state, FULL_POLICY);
    const before = report();
    const other = connectionDir(machine, "b");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "credential.json"), "{ nope", { mode: 0o600 });
    const after = report();
    expect(parseOwnerCeilingReport(after)).toEqual(after);
    // a new revision (the deployment learns the ceiling changed), the report itself still goes out
    expect(after.revision).not.toBe(before.revision);
    expect((await strict()).unreadableConnections.map((u) => u.deviceId)).toEqual(["b"]);
  });

  it("advances the sequence once per newly observed policy revision", async () => {
    writePolicy(state, FULL_POLICY);
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
    writePolicy(state, FULL_POLICY);
    const edited = report();
    expect(edited.revision).not.toBe(first.revision);
    expect(edited.sequence).toBe(1);
    expect({ ...edited, revision: first.revision, sequence: 0 }).toEqual(first);
  });

  it("reports owner fields exactly in the protocol report", async () => {
    writePolicy(state, {
      ...FULL_POLICY,
      allowedDomains: ["*.example.com"],
      ownerCeiling: { outsideSandbox: false, network: "allowlist", projectReach: "machine" },
    });
    const machine = report();
    expect(machine).toEqual({
      version: 3,
      revision: machine.revision,
      sequence: machine.sequence,
      outsideSandbox: false,
      network: "allowlist",
      allowedDomains: ["*.example.com"],
      projectReach: "machine",
    });
    expect(parseOwnerCeilingReport(machine)).toEqual(machine);
    writePolicy(state, {
      ...FULL_POLICY,
      allowedDomains: ["a.test"],
      ownerCeiling: { outsideSandbox: true, network: "open", projectReach: "paths" },
      projectPaths: ["/src/a", "/src/b"],
    });
    const paths = report();
    expect(paths).toMatchObject({ outsideSandbox: true, network: "open", projectReach: "paths" });
    expect(Object.keys(paths).sort()).toEqual(Object.keys(machine).sort());
    expect(paths).not.toHaveProperty("projectPaths");
    expect(paths).not.toHaveProperty("restrictedProjectReach");
    expect(parseOwnerCeilingReport(paths)).toEqual(paths);
  });

  it("blocks on a corrupt sidecar instead of restarting at zero", async () => {
    writePolicy(state, FULL_POLICY);
    report();
    writePolicy(state, FULL_POLICY);
    writeFileSync(ownerReportPath(state), "{ nope");
    expect(() => report()).toThrow(/owner-report\.json/);
    writeFileSync(ownerReportPath(state), JSON.stringify({ sequence: -1 }));
    expect(() => report()).toThrow(/owner-report\.json/);
  });

  it("issues no report for a missing, old-format or invalid policy", async () => {
    expect(() => report()).toThrow();
    writeRaw({ ...onDiskOf(FULL_POLICY), version: 3 });
    expect(() => report()).toThrow();
    expect(existsSync(ownerReportPath(state))).toBe(false);
  });
});

describe("capybara-device ceiling", () => {
  const NARROW = {
    outsideSandbox: false,
    network: "allowlist",
    projectReach: "workspace",
  } as const;
  it("M1: the widening check runs on the locked policy, not an earlier read", async () => {
    writePolicy(state, FULL_POLICY);
    // the narrowing lands after `ceiling set` read the policy but before it writes
    const r = await cli(["ceiling", "set", "--outside-sandbox", "on", "--network", "open"], {
      beforeWrite: () => writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } }),
    });
    expect(r.code).toBe(2);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual(NARROW);
  });

  it("show no longer carries the protocol 2 note, and the daily mode command is gone", async () => {
    writePolicy(state, FULL_POLICY);
    const shown = await cli(["ceiling", "show"]);
    expect(shown.out).not.toMatch(/project reach takes effect only/i);
    const mode = await cli(["mode", "auto", "--yes"]);
    expect(mode.code).toBe(2);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual(FULL_OWNER_CEILING);
  });

  it("shows the owner ceiling and the sandbox allowlist separately", async () => {
    writePolicy(state, {
      ...FULL_POLICY,
      allowedDomains: ["a.test"],
      ownerCeiling: {
        outsideSandbox: false,
        network: "allowlist",
        projectReach: "machine",
      },
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
    expect(r.out).toMatch(/Outside the sandbox: off/);
    expect(r.out).toMatch(/Network: allowlist/);
    expect(r.out).toMatch(/Project reach: machine/);
    expect(r.out).toMatch(/Sandbox allowlist: a\.test/);
    expect(r.out).toMatch(/Revision: [0-9a-f]{64}/);
    expect(r.out).toMatch(/organization/i);
    expect(r.out).not.toMatch(/Full access: /);
  });

  it("narrows directly, changes only the named fields and needs at least one", async () => {
    writePolicy(state, FULL_POLICY);
    expect((await cli(["ceiling", "set"])).code).toBe(2);
    // the old flag is gone, with a pointer to the new one
    const old = await cli(["ceiling", "set", "--full-access", "deny"]);
    expect(old.code).toBe(2);
    expect(old.err).toMatch(/--outside-sandbox/);
    for (const bad of [
      ["--outside-sandbox", "yes"],
      ["--network", "closed"],
      ["--project-reach", "home"],
    ])
      expect((await cli(["ceiling", "set", ...bad])).code, bad.join(" ")).toBe(2);
    const r = await cli(["ceiling", "set", "--outside-sandbox", "off"]);
    expect(r.code).toBe(0);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual({
      ...FULL_OWNER_CEILING,
      outsideSandbox: false,
    });
    const n = await cli([
      "ceiling",
      "set",
      "--network",
      "allowlist",
      "--project-reach",
      "workspace",
    ]);
    expect(n.code).toBe(0);
    expect(n.out).toMatch(/allowlist/);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual(NARROW);
  });

  it("widening needs --yes or a confirmed terminal answer, and shows the new text", async () => {
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } });
    for (const flags of [
      ["--outside-sandbox", "on"],
      ["--network", "open"],
      ["--project-reach", "machine"],
    ]) {
      const refused = await cli(["ceiling", "set", ...flags]);
      expect(refused.code, flags.join(" ")).toBe(2);
      expect(refused.err).toMatch(/--yes/);
      expect(refused.out).toBe(CEILING_WIDENING_TEXT);
      expect(readPolicyFile(state).policy.ownerCeiling).toEqual(NARROW);
    }
    // the widening text tells the new model: the sandbox under every profile
    expect(CEILING_WIDENING_TEXT).toMatch(/run in the sandbox under every profile/);
    expect(CEILING_WIDENING_TEXT).toMatch(/outside the sandbox/);
    expect(CEILING_WIDENING_TEXT).toMatch(/open network/);
    expect(CEILING_WIDENING_TEXT).not.toMatch(/switches to Full run commands as you/);
    const declined = await cli(["ceiling", "set", "--network", "open"], {
      tty: true,
      answer: "n",
    });
    expect(declined.code).toBe(1);
    expect(readPolicyFile(state).policy.ownerCeiling.network).toBe("allowlist");
    const confirmed = await cli(["ceiling", "set", "--project-reach", "machine"], {
      tty: true,
      answer: "y",
    });
    expect(confirmed.code).toBe(0);
    expect(confirmed.out).toContain(
      "Sandboxed work may read the whole machine except secrets, this program's state and other connections.",
    );
    const yes = await cli([
      "ceiling",
      "set",
      "--outside-sandbox",
      "on",
      "--network",
      "open",
      "--yes",
    ]);
    expect(yes.code).toBe(0);
    expect(readPolicyFile(state).policy.ownerCeiling).toEqual(FULL_OWNER_CEILING);
    // the local audit line names the new fields
    expect(readFileSync(join(state, "commands.log"), "utf8")).toMatch(
      /ceiling set outsideSandbox on, network open, projectReach machine/,
    );
  });
  it("widening the reach needs --yes; narrowing it does not", async () => {
    for (const [from, to] of [
      ["workspace", "paths"],
      ["paths", "machine"],
    ] as const) {
      writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW, projectReach: from } });
      const r = await cli(["ceiling", "set", "--project-reach", to]);
      expect(r.code, `${from} -> ${to}`).toBe(2);
      expect(r.err).toContain(CEILING_NEEDS_YES);
      expect(readPolicyFile(state).policy.ownerCeiling.projectReach).toBe(from);
    }
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW, projectReach: "machine" } });
    const narrowed = await cli(["ceiling", "set", "--project-reach", "workspace"]);
    expect(narrowed.code).toBe(0);
    expect(narrowed.out).toMatch(/Project reach: workspace/);
    expect(narrowed.out).not.toMatch(/Sandboxed work may read/);
    expect(readPolicyFile(state).policy.ownerCeiling.projectReach).toBe("workspace");
    // the paths reach names how many paths it lists, and how to add one when none is listed
    const paths = await cli(["ceiling", "set", "--project-reach", "paths", "--yes"]);
    expect(paths.code).toBe(0);
    expect(paths.out).toMatch(/Project reach: paths \(0 listed\)/);
    expect(paths.out).toContain(
      "Sandboxed work may read the listed project paths outside the device's workspace.",
    );
    expect(paths.out).not.toMatch(/Sandboxed work may read the whole machine/);
    expect(paths.out).toContain(
      "No project paths are listed yet: capybara-device policy add projectPaths <dir>",
    );
    writePolicy(state, {
      ...FULL_POLICY,
      ownerCeiling: { ...NARROW, projectReach: "paths" },
      projectPaths: ["/srv/a", "/srv/b"],
    });
    const shown = await cli(["ceiling", "show"]);
    expect(shown.out).toMatch(/Project reach: paths \(2 listed\)/);
    expect(shown.out).not.toMatch(/No project paths are listed yet/);
    // the widening text explains the machine and paths reaches; os-user is gone
    expect(CEILING_WIDENING_TEXT).toContain(
      "The machine reach lets sandboxed work read the whole machine except secrets, this " +
        "program's state and other connections; the paths reach only the listed project paths.",
    );
    expect(CEILING_WIDENING_TEXT).not.toMatch(/os-user/);
  });

  it("outside the sandbox on names the other connections when there are some", async () => {
    const connect = (id: string) =>
      writeCredential(connectionDir(machine, id), {
        url: `https://${id}.test`,
        connectUrl: `wss://${id}.test/device/connect`,
        credential: "c",
        orgId: "o",
        deviceId: id,
        dir: join(root, `work-${id}`),
        mode: "os",
        reconnectGraceSeconds: 120,
        maxFrameBytes: 1048576,
      });
    // this connection alone (the cli helper logs "dev" in): no other connection to name
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } });
    const single = await cli(["ceiling", "set", "--outside-sandbox", "on", "--yes"]);
    expect(single.code).toBe(0);
    expect(single.out).toContain(CEILING_WIDENING_TEXT);
    expect(single.out).not.toContain(CEILING_OTHER_CONNECTIONS_TEXT);
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } });
    connect("two");
    const two = await cli(["ceiling", "set", "--outside-sandbox", "on", "--yes"]);
    expect(two.code).toBe(0);
    const lines = two.out.split("\n");
    expect(lines.indexOf(CEILING_OTHER_CONNECTIONS_TEXT)).toBe(
      lines.indexOf(CEILING_WIDENING_TEXT) + 1,
    );
    // an unreadable connection counts too
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } });
    rmSync(join(connectionsDir(machine), "two"), { recursive: true });
    mkdirSync(join(connectionsDir(machine), "broken"), { recursive: true });
    writeFileSync(join(connectionsDir(machine), "broken", "credential.json"), "{", { mode: 0o600 });
    const broken = await cli(["ceiling", "set", "--outside-sandbox", "on", "--yes"]);
    expect(broken.out).toContain(CEILING_OTHER_CONNECTIONS_TEXT);
    // and so does a logged-out one (no credential.json; its state and work dir remain)
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } });
    rmSync(join(connectionsDir(machine), "broken"), { recursive: true });
    writePolicy(connectionDir(machine, "out"), DEFAULT_POLICY);
    const loggedOut = await cli(["ceiling", "set", "--outside-sandbox", "on", "--yes"]);
    expect(loggedOut.code).toBe(0);
    expect(loggedOut.out).toContain(CEILING_OTHER_CONNECTIONS_TEXT);
    // the changed-meanwhile refusal names them again with the widening text
    writePolicy(state, FULL_POLICY);
    const meanwhile = await cli(["ceiling", "set", "--outside-sandbox", "on"], {
      beforeWrite: () => writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } }),
    });
    expect(meanwhile.code).toBe(2);
    expect(meanwhile.err).toMatch(/changed meanwhile/);
    expect(meanwhile.out.split("\n")).toEqual([
      CEILING_WIDENING_TEXT,
      CEILING_OTHER_CONNECTIONS_TEXT,
    ]);
    // (a connections directory that cannot be listed resolves no connection, so `ceiling set`
    // never gets this far; otherConnectionsExist still counts it as others, fail closed)
    // a widening that leaves outside the sandbox off does not name them
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...NARROW } });
    const net = await cli(["ceiling", "set", "--network", "open", "--yes"]);
    expect(net.code).toBe(0);
    expect(net.out).not.toContain(CEILING_OTHER_CONNECTIONS_TEXT);
  });
});

describe("no owner-ceiling change over the wire", () => {
  it("refuses every policy request, a narrowing included, and writes nothing", async () => {
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...SANDBOX_OWNER_CEILING } });
    const calls: string[] = [];
    const owner = {
      store: new PolicyStore(state),
      report: () => {
        calls.push("report");
        return report();
      },
      reconcile: async () => {
        calls.push("reconcile");
      },
    };
    const source = { accountId: "acc", accountName: "Ann", via: "web" };
    for (const [i, ownerCeiling] of [
      { outsideSandbox: false },
      { network: "allowlist" },
      { fullAccess: true },
      { projectReach: "machine" },
      { outsideSandbox: true },
      { network: "open" },
    ].entries()) {
      const res = await serveOperationV3(
        {} as MacOperationBackend,
        { id: "dev" },
        {
          type: "req",
          id: `q${i}`,
          op: "policy",
          args: { opId: `w${i}`, source, ownerCeiling },
          deadlineMs: 1000,
        } as unknown as KernelRequest,
        new AbortController().signal,
        undefined,
        owner,
      );
      expect(res).toMatchObject({ ok: false, error: { message: "Unknown operation" } });
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
    writePolicy(state, FULL_POLICY);
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

describe("other connections under the machine layout", () => {
  it("connection A is denied B's working directory and state, and a logged-out C's default work dir", async () => {
    const home = join(root, "home");
    const bWork = join(root, "work-b");
    mkdirSync(bWork, { recursive: true });
    writeCredential(connectionDir(machine, "b"), {
      url: "https://b.test",
      connectUrl: "wss://b.test/device/connect",
      credential: "c",
      orgId: "o",
      deviceId: "b",
      dir: bWork,
      mode: "os",
      reconnectGraceSeconds: 120,
      maxFrameBytes: 1048576,
    });
    // C logged out: its directory (policy, logs) and its default working directory remain
    writePolicy(connectionDir(machine, "c"), DEFAULT_POLICY);
    const cWork = defaultWorkDir("c", home);
    mkdirSync(cWork, { recursive: true });
    writePolicy(state, FULL_POLICY);
    // the CLI's program root: the machine directory of the selected connection
    expect(machineDirOfConnection(state)).toBe(machine);
    const ceiling = await strict();
    expect(ceiling.unreadableConnections).toEqual([]);
    const denied = ceiling.restrictedDeniedReadRoots;
    const isDenied = (path: string) => denied.some((root) => within(path, root));
    expect(denied).toContain(bWork);
    expect(denied).toContain(cWork);
    // the whole machine directory, this connection's own included
    expect(denied).toContain(machine);
    for (const path of [
      bWork,
      join(connectionDir(machine, "b"), "credential.json"),
      join(connectionDir(machine, "c"), "policy.json"),
      cWork,
      join(state, "credential.json"),
    ])
      expect(isDenied(path), path).toBe(true);

    // the CLI threads the machine directory: A cannot list B's or C's directories as project paths
    for (const path of [bWork, cWork, connectionDir(machine, "b")]) {
      const r = await cli(["policy", "add", "projectPaths", path]);
      expect(r.code, path).toBe(2);
    }
    // and turning outside the sandbox on from A names the other connections
    writePolicy(state, { ...FULL_POLICY, ownerCeiling: { ...SANDBOX_OWNER_CEILING } });
    const set = await cli(["ceiling", "set", "--outside-sandbox", "on", "--yes"]);
    expect(set.code).toBe(0);
    expect(set.out.split("\n")).toContain(CEILING_OTHER_CONNECTIONS_TEXT);
  });
});

describe("the owner state layout fails closed", () => {
  it("refuses a state root that is not the machine directory of the connection", async () => {
    writePolicy(state, FULL_POLICY);
    const read = (stateDir: string, stateRoot: string) => () =>
      readStrictOwnerCeilingSync({
        stateDir,
        stateRoot,
        deviceId: "dev",
        dir: join(root, "device"),
        home: join(root, "home"),
      });
    // the connection dir as the root would scan <conn>/connections (absent: no other connection)
    expect(read(state, state)).toThrow(/Owner state layout mismatch/);
    expect(read(state, root)).toThrow(/Owner state layout mismatch/);
    // a flat state directory is no connection directory
    writePolicy(machine, FULL_POLICY);
    expect(read(machine, machine)).toThrow(/Owner state layout mismatch/);
    expect(read(machine, root)).toThrow(/Owner state layout mismatch/);
    expect(read(state, machine)).not.toThrow();
    expect(() => report()).not.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses a strict ceiling and an owner report while connections/ cannot be read",
    async () => {
      writePolicy(state, FULL_POLICY);
      // searchable (this connection's policy still opens) but not listable
      chmodSync(connectionsDir(machine), 0o100);
      try {
        await expect(strict()).rejects.toThrow(/cannot be read/);
        expect(() => report()).toThrow(/cannot be read/);
      } finally {
        chmodSync(connectionsDir(machine), 0o700);
      }
    },
  );

  it("refuses a strict ceiling and an owner report while connections/ is a symlink", async () => {
    // the real connection directory lives elsewhere; connections/ links to it
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writePolicy(join(elsewhere, "dev"), FULL_POLICY);
    mkdirSync(machine, { recursive: true });
    symlinkSync(elsewhere, connectionsDir(machine));
    await expect(strict()).rejects.toThrow(/cannot be read/);
    expect(() => report()).toThrow(/cannot be read/);
  });

  it("the runner the CLI starts builds its ceiling with the machine directory as the root", async () => {
    const seen: { stateDir: string; stateRoot: string }[] = [];
    vi.doMock("../src/staged-device.js", () => ({
      createStagedDevice: (o: { stateDir: string; stateRoot: string }) => {
        seen.push({ stateDir: o.stateDir, stateRoot: o.stateRoot });
        return {};
      },
    }));
    try {
      writePolicy(state, FULL_POLICY);
      const cred = {
        url: "https://x.test",
        connectUrl: "wss://x.test",
        credential: "c",
        orgId: "o",
        deviceId: "dev",
        dir: join(root, "device"),
        mode: "os" as const,
        reconnectGraceSeconds: 120,
        maxFrameBytes: 1048576,
      };
      writeCredential(state, cred);
      await defaultCreateStaged(state, join(root, "home"))(cred, new PolicyStore(state));
      expect(seen).toEqual([{ stateDir: state, stateRoot: machine }]);
      const ceiling = readStrictOwnerCeilingSync({
        ...(seen[0] as { stateDir: string; stateRoot: string }),
        deviceId: "dev",
        dir: cred.dir,
        home: join(root, "home"),
      });
      expect(ceiling.restrictedDeniedReadRoots).toContain(machine);
      // a flat state directory never gets a runner
      expect(() => defaultCreateStaged(machine, join(root, "home"))).toThrow(
        /not a connection directory/,
      );
    } finally {
      vi.doUnmock("../src/staged-device.js");
    }
  });
});
