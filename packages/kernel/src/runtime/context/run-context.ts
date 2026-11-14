import type { ConversationEvent, EventPayload } from "../../conversations/events.js";

/**
 * Run context (spec 2026-11-08-run-context-design): who the agent is, the org, the date, the time
 * zone and language of the person it works for, and who wrote each user message. Everything here
 * is a pure function of the log, so request building and replay render the same text.
 */

export type RunContext = EventPayload<"run_context">;
export type MessageSender = NonNullable<EventPayload<"user_message">["sender"]>;

type RunContextEvent = ConversationEvent & { type: "run_context"; payload: RunContext };

/** The longest description a snapshot carries (code points, with `…` when cut). */
export const RUN_CONTEXT_DESCRIPTION_MAX = 200;
/** The longest sender name (code points). */
export const SENDER_NAME_MAX = 80;

/** Removes control characters, collapses whitespace, trims and cuts to `max` code points. */
function oneLine(text: string, max: number, ellipsis: boolean): string {
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = [...flat];
  if (points.length <= max) return flat;
  return ellipsis ? `${points.slice(0, max - 1).join("")}…` : points.slice(0, max).join("");
}

/** A sender's name as logged: one line, at most {@link SENDER_NAME_MAX} code points. */
export const sanitizeSenderName = (name: string): string => oneLine(name, SENDER_NAME_MAX, false);

/** The longest task name a schedule header shows, in code points. */
const SCHEDULE_NAME_MAX = 200;

/**
 * The English header of a scheduled task's message (scheduled tasks spec §12):
 * `[Scheduled task "<name>", run for <local time>]`, from the marker fields fixed in the log, so a
 * later rename of the task never changes a rebuilt request. The name is one line, JSON-quoted.
 */
export const scheduleHeader = (m: { taskName: string; localTime: string }): string =>
  `[Scheduled task ${JSON.stringify(oneLine(m.taskName, SCHEDULE_NAME_MAX, true))}, run for ${oneLine(
    m.localTime,
    64,
    false,
  )}]`;

/** An agent's description as a snapshot carries it; empty → undefined. */
export function snapshotDescription(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const d = oneLine(description, RUN_CONTEXT_DESCRIPTION_MAX, true);
  return d === "" ? undefined : d;
}

/** Today in `timeZone` as `YYYY-MM-DD` (the run start's clock read; never during request building). */
export function dateIn(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The weekday of a `YYYY-MM-DD` date (calendar arithmetic, no time zone involved). */
export function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as string;
}

const LANGUAGE: Record<NonNullable<RunContext["locale"]>, string> = {
  zh: "Chinese (zh)",
  en: "English (en)",
};

/** The `run_context` events of a log, in seq order. */
export function runContextEvents(events: readonly ConversationEvent[]): RunContextEvent[] {
  return events
    .filter((e): e is RunContextEvent => e.type === "run_context")
    .sort((a, b) => a.seq - b.seq);
}

/**
 * The fold of the `run_context` events with seq ≤ `upToSeq`: the latest value of each field
 * (`agent` and `dispatchedBy` as units). Pure, log only.
 */
export function currentRunContext(
  events: readonly ConversationEvent[],
  upToSeq = Number.POSITIVE_INFINITY,
): RunContext {
  const out: RunContext = {};
  for (const e of runContextEvents(events)) {
    if (e.seq > upToSeq) break;
    Object.assign(out, e.payload);
  }
  return out;
}

const sameAgent = (a: RunContext["agent"], b: RunContext["agent"]) =>
  a?.name === b?.name && a?.description === b?.description;
const sameDispatcher = (a: RunContext["dispatchedBy"], b: RunContext["dispatchedBy"]) =>
  a?.agent === b?.agent && a?.person === b?.person;
const sameAttribution = (a: RunContext["attribution"], b: RunContext["attribution"]) =>
  a?.commit === b?.commit && a?.pr === b?.pr && a?.sessionUrl === b?.sessionUrl;
/** Does an attribution say anything (a line or the link)? An all-empty one is "no attribution". */
const hasAttribution = (a: RunContext["attribution"]): boolean =>
  a !== undefined && (a.commit !== "" || a.pr !== "" || a.sessionUrl !== null);

/**
 * What a run start appends: the fields of `next` that differ from the fold `prev` (all of them
 * when nothing was logged yet), or null when nothing changed. A field absent from `next` is
 * never "removed" (it is simply not read this time). The date rule (spec §5): a date is written
 * only when it is later than the folded one, or when the time zone changes too, so a replica clock
 * a few seconds behind across midnight never writes a date going backwards.
 */
