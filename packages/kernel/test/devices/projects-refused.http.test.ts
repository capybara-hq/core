import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createOrg,
  enableDeviceProviders,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * A provider refusing a project directory (`ProjectPathRefusedError` from its `list`), end to end
 * on a cloud device of the fake provider: 422 `device.project_refused` with the provider's reason.
 * Its own file: the provider offers `list` here, which the cases of projects.http.test.ts rely on
 * it not doing.
 */

const DEVICE_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let root: string;
let orgId: string;
let owner: Awaited<ReturnType<typeof session>>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cap-projects-refused-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [DEVICE_FAKE],
        extensionConfig: {
          "device-fake": { root, list: true, refusePaths: ["/workspace/refused"] },
        },
      },
    ),
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await enableDeviceProviders(k, orgId);
});

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

describe("a provider refusing a project path", () => {
  it("answers 422 device.project_refused with its reason; other paths are added", async () => {
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices`,
      payload: { name: `Cloud ${randomUUID().slice(0, 6)}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { device: { id: string } }).device.id;
    const url = `/api/v1/orgs/${orgId}/devices/${id}/projects`;
    const names = async () =>
      (
        (await owner({ method: "GET", url })).json() as { projects: { name: string }[] }
      ).projects.map((p) => p.name);

    // the refused directory itself, a path below it, and a spelling that resolves into it
    for (const path of ["refused", "refused/sub", "app/../refused"]) {
      const res = await owner({ method: "POST", url, payload: { path } });
      expect(res.statusCode, `${path}: ${res.body}`).toBe(422);
      expect(res.json()).toMatchObject({
        error: {
          code: "device.project_refused",
          message: "Refused by the test provider",
          details: [
            { reason: { en: "Refused by the test provider", zh: "测试提供方拒绝了这个目录" } },
          ],
        },
      });
    }
    expect(await names()).toEqual([]);

    // a sibling is not caught by the prefix match: its directory does not exist, the usual refusal
    const other = await owner({ method: "POST", url, payload: { path: "refused-not" } });
    expect(other.json()).toMatchObject({ error: { code: "device.project_path_missing" } });
  });
});
