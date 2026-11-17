import { userInfo } from "node:os";
import {
  type CloudSnapshotRun,
  KernelConfigSchema,
  type KernelLogger,
  type LegacyFreezeResult,
  loadConfig,
  type PermissionCutoverReport,
  permissionCutoverFreeze,
  permissionCutoverReport,
  permissionCutoverSnapshot,
  secretValues,
} from "@capybara-hq/kernel";
import type { CUTOVER_ACTIONS } from "../args.js";

/** The output streams of `permissions cutover` (replaceable in tests). */
export interface PermissionsIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Who published the freeze, as recorded on its row. */
function operator(): string {
  try {
    return `capybara-cli:${userInfo().username}`;
  } catch {
    return "capybara-cli";
  }
}

const iso = (d: Date | string | null): string =>
  d === null ? "never" : (d instanceof Date ? d : new Date(d)).toISOString();

/** How many entries of each list the human-readable output shows (`--json` lists all). */
export const LIST_LIMIT = 20;

/** Appends the first {@link LIST_LIMIT} entries of `items`, then how many more there are. */
function listed<T>(lines: string[], items: readonly T[], render: (item: T) => string): void {
  for (const item of items.slice(0, LIST_LIMIT)) lines.push(`  - ${render(item)}`);
  if (items.length > LIST_LIMIT)
    lines.push(`  ... and ${items.length - LIST_LIMIT} more (--json lists all)`);
}

/** The runbook step the report points at (section 4 of the activation plan). */
function nextStep(r: PermissionCutoverReport): string {
  const ret = r.retirement;
  if (!ret.frozen) {
    const waits: string[] = [];
    if (r.replicas === null) waits.push("confirm no old replica runs (replica presence unknown)");
    else if (r.replicas.some((x) => !x.sameVersion))
      waits.push("check the replicas on a different build (old ones must be stopped)");
    if (ret.unfencedWriters.recent > 0)
      waits.push("an old replica wrote unmarked legacy rows in the last 15 minutes: stop it");
    if (ret.localWithoutBoot.length > 0)
      waits.push(
        "wait for the local devices to report a boot identity (or accept replace_required)",
      );
    if (ret.cloudUnknown.length > 0)
      waits.push("review the cloud devices with unknown incarnations");
    return waits.length > 0
      ? `${waits.join("; ")}; then run capybara permissions cutover freeze`
      : "run capybara permissions cutover freeze";
  }
  if (ret.freezeEnumeratedAt === null)
    return "the freeze's enumeration never completed: run capybara permissions cutover freeze again";
  if (ret.unfencedWriters.afterEnumeration > 0)
    return "an old, unfenced replica wrote legacy rows after the freeze's enumeration: stop it, then run capybara permissions cutover freeze again";
  if (!r.configCurrent)
    return "this CLI's permission configuration is not the published one: use the deployment's config";
  if (r.snapshot.pending > 0) return "run capybara permissions cutover snapshot";
  if (!ret.retired)
    return "wait for the retirement obligations to resolve (restart computers, recreate devices as reported)";
  return ret.abandoned > 0
    ? "retired: deploy R2 after acknowledging the abandoned incarnations"
    : "retired: deploy R2";
}