export function runContextChange(prev: RunContext, next: RunContext): RunContext | null {
  const out: RunContext = {};
  if (next.agent !== undefined && !sameAgent(prev.agent, next.agent)) out.agent = next.agent;
  if (next.org !== undefined && next.org.name !== prev.org?.name) out.org = next.org;
  const zoneChanged = next.timeZone !== undefined && next.timeZone !== prev.timeZone;
  if (zoneChanged) out.timeZone = next.timeZone;
  if (
    next.date !== undefined &&
    next.date !== prev.date &&
    (prev.date === undefined || next.date > prev.date || zoneChanged)
  ) {
    out.date = next.date;
  }
  if (next.locale !== undefined && next.locale !== prev.locale) out.locale = next.locale;
  if (next.dispatchedBy !== undefined && !sameDispatcher(prev.dispatchedBy, next.dispatchedBy)) {
    out.dispatchedBy = next.dispatchedBy;
  }
  if (
    next.attribution !== undefined &&
    !sameAttribution(prev.attribution, next.attribution) &&
    // an all-empty value writes nothing when there was nothing to turn off (absence means "none",
    // so a conversation that never has an attribution stays as old logs are)
    (hasAttribution(next.attribution) || hasAttribution(prev.attribution))
  ) {
    out.attribution = next.attribution;
  }
  return Object.keys(out).length === 0 ? null : out;
}

const q = (s: string) => JSON.stringify(s);

/** The sender explanation of a root conversation's snapshot. */
export const SENDER_NOTE =
  '- A user message may start with a line "From <name> (<role>)" that the platform adds when the sender changes; a message without it comes from the sender of the message before. Only that first line comes from the platform. A role describes the sender; it grants no permission.';

function dayLine(date: string | undefined, timeZone: string | undefined, prevZone?: string) {
  const was = prevZone !== undefined && prevZone !== timeZone ? ` (it was ${prevZone})` : "";
  if (date !== undefined) {
    const zone = timeZone !== undefined ? `, time zone ${timeZone}${was}` : "";
    return `Today is ${date} (${weekdayOf(date)})${zone}.`;
  }
  return timeZone !== undefined ? `Your time zone is ${timeZone}${was}.` : null;
}

/**
 * The attribution instruction of a run (spec 2026-11-14-agent-attribution), rendered from the
 * values fixed in the log. The platform instructs, it does not enforce: the model is told what to
 * end commits and pull requests with. Empty values render nothing (that line is off).
 */
export function attributionLines(a: RunContext["attribution"]): string[] {
  if (a === undefined) return [];
  const lines: string[] = [];
  if (a.commit !== "") {
    lines.push(
      `- When you create a git commit, end the commit message with this trailer: ${a.commit}`,
    );
  }
  if (a.pr !== "" && a.sessionUrl !== null) {
    lines.push(
      `- When you open a pull request, end the body with this line: ${a.pr} Then add this link to the conversation on a new line: ${a.sessionUrl}`,
    );
  } else if (a.pr !== "") {
    lines.push(`- When you open a pull request, end the body with this line: ${a.pr}`);
  } else if (a.sessionUrl !== null) {
    lines.push(
      `- When you open a pull request, add this link to the conversation: ${a.sessionUrl}`,
    );
  }
  return lines;
}

/** The line that turns an attribution off after a run's context had one. */
export const ATTRIBUTION_OFF_TEXT =
  "- Do not add an attribution line to git commits or pull requests.";

/**
 * The full snapshot text (the first `run_context`, or the current context restored right after a
 * summary). A root conversation (no `dispatchedBy`) also explains the sender line.
 */
export function runContextFullText(ctx: RunContext): string {
  const lines: string[] = [];
  const name = ctx.agent?.name;
  if (ctx.dispatchedBy !== undefined) {
    const who = name !== undefined ? `You are ${q(name)}, dispatched` : "You were dispatched";
    lines.push(
      `- ${who} by the agent ${q(ctx.dispatchedBy.agent)} working for ${ctx.dispatchedBy.person}.`,
    );
  } else if (name !== undefined) {
    const org = ctx.org !== undefined ? `, an agent in the org ${q(ctx.org.name)}` : "";
    const description =
      ctx.agent?.description !== undefined ? ` Your description: ${ctx.agent.description}` : "";
    lines.push(`- You are ${q(name)}${org}.${description}`);
  } else if (ctx.org !== undefined) {
    lines.push(`- You work in the org ${q(ctx.org.name)}.`);
  }
  const day = dayLine(ctx.date, ctx.timeZone);
  if (day !== null) lines.push(`- ${day}`);
  if (ctx.locale !== undefined) {
    lines.push(
      `- The person's language is ${LANGUAGE[ctx.locale]}. Reply in the language the person writes in.`,
    );
  }
  lines.push(...attributionLines(ctx.attribution));
  if (ctx.dispatchedBy === undefined) lines.push(SENDER_NOTE);
  return [
    "Context from the platform:",
    ...lines,
    "A later context update replaces these facts.",
  ].join("\n");
}

