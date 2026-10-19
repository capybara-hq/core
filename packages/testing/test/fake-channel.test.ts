import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeChannelServer,
  fakeDirectoryMember,
  fakeDm,
  startFakeChannelServer,
} from "../src/index.js";

let im: FakeChannelServer | undefined;
afterEach(async () => {
  await im?.stop();
  im = undefined;
});

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pid": "42" },
    body: JSON.stringify(body),
  });

const msg = (key?: string) => ({
  appId: "app",
  target: { chatId: "c1", chatType: "dm" },
  message: { text: "hi" },
  ...(key !== undefined && { idempotencyKey: key }),
});

describe("startFakeChannelServer", () => {
  it("/send 按 (appId, idempotencyKey) 去重：重复请求返回同一 messageId，记进 duplicateSends", async () => {
    im = await startFakeChannelServer();
    const a = (await (await post(`${im.url}/send`, msg("k1"))).json()) as { messageId: string };
    const b = (await (await post(`${im.url}/send`, msg("k1"))).json()) as { messageId: string };
    const c = (await (await post(`${im.url}/send`, msg())).json()) as { messageId: string };
    expect(b.messageId).toBe(a.messageId);
    expect(c.messageId).not.toBe(a.messageId);
    expect(im.sent.map((s) => s.messageId)).toEqual([a.messageId, c.messageId]);
    expect(im.sent[0]?.pid).toBe(42);
    expect(im.duplicateSends).toHaveLength(1);
  });

  it("dedupeSends: false → 每次发送都记下", async () => {
    im = await startFakeChannelServer({ dedupeSends: false });
    await post(`${im.url}/send`, msg("k1"));
    await post(`${im.url}/send`, msg("k1"));
    expect(im.sent).toHaveLength(2);
    expect(im.duplicateSends).toEqual([]);
  });

  it("failNext 让接下来几次失败且不记录；finalText 取最后一次更新", async () => {
    im = await startFakeChannelServer();
    im.failNext("/send", 429, 1, 50);
    const r = await post(`${im.url}/send`, msg());
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ retryAfterMs: 50 });
    const { messageId } = (await (await post(`${im.url}/send`, msg())).json()) as {
      messageId: string;
    };
    await post(`${im.url}/update`, { ...msg(), messageId, message: { text: "final" } });
    const s = im.sent[0];
    if (!s) throw new Error("no message");
    expect(im.finalText(s)).toBe("final");
  });

  it("长连接收到推送的事件；统计并发峰值", async () => {
    im = await startFakeChannelServer();
    const ac = new AbortController();
    const res = await fetch(`${im.url}/connect?connection=c1`, {
      signal: ac.signal,
      headers: { "x-pid": "7", "x-app-id": "app" },
    });
    expect(im.active("c1")).toMatchObject([{ pid: 7, appId: "app" }]);
    expect(im.push("c1", fakeDm("m1", "u1", "hello"))).toBe(1);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let buf = "";
    while (!buf.includes("hello")) buf += new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(buf.trim())).toMatchObject({ type: "message", text: "hello" });
    expect(im.maxConcurrent("c1")).toBe(1);
    ac.abort();
  });

  it("OAuth：authorize 带授权码回跳，token 换出用户与 nonce；授权码单次有效", async () => {
    im = await startFakeChannelServer();
    im.users.set("u1", { externalId: "u1", tenantId: "t1", displayName: "U1" });
    const q = new URLSearchParams({
      client_id: "cid",
      redirect_uri: "https://cap.example/cb",
      state: "s1",
      nonce: "n1",
      as: "u1",
    });
    const authz = await fetch(`${im.url}/oauth/authorize?${q}`, { redirect: "manual" });
    expect(authz.status).toBe(302);
    const back = new URL(authz.headers.get("location") ?? "");
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code");
    const tok = await post(`${im.url}/oauth/token`, { code, clientId: "cid", clientSecret: "x" });
    expect(await tok.json()).toMatchObject({ nonce: "n1", user: { externalId: "u1" } });
    const again = await post(`${im.url}/oauth/token`, { code, clientId: "cid", clientSecret: "x" });
    expect(again.status).toBe(400);
    q.set("as", "nobody");
    const denied = await fetch(`${im.url}/oauth/authorize?${q}`, { redirect: "manual" });
    expect(new URL(denied.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("OAuth PKCE：授权时带 code_challenge 的，换 token 须带对应的 codeVerifier", async () => {
    im = await startFakeChannelServer();
    im.users.set("u1", { externalId: "u1", tenantId: "t1", displayName: "U1" });
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const codeFor = async () => {
      const q = new URLSearchParams({
        client_id: "cid",
        redirect_uri: "https://cap.example/cb",
        state: "s1",
        nonce: "n1",
        as: "u1",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const authz = await fetch(`${im?.url}/oauth/authorize?${q}`, { redirect: "manual" });
      return new URL(authz.headers.get("location") ?? "").searchParams.get("code");
    };
    const base = { clientId: "cid", clientSecret: "x" };
    const missing = await post(`${im.url}/oauth/token`, { ...base, code: await codeFor() });
    expect(missing.status).toBe(400);
    const wrong = await post(`${im.url}/oauth/token`, {
      ...base,
      code: await codeFor(),
      codeVerifier: "w".repeat(43),
    });
    expect(wrong.status).toBe(400);
    const ok = await post(`${im.url}/oauth/token`, {
      ...base,
      code: await codeFor(),
      codeVerifier: verifier,
    });
    expect(ok.status).toBe(200);
  });

  it("通讯录分页；failOnPage 让该页 500", async () => {
    im = await startFakeChannelServer();
    const b = im.book("org");
    b.members = ["a", "b", "c"].map((id) => fakeDirectoryMember(id));
    b.pageSize = 2;
    const p0 = (await (await fetch(`${b.url}/members`)).json()) as { next?: string };
    expect(p0.next).toBe("1");
    const p1 = (await (await fetch(`${b.url}/members?cursor=1`)).json()) as {
      members: unknown[];
      next?: string;
    };
    expect(p1.members).toHaveLength(1);
    expect(p1.next).toBeUndefined();
    b.failOnPage = 1;
    expect((await fetch(`${b.url}/members?cursor=1`)).status).toBe(500);
    expect(b.starts()).toBe(1);
  });
});
