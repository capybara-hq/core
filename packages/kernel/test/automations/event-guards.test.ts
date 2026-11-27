import type { TriggerEventDeclaration } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  coalesceJobId,
  depthExceeded,
  isSelfTriggered,
  subjectKey,
  validateFilter,
} from "../../src/automations/events/guards.js";

const subject = { kind: "tracker:issue", id: "org:42/a:b", title: "t" };

describe("subjectKey", () => {
  it("contains no colon and is stable", () => {
    const key = subjectKey(subject);
    expect(key).not.toContain(":");
    expect(key).toBe(subjectKey({ ...subject }));
    expect(key).toMatch(/^tracker-issue-[0-9a-f]{16}$/);
  });
  it("differs per id", () => {
    expect(subjectKey({ kind: "k", id: "1", title: "t" })).not.toBe(
      subjectKey({ kind: "k", id: "2", title: "t" }),
    );
  });
});

describe("coalesceJobId", () => {
  it("has the automation prefix and no colon", () => {
    const id = coalesceJobId("auto-1", subject);
    expect(id).toBe(`automation-coalesce-auto-1-${subjectKey(subject)}`);
    expect(id).not.toContain(":");
  });
});

describe("isSelfTriggered", () => {
  const a = { accountId: "acc", agentId: "ag" };
  it("is true only when account and agent both match", () => {
    expect(isSelfTriggered(a, { runAccountId: "acc", runAgentId: "ag" })).toBe(true);
    expect(isSelfTriggered(a, { runAccountId: "acc", runAgentId: "other" })).toBe(false);
    expect(isSelfTriggered(a, { runAccountId: "other", runAgentId: "ag" })).toBe(false);
    expect(isSelfTriggered(a, null)).toBe(false);
  });
});

describe("depthExceeded", () => {
  it("is depth > max", () => {
    expect(depthExceeded(8, 8)).toBe(false);
    expect(depthExceeded(9, 8)).toBe(true);
  });
});

describe("validateFilter", () => {
  const name = { zh: "x", en: "x" };
  const decl = (
    type: string,
    facts: TriggerEventDeclaration["facts"],
  ): TriggerEventDeclaration => ({
    type,
    name,
    directed: false,
    facts,
  });
  const created = decl("item.created", {
    status: { type: "string", name, filterable: true },
    priority: { type: "number", name, filterable: true },
    done: { type: "boolean", name, filterable: true },
    labels: { type: "string[]", name, filterable: true },
    note: { type: "string", name, filterable: false },
  });
  const updated = decl("item.updated", {
    status: { type: "string", name, filterable: true },
    priority: { type: "string", name, filterable: true },
    note: { type: "string", name, filterable: true },
  });

  it("accepts an empty filter and well-typed clauses", () => {
    expect(validateFilter([], [created])).toEqual([]);
    expect(
      validateFilter(
        [
          { fact: "status", op: "eq", value: "open" },
          { fact: "status", op: "in", value: ["open", "new"] },
          { fact: "priority", op: "eq", value: 2 },
          { fact: "done", op: "eq", value: false },
          { fact: "labels", op: "contains", value: "bug" },
        ],
        [created, updated].slice(0, 1),
      ),
    ).toEqual([]);
  });

  it("refuses a fact that is missing, not filterable or declared by only some types", () => {
    expect(validateFilter([{ fact: "nope", op: "eq", value: "x" }], [created])).toEqual([
      expect.stringContaining('"nope" is not declared by item.created'),
    ]);
    expect(validateFilter([{ fact: "note", op: "eq", value: "x" }], [created])).toEqual([
      expect.stringContaining("cannot be filtered on"),
    ]);
    // `note` is filterable in one type only: every selected type must allow it
    expect(validateFilter([{ fact: "note", op: "eq", value: "x" }], [created, updated])).toEqual([
      expect.stringContaining("cannot be filtered on"),
    ]);
    expect(
      validateFilter([{ fact: "labels", op: "contains", value: "x" }], [created, updated]),
    ).toEqual([expect.stringContaining('"labels" is not declared by item.updated')]);
    expect(validateFilter([{ fact: "status", op: "eq", value: "x" }], [])).toHaveLength(1);
  });

  it("refuses a fact whose type differs between the selected types", () => {
    expect(validateFilter([{ fact: "priority", op: "eq", value: 1 }], [created, updated])).toEqual([
      expect.stringContaining("different types"),
    ]);
  });

  it("refuses an operator or value that does not fit the fact's type", () => {
    const bad = (c: Parameters<typeof validateFilter>[0][number]) =>
      validateFilter([c], [created]).length;
    expect(bad({ fact: "status", op: "eq", value: 1 })).toBe(1);
    expect(bad({ fact: "priority", op: "eq", value: "1" })).toBe(1);
    expect(bad({ fact: "done", op: "eq", value: "true" })).toBe(1);
    expect(bad({ fact: "labels", op: "eq", value: "bug" })).toBe(1);
    expect(bad({ fact: "status", op: "in", value: "open" })).toBe(1);
    expect(bad({ fact: "priority", op: "in", value: ["1"] })).toBe(1);
    expect(bad({ fact: "status", op: "contains", value: "o" })).toBe(1);
    expect(bad({ fact: "labels", op: "contains", value: ["bug"] })).toBe(1);
    expect(bad({ fact: "status", op: "like" as never, value: "o" })).toBe(1);
  });

  it("caps the clauses", () => {
    const filter = Array.from({ length: 21 }, () => ({
      fact: "status",
      op: "eq" as const,
      value: "a",
    }));
    expect(validateFilter(filter, [created])).toEqual([expect.stringContaining("at most 20")]);
  });
});
