import { describe, expect, it } from "vitest";
import { REAP_ROUNDS, Reaper } from "../src/exec/reap.js";

/** A fake process table: marker value per pid; killPid removes a pid. */
function fakeTable(initial: Record<number, string>) {
  const procs = new Map<number, string>(Object.entries(initial).map(([p, m]) => [Number(p), m]));
  const groupKills: number[] = [];
  const pidKills: number[] = [];
  let scans = 0;
  let scanError: Error | undefined;
  const deps = {
    killGroup: (pgid: number) => {
      groupKills.push(pgid);
      return true;
    },
    findMarked: async (match: (v: string) => boolean) => {
      scans++;
      await Promise.resolve();
      if (scanError) throw scanError;
      return [...procs].filter(([, m]) => match(m)).map(([p]) => p);
    },
    killPid: (pid: number) => {
      pidKills.push(pid);
      procs.delete(pid);
    },
  };
  return {
    deps,
    procs,
    groupKills,
    pidKills,
    scans: () => scans,
    failScans: (e: Error) => {
      scanError = e;
    },
  };
}

describe("Reaper", () => {
  it("kills the exec's process group at once, then the processes carrying its exact marker", async () => {
    const t = fakeTable({ 10: "k.a.e1", 11: "k.a.e2", 12: "k.a", 13: "k.a.e1x" });
    const r = new Reaper(t.deps);
    const done = r.reap(500, "k.a.e1");
    // the group kill is synchronous: it happened before the scan resolves
    expect(t.groupKills).toEqual([500]);
    await done;
    expect(t.pidKills).toEqual([10]);
    // another exec of the same tag, the bare tag marker and a longer value stay
    expect([...t.procs.keys()]).toEqual([11, 12, 13]);
  });

  it("reaps calls made meanwhile in one coalesced scan", async () => {
    const t = fakeTable({ 1: "k.a.e1", 2: "k.b.e2", 3: "k.c.e3", 4: "k.d.e4" });
    const r = new Reaper(t.deps);
    const first = r.reap(100, "k.a.e1");
    const second = r.reap(200, "k.b.e2");
    const third = r.reap(300, "k.c.e3");
    await Promise.all([first, second, third]);
    expect(t.groupKills).toEqual([100, 200, 300]);
    expect(new Set(t.pidKills)).toEqual(new Set([1, 2, 3]));
    expect([...t.procs.keys()]).toEqual([4]);
    // one scan found them, one more confirmed nothing was left
    expect(t.scans()).toBe(2);
  });

  it("a reap during a scan is covered by the next scan", async () => {
    const t = fakeTable({ 1: "k.a.e1", 2: "k.b.e2" });
    const r = new Reaper(t.deps);
    const first = r.reap(100, "k.a.e1");
    // let the first scan start
    await Promise.resolve();
    await Promise.resolve();
    const second = r.reap(200, "k.b.e2");
    await second;
    await first;
    expect(t.procs.size).toBe(0);
  });

  it("scans again while it still finds processes, at most REAP_ROUNDS times", async () => {
    // a process that never dies (a kill that does not take)
    const t = fakeTable({ 7: "k.a.e1" });
    const r = new Reaper({ ...t.deps, killPid: (pid) => void t.pidKills.push(pid) });
    await r.reap(1, "k.a.e1");
    expect(t.scans()).toBe(REAP_ROUNDS);
    expect(t.pidKills).toEqual(Array.from({ length: REAP_ROUNDS }, () => 7));
  });

  it("a failing scan never rejects; the next reap scans again", async () => {
    const t = fakeTable({ 1: "k.a.e1" });
    const r = new Reaper(t.deps);
    t.failScans(new Error("ps failed"));
    await expect(r.reap(1, "k.a.e1")).resolves.toBeUndefined();
    expect(t.procs.size).toBe(1);
    t.failScans(undefined as unknown as Error);
    await r.reap(2, "k.b.e2");
    expect(t.procs.size).toBe(1);
    // the failed scan's marker is not retried: it covered only its own reap
    expect(t.pidKills).toEqual([]);
  });

  it("an empty marker reaps only the group", async () => {
    const t = fakeTable({ 1: "" });
    const r = new Reaper(t.deps);
    await r.reap(9, "");
    expect(t.groupKills).toEqual([9]);
    expect(t.scans()).toBe(0);
  });
});
