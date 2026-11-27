import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_SERVICE_FILES_DIGEST_VECTOR,
  DEVICE_SERVICE_INSTALL_ENV,
  DEVICE_SERVICE_INSTALL_KEY_FILE,
  DEVICE_SERVICE_INSTALL_SEAL,
  DEVICE_SERVICE_MACH_CHROMIUM,
  DEVICE_SERVICE_MACH_ENV,
  DEVICE_SERVICE_SOCKET_ENV,
  DEVICE_SERVICE_STATE_ENV,
  DEVICE_SERVICE_WORKSPACE_ENV,
} from "@capybara-hq/plugin-sdk";
import { afterEach, expect, it } from "vitest";
import type { DeviceOwnerCeiling } from "../src/exec/operation-types.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import { InstallCache } from "../src/services/install-cache.js";
import { macServiceLauncher } from "../src/services/mac-launcher.js";
import { parseServiceOpBody, serveServiceOp } from "../src/services/ops.js";
import {
  MAX_SERVICE_SOCKET_PATH_BYTES,
  ServiceSupervisor,
  servicePaths,
} from "../src/services/supervisor.js";
import { bytes, echoLauncher, listenEcho, text } from "./service-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const signal = () => AbortSignal.timeout(10_000);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-svc-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const deviceDir = join(root, "d");
  const workspace = join(deviceDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const aliasRoot = join(root, "a");
  const echo = echoLauncher();
  const supervisor = new ServiceSupervisor({
    deviceDir,
    workspace,
    launcher: () => echo.launcher,
    socketAliasRoot: aliasRoot,
  });
  cleanups.push(() => supervisor.stopAll(signal()));
  return { root, deviceDir, workspace, supervisor, echo };
}

const spec = (files: Record<string, string> = { "main.js": "// service" }) => ({
  name: "browser.browser",
  entry: "main.js",
  args: ["--flag"],
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, b64(v)])),
  env: { FOO: "bar" },
});

it("ensure writes files and starts the service under the sandbox launcher", async () => {
  const { deviceDir, workspace, supervisor, echo } = await fixture();
  const res = await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "// main", "lib/x.js": "// x" }) },
    signal(),
  );
  const stateDir = join(deviceDir, "svc", "browser.browser");
  // the code lives apart from the state, in a directory the service only reads (R30)
  const codeDir = join(deviceDir, "svc-files", "browser.browser");
  expect(res).toMatchObject({
    ok: true,
    result: { name: "browser.browser", state: "running", stateDir, codeDir },
  });
  expect(await readFile(join(codeDir, "main.js"), "utf8")).toBe("// main");
  expect(await readFile(join(codeDir, "lib", "x.js"), "utf8")).toBe("// x");
  expect(echo.calls).toHaveLength(1);
  const call = echo.calls[0];
  // the install directory is the service's to fill until it seals it
  const installDir = join(deviceDir, "svc-install", "browser.browser");
  expect(call?.writeRoots).toEqual([stateDir, join(workspace, "downloads"), installDir]);
  expect(call?.argv).toEqual([process.execPath, join(codeDir, "main.js"), "--flag"]);
  expect(call?.readRoots).toContain(codeDir);
  expect(call?.cwd).toBe(stateDir);
  expect(call?.env).toMatchObject({
    FOO: "bar",
    [DEVICE_SERVICE_STATE_ENV]: stateDir,
    [DEVICE_SERVICE_SOCKET_ENV]: join(stateDir, "s"),
    [DEVICE_SERVICE_INSTALL_ENV]: installDir,
  });
  expect((await stat(join(workspace, "downloads"))).isDirectory()).toBe(true);
  const ok = res as { result: { startedAt: string } };
  expect(Number.isNaN(Date.parse(ok.result.startedAt))).toBe(false);
});

it("second ensure with the same files is a no-op while running", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  const first = await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  const entry = join(deviceDir, "svc-files", "browser.browser", "main.js");
  await writeFile(entry, "// changed locally");
  const second = await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  expect(second).toEqual(first);
  expect(echo.calls).toHaveLength(1);
  // files are written only on start
  expect(await readFile(entry, "utf8")).toBe("// changed locally");
});

it("an ensure with other files (an upgraded extension) restarts the running service on them", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  const ensure = (body: Record<string, unknown>) =>
    serveServiceOp(supervisor, { op: "service.ensure", ...body }, signal());
  const { files: _files, ...noFiles } = spec();
  const first = await ensure({ spec: spec({ "main.js": "// v1" }), filesDigest: "sha256:v1" });
  // a running service names the files it runs (an ifRunning ensure answers it too)
  expect(first).toMatchObject({
    ok: true,
    result: { state: "running", filesDigest: "sha256:v1" },
  });
  expect(await ensure({ spec: { name: "browser.browser" }, ifRunning: true })).toMatchObject({
    ok: true,
    result: { state: "running", filesDigest: "sha256:v1" },
  });
  // the same digest without files: the running service stays
  expect(await ensure({ spec: noFiles, filesDigest: "sha256:v1" })).toEqual(first);
  expect(echo.calls).toHaveLength(1);
  // the upgraded files' digest alone: the machine asks for the files, and the old service runs on
  expect(await ensure({ spec: noFiles, filesDigest: "sha256:v2" })).toMatchObject({
    ok: false,
    error: { kind: "files_needed" },
  });
  expect(echo.calls).toHaveLength(1);
  expect((await supervisor.status("browser.browser")).state).toBe("running");
  // with the files: the old process is stopped and the new one runs on the new code
  const second = await ensure({ spec: spec({ "main.js": "// v2" }), filesDigest: "sha256:v2" });
  expect(second).toMatchObject({ ok: true, result: { state: "running" } });
  expect(echo.calls).toHaveLength(2);
  expect(echo.stopped).toBe(1);
  const codeDir = join(deviceDir, "svc-files", "browser.browser");
  expect(await readFile(join(codeDir, "main.js"), "utf8")).toBe("// v2");
  expect(await readFile(join(codeDir, ".files-digest"), "utf8")).toBe("sha256:v2");
  // files without a digest are compared by their content
  expect(await ensure({ spec: spec({ "main.js": "// v3" }) })).toMatchObject({ ok: true });
  expect(echo.calls).toHaveLength(3);
  expect(await ensure({ spec: spec({ "main.js": "// v3" }) })).toMatchObject({ ok: true });
  expect(echo.calls).toHaveLength(3);
});

