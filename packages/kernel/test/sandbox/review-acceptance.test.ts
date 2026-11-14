import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceExecArgs, KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reviewRules } from "../../src/sandbox/review/index.js";
import {
  readFakeSandboxLimits,
  readFakeSandboxOps,
} from "../fixtures/plugins/sandbox-fake/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * Acceptance end to end for auto mode (spec §10, plan T15): the six scenarios that failed on real
 * devices during acceptance 2026-11-12/13, run through a real kernel. The device is the fake sandbox
 * (a real `/bin/sh` in a temporary directory; `gh` and `git` are small fake programs on its PATH) or
 * a `FakeMachine` over the local-device protocol. The model is `model-fake`
 * (`tool:<key>:<json>` calls the tool).
 *
 * 1. clone `capybara-hq/core` (a repository carrying today's sandbox-protected files);
 * 2. a local server on `127.0.0.1` (Docker's socket proxy shape);
 * 3. a background `git clone` (reviewed before launch, read with `TaskOutput`);
 * 4. `gh pr create` on a local device (review allows `allow.gh`; the owner's machine runs it);
 * 5. `gh auth login` on a cloud device (one `device_code` event, no token);
 * 6. a scheduled task hitting an `ask` command — in `review-pipeline.test.ts` (the scheduled task
 *    machinery lives there).
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

/** The recorded `gh auth login --web` prompt (gh 2.63, GitHub.com, 2026-11-14). */
const CODE_LINE = "! First copy your one-time code: 1A2B-C3D4";
const URL_PROMPT_LINE = "- Press Enter to open https://github.com/login/device in your browser...";

/** The repository the acceptance clone used; its `.mcp.json` and `.claude/` are protected files. */
const CORE_URL = "https://github.com/capybara-hq/core";

/** A fake `git` (node): `clone` writes the protected-file tree under the destination. */
const FAKE_GIT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "clone") {
  const rest = args.slice(1).filter((a) => !a.startsWith("-"));
  const url = rest[0] || "";
  let dest = rest[1];
  if (!dest) dest = url.replace(/\\/+$/, "").split("/").pop().replace(/\\.git$/, "");
  const files = {
    "README.md": "# core\\n",
    ".mcp.json": "{}\\n",
    ".claude/commands/hello.md": "say hello\\n",
    ".vscode/settings.json": "{}\\n",
    ".idea/workspace.xml": "<project/>\\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dest, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  console.log("Cloning into '" + dest + "'...");
  console.log("done.");
  process.exit(0);
}
console.error("fake git: unsupported command " + args.join(" "));
process.exit(2);
`;

/** A fake `gh` (node): `pr create` prints the PR URL, `auth login` prints the device prompt. */
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/capybara-hq/core/pull/4242");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login") {
  console.log(${JSON.stringify(CODE_LINE)});
  console.log(${JSON.stringify(URL_PROMPT_LINE)});
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log("Logged in to github.com as owner");
  process.exit(0);
}
console.error("fake gh: unsupported command " + args.join(" "));
process.exit(2);
`;

/**
 * A no-op `rm` first on the fake sandbox's PATH. The fixture has no isolation and runs commands
 * with `/bin/sh -c` on the host, so scenario 3's denied `rm -rf /` must be harmless even if a
 * launch-then-deny regression ever executes it. The review is textual, so the deny is unchanged.
 */
const FAKE_RM = `#!/bin/sh
exit 0
`;

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let binDir: string;
let owner: Req;
let ownerId: string;
/** auto mode allowed (the default): a sandbox-fake device runs unsandboxed. */
let orgAuto: string;
let agentAuto: string;
/** auto mode off for the org: devices run in sandbox mode (the allowlist network). */
let orgSandbox: string;
let agentSandbox: string;
let versionServer: Server;
let versionUrl: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-review-accept-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        // the fake sandbox's exec PATH starts with `<root>/bin`: put the fake `gh` / `git` there
        sandbox: { limits: { egress: "allowlist", allowHosts: ["example.com"] } },
      },
    ),
  );
  // the provider wrote its shims in `setup`; the fake programs go beside them on the same PATH
  binDir = join(await realpath(root), "bin");
  await writeFile(join(binDir, "git"), FAKE_GIT);
  await chmod(join(binDir, "git"), 0o755);
  await writeFile(join(binDir, "gh"), FAKE_GH);
  await chmod(join(binDir, "gh"), 0o755);
  // a no-op `rm` beside the fake programs: an accidental execution of a denied command is harmless
  await writeFile(join(binDir, "rm"), FAKE_RM);
  await chmod(join(binDir, "rm"), 0o755);

  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");

  orgAuto = await createOrg(owner, "Auto");
  agentAuto = await createAgent(orgAuto);
  orgSandbox = await createOrg(owner, "Sandbox");
  const off = await owner({
    method: "PATCH",
    url: `/api/v1/orgs/${orgSandbox}/settings`,
    // sandbox mode on a cloud device narrows the network to the org's allowlist
    payload: { autoMode: "off", cloudNetwork: { mode: "allowlist" } },
  });
  expect(off.statusCode, off.body).toBe(200);
  agentSandbox = await createAgent(orgSandbox);

  // the "local server" of scenario 2: a real HTTP server on 127.0.0.1 (an ephemeral port; the
  // recorded Docker-proxy shape is pinned separately against the literal 2375 command)
  versionServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Version: "27.0.0", ApiVersion: "1.46" }));
  });
  await new Promise<void>((resolve) => versionServer.listen(0, "127.0.0.1", resolve));
  const address = versionServer.address();
  versionUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/version`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => versionServer?.close(() => resolve()));
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

/** An agent that can use Bash and the file tools the scenarios need. */
async function createAgent(orgId: string): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the device.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins(
          ["Bash", "Read", "Write", "Edit"].map((name) => ({
            kind: "builtin" as const,
            name,
          })),
        ),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

type ToolResult = Extract<ConversationEvent, { type: "tool_result" }>;

const results = async (conv: string): Promise<ToolResult[]> =>
  (await eventsOf(db, conv)).filter((e): e is ToolResult => e.type === "tool_result");

/** Runs one tool call and waits for the run's terminal event (the call finished or was refused). */
async function call(conv: string, key: string, input: unknown, n: number): Promise<ToolResult> {
  await postMessage(owner, orgAuto, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
  return (await results(conv)).at(-1) as ToolResult;
}

/** The same, in an org whose mode is fixed by the org settings. */
async function callIn(
  orgId: string,
  conv: string,
  key: string,
  input: unknown,
  n: number,
): Promise<ToolResult> {
  await postMessage(owner, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
  return (await results(conv)).at(-1) as ToolResult;
}

describe("acceptance: auto mode on a real kernel", () => {
  it("scenario 1: cloning a repository with protected files succeeds in auto mode and is allowed", async () => {
    const conv = await createConv(owner, orgAuto, agentAuto);
    const cloned = await call(
      conv,
      "Bash",
      { command: `git clone ${CORE_URL}`, description: "Clone core" },
      1,
    );
    expect(cloned.payload.isError, cloned.payload.content).toBe(false);
    expect(cloned.payload.review).toMatchObject({
      decision: "allow",
      by: "rule",
      rule: "allow.git",
    });
    expect(cloned.payload.content).toContain("Cloning into");

    // the protected-file tree today's sandbox refused to write is in the device's workspace
    const mcp = await call(conv, "Read", { file_path: "/workspace/core/.mcp.json" }, 2);
    expect(mcp.payload.isError, mcp.payload.content).toBe(false);
    const command = await call(
      conv,
      "Read",
      { file_path: "/workspace/core/.claude/commands/hello.md" },
      3,
    );
    expect(command.payload.content).toContain("say hello");
  });

  it("scenario 1 (sandbox): the file tools stay root-confined and the clone writes under the workspace", async () => {
    const conv = await createConv(owner, orgSandbox, agentSandbox);
    // a read outside the device's roots is refused (the sandbox keeps the workspace, skills, tmp)
    const outside = await callIn(orgSandbox, conv, "Read", { file_path: "/etc/passwd" }, 1);
    expect(outside.payload.isError).toBe(true);
    expect(outside.payload.content).toContain("/workspace");
    // a write outside the roots is refused before the device is touched
    const write = await callIn(orgSandbox, conv, "Write", { file_path: "/etc/x", content: "x" }, 2);
    expect(write.payload.isError).toBe(true);
    expect(write.payload.content).toContain("/workspace");

    // the clone runs in the workspace; its files are there and readable
    const cloned = await callIn(
      orgSandbox,
      conv,
      "Bash",
      { command: `git clone ${CORE_URL}`, description: "Clone core" },
      3,
    );
    expect(cloned.payload.isError, cloned.payload.content).toBe(false);
    expect(cloned.payload.review).toMatchObject({ decision: "allow", rule: "allow.git" });
    const mcp = await callIn(
      orgSandbox,
      conv,
      "Read",
      { file_path: "/workspace/core/.mcp.json" },
      4,
    );
    expect(mcp.payload.isError, mcp.payload.content).toBe(false);
  });

  it("scenario 2: a local server on 127.0.0.1 is reachable in auto mode (no proxy-guard downgrade)", async () => {
    // the recorded Docker socket-proxy probe: allowed by the rule table, never downgraded
    expect(
      reviewRules("curl http://127.0.0.1:2375/version", {
        workspace: "/workspace",
        mode: "auto",
        attended: true,
      }),
    ).toMatchObject({ outcome: "allow", hits: [{ id: "allow.network" }] });

    const conv = await createConv(owner, orgAuto, agentAuto);
    const version = await call(
      conv,
      "Bash",
      { command: `curl -s ${versionUrl}`, description: "Check the docker proxy" },
      1,
    );
    expect(version.payload.isError, version.payload.content).toBe(false);
    expect(version.payload.review).toMatchObject({ decision: "allow", rule: "allow.network" });
    // the command really reached the loopback server
    expect(version.payload.content).toContain('"Version":"27.0.0"');
  });

  it("scenario 2 (sandbox): the device's network is the allowlist", async () => {
    const conv = await createConv(owner, orgSandbox, agentSandbox);
    const version = await callIn(
      orgSandbox,
      conv,
      "Bash",
      { command: `curl -s ${versionUrl}`, description: "Check the docker proxy" },
      1,
    );
    // the rules are the same in both modes; the network is what sandbox mode narrows
    expect(version.payload.review).toMatchObject({ decision: "allow", rule: "allow.network" });
    const created = await waitFor(
      async () => {
        const entries = await readFakeSandboxLimits(root);
        return entries.filter((e) => e.op !== "update").at(-1) ?? null;
      },
      30_000,
      "the created device's limits",
    );
    expect(created.limits.mode).toBe("sandbox");
    expect(created.limits.network.kind).toBe("allowlist");
  });

  it("scenario 3: a background git clone is reviewed before it launches and TaskOutput shows it", async () => {
    const conv = await createConv(owner, orgAuto, agentAuto);
    // a dangerous background launch is denied before anything starts. The command would be harmless
    // if executed (`binDir` carries the no-op `rm`, see FAKE_RM); the assertions are what make a
    // launch-then-deny regression red: a launch inserts its `background_tasks` row as soon as it
    // starts, and every exec reaches the sandbox's own log.
    const denied = await call(
      conv,
      "Bash",
      { command: "rm -rf /", description: "Clean up", run_in_background: true },
      1,
    );
    expect(denied.payload.isError).toBe(true);
    expect(denied.payload.review).toMatchObject({ decision: "deny", rule: "deny.root-delete" });
    expect(denied.payload.content).not.toContain("Started background task");
    const tasks = await db
      .selectFrom("background_tasks")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    expect(tasks, "the denied launch created no background task").toEqual([]);
    const execs = (await readFakeSandboxOps(root)).filter(
      ([op, , , , , , conversationId]) => op === "exec" && conversationId === conv,
    );
    expect(execs, "the denied launch reached no command in the sandbox").toEqual([]);

    const launched = await call(
      conv,
      "Bash",
      {
        command: `git clone ${CORE_URL} cloned`,
        description: "Clone in the background",
        run_in_background: true,
      },
      2,
    );
    expect(launched.payload.isError, launched.payload.content).toBe(false);
    // the launch itself carries the review decision: the command was judged before it ran
    expect(launched.payload.review).toMatchObject({ decision: "allow", rule: "allow.git" });
    // the same log now holds this conversation's launch exec: the empty check above is not vacuous
    const launchExecs = (await readFakeSandboxOps(root)).filter(
      ([op, , , , , , conversationId]) => op === "exec" && conversationId === conv,
    );
    expect(launchExecs.length, "the allowed launch reached the sandbox").toBeGreaterThan(0);
    const taskId = /Started background task (bt_[A-Za-z0-9_-]+)/.exec(
      launched.payload.content,
    )?.[1];
    expect(taskId, launched.payload.content).toBeDefined();

    const output = await call(
      conv,
      "TaskOutput",
      { task_id: taskId, block: true, timeout: 30_000 },
      3,
    );
    expect(output.payload.isError, output.payload.content).toBe(false);
    expect(output.payload.content).toContain("Cloning into 'cloned'");
  });

  it("scenario 4: gh pr create on a local device is allowed and runs on the owner's machine", async () => {
    const device = await localDevice();
    const conv = await createConv(owner, orgAuto, agentAuto);
    await db
      .updateTable("conversations")
      .set({ device_id: device.deviceId })
      .where("id", "=", conv)
      .execute();
    const command = 'gh pr create --title "feat: auto mode" --body "T15"';
    const created = await call(conv, "Bash", { command, description: "Open the PR" }, 1);
    expect(created.payload.isError, created.payload.content).toBe(false);
    expect(created.payload.review).toMatchObject({
      decision: "allow",
      by: "rule",
      rule: "allow.gh",
    });
    expect(created.payload.content).toContain("pull/4242");

    // the reviewed command reached the device the owner signed in on (it runs as the owner)
    const exec = device.machine.frames.find(
      (f): f is Extract<KernelReq, { op: "exec" }> =>
        f.type === "req" && f.op === "exec" && (f.args as DeviceExecArgs).command === command,
    );
    expect(exec, "the exec reached the owner's device").toBeDefined();
    const row = await db
      .selectFrom("device_machines")
      .select("account_id")
      .where("device_id", "=", device.deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    expect(row?.account_id).toBe(ownerId);
    device.machine.close();
  });

  it("scenario 5: gh auth login on a cloud device yields one device_code event and no token", async () => {
    const conv = await createConv(owner, orgAuto, agentAuto);
    const launched = await call(
      conv,
      "Bash",
      { command: "gh auth login --web", description: "Sign in", run_in_background: true },
      1,
    );
    expect(launched.payload.isError, launched.payload.content).toBe(false);
    const taskId = /Started background task (bt_[A-Za-z0-9_-]+)/.exec(
      launched.payload.content,
    )?.[1];
    expect(taskId, launched.payload.content).toBeDefined();
    // the launch only records the task: nothing has read the prompt yet
    expect((await eventsOf(db, conv)).filter((e) => e.type === "device_code")).toHaveLength(0);

    await call(conv, "TaskOutput", { task_id: taskId, block: true, timeout: 30_000 }, 2);
    const events = await eventsOf(db, conv);
    const codes = events.filter(
      (e): e is Extract<ConversationEvent, { type: "device_code" }> => e.type === "device_code",
    );
    // the recorded gh output yields exactly one card, carrying the URL and the code the person needs
    expect(codes).toHaveLength(1);
    expect(codes[0]?.payload).toMatchObject({
      url: "https://github.com/login/device",
      code: "1A2B-C3D4",
    });
    // the kernel-internal device-code field never reaches the log (a real guard). No token
    // assertion here: the fake `gh` prints only the device prompt, and the kernel copies raw exec
    // output into the tool result, so a token in that output would surface by design; a regex over
    // events could never fail and would pin nothing.
    expect(JSON.stringify(events)).not.toContain("loginCode");
  });
});

/** The owner's local device: a machine connected over the device protocol, signing in on the host. */
async function localDevice(): Promise<{ deviceId: string; machine: FakeMachine }> {
  const authorized = await owner({
    method: "POST",
    url: "/api/v1/device/authorize",
    payload: { name: "accept-box", os: "linux", arch: "x64", programVersion: "0.1.0" },
  });
  expect(authorized.statusCode, authorized.body).toBe(200);
  const { userCode, deviceCode } = authorized.json() as { userCode: string; deviceCode: string };
  const confirmed = await owner({
    method: "POST",
    url: "/api/v1/device/confirm",
    payload: { userCode, orgId: orgAuto, name: "Accept box" },
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  const issued = await owner({
    method: "POST",
    url: "/api/v1/device/token",
    payload: { deviceCode },
  });
  expect(issued.statusCode, issued.body).toBe(200);
  const { credential, deviceId } = issued.json() as { credential: string; deviceId: string };

  const machine = new FakeMachine(
    `ws://127.0.0.1:${k.port}/device/connect`,
    credential,
    (req: KernelReq): Answer => {
      if (req.op === "create") return { ok: true, result: { roots: { ...HELLO.roots } } };
      if (req.op !== "exec") return { ok: true, result: null };
      return {
        ok: true,
        result: {
          exitCode: 0,
          stdout: "https://github.com/capybara-hq/core/pull/4242\n",
          stderr: "",
          truncated: false,
          timedOut: false,
        },
      };
    },
    { hello: false },
  );
  await machine.opened;
  machine.send({ ...HELLO, features: ["mode"], policy: { mode: "auto", allowedDomains: [] } });
  // the policy frame is recorded before the conversation can use the device
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("local_policy")
          .where("device_id", "=", deviceId)
          .where("revoked_at", "is", null)
          .executeTakeFirst()
      )?.local_policy != null,
    15_000,
    "the device's policy recorded",
  );
  return { deviceId, machine };
}
