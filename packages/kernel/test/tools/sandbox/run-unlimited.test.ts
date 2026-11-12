import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../../helpers/runs.js";

/**
 * Without a run duration limit (`runtime.maxRunSeconds` 0, the default) a sandbox command's timeout
 * comes from the command limits alone (`sandbox.limits.maxCommandSeconds`, the Bash timeout), and
 * its result carries no time-budget sentence (counterpart of run-budget.test.ts).
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-sbx-unlimited-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, SANDBOX_FAKE],
        extensionConfig: { "sandbox-fake": { root } },
        // the run limits stay at their defaults (none); commands may run 2 seconds at most
        sandbox: { limits: { maxCommandSeconds: 2 } },
      },
    ),
  );
}, 180_000);

afterAll(async () => {
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

type ToolResultEvent = Extract<ConversationEvent, { type: "tool_result" }>;

describe("Bash under a run without a duration limit", { timeout: 90_000 }, () => {
  it("the command's timeout is the command maximum, with no time-budget sentence", async () => {
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    const owner = await session(k, "owner");
    const orgId = await createOrg(owner);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Coder",
          instructions: "Use the sandbox.",
          model: { provider: "model-fake", model: "fake-1" },
          disabledTools: onlyBuiltins([{ kind: "builtin", name: "Bash" }]),
        },
        visibility: "org",
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const conv = await createConv(owner, orgId, (res.json() as { agent: { id: string } }).agent.id);

    const input = { description: "Test step", command: "sleep 120", timeout: 600_000 };
    await postMessage(owner, orgId, conv, `tool:Bash:${JSON.stringify(input)}`);
    const [run] = await waitForTerminal(db, conv, 1, 60_000);
    expect(run?.type).toBe("run_finished");
    const r = (await eventsOf(db, conv)).find(
      (e): e is ToolResultEvent => e.type === "tool_result",
    )?.payload;
    expect(r?.isError).toBe(true);
    // lowered to sandbox.limits.maxCommandSeconds (2 s), not to a run budget
    expect(r?.content).toContain("did not finish within 2s");
    expect(r?.content).toContain("it was lowered to 2000 ms");
    expect(r?.content).not.toContain("time budget");
    expect(r?.content).not.toContain("runtime.maxRunSeconds");
  });
});
