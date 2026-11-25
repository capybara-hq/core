import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecResult } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAC_SERVICE_CHROMIUM_MACH_NAMES,
  macNetworkConfig,
  macServiceMachRules,
  startMacOperationWorker,
} from "../src/exec/operation-worker.js";
import { removeTempParent, testDeviceId } from "./mac-temp-parent.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

// Chromium's Mach services for device services (core#843): a device service launch may register
// and look up exactly the two name kinds the full Chromium build checks in with at start; an agent
// command gets none of it, and the service's file and network confinement stay as they were. The
// darwin cases run real Seatbelt through the patched runtime (`allowMachRegister`).

const DEVICE_ID = testDeviceId("mac-service-mach");
const darwin = process.platform === "darwin";
const require = createRequire(import.meta.url);
const srt = dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json"));

/** Registers (`reg:`) or looks up (`look:`) Mach names; prints `<op>:<name>=<kern_return_t>`. */
const MACH_PROBE = `import ctypes, sys
lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
bp = ctypes.c_uint.in_dll(lib, "bootstrap_port")
for arg in sys.argv[1:]:
    op, name = arg.split(":", 1)
    port = ctypes.c_uint(0)
    f = lib.bootstrap_check_in if op == "reg" else lib.bootstrap_look_up
    print("%s:%s=%d" % (op, name, f(bp, name.encode(), ctypes.byref(port))))
`;
/** BOOTSTRAP_NOT_PRIVILEGED: what Seatbelt answers a denied registration or lookup with. */
const DENIED = 1100;

describe("Chromium's Mach services for device services", () => {
  it("are exactly the two Chromium name kinds, as prefixes ending in their own dot", () => {
    expect(MAC_SERVICE_CHROMIUM_MACH_NAMES).toEqual([
      "com.google.chrome.for.testing.MachPortRendezvousServer.*",
      "com.google.chrome.for.testing.apps.*",
    ]);
    const base = macNetworkConfig({ hosts: [] }).network;
    // an agent command's network config (shared with services) registers nothing
    expect(base).not.toHaveProperty("allowMachRegister");
    expect(macServiceMachRules(base)).toEqual({
      allowMachLookup: ["com.apple.TrustEvaluationAgent", ...MAC_SERVICE_CHROMIUM_MACH_NAMES],
      allowMachRegister: [...MAC_SERVICE_CHROMIUM_MACH_NAMES],
    });
  });

  it("the patched runtime accepts them and refuses a bare wildcard", async () => {
    const { NetworkConfigSchema } = await import(
      pathToFileURL(join(srt, "dist/sandbox/sandbox-config.js")).href
    );
    const rules = macServiceMachRules(macNetworkConfig({ hosts: [] }).network);
    expect(
      NetworkConfigSchema.parse({ allowedDomains: [], deniedDomains: [], ...rules }),
    ).toMatchObject(rules);
    for (const bad of ["*", "", "a*b.c", "nodot*"])
      expect(() =>
        NetworkConfigSchema.parse({
          allowedDomains: [],
          deniedDomains: [],
          allowMachRegister: [bad],
        }),
      ).toThrow();
  });
});