it("service.request round-trips via the socket", async () => {
  const { supervisor } = await fixture();
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  const res = await serveServiceOp(
    supervisor,
    { op: "service.request", name: "browser.browser", body: b64("hello"), timeoutMs: 5000 },
    signal(),
  );
  expect(res).toEqual({ ok: true, result: { body: b64("echo:hello") } });
});

it("service.status and service.stop report and end the service", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  expect(
    await serveServiceOp(supervisor, { op: "service.status", name: "browser.browser" }, signal()),
  ).toEqual({
    ok: true,
    result: {
      name: "browser.browser",
      state: "stopped",
      startedAt: null,
      stateDir: join(deviceDir, "svc", "browser.browser"),
      codeDir: join(deviceDir, "svc-files", "browser.browser"),
    },
  });
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  expect(
    await serveServiceOp(supervisor, { op: "service.stop", name: "browser.browser" }, signal()),
  ).toEqual({
    ok: true,
    result: null,
  });
  expect(supervisor.status("browser.browser").state).toBe("stopped");
  // stopped: a request fails with an actionable error, and the next ensure starts it again
  const refused = await serveServiceOp(
    supervisor,
    { op: "service.request", name: "browser.browser", body: b64("x"), timeoutMs: 1000 },
    signal(),
  );
  expect(refused).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/not running/) },
  });
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  expect(echo.calls).toHaveLength(2);
});

it("a service that exits is reported stopped and is never restarted", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  await supervisor.ensure({ ...spec(), files: { "main.js": bytes("//") } }, undefined, signal());
  echo.exitAll(1);
  await supervisor.exited("browser.browser");
  expect(supervisor.status("browser.browser")).toEqual({
    name: "browser.browser",
    state: "stopped",
    startedAt: null,
    stateDir: join(deviceDir, "svc", "browser.browser"),
    codeDir: join(deviceDir, "svc-files", "browser.browser"),
  });
  expect(echo.calls).toHaveLength(1);
});

const request = (supervisor: ServiceSupervisor, body: string) =>
  serveServiceOp(
    supervisor,
    { op: "service.request", name: "browser.browser", body: b64(body), timeoutMs: 5000 },
    signal(),
  );

it("a request in the window after a service removed its socket waits for its exit and starts it", async () => {
  const { supervisor, echo } = await fixture();
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  // the service removes its socket and exits a moment later (an idle stop)
  expect(await request(supervisor, "retire")).toEqual({
    ok: true,
    result: { body: b64("echo:retire") },
  });
  expect(supervisor.status("browser.browser").state).toBe("running");
  expect(await request(supervisor, "hello")).toEqual({
    ok: true,
    result: { body: b64("echo:hello") },
  });
  // the old process exited on its own and a fresh one runs the launched spec again
  expect(echo.stopped).toBe(0);
  expect(echo.calls).toHaveLength(2);
  expect(echo.calls[1]?.argv).toEqual(echo.calls[0]?.argv);
});

it("an ensure in the window after a service removed its socket starts a fresh one", async () => {
  const { supervisor, echo } = await fixture();
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  await request(supervisor, "retire");
  expect(
    await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({ ok: true, result: { state: "running" } });
  expect(echo.stopped).toBe(0);
  expect(echo.calls).toHaveLength(2);
  expect(await request(supervisor, "hello")).toEqual({
    ok: true,
    result: { body: b64("echo:hello") },
  });
});

it("a service that removed its socket but does not exit is stopped after the grace and started again", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-svc-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "d", "workspace");
  await mkdir(workspace, { recursive: true });
  const echo = echoLauncher();
  const supervisor = new ServiceSupervisor({
    deviceDir: join(root, "d"),
    workspace,
    launcher: () => echo.launcher,
    socketAliasRoot: join(root, "a"),
    exitingGraceMs: 1,
  });
  cleanups.push(() => supervisor.stopAll(signal()));
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  await request(supervisor, "retire-hold");
  expect(await request(supervisor, "hello")).toEqual({
    ok: true,
    result: { body: b64("echo:hello") },
  });
  expect(echo.stopped).toBe(1);
  expect(echo.calls).toHaveLength(2);
});

it("a request whose restart fails answers why the service did not start", async () => {
  const { supervisor, echo } = await fixture();
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  const launch = echo.launcher.launch.bind(echo.launcher);
  echo.launcher.launch = async () => {
    throw new Error("the sandbox refused the launch");
  };
  cleanups.push(async () => {
    echo.launcher.launch = launch;
  });
  await request(supervisor, "retire");
  expect(await request(supervisor, "hello")).toMatchObject({
    ok: false,
    error: { kind: "error", message: "the sandbox refused the launch" },
  });
  expect(supervisor.status("browser.browser").state).toBe("stopped");
});

it("a service stopped by the device is not started again by a request", async () => {
  const { supervisor, echo } = await fixture();
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  await serveServiceOp(supervisor, { op: "service.stop", name: "browser.browser" }, signal());
  expect(await request(supervisor, "hello")).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/not running/) },
  });
  expect(echo.calls).toHaveLength(1);
});

it("refuses malformed service bodies with a typed answer", async () => {
  const { supervisor } = await fixture();
  for (const body of [
    { op: "service.ensure", spec: { ...spec(), name: "Bad Name" } },
    { op: "service.ensure", spec: { ...spec(), name: "browser" } },
    { op: "service.ensure", spec: { ...spec(), entry: "../escape.js" } },
    { op: "service.ensure", spec: { ...spec(), files: { "/abs.js": b64("x") }, entry: "/abs.js" } },
    { op: "service.ensure", spec: { ...spec(), entry: "missing.js" } },
    { op: "service.ensure", spec: { ...spec(), env: { [DEVICE_SERVICE_SOCKET_ENV]: "/x" } } },
    { op: "service.request", name: "browser.browser", body: "not base64!", timeoutMs: 10 },
    { op: "service.unknown", name: "browser.browser" },
  ])
    expect(await serveServiceOp(supervisor, body, signal())).toMatchObject({
      ok: false,
      error: { kind: "invalid" },
    });
});

