import { describe, expect, it } from "vitest";
import {
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

describe("typeList", () => {
  it("lists at most six labels then a count", () => {
    expect(typeList(FOURTEEN_TYPES)).toBe("PNG / JPEG / GIF / WebP / PDF / TXT 等 14 种");
    expect(typeList(FOURTEEN_TYPES, "en")).toBe("PNG / JPEG / GIF / WebP / PDF / TXT and 14 total");
  });

  it("the cap is six, so seven truncates too", () => {
    expect(typeList(FOURTEEN_TYPES.slice(0, 7), "zh")).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT 等 7 种",
    );
    expect(typeList(FOURTEEN_TYPES.slice(0, 7), "en")).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT and 7 total",
    );
  });

  it("six or fewer join with no count", () => {
    expect(typeList(FOURTEEN_TYPES.slice(0, 6), "zh")).toBe("PNG / JPEG / GIF / WebP / PDF / TXT");
    expect(typeList(FOURTEEN_TYPES.slice(0, 6), "en")).toBe("PNG / JPEG / GIF / WebP / PDF / TXT");
    expect(typeList(["image/png", "application/pdf"], "en")).toBe("PNG / PDF");
    expect(typeList([], "zh")).toBe("");
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
    expect(typeList(DEFAULT_LIMITS.types, "zh")).toBe(
      "PNG / JPEG / GIF / WebP / PDF / TXT 等 13 种",
    );
  });
});
