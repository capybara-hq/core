import type { ModelInfo } from "@capybara-hq/plugin-sdk";
import type { AgentDefinition } from "../../../src/agents/definition.js";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { type CaseSnapshot, toEvents } from "../../../src/evals/snapshot.js";
import type { RequestTool } from "../../../src/runtime/context/build.js";
import { compactionPlan } from "../../../src/runtime/context/compaction.js";
import { planningBounds } from "../../../src/runtime/context/fit.js";
import { estimateTokens } from "../../../src/runtime/context/tokens.js";
import { assembleModelRequest } from "../../../src/runtime/model-call.js";
import { compactionSettings } from "./fixtures.js";

/**
 * Seeded long conversations for the in-context boundary eval (idle compaction spec §9.4, §12 Q9):
 * a coding agent's tool-using work (file reads, edits, command output, failing runs, user
 * corrections) recorded as the runtime records it, one run per user turn, each `model_call`
 * carrying the request meta `assembleModelRequest` produced. Each conversation plants 8 head facts
 * before the plan's boundary and 4 tail facts after it, each with a unique codeword
 * (`ZQ-<seed>-H3`, `ZQ-<seed>-T2`); head fact H1 is the security constraint. No tail codeword sits
 * in the first kept user message, so the instruction's anchor quote never carries one. Not a test.
 */

const ORG = "00000000-0000-4000-8000-0000000000e1";
const CONV = "00000000-0000-4000-8000-0000000000e2";
const AT = "2026-11-28T00:00:00.000Z";

/** The model the fixtures are recorded with; a live test sends its requests to the vendor's model. */
export const EVAL_MODEL: ModelInfo = {
  id: "eval-model",
  displayName: "Eval model",
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  capabilities: { tools: true, vision: false, reasoning: true, midConversationSystem: true },
  parameters: [],
};

/** keepRecentTurns 4, reserve 8000: the defaults the brief names. */
export const EVAL_SETTINGS = compactionSettings({ keepRecentTurns: 4 });

/** The step output cap the runs record (and the plan's `O_p`). */
const STEP_MAX_OUTPUT = 8192;

export const EVAL_SEEDS: readonly number[] = Array.from({ length: 20 }, (_, i) => i + 1);

/** The constraint's text, as the summary must keep it verbatim. */
export const CONSTRAINT_TEXT = "never touch `secrets/`";

