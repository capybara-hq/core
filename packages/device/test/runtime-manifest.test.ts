import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalEnvironment,
  canonicalManifest,
  collectEnvironment,
  type EnvironmentFacts,
  enumerateInstalled,
  environmentHash,
  hashRegularFile,
  installedLayout,
  type ManifestLayout,
  manifestHash,
  moduleImports,
  RuntimeManifestError,
  verifyInstalledRuntime,
} from "../src/exec/runtime-manifest.js";

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
      "inline/mac-worker.mjs",
      "inline/native-files.py",
      "inline/native-helper-prelude.py",
      "inline/output-spool-helper.py",
    ]);
  });
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
