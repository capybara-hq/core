import { DeviceProtocolError, isSandboxPermissionUnsupportedError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { EventLog } from "../../conversations/event-log.js";
import { ConversationDevices } from "../../devices/conversation-devices.js";
import { DeviceProjectsService, withinMode } from "../../devices/device-projects.service.js";
import { aboveHome } from "../../devices/working-root.js";
import { ApiError } from "../../errors.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { KernelReadNotAdmitted, KernelReadUnsupported } from "../../sandbox/kernel-read.js";
import { SandboxLockLostError, SandboxPathBusyError } from "../../sandbox/leases.js";
import {
  PERMISSION_CONTEXT_ACTIVATION,
  permissionContextActive,
} from "../../sandbox/permission-context-types.js";
import { homeOf } from "../../sandbox/review/rules.js";
import { SandboxService, type SandboxUseContext } from "../../sandbox/sandbox.service.js";
import { providerConnectionFailure } from "../../sandbox/unreachable.js";
import { currentExecutionClaim } from "../run-execution.js";
import { runEndedIn } from "../run-status.js";
import {
  type ProjectFiles,
  type ProjectRootPayload,
  projectRootIdemKey,
  projectUnavailable,
  readProjectKnowledge,
  sameProjectRoot,
  unavailableProject,
} from "./knowledge.js";

/**
 * The longest a run start waits for its project's knowledge (every device call of the read under
 * one bound): past it the run goes on without a new snapshot, as when the device is unreachable.
 */
export const PROJECT_KNOWLEDGE_TIMEOUT_MS = 30_000;

/**
 * Test seam (`KernelSeams`): the read's time limit in ms, asked at every read; default
 * {@link PROJECT_KNOWLEDGE_TIMEOUT_MS}.
 */
export const PROJECT_KNOWLEDGE_TIMEOUT = Symbol("PROJECT_KNOWLEDGE_TIMEOUT");

/** The run start has no current execution claim of its own run: nothing is admitted. */
class KnowledgeClaimMissing extends Error {
  constructor() {
    super("The run start has no current execution claim of its run");
    this.name = "KnowledgeClaimMissing";
  }
}

/**
 * An error that says the device could not be asked, not that the project is unreadable: the
 * provider unreachable, a kernel refusal (the device offline, gone or busy, a relay given up), a
 * malformed device answer, a lost lease, a kernel read that was not admitted (gate on: nothing
 * was sent to the device).
 */
function isDeviceFailure(e: unknown): boolean {
  return (
    providerConnectionFailure(e) !== undefined ||
    e instanceof KernelReadNotAdmitted ||
    e instanceof KernelReadUnsupported ||
    e instanceof ApiError ||
    e instanceof DeviceProtocolError ||
    e instanceof SandboxLockLostError ||
    e instanceof SandboxPathBusyError
  );
}

/** What a run start tells {@link ProjectKnowledgeService.record}. */
export interface ProjectKnowledgeInput {
  orgId: string;
  conversationId: string;
  runId: string;
  /** The conversation's kind: only a chat conversation can be bound to a project. */
  kind: "chat" | "eval" | "subagent";
  /**
   * A sub-agent run's root conversation: the child works in its root's project, so its run start
   * copies the root's latest snapshot (no device call). Absent for any other run.
   */
  rootConversationId?: string;
  /** The run's shutdown signal (the read has its own time limit as well). */
  signal: AbortSignal;
}

/**
 * Run start's project knowledge (project root spec §4.4, §4.7): for a conversation bound to a
 * project (`conversations.project_name` / `project_path`), reads the project's `AGENTS.md` and
 * skills on its device before the run's first model call ({@link readProjectKnowledge}), outside
 * any transaction, and appends a `project_root` event when the snapshot differs from the
 * conversation's latest one. A free conversation reads nothing, so its device still starts lazily
 * at its first sandbox call; an eval replay or a sub-agent never reads a device here. A sub-agent's
 * run start copies its **root** conversation's latest `project_root` into its own log instead (it
 * works in the same project), under its own run's idempotency key, and again only when the root's
 * latest snapshot differs from the child's latest; the renderer then shows it to the child as is.
 *
 * Reads in the device's effective mode (`DeviceProjectsService.scopeFor`, the same scope the
 * binding was checked against) and through `SandboxService.withSandbox`, as a tool call does, so
 * a bound conversation starts its device eagerly (the accepted cost, spec §4.4). Once the
 * activation gate is on the read goes through `SandboxService.withKernelRead` instead: every
 * stat / readFile / list a kernel read under the run's current execution claim while the run is
 * still queued, acting for the run's trigger, its scope narrowed to the root, `AGENTS.md` and
 * `.agents/skills` (permission activation L2). A project the
 * run cannot use is recorded as `unavailable` with its reason: a project the device no longer
 * keeps under the bound name and path (`removed`, not asked), a root that is gone, out of the mode
 * (or above the owner's home) or unreadable, or a machine that does not announce projects
 * (`unsupported`, not asked). The
 * device not being reachable (offline, the provider down, the time limit) records nothing, and the
 * run goes on as it does today when its device is away. Nothing is cached in the process.
 */
@Injectable()
export class ProjectKnowledgeService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "appendIn" | "notify">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ConversationDevices) private readonly devices: Pick<ConversationDevices, "forTool">,
    @Inject(DeviceProjectsService)
    private readonly projects: Pick<DeviceProjectsService, "scopeFor" | "keeps">,
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "withSandbox" | "withKernelRead">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Optional()
    @Inject(PROJECT_KNOWLEDGE_TIMEOUT)
    private readonly timeoutMs: () => number = () => PROJECT_KNOWLEDGE_TIMEOUT_MS,
    /** The paired activation gate: once on, the read is a set of kernel reads. */
    @Optional() @Inject(PERMISSION_CONTEXT_ACTIVATION) private readonly activation?: boolean,
  ) {}

  /**
   * Reads and records (see the class); notifies after the commit. False: the run had ended under
   * the locks (a stop landed while the device was read), so nothing was appended and the run must
   * not go on (as `PluginContextService.record`).
   */
  async record(input: ProjectKnowledgeInput): Promise<boolean> {
    if (input.kind === "subagent") return this.copyFromRoot(input);
    if (input.kind !== "chat") return true;
    const conv = await this.db.db
      .selectFrom("conversations")
      .select(["account_id", "project_name", "project_path"])
      .where("id", "=", input.conversationId)
      .where("org_id", "=", input.orgId)
      .executeTakeFirst();
    if (!conv || conv.project_name === null || conv.project_path === null) return true;
    const payload = await this.read(input, {
      accountId: conv.account_id,
      project: conv.project_name,
      root: conv.project_path,
    });
    if (payload === null) return true;
    const seq = await this.append(input, payload);
    if (seq === "ended") return false;
    if (seq !== null) await this.eventLog.notify(input.conversationId, seq);
    return true;
  }

  /**
   * A sub-agent's run start: the root conversation's latest snapshot appended to the child's log
   * when it differs from the child's latest ({@link append}); nothing when the root has none. No
   * device call, so a replay of the child (which copies the child's own event) never needs one.
   */
  private async copyFromRoot(input: ProjectKnowledgeInput): Promise<boolean> {
    const rootId = input.rootConversationId;
    if (rootId === undefined || rootId === input.conversationId) return true;
    const latest = await this.db.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", rootId)
      .where("type", "=", "project_root")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    if (latest === undefined) return true;
    // the stored payload passed the event schema when the root's run start appended it
    const seq = await this.append(input, latest.payload as ProjectRootPayload);
    if (seq === "ended") return false;
    if (seq !== null) await this.eventLog.notify(input.conversationId, seq);
    return true;
  }

  /** The snapshot read on the device, or null when the device could not be asked (logged). */
  private async read(
    input: ProjectKnowledgeInput,
    bound: { accountId: string; project: string; root: string },
  ): Promise<ProjectRootPayload | null> {
    const where = {
      orgId: input.orgId,
      conversationId: input.conversationId,
      runId: input.runId,
      project: bound.project,
    };
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs())]);
    try {
      // the device a tool call of this conversation would enter, checked for its owner now
      const deviceId = await this.devices.forTool(input.orgId, input.conversationId);
      const scope = await this.projects.scopeFor(input.orgId, bound.accountId, deviceId);
      // the binding is the name and the path: a project removed from the device (or re-added
      // under its name with another path) no longer serves the conversation, which goes on free
      if (!(await this.projects.keeps(deviceId, bound.project, bound.root))) {
        return unavailableProject(
          bound.project,
          bound.root,
          projectUnavailable.removed(bound.project),
        );
      }
      // a device that cannot serve list / scan (a machine without `projects`, a provider without
      // them) is not asked: the project is recorded as unavailable, so an older snapshot stops
      // applying
      if (!scope.supported) {
        this.log.warn("project knowledge not read: the device offers no projects", {
          ...where,
          deviceId,
        });
        return unavailableProject(bound.project, bound.root, projectUnavailable.unsupported());
      }
      // A machine reporting a wider mode than the org allows is not read unasked. The local
      // provider rechecks the current ceiling on every readFile / stat request as well.
      if (scope.widerThanAllowed) {
        this.log.warn("project knowledge not read: the device runs a wider mode than allowed", {
          ...where,
          deviceId,
        });
        return unavailableProject(
          bound.project,
          bound.root,
          projectUnavailable.widerMode(bound.root),
        );
      }
      const enter = await this.entry(input, bound.accountId, bound.root);
      return await enter(
        {
          orgId: input.orgId,
          deviceId,
          holderConversationId: input.conversationId,
          // the read tells the model nothing: its first tool call still learns that the device
          // started, restarted or had its files reset
          silent: true,
          actor: {
            accountId: enter.accountId,
            conversationId: input.conversationId,
            runId: input.runId,
          },
        },
        async (h, p, info, sig) => {
          const target = { project: bound.project, root: bound.root, mode: scope.mode };
          // the kernel's own check first: a root the mode cannot read is never asked about
          // a root above the owner's home is refused as the working root's rule refuses it
          // (`workingRootOf`, the same home: the reported one, else the workspace's prefix)
          const reported = scope.home;
          const home = reported?.startsWith("/") ? reported : homeOf(info.roots.workspace);
          if (!withinMode(scope, bound.root, info.roots.workspace) || aboveHome(bound.root, home)) {
            return unavailableProject(
              bound.project,
              bound.root,
              projectUnavailable.outsideMode(bound.root, scope.mode),
            );
          }
          const list = p.list;
          const files: ProjectFiles = {
            stat: (path) => p.stat(h, path, sig),
            readFile: (path, maxBytes) => p.readFile(h, path, { maxBytes, signal: sig }),
            ...(list !== undefined && {
              list: (path: string, limit: number) => list.call(p, h, path, { limit, signal: sig }),
            }),
          };
          try {
            return await readProjectKnowledge(files, target, {
              log: (msg, detail) => this.log.info(msg, { ...where, ...detail }),
              // a runtime refusing the read's scope refuses every read of it: thrown, so no
              // half-read snapshot is recorded
              isDeviceFailure: (e) =>
                sig.aborted || isDeviceFailure(e) || isSandboxPermissionUnsupportedError(e),
            });
          } catch (e) {
            // the device's runtime refused the kernel read's scope: the project is recorded
            // unreadable (the provider's text is logged, never recorded) and the run goes on
            if (isSandboxPermissionUnsupportedError(e) && !sig.aborted) {
              this.log.warn("project knowledge not read: the device refused the read's scope", {
                ...where,
                deviceId,
                reason: e.message,
              });
              return unavailableProject(
                bound.project,
                bound.root,
                projectUnavailable.refused(bound.root),
              );
            }
            // gate on: a host runtime without restricted enforcement gets no kernel read; the
            // project is recorded unreadable with the reason and the run goes on
            if (!(e instanceof KernelReadUnsupported)) throw e;
            this.log.warn(
              "project knowledge not read: the device cannot enforce a read-only read",
              {
                ...where,
                deviceId,
              },
            );
            return unavailableProject(
              bound.project,
              bound.root,
              projectUnavailable.notEnforceable(bound.root),
            );
          }
        },
        signal,
      );
    } catch (err) {
      this.log.warn("project knowledge not read: the device could not be asked; the run goes on", {
        ...where,
        timedOut: signal.aborted && !input.signal.aborted,
        err,
      });
      return null;
    }
  }

  /**
   * How the read enters the device. Gate off: the raw `withSandbox`, acting for the conversation's
   * owner (unchanged). Gate on: `withKernelRead` under the run's current execution claim (the run
   * start runs inside it; another run's claim or none admits nothing), acting for the run's
   * trigger, reading the bound root only.
   */
  private async entry(
    input: ProjectKnowledgeInput,
    owner: string,
    root: string,
  ): Promise<SandboxService["withSandbox"] & { accountId: string }> {
    if (!permissionContextActive(this.activation))
      return Object.assign(this.sandbox.withSandbox.bind(this.sandbox), { accountId: owner });
    const claim = currentExecutionClaim();
    if (
      !claim ||
      claim.runId !== input.runId ||
      claim.conversationId !== input.conversationId ||
      claim.orgId !== input.orgId
    )
      throw new KnowledgeClaimMissing();
    const run = await this.db.db
      .selectFrom("runs")
      .select("trigger_account_id")
      .where("id", "=", input.runId)
      .where("conversation_id", "=", input.conversationId)
      .executeTakeFirst();
    if (!run) throw new KnowledgeClaimMissing();
    const read = { claim, purpose: "project_root" as const, root };
    const enter: SandboxService["withSandbox"] = (ctx: SandboxUseContext, fn, signal) =>
      this.sandbox.withKernelRead(ctx, read, fn, signal);
    return Object.assign(enter, { accountId: run.trigger_account_id });
  }

  /**
   * One transaction under the conversation row lock (as `PluginContextService`): compares the
   * snapshot with the conversation's latest `project_root` and appends it when it differs, with
   * the run's idempotency key, so a retried run start finds its event (or nothing changed).
   * Returns the seq written, null for none, `ended` when the run is terminal under the locks.
   */
  @Transactional()
  private async append(
    input: ProjectKnowledgeInput,
    payload: ProjectRootPayload,
  ): Promise<number | null | "ended"> {
    const t = this.db.db;
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", input.conversationId)
      .forUpdate()
      .executeTakeFirst();
    if (await runEndedIn(t, input.runId)) return "ended";
    const latest = await t
      .selectFrom("conversation_events")
      .select(["seq", "payload"])
      .where("conversation_id", "=", input.conversationId)
      .where("type", "=", "project_root")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    // the stored payload passed the event schema when it was appended (`skills` defaulted)
    if (latest !== undefined && sameProjectRoot(latest.payload as ProjectRootPayload, payload)) {
      return null;
    }
    const [written] = await this.eventLog.appendIn(input.conversationId, [
      {
        type: "project_root",
        runId: input.runId,
        idemKey: projectRootIdemKey(input.runId),
        payload,
      },
    ]);
    // an earlier attempt of this run start already wrote its snapshot: nothing new to tell
    if (written === undefined || (latest !== undefined && written.seq <= Number(latest.seq))) {
      return null;
    }
    return written.seq;
  }
}
