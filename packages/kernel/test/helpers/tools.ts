// biome-ignore-all lint/suspicious/noExplicitAny: test pools carry no schema types
import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { KernelConfig } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { Keyring } from "../../src/ctx/secrets.js";
import type { EffectiveConfigs } from "../../src/extensions/effective-config.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import type { KernelDb } from "../../src/infra/database/kernel-db.js";
import { KernelEvents } from "../../src/infra/events/kernel-events.js";
import type { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import type { HookRunner } from "../../src/runtime/hook-calls.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { Breaker } from "../../src/tools/breaker.js";
import { Credentials } from "../../src/tools/credentials.js";
import type { OrgToolSwitches } from "../../src/tools/org-tool-switches.js";
import { ToolOutputs } from "../../src/tools/outputs.js";
import {
  type DecidePolicy,
  ToolPipeline,
  type ToolPipelineHooks,
} from "../../src/tools/pipeline.js";
import { QuestionsService } from "../../src/tools/questions.service.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import { handlesFor } from "./identity.js";

const quiet = createLogger("error", { write: () => {} });

/** A config holder over a config getter (what the tools providers read). */
export function configFrom(config: () => unknown): Pick<KernelConfigService, "get"> {
  return { get: () => config() as KernelConfig };
}

/** The context-aware database handle of a test's Kysely (one per Kysely object). */
export function kernelDbFor(db: Kysely<any>): KernelDb {
  return handlesFor(db).db;
}

export function outputsFor(db: Kysely<any>, config: () => unknown): ToolOutputs {
  return new ToolOutputs(kernelDbFor(db), configFrom(config));
}

export function breakerFor(redis: Redis, config: () => unknown): Breaker {
  return new Breaker(redis, configFrom(config));
}

/**
 * Credentials over a test's Kysely. Without `oauth` the OAuth refresh has no lock or Redis (static
 * credentials only).
 */
export function credentialsFor(
  db: Kysely<any>,
  keyring: Keyring,
  log: KernelLogger = quiet,
  oauth?: {
    config: () => unknown;
    locks: Pick<LockService, "lease" | "releaseIf" | "renew">;
    redis: Pick<Redis, "exists">;
  },
): Credentials {
  return new Credentials(
    kernelDbFor(db),
    keyring,
    log,
    configFrom(oauth?.config ?? (() => ({}))),
    oauth?.locks ?? (undefined as never),
    oauth?.redis ?? (undefined as never),
  );
}

/**
 * The approvals over a test's Kysely and an event log; `events` gets `approval.decided`.
 * `registry`: the agent's tools a trial run's kept approval is checked against (default: none, so
 * no trial approval becomes a task grant).
 */
export function approvalsFor(
  db: Kysely<any>,
  eventLog: EventLog,
  config: () => unknown,
  events: KernelEvents = new KernelEvents(quiet),
  registry: Pick<ToolRegistry, "forAgent"> = {
    forAgent: async () => ({ tools: [], unavailable: [], hidden: [], toolSearch: false }),
  },
): ApprovalsService {
  const h = handlesFor(db);
  return new ApprovalsService(
    h.db,
    configFrom(config),
    eventLog,
    events,
    h.txHost,
    new ScheduledTaskStore(),
    registry,
    // no device here: deciding a network ask needs the kernel's DevicePolicyService
    {
      apply: async () => {
        throw new Error("DevicePolicyService is not available in this test");
      },
    },
    undefined as never,
  );
}

/** The questions over a test's Kysely and an event log; `events` gets `question.answered`. */
export function questionsFor(
  db: Kysely<any>,
  eventLog: EventLog,
  config: () => unknown,
  events: KernelEvents = new KernelEvents(quiet),
): QuestionsService {
  const h = handlesFor(db);
  return new QuestionsService(h.db, configFrom(config), eventLog, events, h.txHost);
}

/** What a hand-built pipeline runs on (the shape of the old `ToolPipelineDeps`). */
export interface PipelineTestDeps {
  db: Kysely<any>;
  eventLog: EventLog;
  registry: Pick<ToolRegistry, "forAgent" | "findConnector" | "handler">;
  credentials: Pick<Credentials, "injection" | "onUnauthorized">;
  breaker: Pick<Breaker, "check" | "failure" | "success">;
  outputs: Pick<ToolOutputs, "save" | "load">;
  approvals: Pick<ApprovalsService, "request" | "forCall">;
  questions: Pick<QuestionsService, "ask" | "forCall">;
  config: () => unknown;
  log: Logger;
  decidePolicy?: DecidePolicy;
  hooks?: ToolPipelineHooks;
  pluginHooks?: HookRunner;
  /** The effective configs (default: every org follows the platform with an empty config). */
  effective?: Pick<EffectiveConfigs, "get">;
  /** The org tool switches (default: none off). */
  switches?: Pick<OrgToolSwitches, "isToolOff">;
  onToolsChanged?: (orgId: string, connectorId: string) => void;
}

/** A tool pipeline over test doubles (no extension host: inline cards are dropped). */
export function pipelineFor(d: PipelineTestDeps): ToolPipeline {
  const h = handlesFor(d.db);
  const onToolsChanged = d.onToolsChanged;
  return new ToolPipeline(
    h.db,
    d.eventLog,
    // no sub-agent dispatch: `agent` calls are refused
    undefined,
    // no messages between agents: `SendMessage` / `SubagentHandback` calls are refused
    undefined,
    d.registry,
    d.credentials,
    d.breaker,
    d.outputs,
    d.approvals,
    d.questions,
    configFrom(d.config),
    d.log,
    d.pluginHooks ? ({ hooks: d.pluginHooks, current: () => undefined } as never) : undefined,
    onToolsChanged
      ? {
          onToolsChanged: async (orgId, connectorId) => {
            onToolsChanged(orgId, connectorId);
          },
        }
      : undefined,
    d.effective ?? {
      get: async () => ({ ok: true, config: {}, source: "platform" }),
    },
    d.switches ?? { isToolOff: async () => false },
    h.txHost,
    {
      ...d.hooks,
      ...(d.decidePolicy !== undefined && { decidePolicy: d.decidePolicy }),
    },
  );
}
