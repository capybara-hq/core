import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * One report-driven permission path (device-provider spec §6.7): the kernel's permission code
 * never branches on a device's location or on the kernel's own local provider; it reads the
 * provider's stored report and permission support, the same for every provider. Beyond the
 * permission code, devices, the sandbox service, tools, automations, platform operations and health
 * handle every device through its provider (a dial-in one through the generic channel).
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const SANDBOX = join(SRC, "sandbox");

/** Every TypeScript file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

const MARKERS = [/\bLOCAL_PROVIDER\b/, /\bowner_report\b/, /location: "local"/];

describe("the permission code has no local branches", () => {
  it('no file under packages/kernel/src/sandbox mentions LOCAL_PROVIDER, owner_report or location: "local"', () => {
    const hits = sources(SANDBOX).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return MARKERS.filter((marker) => marker.test(text)).map(
        (marker) => `${relative(SANDBOX, file)}: ${marker}`,
      );
    });
    expect(hits).toEqual([]);
  });
});

/** `identity/external.ts` compares a login's identity source, not a device's. */
const KERNEL_EXEMPT = [/^identity\/external\.ts$/];

const KERNEL_MARKERS = [
  /\bLOCAL_PROVIDER\b/,
  /"@local"/,
  /\bisInternalProvider\b/,
  /source === "local"/,
  /source !== "local"/,
];

describe("devices, sandbox, tools and automations have no local branches", () => {
  it("packages/kernel/src/local-devices does not exist", () => {
    expect(existsSync(join(SRC, "local-devices"))).toBe(false);
  });

  it('no file under packages/kernel/src mentions LOCAL_PROVIDER, "@local", isInternalProvider or source === "local"', () => {
    const hits = sources(SRC)
      .map((file) => relative(SRC, file))
      .filter((rel) => !KERNEL_EXEMPT.some((re) => re.test(rel)))
      .flatMap((rel) => {
        const text = readFileSync(join(SRC, rel), "utf8");
        return KERNEL_MARKERS.filter((marker) => marker.test(text)).map(
          (marker) => `${rel}: ${marker}`,
        );
      });
    expect(hits).toEqual([]);
  });
});
