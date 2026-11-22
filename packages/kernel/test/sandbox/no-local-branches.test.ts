import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * One report-driven permission path (device-provider spec §6.7): the kernel's permission code
 * never branches on a device's location or on the kernel's own local provider; it reads the
 * provider's stored report and permission support, the same for every provider.
 */

const SANDBOX = fileURLToPath(new URL("../../src/sandbox", import.meta.url));

/** Every TypeScript file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * Files that still name the interim `@local` provider until it leaves the kernel: the registry
 * that defines it and the sandbox service's lifecycle (both cleaned up with the provider).
 */
const PENDING = new Set(["providers.ts", "sandbox.service.ts"]);

const MARKERS = [/\bLOCAL_PROVIDER\b/, /\bowner_report\b/, /location: "local"/];

describe("the permission code has no local branches", () => {
  it('no file under packages/kernel/src/sandbox mentions LOCAL_PROVIDER, owner_report or location: "local"', () => {
    const hits = sources(SANDBOX)
      .filter((file) => !PENDING.has(relative(SANDBOX, file)))
      .flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return MARKERS.filter((marker) => marker.test(text)).map(
          (marker) => `${relative(SANDBOX, file)}: ${marker}`,
        );
      });
    expect(hits).toEqual([]);
  });
});
