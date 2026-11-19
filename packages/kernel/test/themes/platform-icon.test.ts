import { createHash } from "node:crypto";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { createLogger } from "../../src/log.js";
import { availability } from "../../src/platform/availability.js";
import type { OperationContext } from "../../src/platform/operation.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { PlatformIconService } from "../../src/themes/platform-icon.service.js";
import {
  PLATFORM_ICON_DELETE_JOB,
  PlatformIconObjects,
  platformIconDeleteJobId,
  platformIconKey,
  platformIconOrphanJobId,
} from "../../src/themes/platform-icon-objects.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The platform icon (mobile layout spec §10.2.1): the super admin uploads the app icon, its
 * maskable variant and an SVG favicon as JSON base64; each is stored under the kernel's
 * `deployment/platform-icons/` prefix with a row in `capybara.platform_icons`, served by the public
 * `GET /api/v1/platform/icon/:purpose?v=<sha256>`; a replaced or cleared object is deleted through
 * the outbox.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
/** While true, the outbox's adds to the maintenance queue fail (the owed row stays). */
let failMaintenance = false;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [OBJECT_STORE],
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
    {
      logger: createLogger("error", { write: () => {} }),
      overrides: [
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failMaintenance && queue === MAINTENANCE_QUEUE_NAME,
        },
      ],
    },
  );
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
});

let admin: Req;
let adminId: string;
let owner: Req;
let orgId: string;

beforeEach(async () => {
  failMaintenance = false;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox, capybara.platform_icons",
  );
  await deploymentStore().deletePrefix("platform-icons/");
  const accounts = accountsFor(db);
  adminId = (
    await accounts.createLocal({
      login: "admin",
      password: PW,
      displayName: "Admin",
      superAdmin: true,
    })
  ).id;
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  admin = await session(k, "admin");
  owner = await session(k, "owner");
  orgId = await createOrg(admin);
  await testMembers(db).add(orgId, ownerId, "owner", adminId);
});

/** A PNG of `width` × `height`: the signature, an IHDR chunk and IEND, padded to `size` bytes. */
function png(width: number, height: number, size?: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(6, 17); // RGBA
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.concat([sig, ihdr, iend]);
  return size === undefined ? body : Buffer.concat([body, Buffer.alloc(size - body.length)]);
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>',
);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const put = (req: Req, purpose: string, contentType: string, data: Buffer) =>
  req({
    method: "PUT",
    url: `/api/v1/admin/platform/icons/${purpose}`,
    payload: { contentType, dataBase64: data.toString("base64") },
  });
const publicGet = (url: string) => k.http.inject({ method: "GET", url });
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;
const deploymentStore = () => k.app.get(StorageService).deployment();

describe("upload and serve", () => {
  it("a super admin's 512 × 512 PNG is listed and served immutable under its hash", async () => {
    const icon = png(512, 512);
    const res = await put(admin, "app", "image/png", icon);
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json() as { purpose: string; url: string; sha256: string; updatedAt: string };
    expect(view).toMatchObject({
      purpose: "app",
      sha256: sha(icon),
      url: `/api/v1/platform/icon/app?v=${sha(icon)}`,
    });
    expect(typeof view.updatedAt).toBe("string");

    const list = await admin({ method: "GET", url: "/api/v1/admin/platform/icons" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ icons: [view] });

    const served = await publicGet(view.url);
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(served.rawPayload, icon)).toBe(0);

    // stored under the deployment prefix, keyed by purpose and hash
    expect(await deploymentStore().head(platformIconKey("app", sha(icon)))).not.toBeNull();
    const audit = await db
      .selectFrom("audit_events")
      .select(["actor_account_id", "action", "detail"])
      .where("action", "=", "platform.icon.updated")
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_account_id: adminId,
      detail: { purpose: "app", sha256: sha(icon) },
    });
  });

  it("without the hash or with a stale one the bytes are not cached as immutable", async () => {
    const icon = png(512, 512);
    expect((await put(admin, "app", "image/png", icon)).statusCode).toBe(200);
    const bare = await publicGet("/api/v1/platform/icon/app");
    expect(bare.statusCode).toBe(200);
    expect(bare.headers["cache-control"]).toBe("no-cache");
    const stale = await publicGet(`/api/v1/platform/icon/app?v=${"0".repeat(64)}`);
    expect(stale.statusCode).toBe(404);
    expect(errCode(stale)).toBe("platform_icon.not_found");
  });

  it("an unset icon is 404 so the web uses its default set", async () => {
    const res = await publicGet("/api/v1/platform/icon/maskable");
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("platform_icon.not_found");
    expect((await publicGet("/api/v1/platform/icon/other")).statusCode).toBe(400);
  });

  it("the SVG favicon is sanitized and served under a sandbox CSP", async () => {
    const res = await put(admin, "favicon", "image/svg+xml", SVG);
    expect(res.statusCode, res.body).toBe(200);
    const served = await publicGet((res.json() as { url: string }).url);
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/svg+xml");
    expect(served.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.body).toContain("<circle");
  });

  it("the maskable variant is a 512 × 512 PNG too", async () => {
    expect((await put(admin, "maskable", "image/png", png(512, 512))).statusCode).toBe(200);
    const list = await admin({ method: "GET", url: "/api/v1/admin/platform/icons" });
    expect((list.json() as { icons: { purpose: string }[] }).icons.map((i) => i.purpose)).toEqual([
      "maskable",
    ]);
  });
});