const AGENT: AgentDefinition = {
  name: "Builder",
  avatarUrl: null,
  instructions:
    "You are a coding agent working in the ledger-service repository (TypeScript, pnpm, vitest, PostgreSQL). Read code before changing it, keep edits small, run the tests after every change and report what you did.",
  model: { provider: "eval", model: "eval-model" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  disabledSkills: [],
  disabledTools: [],
  toolPolicies: {},
};

function tool(key: string, description: string, properties: Record<string, unknown>): RequestTool {
  return {
    key,
    specHash: `hash-${key.toLowerCase()}`,
    spec: {
      name: key,
      description,
      inputSchema: { type: "object", properties, required: Object.keys(properties) },
    },
  };
}

const TOOLS: RequestTool[] = [
  tool("Read", "Read a file of the repository.", { path: { type: "string" } }),
  tool("Bash", "Run a shell command in the repository root.", { command: { type: "string" } }),
  tool("Edit", "Replace one exact string in a file.", {
    path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
  }),
  tool("Grep", "Search the repository with a regular expression.", {
    pattern: { type: "string" },
    path: { type: "string" },
  }),
];

/** mulberry32: a small seeded PRNG, so a seed always yields the same conversation. */
function rng(seed: number): () => number {
  let a = seed * 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rand {
  constructor(readonly next: () => number) {}
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const MODULES = [
  "ledger",
  "accounts",
  "payouts",
  "invoices",
  "fx",
  "reconcile",
  "audit",
  "exports",
  "webhooks",
  "billing",
];
const NOUNS = [
  "entry",
  "balance",
  "posting",
  "batch",
  "rate",
  "journal",
  "period",
  "transfer",
  "cursor",
  "snapshot",
];
const VERBS = ["load", "apply", "build", "settle", "validate", "split", "merge", "record", "scan"];

function ident(r: Rand): string {
  const n = r.pick(NOUNS);
  return `${r.pick(VERBS)}${n[0]?.toUpperCase()}${n.slice(1)}`;
}

function filePath(r: Rand): string {
  return `src/${r.pick(MODULES)}/${r.pick(NOUNS)}-${r.pick(["service", "repo", "mapper", "rules", "worker"])}.ts`;
}

/** TypeScript-like source of about `tokens` estimated tokens (4 ASCII chars a token). */
function sourceText(r: Rand, path: string, tokens: number): string {
  const lines: string[] = [
    `// ${path}`,
    `import { Pool } from "pg";`,
    `import { Money, round } from "../shared/money.js";`,
    "",
  ];
  let chars = lines.join("\n").length;
  let n = 1;
  while (chars < tokens * 4) {
    const fn = ident(r);
    const noun = r.pick(NOUNS);
    const block = [
      `export async function ${fn}(pool: Pool, id: string): Promise<${noun[0]?.toUpperCase()}${noun.slice(1)} | null> {`,
      `  const { rows } = await pool.query(`,
      `    "SELECT id, amount_minor, currency, created_at FROM ${r.pick(MODULES)}_${noun}s WHERE id = $1",`,
      "    [id],",
      "  );",
      "  if (rows.length === 0) return null;",
      `  const amount = round(Money.fromMinor(rows[0].amount_minor, rows[0].currency), ${r.int(0, 4)});`,
      `  // step ${n}: ${r.pick(["keep the sign", "never mix currencies", "clamp to the period", "drop zero lines"])}`,
      `  return { id, amount, createdAt: rows[0].created_at, kind: "${noun}" };`,
      "}",
      "",
    ].join("\n");
    lines.push(block);
    chars += block.length + 1;
    n++;
  }
  return lines.join("\n");
}

/** Command output of about `tokens` estimated tokens: test runs, logs, git, grep. */
function commandText(r: Rand, command: string, tokens: number, failing: boolean): string {
  const lines: string[] = [`$ ${command}`];
  let chars = lines[0]?.length ?? 0;
  let i = 0;
  while (chars < tokens * 4) {
    const kind = i % 4;
    const p = filePath(r).replace(/\.ts$/, ".test.ts");
    const line =
      kind === 0
        ? ` ✓ ${p} > ${ident(r)} ${r.pick(["keeps the sign", "rounds half even", "rejects a closed period", "is idempotent"])} ${r.int(1, 90)}ms`
        : kind === 1
          ? `[${r.int(10, 23)}:${r.int(10, 59)}:${r.int(10, 59)}] info ${r.pick(MODULES)}: ${r.pick(NOUNS)} ${r.int(1000, 99999)} ${r.pick(["posted", "queued", "settled", "skipped"])} in ${r.int(2, 400)}ms`
          : kind === 2
            ? `${r.int(1, 400)}:${r.int(1, 80)}  ${p.replace(".test", "")}  ${ident(r)}(pool, ${r.pick(NOUNS)}Id)`
            : ` ✓ ${p} (${r.int(3, 40)} tests) ${r.int(20, 900)}ms`;
    lines.push(line);
    chars += line.length + 1;
    i++;
  }
  if (failing) {
    lines.push(
      ` ✗ ${filePath(r).replace(/\.ts$/, ".test.ts")} > ${ident(r)} rounds half even`,
      `   AssertionError: expected 1050 to be 1049`,
      ` Test Files  1 failed | ${r.int(20, 60)} passed`,
    );
  } else {
    lines.push(` Test Files  ${r.int(20, 60)} passed`, ` Tests  ${r.int(200, 900)} passed`);
  }
  return lines.join("\n");
}

/** A line inserted at a random line of a text. */
function insertLine(r: Rand, text: string, line: string): string {
  const lines = text.split("\n");
  lines.splice(r.int(1, Math.max(1, lines.length - 1)), 0, line);
  return lines.join("\n");
}

const TASKS = [
  "The nightly reconcile job double-counts reversed postings. Find out why and fix it.",
  "Add an index for the ledger entry lookups by account and period; the dashboard query is slow.",
  "Refactor the payout mapper so currency conversion happens in one place.",
  "Write regression tests for the half-even rounding in invoices.",
  "The webhook worker retries forever on a 410. Make it stop after a gone response.",
  "Split the fx rate loader so rates are cached per day instead of per request.",
  "The audit export drops rows whose memo has a newline. Fix the CSV quoting.",
  "Make the billing period close idempotent: a second close must be a no-op.",
  "Move the transfer validation rules out of the controller into the rules module.",
  "Investigate the flaky snapshot test in exports and make it deterministic.",
  "Add a dry-run flag to the balance backfill script.",
  "The journal cursor skips entries created in the same millisecond. Fix the ordering.",
];

const CORRECTIONS = [
  "No, that's not what I meant. Keep the old function signature and adapt the callers instead.",
  "Wait, don't change the public API of the service. Put the change behind the existing helper.",
  "That fix is too broad. Revert the change in the mapper and only touch the worker.",
  "No: we use pnpm here, never npm. Rerun the tests with pnpm.",
];

const FOLLOWUPS = [
  "Good. Now run the full test suite and tell me what fails.",
  "Looks right. Also check the other callers of that function.",
  "Fine. Clean up the leftovers and summarize the change.",
  "OK, next part: update the docs comment and run the linter.",
];

/** One planted fact: who carries it and the text. */
interface Fact {
  code: string;
  carrier: "user" | "assistant" | "tool";
  text: string;
}

function headFacts(seed: number): Fact[] {
  const c = (n: number) => `ZQ-${seed}-H${n}`;
  return [
    {
      code: c(1),
      carrier: "user",
      text: `Hard rule for this whole job: ${CONSTRAINT_TEXT} (reference ${c(1)}). Do not read, list or edit anything under it.`,
    },
    {
      code: c(2),
      carrier: "user",
      text: `When you open the PR, put the ticket ${c(2)} in its title.`,
    },
    { code: c(3), carrier: "tool", text: `ledger_export_v2: { key: ${c(3)}, owner: payments }` },
    {
      code: c(4),
      carrier: "user",
      text: `No, the staging database is ${c(4)}, not the one in the README. Use that one from now on.`,
    },
    {
      code: c(5),
      carrier: "assistant",
      text: `Decision: I'll name the new migration ${c(5)}_add_entry_index.sql so it sorts after the existing ones.`,
    },
    {
      code: c(6),
      carrier: "tool",
      text: `Build artifact: ${c(6)} (uploaded to the release bucket)`,
    },
    {
      code: c(7),
      carrier: "user",
      text: `The customer who reported the rounding bug is account ${c(7)}; use it in the regression test name.`,
    },
    { code: c(8), carrier: "tool", text: `Error: advisory lock held by worker ${c(8)}` },
  ];
}

function tailFacts(seed: number): Fact[] {
  const c = (n: number) => `ZQ-${seed}-T${n}`;
  return [
    { code: c(1), carrier: "tool", text: `Coverage report uploaded as ${c(1)}` },
    { code: c(2), carrier: "user", text: `Also add ${c(2)} as the on-call reviewer on the PR.` },
    {
      code: c(3),
      carrier: "assistant",
      text: `I've named the backfill job ${c(3)} so it is easy to find in the queue.`,
    },
    {
      code: c(4),
      carrier: "user",
      text: `Last thing: the changelog entry must mention ${c(4)}.`,
    },
  ];
}

/** Builds a log as the runtime records it: each `model_call` carries what was sent. */
class Recorder {
  readonly events: CaseSnapshot["events"] = [];
  private runN = 0;
  runId = "";

  add(type: string, payload: unknown, runId: string | null = this.runId): number {
    const seq = (this.events.at(-1)?.seq ?? 0) + 1;
    this.events.push({ seq, type, payload, runId, createdAt: AT } as CaseSnapshot["events"][0]);
    return seq;
  }

  user(text: string, extra: Record<string, unknown> = {}): number {
    return this.add(
      "user_message",
      { content: [{ type: "text", text }], authorAccountId: "acc-1", ...extra },
      null,
    );
  }

  started(trigger: "message" | "schedule"): void {
    this.runN++;
    this.runId = `00000000-0000-4000-8000-${String(this.runN).padStart(12, "0")}`;
    this.add("run_started", {
      agentVersion: 1,
      model: { provider: "eval", model: EVAL_MODEL.id },
      triggerAccountId: "acc-1",
      trigger,
    });
  }

  call(step: number): void {
    const events = toEvents(this.snapshot());
    const absorbed = Math.max(
      0,
      ...events.filter((e) => e.type === "user_message").map((e) => e.seq),
    );
    const { request, meta } = assembleModelRequest({
      events,
      agent: AGENT,
      agentVersion: 1,
      model: EVAL_MODEL,
      step,
      absorbedUpToSeq: absorbed,
      params: {},
      tools: TOOLS,
      toolSearch: false,
      defaultMaxOutputTokens: STEP_MAX_OUTPUT,
    });
    this.add("model_call", {
      step,
      attempt: 1,
      provider: "eval",
      model: EVAL_MODEL.id,
      fallback: false,
      request: { ...meta, maxOutputTokens: request.maxOutputTokens },
    });
  }

  usage(step: number): void {
    this.add("usage", {
      step,
      provider: "eval",
      model: EVAL_MODEL.id,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }

  finished(): void {
    this.add("run_finished", {
      reason: "completed",
      consumedUpToSeq: this.events.at(-1)?.seq ?? 0,
    });
  }

  snapshot(): CaseSnapshot {
    return {
      version: 1,
      orgId: ORG,
      conversationId: CONV,
      runId: this.runId,
      agentId: ORG,
      agentVersion: 1,
      source: "web",
      events: structuredClone(this.events),
      definitions: { "1": AGENT },
      toolSpecs: Object.fromEntries(TOOLS.map((t) => [t.specHash, t.spec])),
    };
  }
}

/** What one turn plants: facts in its user message, its tool results, its assistant text. */
interface TurnPlan {
  user: Fact[];
  tool: Fact[];
  assistant: Fact[];
}

export interface EvalFixture {
  seed: number;
  snapshot: CaseSnapshot;
  events: ConversationEvent[];
  absorbedUpToSeq: number;
  /** The plan's boundary: the first kept user message (the 4th-last). */
  firstKeptSeq: number;
  /** Seq of every planted codeword's event. */
  codeSeqs: Record<string, number>;
  headCodes: string[];
  tailCodes: string[];
  /** Shape notes for the report: a sender line or a scheduled header on the kept message. */
  keptShape: "plain" | "sender" | "schedule";
}

/** One conversation for `seed` (60–150k estimated tokens, 10–16 turns). */
export function evalFixture(seed: number): EvalFixture {
  const r = new Rand(rng(seed));
  const turns = r.int(10, 16);
  const headTurns = turns - 4;
  const group = seed % 3 === 0;
  const scheduledKept = seed % 5 === 0;
  const keptShape: EvalFixture["keptShape"] = scheduledKept
    ? "schedule"
    : group
      ? "sender"
      : "plain";

  const plans: TurnPlan[] = Array.from({ length: turns }, () => ({
    user: [],
    tool: [],
    assistant: [],
  }));
  const head = headFacts(seed);
  const place = (f: Fact, turn: number) => {
    const p = plans[turn] as TurnPlan;
    p[f.carrier].push(f);
  };
  place(head[0] as Fact, r.int(0, 1));
  for (const f of head.slice(1)) place(f, r.int(0, headTurns - 1));
  // tail turn 1 (the first kept message) carries no fact in its user message
  for (const [i, f] of tailFacts(seed).entries()) place(f, headTurns + i);

  // the target size, spread over the tool results (tail results are half size)
  const target = r.int(66_000, 138_000);
  const steps = plans.map(() => r.int(2, 5));
  const weights = steps.map((s, i) => s * (i >= headTurns ? 0.5 : 1));
  const perUnit = (target - 4000) / weights.reduce((a, b) => a + b, 0);

  const rec = new Recorder();
  const codeSeqs: Record<string, number> = {};
  const senders = [
    { name: "Grant", role: "owner" },
    { name: "Ada", role: "member" },
  ];
  let firstKeptSeq = 0;
  let task = 0;
  for (let t = 0; t < turns; t++) {
    const plan = plans[t] as TurnPlan;
    const isKept = t === headTurns;
    // the first kept message opens a new piece of work, so its start names it unambiguously
    const opener =
      t === 0
        ? (TASKS[seed % TASKS.length] as string)
        : isKept
          ? `New piece of work: ${TASKS[(seed + 5) % TASKS.length]}`
          : r.chance(0.3)
            ? r.pick(CORRECTIONS)
            : r.chance(0.5)
              ? r.pick(FOLLOWUPS)
              : (TASKS[(seed + ++task) % TASKS.length] as string);
    const text = [opener, ...plan.user.map((f) => f.text)].join(" ");
    const extra: Record<string, unknown> = {};
    if (group) extra.sender = senders[t % 2];
    if (isKept && scheduledKept) {
      extra.schedule = {
        taskId: "task-1",
        taskRunId: `task-run-${seed}`,
        scheduledFor: AT,
        trial: false,
        taskName: "Nightly ledger check",
        localTime: "2026-11-28 02:00",
      };
    }
    const userSeq = rec.user(text, extra);
    if (isKept) firstKeptSeq = userSeq;
    for (const f of plan.user) codeSeqs[f.code] = userSeq;
    rec.started(isKept && scheduledKept ? "schedule" : "message");

    const n = steps[t] as number;
    const toolFacts = [...plan.tool];
    for (let s = 1; s <= n; s++) {
      rec.call(s);
      const key = r.pick(["Read", "Bash", "Bash", "Read", "Grep", "Edit"]);
      const path = filePath(r);
      const command = r.pick([
        "pnpm test",
        `pnpm exec vitest run ${path.replace(/\.ts$/, ".test.ts")}`,
        "pnpm lint",
        "git log --oneline -20",
        "pnpm typecheck",
      ]);
      const input =
        key === "Read"
          ? { path }
          : key === "Bash"
            ? { command }
            : key === "Grep"
              ? { pattern: ident(r), path: "src" }
              : {
                  path,
                  old_string: "round(amount, 2)",
                  new_string: "round(amount, 2, 'half-even')",
                };
      const id = `call-${t}-${s}`;
      rec.add("assistant_message", {
        step: s,
        content: [
          {
            type: "text",
            text: r.pick([
              "Let me look at the code first.",
              "I'll run the tests to see where it stands.",
              "Checking the callers.",
              "Applying the change.",
            ]),
          },
          { type: "tool_call", id, name: key, input },
        ],
        stopReason: "tool_use",
      });
      rec.usage(s);
      const tokens = Math.round(perUnit * (t >= headTurns ? 0.5 : 1) * (0.5 + r.next()));
      const failing = key === "Bash" && r.chance(0.2);
      let content =
        key === "Read" || key === "Edit"
          ? key === "Edit"
            ? `Edited ${path}: 1 replacement.\n${sourceText(r, path, Math.min(tokens, 600))}`
            : sourceText(r, path, tokens)
          : key === "Grep"
            ? commandText(
                r,
                `grep -rn ${String((input as { pattern: string }).pattern)} src`,
                tokens,
                false,
              )
            : commandText(r, command, tokens, failing);
      // one fact a result; the last step takes whatever is left
      const facts = s === n ? toolFacts.splice(0) : toolFacts.splice(0, 1);
      for (const f of facts) content = insertLine(r, content, f.text);
      const isError = facts.some((f) => f.code.endsWith("-H8")) || failing;
      const resultSeq = rec.add("tool_result", {
        step: s,
        callId: id,
        toolKey: key,
        content,
        isError,
      });
      for (const f of facts) codeSeqs[f.code] = resultSeq;
    }
    rec.call(n + 1);
    const closing = r.pick([
      "Done. The tests pass and the change is limited to the files above.",
      "The change is in place; one test was flaky and passed on rerun.",
      "I've made the edit and rerun the suite: all green.",
      "Fixed. I kept the public API unchanged as you asked.",
    ]);
    const finalText = [...plan.assistant.map((f) => f.text), closing].join(" ");
    const finalSeq = rec.add("assistant_message", {
      step: n + 1,
      content: [{ type: "text", text: finalText }],
      stopReason: "end_turn",
    });
    for (const f of plan.assistant) codeSeqs[f.code] = finalSeq;
    rec.usage(n + 1);
    rec.finished();
  }

  const snapshot = rec.snapshot();
  const events = toEvents(snapshot);
  const absorbedUpToSeq = Math.max(
    ...events.filter((e) => e.type === "user_message").map((e) => e.seq),
  );
  return {
    seed,
    snapshot,
    events,
    absorbedUpToSeq,
    firstKeptSeq,
    codeSeqs,
    headCodes: head.map((f) => f.code),
    tailCodes: tailFacts(seed).map((f) => f.code),
    keptShape,
  };
}

/**
 * The plan's boundary for a fixture (`compactionPlan` with `keepRecentTurns: 4` and the tail
 * budget model-call.ts gives it: `W - O_p - R_p` minus the system prompt and tool definitions).
 * `keepRecentTurns: 0` gives the plan of the "all" boundary: every event, no kept tail.
 */
export function evalPlan(
  f: EvalFixture,
  keepRecentTurns: number = EVAL_SETTINGS.keepRecentTurns,
): { coversUpToSeq: number; transcript: string } | null {
  const built = assembleModelRequest({
    events: f.events,
    agent: AGENT,
    agentVersion: 1,
    model: EVAL_MODEL,
    step: 1,
    absorbedUpToSeq: f.absorbedUpToSeq,
    params: {},
    tools: TOOLS,
    toolSearch: false,
    defaultMaxOutputTokens: STEP_MAX_OUTPUT,
  }).request;
  const bounds = planningBounds(
    EVAL_MODEL.contextWindow,
    built.maxOutputTokens,
    EVAL_SETTINGS.reserveTokens,
  );
  const budget = bounds.target - estimateTokens([], built.system, built.tools);
  return compactionPlan(f.events, { ...EVAL_SETTINGS, keepRecentTurns }, budget);
}
