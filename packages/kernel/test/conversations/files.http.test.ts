import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fakeExtensionEntry,
  openSse,
  startTestPostgres,
  startTestRedis,
  startTestS3,
  type TestContainer,
  type TestS3,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/** UI refresh B Task 10: a conversation's file outputs, grouped by source path into versions. */

const OBJECT_STORE = fakeExtensionEntry("fake-object-store");
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let s3: TestS3;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let k: Kernel;
let root: string;

beforeAll(async () => {
  [pgc, rd, s3] = await Promise.all([startTestPostgres(), startTestRedis(), startTestS3()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  root = await mkdtemp(join(tmpdir(), "cap-files-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, OBJECT_STORE, SANDBOX_FAKE],
        extensionConfig: {
          "fake-object-store": {
            endpoint: s3.endpoint,
            region: s3.region,
            bucket: s3.bucket,
            accessKeyId: s3.accessKey,
            secretAccessKey: s3.secretKey,
            forcePathStyle: true,
          },
          "sandbox-fake": { root },
        },
      },
    ),
  );
}, 180_000);
afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop(), s3?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerCookie: () => string;
let other: Req;
let orgId: string;

beforeEach(async () => {
  await truncateTables(raw, "capybara.sandboxes, capybara.accounts, capybara.orgs");
  const accounts = new AccountsService(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const otherId = (await accounts.createLocal({ login: "other", password: PW, displayName: "X" }))
    .id;
  const jar = cookieJar();
  owner = asUser(k.http, jar);
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  ownerCookie = () => jar.header() as string;
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, otherId, "member", ownerId);
  other = await session(k, "other");
});

async function sandboxConversation(): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Coder",
        instructions: "Use the sandbox.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: ["sandbox_bash", "sandbox_deliver"].map((name) => ({ kind: "builtin", name })),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return createConv(owner, orgId, (res.json() as { agent: { id: string } }).agent.id);
}

async function callTool(conv: string, key: string, input: unknown, n: number): Promise<void> {
  await postMessage(owner, orgId, conv, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, conv, n, 30_000);
}

/** Stores an object and logs its `artifact_created` (as `sandbox_deliver` would). */
async function deliver(
  conv: string,
  name: string,
  bytes: Buffer,
  contentType: string,
  sourcePath = `/workspace/${name}`,
): Promise<{ artifactId: string; objectKey: string }> {
  const artifactId = randomUUID();
  const objectKey = `artifacts/${conv}/${artifactId}`;
  await k.storage.kernel(orgId).put(objectKey, bytes, {
    contentType,
    size: bytes.byteLength,
    signal: AbortSignal.timeout(10_000),
  });
  await k.runs.eventLog.append(conv, [
    {
      type: "artifact_created",
      payload: {
        artifactId,
        name,
        contentType,
        size: bytes.byteLength,
        objectKey,
        sourcePath,
        callId: `call-${name}`,
      },
    },
  ]);
  return { artifactId, objectKey };
}

