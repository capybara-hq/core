import { ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { isTimeZone } from "../../time-zone.js";
import { BUILTIN } from "../builtin-names.js";
import type { BuiltinTool } from "../registry.js";

/**
 * The `CurrentTime` builtin: the current local date-time in a time zone. The run context gives the
 * model the date only (day granularity, run context spec §3), so the time of day, durations and
 * other zones come from this tool. Read-only, no side effects: `defaultPolicy` is allow. The
 * result goes into the log like any tool result, so replays read the recorded answer.
 */

const SPEC: ToolSpec = {
  name: BUILTIN.CurrentTime,
  description:
    "Get the current time: the local date and time with its UTC offset, the weekday, the time " +
    "zone and the UTC instant. Today's date is already in your context; call this when you need " +
    "the time of day, to work out a duration or how long ago something happened, or to know the " +
    "time in another time zone. Without timeZone it uses the time zone of the person you work " +
    "for. Read-only, no side effects.",
  inputSchema: {
    type: "object",
    properties: {
      timeZone: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description:
          "An IANA time zone name, e.g. Asia/Shanghai, America/New_York or UTC. Omit it to use " +
          "the time zone of the person you work for.",
      },
    },
    additionalProperties: false,
  },
};

const Input = z.object({ timeZone: z.string().min(1).max(64).optional() }).strict();

/** An unknown zone: what was wrong and how to call again. */
export const unknownTimeZoneText = (zone: string): string =>
  `Unknown time zone '${zone}'; use an IANA name such as Asia/Shanghai or America/New_York, ` +
  "or omit timeZone to use the time zone of the person you work for.";

/** The input did not parse (the schema check runs first, so this is a guard). */
const INVALID_INPUT_TEXT =
  "Invalid input; pass an object with an optional timeZone string (an IANA name such as Asia/Shanghai).";

/** The local wall clock of `now` in `timeZone`, with its offset from UTC. */
export interface LocalTime {
  /** `YYYY-MM-DDTHH:mm:ss±HH:MM`. */
  local: string;
  weekday: string;
  /** `+08:00`, `-05:00`, `+00:00`. */
  offset: string;
  /** `YYYY-MM-DDTHH:mm:ssZ`. */
  utc: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Formats `now` in `timeZone` (a zone {@link isTimeZone} accepts). Seconds precision. */
export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const [y, mo, d, h, mi, s] = ["year", "month", "day", "hour", "minute", "second"].map((t) =>
    Number(part(t)),
  ) as [number, number, number, number, number, number];
  const seconds = Math.floor(now.getTime() / 1000) * 1000;
  // the zone's offset: the wall clock read as if it were UTC, minus the instant
  const offsetMin = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - seconds) / 60_000);
  const abs = Math.abs(offsetMin);
  const offset = `${offsetMin < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return {
    local: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${offset}`,
    weekday: part("weekday"),
    offset,
    utc: `${new Date(seconds).toISOString().slice(0, 19)}Z`,
  };
}

export interface CurrentTimeDeps {
  /** The clock (epoch ms): the kernel's `RUN_CONTEXT_CLOCK` seam, `Date.now` by default. */
  now: () => number;
  /** The conversation's time zone (its run context's, else the org default, else UTC). */
  timeZoneOf: (ctx: { orgId: string; conversationId: string }) => Promise<string>;
}

/** The `CurrentTime` builtin. */
export function currentTimeTool(deps: CurrentTimeDeps): BuiltinTool {
  return {
    spec: SPEC,
    defaultPolicy: "allow",
    async run(input, ctx) {
      const parsed = Input.safeParse(input ?? {});
      if (!parsed.success) throw new ToolError(INVALID_INPUT_TEXT);
      const asked = parsed.data.timeZone?.trim();
      if (asked !== undefined && !isTimeZone(asked)) {
        throw new ToolError(unknownTimeZoneText(asked));
      }
      const zone =
        asked ?? (await deps.timeZoneOf({ orgId: ctx.orgId, conversationId: ctx.conversationId }));
      const t = localTime(new Date(deps.now()), zone);
      const text =
        `Current time: ${t.local} (${t.weekday})\n` +
        `Time zone: ${zone} (UTC${t.offset})\n` +
        `UTC: ${t.utc}`;
      // the row's key argument already shows a zone the model passed; the summary then gives the
      // time alone, and names the zone only when it came from the run context
      const hm = t.local.slice(11, 16);
      const where =
        asked === undefined ? { zh: `（${zone}）`, en: ` (${zone})` } : { zh: "", en: "" };
      return {
        content: [{ type: "text", text }],
        display: {
          summary: {
            zh: `已获取当前时间 · ${hm}${where.zh}`,
            en: `Got the current time · ${hm}${where.en}`,
          },
        },
      };
    },
  };
}
