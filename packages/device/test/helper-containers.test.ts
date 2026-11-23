import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { containerUser } from "../src/exec/docker.js";
import { sandboxImageReference } from "../src/exec/docker-image.js";
import {
  containerHelperLauncher,
  HELPER_LABEL,
  removeLeftoverHelpers,
} from "../src/exec/helper-launcher.js";
import {
  finalizeRecoveredOutput,
  ManagedOutputSpool,
  type OutputLocator,
} from "../src/exec/output-spool.js";
import { collectEnvironment } from "../src/exec/runtime-manifest.js";

// Real Docker: the trusted helpers of a docker-mode device in helper containers of the pinned
// image, with no host interpreter involved.
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const image = sandboxImageReference({});
const signal = new AbortController().signal;
const ref = { executionId: "e", operationId: "o", instanceId: "d", instanceGeneration: "g" };
const dirs: string[] = [];
const opened: ManagedOutputSpool[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!hasDocker)("trusted helpers in helper containers", () => {
  const deviceId = `helpers${Date.now().toString(36)}`;
  const helpers = containerHelperLauncher({ deviceId, image, user: containerUser() });

  beforeAll(() => {
    const have = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    if (have.status !== 0) execFileSync("docker", ["pull", image], { stdio: "ignore" });
  });

  const fixture = () => {
    // a temporary directory: Docker Desktop shares /private and /var/folders by default
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cap-helper-spool-")));
    dirs.push(root);
    mkdirSync(join(root, "private"), { mode: 0o700 });
    mkdirSync(join(root, "workspace", "project"), { recursive: true });
    mkdirSync(join(root, "secret"));
    let locator: OutputLocator | undefined;
    const opts = {
      privateRoot: join(root, "private"),
      artifactRoot: join(root, "workspace", "project"),
      artifactMount: join(root, "workspace"),
      outputPath: join(root, "workspace", "project", "nested", "task.out"),
      ref,
      helpers,
      publish: async (record: OutputLocator) => {
        locator = structuredClone(record);
      },
    };
    const create = async () => {
      const spool = await ManagedOutputSpool.create(opts);
      opened.push(spool);
      return spool;
    };
    return { root, opts, create, locator: () => locator as OutputLocator };
  };

  it("spools, publishes, reads back, recovers and finalizes output", async () => {
    const f = fixture();
    const spool = await f.create();
    await spool.append(Buffer.from("hello "), signal);
    await spool.append(Buffer.from("world"), signal);
    expect(readFileSync(f.opts.outputPath, "utf8")).toBe("hello world");
    expect(await spool.read({ offset: 6, maxBytes: 5, signal })).toMatchObject({
      data: Buffer.from("world"),
      totalBytes: 11,
    });
    await spool.close();
    // after a restart: reopened from the journal's locator in a new helper container
    const reopened = await ManagedOutputSpool.openExisting({ ...f.opts, locator: f.locator() });
    opened.push(reopened);
    expect(Buffer.from((await reopened.read({ offset: 0, maxBytes: 64, signal })).data)).toEqual(
      Buffer.from("hello world"),
    );
    expect(() => finalizeRecoveredOutput(f.opts.privateRoot, helpers, f.locator())).not.toThrow();
    const tampered = structuredClone(f.locator());
    tampered.identity.ino++;
    expect(() => finalizeRecoveredOutput(f.opts.privateRoot, helpers, tampered)).toThrow();
  });

  it("a link the work planted at the artifact path never writes the host path it names", async () => {
    for (const kind of ["ancestor", "final"] as const) {
      const f = fixture();
      const target = join(f.root, "secret");
      if (kind === "ancestor") symlinkSync(target, join(f.opts.artifactRoot, "nested"));
      else {
        mkdirSync(join(f.opts.artifactRoot, "nested"));
        symlinkSync(join(target, "task.out"), f.opts.outputPath);
      }
      await expect(f.create()).rejects.toThrow();
      expect(f.locator()).toBeUndefined();
      expect(readdirSync(target)).toEqual([]);
    }
  });

  it("refuses an artifact root outside the mount it names", async () => {
    const f = fixture();
    await expect(
      ManagedOutputSpool.create({ ...f.opts, artifactMount: join(f.root, "secret") }),
    ).rejects.toThrow(/outside its mount/);
  });

  it("probes the image's interpreter and shell for the environment fingerprint", async () => {
    const facts = await collectEnvironment({
      place: "image",
      helpers,
      pythonPath: "/nonexistent/python3",
      roots: { workspace: "/workspace", skills: "/skills", tmp: "/tmp" },
    });
    expect(facts.place).toBe("image");
    expect(facts.pythonRealPath).toMatch(/^\/usr\/bin\/python3/);
    expect(facts.shellRealPath).toMatch(/bash$/);
    expect(facts.interpreterLibraryEntries.some((e) => /json\/__init__\.py$/.test(e[0]))).toBe(
      true,
    );
  });

  it("removes the helper containers a killed run left, by the device's label", async () => {
    const leftover = `capybara-helper-${deviceId}-left`;
    execFileSync("docker", [
      "run",
      "-d",
      "--name",
      leftover,
      "--label",
      `${HELPER_LABEL}=${deviceId}`,
      "--entrypoint",
      "sleep",
      image,
      "infinity",
    ]);
    await removeLeftoverHelpers(deviceId);
    const left = spawnSync("docker", ["ps", "-aq", "--filter", `name=${leftover}`], {
      encoding: "utf8",
    });
    expect(left.stdout.trim()).toBe("");
  });

  it("a killed helper's container is removed", async () => {
    const child = helpers.spawn("import sys\nsys.stdin.read()", [], []);
    await new Promise((r) => setTimeout(r, 0));
    const name = `capybara-helper-${deviceId}-`;
    // wait for the container to exist, then kill the client
    for (;;) {
      const ps = spawnSync("docker", ["ps", "-q", "--filter", `name=${name}`], {
        encoding: "utf8",
      });
      if (ps.stdout.trim() !== "") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill("SIGKILL");
    for (;;) {
      const ps = spawnSync("docker", ["ps", "-aq", "--filter", `name=${name}`], {
        encoding: "utf8",
      });
      if (ps.stdout.trim() === "") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync("/nonexistent/python3")).toBe(false);
  });
});
