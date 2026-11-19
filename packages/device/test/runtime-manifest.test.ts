import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxPermissionUnsupportedError } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalEnvironment,
  canonicalManifest,
  collectEnvironment,
  type EnvironmentFacts,
  enumerateInstalled,
  environmentHash,
  hashRegularFile,
  helperPythonSources,
  installedLayout,
  type ManifestLayout,
  manifestHash,
  moduleImports,
  pythonImports,
  RuntimeManifestError,
  verifyInstalledRuntime,
} from "../src/exec/runtime-manifest.js";
import { acquireSealedRuntime } from "../src/exec/runtime-source.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** An owned installed-program fixture: emitted helper modules, an SDK and a runtime package. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-manifest-")));
  dirs.push(root);
  const pkg = join(root, "device");
  const file = async (path: string, text: string) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  await file(join(pkg, "package.json"), JSON.stringify({ name: "@capybara-hq/device" }));
  await file(
    join(pkg, "dist/exec/worker.js"),
    'import { a } from "./a.js";\nimport "@capybara-hq/plugin-sdk";\nimport "node:fs";\n// import("not real")\nconst s = "import(x)";\n',
  );
  await file(join(pkg, "dist/exec/a.js"), 'export const a = await import("./b.js");\n');
  await file(join(pkg, "dist/exec/b.js"), "export {};\n");
  const sdk = join(pkg, "node_modules/@capybara-hq/plugin-sdk");
  await file(
    join(sdk, "package.json"),
    JSON.stringify({ name: "@capybara-hq/plugin-sdk", main: "./dist/index.js", type: "module" }),
  );
  await file(join(sdk, "dist/index.js"), 'export * from "./x.js";\nimport "dep-lib";\n');
  await file(join(sdk, "dist/x.js"), "export const x = 1;\n");
  const lib = join(sdk, "node_modules/dep-lib");
  await file(
    join(lib, "package.json"),
    JSON.stringify({ name: "dep-lib", version: "1.0.0", main: "i.js" }),
  );
  await file(join(lib, "i.js"), "module.exports = 1;\n");
  const rt = join(pkg, "node_modules/@fixture/runtime");
  await file(
    join(rt, "package.json"),
    JSON.stringify({
      name: "@fixture/runtime",
      version: "0.0.1",
      main: "dist/index.js",
      dependencies: { "rt-dep": "1" },
    }),
  );
  await file(join(rt, "dist/index.js"), "module.exports = {};\n");
  await file(join(rt, "vendor/helper.bin"), "\u0000binary");
  const rtDep = join(pkg, "node_modules/rt-dep");
  await file(
    join(rtDep, "package.json"),
    JSON.stringify({ name: "rt-dep", version: "2.0.0", main: "i.js" }),
  );
  await file(join(rtDep, "i.js"), "module.exports = 2;\n");
  const layout: ManifestLayout = {
    packageRoot: pkg,
    helperModules: ["dist/exec/worker.js"],
    runtimePackages: ["@fixture/runtime"],
    inline: { "inline/helper.py": "print('hi')\n" },
  };
  const ship = async () => {
    const { runtime, helpers } = await enumerateInstalled(layout);
    await writeFile(
      join(pkg, "dist/runtime-manifest.json"),
      JSON.stringify({ version: 1, runtime, helpers }),
    );
    return { runtime, helpers };
  };
  return { pkg, rt, sdk, layout, ship, file };
}
const env = { pythonPath: "/usr/bin/python3", roots: { workspace: "/w", skills: "/s", tmp: "/t" } };

