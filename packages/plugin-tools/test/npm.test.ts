import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES_MAX_BYTES_DEFAULT } from "@capybara-hq/kernel";
import { type FakeNpmRegistry, startFakeNpmRegistry } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrityOf } from "../src/integrity.js";
import { downloadPinnedNpmPackage, NPM_TARBALL_MAX_BYTES, packPlugin } from "../src/pack/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "fixtures/declarative");

/**
 * The pinned npm download `check:bootstrap --network` relies on: the bytes must match the pin and
 * the tarball must be labelled as the pinned package and version.
 */
describe("downloadPinnedNpmPackage", () => {
  let work: string;
  let tgz: Uint8Array;
  let pin: { npm: string; version: string; integrity: string };
  let reg: FakeNpmRegistry;
  /** Serves the tarball of `@capybara-hq/plugin-fixture-declarative` from another origin. */
  let other: FakeNpmRegistry;
  /** The fixture's package name (its tarball's package.json says so). */
  const PKG = "@capybara-hq/plugin-fixture-declarative";

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "plugin-tools-npm-test-"));
    // Packed from a repository-shaped root, as published (plugins/<dir>)
    await mkdir(join(work, "repo/plugins"), { recursive: true });
    await symlink(fixture, join(work, "repo/plugins/declarative"), "dir");
    const r = await packPlugin(join(work, "repo/plugins/declarative"), join(work, "out"));
    tgz = new Uint8Array(await readFile(r.file));
    pin = { npm: PKG, version: r.manifest.version, integrity: integrityOf(tgz) };
    const tampered = Uint8Array.from(tgz);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    other = await startFakeNpmRegistry({ packages: [{ name: PKG, version: pin.version, tgz }] });
    reg = await startFakeNpmRegistry({
      packages: [
        { name: PKG, version: pin.version, tgz },
        // same version on another package name, bytes changed after the pin was taken
        { name: "@capybara-hq/plugin-tampered", version: pin.version, tgz: tampered },
        // the fixture's exact bytes served under another name (a pin taken from the wrong tarball)
        { name: "@capybara-hq/plugin-mislabelled", version: pin.version, tgz },
        // its tarball lives on another origin (a CDN): the token must not go there
        {
          name: "@capybara-hq/plugin-elsewhere",
          version: pin.version,
          tgz,
          tarballUrl: `${other.url}/${PKG}/-/plugin-fixture-declarative-${pin.version}.tgz`,
        },
      ],
    });
  });
  afterAll(async () => {
    await reg?.stop();
    await other?.stop();
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("returns the pinned version's bytes once their sha512 matches", async () => {
    expect(await downloadPinnedNpmPackage(pin, reg.url)).toEqual(tgz);
    expect(reg.requests).toContain("/@capybara-hq%2fplugin-fixture-declarative");
  });

  it("asks for the abbreviated packument, as npm does", async () => {
    const from = reg.requests.length;
    await downloadPinnedNpmPackage(pin, reg.url);
    expect(reg.accepts[from]).toMatch(/^application\/vnd\.npm\.install-v1\+json/);
  });

  it("sends the npm token to the registry origin only", async () => {
    const from = reg.requests.length;
    const fromOther = other.requests.length;
    await downloadPinnedNpmPackage(pin, reg.url, { token: "s3cret" });
    // packument and tarball on the registry: both carry the token
    expect(reg.authorizations.slice(from)).toEqual(["Bearer s3cret", "Bearer s3cret"]);
    await expect(
      downloadPinnedNpmPackage({ ...pin, npm: "@capybara-hq/plugin-elsewhere" }, reg.url, {
        token: "s3cret",
      }),
    ).rejects.toThrow(/mislabelled|labelled/);
    expect(other.requests.slice(fromOther)).toHaveLength(1);
    expect(other.authorizations.slice(fromOther)).toEqual([undefined]);
  });

  it("refuses a tarball labelled as another package, naming both", async () => {
    await expect(
      downloadPinnedNpmPackage({ ...pin, npm: "@capybara-hq/plugin-mislabelled" }, reg.url),
    ).rejects.toThrow(
      new RegExp(
        `^the tarball of @capybara-hq/plugin-mislabelled@${pin.version} is labelled ${PKG}@${pin.version}`,
      ),
    );
  });

  it("refuses a tarball over the size cap (bootstrap.too_large), which is the kernel's default", async () => {
    expect(NPM_TARBALL_MAX_BYTES).toBe(PACKAGES_MAX_BYTES_DEFAULT);
    await expect(downloadPinnedNpmPackage(pin, reg.url, { maxBytes: 100 })).rejects.toThrow(
      new RegExp(`^bootstrap.too_large: the tarball of ${PKG}`),
    );
  });

  it("refuses a tampered tarball", async () => {
    await expect(
      downloadPinnedNpmPackage({ ...pin, npm: "@capybara-hq/plugin-tampered" }, reg.url),
    ).rejects.toThrow(
      new RegExp(
        `^@capybara-hq/plugin-tampered@${pin.version} from .* has sha512 .*, not the pinned`,
      ),
    );
  });

  it("refuses an unpublished package or version", async () => {
    await expect(
      downloadPinnedNpmPackage({ ...pin, npm: "@capybara-hq/plugin-nope" }, reg.url),
    ).rejects.toThrow(/^@capybara-hq\/plugin-nope is not published on http/);
    await expect(downloadPinnedNpmPackage({ ...pin, version: "9.9.9" }, reg.url)).rejects.toThrow(
      /@capybara-hq\/plugin-fixture-declarative@9\.9\.9 is not published/,
    );
  });
});
