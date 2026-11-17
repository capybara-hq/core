import { describe, expect, it } from "vitest";
import {
  acceptAttribute,
  attachmentTypeLabel,
  DEFAULT_LIMITS,
  fileContentType,
  precheckFile,
  typeList,
} from "../src/lib/attachments";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Fourteen allowed types: the refusal line shows the first six, then the count. */
const FOURTEEN_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  XLSX,
  DOCX,
  PPTX,
  "application/zip",
  "application/json",
  "application/x-ndjson",
];

const zhMore = (n: number) => `等 ${n} 种`;
const enMore = (n: number) => `and ${n} total`;

describe("typeList", () => {
  it("lists at most six labels then a count", () => {
    expect(typeList(FOURTEEN_TYPES, zhMore)).toBe("PNG / JPEG / GIF / WebP / PDF / TXT 等 14 种");
    expect(typeList(FOURTEEN_TYPES, enMore)).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT and 14 total",
    );
  });

  it("the cap is six, so seven truncates too", () => {
    expect(typeList(FOURTEEN_TYPES.slice(0, 7), zhMore)).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT 等 7 种",
    );
    expect(typeList(FOURTEEN_TYPES.slice(0, 7), enMore)).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT and 7 total",
    );
  });

  it("six or fewer join with no count", () => {
    expect(typeList(FOURTEEN_TYPES.slice(0, 6), zhMore)).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT",
    );
    expect(typeList(FOURTEEN_TYPES.slice(0, 6), enMore)).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT",
    );
    expect(typeList(["image/png", "application/pdf"], enMore)).toBe("PNG / PDF");
    expect(typeList([], zhMore)).toBe("");
  });
});

describe("attachmentTypeLabel", () => {
  it("labels the office and archive types", () => {
    expect(attachmentTypeLabel(XLSX)).toBe("XLSX");
    expect(attachmentTypeLabel(DOCX)).toBe("DOCX");
    expect(attachmentTypeLabel(PPTX)).toBe("PPTX");
    expect(attachmentTypeLabel("application/zip")).toBe("ZIP");
    expect(attachmentTypeLabel("application/json")).toBe("JSON");
  });

  it("keeps the existing labels", () => {
    expect(
      [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
      ].map(attachmentTypeLabel),
    ).toEqual(["PNG", "JPEG", "GIF", "WebP", "PDF", "TXT", "Markdown", "CSV"]);
    // anything unknown still shows its content type
    expect(attachmentTypeLabel("application/x-ndjson")).toBe("application/x-ndjson");
  });
});

describe("fileContentType", () => {
  it("infers the new extensions when the browser gives no type", () => {
    expect(fileContentType({ name: "book.xlsx", type: "" })).toBe(XLSX);
    expect(fileContentType({ name: "letter.DOCX", type: "" })).toBe(DOCX);
    expect(fileContentType({ name: "deck.pptx", type: "" })).toBe(PPTX);
    expect(fileContentType({ name: "bundle.zip", type: "" })).toBe("application/zip");
    expect(fileContentType({ name: "state.json", type: "" })).toBe("application/json");
  });
});

describe("DEFAULT_LIMITS", () => {
  it("allows the kernel's 13 types before the limits arrive", () => {
    expect(DEFAULT_LIMITS.types).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      XLSX,
      DOCX,
      PPTX,
      "application/zip",
      "application/json",
    ]);
    // a first paint does not refuse a valid file
    for (const type of DEFAULT_LIMITS.types) {
      expect(precheckFile({ name: "f", type, size: 1 }, DEFAULT_LIMITS)).toBeNull();
    }
    // and the refusal line stays one short line
    expect(typeList(DEFAULT_LIMITS.types, zhMore)).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT 等 13 种",
    );
  });
});

describe("extension acceptance", () => {
  it("a source or office file passes by extension whatever its content type", () => {
    const limits = { ...DEFAULT_LIMITS, extensions: ["py", "html", "docx"] };
    expect(
      precheckFile({ name: "main.py", type: "application/octet-stream", size: 3 }, limits),
    ).toBeNull();
    expect(precheckFile({ name: "page.html", type: "text/html", size: 3 }, limits)).toBeNull();
    expect(precheckFile({ name: "续约.DOCX", type: "", size: 3 }, limits)).toBeNull();
    expect(precheckFile({ name: "a.exe", type: "application/x-msdownload", size: 3 }, limits)).toBe(
      "attachment.type_not_allowed",
    );
    // the size limit still applies to an extension-accepted file
    expect(
      precheckFile({ name: "big.zip", type: "application/zip", size: limits.maxBytes + 1 }, limits),
    ).toBe("attachment.too_large");
  });

  it("the accept attribute offers the types and the .ext entries", () => {
    const attr = acceptAttribute({ ...DEFAULT_LIMITS, extensions: ["py", "html"] });
    expect(attr).toContain("image/png");
    expect(attr).toContain(".py");
    expect(attr.split(",")).toContain(".html");
  });
});
