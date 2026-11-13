import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ConversationDevices } from "../../src/devices/conversation-devices.js";
import { ApiError } from "../../src/errors.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { SandboxFileReader } from "../../src/sandbox/sandbox-file-reader.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * SandboxFileReader: one file of a conversation's sandbox read for the kernel (skill authoring
 * spec), on a real kernel and the fake sandbox plugin.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let reader: SandboxFileReader;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-sbx-file-reader-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
      },
    ),
  );
  reader = k.app.get(SandboxFileReader);
});

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let orgId: string;
let convId: string;

beforeEach(async () => {
  await truncateTables(
    db,
    "capybara.devices, capybara.sandboxes, capybara.runs, capybara.conversation_events, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Author",
        instructions: "Build skills.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "private",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  convId = await createConv(owner, orgId, (res.json() as { agent: { id: string } }).agent.id);
});

/** Writes `data` at `rel` under the conversation's workspace; returns the workspace root. */
async function put(rel: string, data: string): Promise<string> {
  const deviceId = await k.app.get(ConversationDevices).forTool(orgId, convId);
  const signal = new AbortController().signal;
  return k.app.get(SandboxService).withSandbox(
    {
      orgId,
      deviceId,
      holderConversationId: convId,
      actor: { accountId: ownerId, conversationId: convId },
    },
    async (h, p, info, s) => {
      await p.writeFile(h, `${info.roots.workspace}/${rel}`, new TextEncoder().encode(data), s);
      return info.roots.workspace;
    },
    signal,
  );
}

const read = (path: string, maxBytes = 1024) =>
  reader.read({
    orgId,
    conversationId: convId,
    actorAccountId: ownerId,
    path,
    maxBytes,
    signal: new AbortController().signal,
  });

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    const err = e as ApiError;
    expect(err.status).toBe(422);
    return { code: err.code, message: err.message };
  }
  throw new Error("expected the read to fail");
}

describe("SandboxFileReader.read", () => {
  it("returns the bytes of a file in the conversation's sandbox", async () => {
    const ws = await put("pkg/skill.zip", "hello");
    const got = await read(`${ws}/pkg/skill.zip`);
    expect(new TextDecoder().decode(got)).toBe("hello");
  });

  it("refuses a relative path and a path outside the sandbox roots", async () => {
    await put("a.txt", "x");
    expect((await codeOf(read("../etc/passwd"))).code).toBe("sandbox.file_invalid_path");
    expect((await codeOf(read("/etc/passwd"))).code).toBe("sandbox.file_invalid_path");
  });

  it("reports a missing file", async () => {
    const ws = await put("a.txt", "x");
    const err = await codeOf(read(`${ws}/missing.zip`));
    expect(err.code).toBe("sandbox.file_not_found");
    expect(err.message).toContain(`${ws}/missing.zip`);
  });

  it("refuses a directory", async () => {
    const ws = await put("dir/a.txt", "x");
    expect((await codeOf(read(`${ws}/dir`))).code).toBe("sandbox.file_is_directory");
  });

  it("refuses a file over maxBytes, naming the path and the limit", async () => {
    const ws = await put("big.zip", "12345");
    const err = await codeOf(read(`${ws}/big.zip`, 4));
    expect(err.code).toBe("sandbox.file_too_large");
    expect(err.message).toContain(`${ws}/big.zip`);
    expect(err.message).toContain("4 bytes");
  });
});