describe("refusals store nothing", () => {
  const nothingStored = async () => {
    expect(await db.selectFrom("platform_icons").selectAll().execute()).toEqual([]);
    expect((await deploymentStore().list("platform-icons/")).items).toEqual([]);
  };

  it("a JPEG declared as PNG is invalid_type", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
    const res = await put(admin, "app", "image/png", jpeg);
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("platform_icon.invalid_type");
    await nothingStored();
  });

  it("a 513 × 512 PNG is invalid_size and names 512 × 512", async () => {
    const res = await put(admin, "app", "image/png", png(513, 512));
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("platform_icon.invalid_size");
    expect(res.body).toContain("512 × 512");
    await nothingStored();
  });

  it("1 MiB + 1 byte is too_large", async () => {
    const res = await put(admin, "app", "image/png", png(512, 512, 1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
    expect(errCode(res)).toBe("platform_icon.too_large");
    await nothingStored();
  });

  it("exactly 1 MiB is accepted", async () => {
    const res = await put(admin, "app", "image/png", png(512, 512, 1024 * 1024));
    expect(res.statusCode, res.body).toBe(200);
  });

  it("an SVG is only a favicon, and a favicon only an SVG", async () => {
    const svgApp = await put(admin, "app", "image/svg+xml", SVG);
    expect(svgApp.statusCode).toBe(400);
    expect(errCode(svgApp)).toBe("platform_icon.invalid_type");
    const pngFavicon = await put(admin, "favicon", "image/png", png(512, 512));
    expect(pngFavicon.statusCode).toBe(400);
    expect(errCode(pngFavicon)).toBe("platform_icon.invalid_type");
    await nothingStored();
  });

  it("an SVG with a script or a non-SVG root is invalid_type", async () => {
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><script>alert(1)</script></svg>',
      '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
      "not xml at all",
    ]) {
      const res = await put(admin, "favicon", "image/svg+xml", Buffer.from(bad));
      expect(res.statusCode, bad).toBe(400);
      expect(errCode(res), bad).toBe("platform_icon.invalid_type");
    }
    await nothingStored();
  });

  it("data that is not base64 is a validation failure", async () => {
    const res = await admin({
      method: "PUT",
      url: "/api/v1/admin/platform/icons/app",
      payload: { contentType: "image/png", dataBase64: "@@not base64@@" },
    });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
  });

  it("an org owner who is not the super admin is 403; no session is 401", async () => {
    const res = await put(owner, "app", "image/png", png(512, 512));
    expect(res.statusCode).toBe(403);
    expect((await owner({ method: "GET", url: "/api/v1/admin/platform/icons" })).statusCode).toBe(
      403,
    );
    expect(
      (await owner({ method: "DELETE", url: "/api/v1/admin/platform/icons/app" })).statusCode,
    ).toBe(403);
    expect(
      (await k.http.inject({ method: "GET", url: "/api/v1/admin/platform/icons" })).statusCode,
    ).toBe(401);
    await nothingStored();
  });
});

