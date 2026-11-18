import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxOperationScope } from "@capybara-hq/plugin-sdk";
/** The grant one operation receives (the conformance harness's shape). */
export interface OperationGrant {
  readonly profile: SandboxOperationScope["profile"];
  readonly filesystem: SandboxOperationScope["filesystem"];
  readonly network: SandboxOperationScope["network"];
}

import type { DeviceOwnerCeiling } from "../src/exec/operation-types.js";

/**
 * A hardened Linux container standing in for a local device (the 2b harness's hardening: a
 * non-root UID, cap-drop ALL, no-new-privileges, a read-only root, Docker's default seccomp and no
 * network), with the operation runtime staged root-owned the way the device's container host
 * stages it, and root-run endpoints whose receipts the device user cannot forge.
 */
export const IMAGE =
  process.env.CAPYBARA_TEST_SANDBOX_IMAGE ?? "ghcr.io/capybara-hq/capybara-sandbox:0.1.0-rc.15";
const RECEIPTS = "/opt/capybara-receipts";
const USER = "1000:1000";
const LISTEN = new URL("../../testing/test/fixtures/linux-permission/listen.py", import.meta.url);

/** Why the container evidence cannot run here, or null when it can. */
export function dockerUnavailable(): string | null {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0)
    return "Docker is not available";
  if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status !== 0) {
    if (spawnSync("docker", ["pull", IMAGE], { stdio: "ignore" }).status !== 0)
      return `The sandbox image ${IMAGE} is not available`;
  }
  return null;
}

