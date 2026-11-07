import { ToolError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { BUILTIN, DEFAULT_AGENT_TOOLS } from "../../src/tools/builtin-names.js";
import { currentTimeTool, localTime } from "../../src/tools/builtins/current-time.js";
import type { BuiltinCallContext } from "../../src/tools/registry.js";

/** The `CurrentTime` builtin: the clock in the run context's zone, or a zone the model names. */

const NOW = Date.parse("2026-11-08T13:05:33.789Z");
const ctx = {
  orgId: "o1",
  conversationId: "c1",
  signal: new AbortController().signal,
} as unknown as BuiltinCallContext;

function tool(zone = "Asia/Shanghai") {
  const asked: { orgId: string; conversationId: string }[] = [];
  const t = currentTimeTool({
    now: () => NOW,
    timeZoneOf: async (c) => {
      asked.push(c);
      return zone;
    },
  });
  return { t, asked };
}

const textOf = (r: unknown) =>
  (r as { content: { type: string; text: string }[] }).content.map((c) => c.text).join("");

describe("CurrentTime", () => {
  it("is a read-only builtin, allowed by default, on for new agents", () => {
    const { t } = tool();
    expect(t.spec.name).toBe(BUILTIN.CurrentTime);
    expect(t.defaultPolicy).toBe("allow");
    expect(DEFAULT_AGENT_TOOLS).toContainEqual({ kind: "builtin", name: "CurrentTime" });
    expect(t.spec.description).toContain("Today's date is already in your context");
  });

  it("without timeZone: the conversation's zone (run context), read from the fixed clock", async () => {
    const { t, asked } = tool("Asia/Shanghai");
    const r = await t.run({}, ctx);
    expect(asked).toEqual([{ orgId: "o1", conversationId: "c1" }]);
    expect(textOf(r)).toBe(
      "Current time: 2026-11-08T21:05:33+08:00 (Sunday)\n" +
        "Time zone: Asia/Shanghai (UTC+08:00)\n" +
        "UTC: 2026-11-08T13:05:33Z",
    );
    expect((r as { display?: unknown }).display).toEqual({
      summary: {
        zh: "已获取当前时间（Asia/Shanghai）",
        en: "Got the current time (Asia/Shanghai)",
      },
    });
  });

  it("an explicit zone wins and the conversation's zone is not read", async () => {
    const { t, asked } = tool("Asia/Shanghai");
    const r = await t.run({ timeZone: "America/New_York" }, ctx);
    expect(asked).toEqual([]);
    expect(textOf(r)).toBe(
      "Current time: 2026-11-08T08:05:33-05:00 (Sunday)\n" +
        "Time zone: America/New_York (UTC-05:00)\n" +
        "UTC: 2026-11-08T13:05:33Z",
    );
  });

  it("an unknown zone is an actionable tool error", async () => {
    const { t } = tool();
    const err = await t.run({ timeZone: "Mars/Olympus" }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toBe(
      "Unknown time zone 'Mars/Olympus'; use an IANA name such as Asia/Shanghai or " +
        "America/New_York, or omit timeZone to use the time zone of the person you work for.",
    );
  });

  it("formats half-hour offsets, UTC and the day across the date line", () => {
    const at = new Date(NOW);
    expect(localTime(at, "Asia/Kolkata")).toEqual({
      local: "2026-11-08T18:35:33+05:30",
      weekday: "Sunday",
      offset: "+05:30",
      utc: "2026-11-08T13:05:33Z",
    });
    expect(localTime(at, "UTC").local).toBe("2026-11-08T13:05:33+00:00");
    expect(localTime(at, "Pacific/Kiritimati")).toMatchObject({
      local: "2026-11-09T03:05:33+14:00",
      weekday: "Monday",
    });
    // midnight reads 00, never 24
    expect(localTime(new Date("2026-11-08T16:00:00Z"), "Asia/Shanghai").local).toBe(
      "2026-11-09T00:00:00+08:00",
    );
  });
});