it("without a launcher (an unsupported host) service.ensure answers unsupported", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-svc-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const supervisor = new ServiceSupervisor({
    deviceDir: root,
    workspace: join(root, "workspace"),
    launcher: () => undefined,
    socketAliasRoot: join(root, "a"),
  });
  expect(
    await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({
    ok: false,
    error: { kind: "unsupported" },
  });
});

it("state dir path length stays under 104 bytes for the longest service id", async () => {
  // the longest id: a 41-character extension name, a dot, a 32-character service name
  const name = `e${"x".repeat(40)}.a${"b".repeat(31)}`;
  expect(name).toHaveLength(74);
  expect(MAX_SERVICE_SOCKET_PATH_BYTES).toBeLessThan(104);
  // a typical device directory, ~/capybara-device/<uuid>: a short name binds in the state dir
  const typicalDir = "/Users/someone/capybara-device/0b9c7a52-3f1e-4f43-9d55-3f0e9b6e2a11";
  const short = servicePaths(typicalDir, "browser.browser", "/tmp/capybara-svc-501");
  expect(short).toEqual({
    stateDir: `${typicalDir}/svc/browser.browser`,
    socket: `${typicalDir}/svc/browser.browser/s`,
  });
  // the longest id there would pass the limit: the socket is reached through the alias
  const typical = servicePaths(typicalDir, name, "/tmp/capybara-svc-501");
  expect(Buffer.byteLength(`${typical.stateDir}/s`)).toBeGreaterThan(MAX_SERVICE_SOCKET_PATH_BYTES);
  expect(Buffer.byteLength(typical.socket)).toBeLessThanOrEqual(MAX_SERVICE_SOCKET_PATH_BYTES);
  // a long device directory: the socket is reached through a short alias of the state dir
  const long = servicePaths(
    `/Users/someone/${"deep/".repeat(20)}device`,
    name,
    "/tmp/capybara-svc-501",
  );
  expect(long.stateDir).toBe(`/Users/someone/${"deep/".repeat(20)}device/svc/${name}`);
  expect(long.alias).toMatch(/^\/tmp\/capybara-svc-501\/[0-9a-f]{16}$/);
  expect(long.socket).toBe(`${long.alias}/s`);
  expect(Buffer.byteLength(long.socket)).toBeLessThanOrEqual(MAX_SERVICE_SOCKET_PATH_BYTES);
});

it("a long device directory still serves the socket inside the state dir", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-svc-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const deviceDir = join(root, "x".repeat(60), "y".repeat(40));
  const workspace = join(deviceDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const echo = echoLauncher();
  // the alias root is short and private to this test (never the real /tmp default)
  const aliasRoot = await realpath(await mkdtemp("/tmp/cap-svc-a-"));
  cleanups.push(() => rm(aliasRoot, { recursive: true, force: true }));
  const supervisor = new ServiceSupervisor({
    deviceDir,
    workspace,
    launcher: () => echo.launcher,
    socketAliasRoot: join(aliasRoot, "r"),
  });
  cleanups.push(() => supervisor.stopAll(signal()));
  const name = `e${"x".repeat(40)}.a${"b".repeat(31)}`;
  await supervisor.ensure(
    { ...spec(), name, files: { "main.js": bytes("//") } },
    undefined,
    signal(),
  );
  const socket = echo.calls[0]?.env[DEVICE_SERVICE_SOCKET_ENV] as string;
  expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(MAX_SERVICE_SOCKET_PATH_BYTES);
  // the socket file itself lives in the state dir
  expect((await stat(join(deviceDir, "svc", name, "s"))).isSocket()).toBe(true);
  // the alias is a read root of the service (it resolves the path through it)
  expect(echo.calls[0]?.readRoots).toContain(socket.slice(0, -2));
  const reply = await supervisor.request(name, bytes("hi"), { timeoutMs: 5000, signal: signal() });
  expect(text(reply)).toBe("echo:hi");
  // a plain connection works too (the device program is outside the sandbox)
  await new Promise<void>((resolve, reject) => {
    const c = createConnection(socket, () => {
      c.destroy();
      resolve();
    });
    c.on("error", reject);
  });
  // the alias goes with the service
  await supervisor.stop(name, signal());
  await expect(lstat(socket.slice(0, -2))).rejects.toThrow(/ENOENT/);
});

async function plantedFixture() {
  const f = await fixture();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "keep");
  const codeDir = join(f.deviceDir, "svc-files", "browser.browser");
  await mkdir(codeDir, { recursive: true });
  return { ...f, outside, codeDir };
}

it("a link planted as a code file is replaced, never followed", async () => {
  const f = await plantedFixture();
  await symlink(join(f.outside, "secret"), join(f.codeDir, "main.js"));
  await link(join(f.outside, "secret"), join(f.codeDir, "other.js"));
  const res = await serveServiceOp(
    f.supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "// main", "other.js": "// other" }) },
    signal(),
  );
  expect(res).toMatchObject({ ok: true });
  expect(await readFile(join(f.outside, "secret"), "utf8")).toBe("keep");
  expect((await lstat(join(f.codeDir, "main.js"))).isFile()).toBe(true);
  expect(await readFile(join(f.codeDir, "main.js"), "utf8")).toBe("// main");
  expect((await lstat(join(f.codeDir, "other.js"))).nlink).toBe(1);
});

it("a code directory that is a link is refused", async () => {
  const f = await plantedFixture();
  await rm(f.codeDir, { recursive: true });
  await symlink(f.outside, f.codeDir);
  const res = await serveServiceOp(
    f.supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "//", "lib/x.js": "// x" }) },
    signal(),
  );
  expect(res).toMatchObject({
    ok: false,
    error: { kind: "denied", message: expect.stringMatching(/symbolic link/) },
  });
  await expect(stat(join(f.outside, "x.js"))).rejects.toThrow(/ENOENT/);
  expect(f.echo.calls).toHaveLength(0);
});

