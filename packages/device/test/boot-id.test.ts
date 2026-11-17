import { describe, expect, it } from "vitest";
import { type BootIdSources, bootTimeId, readBootId } from "../src/boot-id.js";

/** Sources over fixed answers; a missing one throws, as a missing file or sysctl does. */
const sources = (platform: NodeJS.Platform, answers: Record<string, string>): BootIdSources => ({
  platform,
  readFile: (path) => {
    const v = answers[path];
    if (v === undefined) throw new Error(`ENOENT ${path}`);
    return v;
  },
  sysctl: (name) => {
    const v = answers[name];
    if (v === undefined) throw new Error(`unknown oid ${name}`);
    return v;
  },
});

describe("boot identity", () => {
  it("reads Linux's boot_id", () => {
    expect(
      readBootId(
        sources("linux", {
          "/proc/sys/kernel/random/boot_id": "0f2a9c1e-7b1d-4b8e-9d5e-1c2b3a4d5e6f\n",
        }),
      ),
    ).toBe("0f2a9c1e-7b1d-4b8e-9d5e-1c2b3a4d5e6f");
  });

  it("reads macOS's boot session UUID, else its boot time", () => {
    expect(
      readBootId(
        sources("darwin", { "kern.bootsessionuuid": "A1B2C3D4-0000-1111-2222-333344445555\n" }),
      ),
    ).toBe("A1B2C3D4-0000-1111-2222-333344445555");
    const boottime = "{ sec = 1763370000, usec = 123456 } Mon Nov 17 08:00:00 2026\n";
    expect(readBootId(sources("darwin", { "kern.boottime": boottime }))).toBe(
      "boottime-1763370000.123456",
    );
    expect(
      readBootId(sources("darwin", { "kern.bootsessionuuid": "", "kern.boottime": boottime })),
    ).toBe("boottime-1763370000.123456");
  });

  it("reports nothing when unreadable or malformed", () => {
    expect(readBootId(sources("linux", {}))).toBeUndefined();
    expect(readBootId(sources("darwin", { "kern.boottime": "garbage" }))).toBeUndefined();
    expect(
      readBootId(sources("linux", { "/proc/sys/kernel/random/boot_id": "a b; rm -rf /" })),
    ).toBeUndefined();
    expect(readBootId(sources("win32", {}))).toBeUndefined();
    expect(bootTimeId("sec = 1")).toBeUndefined();
  });
});
