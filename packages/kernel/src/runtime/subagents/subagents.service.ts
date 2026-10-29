import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { EventLog, EventLogModule } from "../../conversations/event-log.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { ModelsModule } from "../../models/models.module.js";
import { ModelPurposesService } from "../../models/purposes.js";
import { SkillInvoker } from "../../skills/invoke.js";
import { SkillsModule } from "../../skills/skills.module.js";
import { ProviderRegistry, ProvidersModule } from "../providers.js";
import { RunJobs, RunJobsModule } from "../run-jobs.js";
import {
  type ChildWriter,
  commitDispatchIn,
  type DispatchArgs,
  type DispatchCommit,
  type DispatchOutcome,
  type DispatchPlan,
  dispatchSubagent,
} from "./dispatch.js";
import { publishSubagentProgress, type SubagentStep } from "./progress.js";
import { liveSkillForks, type SkillForkDeps, type SkillForks } from "./skill-fork.js";

/**
 * Sub-agents (phase C, spec §7) and forked skills (phase D): the `agent` tool's dispatch (the
 * tool pipeline calls {@link dispatch}), a run's fork invocation ({@link skillForks}, the loop's
 * `prepare`) and a child step's progress on the parent's stream ({@link progress}). Child runs go
 * to the sub-agent run queue through {@link RunJobs}. The child lifecycle after dispatch (a
 * finished child resumes its parent, a stopped parent stops its children) is the waits'
 * (`Waits.childFinished` / `stopChildren`).
 */
@Injectable()
export class SubagentsService {
  /** The dispatch's dependencies (`dispatch.ts`, `skill-fork.ts`). */
  readonly deps: SkillForkDeps;
  /** The live fork handler of the loop (`LoopDeps.skillForks`). */
  readonly skillForks: SkillForks;

  constructor(
    @Inject(KernelDb) kdb: KernelDb,
    @Inject(EventLog) eventLog: EventLog,
    @Inject(ModelPurposesService) purposes: ModelPurposesService,
    @Inject(ProviderRegistry) registry: ProviderRegistry,
    @Inject(KernelConfigService) config: KernelConfigService,
    @Inject(RunJobs) jobs: RunJobs,
    @Inject(SkillInvoker) invoker: SkillInvoker,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {
    this.deps = {
      get db(): KernelSchemaDb {
        return kdb.db;
      },
      eventLog,
      purposes,
      registry,
      config,
      enqueue: (data, jobId, kind) => jobs.enqueue(data, jobId, kind),
      log,
      invoker,
      commitDispatch: (a, plan, child) => this.commitDispatch(a, plan, child),
    };
    this.skillForks = liveSkillForks(this.deps);
  }

  /** Dispatches the sub-agent of one `agent` call (`dispatchSubagent`). */
  dispatch(a: DispatchArgs): Promise<DispatchOutcome> {
    return dispatchSubagent(this.deps, a);
  }

  /** The dispatch's writes in a transaction of their own (see `commitDispatchIn`). */
  @Transactional({ propagation: "requires_new" })
  commitDispatch(
    a: DispatchArgs,
    plan: DispatchPlan,
    child: ChildWriter,
  ): Promise<DispatchCommit | null> {
    return commitDispatchIn(this.deps, a, plan, child);
  }

  /** A sub-agent's finished step on its parent's stream (sub-agents spec §14.2). Never throws. */
  progress(s: SubagentStep): Promise<void> {
    return publishSubagentProgress({ db: this.deps.db, bus: this.bus, log: this.log }, s);
  }
}

/** Sub-agent dispatch (the tools domain's `agent` tool and the run loop use it). */
@Module({
  imports: [EventLogModule, ModelsModule, ProvidersModule, RunJobsModule, SkillsModule],
  providers: [SubagentsService],
  exports: [SubagentsService],
})
export class SubagentsModule {}