it("a state directory or downloads that is a link is refused", async () => {
  const f = await fixture();
  const elsewhere = join(f.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(f.workspace, "downloads"));
  expect(
    await serveServiceOp(f.supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({
    ok: false,
    error: { kind: "denied" },
  });
  await rm(join(f.workspace, "downloads"));
  // the refused first attempt made the state directory; a service could replace it with a link
  await rm(join(f.deviceDir, "svc", "browser.browser"), { recursive: true });
  await symlink(elsewhere, join(f.deviceDir, "svc", "browser.browser"));
  expect(
    await serveServiceOp(f.supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({
    ok: false,
    error: { kind: "denied" },
  });
  expect(f.echo.calls).toHaveLength(0);
});

it("spec files may use any name but the digest's", async () => {
  const { supervisor } = await fixture();
  // the code directory is apart from the state: the socket and temporary names are free there
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: spec({ "main.js": "//", s: "x", "tmp/x": "x" }) },
      signal(),
    ),
  ).toMatchObject({ ok: true });
  await supervisor.stop("browser.browser", signal());
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: spec({ "main.js": "//", ".files-digest": "x" }) },
      signal(),
    ),
  ).toMatchObject({ ok: false, error: { kind: "invalid" } });
});

it("ifRunning starts nothing for a stopped service", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: spec(), ifRunning: true },
      signal(),
    ),
  ).toEqual({
    ok: true,
    result: {
      name: "browser.browser",
      state: "stopped",
      startedAt: null,
      stateDir: join(deviceDir, "svc", "browser.browser"),
      codeDir: join(deviceDir, "svc-files", "browser.browser"),
    },
  });
  expect(echo.calls).toHaveLength(0);
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: spec(), ifRunning: true },
      signal(),
    ),
  ).toMatchObject({ ok: true, result: { state: "running" } });
  expect(echo.calls).toHaveLength(1);
});

it("parses service files of several megabytes (a browser daemon bundle)", () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 7).toString("base64");
  const parsed = parseServiceOpBody({
    op: "service.ensure",
    spec: { name: "browser.browser", entry: "main.js", args: [], files: { "main.js": big } },
  });
  expect(parsed.op === "service.ensure" && parsed.spec.files?.["main.js"]?.length).toBe(
    6 * 1024 * 1024,
  );
  for (const bad of ["abc", "ab=c", "a===", "ab c"])
    expect(() =>
      parseServiceOpBody({
        op: "service.ensure",
        spec: { name: "browser.browser", entry: "main.js", args: [], files: { "main.js": bad } },
      }),
    ).toThrow(/standard padded base64/);
});

it("ifRunning accepts the name-only spec device-local sends", async () => {
  const { supervisor, echo } = await fixture();
  const nameOnly = { op: "service.ensure", spec: { name: "browser.browser" }, ifRunning: true };
  expect(await serveServiceOp(supervisor, nameOnly, signal())).toMatchObject({
    ok: true,
    result: { name: "browser.browser", state: "stopped" },
  });
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  expect(await serveServiceOp(supervisor, nameOnly, signal())).toMatchObject({
    ok: true,
    result: { state: "running" },
  });
  expect(echo.calls).toHaveLength(1);
  // without ifRunning the spec stays complete
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: { name: "browser.browser" } },
      signal(),
    ),
  ).toMatchObject({ ok: false, error: { kind: "invalid" } });
});

it("a cancelled ensure never fails a concurrent one", async () => {
  const { supervisor, echo } = await fixture();
  const first = new AbortController();
  const a = supervisor.ensure(
    { ...spec(), files: { "main.js": bytes("//") } },
    undefined,
    first.signal,
  );
  const b = supervisor.ensure(
    { ...spec(), files: { "main.js": bytes("//") } },
    undefined,
    signal(),
  );
  first.abort(new Error("caller went away"));
  await expect(a).rejects.toThrow(/caller went away/);
  expect(await b).toMatchObject({ state: "running" });
  expect(echo.calls).toHaveLength(1);
});

it("service.request waits no longer than the envelope deadline and answers", async () => {
  const { supervisor } = await fixture();
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  const res = await serveServiceOp(
    supervisor,
    { op: "service.request", name: "browser.browser", body: b64("hang"), timeoutMs: 600_000 },
    signal(),
    { deadlineMs: 300 },
  );
  expect(res).toMatchObject({
    ok: false,
    error: { kind: "error", message: expect.stringMatching(/did not answer within 50 ms/) },
  });
});

function ceiling(
  roots: { workspace: string },
  denies: string[] = [],
  net: { network: "open" | "allowlist"; allowedDomains: string[]; revision?: string } = {
    network: "open",
    allowedDomains: [],
  },
): DeviceOwnerCeiling {
  const { revision = "r", ...rest } = net;
  return {
    revision,
    outsideSandbox: false,
    ...rest,
    roots: { workspace: roots.workspace, skills: "/nonexistent/skills", tmp: "/nonexistent/tmp" },
    projectReach: "workspace",
    projectPaths: [],
    secretAndStateDenies: denies,
    otherConnectionDenies: [],
    unreadableConnections: [],
    mountReexposedDenies: [],
    mountReexposureProblem: null,
    restrictedDeniedReadRoots: [],
    preparation: { skillsRoot: "/nonexistent/skills", attachmentsBase: "/nonexistent/a" },
  } as unknown as DeviceOwnerCeiling;
}

/** A supervisor on the macOS launcher with a fake worker that runs the echo service in-process. */
async function macFixture(
  denies: (deviceDir: string) => string[] = () => [],
  net?: () => { network: "open" | "allowlist"; allowedDomains: string[]; revision?: string },
) {
  const f = await fixture();
  const requests: MacWorkerRequest[] = [];
  const launcher = macServiceLauncher({
    deviceId: "d",
    stateDir: f.root,
    pythonPath: "/usr/bin/python3",
    runtimeHash: () => "hash",
    readOwnerCeiling: async () => ceiling({ workspace: f.workspace }, denies(f.deviceDir), net?.()),
    startWorker: async (request) => {
      requests.push(request);
      if (request.kind !== "exec") throw new Error("exec only");
      const svc = await listenEcho(request.args.env?.[DEVICE_SERVICE_SOCKET_ENV] as string);
      return {
        ready: Promise.resolve(),
        completion: svc.exited.then(({ code }) => ({
          exitCode: code,
          stdout: "",
          stderr: "",
          truncated: false,
          timedOut: false,
        })),
        cancel: async () => svc.exit(null),
      };
    },
  });
  const supervisor = new ServiceSupervisor({
    deviceDir: f.deviceDir,
    workspace: f.workspace,
    launcher: () => launcher,
    socketAliasRoot: join(f.root, "a"),
  });
  cleanups.push(() => supervisor.stopAll(signal()));
  return { ...f, supervisor, requests };
}

