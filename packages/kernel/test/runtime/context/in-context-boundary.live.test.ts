import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock, ModelRequest } from "@capybara-hq/plugin-sdk";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildCompactionRequest,
  COMPACTION_MAX_OUTPUT_TOKENS,
  extractSummary,
} from "../../../src/runtime/context/compaction.js";
import { buildInContextCompactionRequest } from "../../../src/runtime/context/in-context-compaction.js";
import {
  CONSTRAINT_TEXT,
  EVAL_MODEL,
  EVAL_SEEDS,
  EVAL_SETTINGS,
  type EvalFixture,
  evalFixture,
  evalPlan,
} from "./in-context-eval-fixtures.js";

/**
 * The Q9 eval (idle compaction spec §9.4, §12 Q9): can the in-context summary be held to a marked
 * boundary and keep a verbatim tail? 20 seeded long conversations (in-context-eval-fixtures.ts) are
 * sent to every configured vendor twice: the in-context request with a marked boundary at the
 * plan's own boundary (`keepRecentTurns: 4`), and the transcript request over the plan's transcript
 * (the baseline). Metrics per model: tail leakage (share of conversations whose `<summary>` holds
 * any tail codeword), head recall (share of head codewords present), constraint kept (share keeping
 * "never touch `secrets/`" verbatim, case-insensitive). The test prints only the metric table and
 * codeword ids, never a summary or a key.
 *
 * The fixture block always runs. The live block is skipped unless `CAPYBARA_TEST_COMPACTION_EVAL=1`;
 * keys stay in `~/.capybara-test.env` and are loaded only in the test command:
 *
 *   set -a; . ~/.capybara-test.env; set +a
 *   CAPYBARA_TEST_COMPACTION_EVAL=1 pnpm exec vitest run \
 *     packages/kernel/test/runtime/context/in-context-boundary.live.test.ts
 *
 * Vendors (each runs when its variables are set): Anthropic `CAPYBARA_TEST_ANTHROPIC_API_KEY`,
 * `CAPYBARA_TEST_ANTHROPIC_MODEL` (default `claude-haiku-5-5`); OpenAI `CAPYBARA_TEST_OPENAI_API_KEY`,
 * `CAPYBARA_TEST_OPENAI_MODEL`; an OpenAI-compatible endpoint `CAPYBARA_TEST_OAICOMPAT_BASE_URL`
 * (with its `/v1`), `_API_KEY`, `_MODEL`, `_DIALECT` (DeepSeek); Qwen through DashScope's
 * OpenAI-compatible mode `CAPYBARA_TEST_BAILIAN_API_KEY`, `CAPYBARA_TEST_BAILIAN_REGION`,
 * `CAPYBARA_TEST_BAILIAN_MODEL` (default `qwen3.8-flash`). `CAPYBARA_TEST_COMPACTION_EVAL_DUMP=<dir>`
 * writes the summaries to that local directory for inspection. A transient network error is rerun
 * once (per case) before it is a bug.
 */

const env = process.env;
const LIVE = env.CAPYBARA_TEST_COMPACTION_EVAL === "1";
const SUMMARY_CAP = COMPACTION_MAX_OUTPUT_TOKENS;
/** `CAPYBARA_TEST_COMPACTION_EVAL_SEEDS=1,2` limits a smoke run; the rule decides only on all 20. */
const LIVE_SEEDS: readonly number[] =
  env.CAPYBARA_TEST_COMPACTION_EVAL_SEEDS?.split(",").map(Number) ?? EVAL_SEEDS;

const fixtures = new Map<number, EvalFixture>();
function fixture(seed: number): EvalFixture {
  let f = fixtures.get(seed);
  if (f === undefined) {
    f = evalFixture(seed);
    fixtures.set(seed, f);
  }
  return f;
}

