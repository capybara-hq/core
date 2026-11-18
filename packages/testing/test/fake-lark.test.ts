import { afterEach, describe, expect, it } from "vitest";
import { type FakeLarkServer, startFakeLark } from "../src/fake-lark.js";

/** The fake Lark's upload endpoints and image / file messages. */

let lark: FakeLarkServer | undefined;

afterEach(async () => {
  await lark?.stop();
  lark = undefined;
});

type Envelope = { code: number; msg?: string; data?: Record<string, string> };

async function token(s: FakeLarkServer): Promise<string> {
  const res = await fetch(`${s.url}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: s.appId, app_secret: s.appSecret }),
  });
  return ((await res.json()) as { tenant_access_token: string }).tenant_access_token;
}

async function multipart(
  s: FakeLarkServer,
  t: string,
  path: string,
  fields: Record<string, string>,
  field: string,
  data: string,
): Promise<Envelope> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set(field, new Blob([data]), "x.bin");
  const res = await fetch(`${s.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}` },
    body: form,
  });
  return (await res.json()) as Envelope;
}

async function json(s: FakeLarkServer, t: string, path: string, body: object): Promise<Envelope> {
  const res = await fetch(`${s.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Envelope;
}

describe("fake Lark uploads", () => {
  it("records an image upload and an image reply in a thread, deduped by uuid", async () => {
    lark = await startFakeLark();
    const t = await token(lark);
    const root = await json(lark, t, "/open-apis/im/v1/messages?receive_id_type=chat_id", {
      receive_id: "oc_1",
      msg_type: "text",
      content: JSON.stringify({ text: "hi" }),
    });
    const rootId = root.data?.message_id as string;
    const up = await multipart(
      lark,
      t,
      "/open-apis/im/v1/images",
      { image_type: "message" },
      "image",
      "PNG",
    );
    expect(up.code).toBe(0);
    const key = up.data?.image_key as string;
    const send = () =>
      json(lark as FakeLarkServer, t, `/open-apis/im/v1/messages/${rootId}/reply`, {
        msg_type: "image",
        content: JSON.stringify({ image_key: key }),
        reply_in_thread: true,
        uuid: "u-1",
      });
    const first = await send();
    const second = await send();
    expect(first.code).toBe(0);
    expect(second.data?.message_id).toBe(first.data?.message_id);
    expect(lark.uploads).toHaveLength(1);
    expect(lark.uploads[0]).toMatchObject({ kind: "image", key });
    expect(lark.uploads[0]?.data.toString()).toBe("PNG");
    const images = lark.messages.filter((m) => m.msgType === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ replyInThread: true, rootId });
  });

  it("records a file upload and refuses an unknown file_key with 230001", async () => {
    lark = await startFakeLark();
    const t = await token(lark);
    const up = await multipart(
      lark,
      t,
      "/open-apis/im/v1/files",
      { file_type: "pdf", file_name: "a.pdf" },
      "file",
      "%PDF",
    );
    expect(up.code).toBe(0);
    expect(lark.uploads[0]).toMatchObject({ kind: "file", fileType: "pdf", fileName: "a.pdf" });
    const path = "/open-apis/im/v1/messages?receive_id_type=chat_id";
    const ok = await json(lark, t, path, {
      receive_id: "oc_1",
      msg_type: "file",
      content: JSON.stringify({ file_key: up.data?.file_key }),
    });
    expect(ok.code).toBe(0);
    const bad = await json(lark, t, path, {
      receive_id: "oc_1",
      msg_type: "file",
      content: JSON.stringify({ file_key: "file_v3_nope" }),
    });
    expect(bad.code).toBe(230001);
  });
});
