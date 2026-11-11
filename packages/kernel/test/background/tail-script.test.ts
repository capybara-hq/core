import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASKS_DIR } from "../../src/background/launch.js";
import { parseTail, tailScript } from "../../src/background/tasks.service.js";

const run = promisify(execFile);

/**
 * The output read script runs with the host's own `sh`, `wc`, `tail`, `base64` and `tr` (GNU on
 * Linux, BSD on macOS: a local device's machine), so it reads the same on both.
 */
describe("tailScript", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cap-tail-"));
    await mkdir(join(dir, TASKS_DIR), { recursive: true });
    await writeFile(join(dir, TASKS_DIR, "bt_aaaaaa.out"), "one\ntwo\nthree\n");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const read = async (id: string, tail: number) =>
    parseTail((await run("sh", ["-c", tailScript(id, tail)], { cwd: dir })).stdout, tail);

  it("reads the whole output and its end", async () => {
    expect(await read("bt_aaaaaa", 1000)).toEqual({ text: "one\ntwo\nthree\n", truncated: false });
    expect(await read("bt_aaaaaa", 6)).toEqual({ text: "three\n", truncated: true });
  });

  it("says missing when the output file is gone", async () => {
    expect(await read("bt_bbbbbb", 1000)).toBe("missing");
  });
});