describe("canonical manifest", () => {
  it("sorts by code point, fixes the tuple shape and hashes the exact UTF-8 bytes", () => {
    const entries = [
      ["b", 1, "1".repeat(64)],
      ["B", 2, "2".repeat(64)],
      ["a/c", 0, sha("")],
    ] as const;
    const text = canonicalManifest("runtime", entries);
    expect(text).toBe(
      `[1,"runtime",[["B",2,"${"2".repeat(64)}"],["a/c",0,"${sha("")}"],["b",1,"${"1".repeat(64)}"]]]`,
    );
    expect(manifestHash("runtime", entries)).toBe(sha(text));
    expect(manifestHash("helpers", entries)).not.toBe(manifestHash("runtime", entries));
  });
  it("refuses entries that could alias or escape", () => {
    const ok = ["x", 1, "a".repeat(64)] as const;
    for (const bad of [
      [ok, ok],
      [["../x", 1, "a".repeat(64)]],
      [["/x", 1, "a".repeat(64)]],
      [["a//b", 1, "a".repeat(64)]],
      [["é", 1, "a".repeat(64)]],
      [["x", -1, "a".repeat(64)]],
      [["x", 1, "A".repeat(64)]],
      [["x", 1]],
    ])
      expect(() => canonicalManifest("helpers", bad as never)).toThrow(RuntimeManifestError);
  });
  it("finds static and literal dynamic imports and refuses ones it cannot enumerate", () => {
    expect(
      moduleImports(
        'import a from "./a.js";\nexport * from "../b.js";\nawait import("./c.js");',
        "m",
      ),
    ).toEqual(["./a.js", "../b.js", "./c.js"]);
    expect(() => moduleImports("const m = await import(name);", "m")).toThrow(
      "cannot be enumerated",
    );
    expect(() => moduleImports("const m = `${await import(name)}`;", "m")).toThrow();
    // a declared expression is removed first; its absence is itself a failure
    expect(moduleImports("await import(rt)", "m", ["import(rt)"])).toEqual([]);
    expect(() => moduleImports("", "m", ["import(rt)"])).toThrow("known import");
  });
});