describe("replace and clear", () => {
  it("a second PUT replaces the icon; the old object is deleted once the outbox runs", async () => {
    failMaintenance = true;
    const first = png(512, 512, 100);
    const second = png(512, 512, 200);
    expect((await put(admin, "app", "image/png", first)).statusCode).toBe(200);
    const res = await put(admin, "app", "image/png", second);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { sha256: string }).sha256).toBe(sha(second));

    const oldKey = platformIconKey("app", sha(first));
    const owed = await db
      .selectFrom("outbox")
      .select(["queue", "job_name", "data", "org_id", "run_at"])
      .where("job_id", "=", platformIconDeleteJobId("app", sha(first)))
      .executeTakeFirstOrThrow();
    expect(owed).toMatchObject({
      queue: MAINTENANCE_QUEUE_NAME,
      job_name: PLATFORM_ICON_DELETE_JOB,
      data: { purpose: "app", objectKey: oldKey },
      org_id: null,
      run_at: null,
    });
    // the old object is still there until the job runs; the old URL is no longer served
    expect(await deploymentStore().head(oldKey)).not.toBeNull();
    expect((await publicGet(`/api/v1/platform/icon/app?v=${sha(first)}`)).statusCode).toBe(404);

    failMaintenance = false;
    await sql`UPDATE capybara.outbox SET next_attempt_at = now()`.execute(raw);
    await drainOutbox(k.app, { jobId: platformIconDeleteJobId("app", sha(first)) });
    await expect.poll(() => deploymentStore().head(oldKey)).toBeNull();
    expect(await deploymentStore().head(platformIconKey("app", sha(second)))).not.toBeNull();
  });

  it("uploading the same bytes again keeps the object and owes no delete", async () => {
    const icon = png(512, 512);
    expect((await put(admin, "app", "image/png", icon)).statusCode).toBe(200);
    expect((await put(admin, "app", "image/png", icon)).statusCode).toBe(200);
    const deletes = await db
      .selectFrom("outbox")
      .select("job_id")
      .where("job_id", "=", platformIconDeleteJobId("app", sha(icon)))
      .execute();
    expect(deletes).toEqual([]);
    expect(await deploymentStore().head(platformIconKey("app", sha(icon)))).not.toBeNull();
  });

  it("DELETE restores the default: the public GET is 404 and the object goes", async () => {
    failMaintenance = true;
    const icon = png(512, 512);
    const set = await put(admin, "app", "image/png", icon);
    expect(set.statusCode).toBe(200);
    const del = await admin({ method: "DELETE", url: "/api/v1/admin/platform/icons/app" });
    expect(del.statusCode, del.body).toBe(204);
    expect((await publicGet((set.json() as { url: string }).url)).statusCode).toBe(404);
    expect((await publicGet("/api/v1/platform/icon/app")).statusCode).toBe(404);
    const list = await admin({ method: "GET", url: "/api/v1/admin/platform/icons" });
    expect(list.json()).toEqual({ icons: [] });

    failMaintenance = false;
    await sql`UPDATE capybara.outbox SET next_attempt_at = now()`.execute(raw);
    await drainOutbox(k.app, { jobId: platformIconDeleteJobId("app", sha(icon)) });
    await expect.poll(() => deploymentStore().head(platformIconKey("app", sha(icon)))).toBeNull();
    // clearing an unset icon is a no-op
    expect(
      (await admin({ method: "DELETE", url: "/api/v1/admin/platform/icons/app" })).statusCode,
    ).toBe(204);
  });
});