it("the macOS launcher refuses roots the owner ceiling denies, as a typed error", async () => {
  const f = await macFixture((deviceDir) => [join(deviceDir, "svc")]);
  expect(
    await serveServiceOp(f.supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({
    ok: false,
    error: { kind: "denied" },
  });
  expect(f.requests).toHaveLength(0);
});

it("ensure with a widened host list restarts the running service with the new grant", async () => {
  const f = await macFixture();
  const ensure = (hosts: string[]) =>
    serveServiceOp(
      f.supervisor,
      { op: "service.ensure", spec: spec(), network: { kind: "allowlist", hosts } },
      signal(),
    );
  expect(await ensure(["a.example.com"])).toMatchObject({ ok: true, result: { state: "running" } });
  const first = f.requests[0];
  expect(first?.grant).toMatchObject({
    full: false,
    hosts: ["a.example.com"],
    writeRoots: [
      join(f.deviceDir, "svc", "browser.browser"),
      join(f.workspace, "downloads"),
      join(f.deviceDir, "svc-install", "browser.browser"),
    ],
  });
  expect(first?.service?.unixSockets).toEqual([join(f.deviceDir, "svc", "browser.browser")]);
  // the same network again: kept as is
  await ensure(["a.example.com"]);
  expect(f.requests).toHaveLength(1);
  // a host approved later: the grant cannot change in place, so the service restarts with it
  expect(await ensure(["a.example.com", "b.example.com"])).toMatchObject({
    ok: true,
    result: { state: "running" },
  });
  expect(f.requests).toHaveLength(2);
  expect([...(f.requests[1]?.grant.hosts ?? [])].sort()).toEqual([
    "a.example.com",
    "b.example.com",
  ]);
  const reply = await f.supervisor.request("browser.browser", bytes("x"), {
    timeoutMs: 5000,
    signal: signal(),
  });
  expect(text(reply)).toBe("echo:x");
});

it("a downloads directory swapped for a link right before the launch is refused", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const supervisor = new ServiceSupervisor({
    deviceDir: f.deviceDir,
    workspace: f.workspace,
    launcher: () => f.echo.launcher,
    socketAliasRoot: join(f.root, "a"),
    // a concurrent sandboxed operation replaces downloads after it was checked
    beforeLaunch: async () => {
      await rm(join(f.workspace, "downloads"), { recursive: true });
      await symlink(outside, join(f.workspace, "downloads"));
    },
  });
  cleanups.push(() => supervisor.stopAll(signal()));
  expect(
    await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({
    ok: false,
    error: { kind: "denied", message: expect.stringMatching(/resolves outside/) },
  });
  expect(f.echo.calls).toHaveLength(0);
});

it("an owner ceiling narrowed while the service runs restarts it at the next ensure", async () => {
  let allowedDomains = ["a.example.com", "b.example.com"];
  const f = await macFixture(undefined, () => ({ network: "allowlist", allowedDomains }));
  const ensure = () =>
    serveServiceOp(
      f.supervisor,
      {
        op: "service.ensure",
        spec: spec(),
        network: { kind: "allowlist", hosts: ["a.example.com", "b.example.com"] },
      },
      signal(),
    );
  await ensure();
  expect([...(f.requests[0]?.grant.hosts ?? [])].sort()).toEqual([
    "a.example.com",
    "b.example.com",
  ]);
  // the same request, nothing changed: kept
  await ensure();
  expect(f.requests).toHaveLength(1);
  // the owner drops b.example.com: the same requested network now means less, so it restarts
  allowedDomains = ["a.example.com"];
  expect(await ensure()).toMatchObject({ ok: true, result: { state: "running" } });
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.grant.hosts).toEqual(["a.example.com"]);
  await ensure();
  expect(f.requests).toHaveLength(2);
});

it("every service gets the device's resolved workspace root, which a spec cannot set", async () => {
  const f = await fixture();
  // the supervisor is given the workspace through a link: the service gets the resolved path
  const linked = join(f.root, "ws-link");
  await symlink(f.workspace, linked);
  const supervisor = new ServiceSupervisor({
    deviceDir: f.deviceDir,
    workspace: linked,
    launcher: () => f.echo.launcher,
    socketAliasRoot: join(f.root, "a"),
  });
  cleanups.push(() => supervisor.stopAll(signal()));
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  expect(f.echo.calls[0]?.env[DEVICE_SERVICE_WORKSPACE_ENV]).toBe(f.workspace);
  const refused = await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: { ...spec(), env: { [DEVICE_SERVICE_WORKSPACE_ENV]: "/" } } },
    signal(),
  );
  expect(refused).toMatchObject({ ok: false, error: { kind: "invalid" } });
});