describe("installed closure", () => {
  it("covers the emitted helper closure, inline sources and the runtime dependency closure", async () => {
    const f = await fixture();
    const { runtime, helpers } = await f.ship();
    expect(helpers.map((e) => e[0])).toEqual([
      "inline/helper.py",
      "node_modules/@capybara-hq/plugin-sdk/dist/index.js",
      "node_modules/@capybara-hq/plugin-sdk/dist/x.js",
      "package/dist/exec/a.js",
      "package/dist/exec/b.js",
      "package/dist/exec/worker.js",
    ]);
    expect(runtime.map((e) => e[0])).toEqual([
      "meta/@fixture/runtime@0.0.1",
      "meta/dep-lib@1.0.0",
      "meta/rt-dep@2.0.0",
      "node_modules/@fixture/runtime@0.0.1/dist/index.js",
      "node_modules/@fixture/runtime@0.0.1/package.json",
      "node_modules/@fixture/runtime@0.0.1/vendor/helper.bin",
      "node_modules/dep-lib@1.0.0/i.js",
      "node_modules/dep-lib@1.0.0/package.json",
      "node_modules/rt-dep@2.0.0/i.js",
      "node_modules/rt-dep@2.0.0/package.json",
    ]);
    // real bytes, never a placeholder
    const b = helpers.find((e) => e[0] === "package/dist/exec/b.js");
    expect(b).toEqual(["package/dist/exec/b.js", 11, sha("export {};\n")]);
  });

  it("verifies the shipped manifest and refuses changed, missing, extra or linked files", async () => {
    const f = await fixture();
    const shipped = await f.ship();
    const verified = await verifyInstalledRuntime(env, f.layout);
    expect(verified.runtimeHash).toBe(manifestHash("runtime", shipped.runtime));
    expect(verified.helperHash).toBe(manifestHash("helpers", shipped.helpers));
    expect(verified.imageFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await f.file(join(f.pkg, "dist/exec/b.js"), "export {}; // changed\n");
    await expect(verifyInstalledRuntime(env, f.layout)).rejects.toThrow(
      "changed package/dist/exec/b.js",
    );
    await f.file(join(f.pkg, "dist/exec/b.js"), "export {};\n");
    await f.file(join(f.rt, "vendor/extra.bin"), "x");
    await expect(verifyInstalledRuntime(env, f.layout)).rejects.toThrow("unexpected");
    await rm(join(f.rt, "vendor/extra.bin"));
    await rm(join(f.rt, "vendor/helper.bin"));
    await expect(verifyInstalledRuntime(env, f.layout)).rejects.toThrow("missing");
    await symlink("/etc/hosts", join(f.rt, "vendor/helper.bin"));
    await expect(verifyInstalledRuntime(env, f.layout)).rejects.toThrow("not a regular file");
    await rm(join(f.rt, "vendor/helper.bin"));
    await f.file(join(f.rt, "vendor/helper.bin"), "\u0000binary");
    await expect(verifyInstalledRuntime(env, f.layout)).resolves.toEqual(verified);
    // a changed inline helper source is a changed helper set
    await expect(
      verifyInstalledRuntime(env, { ...f.layout, inline: { "inline/helper.py": "print(2)\n" } }),
    ).rejects.toThrow("changed inline/helper.py");
  });

  it("fails generation on a dynamic import it cannot enumerate, and without a manifest", async () => {
    const f = await fixture();
    await expect(verifyInstalledRuntime(env, f.layout)).rejects.toThrow("no runtime manifest");
    await f.file(join(f.pkg, "dist/exec/b.js"), "export const m = await import(process.env.X);\n");
    await expect(enumerateInstalled(f.layout)).rejects.toThrow("cannot be enumerated");
  });

  it("hashes through the opened handle and refuses a symlinked file", async () => {
    const f = await fixture();
    const target = join(f.pkg, "dist/exec/b.js");
    expect(await hashRegularFile(target)).toEqual({ size: 11, sha256: sha("export {};\n") });
    await symlink(target, join(f.pkg, "link.js"));
    await expect(hashRegularFile(join(f.pkg, "link.js"))).rejects.toThrow(RuntimeManifestError);
  });

  it("enumerates the real installed helper and sandbox runtime closure of this program", async () => {
    const layout = installedLayout();
    // tests run from source: the emitted modules come from a build, so only the runtime part and
    // the inline helper sources are checked against the files on disk here
    const { runtime, helpers } = await enumerateInstalled({ ...layout, helperModules: [] });
    const meta = runtime.filter((e) => e[0].startsWith("meta/")).map((e) => e[0]);
    expect(meta).toContain("meta/@anthropic-ai/sandbox-runtime@0.0.81");
    const pkgJson = runtime.find(
      (e) => e[0] === "node_modules/@anthropic-ai/sandbox-runtime@0.0.81/package.json",
    );
    const real = await readFile(
      join(layout.packageRoot, "node_modules/@anthropic-ai/sandbox-runtime/package.json"),
    );
    expect(pkgJson).toEqual([pkgJson?.[0], real.byteLength, sha(real)]);
    expect(helpers.map((e) => e[0])).toEqual([
      "inline/linux-device-agent.py",
      "inline/linux-sandbox.py",
      "inline/mac-worker.mjs",
      "inline/native-files.py",
      "inline/native-helper-prelude.py",
      "inline/output-spool-helper.py",
    ]);
  });
});

describe("verified runtime closure: verify-to-launch pinning (B-7)", () => {
  async function sealed() {
    const f = await fixture();
    await f.ship();
    const state = await realpath(await mkdtemp(join(tmpdir(), "cap-seal-")));
    dirs.push(state);
    const verified = await verifyInstalledRuntime(env, f.layout, { stageIn: state });
    bound = verified.runtimeHash;
    return { ...f, state, verified, dep: join(f.pkg, "node_modules/rt-dep/i.js") };
  }
  // the runtime hash the (simulated) binding attested
  let bound = "";
  const sealedRuntimeEntry = async (hash: string | undefined = bound) => {
    const held = await acquireSealedRuntime(hash);
    held.release();
    return held.entry;
  };
  const refused = (pattern: RegExp, hash?: string) => async () => {
    const error = await sealedRuntimeEntry(hash ?? bound).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SandboxPermissionUnsupportedError);
    expect((error as Error).message).toMatch(pattern);
  };

  // first in the file: no test before it verified anything in this process
  it("refuses before any verification", refused(/not been verified/));

  it("launches from a private staged copy of exactly the verified bytes", async () => {
    const f = await sealed();
    const entry = await sealedRuntimeEntry();
    expect(entry.startsWith(join(f.state, "operation-runtime/"))).toBe(true);
    expect(await readFile(entry, "utf8")).toBe(await readFile(join(f.rt, "dist/index.js"), "utf8"));
    // the staged runtime resolves its dependencies inside the staged copy, never the install
    const req = createRequire(entry);
    expect(req("rt-dep")).toBe(2);
    expect(req.resolve("rt-dep").startsWith(join(f.state, "operation-runtime/"))).toBe(true);
    expect((await stat(entry)).mode & 0o222).toBe(0);
    // unchanged bytes keep launching, also when a file is rewritten with the same bytes
    expect(await sealedRuntimeEntry()).toBe(entry);
    await writeFile(f.dep, "module.exports = 2;\n");
    expect(await sealedRuntimeEntry()).toBe(entry);
  });

  it("refuses the launch after a byte changed in the installed closure", async () => {
    const f = await sealed();
    await writeFile(f.dep, "module.exports = 3;\n");
    await refused(/changed after it was verified \(changed .*rt-dep\/i\.js\).*restart/)();
    await writeFile(f.dep, "module.exports = 2;\n");
    expect(await sealedRuntimeEntry()).toMatch(/operation-runtime/);
  });

  it("refuses a replaced file, a symlink swap and an added file", async () => {
    const f = await sealed();
    await rm(f.dep);
    await refused(/missing .*rt-dep\/i\.js/)();
    await writeFile(f.dep, "module.exports = 'other';\n");
    await refused(/changed .*rt-dep\/i\.js/)();
    // a link to identical bytes is still not the verified regular file
    const copy = join(f.pkg, "copy.js");
    await writeFile(copy, "module.exports = 2;\n");
    await rm(f.dep);
    await symlink(copy, f.dep);
    await refused(/rt-dep\/i\.js is no longer a regular file/)();
    await rm(f.dep);
    await copyFile(copy, f.dep);
    expect(await sealedRuntimeEntry()).toMatch(/operation-runtime/);
    await writeFile(join(f.rt, "dist/extra.js"), "x");
    await refused(/unexpected .*dist\/extra\.js/)();
  });

  it("refuses a staged copy changed after staging", async () => {
    await sealed();
    const entry = await sealedRuntimeEntry();
    await chmod(entry, 0o600);
    await writeFile(entry, "module.exports = { evil: true };\n");
    await refused(/staged copy/)();
  });

  it("refuses a staged dependency swapped for a link elsewhere", async () => {
    const f = await sealed();
    const entry = await sealedRuntimeEntry();
    const dep = createRequire(entry).resolve("rt-dep");
    await chmod(join(dep, ".."), 0o700);
    await rm(dep);
    await symlink(f.dep, dep);
    await refused(/staged copy/)();
  });

  it("refuses after a failed re-verification", async () => {
    const f = await sealed();
    await writeFile(f.dep, "module.exports = 3;\n");
    await expect(verifyInstalledRuntime(env, f.layout, { stageIn: f.state })).rejects.toThrow(
      "changed node_modules/rt-dep@2.0.0/i.js",
    );
    // the failed attempt leaves no seal (even with the old bytes back) and no partial copy
    await writeFile(f.dep, "module.exports = 2;\n");
    await refused(/not been verified/)();
    const staged = await readdir(join(f.state, "operation-runtime"));
    expect(staged.filter((n) => n.includes("tmp"))).toEqual([]);
    // a successful re-verification seals again and prunes copies older than the previous one
    await verifyInstalledRuntime(env, f.layout, { stageIn: f.state });
    await verifyInstalledRuntime(env, f.layout, { stageIn: f.state });
    await verifyInstalledRuntime(env, f.layout, { stageIn: f.state });
    expect(
      (await readdir(join(f.state, "operation-runtime"))).filter((n) => n.startsWith("closure-")),
    ).toHaveLength(2);
    expect(await sealedRuntimeEntry()).toMatch(/operation-runtime/);
  });

  it("refuses a seal that is not the runtime the binding attested", async () => {
    const f = await sealed();
    const x = f.verified.runtimeHash;
    await refused(/not the one this instance binding attested/, "")();
    // the install changes and a later verification (of the changed install) seals X'
    await writeFile(f.dep, "module.exports = 3;\n");
    await f.ship();
    const changed = await verifyInstalledRuntime(env, f.layout, { stageIn: f.state });
    expect(changed.runtimeHash).not.toBe(x);
    // a launch for the binding that attested X is refused; one for X' runs
    await refused(/not the one this instance binding attested/, x)();
    expect(await sealedRuntimeEntry(changed.runtimeHash)).toMatch(/operation-runtime/);
  });

  it("pruning keeps copies a launch still holds and other verifications' temporary copies", async () => {
    const f = await sealed();
    const held = await acquireSealedRuntime(bound);
    const heldCopy = held.entry.slice(0, held.entry.indexOf("/store/"));
    const other = join(f.state, "operation-runtime", "closure-tmp-other-verification");
    await mkdir(other, { mode: 0o700 });
    for (let i = 0; i < 3; i++) await verifyInstalledRuntime(env, f.layout, { stageIn: f.state });
    await expect(stat(heldCopy)).resolves.toBeDefined();
    await expect(stat(other)).resolves.toBeDefined();
    held.release();
    await verifyInstalledRuntime(env, f.layout, { stageIn: f.state });
    await expect(stat(heldCopy)).rejects.toThrow();
    const left = await readdir(join(f.state, "operation-runtime"));
    expect(left.filter((n) => n.startsWith("closure-") && !n.includes("tmp"))).toHaveLength(2);
  });

  it.each(["peerDependencies", "optionalDependencies"])(
    "refuses a runtime package that declares %s (resolved outside the copy)",
    async (field) => {
      const f = await fixture();
      await f.file(
        join(f.pkg, "node_modules/rt-dep/package.json"),
        JSON.stringify({ name: "rt-dep", version: "2.0.0", main: "i.js", [field]: { x: "1" } }),
      );
      await expect(enumerateInstalled(f.layout)).rejects.toThrow(`rt-dep@2.0.0 declares ${field}`);
    },
  );

  it.runIf(process.platform === "darwin")(
    "a restricted worker loads the staged runtime and is refused before fork after a change",
    async () => {
      const f = await fixture();
      // a stand-in sandbox runtime that reports where it was loaded from through its proxy token
      await f.file(
        join(f.rt, "dist/index.js"),
        [
          'import { fileURLToPath } from "node:url";',
          "export const SandboxManager = {",
          "  checkDependencies: () => ({ errors: [] }),",
          "  isSupportedPlatform: () => true,",
          "  initialize: async (config) => { globalThis.config = config; },",
          "  getProxyAuthToken: () => Buffer.from(JSON.stringify({ from: fileURLToPath(import.meta.url), config: globalThis.config })).toString('hex'),",
          "  getProxyPort: () => 1,",
          "  wrapWithSandbox: async (script) => script,",
          "  reset: async () => {},",
          "};",
          "",
        ].join("\n"),
      );
      await f.file(
        join(f.rt, "package.json"),
        JSON.stringify({
          name: "@fixture/runtime",
          version: "0.0.1",
          type: "module",
          main: "dist/index.js",
          dependencies: { "rt-dep": "1" },
        }),
      );
      await f.file(join(f.rt, "vendor/java-proxy-agent/srt-proxy-agent.jar"), "PK jar");
      await f.ship();
      const state = await realpath(await mkdtemp(join(tmpdir(), "cap-seal-worker-")));
      dirs.push(state);
      bound = (await verifyInstalledRuntime(env, f.layout, { stageIn: state })).runtimeHash;
      const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
      const loadedFrom: string[] = [];
      const configs: {
        javaAgentJarPath?: string;
        filesystem: { allowRead: unknown[]; allowReadExact: string[] };
      }[] = [];
      const launch = (runtimeHash = bound) =>
        startMacOperationWorker(
          {
            kind: "exec",
            scope: {
              operationId: "seal-fixture",
              admitBeforeMs: Date.now() + 30000,
              deviceId: "owned-fixture",
              rootConversationId: "r",
              profileRevision: 0,
              ceilingRevision: "fixture",
              profile: "approve-for-me",
              actor: { accountId: "a", conversationId: "r" },
              tag: "fixture",
              filesystem: { kind: "scoped", readRoots: [state], writeRoots: [] },
              network: { kind: "none" },
            },
            args: { command: "echo ok", cwd: state, timeoutMs: 8000, maxOutputBytes: 1000 },
            grant: {
              full: false,
              readRoots: [state],
              writeRoots: [],
              hosts: [],
              deniedReadRoots: [],
              revision: "fixture",
            },
            stateDir: state,
            pythonPath: "/usr/bin/python3",
            runtimeHash,
            beforeLaunch: async () => {},
            onLaunch: async () => {},
            onRuntimeReady: async ({ proxyUrl }) => {
              const token = /^http:\/\/srt:([0-9a-f]+)@/.exec(proxyUrl)?.[1] ?? "";
              const report = JSON.parse(Buffer.from(token, "hex").toString());
              loadedFrom.push(report.from);
              configs.push(report.config);
            },
          },
          AbortSignal.timeout(15000),
        );
      const worker = await launch();
      expect(await worker.completion).toMatchObject({ exitCode: 0, stdout: "ok\n" });
      expect(loadedFrom).toEqual([await sealedRuntimeEntry()]);
      expect(loadedFrom[0]?.startsWith(join(state, "operation-runtime/"))).toBe(true);
      // sandboxed JVMs get the staged agent, named explicitly and readable inside the sandbox
      const jar = join(
        loadedFrom[0] as string,
        "../../vendor/java-proxy-agent/srt-proxy-agent.jar",
      );
      expect(await readFile(jar, "utf8")).toBe("PK jar");
      expect(configs[0]?.javaAgentJarPath).toBe(jar);
      expect(configs[0]?.filesystem.allowReadExact).toContain(jar);

      // a launch for another binding's runtime is refused before fork
      const otherBinding = await launch("0".repeat(64));
      await expect(otherBinding.completion).rejects.toThrow(/not the one this instance binding/);

      await writeFile(join(f.pkg, "node_modules/rt-dep/i.js"), "module.exports = 3;\n");
      const refusedWorker = await launch();
      await expect(refusedWorker.completion).rejects.toBeInstanceOf(
        SandboxPermissionUnsupportedError,
      );
      await expect(refusedWorker.ready).rejects.toThrow(/changed after it was verified/);
      // no worker process was started for the refused launch
      expect(loadedFrom).toHaveLength(1);
    },
  );
});

