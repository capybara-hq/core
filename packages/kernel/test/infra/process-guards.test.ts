import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onProcessFault,
  processFault,
  resetProcessFault,
} from "../../src/infra/health/process-fault.js";
import {
  GUARD_CIRCUIT_LIMIT,
  GUARD_CIRCUIT_WINDOW_MS,
  GUARD_LOG_MARKER,
  installProcessGuards,
} from "../../src/infra/lifecycle/process-guards.js";
import { handleShutdownSignals } from "../../src/infra/lifecycle/shutdown-signals.js";
import { createLogger } from "../../src/log.js";

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

afterEach(() => resetProcessFault());

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

  it("once the circuit is open nothing more is logged, so a failing log write cannot keep the process busy", () => {
    // The loop seen in acceptance: stdout's reader died, every log write raised EPIPE as an uncaught
    // exception, the guard logged it (another write, another EPIPE) and the endless chain of
    // nextTick errors starved the exit, the stop budget's timers and a second Ctrl-C.
    const { proc, records, exits } = setup();
    for (let i = 0; i <= GUARD_CIRCUIT_LIMIT; i++)
      proc.emit("uncaughtException", new Error("EPIPE"));
    expect(exits).toEqual([1]);
    const logged = records.length;
    for (let i = 0; i < 100; i++) proc.emit("uncaughtException", new Error("EPIPE"));
    expect(records.length).toBe(logged);
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

  it("a swallowed fatal event is logged at fatal severity and marks the process faulted", () => {
    const { proc, records } = setup();
    expect(processFault()).toBeUndefined();
    proc.emit("uncaughtException", new Error("boom"));
    proc.emit("unhandledRejection", new Error("later"));
    expect(records[0]?.fields).toMatchObject({ severity: "fatal", kind: "uncaughtException" });
    expect(processFault()).toEqual({ kind: "uncaughtException" });
  });

  it("a swallowed fatal event runs the graceful stop once and exits 1 (the restart policy replaces the process)", async () => {
    const { proc } = setup();
    const signals = new EventEmitter();
    const exits: number[] = [];
    const lines: Record<string, unknown>[] = [];
    let release!: () => void;
    const drained = new Promise<void>((r) => {
      release = r;
    });
    const close = vi.fn(() => drained);
    const handle = handleShutdownSignals(
      close,
      createLogger("info", { write: (l) => lines.push(JSON.parse(l)) }),
      { signals, exit: (c) => exits.push(c), faults: onProcessFault },
    );
    proc.emit("unhandledRejection", new Error("boom"));
    proc.emit("uncaughtException", new Error("again"));
    // the stop began (readiness 503 comes from the fault and the stop) and waits for the drain
    expect(close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);
    expect(
      lines.some(
        (l) => l.msg === "fatal event swallowed; shutting down so the process is replaced",
      ),
    ).toBe(true);
    release();
    await handle.exiting();
    expect(exits).toEqual([1]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("a fault before the handlers are installed stops at once; without `faults` nothing stops", async () => {
    const { proc } = setup();
    proc.emit("unhandledRejection", new Error("early"));
    const plain = vi.fn(async () => {});
    const off = handleShutdownSignals(plain, createLogger("error", { write: () => {} }), {
      signals: new EventEmitter(),
      exit: () => {},
    });
    expect(plain).not.toHaveBeenCalled();
    off.dispose();
    const exits: number[] = [];
    const close = vi.fn(async () => {});
    const handle = handleShutdownSignals(close, createLogger("error", { write: () => {} }), {
      signals: new EventEmitter(),
      exit: (c) => exits.push(c),
      faults: onProcessFault,
    });
    await handle.exiting();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([1]);
  });
});
