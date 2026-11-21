import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { installCrashLog, localTimestamp, stamped, stampLines } from "../src/log-timestamp.js";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

describe("localTimestamp", () => {
  it("is local ISO-8601 with milliseconds and an offset", () => {
    expect(localTimestamp(new Date(2026, 10, 21, 12, 56, 30, 913))).toMatch(STAMP);
    const d = new Date(2026, 10, 21, 1, 2, 3, 4);
    expect(localTimestamp(d)).toContain("2026-11-21T01:02:03.004");
    const offset = -d.getTimezoneOffset();
    const sign = offset < 0 ? "-" : "+";
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const mm = String(Math.abs(offset) % 60).padStart(2, "0");
    expect(localTimestamp(d).endsWith(`${sign}${hh}:${mm}`)).toBe(true);
  });
});

describe("stampLines", () => {
  it("prefixes every line of a multi-line message", () => {
    const now = () => new Date(2026, 10, 21, 12, 0, 0, 0);
    const [a, b] = stampLines("one\ntwo", now).split("\n");
    expect(a).toMatch(/^\S+ one$/);
    expect(b).toMatch(/^\S+ two$/);
    expect((a ?? "").split(" ")[0]).toMatch(STAMP);
  });

  it("wraps a writer", () => {
    const write = vi.fn();
    stamped(write)("hello");
    expect(write.mock.calls[0]?.[0]).toMatch(/^\S+ hello$/);
  });
});

describe("installCrashLog", () => {
  it("logs the stack with a timestamp and exits 1", () => {
    const handlers = new Map<string, (reason: unknown) => void>();
    const written: string[] = [];
    const exit = vi.fn();
    installCrashLog({
      on: ((event: string, fn: (reason: unknown) => void) => {
        handlers.set(event, fn);
      }) as never,
      exit: exit as never,
      stderr: { write: (s: string) => written.push(s) } as never,
    });
    const error = new Error("boom");
    handlers.get("uncaughtException")?.(error);
    expect(exit).toHaveBeenCalledWith(1);
    const first = written.join("").split("\n")[0] ?? "";
    expect(first).toMatch(/^\S+ Uncaught exception: Error: boom$/);
    expect(written.join("")).toContain("log-timestamp.test");
    handlers.get("unhandledRejection")?.("nope");
    expect(written.join("")).toContain("Unhandled rejection: nope");
  });
});

describe("runCli", () => {
  it("timestamps start output and leaves other commands plain", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      platform: "linux" as const,
      home: "/nonexistent/capybara-log-timestamp-home",
      env: {},
    };
    expect(await runCli(["start"], io)).toBe(0); // not logged in: a deliberate stop
    expect(err.length).toBeGreaterThan(0);
    for (const line of err) expect(line.split(" ")[0]).toMatch(STAMP);
    err.length = 0;
    await runCli(["status"], io);
    for (const line of [...out, ...err]) expect(line.split(" ")[0]).not.toMatch(STAMP);
  });
});