describe("environment fingerprint", () => {
  const facts: EnvironmentFacts = {
    platform: "darwin",
    arch: "arm64",
    osBuild: "25A1",
    effectiveUid: 501,
    nodeRealPath: "/n",
    nodeSha256: "1".repeat(64),
    nodeVersion: "v24",
    pythonRealPath: "/p",
    pythonSha256: "2".repeat(64),
    pythonVersion: "3.9",
    shellRealPath: "/bin/bash",
    shellSha256: "3".repeat(64),
    providerImageDigest: null,
    interpreterLibraryEntries: [["python/lib/os.py", 1, "4".repeat(64)]],
    environmentBoundaryDigest: "5".repeat(64),
  };
  it("changes with every interpreter, library, OS and boundary input", () => {
    const base = environmentHash(facts);
    expect(base).toBe(sha(canonicalEnvironment(facts)));
    for (const change of [
      { osBuild: "25A2" },
      { effectiveUid: 502 },
      { nodeSha256: "6".repeat(64) },
      { pythonSha256: "6".repeat(64) },
      { pythonVersion: "3.10" },
      { shellSha256: "6".repeat(64) },
      { providerImageDigest: "7".repeat(64) },
      { interpreterLibraryEntries: [["python/lib/os.py", 1, "8".repeat(64)]] as const },
      { environmentBoundaryDigest: "9".repeat(64) },
    ])
      expect(environmentHash({ ...facts, ...change } as EnvironmentFacts)).not.toBe(base);
  });
  it("collects real interpreter bytes and the modules the helpers load", async () => {
    const collected = await collectEnvironment(env);
    expect(collected.nodeRealPath).toBe(await realpath(process.execPath));
    expect(collected.nodeSha256).toBe(sha(await readFile(await realpath(process.execPath))));
    expect(collected.pythonSha256).toBe(sha(await readFile(await realpath("/usr/bin/python3"))));
    const names = collected.interpreterLibraryEntries.map((e) => e[0]);
    expect(names.some((n) => /\/json\/__init__\.py$/.test(n))).toBe(true);
    expect(names.some((n) => /\/base64\.py$/.test(n))).toBe(true);
    // a restricted-only change (other domains or projects) is not an input; roots are
    const moved = await collectEnvironment({ ...env, roots: { ...env.roots, workspace: "/x" } });
    expect(moved.environmentBoundaryDigest).not.toBe(collected.environmentBoundaryDigest);
    expect({ ...moved, environmentBoundaryDigest: "" }).toEqual({
      ...collected,
      environmentBoundaryDigest: "",
    });
  });
});

