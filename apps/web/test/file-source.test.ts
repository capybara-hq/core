import { describe, expect, it } from "vitest";
import { type FileSource, type ShareMeta, sourceFile, sourceUrls } from "../src/lib/file-source";
import { builtinPreview, type FileOutput, isHtmlFile } from "../src/lib/files";

describe("isHtmlFile", () => {
  it("takes the text/html base type or a .html / .htm name in any case", () => {
    expect(isHtmlFile({ name: "a.HTM", contentType: "application/octet-stream" })).toBe(true);
    expect(isHtmlFile({ name: "report", contentType: "text/html; charset=gbk" })).toBe(true);
    expect(isHtmlFile({ name: "index.html", contentType: "text/plain" })).toBe(true);
    expect(isHtmlFile({ name: "a.html.txt", contentType: "text/plain" })).toBe(false);
    expect(isHtmlFile({ name: "page.xhtml", contentType: "application/xhtml+xml" })).toBe(false);
  });

  it("builtinPreview picks html before every other built-in", () => {
    expect(builtinPreview({ name: "r.html", contentType: "text/html", previewable: "text" })).toBe(
      "html",
    );
    expect(builtinPreview({ name: "r.htm", contentType: "", previewable: null })).toBe("html");
  });
});

const META: ShareMeta = {
  name: "季度报告.html",
  contentType: "text/html",
  size: 10,
  sharedBy: "Grant",
  expiresAt: null,
  audience: "internal",
  render: "html",
  previewable: "text",
  previewers: [],
};

describe("sourceUrls", () => {
  it("a share reads its public routes", () => {
    expect(sourceUrls({ kind: "share", code: "AbCdEfGh12", meta: META })).toEqual({
      download: "/api/v1/s/AbCdEfGh12/content?download=1",
      inline: "/api/v1/s/AbCdEfGh12/inline",
      content: "/api/v1/s/AbCdEfGh12/content",
      html: "/api/v1/s/AbCdEfGh12/html",
    });
  });

  it("a delivered file reads the artifact routes, an upload the library file route", () => {
    const file = { id: "f1", origin: "delivered" } as FileOutput;
    const s: FileSource = { kind: "conversation", orgId: "o1", conversationId: "c1", file };
    expect(sourceUrls(s)).toEqual({
      download: "/api/v1/orgs/o1/conversations/c1/artifacts/f1/download",
      inline: "/api/v1/orgs/o1/conversations/c1/artifacts/f1/download?inline=1",
      content: "/api/v1/orgs/o1/conversations/c1/artifacts/f1/download",
    });
    const up = { ...s, file: { id: "a1", origin: "uploaded" } as FileOutput };
    expect(sourceUrls(up).download).toBe("/api/v1/orgs/o1/files/a1/download");
    expect(sourceUrls(up).html).toBeUndefined();
  });

  it("a skill file reads the skill file content route by version and path, never an HTML route", () => {
    const s: FileSource = {
      kind: "skill",
      orgId: "o1",
      skillId: "s1",
      version: 3,
      file: {
        path: "scripts/run 1.sh",
        name: "run 1.sh",
        contentType: "application/x-sh",
        size: 7,
        previewable: "text",
      },
    };
    const base = "/api/v1/orgs/o1/skills/s1/files/content?version=3&path=scripts%2Frun+1.sh";
    expect(sourceUrls(s)).toEqual({ download: base, inline: `${base}&inline=1`, content: base });
    expect(sourceFile(s)).toEqual(s.file);
  });
});
