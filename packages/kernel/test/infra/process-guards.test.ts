import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  GUARD_CIRCUIT_LIMIT,
  GUARD_CIRCUIT_WINDOW_MS,
  GUARD_LOG_MARKER,
  installProcessGuards,
} from "../../src/infra/lifecycle/process-guards.js";

/** A clock, a logger, an exit recorder and an event source in place of the process. */
function setup() {
  let now = 1_000_000;
  const records: { msg: string; fields?: Record<string, unknown> }[] = [];
  const exits: number[] = [];
  const proc = new EventEmitter();
  const uninstall = installProcessGuards({
    log: () => ({
      error: (msg: string, fields?: Record<string, unknown>) => {
        records.push({ msg, ...(fields !== undefined && { fields }) });
      },
    }),
    exit: (code) => exits.push(code),
    now: () => now,
    process: proc,
  });
  return {
    proc,
    records,
    exits,
    uninstall,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("process guards", () => {
  it("logs an unhandled rejection and an uncaught exception through the logger and keeps running", () => {
    const { proc, records, exits } = setup();
    proc.emit("unhandledRejection", new Error("otlp export failed"));
    proc.emit("uncaughtException", new Error("socket error nobody listened to"));
    expect(exits).toEqual([]);
    expect(records.map((r) => [r.msg, r.fields?.kind, r.fields?.marker])).toEqual([
      ["unhandled promise rejection", "unhandledRejection", GUARD_LOG_MARKER],
      ["uncaught exception", "uncaughtException", GUARD_LOG_MARKER],
    ]);
    expect(records[0]?.fields?.err).toMatchObject({ message: "otlp export failed" });
  });

  it(`${GUARD_CIRCUIT_LIMIT} events within the window are tolerated; one more exits 1, once`, () => {
    const { proc, records, exits, advance } = setup();
    for (let i = 0; i < GUARD_CIRCUIT_LIMIT; i++) {
      proc.emit("unhandledRejection", new Error(`e${i}`));
      advance(1_000);
    }
    expect(exits).toEqual([]);
    proc.emit("uncaughtException", new Error("sixth"));
    expect(exits).toEqual([1]);
    const open = records.find((r) => r.fields?.kind === "circuit-open");
    expect(open?.fields).toMatchObject({
      marker: GUARD_LOG_MARKER,
      events: GUARD_CIRCUIT_LIMIT + 1,
      windowMs: GUARD_CIRCUIT_WINDOW_MS,
    });
    // Further events while the process exits do not exit again
    proc.emit("unhandledRejection", new Error("seventh"));
    expect(exits).toEqual([1]);
  });

  it("events spread over more than the window never open the circuit", () => {
    const { proc, exits, advance } = setup();
    for (let i = 0; i < 20; i++) {
      proc.emit("unhandledRejection", new Error(`e${i}`));
      advance(GUARD_CIRCUIT_WINDOW_MS / GUARD_CIRCUIT_LIMIT + 1);
    }
    expect(exits).toEqual([]);
  });

  it("a throwing logger neither escapes the handler nor keeps the circuit from opening", () => {
    const exits: number[] = [];
    const proc = new EventEmitter();
    installProcessGuards({
      log: () => ({
        error: () => {
          throw new Error("logger broken");
        },
      }),
      exit: (code) => exits.push(code),
      now: () => 0,
      process: proc,
    });
    for (let i = 0; i <= GUARD_CIRCUIT_LIMIT; i++) {
      expect(() => proc.emit("unhandledRejection", "not an error")).not.toThrow();
    }
    expect(exits).toEqual([1]);
  });

  it("the logger is read on every event (the CLI switches to the configured one)", () => {
    const first = vi.fn();
    const second = vi.fn();
    let current = first;
    const proc = new EventEmitter();
    installProcessGuards({
      log: () => ({ error: current }),
      exit: () => {},
      process: proc,
    });
    proc.emit("unhandledRejection", 1);
    current = second;
    proc.emit("unhandledRejection", 2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("uninstall removes both listeners", () => {
    const { proc, uninstall } = setup();
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    uninstall();
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
    expect(proc.listenerCount("uncaughtException")).toBe(0);
  });
});
