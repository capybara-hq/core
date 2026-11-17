import { DEFAULT_SANDBOX_ROOTS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../../src/config/schema.js";
import { ApiError } from "../../../src/errors.js";
import { BUILTIN_TOOL_KINDS, SANDBOX_ASK_TOOL_NAMES } from "../../../src/tools/builtin-names.js";
import {
  type SandboxToolDeps,
  sandboxFetchAttachmentTool,
  sandboxTools,
} from "../../../src/tools/builtins/sandbox/index.js";
import type { BuiltinTool } from "../../../src/tools/registry.js";

/**
 * Attachments on demand (spec §5.4): `FetchAttachment` copies one attachment of the conversation
 * into the device. Nothing is copied before the model asks for it; the tool is the only way in.
 */

/** The conversation: its first 12 hex digits name the attachment directory. */
const CONV = "6f40dd43-0000-4000-8000-000000000001";
const DIR = "/workspace/attachments/6f40dd430000";
const ATT = "0b8c3d2e-1111-4222-8333-444455556666";

const cfg = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});

const callCtx = () => ({
  orgId: "o",
  accountId: "a",
  agentId: "g",
  conversationId: CONV,
  callId: "call",
  signal: new AbortController().signal,
});

interface Opened {
  name: string;
  contentType: string;
  size: number;
  body: ReadableStream<Uint8Array>;
}

/** A stub kernel: only the deps `FetchAttachment` reads. */
function rig(
  o: {
    attachments?: { id: string; name: string }[];
    /** What opening an attachment answers (`null`: the row or its object is gone). */
    open?: (id: string) => Opened | null;
    /** A path whose write fails, e.g. a full disk. */
    failWrite?: string;
    cloudAvailable?: boolean;
    /** Whether the conversation's device can run without a cloud provider (ruling R8). */
    usableNow?: boolean;
  } = {},
) {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const p = {
    readFile: async (_h: unknown, path: string) => {
      const d = files.get(path);
      return d === undefined ? null : { data: d, truncated: false };
    },
    writeFile: async (_h: unknown, path: string, data: Uint8Array) => {
      if (path === o.failWrite) throw new Error("no space left on device");
      files.set(path, data);
      writes.push(path);
    },
    stat: async () => null,
  };
  const list = o.attachments ?? [];
  const deps = {
    devices: {
      forTool: async () => "env-1",
      ...(o.usableNow !== undefined && { usableNow: async () => o.usableNow }),
    },
    sandbox: {
      cloudAvailable: o.cloudAvailable ?? true,
      availableFor: async () => true,
      withSandbox: async (
        _c: unknown,
        fn: (h: unknown, p: unknown, info: unknown, s: AbortSignal) => Promise<unknown>,
      ) =>
        fn(
          { id: "x" },
          p,
          { fresh: false, restarted: false, roots: DEFAULT_SANDBOX_ROOTS },
          new AbortController().signal,
        ),
    },
    attachments: {
      listForConversation: async () => list,
      openForConversation: async (_o: string, _c: string, id: string) =>
        o.open
          ? o.open(id)
          : {
              name: list.find((a) => a.id === id)?.name ?? id,
              contentType: "application/octet-stream",
              size: 2,
              body: new Response("hi").body as ReadableStream<Uint8Array>,
            },
    },
    // biome-ignore lint/suspicious/noExplicitAny: not called
    storage: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: not called
    eventLog: {} as any,
    config: { get: () => cfg },
  } as unknown as SandboxToolDeps;
  const tools = sandboxTools(deps);
  const tool = tools.find((t) => t.spec.name === "FetchAttachment") as BuiltinTool;
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
  return { files, writes, deps, tools, tool, text };
}

