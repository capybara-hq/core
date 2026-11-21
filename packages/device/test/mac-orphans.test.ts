import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LAUNCH_SLACK_MS,
  LEGACY_MARGIN_MS,
  macOrphanProcesses,
  type OrphanProcesses,
  orphanVerdict,
  type ProcessRow,
  parseProcessTable,
  reapOrphans,
} from "../src/exec/mac-orphans.js";

const row = (pid: number, pgid: number, startMs: number, ppid = 1): ProcessRow => ({
  pid,
  ppid,
  pgid,
  startMs,
});

describe("orphanVerdict", () => {
  const launchedAtMs = 1_000_500;
  const timed = { pid: 500, token: "t", launchedAtMs };
  const legacy = { pid: 500, token: "t" };

  it("a pid with no process and no group is gone", () => {
    expect(orphanVerdict(timed, 0, [])).toBe("gone");
    expect(orphanVerdict(legacy, 0, [row(7, 7, 0)])).toBe("gone");
  });

  it("a pid now in another group was reused", () => {
    expect(orphanVerdict(timed, 0, [row(500, 400, 1_000_000)])).toBe("gone");
  });

  it("a leader that started by the launch time is ours, one after it was reused", () => {
    const at = (startMs: number) => orphanVerdict(timed, 0, [row(500, 500, startMs)]);
    // `ps` truncates to the second: the launch's own second is ours
    expect(at(1_000_000)).toBe("ours");
    expect(at(launchedAtMs - LAUNCH_SLACK_MS)).toBe("ours");
    // started after the launch was recorded: certainly another process
    expect(at(1_001_000)).toBe("gone");
  });

  it("a leader that looks older than the launch window is unprovable, never gone", () => {
    const at = (startMs: number) => orphanVerdict(timed, 0, [row(500, 500, startMs)]);
    // a stall or sleep between the spawn and the record (or a stepped clock) makes a live leader
    // look too old: it may still be ours
    expect(at(launchedAtMs - 2 * LAUNCH_SLACK_MS)).toBe("unprovable");
    expect(at(0)).toBe("unprovable");
  });

  it("an earlier version's identity is never ours: gone only when started long after admission", () => {
    const at = (startMs: number) => orphanVerdict(legacy, 100_000, [row(500, 500, startMs)]);
    expect(at(100_000 + LEGACY_MARGIN_MS + 1000)).toBe("gone");
    expect(at(100_000 + LEGACY_MARGIN_MS)).toBe("unprovable");
    expect(at(100_000 + 61_000)).toBe("unprovable");
    expect(at(90_000)).toBe("unprovable");
  });

  it("a group that outlived its leader is unprovable", () => {
    expect(orphanVerdict(timed, 0, [row(501, 500, 1_000_000)])).toBe("unprovable");
  });
});

it("parses ps output (C locale, UTC) and leaves zombies and exiting processes out", () => {
  const rows = parseProcessTable(
    [
      "    1     0     1 Ss   Sat Nov 21 09:00:00 2026",
      "  812     1   812 Z    Sat Nov 21 09:00:01 2026",
      "  813   812   812 RE   Sat Nov 21 09:00:01 2026",
      "  900   812   812 S+   Sun Nov  1 10:00:00 2026   ",
      "garbage",
    ].join("\n"),
  );
  expect(rows).toEqual([
    { pid: 1, ppid: 0, pgid: 1, startMs: Date.UTC(2026, 10, 21, 9, 0, 0) },
    { pid: 900, ppid: 812, pgid: 812, startMs: Date.UTC(2026, 10, 1, 10, 0, 0) },
  ]);
});