/** The two request forms of a fixture: the in-context (marked) one and the transcript baseline. */
function requests(f: EvalFixture): { inContext: ModelRequest; transcript: ModelRequest } {
  const plan = evalPlan(f);
  if (plan === null) throw new Error(`seed ${f.seed}: no plan`);
  const out = buildInContextCompactionRequest({
    snapshot: f.snapshot,
    events: f.events,
    absorbedUpToSeq: f.absorbedUpToSeq,
    model: EVAL_MODEL,
    reserveTokens: EVAL_SETTINGS.reserveTokens,
    summaryCap: SUMMARY_CAP,
    boundary: { mode: "marked", firstKeptSeq: f.firstKeptSeq },
    retry: false,
  });
  if ("skip" in out) throw new Error(`seed ${f.seed}: in-context request skipped: ${out.skip}`);
  return {
    inContext: out.request,
    transcript: buildCompactionRequest(plan.transcript, EVAL_MODEL.id, SUMMARY_CAP),
  };
}

function estimateOf(f: EvalFixture): number {
  const out = buildInContextCompactionRequest({
    snapshot: f.snapshot,
    events: f.events,
    absorbedUpToSeq: f.absorbedUpToSeq,
    model: EVAL_MODEL,
    reserveTokens: EVAL_SETTINGS.reserveTokens,
    summaryCap: SUMMARY_CAP,
    boundary: { mode: "marked", firstKeptSeq: f.firstKeptSeq },
    retry: false,
  });
  return "skip" in out ? 0 : out.estimate;
}

