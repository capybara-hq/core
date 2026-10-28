import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { createLogger } from "@capybara-hq/kernel";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ opts: [] as Record<string, unknown>[] }));

// Only createKernel and the config source are replaced: the real resolveConfig reads the env
vi.mock("@capybara-hq/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@capybara-hq/kernel")>();
  return {
    ...real,
    selectConfigSource: () => ({ load: async () => ({}) }),
    createKernel: async (_config: unknown, opts: Record<string, unknown>) => {
      seen.opts.push(opts);
      return { start: async () => {}, stop: async () => {} };
    },
  };
});

const { runStart } = await import("../src/commands/start.js");

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  CAPYBARA_DB__URL: "postgres://u:p@127.0.0.1:1/db",
  CAPYBARA_REDIS__URL: "redis://127.0.0.1:1",
  CAPYBARA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  ...extra,
});

async function start(e: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const log = createLogger("error", { write: () => {} });
  const code = await runStart({}, log, e, () => {}, new EventEmitter());
  expect(code).toBeUndefined();
  return seen.opts.at(-1) as Record<string, unknown>;
}

describe("capybara start always runs the bootstrap step", () => {
  beforeEach(() => {
    seen.opts.length = 0;
  });

  it("with the offline directory ./bootstrap of the working directory by default", async () => {
    const opts = await start(env());
    expect(opts.bootstrap).toEqual({ dir: resolve(process.cwd(), "bootstrap") });
  });

  it("CAPYBARA_BOOTSTRAP__DIR overrides it (relative to the working directory)", async () => {
    expect((await start(env({ CAPYBARA_BOOTSTRAP__DIR: "/srv/offline" }))).bootstrap).toEqual({
      dir: "/srv/offline",
    });
    expect((await start(env({ CAPYBARA_BOOTSTRAP__DIR: "pkgs" }))).bootstrap).toEqual({
      dir: resolve(process.cwd(), "pkgs"),
    });
  });
});