describe("reapOrphans", () => {
  // a fake process table: SIGKILL removes a process (unless it survives); SIGSTOP is recorded
  const fake = (rows: ProcessRow[], opts: { survivors?: number[]; next?: ProcessRow[][] } = {}) => {
    const stopped: number[] = [];
    const killed: number[] = [];
    const groups: number[] = [];
    const remove = (match: (r: ProcessRow) => boolean) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i] as ProcessRow;
        if (match(r) && !opts.survivors?.includes(r.pid)) rows.splice(i, 1);
      }
    };
    const processes: OrphanProcesses = {
      list: async () => {
        const replaced = opts.next?.shift();
        if (replaced) rows.splice(0, rows.length, ...replaced);
        return rows.map((r) => ({ ...r }));
      },
      signal: (pid, signal) => {
        if (signal === "SIGSTOP") stopped.push(pid);
        else {
          killed.push(pid);
          remove((r) => r.pid === pid);
        }
      },
      killGroup: (pgid) => {
        groups.push(pgid);
        remove((r) => r.pgid === pgid);
      },
      pause: async () => {},
    };
    return { rows, stopped, killed, groups, processes };
  };
  const launchedAtMs = 1_000_500;
  const item = { identity: { pid: 500, token: "t", launchedAtMs }, admitBeforeMs: 0 };

  it("stops and kills the whole tree of a proven leader, descendants that left the group too", async () => {
    const f = fake([
      row(500, 500, 1_000_000),
      row(501, 500, 1_000_000, 500),
      // left the group (setsid / daemonizing) but is still a descendant
      row(502, 502, 1_001_000, 501),
      row(503, 502, 1_002_000, 502),
      // unrelated
      row(600, 600, 1_000_000),
      row(601, 601, 1_000_000, 600),
    ]);
    expect(await reapOrphans(f.processes, [item])).toEqual([true]);
    expect(f.stopped.sort()).toEqual([500, 501, 502, 503]);
    expect(f.killed.sort()).toEqual([500, 501, 502, 503]);
    expect(f.rows.map((r) => r.pid)).toEqual([600, 601]);
  });

  it("does not settle while a descendant outside the group survives", async () => {
    const f = fake([row(500, 500, 1_000_000), row(502, 502, 1_001_000, 500), row(600, 600, 0)], {
      survivors: [502],
    });
    expect(await reapOrphans(f.processes, [item])).toEqual([false]);
  });

  it("re-reads the table before signalling: a pid reused meanwhile is never touched", async () => {
    const f = fake([row(500, 500, 1_000_000)], {
      // the first read proves the leader ours; by the next, another process holds the pid
      next: [[row(500, 500, 1_000_000)], [row(500, 500, 5_000_000)]],
    });
    expect(await reapOrphans(f.processes, [item])).toEqual([true]);
    expect(f.stopped).toEqual([]);
    expect(f.killed).toEqual([]);
    expect(f.groups).toEqual([]);
  });

  it("never signals an unprovable or reused process", async () => {
    const f = fake([row(500, 500, 0), row(700, 700, 9_000_000)]);
    const reused = { identity: { pid: 700, token: "t", launchedAtMs }, admitBeforeMs: 0 };
    expect(await reapOrphans(f.processes, [item, reused])).toEqual([false, true]);
    expect([...f.stopped, ...f.killed, ...f.groups]).toEqual([]);
  });
});

// The real process table: a detached child (its own group leader, as every launch is) with a
// member in its group and a descendant that left it (setsid). Recorded with its launch time it is
// reaped with its whole tree; recorded with a launch time it cannot match it is never signalled.
it.runIf(process.platform === "darwin")(
  "reaps a real detached process tree it can prove ours and spares one it cannot",
  async () => {
    const child = spawn(
      "/bin/sh",
      ["-c", "/usr/bin/perl -MPOSIX -e 'setsid(); sleep 300' & sleep 300 & wait"],
      { detached: true, stdio: "ignore" },
    );
    const launchedAtMs = Date.now();
    const pid = child.pid as number;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const tree = async () => {
      const rows = await macOrphanProcesses.list();
      return rows.filter((r) => r.pid === pid || r.pgid === pid || r.ppid === pid);
    };
    let escaped: number | undefined;
    try {
      // the shell, its sleep, and the perl that left the group
      await expect.poll(async () => (await tree()).length).toBe(3);
      escaped = (await tree()).find((r) => r.pgid !== pid)?.pid;
      expect(escaped).toBeDefined();
      // recorded an hour before the process started: a reused pid, settled with no signal
      const [reused] = await reapOrphans(macOrphanProcesses, [
        { identity: { pid, token: "t", launchedAtMs: launchedAtMs - 3_600_000 }, admitBeforeMs: 0 },
      ]);
      expect(reused).toBe(true);
      // recorded an hour after it started: unprovable, never settled, never signalled
      const [unprovable] = await reapOrphans(macOrphanProcesses, [
        { identity: { pid, token: "t", launchedAtMs: launchedAtMs + 3_600_000 }, admitBeforeMs: 0 },
      ]);
      expect(unprovable).toBe(false);
      expect(await tree()).toHaveLength(3);
      const [reaped] = await reapOrphans(macOrphanProcesses, [
        { identity: { pid, token: "t", launchedAtMs }, admitBeforeMs: 0 },
      ]);
      expect(reaped).toBe(true);
      const left = await macOrphanProcesses.list();
      expect(left.some((r) => r.pid === pid || r.pgid === pid || r.pid === escaped)).toBe(false);
      await exited;
    } finally {
      for (const target of [-pid, escaped ?? 0])
        try {
          if (target) process.kill(target, "SIGKILL");
        } catch {}
    }
  },
);
