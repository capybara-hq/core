import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_SERVICE_SOCKET_ENV, DEVICE_SERVICE_STATE_ENV } from "@capybara-hq/plugin-sdk";
import { afterEach, expect, it } from "vitest";
import { serveServiceOp } from "../src/services/ops.js";
import {
  MAX_SERVICE_SOCKET_PATH_BYTES,
  ServiceSupervisor,
  servicePaths,
} from "../src/services/supervisor.js";
import { bytes, echoLauncher, text } from "./service-fixture.js";

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
  name: "browser",
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
  expect(res).toMatchObject({ ok: true, result: { name: "browser", state: "running" } });
  const stateDir = join(deviceDir, "svc", "browser");
  expect(await readFile(join(stateDir, "main.js"), "utf8")).toBe("// main");
  expect(await readFile(join(stateDir, "lib", "x.js"), "utf8")).toBe("// x");
  expect(echo.calls).toHaveLength(1);
  const call = echo.calls[0];
  expect(call?.writeRoots).toEqual([stateDir, join(workspace, "downloads")]);
  expect(call?.argv).toEqual([process.execPath, join(stateDir, "main.js"), "--flag"]);
  expect(call?.cwd).toBe(stateDir);
  expect(call?.env).toMatchObject({
    FOO: "bar",
    [DEVICE_SERVICE_STATE_ENV]: stateDir,
    [DEVICE_SERVICE_SOCKET_ENV]: join(stateDir, "s"),
  });
  expect((await stat(join(workspace, "downloads"))).isDirectory()).toBe(true);
  const ok = res as { result: { startedAt: string } };
  expect(Number.isNaN(Date.parse(ok.result.startedAt))).toBe(false);
});

it("second ensure is a no-op while running", async () => {
  const { deviceDir, supervisor, echo } = await fixture();
  const first = await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  const entry = join(deviceDir, "svc", "browser", "main.js");
  await writeFile(entry, "// changed locally");
  const second = await serveServiceOp(
    supervisor,
    { op: "service.ensure", spec: spec({ "main.js": "// new" }) },
    signal(),
  );
  expect(second).toEqual(first);
  expect(echo.calls).toHaveLength(1);
  // files are written only on start
  expect(await readFile(entry, "utf8")).toBe("// changed locally");
});

it("service.request round-trips via the socket", async () => {
  const { supervisor } = await fixture();
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  const res = await serveServiceOp(
    supervisor,
    { op: "service.request", name: "browser", body: b64("hello"), timeoutMs: 5000 },
    signal(),
  );
  expect(res).toEqual({ ok: true, result: { body: b64("echo:hello") } });
});

it("service.status and service.stop report and end the service", async () => {
  const { supervisor, echo } = await fixture();
  expect(
    await serveServiceOp(supervisor, { op: "service.status", name: "browser" }, signal()),
  ).toEqual({ ok: true, result: { name: "browser", state: "stopped", startedAt: null } });
  await serveServiceOp(supervisor, { op: "service.ensure", spec: spec() }, signal());
  expect(
    await serveServiceOp(supervisor, { op: "service.stop", name: "browser" }, signal()),
  ).toEqual({
    ok: true,
    result: null,
  });
  expect(supervisor.status("browser").state).toBe("stopped");
  // stopped: a request fails with an actionable error, and the next ensure starts it again
  const refused = await serveServiceOp(
    supervisor,
    { op: "service.request", name: "browser", body: b64("x"), timeoutMs: 1000 },
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
  const { supervisor, echo } = await fixture();
  await supervisor.ensure({ ...spec(), files: { "main.js": bytes("//") } }, undefined, signal());
  echo.exitAll(1);
  await supervisor.exited("browser");
  expect(supervisor.status("browser")).toEqual({
    name: "browser",
    state: "stopped",
    startedAt: null,
  });
  expect(echo.calls).toHaveLength(1);
});

it("refuses malformed service bodies with a typed answer", async () => {
  const { supervisor } = await fixture();
  for (const body of [
    { op: "service.ensure", spec: { ...spec(), name: "Bad Name" } },
    { op: "service.ensure", spec: { ...spec(), entry: "../escape.js" } },
    { op: "service.ensure", spec: { ...spec(), files: { "/abs.js": b64("x") }, entry: "/abs.js" } },
    { op: "service.ensure", spec: { ...spec(), entry: "missing.js" } },
    { op: "service.ensure", spec: { ...spec(), env: { [DEVICE_SERVICE_SOCKET_ENV]: "/x" } } },
    { op: "service.request", name: "browser", body: "not base64!", timeoutMs: 10 },
    { op: "service.unknown", name: "browser" },
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

it("state dir path length stays under 104 bytes for a 32-char service name", async () => {
  const name = `a${"b".repeat(31)}`;
  expect(name).toHaveLength(32);
  expect(MAX_SERVICE_SOCKET_PATH_BYTES).toBeLessThan(104);
  // a typical device directory, ~/capybara-device/<uuid>: a short name binds in the state dir
  const typicalDir = "/Users/someone/capybara-device/0b9c7a52-3f1e-4f43-9d55-3f0e9b6e2a11";
  const short = servicePaths(typicalDir, "browser", "/tmp/capybara-svc-501");
  expect(short).toEqual({
    stateDir: `${typicalDir}/svc/browser`,
    socket: `${typicalDir}/svc/browser/s`,
  });
  // a 32-character name there would pass the limit: the socket is reached through the alias
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
  const name = `a${"b".repeat(31)}`;
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
});
