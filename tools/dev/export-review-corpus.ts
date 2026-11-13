/**
 * Exports every `Bash` call from a development kernel's event log, one JSON object per line:
 * `{ command, cwd, mode, attended }`. The corpus files under
 * `packages/kernel/test/sandbox/review/corpus/` are this output, hand-labelled with the decision
 * and rule ids in a review pass (auto-mode spec §5.2, §10).
 *
 *   tsx tools/dev/export-review-corpus.ts [--since 2026-11-12] [--until 2026-11-14] \
 *     [--out corpus.jsonl] [--mode auto|sandbox] [--cwd /workspace]
 *
 * The database URL comes from `CAPYBARA_DB__URL` (see docs/development.md) and is never printed;
 * command text is redacted for token-shaped strings before it is written. The events do not record
 * the device's working directory or mode, so `--cwd` (default `/workspace`, the sandbox root) and
 * `--mode` (default `auto`, the new default) are supplied here; `attended` is derived from the run
 * (a run a person started on their own conversation).
 */
import { writeFileSync } from "node:fs";
import pg from "pg";

interface Row {
  command: string;
  owner_account_id: string;
  trigger_account_id: string | null;
  scheduled_task_run_id: string | null;
}

interface Args {
  since: string | null;
  until: string | null;
  out: string | null;
  mode: "auto" | "sandbox";
  cwd: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { since: null, until: null, out: null, mode: "auto", cwd: "/workspace" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--since" && value !== undefined) {
      args.since = value;
      i += 1;
    } else if (flag === "--until" && value !== undefined) {
      args.until = value;
      i += 1;
    } else if (flag === "--out" && value !== undefined) {
      args.out = value;
      i += 1;
    } else if (flag === "--cwd" && value !== undefined) {
      args.cwd = value;
      i += 1;
    } else if (flag === "--mode" && (value === "auto" || value === "sandbox")) {
      args.mode = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/** Token-shaped strings the agent may have pasted into a command; the corpus never keeps them. */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ghp_[A-Za-z0-9]{20,}/g, "ghp_***"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
  [/gh[ousr]_[A-Za-z0-9]{20,}/g, "gh_***"],
  [/sk-[A-Za-z0-9]{20,}/g, "sk-***"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox-***"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA***"],
  [/(Bearer\s+)[A-Za-z0-9._-]{20,}/gi, "$1***"],
  [/((?:--?|\b)(?:password|passwd|token|secret|api[-_]?key)[= ])\S+/gi, "$1***"],
  [/(postgres(?:ql)?:\/\/)\S+/g, "$1***"],
];

function redact(command: string): string {
  let out = command;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

function sanitizeError(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/g, "postgres://***");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.CAPYBARA_DB__URL;
  if (url === undefined || url.length === 0) {
    throw new Error("CAPYBARA_DB__URL is not set (see docs/development.md)");
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const sql = `
      SELECT
        block->'input'->>'command' AS command,
        c.account_id AS owner_account_id,
        r.trigger_account_id AS trigger_account_id,
        r.scheduled_task_run_id AS scheduled_task_run_id
      FROM capybara.conversation_events e
      JOIN capybara.conversations c ON c.id = e.conversation_id
      LEFT JOIN capybara.runs r ON r.id = e.run_id
      CROSS JOIN LATERAL jsonb_array_elements(e.payload->'content') AS block
      WHERE e.type = 'assistant_message'
        AND block->>'type' = 'tool_call'
        AND block->>'name' = 'Bash'
        AND ($1::timestamptz IS NULL OR e.created_at >= $1::timestamptz)
        AND ($2::timestamptz IS NULL OR e.created_at < $2::timestamptz)
      ORDER BY e.created_at, e.seq
    `;
    const result = await client.query<Row>(sql, [args.since, args.until]);
    const lines: string[] = [];
    for (const row of result.rows) {
      if (typeof row.command !== "string" || row.command.length === 0) continue;
      // A run a person started on their own conversation is attended; a scheduled task run (or one
      // inherited from it) is not.
      const attended =
        row.scheduled_task_run_id === null &&
        (row.trigger_account_id === null || row.trigger_account_id === row.owner_account_id);
      lines.push(
        JSON.stringify({
          command: redact(row.command),
          cwd: args.cwd,
          mode: args.mode,
          attended,
        }),
      );
    }
    const text = `${lines.join("\n")}\n`;
    if (args.out === null) process.stdout.write(text);
    else writeFileSync(args.out, text);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`export-review-corpus: ${sanitizeError(message)}\n`);
  process.exitCode = 1;
});