/** The human-readable report. */
export function formatReport(r: PermissionCutoverReport): string {
  const ret = r.retirement;
  const lines: string[] = [`Permission cutover report (kernel ${r.kernelVersion})`];
  lines.push(
    `Permission configuration: ${r.configCurrent ? "current" : "NOT current (this config differs from the published one)"}`,
  );
  if (r.replicas === null) lines.push("Replicas: unknown (Redis did not answer)");
  else {
    const other = r.replicas.filter((x) => !x.sameVersion);
    // only the kernel version is reported: a different one is an old replica or a newer build
    // (this CLI may be the odd one out); builds of one version are not told apart
    lines.push(
      `Replicas: ${r.replicas.length} live, ${other.length} on a different build than this CLI ` +
        `(${r.kernelVersion}; an old replica, or this CLI is the different one)`,
    );
    listed(
      lines,
      other,
      (x) => `${x.id} version ${x.version} (${x.roles.join(",")}), started ${x.startedAt}`,
    );
  }
  lines.push(
    ret.frozen
      ? `Legacy freeze: published ${iso(ret.frozenAt)}, ${
          ret.freezeEnumeratedAt === null
            ? "enumeration NOT completed (run the freeze again)"
            : `enumerated ${iso(ret.freezeEnumeratedAt)}`
        }`
      : "Legacy freeze: not published",
  );
  lines.push(`Fenced legacy reservations (refused at dispatch): ${ret.fencedReservations}`);
  const u = ret.unfencedWriters;
  lines.push(
    `Unmarked legacy rows (only an old, unfenced replica writes them): ${u.sinceMigration} since ` +
      `migration 0157, ${u.afterFreeze} after the freeze, ${u.afterEnumeration} after its ` +
      `enumeration, ${u.recent} in the last 15 minutes (database clock)${
        u.latestAt === null ? "" : `, latest ${iso(u.latestAt)}`
      }`,
  );
  lines.push(`Local devices without a boot identity: ${ret.localWithoutBoot.length}`);
  listed(
    lines,
    ret.localWithoutBoot,
    (d) => `${d.deviceId} (${d.machineId === null ? "no machine" : `machine ${d.machineId}`})`,
  );
  lines.push(`Cloud devices with unknown incarnations: ${ret.cloudUnknown.length}`);
  listed(lines, ret.cloudUnknown, (d) => {
    const flags = [
      d.prevHandle && "prevHandle (recreate_required)",
      d.noInstance && "noInstance (recreate_required)",
      d.currentUnconfirmed && "currentUnconfirmed (destroyByName on first use)",
    ].filter(Boolean);
    return `${d.deviceId}${flags.length > 0 ? ` ${flags.join(", ")}` : ""}`;
  });
  lines.push(
    `Obligations: open ${ret.open}, quarantined ${ret.quarantined}, resolved ${ret.resolved}, ` +
      `abandoned ${ret.abandoned} (${ret.abandonedMembers} members), unsettled members ` +
      `${ret.unsettledMembers}; retired: ${ret.retired ? "yes" : "no"}`,
  );
  listed(
    lines,
    ret.unresolved,
    (o) =>
      `${o.deviceId} ${o.provider} generation ${o.instanceGeneration}: ${o.state}` +
      `${o.reason === null ? "" : ` (${o.reason})`}${o.bootKnown ? ", boot known" : ""}`,
  );
  listed(
    lines,
    ret.abandonedList,
    (o) =>
      `abandoned ${o.deviceId} ${o.provider} generation ${o.instanceGeneration} at ${iso(o.abandonedAt)}`,
  );
  lines.push(
    `Cloud snapshot: ${r.snapshot.cloudDevices} cloud device(s), ${r.snapshot.pending} without a ` +
      `snapshot, ${r.snapshot.reconcileRequired.length} awaiting reconciliation`,
  );
  listed(
    lines,
    r.snapshot.reconcileRequired,
    (id) => `${id} permission_reconcile_required (reset its files)`,
  );
  lines.push(`Next: ${nextStep(r)}`);
  return `${lines.join("\n")}\n`;
}

function formatFreeze(f: LegacyFreezeResult): string {
  return `Freeze published ${iso(f.frozenAt)}; enumerated ${f.added} new members (stable)\n`;
}

