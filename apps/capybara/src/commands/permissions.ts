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

/** The runbook step the report points at (section 4 of the activation plan). */
function nextStep(r: PermissionCutoverReport): string {
  const ret = r.retirement;
  if (!ret.frozen) {
    const waits: string[] = [];
    if (r.replicas === null) waits.push("confirm no old replica runs (replica presence unknown)");
    else if (r.replicas.some((x) => !x.sameVersion))
      waits.push("stop the replicas on another version");
    if (ret.unfencedWriters.latestAt !== null)
      waits.push("make sure the replica that wrote unmarked legacy rows is stopped");
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
    lines.push(
      `Replicas: ${r.replicas.length} live, ${other.length} on another version than ${r.kernelVersion}`,
    );
    for (const x of other)
      lines.push(`  - ${x.id} version ${x.version} (${x.roles.join(",")}), started ${x.startedAt}`);
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
      `migration 0157, ${u.afterFreeze} after the freeze${
        u.latestAt === null ? "" : `, latest ${iso(u.latestAt)}`
      }`,
  );
  lines.push(`Local devices without a boot identity: ${ret.localWithoutBoot.length}`);
  for (const d of ret.localWithoutBoot)
    lines.push(
      `  - ${d.deviceId} (${d.machineId === null ? "no machine" : `machine ${d.machineId}`})`,
    );
  lines.push(`Cloud devices with unknown incarnations: ${ret.cloudUnknown.length}`);
  for (const d of ret.cloudUnknown) {
    const flags = [
      d.prevHandle && "prevHandle (recreate_required)",
      d.noInstance && "noInstance (recreate_required)",
      d.currentUnconfirmed && "currentUnconfirmed (destroyByName on first use)",
    ].filter(Boolean);
    lines.push(`  - ${d.deviceId}${flags.length > 0 ? ` ${flags.join(", ")}` : ""}`);
  }
  lines.push(
    `Obligations: open ${ret.open}, quarantined ${ret.quarantined}, resolved ${ret.resolved}, ` +
      `abandoned ${ret.abandoned} (${ret.abandonedMembers} members), unsettled members ` +
      `${ret.unsettledMembers}; retired: ${ret.retired ? "yes" : "no"}`,
  );
  for (const o of ret.unresolved)
    lines.push(
      `  - ${o.deviceId} ${o.provider} generation ${o.instanceGeneration}: ${o.state}` +
        `${o.reason === null ? "" : ` (${o.reason})`}${o.bootKnown ? ", boot known" : ""}`,
    );
  for (const o of ret.abandonedList)
    lines.push(
      `  - abandoned ${o.deviceId} ${o.provider} generation ${o.instanceGeneration} at ${iso(o.abandonedAt)}`,
    );
  lines.push(
    `Cloud snapshot: ${r.snapshot.cloudDevices} cloud device(s), ${r.snapshot.pending} without a ` +
      `snapshot, ${r.snapshot.reconcileRequired.length} awaiting reconciliation`,
  );
  for (const id of r.snapshot.reconcileRequired)
    lines.push(`  - ${id} permission_reconcile_required (reset its files)`);
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
  for (const f of run.failed) lines.push(`  - failed ${f.deviceId}: ${f.error}`);
  if (run.reconcileRequired.length > 0) {
    lines.push(
      `Awaiting reconciliation (admission blocked until their files are reset): ${run.reconcileRequired.length}`,
    );
    for (const id of run.reconcileRequired) lines.push(`  - ${id}`);
  }
  if (run.failed.length > 0 || run.pending > 0)
    lines.push("Run the snapshot again: it resumes where this run stopped");
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
 *   Exit 1 when refused (no freeze, a config that is not the published one) or when a device
 *   failed or is still pending (a re-run resumes).
 * `--json` prints the result as JSON instead.
 */
export async function runPermissionsCutover(
  opts: { action: (typeof CUTOVER_ACTIONS)[number]; json: boolean },
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
        const run = await permissionCutoverSnapshot(config, { logger: log });
        io.stdout.write(opts.json ? json(run) : formatSnapshot(run));
        return run.failed.length > 0 || run.pending > 0 ? 1 : 0;
      }
    }
  } catch (e) {
    io.stderr.write(
      `capybara: permissions cutover ${opts.action} failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}
