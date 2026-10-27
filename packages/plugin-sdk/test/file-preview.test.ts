import { describe, expect, it } from "vitest";
import {
  EXTENSION_POINTS,
  FILE_PREVIEW_EXTENSION_POINT,
  FILE_PREVIEW_MAX_BYTES,
  type FilePreviewer,
  previewerAccepts,
  validateFilePreviewProvider,
} from "../src/index.js";

const title = { zh: "文档", en: "Document" };
const docx: FilePreviewer = {
  id: "docx",
  title,
  accepts: { extensions: [".docx"] },
  maxBytes: 1024,
  render: async () => ({ blocks: [] }),
};

describe("file-preview@1", () => {
  it("is a registered, org-scoped, multi-provider extension point", () => {
    expect(FILE_PREVIEW_EXTENSION_POINT).toBe("file-preview@1");
    expect(EXTENSION_POINTS["file-preview"]).toEqual({
      cardinality: "multi",
      brokered: false,
      orgScoped: true,
    });
  });

  it("accepts a valid provider (render and embed previewers)", () => {
    expect(
      validateFilePreviewProvider({
        previewers: [docx, { ...docx, id: "pdf", render: undefined, embed: "pdf-view" }],
      }),
    ).toEqual([]);
  });

  it("rejects a previewer with both render and embed, or neither", () => {
    expect(validateFilePreviewProvider({ previewers: [{ ...docx, embed: "x" }] })).toEqual([
      "previewers[0] must have exactly one of render or embed",
    ]);
    expect(validateFilePreviewProvider({ previewers: [{ ...docx, render: undefined }] })).toEqual([
      "previewers[0] must have exactly one of render or embed",
    ]);
  });

  it("rejects maxBytes over the cap, a bad id, duplicates and empty accepts", () => {
    const issues = validateFilePreviewProvider({
      previewers: [
        { ...docx, maxBytes: FILE_PREVIEW_MAX_BYTES + 1 },
        { ...docx, id: "Bad_Id" },
        { ...docx, accepts: {} },
        { ...docx, title: { zh: "", en: "x" } },
      ],
    });
    expect(issues).toEqual([
      `previewers[0].maxBytes must be an integer from 1 to ${FILE_PREVIEW_MAX_BYTES}`,
      "previewers[1].id must match ^[a-z0-9-]{1,40}$",
      'previewers[2].id "docx" is a duplicate',
      "previewers[2].accepts needs at least one MIME type or extension",
      'previewers[3].id "docx" is a duplicate',
      "previewers[3].title needs non-empty zh and en of at most 100 characters",
    ]);
    expect(validateFilePreviewProvider(null)).toEqual(["provider must be an object"]);
    expect(validateFilePreviewProvider({ previewers: [] })).toEqual([
      "previewers must be a non-empty array",
    ]);
  });

  it("previewerAccepts matches MIME wildcards and extensions case-insensitively, within maxBytes", () => {
    const img = { accepts: { mimeTypes: ["image/*"] }, maxBytes: 100 };
    expect(previewerAccepts(img, { name: "a.png", contentType: "image/png", size: 10 })).toBe(true);
    expect(previewerAccepts(img, { name: "a.png", contentType: "IMAGE/PNG; x=y", size: 10 })).toBe(
      true,
    );
    expect(previewerAccepts(img, { name: "a.txt", contentType: "text/plain", size: 10 })).toBe(
      false,
    );
    expect(previewerAccepts(img, { name: "a.png", contentType: "image/png", size: 101 })).toBe(
      false,
    );
    const word = { accepts: { extensions: ["docx"] }, maxBytes: 100 };
    expect(
      previewerAccepts(word, { name: "Report.DOCX", contentType: "application/zip", size: 1 }),
    ).toBe(true);
    expect(
      previewerAccepts(docx, { name: "r.docx", contentType: "application/octet-stream", size: 1 }),
    ).toBe(true);
    expect(previewerAccepts(docx, { name: "r.pdf", contentType: "application/pdf", size: 1 })).toBe(
      false,
    );
    const exact = { accepts: { mimeTypes: ["application/pdf"] }, maxBytes: 100 };
    expect(previewerAccepts(exact, { name: "x", contentType: "application/pdf", size: 1 })).toBe(
      true,
    );
  });
});
