import { describe, expect, it } from "vitest";
import {
  EXTENSION_POINTS,
  matchesFilter,
  TRIGGER_SOURCE_EXTENSION_POINT,
  TRIGGER_SUMMARY_MAX_BYTES,
  TriggerError,
  type TriggerEvent,
  validateTriggerEvent,
} from "../src/index.js";

const ev = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
  orgId: "org1",
  type: "item.created",
  subject: { kind: "item", id: "1", title: "T" },
  facts: {},
  summary: "s",
  dedupeKey: "k",
  ...over,
});

describe("matchesFilter", () => {
  const facts = { status: "ready", labels: ["ui", "p1"], priority: 2 };
  it("is a conjunction over eq/in/contains", () => {
    expect(matchesFilter([{ fact: "status", op: "eq", value: "ready" }], facts)).toBe(true);
    expect(matchesFilter([{ fact: "status", op: "in", value: ["done", "ready"] }], facts)).toBe(
      true,
    );
    expect(
      matchesFilter(
        [
          { fact: "labels", op: "contains", value: "p1" },
          { fact: "priority", op: "eq", value: 3 },
        ],
        facts,
      ),
    ).toBe(false);
    expect(matchesFilter([{ fact: "missing", op: "eq", value: "x" }], facts)).toBe(false);
  });
  it("matches everything with an empty filter, and never eq on arrays", () => {
    expect(matchesFilter([], facts)).toBe(true);
    expect(matchesFilter([{ fact: "labels", op: "eq", value: ["ui", "p1"] }], facts)).toBe(false);
    expect(matchesFilter([{ fact: "labels", op: "eq", value: "ui" }], facts)).toBe(false);
  });
});

describe("validateTriggerEvent", () => {
  it("refuses undeclared types and oversized summaries", () => {
    expect(validateTriggerEvent(ev({ type: "item.deleted" }), ["item.created"])).toContain(
      "type_not_declared",
    );
    expect(validateTriggerEvent(ev({ summary: "x".repeat(4097) }), ["item.created"])).toContain(
      "summary_too_long",
    );
  });
  it("measures the summary in UTF-8 bytes", () => {
    const s = "智".repeat(Math.floor(TRIGGER_SUMMARY_MAX_BYTES / 3) + 1);
    expect(validateTriggerEvent(ev({ summary: s }), ["item.created"])).toContain(
      "summary_too_long",
    );
    expect(validateTriggerEvent(ev(), ["item.created"])).toEqual([]);
  });
  it("requires the identifying fields", () => {
    const errs = validateTriggerEvent(
      ev({ orgId: "", dedupeKey: "", subject: { kind: "", id: "", title: "" } }),
      ["item.created"],
    );
    expect(errs).toEqual(
      expect.arrayContaining([
        "missing_org_id",
        "missing_dedupe_key",
        "missing_subject_kind",
        "missing_subject_id",
        "missing_subject_title",
      ]),
    );
  });
});

describe("trigger-source@1", () => {
  it("is a brokered, org-scoped multi point", () => {
    expect(TRIGGER_SOURCE_EXTENSION_POINT).toBe("trigger-source@1");
    expect(EXTENSION_POINTS["trigger-source"]).toMatchObject({
      majors: [1],
      cardinality: "multi",
      brokered: true,
      orgScoped: true,
    });
  });
  it("TriggerError carries its code", () => {
    expect(new TriggerError("org_disabled", "x").code).toBe("org_disabled");
  });
});
