import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every `docker` invocation the device container makes, recorded instead of run.
const calls: string[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: null;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = null;
      child.kill = () => {};
      queueMicrotask(() => {
        if (args[0] === "info") child.stdout.emit("data", Buffer.from("29.0.0\n"));
        child.emit("close", 0);
      });
      return child;
    }),
  };
});

const { createDockerContainer } = await import("../src/exec/docker.js");
const { DEFAULT_POLICY } = await import("../src/state.js");

beforeEach(() => {
  calls.length = 0;
});

describe("the docker-mode device container at startup", () => {
  it("checks the daemon and runs no marker reaper (no broad kill in the container)", async () => {
    const container = await createDockerContainer({
      dir: "/nonexistent/capybara-device-test",
      deviceId: "dev1",
      policy: () => DEFAULT_POLICY,
    });
    expect(calls).toEqual([["docker", "info", "--format", "{{.ServerVersion}}"]]);
    // nothing to kill at stop either: the operation backend stops its own work exactly
    expect("dispose" in container).toBe(false);
    expect("killAll" in container).toBe(false);
  });
});