describe("the object written before its row", () => {
  it("each upload owes a delayed orphan check that keeps an object its row names", async () => {
    const icon = png(512, 512);
    expect((await put(admin, "app", "image/png", icon)).statusCode).toBe(200);
    const intent = await db
      .selectFrom("outbox")
      .select(["job_name", "data", sql<boolean>`run_at > now()`.as("later")])
      .where("job_id", "=", platformIconOrphanJobId("app", sha(icon)))
      .executeTakeFirstOrThrow();
    expect(intent).toMatchObject({
      job_name: PLATFORM_ICON_DELETE_JOB,
      data: { purpose: "app", objectKey: platformIconKey("app", sha(icon)) },
      later: true,
    });
    await sql`UPDATE capybara.outbox SET run_at = now(), next_attempt_at = now()`.execute(raw);
    await drainOutbox(k.app, { jobId: platformIconOrphanJobId("app", sha(icon)) });
    // the job ran (its row is gone) and left the object its row names
    expect(await deploymentStore().head(platformIconKey("app", sha(icon)))).not.toBeNull();
    expect((await publicGet("/api/v1/platform/icon/app")).statusCode).toBe(200);
  });

  it("an object no row names (an upload that never committed) is deleted by the job", async () => {
    const icon = png(512, 512, 300);
    const key = platformIconKey("maskable", sha(icon));
    await deploymentStore().put(key, icon, { contentType: "image/png" });
    await k.app.get(PlatformIconObjects).deleteObject({ purpose: "maskable", objectKey: key });
    expect(await deploymentStore().head(key)).toBeNull();
  });

  it("the job never deletes a key outside the purpose's own icon keys", async () => {
    await expect(
      k.app
        .get(PlatformIconObjects)
        .deleteObject({ purpose: "app", objectKey: "plugins/blobs/x.tgz" }),
    ).rejects.toThrow(/unexpected object key/);
  });
});

describe("Platform operations", () => {
  const ctxOf = (accountId: string): OperationContext => ({
    orgId,
    actorAccountId: accountId,
    agentId: "00000000-0000-0000-0000-000000000000",
    conversationId: "00000000-0000-0000-0000-000000000001",
    runId: null,
    signal: new AbortController().signal,
  });
  const op = (id: string) => {
    const o = k.app
      .get(PlatformOperations)
      .all()
      .find((x) => x.id === id);
    if (!o) throw new Error(`no operation ${id}`);
    return o;
  };

  it("admin.set-icon, admin.icons and admin.clear-icon run through the same service", async () => {
    const icon = png(512, 512);
    const input = op("admin.set-icon").input.parse({
      purpose: "app",
      contentType: "image/png",
      dataBase64: icon.toString("base64"),
    });
    expect(await op("admin.set-icon").precheck?.(input, ctxOf(adminId))).toEqual({ ok: true });
    const summary = await op("admin.set-icon").summary?.(input, ctxOf(adminId));
    expect(summary?.en).toContain("app icon");
    const view = await op("admin.set-icon").run(input, ctxOf(adminId));
    expect(view).toMatchObject({ purpose: "app", sha256: sha(icon) });
    const audit = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "platform.icon.updated")
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ via: "agent", operation: "admin.set-icon" });

    expect(await op("admin.icons").run({}, ctxOf(adminId))).toEqual({ icons: [view] });
    expect(
      await op("admin.clear-icon").run(
        op("admin.clear-icon").input.parse({ purpose: "app" }),
        ctxOf(adminId),
      ),
    ).toEqual({ purpose: "app", cleared: true });
    expect(await k.app.get(PlatformIconService).current("app")).toBeNull();
  });

  it("the precheck refuses a wrong size before any card", async () => {
    const input = op("admin.set-icon").input.parse({
      purpose: "app",
      contentType: "image/png",
      dataBase64: png(256, 256).toString("base64"),
    });
    expect(await op("admin.set-icon").precheck?.(input, ctxOf(adminId))).toMatchObject({
      ok: false,
      code: "platform_icon.invalid_size",
    });
  });

  it("only the super admin may call them", () => {
    for (const id of ["admin.icons", "admin.set-icon", "admin.clear-icon"]) {
      expect(op(id).authz).toEqual({ superAdmin: true });
      const a = availability(op(id), {
        role: "owner",
        isSuperAdmin: false,
        personPresent: true,
        agentPrivateToActor: true,
        setting: "on",
      });
      expect(a.ok, id).toBe(false);
    }
  });
});

describe("current icon reference", () => {
  it("current() gives the purpose, hash and URL other features build on", async () => {
    expect(await k.app.get(PlatformIconService).current("app")).toBeNull();
    const icon = png(512, 512);
    await put(admin, "app", "image/png", icon);
    expect(await k.app.get(PlatformIconService).current("app")).toEqual({
      purpose: "app",
      sha256: sha(icon),
      url: `/api/v1/platform/icon/app?v=${sha(icon)}`,
    });
  });
});
