import {
  createDualReplicaHarness,
  fakeExtensionEntry,
  type Harness,
  replicaOf,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { PW } from "../helpers/runs.js";
import { makeZip } from "./zip.js";

/**
 * Sharing an agent skill and proposing a version of it across two kernel replicas (separate
 * processes sharing PG / Redis / SeaweedFS), all over HTTP: two org admins decide the same request
 * at once on different replicas; exactly one decision wins, the other gets
 * `skill_change.already_decided`, and the skill changes once.
 */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");

type Json = Record<string, unknown>;
type Res = { status: number; json: Json };
type User = "owner" | "admin" | "member";

const zipOf = (body: string) =>
  new Uint8Array(
    makeZip([
      {
        name: "SKILL.md",
        data: `---\nname: notes\ndescription: Take notes.\n---\n# Notes\n${body}\n`,
      },
    ]),
  );

describe("agent skill sharing (dual replica)", () => {
  let pgc: TestContainer;
  let rdc: TestContainer;
  let s3: TestS3;
  let h: Harness;
  let raw: ReturnType<typeof createDb>;
  let db: KernelSchemaDb;
  let base = "";
  const jars: Record<User, Map<string, string>> = {
    owner: new Map(),
    admin: new Map(),
    member: new Map(),
  };

  /** As a user, on replica `i` (with that user's cookies). */
  async function at(u: User, i: 0 | 1, method: string, path: string, body?: unknown) {
    const jar = jars[u];
    const res = await fetch(`http://127.0.0.1:${h.replicas[i].port}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json } as Res;
  }

  beforeAll(async () => {
    [pgc, rdc, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
    h = await createDualReplicaHarness({
      extensions: [MODEL_FAKE, OBJECT_STORE],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
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
      config: { auth: { cookieSecure: false } },
    });
    raw = createDb(h.dbUrl, 3);
    db = kernelDb(raw);
    const accounts = accountsFor(db);
    const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
      .id;
    const adminId = (await accounts.createLocal({ login: "adm", password: PW, displayName: "A" }))
      .id;
    const memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" }))
      .id;
    for (const [u, login, i] of [
      ["owner", "owner", 0],
      ["admin", "adm", 1],
      ["member", "mem", 0],
    ] as const) {
      const r = await at(u, i, "POST", "/api/v1/auth/login", { login, password: PW });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    const org = await at("owner", 1, "POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    base = `/api/v1/orgs/${orgId}`;
    await testMembers(db).add(orgId, adminId, "admin", ownerId);
    await testMembers(db).add(orgId, memberId, "member", ownerId);
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rdc?.stop(), s3?.stop()]);
  }, 120_000);

  /** The member registers a package on its agent through replica `i` (upload, put, register). */
  async function register(i: 0 | 1, agentId: string, zip: Uint8Array) {
    const up = await at("member", i, "POST", `${base}/agents/${agentId}/skills/uploads`, {
      name: "skill.zip",
      size: zip.byteLength,
    });
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const u = up.json as {
      id: string;
      upload: {
        method: "PUT" | "POST";
        url: string;
        headers: Record<string, string>;
        fields?: Record<string, string>;
      };
    };
    let put: Response;
    if (u.upload.method === "PUT") {
      put = await fetch(u.upload.url, {
        method: "PUT",
        headers: u.upload.headers,
        body: Buffer.from(zip),
      });
    } else {
      const form = new FormData();
      for (const [key, v] of Object.entries(u.upload.fields ?? {})) form.append(key, v);
      form.append("file", new Blob([Buffer.from(zip)], { type: "application/zip" }));
      put = await fetch(u.upload.url, { method: "POST", headers: u.upload.headers, body: form });
    }
    expect(put.status).toBeLessThan(300);
    const reg = await at("member", i, "POST", `${base}/agents/${agentId}/skills`, {
      uploadId: u.id,
    });
    expect(reg.status, JSON.stringify(reg.json)).toBe(200);
    return reg.json.skill as { kind: string; skillId: string; requestId?: string };
  }

  /** Both admins decide `id` at once, one per replica: one 200, one 409 already_decided. */
  async function raceApprove(id: string) {
    const [a, b] = await Promise.all([
      at("owner", 0, "POST", `${base}/skill-changes/${id}/decide`, { decision: "approve" }),
      at("admin", 1, "POST", `${base}/skill-changes/${id}/decide`, { decision: "approve" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, JSON.stringify([a.json, b.json])).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((loser.json.error as { code: string }).code).toBe("skill_change.already_decided");
  }

  it("two admins approving one share and one version proposal: one wins each time", async () => {
    const created = await at("member", 1, "POST", `${base}/agents`, {
      definition: {
        name: "Notes",
        instructions: "Take notes.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "private",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const agentId = (created.json.agent as { id: string }).id;

    const own = await register(0, agentId, zipOf("v1"));
    expect(own.kind).toBe("version");
    const share = await at(
      "member",
      1,
      "POST",
      `${base}/agents/${agentId}/skills/${own.skillId}/share`,
    );
    expect(share.status, JSON.stringify(share.json)).toBe(200);
    const asked = share.json.share as { kind: string; requestId: string };
    expect(asked.kind).toBe("requested");

    await raceApprove(asked.requestId);
    const shared = await db
      .selectFrom("skills")
      .select(["scope", "origin_agent_id", "current_version"])
      .where("id", "=", own.skillId)
      .executeTakeFirstOrThrow();
    expect(shared).toEqual({ scope: "org", origin_agent_id: agentId, current_version: 1 });

    // the maintainer registers the same name on the web: a proposal the admins race on
    const proposed = await register(1, agentId, zipOf("v2"));
    expect(proposed.kind).toBe("proposed");
    expect(proposed.skillId).toBe(own.skillId);
    await raceApprove(proposed.requestId as string);
    const versions = await db
      .selectFrom("skill_versions")
      .select("version")
      .where("skill_id", "=", own.skillId)
      .orderBy("version")
      .execute();
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const after = await db
      .selectFrom("skills")
      .select("current_version")
      .where("id", "=", own.skillId)
      .executeTakeFirstOrThrow();
    expect(after.current_version).toBe(2);
  });
});
