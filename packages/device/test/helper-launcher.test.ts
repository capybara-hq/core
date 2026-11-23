import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkMountPath, HELPER_LABEL, helperContainerArgs } from "../src/exec/helper-launcher.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "cap-helper-args-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const image = `ghcr.io/capybara-hq/capybara-sandbox@sha256:${"a".repeat(64)}`;
const o = { deviceId: "dev1", image, user: "1000:1000" };

describe("helper container arguments", () => {
  it("run the pinned image's interpreter confined, with exactly the step's mounts at the same paths", () => {
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a);
    mkdirSync(b);
    const args = helperContainerArgs(o, "capybara-helper-dev1-x", "print(1)", ["arg"], [a, b, a]);
    expect(args).toEqual([
      "run",
      "--rm",
      "-i",
      "--pull",
      "never",
      "--name",
      "capybara-helper-dev1-x",
      "--label",
      `${HELPER_LABEL}=dev1`,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      "64",
      "--log-driver",
      "none",
      "--user",
      "1000:1000",
      "--workdir",
      "/",
      "--mount",
      `type=bind,source=${a},target=${a}`,
      "--mount",
      `type=bind,source=${b},target=${b}`,
      "--entrypoint",
      "/usr/bin/python3",
      image,
      "-I",
      "-c",
      "print(1)",
      "arg",
    ]);
    // no mounts: nothing of the host
    expect(helperContainerArgs(o, "n", "s", [], []).filter((x) => x === "--mount")).toEqual([]);
  });

  it("refuses a mount the --mount syntax or a link could widen", () => {
    const comma = join(base, "x,readonly=false");
    mkdirSync(comma);
    const link = join(base, "link");
    symlinkSync(base, link);
    for (const bad of [
      comma,
      link,
      join(base, "missing"),
      "relative/path",
      "/",
      `${base}/`,
      `${base}/../${base.split("/").at(-1)}`,
      join(base, 'quote"'),
    ])
      expect(() => checkMountPath(bad), bad).toThrow(/cannot mount/);
    expect(checkMountPath(base)).toBe(base);
  });
});