describe("environment covers every helper import (fix round 1, M2)", () => {
  it("parses the imports of the shipped Python helpers", () => {
    expect(
      pythonImports("import os, sys as s\n  from urllib.parse import quote\nimport a.b # c\n"),
    ).toEqual(["a.b", "os", "sys", "urllib.parse"]);
    const all = new Set(helperPythonSources().flatMap(pythonImports));
    for (const m of ["urllib.parse", "re", "base64", "json", "errno", "stat"])
      expect(all).toContain(m);
  });
  it("fingerprints the file of every module a helper imports", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const modules = [...new Set(helperPythonSources().flatMap(pythonImports))];
    // where the interpreter loads each one from (built-in modules have no file)
    const origins = JSON.parse(
      (
        await promisify(execFile)("/usr/bin/python3", [
          "-I",
          "-c",
          "import json,sys,importlib,os\nprint(json.dumps([os.path.realpath(f) for f in [getattr(importlib.import_module(m),'__file__',None) for m in json.loads(sys.argv[1])] if f]))",
          JSON.stringify(modules),
        ])
      ).stdout,
    ) as string[];
    expect(origins.some((o) => o.endsWith("urllib/parse.py"))).toBe(true);
    const collected = await collectEnvironment(env);
    const names = collected.interpreterLibraryEntries.map((e) => e[0]);
    for (const origin of origins)
      expect(names.some((n) => origin.endsWith(n.replace(/^python(-abs)?\//, "")))).toBe(true);
  });
});
