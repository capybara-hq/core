import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KernelRequest, parseDeviceFrame } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCommandLine, USAGE } from "../src/args.js";
import { runCli } from "../src/cli.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { serveOperationV3 } from "../src/server-ops.js";

// The protocol-2 surface is gone (permission activation W5-P1): the only dispatch left is the
// protocol 3 one, and the operations only the old dispatch served are refused there as unknown.

const handle = { id: "d" };
const signal = new AbortController().signal;
const request = (op: string, args: unknown): KernelRequest =>
  ({ type: "req", id: "request", op, args, deadlineMs: 1000 }) as unknown as KernelRequest;

/** A backend whose every member records a call: a removed op must reach none of them. */
function recordingBackend() {
  const touched: string[] = [];
  const backend = new Proxy(
    {},
    {
      get: (_t, key) => {
        touched.push(String(key));
        return vi.fn(async () => {
          throw new Error("the backend must not be reached");
        });
      },
    },
  ) as MacOperationBackend;
  return { backend, touched };
}

/** The removed operations, with the arguments the protocol 2 kernel sent. */
const REMOVED: [op: string, args: unknown][] = [
  ["killTagged", { tags: ["t1"] }],
  ["killAll", {}],
];

describe("removed protocol 2 operations", () => {
  for (const [op, args] of REMOVED) {
    it(`${op} is refused as an unknown operation by the protocol 3 dispatch`, async () => {
      const { backend, touched } = recordingBackend();
      const binder = { bind: vi.fn() };
      const res = await serveOperationV3(backend, handle, request(op, args), signal, binder);
      expect(res).toEqual({
        type: "res",
        id: "request",
        ok: false,
        error: { kind: "error", message: "Unknown operation" },
      });
      expect(touched).toEqual([]);
      expect(binder.bind).not.toHaveBeenCalled();
    });

    it(`${op} is refused as unknown by the session's frame parser (the socket closes)`, () => {
      expect(() =>
        parseDeviceFrame(JSON.stringify(request(op, args)), "kernel", 1024 * 1024),
      ).toThrow("Unknown operation");
    });
  }

  it("no protocol 2 dispatcher or connection is left to serve them", async () => {
    const ops = await import("../src/server-ops.js");
    for (const name of ["serveOp", "runOp", "logEntryFor", "summaryFacts"])
      expect(Object.keys(ops)).not.toContain(name);
    const client = await import("../src/client.js");
    expect(Object.keys(client)).not.toContain("connect");
  });
});

describe("startup", () => {
  it("the program's start path builds no protocol 2 executor and so runs no marker reaper", () => {
    // the OS executor kills marked leftovers when it is built; nothing on the start path builds it
    for (const file of [
      "cli.ts",
      "commands/start.ts",
      "staged-connect.ts",
      "staged-device.ts",
      "staged-session.ts",
    ]) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/exec\/(os|reap|procs|host|switch)\.js/);
      expect(source, file).not.toMatch(/killLeftovers|Reaper/);
    }
  });
});

describe("removed daily mode command", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "device-legacy-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("`capybara-device mode` is an unknown command; `ceiling` stays", async () => {
    expect(() => parseCommandLine(["mode"])).toThrow(/unknown command mode/);
    expect(() => parseCommandLine(["mode", "auto", "--yes"])).toThrow(/unknown command mode/);
    expect(parseCommandLine(["ceiling", "show"])).toEqual({ command: "ceiling", action: "show" });
    expect(USAGE).not.toMatch(/capybara-device mode/);
    expect(USAGE).toMatch(/capybara-device ceiling set/);
    const err: string[] = [];
    const code = await runCli(["mode", "auto", "--yes"], {
      env: { XDG_CONFIG_HOME: dir },
      home: dir,
      platform: "linux",
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unknown command mode/);
  });
});
