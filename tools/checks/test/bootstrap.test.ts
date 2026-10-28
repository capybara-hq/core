import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "@capybara-hq/plugin-tools/pack";
import {
  type FakeGitServer,
  type FakeNpmRegistry,
  startFakeGitServer,
  startFakeNpmRegistry,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkBootstrap } from "../src/bootstrap.js";

const dir = fileURLToPath(new URL("../fixtures/bootstrap/", import.meta.url));
const fixture = (name: string) => join(dir, name);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFixture = (name: string) => join(dir, "compose", name);
/** The marketplace commit the compose fixtures pin. */
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OFFICIAL = "https://github.com/capybara-hq/plugins.git";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "check-bootstrap-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Copies a fixture manifest into the temp dir (paths still resolve against the fixture root). */
async function copyOf(name: string): Promise<string> {
  const file = join(tmp, name);
  await copyFile(fixture(name), file);
  return file;
}

describe("checkBootstrap", () => {
  it("reports a wrong integrity as bootstrap-stale with the expected value", async () => {
    const f = await checkBootstrap(fixture("stale-integrity.json"), dir);
    expect(f.map((x) => [x.rule, x.line])).toEqual([["bootstrap-stale", 5]]);
    expect(f[0]?.message).toMatch(
      /^demo: integrity is sha512-A+== but plugins\/demo packs sha512-/,
    );
  });

  it("reports a version mismatch as bootstrap-stale", async () => {
    const f = await checkBootstrap(fixture("stale-version.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-stale", "bootstrap-stale"]);
    expect(f[0]?.message).toContain("version is 9.9.9 but plugins/demo packs 1.2.3");
  });

  it("--write fixes stale entries, after which the manifest is clean", async () => {
    const file = await copyOf("stale-version.json");
    expect(await checkBootstrap(file, dir, { write: true })).toEqual([]);
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.plugins[0].version).toBe("1.2.3");
    expect(written.plugins[0].integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(await checkBootstrap(file, dir)).toEqual([]);
  });

  it("the pack is reproducible: two runs pin the same integrity", async () => {
    const a = await copyOf("stale-integrity.json");
    await checkBootstrap(a, dir, { write: true });
    const b = join(tmp, "again.json");
    await copyFile(fixture("stale-integrity.json"), b);
    await checkBootstrap(b, dir, { write: true });
    expect(await readFile(b, "utf8")).toBe(await readFile(a, "utf8"));
  });

  it("reports an entry whose name differs from the packed plugin", async () => {
    const f = await checkBootstrap(fixture("name-mismatch.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-name"]);
    expect(f[0]?.message).toContain('packs the plugin "demo"');
  });

  it("reports a path that does not pack", async () => {
    const f = await checkBootstrap(fixture("pack-fails.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-pack"]);
  });

  it("reports a manifest that does not parse", async () => {
    const f = await checkBootstrap(fixture("invalid.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-invalid"]);
    expect(f[0]?.message).toMatch(/^plugins\.0\.integrity: /);
    const bad = join(tmp, "bad.json");
    await writeFile(bad, "{");
    expect((await checkBootstrap(bad, dir)).map((x) => x.rule)).toEqual(["bootstrap-invalid"]);
  });

  it("leaves npm entries to the network mode", async () => {
    const file = join(tmp, "npm.json");
    const m = JSON.parse(await readFile(fixture("stale-integrity.json"), "utf8"));
    m.marketplace = {
      url: "https://github.com/capybara-hq/plugins.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    };
    m.plugins = [
      { ...m.plugins[0], source: "npm", npm: "@capybara-hq/plugin-demo", path: undefined },
    ];
    await writeFile(file, JSON.stringify(m));
    expect(await checkBootstrap(file, dir)).toEqual([]);
  });

  it("leaves no temporary files in the fixture", async () => {
    await checkBootstrap(fixture("stale-integrity.json"), dir);
    expect((await readdir(join(dir, "plugins/demo"))).sort()).toEqual([
      ".capybara-plugin",
      "package.json",
      "skills",
    ]);
  });

  it("passes on the repository's bootstrap.json and compose files (offline)", async () => {
    expect(
      await checkBootstrap(join(repoRoot, "packages/kernel/bootstrap.json"), repoRoot, {
        composeFiles: [
          join(repoRoot, "docker/compose.yaml"),
          join(repoRoot, "docker/compose.dev.yaml"),
        ],
      }),
    ).toEqual([]);
  });
});

describe("checkBootstrap: compose builds from the plugins repository (bootstrap-compose-ref)", () => {
  /** A manifest with one npm entry and the marketplace at `commit` (none: no marketplace). */
  async function manifestAt(commit: string | undefined) {
    const file = join(tmp, `m-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        ...(commit !== undefined && { marketplace: { url: OFFICIAL, commit } }),
        plugins:
          commit === undefined
            ? []
            : [
                {
                  name: "demo",
                  source: "npm",
                  npm: "@capybara-hq/plugin-demo",
                  version: "1.2.3",
                  integrity: `sha512-${"A".repeat(86)}==`,
                  required: true,
                },
              ],
      }),
    );
    return file;
  }

  it("passes when every git build context of the plugins repository is at marketplace.commit", async () => {
    expect(
      await checkBootstrap(await manifestAt(COMMIT), dir, {
        composeFiles: [composeFixture("pinned.yaml")],
      }),
    ).toEqual([]);
  });

  it("reports a branch, the default branch, another commit and a bare repository URL", async () => {
    const f = await checkBootstrap(await manifestAt(COMMIT), dir, {
      composeFiles: [composeFixture("drift.yaml")],
    });
    expect(f.map((x) => [x.rule, x.file.split("/").pop(), x.line])).toEqual([
      ["bootstrap-compose-ref", "drift.yaml", 3],
      ["bootstrap-compose-ref", "drift.yaml", 6],
      ["bootstrap-compose-ref", "drift.yaml", 8],
      ["bootstrap-compose-ref", "drift.yaml", 10],
    ]);
    expect(f[0]?.message).toBe(
      `builds plugins/sandbox-docker/image from https://github.com/capybara-hq/plugins.git at main; pin it to marketplace.commit: https://github.com/capybara-hq/plugins.git#${COMMIT}:plugins/sandbox-docker/image`,
    );
    expect(f[1]?.message).toContain("at the default branch");
    expect(f[3]?.message).toContain("builds the repository root from");
  });

  it("reports a pinned context the manifest cannot vouch for (no marketplace commit)", async () => {
    const f = await checkBootstrap(await manifestAt(undefined), dir, {
      composeFiles: [composeFixture("pinned.yaml")],
    });
    expect(f.map((x) => [x.rule, x.line])).toEqual([
      ["bootstrap-compose-ref", 3],
      ["bootstrap-compose-ref", 6],
    ]);
    expect(f[0]?.message).toContain("has no marketplace commit to pin it to");
  });

  it("is not checked without compose files", async () => {
    expect(await checkBootstrap(await manifestAt("f".repeat(40)), dir)).toEqual([]);
  });
});