function formatSnapshot(run: CloudSnapshotRun): string {
  const by = new Map<string, number>();
  for (const r of run.results) by.set(r.state, (by.get(r.state) ?? 0) + 1);
  const states = [...by].map(([s, n]) => `${s} ${n}`).join(", ");
  const lines = [
    `Snapshotted ${run.results.length} cloud device(s)${states === "" ? "" : ` (${states})`}; ` +
      `failed ${run.failed.length}; pending ${run.pending}`,
  ];
  listed(lines, run.failed, (f) => `failed ${f.deviceId}: ${f.error}`);
  if (run.reconcileRequired.length > 0) {
    lines.push(
      `Awaiting reconciliation (admission blocked until their files are reset): ${run.reconcileRequired.length}`,
    );
    listed(lines, run.reconcileRequired, (id) => id);
  }
  lines.push(
    run.failed.length > 0 || run.pending > 0
      ? "Run the snapshot again: it resumes where this run stopped"
      : "Run it again right before R2: cloud devices created since have no snapshot yet",
  );
  return `${lines.join("\n")}\n`;
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/**
 * `capybara permissions cutover report | freeze | snapshot` (permission runtime cutover B-10,
 * B-26; the runbook in `.agents/skills/writing-sandbox-providers/SKILL.md`):
 * - `report`: the pre-checks and progress, no writes; PostgreSQL only (replica presence is read
 *   from Redis when it answers). Exit 0.
 * - `freeze`: publishes the legacy-launch freeze and enumerates until stable before returning
 *   (idempotent); PostgreSQL only. Exit 1 when the enumeration did not settle.
 * - `snapshot`: the cloud snapshot of every device under its lifecycle lease (needs Redis).
 *   Exit 1 when refused (no freeze, a config that is not the published one), interrupted
 *   (SIGINT, or `opts.signal`: the device in flight commits or rolls back whole), or when a
 *   device failed or is still pending (a re-run resumes). `leaseWaitMs` bounds the wait for
 *   each device's lifecycle lease.
 * `--json` prints the result as JSON instead.
 */
export async function runPermissionsCutover(
  opts: {
    action: (typeof CUTOVER_ACTIONS)[number];
    json: boolean;
    leaseWaitMs?: number;
    /** Replaces the SIGINT abort (tests). */
    signal?: AbortSignal;
  },
  log: KernelLogger,
  env: NodeJS.ProcessEnv,
  io: PermissionsIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const config = await loadConfig(env);
    log.addSecrets(secretValues(KernelConfigSchema, config));
    log.setLevel(config.log.level);
    switch (opts.action) {
      case "report": {
        const report = await permissionCutoverReport(config, { logger: log });
        io.stdout.write(opts.json ? json(report) : formatReport(report));
        return 0;
      }
      case "freeze": {
        const out = await permissionCutoverFreeze(config, { logger: log, by: operator() });
        io.stdout.write(
          opts.json ? json(out) : `${formatFreeze(out.freeze)}${formatReport(out.report)}`,
        );
        return 0;
      }
      case "snapshot": {
        // Ctrl-C stops between devices (or a lease wait) instead of killing a device's transaction
        const ac = new AbortController();
        const onSigint = () => ac.abort(new Error("interrupted (SIGINT)"));
        if (opts.signal === undefined) process.once("SIGINT", onSigint);
        const signal = opts.signal ?? ac.signal;
        try {
          const run = await permissionCutoverSnapshot(config, {
            logger: log,
            signal,
            ...(opts.leaseWaitMs !== undefined && { leaseWaitMs: opts.leaseWaitMs }),
          });
          io.stdout.write(opts.json ? json(run) : formatSnapshot(run));
          return run.failed.length > 0 || run.pending > 0 ? 1 : 0;
        } catch (e) {
          if (!signal.aborted) throw e;
          io.stderr.write(
            "capybara: permissions cutover snapshot interrupted: every device done so far is " +
              "committed; run it again to resume\n",
          );
          return 1;
        } finally {
          process.off("SIGINT", onSigint);
        }
      }
    }
  } catch (e) {
    io.stderr.write(
      `capybara: permissions cutover ${opts.action} failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}
