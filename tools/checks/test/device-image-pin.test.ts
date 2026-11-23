import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDeviceImagePin,
  checkDeviceImagePinNetwork,
  DEVICE_IMAGE_PIN_FILE,
  DEVICE_SOURCE_DIR,
  type FetchLike,
  loadPin,
  resolvePin,
  writePin,
} from "../src/device-image-pin.js";

const dir = fileURLToPath(new URL("../fixtures/device-image-pin/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const rules = (file: string, src?: string) =>
  checkDeviceImagePin(join(dir, file), src && join(dir, src)).map((f) => f.rule);

describe("checkDeviceImagePin (offline)", () => {
  it("passes a well-formed digest pin and sources without a tag", () => {
    expect(rules("clean.ts", "src-clean")).toEqual([]);
  });

  it("refuses a tag instead of a digest", () => {
    expect(rules("tag.ts")).toEqual(["device-image-pin-digest"]);
  });

  it("refuses a missing platform", () => {
    expect(rules("missing-platform.ts")).toEqual(["device-image-pin-shape"]);
  });

  it("refuses a malformed digest", () => {
    expect(rules("malformed.ts")).toEqual(["device-image-pin-digest"]);
  });

  it("refuses another repository and a digest used twice", () => {
    expect(rules("repeat.ts").sort()).toEqual([
      "device-image-pin-digest",
      "device-image-pin-repository",
    ]);
  });

  it("refuses a pin that is not a plain literal, or no pin at all", () => {
    expect(rules("not-literal.ts")).toEqual(["device-image-pin-literal"]);
    expect(rules("missing.ts")).toEqual(["device-image-pin-missing"]);
  });

  it("refuses a device source that names the image by tag", () => {
    expect(rules("clean.ts", "src-tag")).toEqual(["device-image-pin-tag"]);
  });

  it("passes on the repository's pin and device sources", () => {
    expect(
      checkDeviceImagePin(join(repoRoot, DEVICE_IMAGE_PIN_FILE), join(repoRoot, DEVICE_SOURCE_DIR)),
    ).toEqual([]);
  });
});

/** A fake registry with an index of two platforms (plus an attestation entry) and its manifests. */
function fakeRegistry(o: { tamper?: boolean } = {}) {
  const blob = (o: unknown) => Buffer.from(JSON.stringify(o));
  const digest = (b: Buffer) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
  const config = { amd64: `sha256:${"a".repeat(64)}`, arm64: `sha256:${"b".repeat(64)}` };
  const manifests = Object.fromEntries(
    (["amd64", "arm64"] as const).map((p) => [
      p,
      blob({ schemaVersion: 2, config: { digest: config[p] }, layers: [] }),
    ]),
  ) as Record<"amd64" | "arm64", Buffer>;
  const index = blob({
    schemaVersion: 2,
    manifests: [
      { digest: digest(manifests.arm64), platform: { os: "linux", architecture: "arm64" } },
      { digest: `sha256:${"c".repeat(64)}`, platform: { os: "unknown", architecture: "unknown" } },
      { digest: digest(manifests.amd64), platform: { os: "linux", architecture: "amd64" } },
    ],
  });
  const bodies = new Map<string, Buffer>([
    [digest(index), index],
    [digest(manifests.amd64), o.tamper ? blob({ other: true }) : manifests.amd64],
    [digest(manifests.arm64), manifests.arm64],
  ]);
  const requests: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push(url);
    const reply = (status: number, body: Buffer, headers: Record<string, string> = {}) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      json: async () => JSON.parse(body.toString()),
    });
    if (url.startsWith("https://ghcr.io/token?")) return reply(200, blob({ token: "anonymous" }));
    if (init?.headers?.Authorization !== "Bearer anonymous")
      return reply(401, Buffer.alloc(0), {
        "www-authenticate":
          'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:capybara-hq/capybara-sandbox:pull"',
      });
    const ref = url.split("/manifests/")[1] as string;
    const body = ref === "0.1.0-rc.9" ? index : bodies.get(ref);
    return body ? reply(200, body) : reply(404, Buffer.alloc(0));
  };
  return {
    fetchFn,
    requests,
    expected: {
      repository: "ghcr.io/capybara-hq/capybara-sandbox",
      version: "0.1.0-rc.9",
      index: digest(index),
      platforms: {
        amd64: { manifest: digest(manifests.amd64), config: config.amd64 },
        arm64: { manifest: digest(manifests.arm64), config: config.arm64 },
      },
    },
  };
}

describe("device image pin against the registry", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  const copy = () => {
    tmp = mkdtempSync(join(tmpdir(), "device-image-pin-"));
    const file = join(tmp, "docker-image.ts");
    copyFileSync(join(dir, "clean.ts"), file);
    return file;
  };

  it("resolves a version to its index and per-platform digests with an anonymous token", async () => {
    const r = fakeRegistry();
    expect(await resolvePin("0.1.0-rc.9", undefined, r.fetchFn)).toEqual(r.expected);
  });

  it("writes the pin the generator resolved, and the network check then passes", async () => {
    const r = fakeRegistry();
    const file = copy();
    expect(writePin(file, r.expected)).toBe(true);
    expect(writePin(file, r.expected)).toBe(false);
    expect(loadPin(file)).toEqual(r.expected);
    expect(readFileSync(file, "utf8")).toContain("// fixture of check:device-image-pin");
    expect(checkDeviceImagePin(file)).toEqual([]);
    expect(await checkDeviceImagePinNetwork(file, r.fetchFn)).toEqual([]);
  });

  it("fails when the pin disagrees with the registry", async () => {
    const r = fakeRegistry();
    const file = copy();
    writePin(file, {
      ...r.expected,
      platforms: {
        ...r.expected.platforms,
        arm64: { ...r.expected.platforms.arm64, config: `sha256:${"d".repeat(64)}` },
      },
    });
    const findings = await checkDeviceImagePinNetwork(file, r.fetchFn);
    expect(findings.map((f) => f.rule)).toEqual(["device-image-pin-registry"]);
    expect(findings[0]?.message).toContain("platforms.arm64.config");
  });

  it("fails when the registry serves bytes that do not match a digest", async () => {
    const r = fakeRegistry({ tamper: true });
    const file = copy();
    writePin(file, r.expected);
    const findings = await checkDeviceImagePinNetwork(file, r.fetchFn);
    expect(findings.map((f) => f.rule)).toEqual(["device-image-pin-registry"]);
    expect(findings[0]?.message).toContain("served bytes of");
  });
});