describe("checkBootstrap --network (npm entries and the marketplace commit)", () => {
  /** The demo fixture's package name (its tarball's package.json says so). */
  const PKG = "@capybara-hq/plugin-fixture-bootstrap-demo";
  let tgz: Uint8Array;
  let pin: string;
  let reg: FakeNpmRegistry;
  let git: FakeGitServer;
  /** Marketplace commits: every entry listed as pinned, and three drifted ones. */
  let good: string;
  let wrongVersion: string;
  let wrongIntegrity: string;
  let missing: string;
  const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
  const marketplace = (plugins: unknown[]) => ({
    ".capybara-plugin/marketplace.json": JSON.stringify({
      schemaVersion: 1,
      name: "Official",
      plugins,
    }),
  });
  const npmEntry = (version: string, integrity: string, name = "demo", pkg = PKG) => ({
    name,
    summary: { en: name },
    source: { npm: { package: pkg, version, integrity } },
  });

  beforeAll(async () => {
    const work = await mkdtemp(join(tmpdir(), "check-bootstrap-net-"));
    try {
      const r = await packPlugin(join(dir, "plugins/demo"), work);
      tgz = new Uint8Array(await readFile(r.file));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    pin = sri(tgz);
    const tampered = Uint8Array.from(tgz);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    reg = await startFakeNpmRegistry({
      packages: [
        { name: PKG, version: "1.2.3", tgz },
        // the registry claims the pinned sha512 but serves other bytes
        { name: "@capybara-hq/plugin-tampered", version: "1.2.3", tgz: tampered, integrity: pin },
        // the bytes are the pinned ones but the registry's metadata disagrees
        {
          name: "@capybara-hq/plugin-mislabelled",
          version: "1.2.3",
          tgz,
          integrity: sri(tampered),
        },
        // the pinned bytes, with matching metadata, served under a name they do not carry
        { name: "@capybara-hq/plugin-relabelled", version: "1.2.3", tgz },
      ],
    });
    git = await startFakeGitServer();
    wrongVersion = await git.commit("plugins", marketplace([npmEntry("1.2.2", pin)]));
    wrongIntegrity = await git.commit("plugins", marketplace([npmEntry("1.2.3", sri(tampered))]));
    missing = await git.commit("plugins", marketplace([npmEntry("1.2.3", pin, "other")]));
    good = await git.commit(
      "plugins",
      marketplace([
        npmEntry("1.2.2", sri(tampered)),
        npmEntry("1.2.3", pin),
        npmEntry("1.2.3", pin, "tampered", "@capybara-hq/plugin-tampered"),
        npmEntry("1.2.3", pin, "mislabelled", "@capybara-hq/plugin-mislabelled"),
        npmEntry("1.2.3", pin, "relabelled", "@capybara-hq/plugin-relabelled"),
        npmEntry("1.2.3", pin, "nope", "@capybara-hq/plugin-nope"),
      ]),
    );
  }, 60_000);
  afterAll(async () => {
    await Promise.all([reg?.stop(), git?.stop()]);
  });

  /** A manifest of npm entries (default: demo as pinned) at marketplace `commit`. */
  async function npmManifest(commit: string, entries: Record<string, unknown>[] = [{}]) {
    const file = join(tmp, `npm-${Math.random().toString(36).slice(2)}.json`);
    const plugins = entries.map((over) => ({
      name: "demo",
      source: "npm",
      npm: PKG,
      version: "1.2.3",
      integrity: pin,
      required: true,
      ...over,
    }));
    await writeFile(
      file,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          marketplace: { url: "https://github.com/capybara-hq/plugins.git", commit },
          plugins,
        },
        null,
        2,
      )}\n`,
    );
    return file;
  }
  /** The network mode against the fakes (the marketplace read from the fake git server). */
  const network = () => ({
    registry: reg.url,
    marketplaceUrl: git.url("plugins"),
    allowInsecureLoopback: true,
  });
  const rules = (f: { rule: string }[]) => f.map((x) => x.rule);

  it("passes when every npm entry is published as pinned and listed at the marketplace commit", async () => {
    expect(await checkBootstrap(await npmManifest(good), dir, { network: network() })).toEqual([]);
  });

  it("reports an unpublished package or version as bootstrap-npm", async () => {
    const f = await checkBootstrap(
      await npmManifest(good, [
        { name: "nope", npm: "@capybara-hq/plugin-nope" },
        { name: "demo", version: "9.9.9" },
      ]),
      dir,
      { network: network() },
    );
    expect(rules(f)).toEqual(["bootstrap-npm", "bootstrap-npm", "bootstrap-marketplace"]);
    expect(f[0]?.message).toMatch(/^nope: @capybara-hq\/plugin-nope is not published on http/);
    expect(f[1]?.message).toMatch(
      /^demo: @capybara-hq\/plugin-fixture-bootstrap-demo@9\.9\.9 is not published/,
    );
    expect(f[2]?.message).toMatch(
      /^demo: the marketplace at [0-9a-f]{12} lists demo at 1\.2\.2, 1\.2\.3, not 9\.9\.9/,
    );
  });

  it("reports a tampered tarball and a registry whose dist.integrity differs from the pin", async () => {
    const f = await checkBootstrap(
      await npmManifest(good, [
        { name: "tampered", npm: "@capybara-hq/plugin-tampered" },
        { name: "mislabelled", npm: "@capybara-hq/plugin-mislabelled" },
      ]),
      dir,
      { network: network() },
    );
    expect(rules(f)).toEqual(["bootstrap-npm", "bootstrap-npm"]);
    expect(f[0]?.message).toMatch(/^tampered: .* has sha512 .*, not the pinned sha512-/);
    expect(f[1]?.message).toMatch(
      /^mislabelled: the registry's dist\.integrity .* is not the pinned/,
    );
  });

  it("reports pinned bytes whose package.json names another package (bootstrap-npm)", async () => {
    const f = await checkBootstrap(
      await npmManifest(good, [{ name: "relabelled", npm: "@capybara-hq/plugin-relabelled" }]),
      dir,
      { network: network() },
    );
    expect(rules(f)).toEqual(["bootstrap-npm"]);
    expect(f[0]?.message).toBe(
      `relabelled: the tarball of @capybara-hq/plugin-relabelled@1.2.3 is labelled ${PKG}@1.2.3 in its package.json`,
    );
  });

  it("reports an entry the marketplace commit lacks or lists at another version or integrity", async () => {
    for (const [commit, re] of [
      [missing, /^demo: the marketplace at [0-9a-f]{12} has no entry demo/],
      [wrongVersion, /^demo: the marketplace at [0-9a-f]{12} lists demo at 1\.2\.2, not 1\.2\.3/],
      [
        wrongIntegrity,
        /^demo: the marketplace at [0-9a-f]{12} lists demo@1\.2\.3 as npm @capybara-hq\/plugin-fixture-bootstrap-demo with integrity sha512-/,
      ],
    ] as const) {
      const f = await checkBootstrap(await npmManifest(commit), dir, { network: network() });
      expect(rules(f)).toEqual(["bootstrap-marketplace"]);
      expect(f[0]?.message).toMatch(re);
    }
  });

  it("reports a marketplace commit that cannot be read", async () => {
    const f = await checkBootstrap(await npmManifest("0".repeat(40)), dir, {
      network: network(),
    });
    expect(rules(f)).toEqual(["bootstrap-marketplace"]);
    expect(f[0]?.message).toMatch(
      /^cannot read \.capybara-plugin\/marketplace\.json at 000000000000/,
    );
  });

  describe("the plugins repository's files at marketplace.commit", () => {
    const HAPROXY = join(
      fileURLToPath(new URL("../fixtures/compose-haproxy/", import.meta.url)),
      "haproxy.cfg",
    );
    const COPY = "plugins/sandbox-docker/test/sandbox-proxy/haproxy.cfg";
    const IMAGE = "plugins/sandbox-docker/image";
    const EGRESS = "plugins/sandbox-docker/egress-proxy";
    /** A plugins repository commit: the marketplace listing demo as pinned, plus `files`. */
    const repoCommit = (files: Record<string, string>) =>
      git.commit("plugins", { ...marketplace([npmEntry("1.2.3", pin)]), ...files });
    /** A compose file building both sandbox images from the plugins repository at `commit`. */
    async function composeAt(commit: string) {
      const file = join(tmp, `compose-${Math.random().toString(36).slice(2)}.yaml`);
      await writeFile(
        file,
        [
          "services:",
          "  sandbox-image:",
          `    build: ${OFFICIAL}#${commit}:${IMAGE}`,
          "  sandbox-egress-image:",
          `    build: ${OFFICIAL}#${commit}:${EGRESS}`,
          "",
        ].join("\n"),
      );
      return file;
    }
    const opts = async (commit: string) => ({
      network: network(),
      haproxyFile: HAPROXY,
      composeFiles: [await composeAt(commit)],
    });

    it("passes when the haproxy copy equals core's file and every build context exists", async () => {
      const commit = await repoCommit({
        [COPY]: await readFile(HAPROXY, "utf8"),
        [`${IMAGE}/Dockerfile`]: "FROM scratch\n",
        [`${EGRESS}/Dockerfile`]: "FROM scratch\n",
      });
      expect(await checkBootstrap(await npmManifest(commit), dir, await opts(commit))).toEqual([]);
    });

    it("reports a haproxy copy that differs from core's file, or is missing (bootstrap-haproxy)", async () => {
      const contexts = {
        [`${IMAGE}/Dockerfile`]: "FROM scratch\n",
        [`${EGRESS}/Dockerfile`]: "FROM scratch\n",
      };
      const drift = await repoCommit({
        ...contexts,
        [COPY]: `${await readFile(HAPROXY, "utf8")}# local edit\n`,
      });
      const f = await checkBootstrap(await npmManifest(drift), dir, await opts(drift));
      expect(rules(f)).toEqual(["bootstrap-haproxy"]);
      expect(f[0]?.message).toMatch(
        /^plugins\/sandbox-docker\/test\/sandbox-proxy\/haproxy\.cfg at [0-9a-f]{12} of .* differs from .*haproxy\.cfg/,
      );
      const missing = await repoCommit(contexts);
      const g = await checkBootstrap(await npmManifest(missing), dir, await opts(missing));
      expect(rules(g)).toEqual(["bootstrap-haproxy"]);
      expect(g[0]?.message).toContain("is missing");
    });

    it("reports a build context without a Dockerfile at the commit (bootstrap-compose-ref)", async () => {
      const commit = await repoCommit({
        [COPY]: await readFile(HAPROXY, "utf8"),
        [`${IMAGE}/Dockerfile`]: "FROM scratch\n",
      });
      const o = await opts(commit);
      const f = await checkBootstrap(await npmManifest(commit), dir, o);
      expect(f.map((x) => [x.rule, x.file, x.line])).toEqual([
        ["bootstrap-compose-ref", o.composeFiles[0], 5],
      ]);
      expect(f[0]?.message).toMatch(
        /^plugins\/sandbox-docker\/egress-proxy\/Dockerfile is missing at [0-9a-f]{12} of /,
      );
    });
  });

  it("reports a marketplace URL other than the official one (bootstrap-marketplace-url)", async () => {
    const file = await npmManifest(good);
    const m = JSON.parse(await readFile(file, "utf8"));
    m.marketplace.url = "https://github.com/someone/plugins.git";
    await writeFile(file, JSON.stringify(m, null, 2));
    const f = await checkBootstrap(file, dir, { network: network() });
    expect(rules(f)).toEqual(["bootstrap-marketplace-url"]);
    expect(f[0]?.message).toBe(
      "marketplace.url is https://github.com/someone/plugins.git; the bootstrap plugins must come from the official marketplace https://github.com/capybara-hq/plugins.git",
    );
  });

  it("without --network, npm entries are not fetched", async () => {
    const before = reg.requests.length;
    expect(await checkBootstrap(await npmManifest("0".repeat(40)), dir)).toEqual([]);
    expect(reg.requests.length).toBe(before);
  });
});
