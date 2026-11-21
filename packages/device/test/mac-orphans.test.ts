import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_SLACK_MS,
  macOrphanProcesses,
  orphanVerdict,
  parseProcessTable,
  reapOrphans,
} from "../src/exec/mac-orphans.js";

describe("orphanVerdict", () => {
  const launchedAtMs = 1_000_500;
  const timed = { pid: 500, token: "t", launchedAtMs };
  const legacy = { pid: 500, token: "t" };

  it("a pid with no process and no group is gone", () => {
    expect(orphanVerdict(timed, 0, [])).toBe("gone");
    expect(orphanVerdict(legacy, 0, [{ pid: 7, pgid: 7, startMs: 0 }])).toBe("gone");
  });

  it("a pid now in another group was reused", () => {
    expect(orphanVerdict(timed, 0, [{ pid: 500, pgid: 400, startMs: 1_000_000 }])).toBe("gone");
  });

  it("a recorded launch time proves the leader ours only inside the launch window", () => {
    const at = (startMs: number) => orphanVerdict(timed, 0, [{ pid: 500, pgid: 500, startMs }]);
    expect(at(1_000_000)).toBe("ours");
    expect(at(Math.floor((launchedAtMs - LAUNCH_SLACK_MS) / 1000) * 1000)).toBe("ours");
    expect(at(launchedAtMs - LAUNCH_SLACK_MS - 1000)).toBe("gone");
    expect(at(1_001_000)).toBe("gone");
  });

  it("an earlier version's identity is never ours: gone only when started well after admission", () => {
    const at = (startMs: number) =>
      orphanVerdict(legacy, 100_000, [{ pid: 500, pgid: 500, startMs }]);
    expect(at(100_000 + LAUNCH_SLACK_MS)).toBe("gone");
    expect(at(90_000)).toBe("unprovable");
    expect(at(100_000 + LAUNCH_SLACK_MS - 1000)).toBe("unprovable");
  });

  it("a group that outlived its leader is unprovable", () => {
    expect(orphanVerdict(timed, 0, [{ pid: 501, pgid: 500, startMs: 1_000_000 }])).toBe(
      "unprovable",
    );
  });
});

it("parses ps output in the C locale and leaves zombies and exiting processes out", () => {
  const rows = parseProcessTable(
    [
      "    1     1 Ss   Sat Nov 21 09:00:00 2026",
      "  812   812 Z    Sat Nov 21 09:00:01 2026",
      "  813   812 RE   Sat Nov 21 09:00:01 2026",
      "  900   812 S+   Sun Nov  1 10:00:00 2026   ",
      "garbage",
    ].join("\n"),
  );
  expect(rows).toEqual([
    { pid: 1, pgid: 1, startMs: Date.parse("Sat Nov 21 09:00:00 2026") },
    { pid: 900, pgid: 812, startMs: Date.parse("Sun Nov 1 10:00:00 2026") },
  ]);
});

// The real process table: a detached child (its own group leader, as every launch is) recorded
// with its launch time is reaped with its group; the same pid recorded with a launch time an hour
// off is never signalled.
it.runIf(process.platform === "darwin")(
  "reaps a real detached process group it can prove ours and spares one it cannot",
  async () => {
    const child = spawn("/bin/sh", ["-c", "sleep 300 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    const launchedAtMs = Date.now();
    const pid = child.pid as number;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      // the shell and its sleep share the group
      await expect
        .poll(
          async () => (await macOrphanProcesses.list()).filter((row) => row.pgid === pid).length,
        )
        .toBe(2);
      const [spared] = await reapOrphans(macOrphanProcesses, [
        { identity: { pid, token: "t", launchedAtMs: launchedAtMs - 3_600_000 }, admitBeforeMs: 0 },
      ]);
      // "gone" by its verdict (the pid's process started outside the window), yet nothing killed
      expect(spared).toBe(true);
      expect((await macOrphanProcesses.list()).some((row) => row.pid === pid)).toBe(true);
      const [reaped] = await reapOrphans(macOrphanProcesses, [
        { identity: { pid, token: "t", launchedAtMs }, admitBeforeMs: 0 },
      ]);
      expect(reaped).toBe(true);
      expect((await macOrphanProcesses.list()).some((row) => row.pgid === pid)).toBe(false);
      await exited;
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  },
);
