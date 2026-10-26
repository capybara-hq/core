import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TranslationReport } from "../../src/catalog/claude/report.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { PW, type Req, runConfig, session, startKernel } from "../helpers/runs.js";

/**
 * Live check of phase B against the real obra/superpowers repository on GitHub (network).
 * Skipped unless `CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1`. Behind a proxy (GitHub unreachable
 * directly), also set `CAPYBARA_TEST_HTTPS_PROXY` to the proxy URL; it becomes `net.httpsProxy`, so
 * the download goes through the same network rules as in production:
 *
 *   CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1 CAPYBARA_TEST_HTTPS_PROXY=http://127.0.0.1:7890 \
 *     pnpm exec vitest run packages/kernel/test/catalog/claude-live.test.ts
 *
 * The test adds the repository as a git marketplace, refreshes it and prepares the import of
 * superpowers; it never confirms (the staging row expires on its own).
 */

const LIVE = process.env.CAPYBARA_TEST_CLAUDE_SUPERPOWERS === "1";
const PROXY = process.env.CAPYBARA_TEST_HTTPS_PROXY;
const REPO = "https://github.com/obra/superpowers.git";

describe.skipIf(!LIVE)("live: obra/superpowers from GitHub", { timeout: 300_000 }, () => {
  const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
  let pgc: TestContainer;
  let rd: TestContainer;
  let s3: TestS3;
  let destroyDb: () => Promise<void>;
  let pluginsDir: string;
  let k: Kernel;
  let admin: Req;

  beforeAll(async () => {
    [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
    const raw = createDb(pgc.url, 3);
    destroyDb = () => raw.destroy();
    pluginsDir = await mkdtemp(join(tmpdir(), "kernel-claude-live-"));
    k = await startKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          roles: ["api"],
          extensionHost: { dir: pluginsDir },
          extensions: [OBJECT_STORE],
          ...(PROXY !== undefined && PROXY !== "" && { net: { httpsProxy: PROXY } }),
          extensionConfig: {
            "fake-object-store": {
              endpoint: s3.endpoint,
              region: s3.region,
              bucket: s3.bucket,
              accessKeyId: s3.accessKey,
              secretAccessKey: s3.secretKey,
              forcePathStyle: true,
            },
          },
        },
      ),
    );
    await new AccountsService(kernelDb(raw)).createLocal({
      login: "root",
      password: PW,
      displayName: "R",
      enterpriseAdmin: true,
    });
    admin = await session(k, "root");
  }, 240_000);

  afterAll(async () => {
    await k?.stop();
    await destroyDb?.();
    if (pluginsDir) await rm(pluginsDir, { recursive: true, force: true });
    await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  });

  it("the superpowers repository as a git marketplace: the review has the skills, a SessionStart hook and the MIT license", async () => {
    const added = await admin({
      method: "POST",
      url: "/api/v1/admin/marketplaces",
      payload: { name: "Superpowers", url: REPO, form: "git" },
    });
    expect(added.statusCode, added.body).toBe(201);
    const id = added.json().id as string;
    const refreshed = await admin({
      method: "POST",
      url: `/api/v1/admin/marketplaces/${id}/refresh`,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().lastStatus, refreshed.body).toBe("ok");
    const prepared = await admin({
      method: "POST",
      url: `/api/v1/admin/marketplaces/${id}/entries/superpowers/import`,
      payload: {},
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const review = prepared.json().review as {
      format: string;
      license?: string;
      licenseText?: string;
      skills: { name: string }[];
      translation: TranslationReport;
    };
    expect(review.format).toBe("claude-code");
    expect(review.skills.length).toBeGreaterThanOrEqual(10);
    expect(review.skills.map((s) => s.name)).toContain("using-superpowers");
    expect(review.translation.sessionStart).toBe(true);
    expect(review.license).toBe("MIT");
    expect(review.licenseText).toMatch(/MIT License/);
  });
});