interface FileOutput {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sourcePath: string;
  version: number;
  versions: { id: string; size: number; createdAt: string }[];
  callId: string;
  createdAt: string;
  status: "available" | "removed";
  previewable: "image" | "text" | null;
}
const filesUrl = (conv: string) => `/api/v1/orgs/${orgId}/conversations/${conv}/files`;
const listFiles = async (conv: string, query = "") => {
  const r = await owner({ method: "GET", url: `${filesUrl(conv)}${query}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { files: FileOutput[]; next: string | null };
};

describe("file outputs", { timeout: 60_000 }, () => {
  it("two deliveries of one path are one file with two versions; delivering sends changed: files", async () => {
    const conv = await sandboxConversation();
    {
      await callTool(
        conv,
        "sandbox_bash",
        {
          description: "Write a report",
          command: "mkdir -p out && printf 'v1\\n' > out/report.md",
        },
        1,
      );
      await callTool(conv, "sandbox_deliver", { path: "/workspace/out/report.md" }, 2);
      const sse = await openSse(
        `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
        { cookie: ownerCookie() },
      );
      try {
        await callTool(
          conv,
          "sandbox_bash",
          { description: "Update it", command: "printf 'v2 longer\\n' > out/report.md" },
          3,
        );
        await callTool(conv, "sandbox_deliver", { path: "/workspace/out/report.md" }, 4);
        await sse.until(
          (m) => m.some((x) => x.event === "changed" && x.data === '{"what":"files"}'),
          10_000,
          "changed: files",
        );
      } finally {
        sse.close();
      }
      const { files, next } = await listFiles(conv);
      expect(next).toBeNull();
      expect(files).toHaveLength(1);
      const f = files[0] as FileOutput;
      expect(f).toMatchObject({
        name: "report.md",
        sourcePath: "/workspace/out/report.md",
        version: 2,
        size: 10,
        status: "available",
        previewable: "text",
      });
      expect(f.versions.map((v) => v.size)).toEqual([10, 3]);
      expect(f.id).toBe(f.versions[0]?.id);
      const content = await owner({ method: "GET", url: `${filesUrl(conv)}/${f.id}/content` });
      expect(content.statusCode, content.body).toBe(200);
      expect(content.body).toBe("v2 longer\n");
      // an older version is readable by its id
      const old = await owner({
        method: "GET",
        url: `${filesUrl(conv)}/${f.versions[1]?.id}/content`,
      });
      expect(old.body).toBe("v1\n");
    }
  });

  it("newest first, paged by file id; removed objects are marked and their content is 410", async () => {
    const conv = await sandboxConversation();
    const a = await deliver(conv, "a.txt", Buffer.from("alpha"), "text/plain");
    await deliver(conv, "b.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
    await deliver(conv, "c.bin", Buffer.from([1, 2, 3]), "application/octet-stream");
    const page1 = await listFiles(conv, "?limit=2");
    expect(page1.files.map((f) => [f.name, f.previewable])).toEqual([
      ["c.bin", null],
      ["b.png", "image"],
    ]);
    expect(page1.next).toBe(page1.files[1]?.id);
    const page2 = await listFiles(conv, `?limit=2&after=${page1.next}`);
    expect(page2.files.map((f) => f.name)).toEqual(["a.txt"]);
    expect(page2.next).toBeNull();

    await k.storage.kernel(orgId).delete(a.objectKey);
    const after = await listFiles(conv);
    expect(after.files.find((f) => f.name === "a.txt")?.status).toBe("removed");
    expect(after.files.find((f) => f.name === "b.png")?.status).toBe("available");
    const gone = await owner({ method: "GET", url: `${filesUrl(conv)}/${a.artifactId}/content` });
    expect(gone.statusCode).toBe(410);
    expect((gone.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_removed",
    );
  });

  it("text content: cut at `limit` with X-Content-Truncated; never served as HTML; images refused", async () => {
    const conv = await sandboxConversation();
    const t = await deliver(conv, "notes.txt", Buffer.from("0123456789abcdef"), "text/plain");
    const cut = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${t.artifactId}/content?limit=10`,
    });
    expect(cut.statusCode).toBe(200);
    expect(cut.body).toBe("0123456789");
    expect(cut.headers["x-content-truncated"]).toBe("true");
    expect(cut.headers["content-type"]).toMatch(/^text\/plain/);
    expect(cut.headers["x-content-type-options"]).toBe("nosniff");
    expect(cut.headers["cache-control"]).toContain("no-store");
    const whole = await owner({ method: "GET", url: `${filesUrl(conv)}/${t.artifactId}/content` });
    expect(whole.body).toBe("0123456789abcdef");
    expect(whole.headers["x-content-truncated"]).toBeUndefined();

    // a multi-byte character is never split at the cut
    const cjk = await deliver(conv, "cjk.txt", Buffer.from("中文字"), "text/plain");
    const half = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${cjk.artifactId}/content?limit=4`,
    });
    expect(half.body).toBe("中");

    const html = await deliver(conv, "page.html", Buffer.from("<script>x()</script>"), "text/html");
    const asText = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${html.artifactId}/content`,
    });
    expect(asText.statusCode).toBe(200);
    expect(asText.headers["content-type"]).toMatch(/^text\/plain/);
    expect(asText.headers["content-security-policy"]).toContain("sandbox");

    const img = await deliver(conv, "dot.png", Buffer.from([0x89, 0x50]), "image/png");
    const refused = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${img.artifactId}/content`,
    });
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      "conversation.artifact_not_previewable",
    );
    const unknown = await owner({
      method: "GET",
      url: `${filesUrl(conv)}/${randomUUID()}/content`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("another member: 404 for the list and the content", async () => {
    const conv = await sandboxConversation();
    const t = await deliver(conv, "notes.txt", Buffer.from("secret"), "text/plain");
    for (const url of [filesUrl(conv), `${filesUrl(conv)}/${t.artifactId}/content`]) {
      const r = await other({ method: "GET", url });
      expect(r.statusCode, url).toBe(404);
      expect((r.json() as { error: { code: string } }).error.code).toBe("conversation.not_found");
    }
  });
});
