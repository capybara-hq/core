/**
 * The RLS cost measurement of the Postgres RLS spec §8 (docs/superpowers/specs/
 * 2026-11-23-postgres-rls-design.md): run it against a running kernel once per `db.rls` value
 * (`off`, `scoped`, `enforce`) on the same commit and compare the JSON it prints.
 *
 *   KERNEL_URL=http://127.0.0.1:8080 TOKEN=cap_pat_... ORG_ID=... CONVERSATION_ID=... \
 *   DATABASE_URL=postgres://... tsx tools/dev/rls-measure.ts \
 *     [--vus 50] [--seconds 300] [--turns 20] [--label scoped]
 *
 * - statements per flow: with `pg_stat_statements` installed on the server, the statement count
 *   of one pass of each flow (`pg_stat_statements_reset()` first: use a database of its own);
 * - latency: `--vus` concurrent loops over the HTTP flows for `--seconds`, p50 / p95 / p99 per flow;
 * - a run turn: `--turns` sequential user messages to `CONVERSATION_ID` (an agent whose model and
 *   tools are deterministic, e.g. model-fake with a script of three tool calls), wall time from the
 *   post to the run's terminal event, read from the database;
 * - database CPU: the 20 statements with the most `total_exec_time` after the run.
 *
 * `TOKEN` is a personal access token of a member of `ORG_ID`. Nothing is written except the turns'
 * messages. The bar for enforcing (§10): p95 of each HTTP flow +5 %, a run turn +3 %, database CPU
 * +10 %, each against `off`.
 */
import { parseArgs } from "node:util";
import pg from "pg";

const { values: args } = parseArgs({
  options: {
    vus: { type: "string", default: "50" },
    seconds: { type: "string", default: "300" },
    turns: { type: "string", default: "20" },
    label: { type: "string", default: "" },
  },
});

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

const base = env("KERNEL_URL").replace(/\/$/, "");
const token = env("TOKEN");
const org = env("ORG_ID");
const conversation = env("CONVERSATION_ID");
const db = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 2 });

/** The HTTP flows of §8 (a sweep is measured through pg_stat_statements on its own). */
const FLOWS: Record<string, string[]> = {
  "workspace home": [
    "/api/v1/me",
    `/api/v1/orgs/${org}/agents`,
    `/api/v1/orgs/${org}/conversations?limit=50`,
  ],
  "open a conversation": [
    `/api/v1/orgs/${org}/conversations/${conversation}`,
    `/api/v1/orgs/${org}/conversations/${conversation}/events?limit=200`,
  ],
};

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${res.status}`);
  return res;
}

async function runFlow(paths: string[]): Promise<void> {
  for (const p of paths) await call(p);
}

async function statementsPerFlow(): Promise<Record<string, number> | string> {
  try {
    await db.query("select pg_stat_statements_reset()");
  } catch {
    return "pg_stat_statements is not installed";
  }
  const out: Record<string, number> = {};
  for (const [name, paths] of Object.entries(FLOWS)) {
    await db.query("select pg_stat_statements_reset()");
    await runFlow(paths);
    const r = await db.query<{ n: string }>(
      "select coalesce(sum(calls), 0) as n from pg_stat_statements where query not like '%pg_stat_statements%'",
    );
    out[name] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

function percentiles(ms: number[]): { n: number; p50: number; p95: number; p99: number } {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

async function latency(vus: number, seconds: number) {
  const samples: Record<string, number[]> = Object.fromEntries(
    Object.keys(FLOWS).map((k) => [k, []]),
  );
  const end = performance.now() + seconds * 1000;
  const names = Object.keys(FLOWS);
  await Promise.all(
    Array.from({ length: vus }, async (_, v) => {
      for (let i = v; performance.now() < end; i++) {
        const name = names[i % names.length] as string;
        const t = performance.now();
        await runFlow(FLOWS[name] as string[]);
        samples[name]?.push(performance.now() - t);
      }
    }),
  );
  return Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, percentiles(v)]));
}

async function terminalCount(): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select count(*) as n from capybara.conversation_events where conversation_id = $1
       and type in ('run_finished', 'run_failed', 'run_aborted')`,
    [conversation],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function turns(n: number) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const before = await terminalCount();
    const t = performance.now();
    await call(`/api/v1/orgs/${org}/conversations/${conversation}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: `rls measurement turn ${i}` }),
    });
    const deadline = t + 120_000;
    while ((await terminalCount()) <= before) {
      if (performance.now() > deadline) throw new Error(`turn ${i} did not finish in 120 s`);
      await new Promise((r) => setTimeout(r, 20));
    }
    ms.push(performance.now() - t);
  }
  return percentiles(ms);
}

async function topStatements() {
  try {
    const r = await db.query<{ query: string; calls: string; total_ms: string }>(
      `select left(query, 160) as query, calls, round(total_exec_time::numeric, 1) as total_ms
         from pg_stat_statements order by total_exec_time desc limit 20`,
    );
    return r.rows;
  } catch {
    return "pg_stat_statements is not installed";
  }
}

try {
  const vus = Number(args.vus);
  const seconds = Number(args.seconds);
  const statements = await statementsPerFlow();
  await db.query("select pg_stat_statements_reset()").catch(() => {});
  const http = await latency(vus, seconds);
  const turn = Number(args.turns) > 0 ? await turns(Number(args.turns)) : "skipped";
  const top = await topStatements();
  console.log(
    JSON.stringify(
      {
        label: args.label,
        statements,
        http,
        turn,
        top,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
