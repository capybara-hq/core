import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeE2BServer, startFakeE2B } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function fake(opts: Parameters<typeof startFakeE2B>[0] = {}): Promise<FakeE2BServer> {
  const f = await startFakeE2B(opts);
  cleanups.push(() => f.close());
  return f;
}

function api(f: FakeE2BServer, method: string, path: string, body?: unknown) {
  return fetch(`${f.url}${path}`, {
    method,
    headers: { "x-api-key": f.apiKey, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function buildFromImage(f: FakeE2BServer, name: string, image: string) {
  // the calls of Template.build(Template().fromImage(image), { alias }) in e2b@2.58.0
  const req = await api(f, "POST", "/v3/templates", { name });
  expect(req.status).toBe(202);
  const { templateID, buildID } = (await req.json()) as { templateID: string; buildID: string };
  const trigger = await api(f, "POST", `/v2/templates/${templateID}/builds/${buildID}`, {
    fromImage: image,
    steps: [],
    force: false,
  });
  expect(trigger.status).toBe(202);
  return { templateID, buildID };
}

async function status(f: FakeE2BServer, t: { templateID: string; buildID: string }) {
  const res = await api(f, "GET", `/templates/${t.templateID}/builds/${t.buildID}/status`);
  return ((await res.json()) as { status: string }).status;
}

async function createSandbox(f: FakeE2BServer, templateID: string) {
  const res = await api(f, "POST", "/v2/sandboxes", { templateID });
  return { res, body: (await res.json()) as { sandboxID: string; envdAccessToken: string } };
}

/** Starts a long-running process and drops the connection (the process outlives the request). */
async function startLong(f: FakeE2BServer, id: string, token: string, script: string) {
  const msg = Buffer.from(JSON.stringify({ process: { cmd: "/bin/sh", args: ["-c", script] } }));
  const head = Buffer.alloc(5);
  head.writeUInt32BE(msg.byteLength, 1);
  const ac = new AbortController();
  void fetch(`${f.url}/process.Process/Start`, {
    method: "POST",
    signal: ac.signal,
    headers: {
      "content-type": "application/connect+json",
      "e2b-sandbox-id": id,
      "x-access-token": token,
      authorization: `Basic ${Buffer.from("user:").toString("base64")}`,
    },
    body: Buffer.concat([head, msg]),
  }).catch(() => undefined);
  await expect.poll(() => f.running(id).length).toBeGreaterThan(0);
  ac.abort();
}

describe("fake E2B template build", () => {
  it("template build from image becomes usable by alias", async () => {
    const f = await fake({ templateBuildMs: 150 });
    expect((await api(f, "GET", "/templates/aliases/capybara-sandbox-1")).status).toBe(404);
    const t = await buildFromImage(f, "capybara-sandbox-1", "ghcr.io/x/sandbox:1");
    expect((await api(f, "GET", "/templates/aliases/capybara-sandbox-1")).status).toBe(200);
    expect(await status(f, t)).toBe("building");
    // a template still building cannot create sandboxes
    expect((await createSandbox(f, "capybara-sandbox-1")).res.status).toBe(404);
    await expect.poll(() => status(f, t), { timeout: 3000 }).toBe("ready");
    expect(f.templates.get("capybara-sandbox-1")?.image).toBe("ghcr.io/x/sandbox:1");
    const made = await createSandbox(f, "capybara-sandbox-1");
    expect(made.res.status).toBe(201);
    expect(f.sandboxes.get(made.body.sandboxID)?.templateID).toBe(t.templateID);
  });

  it("seeds existing aliases as ready templates", async () => {
    const f = await fake({ templates: ["seeded"] });
    expect((await api(f, "GET", "/templates/aliases/seeded")).status).toBe(200);
    expect((await createSandbox(f, "seeded")).res.status).toBe(201);
  });
});

describe("fake E2B pause", () => {
  it("memory-less pause keeps files and drops processes", async () => {
    const f = await fake();
    const { body } = await createSandbox(f, "base");
    const id = body.sandboxID;
    await startLong(f, id, body.envdAccessToken, "echo kept > /workspace/a.txt; sleep 60");
    await expect.poll(() => existsSync(f.hostPath(id, "/workspace/a.txt"))).toBe(true);

    expect((await api(f, "POST", `/sandboxes/${id}/pause`, { memory: false })).status).toBe(204);
    expect(f.running(id)).toEqual([]);
    expect((await api(f, "POST", `/v2/sandboxes/${id}/connect`, { timeout: 60 })).status).toBe(201);
    expect(f.running(id)).toEqual([]);
    expect(readFileSync(f.hostPath(id, "/workspace/a.txt"), "utf8")).toBe("kept\n");
  });

  it("pause with memory keeps processes", async () => {
    const f = await fake();
    const { body } = await createSandbox(f, "base");
    const id = body.sandboxID;
    await startLong(f, id, body.envdAccessToken, "sleep 60");
    expect((await api(f, "POST", `/sandboxes/${id}/pause`, {})).status).toBe(204);
    expect(f.running(id).length).toBe(1);
    expect(f.sandboxes.get(id)?.pausedWithMemory).toBe(true);
  });

  it("removed sandbox returns 404 on connect", async () => {
    const f = await fake();
    const { body } = await createSandbox(f, "base");
    const id = body.sandboxID;
    expect((await api(f, "POST", `/sandboxes/${id}/pause`, { memory: false })).status).toBe(204);
    await f.removeSandbox(id);
    expect((await api(f, "POST", `/v2/sandboxes/${id}/connect`, { timeout: 60 })).status).toBe(404);
  });
});