it("digest-first files: a start reuses stored files only under the same digest", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  const ensure = (body: Record<string, unknown>) =>
    serveServiceOp(supervisor, { op: "service.ensure", ...body }, signal());
  const { files: _files, ...noFiles } = spec();
  // with files and a digest: written, and the digest stored with them
  expect(
    await ensure({ spec: spec({ "main.js": "// v1" }), filesDigest: "sha256:v1" }),
  ).toMatchObject({
    ok: true,
    result: { state: "running" },
  });
  expect(
    await readFile(join(deviceDir, "svc-files", "browser.browser", ".files-digest"), "utf8"),
  ).toBe("sha256:v1");
  // a running service under the same digest stays as it is
  expect(await ensure({ spec: noFiles, filesDigest: "sha256:v1" })).toMatchObject({
    ok: true,
    result: { state: "running" },
  });
  expect(echo.calls).toHaveLength(1);
  await supervisor.stop("browser.browser", signal());
  // the digest alone starts it on the stored files
  expect(await ensure({ spec: noFiles, filesDigest: "sha256:v1" })).toMatchObject({
    ok: true,
    result: { state: "running" },
  });
  expect(echo.calls).toHaveLength(2);
  expect(await readFile(join(deviceDir, "svc-files", "browser.browser", "main.js"), "utf8")).toBe(
    "// v1",
  );
  await supervisor.stop("browser.browser", signal());
  // another digest without files: files_needed, nothing started
  expect(await ensure({ spec: noFiles, filesDigest: "sha256:v2" })).toMatchObject({
    ok: false,
    error: { kind: "files_needed" },
  });
  // neither files nor a digest on a stopped service: files_needed as well
  expect(await ensure({ spec: noFiles })).toMatchObject({
    ok: false,
    error: { kind: "files_needed" },
  });
  expect(echo.calls).toHaveLength(2);
  // files without a digest drop the stored one: the old digest no longer matches
  await ensure({ spec: spec({ "main.js": "// v3" }) });
  await supervisor.stop("browser.browser", signal());
  expect(await ensure({ spec: noFiles, filesDigest: "sha256:v1" })).toMatchObject({
    ok: false,
    error: { kind: "files_needed" },
  });
  // a malformed digest and the reserved digest file name are invalid
  expect(await ensure({ spec: noFiles, filesDigest: "bad digest!" })).toMatchObject({
    ok: false,
    error: { kind: "invalid" },
  });
  expect(await ensure({ spec: spec({ "main.js": "//", ".files-digest": "x" }) })).toMatchObject({
    ok: false,
    error: { kind: "invalid" },
  });
});

it("a stored digest that is a link counts as none", async () => {
  const { root, deviceDir, supervisor } = await fixture();
  await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec(), filesDigest: "d1" },
    signal(),
  );
  await supervisor.stop("browser.browser", signal());
  const digestFile = join(deviceDir, "svc-files", "browser.browser", ".files-digest");
  await writeFile(join(root, "planted"), "d1");
  await rm(digestFile);
  await symlink(join(root, "planted"), digestFile);
  const { files: _f, ...noFiles } = spec();
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: noFiles, filesDigest: "d1" },
      signal(),
    ),
  ).toMatchObject({ ok: false, error: { kind: "files_needed" } });
});

it("a service rewriting its state directory cannot change the code a digest start runs", async () => {
  const { deviceDir, workspace, supervisor, echo } = await fixture();
  const stateDir = join(deviceDir, "svc", "browser.browser");
  const codeDir = join(deviceDir, "svc-files", "browser.browser");
  await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "// reviewed" }), filesDigest: "d1" },
    signal(),
  );
  // the grant: the code directory is read, never written
  const grant = echo.calls[0];
  expect(grant?.readRoots).toContain(codeDir);
  for (const root of grant?.writeRoots ?? [])
    expect(codeDir === root || codeDir.startsWith(`${root}/`)).toBe(false);
  expect(grant?.writeRoots).toEqual([
    stateDir,
    join(workspace, "downloads"),
    join(deviceDir, "svc-install", "browser.browser"),
  ]);
  // what a compromised service can do: rewrite anything in its state directory
  await writeFile(join(stateDir, "main.js"), "// evil");
  await writeFile(join(stateDir, ".files-digest"), "d1");
  await supervisor.stop("browser.browser", signal());
  const { files: _f, ...noFiles } = spec();
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: noFiles, filesDigest: "d1" },
      signal(),
    ),
  ).toMatchObject({ ok: true, result: { state: "running" } });
  expect(echo.calls[1]?.argv[1]).toBe(join(codeDir, "main.js"));
  expect(await readFile(join(codeDir, "main.js"), "utf8")).toBe("// reviewed");
});

it("new files replace the whole code directory", async () => {
  const { deviceDir, supervisor } = await fixture();
  await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "//", "old.js": "//" }), filesDigest: "d1" },
    signal(),
  );
  await supervisor.stop("browser.browser", signal());
  await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "//" }) },
    signal(),
  );
  const codeDir = join(deviceDir, "svc-files", "browser.browser");
  await expect(stat(join(codeDir, "old.js"))).rejects.toThrow(/ENOENT/);
  await expect(stat(join(codeDir, ".files-digest"))).rejects.toThrow(/ENOENT/);
});

// The kernel's ifRunning ensures (the launch review's first look, the refresh after an allowlist
// change) send only the service's name: { name, entry: "", args: [], files: {} }.
const nameOnly = { name: "browser.browser", entry: "", args: [], files: {} };

it("an ifRunning ensure with the name-only spec answers stopped, then keeps a running service", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: nameOnly, ifRunning: true },
      signal(),
    ),
  ).toMatchObject({
    ok: true,
    result: { name: "browser.browser", state: "stopped", startedAt: null },
  });
  const started = await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "// reviewed" }) },
    signal(),
  );
  expect(
    await serveServiceOp(
      supervisor,
      { op: "service.ensure", spec: nameOnly, ifRunning: true },
      signal(),
    ),
  ).toEqual(started);
  expect(echo.calls).toHaveLength(1);
  // the empty files of the name-only spec never touch the code directory
  expect(await readFile(join(deviceDir, "svc-files", "browser.browser", "main.js"), "utf8")).toBe(
    "// reviewed",
  );
});

it("a network change under a name-only ifRunning ensure restarts the launched spec on its stored code", async () => {
  const f = await macFixture();
  const codeDir = join(f.deviceDir, "svc-files", "browser.browser");
  const first = await serveServiceOp(
    f.supervisor,
    {
      op: "service.ensure",
      spec: spec({ "main.js": "// reviewed" }),
      network: { kind: "allowlist", hosts: ["a.example.com"] },
    },
    signal(),
  );
  expect(first).toMatchObject({ ok: true, result: { state: "running" } });
  const restarted = await serveServiceOp(
    f.supervisor,
    {
      op: "service.ensure",
      spec: nameOnly,
      ifRunning: true,
      network: { kind: "allowlist", hosts: ["a.example.com", "b.example.com"] },
    },
    signal(),
  );
  expect(restarted).toMatchObject({ ok: true, result: { state: "running" } });
  expect(f.requests).toHaveLength(2);
  // the same command (entry, args, env) as the reviewed launch, never the request's empty spec
  const exec = (r: MacWorkerRequest | undefined) => (r?.kind === "exec" ? r.args : undefined);
  expect(exec(f.requests[1])?.command).toBe(exec(f.requests[0])?.command);
  expect(exec(f.requests[1])?.env?.FOO).toBe("bar");
  expect([...(f.requests[1]?.grant.hosts ?? [])].sort()).toEqual([
    "a.example.com",
    "b.example.com",
  ]);
  expect(await readFile(join(codeDir, "main.js"), "utf8")).toBe("// reviewed");
});

