import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type FakeNpmRegistry,
  npmProvenanceAttestations,
  startFakeNpmRegistry,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchProvenance,
  parseAttestations,
  sameRepository,
} from "../../src/packages/provenance.js";

const tgz = new TextEncoder().encode("a plugin tarball");
const other = new TextEncoder().encode("another tarball");
const sri = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPO = "https://github.com/acme/plugins";

let reg: FakeNpmRegistry;
const cfg = () => ({ registry: reg.url, maxBytes: 1024 * 1024, token: "npm-secret" });
const signal = () => AbortSignal.timeout(10_000);

beforeAll(async () => {
  reg = await startFakeNpmRegistry({
    packages: [
      {
        name: "@acme/plugin-crm",
        version: "1.2.0",
        tgz,
        attestations: npmProvenanceAttestations({
          name: "@acme/plugin-crm",
          version: "1.2.0",
          tgz,
          repository: REPO,
          commit: COMMIT,
        }),
      },
      // published without provenance
      { name: "@acme/plain", version: "1.0.0", tgz },
      {
        name: "@acme/no-repo",
        version: "1.0.0",
        tgz,
        attestations: npmProvenanceAttestations({
          name: "@acme/no-repo",
          version: "1.0.0",
          tgz,
          repository: REPO,
          commit: COMMIT,
          predicate: { buildDefinition: { buildType: "x", externalParameters: {} } },
        }),
      },
      { name: "@acme/garbage", version: "1.0.0", tgz, attestations: { attestations: "nope" } },
    ],
  });
});

afterAll(async () => {
  await reg?.stop();
});

describe("fetchProvenance (spec §5.5: display only, never fails an import)", () => {
  it("reads repository, commit, workflow and build type from the SLSA v1 statement in the DSSE envelope", async () => {
    const p = await fetchProvenance(cfg(), "@acme/plugin-crm", "1.2.0", signal(), {
      integrity: sri(tgz),
    });
    expect(p).toEqual({
      checked: true,
      repository: REPO,
      commit: COMMIT,
      workflow: ".github/workflows/release.yml",
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
    });
    // the npm client's path (scoped name with %2f) and the registry token, sent to the registry
    const at = reg.requests.indexOf("/-/npm/v1/attestations/@acme%2fplugin-crm@1.2.0");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(reg.authorizations[at]).toBe("Bearer npm-secret");
  });

  it("a statement about another tarball is not shown", async () => {
    const p = await fetchProvenance(cfg(), "@acme/plugin-crm", "1.2.0", signal(), {
      integrity: sri(other),
    });
    expect(p).toEqual({
      checked: false,
      reason: "the provenance is about another tarball than the one downloaded",
    });
  });

  it("a registry without attestations for the version: not checked", async () => {
    expect(await fetchProvenance(cfg(), "@acme/plain", "1.0.0", signal())).toEqual({
      checked: false,
      reason: "the registry has no provenance for this version",
    });
  });

  it("missing fields or a malformed answer: not checked, with the reason", async () => {
    expect(await fetchProvenance(cfg(), "@acme/no-repo", "1.0.0", signal())).toEqual({
      checked: false,
      reason: "the provenance names no repository",
    });
    expect(await fetchProvenance(cfg(), "@acme/garbage", "1.0.0", signal())).toEqual({
      checked: false,
      reason: "the attestations answer is not in the npm format",
    });
    expect(parseAttestations({ attestations: [] })).toEqual({
      checked: false,
      reason: "the registry has no SLSA provenance for this version",
    });
    const bad = npmProvenanceAttestations({
      name: "x",
      version: "1.0.0",
      tgz,
      repository: REPO,
      commit: "not-a-sha",
    });
    expect(parseAttestations(bad)).toMatchObject({
      checked: false,
      reason: "the provenance names no git commit",
    });
  });

  it("an unreachable registry, a slow one, an oversized answer: not checked, never a throw", async () => {
    const offline = await fetchProvenance(
      { registry: "http://127.0.0.1:1", maxBytes: 1 },
      "@acme/plugin-crm",
      "1.2.0",
      signal(),
    );
    expect(offline.checked).toBe(false);
    expect((offline as { reason: string }).reason).toMatch(/^cannot read the attestations/);

    const slow = createServer((req, res) => {
      if (req.url?.includes("big")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"attestations":[${'"x",'.repeat(400_000)}"x"]}`);
        return;
      }
      setTimeout(() => res.end("{}"), 5_000).unref();
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try {
      const late = await fetchProvenance(
        { registry: url, maxBytes: 1 },
        "slow",
        "1.0.0",
        AbortSignal.timeout(200),
      );
      expect(late).toEqual({ checked: false, reason: "the registry did not answer in time" });
      const big = await fetchProvenance({ registry: url, maxBytes: 1 }, "big", "1.0.0", signal());
      expect(big).toEqual({
        checked: false,
        reason: "cannot read the attestations: the attestations are too large",
      });
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((r) => slow.close(() => r()));
    }
  });
});

describe("sameRepository", () => {
  it("ignores git+, .git, a trailing slash and case", () => {
    expect(sameRepository("git+https://GitHub.com/Acme/Plugins.git", `${REPO}/`)).toBe(true);
    expect(sameRepository(REPO, "https://github.com/acme/other")).toBe(false);
  });
});