function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { input, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`docker ${args.slice(0, 4).join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** Async docker exec (inspection runs while operations hold the event loop's attention). */
function _dockerAsync(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      err += b.toString("utf8");
    });
    child.stdin.end(input ?? "");
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`docker ${args[0]} failed: ${err}`)),
    );
  });
}

export const NAMES = {
  granted: "granted.permission.test",
  ungranted4: "ungranted4.permission.test",
  ungranted6: "ungranted6.permission.test",
} as const;
const ENDPOINTS = {
  granted: ["127.0.0.1", 18080],
  ungranted4: ["127.0.0.1", 18081],
  ungranted6: ["::1", 18082],
} as const;

export interface LinuxDevice {
  readonly name: string;
  run(command: string, user?: string): string;
  remove(): void;
}

/** Starts the hardened device container, stages the runtime and starts the endpoints. */
export async function startLinuxDevice(
  options: {
    seccompProfile?: string;
    /** Bind-mount this host directory at /workspace and /tmp, as the device's executor does. */
    bindWorkspace?: string;
  } = {},
): Promise<LinuxDevice> {
  const name = `capybara-w2s-${randomUUID().slice(0, 12)}`;
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "capybara.test=device-linux-operations",
    "--user",
    USER,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    ...(options.seccompProfile ? ["--security-opt", `seccomp=${options.seccompProfile}`] : []),
    "--network",
    "none",
    // the agent's allowlist proxy resolves names like any client would
    ...Object.entries(NAMES).flatMap(([key, host]) => [
      "--add-host",
      `${host}:${ENDPOINTS[key as keyof typeof ENDPOINTS][0]}`,
    ]),
    ...(options.bindWorkspace
      ? ["--mount", `type=bind,source=${options.bindWorkspace}/tmp,target=/tmp`]
      : ["--tmpfs", "/tmp:size=64m"]),
    "--tmpfs",
    "/home/sandbox:uid=1000,gid=1000,mode=755",
    ...(options.bindWorkspace
      ? ["--mount", `type=bind,source=${options.bindWorkspace}/workspace,target=/workspace`]
      : ["--tmpfs", "/workspace:exec,uid=1000,gid=1000,mode=755"]),
    "--tmpfs",
    `${RECEIPTS}:mode=755`,
    IMAGE,
    "sleep",
    "infinity",
  ]);
  const run = (command: string, user = USER) =>
    docker(["exec", "-i", "-u", user, name, "sh", "-c", command]);
  try {
    docker(
      ["exec", "-i", "-u", "0", name, "sh", "-c", `cat > ${RECEIPTS}/listen.py`],
      await import("node:fs").then((fs) => fs.readFileSync(LISTEN, "utf8")),
    );
    const child = spawn("docker", [
      "exec",
      "-u",
      "0",
      name,
      "python3",
      "-I",
      `${RECEIPTS}/listen.py`,
      RECEIPTS,
      JSON.stringify(ENDPOINTS),
    ]);
    child.unref();
    docker([
      "exec",
      name,
      "python3",
      "-c",
      `import socket
for host, port in (("127.0.0.1", 18080), ("127.0.0.1", 18081), ("::1", 18082)):
    while True:
        try:
            socket.create_connection((host, port)).close()
            break
        except OSError:
            pass`,
    ]);
  } catch (error) {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    throw error;
  }
  return {
    name,
    run,
    remove: () => {
      for (const [key, inspector] of inspectors)
        if (key.startsWith(`${name}/`)) {
          inspector.close();
          inspectors.delete(key);
        }
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    },
  };
}

const INSPECT = `
import base64, json, os, sys

def answer(request):
    kind = request["what"]
    if kind == "read":
        try:
            with open(request["path"], "rb") as handle:
                return base64.b64encode(handle.read()).decode()
        except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
            return None
    if kind == "mode":
        try:
            return os.stat(request["path"]).st_mode & 0o7777
        except FileNotFoundError:
            return None
    if kind == "alive":
        alive = []
        for pid in request["pids"]:
            try:
                with open("/proc/%d/stat" % pid) as handle:
                    state = handle.read().rsplit(")", 1)[1].split()[0]
                if state not in ("Z", "X"):
                    alive.append(pid)
            except OSError:
                pass
        return alive
    if kind == "seed":
        for entry in request["entries"]:
            os.makedirs(os.path.dirname(entry["path"]), exist_ok=True)
            if entry["kind"] == "directory":
                os.makedirs(entry["path"], exist_ok=True)
            elif entry["kind"] == "file":
                with open(entry["path"], "wb") as handle:
                    handle.write(base64.b64decode(entry["dataB64"]))
            else:
                os.symlink(entry["target"], entry["path"])
        return True
    if kind == "outside":
        # a fresh process of this uid outside every operation (another session's Full work)
        import subprocess
        done = subprocess.run(["python3", "-", *request["args"]], input=request["program"].encode(),
                              capture_output=True)
        if done.returncode != 0:
            raise RuntimeError(done.stderr.decode())
        return done.stdout.decode()
    raise ValueError(kind)

for line in sys.stdin:
    request = json.loads(line)
    try:
        reply = {"id": request["id"], "result": answer(request)}
    except Exception as error:
        reply = {"id": request["id"], "error": str(error)}
    sys.stdout.write(json.dumps(reply) + "\\n")
    sys.stdout.flush()
`;

/** One long-lived trusted inspector process in the device (a docker exec per call is slow). */
class Inspector {
  private readonly child;
  private readonly pending = new Map<
    number,
    (reply: { result?: unknown; error?: string }) => void
  >();
  private next = 0;
  private buffered = "";
  constructor(device: string, user: string) {
    this.child = spawn("docker", ["exec", "-i", "-u", user, device, "python3", "-c", INSPECT], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child.stdout.on("data", (b: Buffer) => {
      this.buffered += b.toString("utf8");
      for (let i = this.buffered.indexOf("\n"); i >= 0; i = this.buffered.indexOf("\n")) {
        const reply = JSON.parse(this.buffered.slice(0, i)) as { id: number; result?: unknown };
        this.buffered = this.buffered.slice(i + 1);
        this.pending.get(reply.id)?.(reply);
        this.pending.delete(reply.id);
      }
    });
  }
  ask(request: object): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) =>
        reply.error === undefined ? resolve(reply.result) : reject(new Error(reply.error)),
      );
      this.child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }
  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

const inspectors = new Map<string, Inspector>();
/** A trusted, out-of-band inspection inside the device (root for reads, the user for seeding). */
export async function inspect(device: LinuxDevice, request: object, user = "0"): Promise<unknown> {
  const key = `${device.name}/${user}`;
  let inspector = inspectors.get(key);
  if (!inspector) {
    inspector = new Inspector(device.name, user);
    inspectors.set(key, inspector);
  }
  return inspector.ask(request);
}

let sequence = 0;
/** A fresh operation scope for a grant (new operation ID), as the kernel would resolve it. */
export function scopeFor(
  deviceId: string,
  grant: OperationGrant,
  admitMs = 120_000,
): SandboxOperationScope {
  const operationId = `op-${++sequence}-${randomUUID().slice(0, 8)}`;
  return {
    operationId,
    admitBeforeMs: Date.now() + admitMs,
    deviceId,
    rootConversationId: "conversation",
    profileRevision: 0,
    ceilingRevision: "ceiling",
    profile: grant.profile,
    actor: { accountId: "account", conversationId: "conversation" },
    tag: operationId,
    filesystem: grant.filesystem,
    network: grant.network,
  } as SandboxOperationScope;
}

/** The owner ceiling of the fixture device: Full allowed, restricted reach in the workspace. */
export function fixtureCeiling(roots: DeviceOwnerCeiling["roots"]): DeviceOwnerCeiling {
  return {
    revision: "one",
    fullAccess: true,
    roots,
    restrictedProjectReach: "workspace",
    restrictedAllowedDomains: [NAMES.granted],
    restrictedDeniedReadRoots: [],
    preparation: {
      skillsRoot: roots.skills,
      attachmentsBase: join(roots.workspace, "attachments"),
    },
    fullNetwork: "environment",
  };
}

/** A private state directory for one backend (the journal, retained output). */
export async function stateDirectory(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cap-linux-backend-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