describe.runIf(darwin)("real Seatbelt: Chromium's Mach services", () => {
  const workspace = { runtimeHash: "", cleanup: async () => {} };
  let root = "";
  beforeAll(async () => {
    Object.assign(workspace, await sealWorkspaceRuntime());
    root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-mach-")));
  });
  afterAll(async () => {
    await removeTempParent(DEVICE_ID);
    await workspace.cleanup();
    if (root !== "") await rm(root, { recursive: true, force: true });
  });

  /** Runs `command` restricted, as a device service launch (`service`) or an agent command. */
  async function run(command: string, service: boolean): Promise<ExecResult> {
    const id = `mach-${Math.random().toString(36).slice(2, 10)}`;
    const state = join(root, id);
    const tmp = join(state, "tmp");
    await mkdir(tmp, { recursive: true });
    const stateDir = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-mach-w-")));
    await writeFile(join(state, "mach.py"), MACH_PROBE);
    let out = "";
    const worker = await startMacOperationWorker(
      {
        kind: "exec",
        scope: {
          operationId: id,
          admitBeforeMs: Date.now() + 60_000,
          deviceId: DEVICE_ID,
          rootConversationId: "device-service",
          profileRevision: 0,
          ceilingRevision: "fixture",
          profile: "request-approval",
          actor: { accountId: "device-service", conversationId: "device-service" },
          tag: id,
          filesystem: { kind: "scoped", projectRoot: null, writeRoots: [state] },
          network: { kind: "none" },
        },
        grant: {
          full: false,
          readRoots: [state],
          writeRoots: [state],
          hosts: [],
          deniedReadRoots: [],
          revision: "fixture",
        },
        stateDir,
        pythonPath: "/usr/bin/python3",
        runtimeHash: workspace.runtimeHash,
        ...(service ? { service: { tmpDir: tmp, unixSockets: [state] } } : {}),
        beforeLaunch: async () => {},
        onLaunch: async () => {},
        onOutput: (b) => {
          out += b.toString();
        },
        args: {
          command: command.replaceAll("$STATE", state),
          cwd: state,
          timeoutMs: 30_000,
          maxOutputBytes: 64_000,
        },
      },
      AbortSignal.timeout(60_000),
    );
    await worker.ready;
    const result = (await worker.completion) as ExecResult;
    return { ...result, stdout: result.stdout || out };
  }

  const probe = (names: string[]) =>
    `/usr/bin/python3 $STATE/mach.py ${names.map((n) => `'${n}'`).join(" ")}`;
  const codes = (stdout: string) =>
    Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.lastIndexOf("=")), Number(l.slice(l.lastIndexOf("=") + 1))]),
    );
  const NAMES = [
    "reg:com.google.chrome.for.testing.MachPortRendezvousServer.4242",
    "reg:com.google.chrome.for.testing.apps.0123abcd",
    // anything else stays closed: a sibling Chromium name, another vendor's, a bare prefix
    "reg:com.google.chrome.for.testing.other",
    "reg:com.google.chrome.for.testing.MachPortRendezvousServer",
    "reg:org.chromium.Chromium.MachPortRendezvousServer.4242",
    "reg:com.apple.capybara-test",
  ];

  it("a device service registers only Chromium's two name kinds", async () => {
    const r = await run(probe(NAMES), true);
    expect(codes(r.stdout)).toEqual({
      "reg:com.google.chrome.for.testing.MachPortRendezvousServer.4242": 0,
      "reg:com.google.chrome.for.testing.apps.0123abcd": 0,
      "reg:com.google.chrome.for.testing.other": DENIED,
      "reg:com.google.chrome.for.testing.MachPortRendezvousServer": DENIED,
      "reg:org.chromium.Chromium.MachPortRendezvousServer.4242": DENIED,
      "reg:com.apple.capybara-test": DENIED,
    });
  });

  it("an agent command registers none of them", async () => {
    const r = await run(probe(NAMES), false);
    const got = codes(r.stdout);
    expect(Object.keys(got)).toHaveLength(NAMES.length);
    for (const name of NAMES) expect(got[name]).toBe(DENIED);
  });

  it("a device service's files and network stay confined as before", async () => {
    const outside = join(root, `outside-${Date.now()}`);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "s");
    const checks = [
      `echo x > ${outside}/w`,
      `cat ${outside}/secret`,
      "/usr/bin/curl -sS --max-time 5 -o /dev/null https://1.1.1.1/",
      "/usr/bin/nc -z -w 3 1.1.1.1 443",
    ];
    const command = checks
      .map((c) => `if ${c} >/dev/null 2>&1; then echo OPEN; else echo refused; fi`)
      .join("; ");
    for (const service of [true, false]) {
      const r = await run(`${command}; echo ok > $STATE/inside && cat $STATE/inside`, service);
      expect(r.stdout.trim().split("\n")).toEqual([...checks.map(() => "refused"), "ok"]);
    }
  });
});
