import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import { EventLog } from "../../../src/conversations/event-log.js";
import { createDb } from "../../../src/db/pool.js";
import { BuiltinTools } from "../../../src/tools/builtins/builtin-tools.js";
import { startKernel, type TestKernel } from "../../helpers/runs.js";
import { seedDevice } from "../../helpers/sandbox.js";

/**
 * Read before Write and Edit across two replicas (two kernels on one PG / Redis and one fake
 * sandbox root): the decision comes only from the conversation's log in PG, so a Read handled by
 * replica A lets replica B edit, and a change made through B is caught on A.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const MODIFIED =
  "File has been modified since it was read, either by the user or by another command. Read it again before writing to it.";

let pgc: TestContainer;
let rdc: TestContainer;
let root: string;
let raw: ReturnType<typeof createDb>;
const kernels: TestKernel[] = [];

const cfg = () =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rdc.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    roles: ["api"],
    extensions: [SANDBOX_FAKE],
    extensionConfig: { "sandbox-fake": { root } },
    extensionPermissions: { autoApprove: true },
  });

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  root = await mkdtemp(join(tmpdir(), "cap-rbw-dual-"));
  raw = createDb(pgc.url, 2);
}, 120_000);

afterAll(async () => {
  for (const k of kernels) await k.close();
  await raw?.destroy();
  await rm(root, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

describe("read before write (two replicas)", { timeout: 90_000 }, () => {
  it("the decision uses only PG: Read on A lets B edit; a change through B is caught on A", async () => {
    const [a, b] = await Promise.all([startKernel(cfg()), startKernel(cfg())]);
    kernels.push(a, b);
    const accountId = randomUUID();
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
      raw,
    );
    await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
      VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
    await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
      VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
    // bound to a device of the owner's (both replicas reach its one instance)
    const deviceId = await seedDevice(raw, orgId, accountId);
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, device_id)
      VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId}, ${deviceId})`.execute(raw);

    let step = 0;
    /** Runs a builtin on a replica and logs its result the way the tool pipeline does. */
    const use = async (k: TestKernel, name: string, input: unknown) => {
      const tool = k.app
        .get(BuiltinTools)
        .list()
        .find((t) => t.spec.name === name);
      if (!tool) throw new Error(`no builtin ${name}`);
      const callId = `c${++step}`;
      try {
        const r = await tool.run(input, {
          orgId,
          accountId,
          agentId,
          conversationId,
          callId,
          signal: AbortSignal.timeout(30_000),
        });
        if ("content" in r) {
          const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
          await k.app.get(EventLog).append(conversationId, [
            {
              type: "tool_result",
              payload: {
                step,
                callId,
                toolKey: name,
                content: text,
                isError: false,
                ...(r.view !== undefined && { view: r.view }),
              },
            },
          ]);
        }
        return { error: null as string | null };
      } catch (e) {
        return { error: (e as Error).message };
      }
    };

    expect(
      (await use(a, "Bash", { description: "seed", command: "printf 'one\\n' > /workspace/a.txt" }))
        .error,
    ).toBeNull();
    expect((await use(a, "Read", { file_path: "/workspace/a.txt" })).error).toBeNull();
    // Edit on the other replica succeeds on the strength of A's Read
    expect(
      (
        await use(b, "Edit", {
          file_path: "/workspace/a.txt",
          old_string: "one",
          new_string: "two",
        })
      ).error,
    ).toBeNull();
    // a change through B (its Bash is not logged as a file state) is caught on A
    expect(
      (
        await use(b, "Bash", {
          description: "append",
          command: "printf 'x\\n' >> /workspace/a.txt",
        })
      ).error,
    ).toBeNull();
    const bad = await use(a, "Edit", {
      file_path: "/workspace/a.txt",
      old_string: "two",
      new_string: "three",
    });
    expect(bad.error).toBe(MODIFIED);
    expect((await use(b, "Read", { file_path: "/workspace/a.txt" })).error).toBeNull();
    expect(
      (
        await use(a, "Edit", {
          file_path: "/workspace/a.txt",
          old_string: "two",
          new_string: "three",
        })
      ).error,
    ).toBeNull();
  });
});