describe("FetchAttachment", () => {
  it("copies an attachment by name and returns the stable path", async () => {
    const r = rig({ attachments: [{ id: ATT, name: "电商工行.xlsx" }] });
    const first = r.text(await r.tool.run({ file: "电商工行.xlsx" }, callCtx()));
    expect(first).toContain(`Copied 电商工行.xlsx to ${DIR}/电商工行.xlsx.`);
    expect(r.writes).toContain(`${DIR}/电商工行.xlsx`);
    expect(new TextDecoder().decode(r.files.get(`${DIR}/电商工行.xlsx`))).toBe("hi");
    // the same call again: the same path, the same bytes
    const second = r.text(await r.tool.run({ file: "电商工行.xlsx" }, callCtx()));
    expect(second).toContain(`Copied 电商工行.xlsx to ${DIR}/电商工行.xlsx.`);
    expect(new TextDecoder().decode(r.files.get(`${DIR}/电商工行.xlsx`))).toBe("hi");
  });

  it("accepts the unsigned reference and the attachment id", async () => {
    const r = rig({ attachments: [{ id: ATT, name: "电商工行.xlsx" }] });
    for (const file of [
      `s3://capybara/kernel/o/attachments/${ATT}`,
      `capybara://attachments/${ATT}`,
      ATT,
    ]) {
      const out = r.text(await r.tool.run({ file }, callCtx()));
      expect(out, file).toContain(`Copied 电商工行.xlsx to ${DIR}/电商工行.xlsx.`);
    }
  });

  it("matches the name exactly, case-sensitively", async () => {
    const r = rig({
      attachments: [
        { id: ATT, name: "Report.csv" },
        { id: "1e2f3a4b-1111-4222-8333-444455556666", name: "report.csv" },
      ],
    });
    const out = r.text(await r.tool.run({ file: "Report.csv" }, callCtx()));
    expect(out).toContain(`Copied Report.csv to ${DIR}/Report.csv.`);
    await expect(r.tool.run({ file: "REPORT.CSV" }, callCtx())).rejects.toThrow(
      /No attachment named "REPORT\.CSV"; this conversation has: Report\.csv, report\.csv\./,
    );
  });

  it("names the first five files the conversation has when the file is unknown", async () => {
    const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt"];
    const r = rig({ attachments: names.map((name, i) => ({ id: `id-${i}`, name })) });
    await expect(r.tool.run({ file: "nope.xlsx" }, callCtx())).rejects.toThrow(
      /No attachment named "nope\.xlsx"; this conversation has: a\.txt, b\.txt, c\.txt, d\.txt, e\.txt\./,
    );
  });

  it("says so when the conversation has no attachments at all", async () => {
    const r = rig();
    await expect(r.tool.run({ file: "nope.xlsx" }, callCtx())).rejects.toThrow(
      /No attachment named "nope\.xlsx"; this conversation has no attachments\. Ask the user to send the file/,
    );
  });

  it("a duplicate file name gets its own stable name", async () => {
    const second = "1e2f3a4b-1111-4222-8333-444455556666";
    const r = rig({
      attachments: [
        { id: ATT, name: "report.csv" },
        { id: second, name: "report.csv" },
      ],
    });
    const first = r.text(await r.tool.run({ file: "report.csv" }, callCtx()));
    expect(first).toContain(`Copied report.csv to ${DIR}/report.csv.`);
    // by id: the same file, under the name the whole list assigns it (the path's last segment)
    const other = r.text(await r.tool.run({ file: second }, callCtx()));
    expect(other).toContain(`Copied report-2.csv to ${DIR}/report-2.csv.`);
  });

  it("only ever writes the sanitized name the list assigns, never the raw one", async () => {
    // the path's last segment is `assignAttachmentNames`' output: a raw name with `/`, `..` or a
    // dot-only name never reaches it, so the write stays inside the conversation's directory
    const r = rig({
      attachments: [
        { id: ATT, name: "../../etc/passwd" },
        { id: "1e2f3a4b-1111-4222-8333-444455556666", name: ".." },
      ],
    });
    const traversal = r.text(await r.tool.run({ file: "../../etc/passwd" }, callCtx()));
    expect(traversal).toContain(`Copied .._.._etc_passwd to ${DIR}/.._.._etc_passwd.`);
    const dots = r.text(
      await r.tool.run({ file: "1e2f3a4b-1111-4222-8333-444455556666" }, callCtx()),
    );
    expect(dots).toContain(`Copied attachment to ${DIR}/attachment.`);
    // one segment below the conversation's directory, whatever the names: nothing escapes it
    for (const w of r.writes) expect(w, w).toMatch(new RegExp(`^${DIR}/[^/]+$`));
  });

  it("answers that the file is gone when its row or object is", async () => {
    const r = rig({ attachments: [{ id: ATT, name: "gone.xlsx" }], open: () => null });
    await expect(r.tool.run({ file: "gone.xlsx" }, callCtx())).rejects.toThrow(
      /Attachment "gone\.xlsx" is no longer in this conversation: .*Ask the user to send it again/,
    );
  });

  it("answers that file storage is unavailable when the store fails", async () => {
    const r = rig({
      attachments: [{ id: ATT, name: "a.xlsx" }],
      open: () => {
        throw new ApiError("storage.unavailable", "object store down");
      },
    });
    await expect(r.tool.run({ file: "a.xlsx" }, callCtx())).rejects.toThrow(
      /File storage is unavailable, so "a\.xlsx" could not be copied/,
    );
    // never the provider's own words
    await expect(r.tool.run({ file: "a.xlsx" }, callCtx())).rejects.not.toThrow(
      /object store down/,
    );
  });

  it("turns a failed write into an actionable error", async () => {
    const r = rig({ attachments: [{ id: ATT, name: "a.xlsx" }], failWrite: `${DIR}/a.xlsx` });
    await expect(r.tool.run({ file: "a.xlsx" }, callCtx())).rejects.toThrow(
      /Copying "a\.xlsx" into the device failed/,
    );
    await expect(r.tool.run({ file: "a.xlsx" }, callCtx())).rejects.not.toThrow(/no space left/);
  });

  it("is not offered without a usable sandbox", async () => {
    const r = rig({ cloudAvailable: false, usableNow: false });
    const reason = await r.tool.unavailable?.({ orgId: "o", conversationId: CONV });
    expect(reason).toMatch(/^No sandbox is configured in this deployment/);
    const usable = rig({ cloudAvailable: false, usableNow: true });
    expect(await usable.tool.unavailable?.({ orgId: "o", conversationId: CONV })).toBeNull();
  });

  it("is registered as a sandbox tool, allowed by default, out of the org ask list", () => {
    const r = rig({ attachments: [{ id: ATT, name: "a.xlsx" }] });
    expect(r.tools.map((t) => t.spec.name)).toContain("FetchAttachment");
    expect(r.tool.defaultPolicy).toBe("allow");
    expect(r.tool.spec.keyArgs).toEqual(["file"]);
    expect(BUILTIN_TOOL_KINDS.FetchAttachment).toBe("tool");
    expect(SANDBOX_ASK_TOOL_NAMES.has("FetchAttachment")).toBe(false);
    // the exported factory builds the same tool
    expect(sandboxFetchAttachmentTool(r.deps).spec.name).toBe("FetchAttachment");
  });
});