describe("in-context boundary eval fixtures", () => {
  it("plants every codeword on its side of the plan's boundary and builds every request", () => {
    for (const seed of EVAL_SEEDS) {
      const f = fixture(seed);
      const plan = evalPlan(f);
      expect(plan, `seed ${seed}`).not.toBeNull();
      const covers = plan?.coversUpToSeq ?? 0;
      const firstKept = f.events.find((e) => e.type === "user_message" && e.seq > covers);
      expect(firstKept?.seq, `seed ${seed}: boundary`).toBe(f.firstKeptSeq);
      expect(Object.keys(f.codeSeqs).sort()).toEqual([...f.headCodes, ...f.tailCodes].sort());
      for (const code of f.headCodes) expect(f.codeSeqs[code], code).toBeLessThanOrEqual(covers);
      for (const code of f.tailCodes) expect(f.codeSeqs[code], code).toBeGreaterThan(covers);
      for (const code of f.headCodes) expect(plan?.transcript).toContain(code);
      for (const code of f.tailCodes) expect(plan?.transcript).not.toContain(code);

      const out = buildInContextCompactionRequest({
        snapshot: f.snapshot,
        events: f.events,
        absorbedUpToSeq: f.absorbedUpToSeq,
        model: EVAL_MODEL,
        reserveTokens: EVAL_SETTINGS.reserveTokens,
        summaryCap: SUMMARY_CAP,
        boundary: { mode: "marked", firstKeptSeq: f.firstKeptSeq },
        retry: false,
      });
      if ("skip" in out) throw new Error(`seed ${seed}: skipped: ${out.skip}`);
      expect(out.estimate, `seed ${seed}: size`).toBeGreaterThanOrEqual(60_000);
      expect(out.estimate, `seed ${seed}: size`).toBeLessThanOrEqual(150_000);
      // the instruction (the anchor quote included) names no codeword
      const last = out.request.messages.at(-1);
      const instruction = last?.role === "user" ? last.content.at(-1) : undefined;
      expect(instruction?.type === "text" && /ZQ-/.test(instruction.text)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- live part

interface Answer {
  text: string;
  stop: string;
  toolCall: boolean;
  inputTokens: number;
  outputTokens: number;
}

interface Vendor {
  label: string;
  send(req: ModelRequest, signal: AbortSignal): Promise<Answer>;
}

const textOf = (blocks: ContentBlock[]): string =>
  blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`model endpoint answered ${res.status}: ${text.slice(0, 300)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Anthropic Messages: tool results first in a user turn, consecutive same-role turns merged. */
function anthropicVendor(key: string, model: string): Vendor {
  return {
    label: `anthropic ${model}`,
    async send(req, signal) {
      const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
      const push = (role: "user" | "assistant", content: unknown[]) => {
        if (content.length === 0) return;
        const last = messages.at(-1);
        if (last?.role === role) last.content.push(...content);
        else messages.push({ role, content });
      };
      for (const m of req.messages) {
        if (m.role === "system") {
          push("user", [{ type: "text", text: `[system] ${m.content}` }]);
        } else if (m.role === "assistant") {
          push(
            "assistant",
            m.content.flatMap((b): unknown[] =>
              b.type === "text" && b.text !== ""
                ? [{ type: "text", text: b.text }]
                : b.type === "tool_call"
                  ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input }]
                  : [],
            ),
          );
        } else {
          const results = m.content.flatMap((b) =>
            b.type === "tool_result"
              ? [
                  {
                    type: "tool_result",
                    tool_use_id: b.callId,
                    content: b.content,
                    is_error: b.isError,
                  },
                ]
              : [],
          );
          const texts = m.content.flatMap((b) =>
            b.type === "text" && b.text !== "" ? [{ type: "text", text: b.text }] : [],
          );
          push("user", [...results, ...texts]);
        }
      }
      const body = await post(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: req.maxOutputTokens,
          system: req.system.map((s) => s.text).join("\n\n"),
          messages,
          ...(req.tools.length > 0 && {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
            tool_choice: { type: req.toolChoice === "none" ? "none" : "auto" },
          }),
        },
        signal,
      );
      const content = (body.content ?? []) as { type: string; text?: string }[];
      const usage = (body.usage ?? {}) as Record<string, number>;
      return {
        text: content
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        stop: String(body.stop_reason),
        toolCall: content.some((b) => b.type === "tool_use"),
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      };
    },
  };
}

/** OpenAI Chat Completions (OpenAI, DeepSeek, DashScope compatible mode). */
function chatVendor(opts: {
  label: string;
  base: string;
  key: string;
  model: string;
  maxField: "max_tokens" | "max_completion_tokens";
  extra?: Record<string, unknown>;
}): Vendor {
  return {
    label: opts.label,
    async send(req, signal) {
      const messages: Record<string, unknown>[] = [
        { role: "system", content: req.system.map((s) => s.text).join("\n\n") },
      ];
      for (const m of req.messages) {
        if (m.role === "system") {
          messages.push({ role: "system", content: m.content });
        } else if (m.role === "assistant") {
          const calls = m.content.flatMap((b) =>
            b.type === "tool_call"
              ? [
                  {
                    id: b.id,
                    type: "function",
                    function: { name: b.name, arguments: JSON.stringify(b.input) },
                  },
                ]
              : [],
          );
          messages.push({
            role: "assistant",
            content: textOf(m.content),
            ...(calls.length > 0 && { tool_calls: calls }),
          });
        } else {
          for (const b of m.content) {
            if (b.type === "tool_result")
              messages.push({ role: "tool", tool_call_id: b.callId, content: b.content });
          }
          const text = textOf(m.content);
          if (text !== "") messages.push({ role: "user", content: text });
        }
      }
      const body = await post(
        `${opts.base}/chat/completions`,
        { authorization: `Bearer ${opts.key}` },
        {
          model: opts.model,
          messages,
          [opts.maxField]: req.maxOutputTokens,
          ...(req.tools.length > 0 && {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: req.toolChoice ?? "auto",
          }),
          ...opts.extra,
        },
        signal,
      );
      const choice = ((body.choices ?? []) as Record<string, unknown>[])[0] ?? {};
      const message = (choice.message ?? {}) as { content?: string; tool_calls?: unknown[] };
      const usage = (body.usage ?? {}) as Record<string, number>;
      return {
        text: message.content ?? "",
        stop: String(choice.finish_reason),
        toolCall: (message.tool_calls?.length ?? 0) > 0,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      };
    },
  };
}

function vendors(): Vendor[] {
  const out: Vendor[] = [];
  if (env.CAPYBARA_TEST_ANTHROPIC_API_KEY) {
    out.push(
      anthropicVendor(
        env.CAPYBARA_TEST_ANTHROPIC_API_KEY,
        env.CAPYBARA_TEST_ANTHROPIC_MODEL ?? "claude-haiku-5-5",
      ),
    );
  }
  if (env.CAPYBARA_TEST_OPENAI_API_KEY && env.CAPYBARA_TEST_OPENAI_MODEL) {
    out.push(
      chatVendor({
        label: `openai ${env.CAPYBARA_TEST_OPENAI_MODEL}`,
        base: "https://api.openai.com/v1",
        key: env.CAPYBARA_TEST_OPENAI_API_KEY,
        model: env.CAPYBARA_TEST_OPENAI_MODEL,
        maxField: "max_completion_tokens",
      }),
    );
  }
  const oai = {
    base: env.CAPYBARA_TEST_OAICOMPAT_BASE_URL,
    key: env.CAPYBARA_TEST_OAICOMPAT_API_KEY,
    model: env.CAPYBARA_TEST_OAICOMPAT_MODEL,
  };
  if (oai.base && oai.key && oai.model) {
    out.push(
      chatVendor({
        label: `${env.CAPYBARA_TEST_OAICOMPAT_DIALECT ?? "oaicompat"} ${oai.model}`,
        base: oai.base,
        key: oai.key,
        model: oai.model,
        maxField: "max_tokens",
      }),
    );
  }
  if (env.CAPYBARA_TEST_BAILIAN_API_KEY) {
    const intl = env.CAPYBARA_TEST_BAILIAN_REGION?.startsWith("ap-") === true;
    const model = env.CAPYBARA_TEST_BAILIAN_MODEL ?? "qwen3.8-flash";
    out.push(
      chatVendor({
        label: `qwen ${model}`,
        base: `https://${intl ? "dashscope-intl" : "dashscope"}.aliyuncs.com/compatible-mode/v1`,
        key: env.CAPYBARA_TEST_BAILIAN_API_KEY,
        model,
        maxField: "max_tokens",
      }),
    );
  }
  return out;
}

const transient = (err: unknown): boolean => {
  const status = (err as { status?: number }).status;
  if (status !== undefined) return status === 429 || status >= 500;
  return err instanceof Error && !/answered/.test(err.message);
};

/** One call; a transient network error is rerun once. */
async function call(v: Vendor, req: ModelRequest): Promise<Answer> {
  try {
    return await v.send(req, AbortSignal.timeout(600_000));
  } catch (err) {
    if (!transient(err)) throw err;
    return v.send(req, AbortSignal.timeout(600_000));
  }
}

interface CaseResult {
  seed: number;
  form: "in_context" | "transcript";
  summary: string;
  stop: string;
  toolCall: boolean;
  tailLeaked: string[];
  headMissing: string[];
  constraintKept: boolean;
  constraintLoose: boolean;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
const loose = (s: string) => norm(s).replace(/[`'"*_]/g, "");

function score(f: EvalFixture, form: CaseResult["form"], a: Answer): CaseResult {
  const summary = a.toolCall ? "" : extractSummary(a.text);
  return {
    seed: f.seed,
    form,
    summary,
    stop: a.stop,
    toolCall: a.toolCall,
    tailLeaked: f.tailCodes.filter((c) => summary.includes(c)),
    headMissing: f.headCodes.filter((c) => !summary.includes(c)),
    constraintKept: norm(summary).includes(norm(CONSTRAINT_TEXT)),
    constraintLoose: loose(summary).includes(loose(CONSTRAINT_TEXT)),
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
  };
}

async function pool<T>(items: readonly T[], width: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
    }),
  );
}

const results = new Map<string, CaseResult[]>();

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

function table(): string[] {
  const lines = [
    "| model | tail leakage (in-ctx) | head recall in-ctx | head recall transcript | constraint in-ctx | constraint transcript | errors / max_tokens / tool calls | in/out tokens |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const verdicts: boolean[] = [];
  const detail: string[] = [];
  for (const [label, rs] of results) {
    const ic = rs.filter((r) => r.form === "in_context" && r.error === undefined);
    const tr = rs.filter((r) => r.form === "transcript" && r.error === undefined);
    const errors = rs.filter((r) => r.error !== undefined).length;
    const leaked = ic.filter((r) => r.tailLeaked.length > 0).length;
    const heads = (xs: CaseResult[]) => xs.reduce((a, r) => a + 8 - r.headMissing.length, 0);
    const icRecall = ic.length === 0 ? 0 : heads(ic) / (8 * ic.length);
    const trRecall = tr.length === 0 ? 0 : heads(tr) / (8 * tr.length);
    const icKept = ic.filter((r) => r.constraintKept).length;
    const trKept = tr.filter((r) => r.constraintKept).length;
    const icLoose = ic.filter((r) => r.constraintLoose).length;
    const trLoose = tr.filter((r) => r.constraintLoose).length;
    const maxTok = rs.filter((r) => /max_tokens|length/.test(r.stop)).length;
    const tools = rs.filter((r) => r.toolCall).length;
    const tokIn = rs.reduce((a, r) => a + r.inputTokens, 0);
    const tokOut = rs.reduce((a, r) => a + r.outputTokens, 0);
    lines.push(
      `| ${label} | ${leaked}/${ic.length} | ${pct(heads(ic), 8 * ic.length)} | ${pct(heads(tr), 8 * tr.length)} | ${icKept}/${ic.length} (loose ${icLoose}) | ${trKept}/${tr.length} (loose ${trLoose}) | ${errors} / ${maxTok} / ${tools} | ${tokIn} / ${tokOut} |`,
    );
    verdicts.push(
      errors === 0 &&
        ic.length === 20 &&
        leaked <= 1 &&
        icRecall >= trRecall - 0.05 &&
        icKept >= 19,
    );
    for (const r of rs) {
      if (r.error !== undefined) detail.push(`${label} seed ${r.seed} ${r.form}: error ${r.error}`);
      else if (r.tailLeaked.length > 0 || r.headMissing.length > 0 || !r.constraintKept)
        detail.push(
          `${label} seed ${r.seed} ${r.form}: leaked [${r.tailLeaked.join(",")}] missing [${r.headMissing.join(",")}] constraint ${r.constraintKept ? "kept" : r.constraintLoose ? "loose" : "lost"} stop ${r.stop}`,
        );
    }
  }
  const tested = results.size;
  const rule =
    LIVE_SEEDS.length !== EVAL_SEEDS.length
      ? "partial run: the rule cannot decide"
      : tested < 2
        ? "fewer than two vendors tested: the rule cannot decide"
        : verdicts.every(Boolean)
          ? '"marked"'
          : '"all"';
  const sizes = EVAL_SEEDS.map((seed) => estimateOf(fixture(seed))).sort((a, b) => a - b);
  const sizeLine = `fixture sizes (estimated tokens of the in-context request): min ${sizes[0]}, median ${sizes[10]}, max ${sizes.at(-1)}`;
  return [
    ...lines,
    "",
    `vendors tested: ${tested}; decision rule: ${rule}`,
    sizeLine,
    "",
    ...detail,
  ];
}

describe.skipIf(!LIVE)("live: the in-context summary boundary", { timeout: 3_600_000 }, () => {
  afterAll(() => {
    if (results.size > 0) process.stdout.write(`${table().join("\n")}\n`);
    const dump = env.CAPYBARA_TEST_COMPACTION_EVAL_DUMP;
    if (dump !== undefined && results.size > 0) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(
        join(dump, "in-context-boundary.json"),
        JSON.stringify(Object.fromEntries(results), null, 2),
      );
    }
  });

  it.concurrent.each(vendors().map((v) => [v.label, v] as const))("%s", async (label, v) => {
    const rs: CaseResult[] = [];
    results.set(label, rs);
    const cases = LIVE_SEEDS.flatMap((seed) =>
      (["in_context", "transcript"] as const).map((form) => ({ seed, form })),
    );
    await pool(cases, 4, async ({ seed, form }) => {
      const f = fixture(seed);
      const req = requests(f);
      try {
        rs.push(
          score(f, form, await call(v, form === "in_context" ? req.inContext : req.transcript)),
        );
      } catch (err) {
        rs.push({
          seed,
          form,
          summary: "",
          stop: "error",
          toolCall: false,
          tailLeaked: [],
          headMissing: f.headCodes,
          constraintKept: false,
          constraintLoose: false,
          inputTokens: 0,
          outputTokens: 0,
          error: String(err instanceof Error ? err.message : err).slice(0, 200),
        });
      }
    });
    rs.sort((a, b) => a.seed - b.seed || a.form.localeCompare(b.form));
    expect(rs).toHaveLength(cases.length);
  });
});