it("reconcile stops a service whose owner ceiling changed, and keeps one whose did not", async () => {
  let allowedDomains = ["a.example.com", "b.example.com"];
  let revision = "r1";
  const f = await macFixture(undefined, () => ({
    network: "allowlist",
    allowedDomains,
    revision,
  }));
  const ensure = () =>
    serveServiceOp(
      f.supervisor,
      {
        op: "service.ensure",
        spec: spec(),
        network: { kind: "allowlist", hosts: ["a.example.com", "b.example.com"] },
      },
      signal(),
    );
  await ensure();
  // nothing changed: kept
  await f.supervisor.reconcile(signal());
  expect(f.supervisor.status("browser.browser").state).toBe("running");
  // the owner narrows the network: stopped, not restarted (the next ensure starts it again)
  allowedDomains = ["a.example.com"];
  revision = "r2";
  await f.supervisor.reconcile(signal());
  expect(f.supervisor.status("browser.browser").state).toBe("stopped");
  expect(f.requests).toHaveLength(1);
  // a revision change alone (a new deny root) stops it too
  await ensure();
  expect(f.requests).toHaveLength(2);
  revision = "r3";
  await f.supervisor.reconcile(signal());
  expect(f.supervisor.status("browser.browser").state).toBe("stopped");
  expect(f.requests).toHaveLength(2);
});

it("the macOS launcher tells the service the full Chromium build can start", async () => {
  const f = await macFixture();
  expect(
    await serveServiceOp(f.supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({ ok: true });
  const request = f.requests[0];
  expect(request?.kind === "exec" ? request.args.env : undefined).toMatchObject({
    [DEVICE_SERVICE_MACH_ENV]: DEVICE_SERVICE_MACH_CHROMIUM,
  });
});

it("the install directory is read only once sealed and emptied when the service's files change", async () => {
  const { deviceDir, workspace, supervisor, echo } = await fixture();
  const stateDir = join(deviceDir, "svc", "browser.browser");
  const installDir = join(deviceDir, "svc-install", "browser.browser");
  const { files: _f, ...noFiles } = spec();
  const ensure = (body: Record<string, unknown>) =>
    serveServiceOp(supervisor, { op: "service.ensure", ...body }, signal());
  expect(await ensure({ spec: spec(), filesDigest: "d1" })).toMatchObject({ ok: true });
  // unsealed: writable, not a read root
  expect(echo.calls[0]?.writeRoots).toContain(installDir);
  expect(echo.calls[0]?.readRoots).not.toContain(installDir);
  // what the service does on its first start: install, then seal
  await writeFile(join(installDir, "browser"), "chromium");
  await writeFile(join(installDir, DEVICE_SERVICE_INSTALL_SEAL), "");
  await supervisor.stop("browser.browser", signal());
  // the next start (same files): read only, the install kept
  expect(await ensure({ spec: noFiles, filesDigest: "d1" })).toMatchObject({ ok: true });
  expect(echo.calls[1]?.writeRoots).toEqual([stateDir, join(workspace, "downloads")]);
  expect(echo.calls[1]?.readRoots).toContain(installDir);
  expect(echo.calls[1]?.env[DEVICE_SERVICE_INSTALL_ENV]).toBe(installDir);
  expect(await readFile(join(installDir, "browser"), "utf8")).toBe("chromium");
  // a restart for a changed network runs on the stored code: the seal holds
  expect(
    await ensure({
      spec: { name: "browser.browser" },
      ifRunning: true,
      network: { kind: "allowlist", hosts: ["a.example.com"] },
    }),
  ).toMatchObject({ ok: true, result: { state: "running" } });
  expect(echo.calls).toHaveLength(3);
  expect(echo.calls[2]?.writeRoots).not.toContain(installDir);
  expect(echo.calls[2]?.readRoots).toContain(installDir);
  await supervisor.stop("browser.browser", signal());
  // new files (a plugin upgrade): emptied and writable again for the new install
  expect(await ensure({ spec: spec({ "main.js": "// v2" }), filesDigest: "d2" })).toMatchObject({
    ok: true,
  });
  expect(echo.calls[3]?.writeRoots).toContain(installDir);
  await expect(lstat(join(installDir, "browser"))).rejects.toThrow(/ENOENT/);
  await expect(lstat(join(installDir, DEVICE_SERVICE_INSTALL_SEAL))).rejects.toThrow(/ENOENT/);
  // the digest record sits beside the install directory, out of the service's reach
  expect(await readFile(join(deviceDir, "svc-install", ".browser.browser"), "utf8")).toBe("d2");
});

it("a service naming its install key gets the machine-wide cache, shared across upgrades and devices", async () => {
  const { root, deviceDir, workspace, supervisor: _unused, echo } = await fixture();
  const cache = new InstallCache({ root: join(root, "cache"), scope: "https://prod.example.com" });
  const supervisorOf = (dir: string, ws: string) => {
    const s = new ServiceSupervisor({
      deviceDir: dir,
      workspace: ws,
      launcher: () => echo.launcher,
      socketAliasRoot: join(root, "a"),
      installCache: cache,
    });
    cleanups.push(() => s.stopAll(signal()));
    return s;
  };
  const supervisor = supervisorOf(deviceDir, workspace);
  const keyed = (main: string) =>
    spec({ "main.js": main, [DEVICE_SERVICE_INSTALL_KEY_FILE]: "chromium-1255\n" });
  // an install the device kept before the cache: removed once the service moves to the cache
  await mkdir(join(deviceDir, "svc-install", "browser.browser"), { recursive: true });
  await writeFile(join(deviceDir, "svc-install", "browser.browser", "old"), "380 MB");
  const ensure = (s: ServiceSupervisor, body: Record<string, unknown>) =>
    serveServiceOp(s, { op: "service.ensure", ...body }, signal());
  expect(await ensure(supervisor, { spec: keyed("// v1"), filesDigest: "d1" })).toMatchObject({
    ok: true,
  });
  const staging = echo.calls[0]?.env[DEVICE_SERVICE_INSTALL_ENV] as string;
  expect(staging.startsWith(`${join(root, "cache")}/`)).toBe(true);
  expect(echo.calls[0]?.writeRoots).toContain(staging);
  await expect(lstat(join(deviceDir, "svc-install", "browser.browser"))).rejects.toThrow(/ENOENT/);
  // the service installs and seals, then exits: published before the name is free again
  await writeFile(join(staging, "chrome"), "chromium");
  await writeFile(join(staging, DEVICE_SERVICE_INSTALL_SEAL), "");
  echo.exitAll(0);
  await supervisor.exited("browser.browser");
  // a plugin upgrade that keeps the key: the sealed install, read only, nothing to download
  expect(await ensure(supervisor, { spec: keyed("// v2"), filesDigest: "d2" })).toMatchObject({
    ok: true,
  });
  const entry = echo.calls[1]?.env[DEVICE_SERVICE_INSTALL_ENV] as string;
  expect(entry).toMatch(/\/entries\/chromium-1255@[0-9a-f]{12}$/);
  expect(echo.calls[1]?.readRoots).toContain(entry);
  expect(echo.calls[1]?.writeRoots).not.toContain(entry);
  expect(await readFile(join(entry, "chrome"), "utf8")).toBe("chromium");
  // another device of the same deployment on this machine: the same entry
  const other = join(root, "d2");
  await mkdir(join(other, "workspace"), { recursive: true });
  const second = supervisorOf(other, join(other, "workspace"));
  expect(await ensure(second, { spec: keyed("// v2"), filesDigest: "d2" })).toMatchObject({
    ok: true,
  });
  expect(echo.calls[2]?.env[DEVICE_SERVICE_INSTALL_ENV]).toBe(entry);
  expect(echo.calls[2]?.readRoots).toContain(entry);
});

it("only a regular seal file seals the install directory", async () => {
  const { root, deviceDir, supervisor, echo } = await fixture();
  const installDir = join(deviceDir, "svc-install", "browser.browser");
  const { files: _f, ...noFiles } = spec();
  await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec(), filesDigest: "d1" },
    signal(),
  );
  await writeFile(join(root, "elsewhere"), "");
  await symlink(join(root, "elsewhere"), join(installDir, DEVICE_SERVICE_INSTALL_SEAL));
  await supervisor.stop("browser.browser", signal());
  await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: noFiles, filesDigest: "d1" },
    signal(),
  );
  expect(echo.calls[1]?.writeRoots).toContain(installDir);
  expect(echo.calls[1]?.readRoots).not.toContain(installDir);
});