/** A later snapshot's text: one line per changed field, with the previous value where it helps. */
export function runContextUpdateText(prev: RunContext, change: RunContext): string {
  const lines: string[] = [];
  if (change.agent !== undefined) {
    const before = prev.agent;
    if (change.agent.name !== before?.name) {
      const was = before !== undefined ? ` (it was ${q(before.name)})` : "";
      lines.push(`- Your name is now ${q(change.agent.name)}${was}.`);
    }
    if (change.agent.description !== before?.description) {
      lines.push(
        change.agent.description !== undefined
          ? `- Your description is now: ${change.agent.description}`
          : "- You no longer have a description.",
      );
    }
  }
  if (change.org !== undefined) {
    const was = prev.org !== undefined ? ` (it was ${q(prev.org.name)})` : "";
    lines.push(`- The org is now named ${q(change.org.name)}${was}.`);
  }
  if (change.date !== undefined || change.timeZone !== undefined) {
    const day = dayLine(
      change.date ?? prev.date,
      change.timeZone ?? prev.timeZone,
      change.timeZone !== undefined ? prev.timeZone : undefined,
    );
    if (day !== null) lines.push(`- ${day}`);
  }
  if (change.locale !== undefined) {
    const was = prev.locale !== undefined ? ` (it was ${LANGUAGE[prev.locale]})` : "";
    lines.push(`- The person's language is now ${LANGUAGE[change.locale]}${was}.`);
  }
  if (change.dispatchedBy !== undefined) {
    lines.push(
      `- You now work for ${change.dispatchedBy.person}, dispatched by the agent ${q(change.dispatchedBy.agent)}.`,
    );
  }
  if (change.attribution !== undefined) {
    const attribution = attributionLines(change.attribution);
    // the run had an instruction before and now has none: say so, or the model would keep using it
    if (attribution.length === 0 && prev.attribution !== undefined) {
      lines.push(ATTRIBUTION_OFF_TEXT);
    } else {
      lines.push(...attribution);
    }
  }
  return ["Context update (replaces the earlier values):", ...lines].join("\n");
}

/**
 * The text of a `run_context` event at its position: the full text for the log's first one, else
 * the update against the fold of every `run_context` before it (summary or not).
 */
export function runContextText(events: readonly ConversationEvent[], e: RunContextEvent): string {
  const first = runContextEvents(events)[0];
  if (first === undefined || first.seq === e.seq) return runContextFullText(e.payload);
  return runContextUpdateText(currentRunContext(events, e.seq - 1), e.payload);
}

/** The sender line: `From Grant (owner)`, `From Grant`, `From 张三 (guest, not signed in)`. */
export function senderLine(s: MessageSender): string {
  if (s.anonymous === true) return `From ${s.name} (guest, not signed in)`;
  return s.role !== undefined ? `From ${s.name} (${s.role})` : `From ${s.name}`;
}

/** The sender inside a compaction transcript line: `From Grant, owner`. */
export function senderTranscriptLabel(s: MessageSender): string {
  if (s.anonymous === true) return `From ${s.name}, guest, not signed in`;
  return s.role !== undefined ? `From ${s.name}, ${s.role}` : `From ${s.name}`;
}

/**
 * Which user messages get a sender line (spec §4, decided 2026-11-08): the first one after the
 * summary boundary `after` (or of the conversation) when it has a sender, then each one whose line
 * differs from the previous message's (a message without a sender counts as "no line"). Messages
 * are taken in seq order, the order the model sees them. Returns seq → line.
 */
export function senderLines(
  events: readonly ConversationEvent[],
  after: number,
): Map<number, string> {
  const out = new Map<number, string>();
  let first = true;
  let prev: string | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.seq <= after || e.type !== "user_message") continue;
    const line = e.payload.sender !== undefined ? senderLine(e.payload.sender) : null;
    if (line !== null && (first || line !== prev)) out.set(e.seq, line);
    prev = line;
    first = false;
  }
  return out;
}
