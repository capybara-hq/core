import { randomUUID } from "node:crypto";
import {
  createDualReplicaHarness,
  type Harness,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PLUGIN_SCOPE_QUEUE,
  SCOPE_ITEM_JOB,
  scopeItemJobId,
} from "../../src/catalog/scope-sync.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW, waitFor } from "../helpers/runs.js";

/**
 * Dual replica: the scope sync of one `all` item is enqueued from both replicas at once (org
 * creations on each replica enqueue their org's job; item jobs for several scope versions are added
 * besides), and both replicas' workers converge the same orgs concurrently. Exactly one live install
 * per org, no failed install.
 */

let pgc: TestContainer;
let rdc: TestContainer;
let h: Harness | undefined;
let raw: ReturnType<typeof createDb> | undefined;
let queue: Queue | undefined;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
}, 120_000);

afterAll(async () => {
  await queue?.close();
  await raw?.destroy();
  await h?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;

describe("plugin scope sync (dual replica)", () => {
  it("both replicas sync the same item: one live install per org, none failed", async () => {
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      config: { auth: { cookieSecure: false } },
    });
    const harness = h;
    raw = createDb(harness.dbUrl, 3);
    const db: KernelSchemaDb = kernelDb(raw);
    queue = new Queue(PLUGIN_SCOPE_QUEUE, {
      connection: new Redis(rdc.url, { maxRetriesPerRequest: null }),
    });

    let cookie = "";
    const call = async (
      index: number | undefined,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const init = {
        method,
        headers: {
          "x-capybara-csrf": "1",
          ...(cookie !== "" && { cookie }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      };
      const res =
        index === undefined
          ? await harness.request(path, init)
          : await harness.requestTo(index, path, init);
      const text = await res.text();
      if (path === "/api/v1/auth/login") {
        cookie = res.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ");
      }
      return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
    };

    await accountsFor(db).createLocal({
      login: "owner",
      password: PW,
      displayName: "O",
      superAdmin: true,
    });
    expect(
      (await call(undefined, "POST", "/api/v1/auth/login", { login: "owner", password: PW }))
        .status,
    ).toBe(200);

    // An `all` plugin with no components (no object store needed): written as an import leaves it
    const itemId = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: "everywhere",
        package_name: "@acme/plugin-everywhere",
        publisher: "Acme",
        description: "Empty bundle",
        latest_version: "1.0.0",
        policy: "allow",
        scope: "all",
        scope_version: 1,
      })
      .execute();
    await db
      .insertInto("catalog_item_versions")
      .values({
        item_id: itemId,
        version: "1.0.0",
        manifest: JSON.stringify({
          schemaVersion: 1,
          name: "everywhere",
          version: "1.0.0",
          publisher: "Acme",
          description: "Empty bundle",
          skills: [],
          connectorTemplates: [],
        }),
        source: "file",
        source_ref: "upload",
        object_prefix: null,
        files: JSON.stringify([]),
        size: 10,
      })
      .execute();

    // Org creations on both replicas (each enqueues its org's sync on the replica that served it)
    const orgIds: string[] = [];
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(i % 2, "POST", "/api/v1/orgs", { name: `Org ${i}` }),
      ),
    );
    for (const r of created) {
      expect(r.status).toBe(201);
      orgIds.push((r.json.org as { id: string }).id);
    }
    // ...and item jobs for several scope versions, picked up by both replicas' workers
    await Promise.all(
      [1, 2, 3, 4].map((v) =>
        queue?.add(
          SCOPE_ITEM_JOB,
          { kind: "item", itemId },
          { jobId: scopeItemJobId(itemId, v), removeOnComplete: true, removeOnFail: true },
        ),
      ),
    );

    await waitFor(
      async () => {
        const c = await queue?.getJobCounts("waiting", "active", "delayed", "prioritized");
        return c !== undefined && Object.values(c).every((n) => n === 0);
      },
      60_000,
      "scope queue idle",
    );
    const installs = await db
      .selectFrom("plugin_installs")
      .select(["org_id", "status"])
      .where("item_id", "=", itemId)
      .execute();
    const live = installs.filter((r) => r.status !== "failed").map((r) => r.org_id);
    expect(live.sort()).toEqual([...orgIds].sort());
    expect(installs.filter((r) => r.status === "failed")).toEqual([]);
    const failed = await db
      .selectFrom("audit_events")
      .select("action")
      .where("action", "in", ["plugin.org_install_failed", "plugin.scope_sync_failed"])
      .execute();
    expect(failed).toEqual([]);
  }, 120_000);
});