it("an unsealed install directory is emptied at every start, whatever wrote it (an older version)", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  const installDir = join(deviceDir, "svc-install", "browser.browser");
  const { files: _f, ...noFiles } = spec();
  const ensure = (body: Record<string, unknown>) =>
    serveServiceOp(supervisor, { op: "service.ensure", ...body }, signal());
  expect(await ensure({ spec: spec(), filesDigest: "d1" })).toMatchObject({ ok: true });
  // a process that never sealed (an older service, a compromised one) left an "install" behind
  await mkdir(join(installDir, "chromium-1"), { recursive: true });
  await writeFile(join(installDir, "chromium-1", "INSTALLATION_COMPLETE"), "");
  await writeFile(join(installDir, "chromium-1", "chrome"), "planted");
  await supervisor.stop("browser.browser", signal());
  // the same files again: still unsealed, so emptied
  expect(await ensure({ spec: noFiles, filesDigest: "d1" })).toMatchObject({ ok: true });
  await expect(lstat(join(installDir, "chromium-1"))).rejects.toThrow(/ENOENT/);
  expect(echo.calls[1]?.writeRoots).toContain(installDir);
  await writeFile(join(installDir, "planted-again"), "x");
  await supervisor.stop("browser.browser", signal());
  // an upgrade (new files) over a dirty unsealed directory: emptied too, never sealed as found
  expect(await ensure({ spec: spec({ "main.js": "// v2" }), filesDigest: "d2" })).toMatchObject({
    ok: true,
  });
  await expect(lstat(join(installDir, "planted-again"))).rejects.toThrow(/ENOENT/);
  expect(echo.calls[2]?.writeRoots).toContain(installDir);
});

it("removes what services kept under bare names before ids, keeping every service id", async () => {
  const { deviceDir, supervisor } = await fixture();
  for (const dir of ["svc/browser/profile", "svc-files/browser", "svc/other.kept"])
    await mkdir(join(deviceDir, dir), { recursive: true });
  await writeFile(join(deviceDir, "svc/browser/profile/Cookies"), "old session");
  expect(
    await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({ ok: true });
  await expect(lstat(join(deviceDir, "svc/browser"))).rejects.toThrow(/ENOENT/);
  await expect(lstat(join(deviceDir, "svc-files/browser"))).rejects.toThrow(/ENOENT/);
  expect((await lstat(join(deviceDir, "svc/other.kept"))).isDirectory()).toBe(true);
  expect((await lstat(join(deviceDir, "svc/browser.browser"))).isDirectory()).toBe(true);
  // only once: what appears later under a non-id name (a future id rule) is left alone
  expect((await lstat(join(deviceDir, "svc/.ids-v1"))).isFile()).toBe(true);
  await supervisor.stop("browser.browser", signal());
  await mkdir(join(deviceDir, "svc/Later_Name"), { recursive: true });
  expect(
    await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal()),
  ).toMatchObject({ ok: true });
  expect((await lstat(join(deviceDir, "svc/Later_Name"))).isDirectory()).toBe(true);
});

it("a running service reports the SDK's digest of the files it was sent (the pinned vector)", async () => {
  const { supervisor } = await fixture();
  const files = Object.fromEntries(
    Object.entries(DEVICE_SERVICE_FILES_DIGEST_VECTOR.files).map(([k, v]) => [k, b64(v)]),
  );
  const res = await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: { ...spec(), files } },
    signal(),
  );
  expect(res).toMatchObject({
    ok: true,
    result: { state: "running", filesDigest: DEVICE_SERVICE_FILES_DIGEST_VECTOR.digest },
  });
});
