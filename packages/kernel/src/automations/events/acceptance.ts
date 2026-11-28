import { randomUUID } from "node:crypto";
import {
  InboxError,
  type LocalizedName,
  type TriggerEventDeclaration,
  type TriggerSource,
  type TriggerSubject,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { AgentLookup, AgentLookupModule } from "../../agents/agent-lookup.js";
import type { AcceptanceMode } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import { ExtensionDisplayNames } from "../../extensions/display-name.js";
import { ExtensionsModule } from "../../extensions/extensions.module.js";
import { ExtensionPointDefaults } from "../../extensions/point-defaults.js";
import { oweOfferDeclinedIn } from "../../extensions/run-lifecycle-owe.js";
import { audit } from "../../identity/audit.js";
import { InboxItemsModule, InboxItemsService } from "../../inbox/inbox-items.service.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { OutboxService } from "../../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { roleAtLeast } from "../../orgs/roles.js";
import { pluginDisplayNames } from "../../tools/display-names.js";
import { type EffectiveAutomationSettings, readAutomationSettings } from "../effective-settings.js";
import { eventSourceUnavailable } from "../errors.js";
import { withDeadline } from "./deadline.js";
import { deliverEvent, type EventCause, type EventRow } from "./deliver.js";
import { isSelfTriggered } from "./guards.js";

export type { AcceptanceMode } from "../../db/kernel-schema.js";

/** How long a work offer stays open (collaboration spec §4.4). */
export const OFFER_TTL_SECONDS = 7 * 24 * 3600;

/** The prompt of an acceptance automation (model-visible; the event block carries the work). */
export const ACCEPTANCE_PROMPT =
  "This work was assigned to you. Read the assigned item, do what it asks within what you are allowed to do, and report what you did.";

/** A person's acceptance rule for one trigger source with directed event types. */
export interface AcceptanceRuleView {
  source: string;
  /** The source's display name. */
  name: LocalizedName;
  /** The person's rule; null = they follow the org's `directedDefault`. */
  mode: AcceptanceMode | null;
}

/** What `GET automations/acceptance` answers. */
export interface AcceptanceRulesView {
  items: AcceptanceRuleView[];
  /** The org's default for a source without a rule (`automations.directedDefault`). */
  directedDefault: AcceptanceMode;
}

/** An open work offer, as its person's inbox shows it. */
export interface AutomationOfferView {
  id: string;
  source: string;
  sourceName: LocalizedName;
  agent: { id: string; name: string };
  eventType: string;
  subject: TriggerSubject;
  /** The extension's summary of what happened (written by people, shown as text). */
  summary: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * What routing a directed event did: `paused` when the rule is `auto` but the person's acceptance
 * automation is paused or ended (nothing runs); `skipped` when its own audience agent caused it
 * (self-trigger) or another dispatch of it settled it first.
 */
export type RouteOutcome = "fired" | "offered" | "off" | "paused" | "undelivered" | "skipped";

/** The most open offers one inbox read returns. */
export const OFFERS_LIST_MAX = 100;

/** What the dispatcher already knows when it hands a directed event over. */
export interface RouteContext {
  decl: TriggerEventDeclaration;
  /** Every event type the source declares now. */
  declared: readonly TriggerEventDeclaration[];
  cause: EventCause;
  settings: EffectiveAutomationSettings;
  /**
   * The source's `visible()` within its deadline; undefined when it did not answer on the
   * dispatch's last attempt (the dispatcher then left the event `undelivered`).
   */
  visible(accountIds: string[]): Promise<string[] | undefined>;
}

const offerNotFound = () => new ApiError("automation.offer_not_found", "Work offer not found");
const offerClosed = () =>
  new ApiError(
    "automation.offer_closed",
    "This work offer was already accepted, declined or has expired",
  );
const offerUnavailable = (message: string) => new ApiError("automation.offer_unavailable", message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The directed event types a source declares, sorted. */
const directedTypes = (declared: readonly TriggerEventDeclaration[]): string[] =>
  [...new Set(declared.filter((d) => d.directed).map((d) => d.type))].sort();

/** An in-app link a kernel inbox item may carry; anything else is left out. */
const inAppLink = (url: string | undefined): string | undefined =>
  url?.startsWith("/") && !url.startsWith("//") && url.length <= 2048 ? url : undefined;

/**
 * Directed events and acceptance (collaboration spec §4.4). A directed event names the person and
 * the agent the work is for (`audience`); work runs as that person, with that agent, only within
 * what the person allowed:
 *
 * - **Rules.** The person's rule for the source (`automation_acceptance`), else the org's
 *   `automations.directedDefault` (default `auto`): `auto` runs the work through the person's
 *   acceptance automation for (source, agent), made by the kernel on first need (owner = the
 *   person, `subject` mode, no grants, `unattended_ask = wait`, every directed type of the source);
 *   `confirm` posts a work offer to the person's inbox; `off` runs nothing. The rule is read on
 *   every event, so switching to `confirm` or `off` takes effect even while the acceptance
 *   automation exists, and a paused one runs nothing.
 * - **Guards** (before the rule): the type must be directed; the person must be an active member
 *   (member role or above) who may use the agent (`AgentLookup.get`) and whom the source's
 *   `visible()` admits, in an org with automations on; otherwise the event is `undelivered`. An
 *   event caused by a run of that person on that agent (self-trigger) runs nothing.
 * - **Offers.** Accept (the person's own act, never an agent's) makes or reuses the acceptance
 *   automation and delivers the event to it, after checking the guards again; decline tells the
 *   person who caused the event (`cause_account_id`, else the cause run's trigger account) through
 *   a kernel inbox item. An offer is open for {@link OFFER_TTL_SECONDS}; past it, it is `expired`
 *   when next read.
 *
 * Every read and write filters by the org; the person acts only on their own rules and offers.
 */
@Injectable()
export class AcceptanceService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ExtensionPointDefaults)
    private readonly points: Pick<ExtensionPointDefaults, "providersFor">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
    @Inject(InboxItemsService) private readonly inbox: Pick<InboxItemsService, "post" | "close">,
    @Inject(AgentLookup) private readonly agents: Pick<AgentLookup, "get">,
    @Inject(ExtensionDisplayNames)
    private readonly displayNames: Pick<ExtensionDisplayNames, "many">,
  ) {}

  /**
   * Routes the pending directed event `ev` (the dispatcher's guards for depth, the source and its
   * declarations already passed), see the class. The event ends `dispatched` (fired, offered, off
   * or self-triggered) or `undelivered`.
   */
  async route(ev: EventRow, ctx: RouteContext): Promise<RouteOutcome> {
    const audience = ev.audience;
    if (audience === null) throw new Error(`trigger event ${ev.id} is not directed`);
    const orgId = ev.org_id;
    const log = { orgId, eventId: ev.id, plugin: ev.plugin, type: ev.type };
    const refuse = (why: string): Promise<RouteOutcome> => {
      this.log.info(`directed trigger event undelivered: ${why}`, log);
      return this.settle(orgId, ev.id, "undelivered").then(() => "undelivered");
    };
    if (!ctx.decl.directed) return refuse("its type is not declared directed");
    if (!ctx.settings.enabled) return refuse("automations are off in the org");
    const problem = await this.audienceProblem(orgId, audience.accountId, audience.agentId);
    if (problem !== null) return refuse(problem);
    if (isSelfTriggered(audience, ctx.cause)) {
      this.log.info("directed trigger event caused by its own audience agent; nothing runs", log);
      await this.settle(orgId, ev.id, "dispatched");
      return "skipped";
    }
    const seen = await ctx.visible([audience.accountId]);
    if (seen === undefined) return refuse("the source gave no answer on who may see the subject");
    if (!seen.includes(audience.accountId)) return refuse("the source does not show the subject");
    const mode = await this.modeFor(orgId, audience.accountId, ev.plugin, ctx.settings);
    return this.routeIn(ev, mode, ctx);
  }

  /** {@link route}'s writes, in one transaction under the event row's lock. */
  @Transactional()
  private async routeIn(
    ev: EventRow,
    mode: AcceptanceMode,
    ctx: RouteContext,
  ): Promise<RouteOutcome> {
    const db = this.kdb.db;
    const orgId = ev.org_id;
    const audience = ev.audience as { accountId: string; agentId: string };
    const held = await db
      .selectFrom("trigger_events")
      .select("state")
      .where("org_id", "=", orgId)
      .where("id", "=", ev.id)
      .forUpdate()
      .executeTakeFirst();
    // another dispatch of the event settled it first
    if (held?.state !== "pending") return "skipped";
    if (mode === "off") {
      await this.oweDeclined(ev, audience, "off");
      this.log.info("directed trigger event: the person's acceptance rule is off", {
        orgId,
        eventId: ev.id,
        plugin: ev.plugin,
      });
      await this.settle(orgId, ev.id, "dispatched");
      return "off";
    }
    if (mode === "confirm") {
      await this.offer(ev, audience);
      await this.settle(orgId, ev.id, "dispatched");
      return "offered";
    }
    const automationId = await this.ensureAutomation(
      orgId,
      audience.accountId,
      audience.agentId,
      ev.plugin,
      directedTypes(ctx.declared),
    );
    const added = await deliverEvent(
      { db, outbox: this.outbox, log: this.log },
      ev,
      [automationId],
      { decl: ctx.decl, cause: ctx.cause, coalesceSeconds: ctx.settings.coalesceSeconds },
    );
    await this.settle(orgId, ev.id, "dispatched");
    if (added === 0) {
      // the event row is held and the cause checked: only a paused or ended automation takes none
      await this.oweDeclined(ev, audience, "paused");
      this.log.info("directed trigger event: the person's acceptance automation is paused", {
        orgId,
        eventId: ev.id,
        automationId,
      });
      return "paused";
    }
    return "fired";
  }

  /**
   * Tells the event's source plugin that directed work was not run (`run.lifecycle`
   * `offer_declined`), owed in the caller's transaction; nothing when the plugin does not
   * subscribe in the org.
   */
  private oweDeclined(
    ev: EventRow,
    audience: { accountId: string; agentId: string },
    reason: "declined" | "off" | "paused",
  ): Promise<void> {
    return oweOfferDeclinedIn(this.kdb.db, this.outbox, {
      orgId: ev.org_id,
      plugin: ev.plugin,
      eventId: ev.id,
      accountId: audience.accountId,
      agentId: audience.agentId,
      subject: ev.subject,
      reason,
    });
  }

  /**
   * Why the audience cannot receive work, or null: an active member (member role or above) of the
   * org who may use the agent.
   */
  private async audienceProblem(
    orgId: string,
    accountId: string,
    agentId: string,
  ): Promise<string | null> {
    const member = await this.kdb.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("memberships.role")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    if (member === undefined || !roleAtLeast(member.role, "member"))
      return "the person is not an active member who may use automations";
    try {
      await this.agents.get(orgId, agentId, accountId);
    } catch (err) {
      if (err instanceof ApiError) return "the person may not use the agent";
      throw err;
    }
    return null;
  }

  /** The person's rule for `source`, else the org's default. */
  private async modeFor(
    orgId: string,
    accountId: string,
    source: string,
    settings: EffectiveAutomationSettings,
  ): Promise<AcceptanceMode> {
    const row = await this.kdb.db
      .selectFrom("automation_acceptance")
      .select("mode")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("source", "=", source)
      .executeTakeFirst();
    return row?.mode ?? settings.directedDefault;
  }

  /**
   * The live acceptance automation of (org, person, source, agent), made when missing (see the
   * class); an existing one gains directed types its source declares since. The caller runs it in
   * a transaction; the partial unique index makes two concurrent first events make one.
   */
  private async ensureAutomation(
    orgId: string,
    accountId: string,
    agentId: string,
    source: string,
    types: string[],
  ): Promise<string> {
    const db = this.kdb.db;
    const find = () =>
      db
        .selectFrom("automations")
        .select(["id", "trigger"])
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("agent_id", "=", agentId)
        .where("origin", "=", "acceptance")
        .where("deleted_at", "is", null)
        .where(sql<boolean>`trigger->>'source' = ${source}`)
        .forUpdate()
        .executeTakeFirst();
    const found = await find();
    if (found !== undefined) {
      const t = found.trigger;
      const have = t.kind === "event" ? t.types : [];
      if (types.some((x) => !have.includes(x))) {
        await db
          .updateTable("automations")
          .set({
            trigger: JSON.stringify({
              kind: "event",
              source,
              types: [...new Set([...have, ...types])].sort(),
              filter: [],
            }),
            updated_at: sql<Date>`now()`,
          })
          .where("org_id", "=", orgId)
          .where("id", "=", found.id)
          .execute();
      }
      return found.id;
    }
    const [sourceNames, agent] = await Promise.all([
      this.displayNames.many([source]),
      this.agents.get(orgId, agentId, accountId),
    ]);
    const sourceName = sourceNames.get(source)?.en ?? source;
    const name = `${sourceName} · ${agent.definition.name}`.slice(0, 200);
    const id = randomUUID();
    const inserted = await db
      .insertInto("automations")
      .values({
        id,
        org_id: orgId,
        account_id: accountId,
        agent_id: agentId,
        name,
        prompt: ACCEPTANCE_PROMPT,
        trigger: JSON.stringify({ kind: "event", source, types, filter: [] }),
        mode: "subject",
        conversation_id: null,
        chat: null,
        model: null,
        effort: null,
        device_id: null,
        unattended_ask: "wait",
        origin: "acceptance",
        principal: JSON.stringify({ kind: "member", accountId }),
        status: "active",
        next_run_at: null,
        jitter_seconds: 0,
        expires_at: null,
      })
      // only the acceptance index can conflict (the id is new): another event made it first
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted === undefined) {
      const winner = await find();
      if (winner === undefined) throw new Error("acceptance automation insert conflicted");
      return winner.id;
    }
    await audit(db, {
      orgId,
      action: "automation.created",
      target: id,
      detail: { name, agentId, mode: "subject", origin: "acceptance", source, grants: [] },
    });
    return id;
  }

  /** Posts the work offer for `ev` and its inbox item (one offer per event). */
  private async offer(ev: EventRow, audience: { accountId: string; agentId: string }) {
    const db = this.kdb.db;
    const orgId = ev.org_id;
    const id = randomUUID();
    const row = await db
      .insertInto("automation_offers")
      .values({
        id,
        org_id: orgId,
        account_id: audience.accountId,
        event_id: ev.id,
        source: ev.plugin,
        agent_id: audience.agentId,
      })
      .onConflict((oc) => oc.column("event_id").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (row === undefined) return;
    const [names, agentName] = await Promise.all([
      pluginDisplayNames(db, [ev.plugin]),
      this.agentName(orgId, audience.agentId),
    ]);
    const sourceName = names.get(ev.plugin)?.en ?? ev.plugin;
    try {
      const { itemId } = await this.inbox.post(
        { kind: "kernel" },
        {
          orgId,
          accountId: audience.accountId,
          kind: "automation_offer",
          title: ev.subject.title.slice(0, 200) || ev.type,
          body: `${sourceName} offers this work to ${agentName || "your agent"}. Accept to let the agent work on it as you, or decline.`,
          link: "/inbox",
          dedupeKey: `automation-offer-${id}`,
          expiresInSeconds: OFFER_TTL_SECONDS,
        },
      );
      await db
        .updateTable("automation_offers")
        .set({ inbox_item_id: itemId })
        .where("org_id", "=", orgId)
        .where("id", "=", id)
        .execute();
    } catch (err) {
      if (!(err instanceof InboxError)) throw err;
      // the offer still lists in the inbox; only its push item is missing
      this.log.warn("work offer inbox item not posted", { orgId, offerId: id, err });
    }
  }

  private async agentName(orgId: string, agentId: string): Promise<string> {
    const row = await this.kdb.db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select(sql<string | null>`agent_versions.definition->>'name'`.as("name"))
      .where("agents.org_id", "=", orgId)
      .where("agents.id", "=", agentId)
      .executeTakeFirst();
    return row?.name ?? "";
  }

  private async settle(orgId: string, eventId: string, state: "dispatched" | "undelivered") {
    await this.kdb.db
      .updateTable("trigger_events")
      .set({ state })
      .where("org_id", "=", orgId)
      .where("id", "=", eventId)
      .where("state", "=", "pending")
      .execute();
  }

  /**
   * The caller's rules (`GET automations/acceptance`): each trigger source that serves the org
   * (not switched off) and declares a directed type, with the caller's rule or null, and the org's
   * default. A source whose `events()` fails or times out is left out.
   */
  async rules(orgId: string, accountId: string): Promise<AcceptanceRulesView> {
    const db = this.kdb.db;
    const settings = await readAutomationSettings(db, this.config, orgId);
    const sources = await this.directedSources(orgId, settings);
    const stored = await db
      .selectFrom("automation_acceptance")
      .select(["source", "mode"])
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .execute();
    const mine = new Map(stored.map((r) => [r.source, r.mode]));
    const names = await this.displayNames.many(sources.map((s) => s.source));
    return {
      items: sources.map((s) => ({
        source: s.source,
        name: names.get(s.source) ?? { zh: s.source, en: s.source },
        mode: mine.get(s.source) ?? null,
      })),
      directedDefault: settings.directedDefault,
    };
  }

  /**
   * Sets the caller's rules (`PUT automations/acceptance`): each `{ source, mode }` stores the
   * rule, `mode: null` removes it (the org default applies again). A rule for a source that is not
   * a serving source with directed types is `automation.event_source_unavailable`; removing one is
   * always allowed. Returns {@link rules}.
   */
  async setRules(
    orgId: string,
    accountId: string,
    rules: readonly { source: string; mode: AcceptanceMode | null }[],
  ): Promise<AcceptanceRulesView> {
    const settings = await readAutomationSettings(this.kdb.db, this.config, orgId);
    const setting = rules.filter((r) => r.mode !== null);
    if (setting.length > 0) {
      const known = new Set((await this.directedSources(orgId, settings)).map((s) => s.source));
      const unknown = setting.find((r) => !known.has(r.source));
      if (unknown !== undefined) {
        throw eventSourceUnavailable(
          `${unknown.source} is not an event source of this organization that assigns work (it must be an enabled extension with directed event types, not switched off in the automation settings)`,
        );
      }
    }
    await this.writeRules(orgId, accountId, rules);
    return this.rules(orgId, accountId);
  }

  @Transactional()
  private async writeRules(
    orgId: string,
    accountId: string,
    rules: readonly { source: string; mode: AcceptanceMode | null }[],
  ): Promise<void> {
    const db = this.kdb.db;
    for (const r of rules) {
      if (r.mode === null) {
        await db
          .deleteFrom("automation_acceptance")
          .where("org_id", "=", orgId)
          .where("account_id", "=", accountId)
          .where("source", "=", r.source)
          .execute();
      } else {
        await db
          .insertInto("automation_acceptance")
          .values({ org_id: orgId, account_id: accountId, source: r.source, mode: r.mode })
          .onConflict((oc) =>
            oc
              .columns(["org_id", "account_id", "source"])
              .doUpdateSet({ mode: r.mode as AcceptanceMode, updated_at: sql<Date>`now()` }),
          )
          .execute();
      }
    }
    await audit(db, {
      actorAccountId: accountId,
      orgId,
      action: "automation.acceptance_changed",
      detail: { rules: rules.map((r) => ({ source: r.source, mode: r.mode })) },
    });
  }

  /** The trigger sources that serve the org, are not switched off and declare a directed type. */
  private async directedSources(
    orgId: string,
    settings: EffectiveAutomationSettings,
  ): Promise<
    { source: string; declared: TriggerEventDeclaration[]; impl: TriggerSource; config: unknown }[]
  > {
    const { providers } = await this.points.providersFor<TriggerSource>(orgId, "trigger-source");
    const ms = this.config.get().tools.timeoutMs;
    const out = await Promise.all(
      providers
        .filter((p) => !settings.eventSourcesOff.includes(p.extension))
        .map(async (p) => {
          try {
            const declared = await withDeadline(p.extension, "events()", ms, () => p.impl.events());
            return declared.some((d) => d.directed)
              ? { source: p.extension, declared, impl: p.impl, config: p.config }
              : null;
          } catch (err) {
            this.log.warn("trigger source events() failed; left out of the acceptance rules", {
              orgId,
              plugin: p.extension,
              err,
            });
            return null;
          }
        }),
    );
    return out.filter((s) => s !== null).sort((a, b) => (a.source < b.source ? -1 : 1));
  }

  /**
   * The caller's open, unexpired offers, newest first (the inbox's `automation_offer` entries).
   */
  async openOffers(orgId: string, accountId: string): Promise<AutomationOfferView[]> {
    const db = this.kdb.db;
    const rows = await db
      .selectFrom("automation_offers as o")
      .innerJoin("trigger_events as e", "e.id", "o.event_id")
      .select([
        "o.id",
        "o.source",
        "o.agent_id",
        "o.created_at",
        "e.type",
        "e.subject",
        "e.summary",
      ])
      .where("o.org_id", "=", orgId)
      .where("o.account_id", "=", accountId)
      .where("o.state", "=", "open")
      .where("o.created_at", ">", sql<Date>`now() - make_interval(secs => ${OFFER_TTL_SECONDS})`)
      .orderBy("o.created_at", "desc")
      .orderBy("o.id")
      .limit(OFFERS_LIST_MAX)
      .execute();
    if (rows.length === 0) return [];
    const names = await pluginDisplayNames(
      db,
      rows.map((r) => r.source),
    );
    const agentNames = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.agent_id)))
      agentNames.set(id, await this.agentName(orgId, id));
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      sourceName: names.get(r.source) ?? { zh: r.source, en: r.source },
      agent: { id: r.agent_id, name: agentNames.get(r.agent_id) ?? "" },
      eventType: r.type,
      subject: r.subject,
      summary: r.summary,
      createdAt: r.created_at.toISOString(),
      expiresAt: new Date(r.created_at.getTime() + OFFER_TTL_SECONDS * 1000).toISOString(),
    }));
  }

  /**
   * The person accepts their own open offer (`POST automations/offers/:id/accept`): the guards of
   * {@link route} are checked again (`automation.offer_unavailable` when one fails: the source no
   * longer serves the org or shows the subject, the agent cannot be used, automations are off, or
   * the acceptance automation is paused), then the acceptance automation is made or reused and the
   * event delivered to it, and the offer is `accepted`. Another person's offer or an unknown id is
   * `automation.offer_not_found`; one decided or expired is `automation.offer_closed`.
   */
  async accept(
    orgId: string,
    accountId: string,
    offerId: string,
  ): Promise<{ automationId: string }> {
    const { offer, ev } = await this.openOffer(orgId, accountId, offerId);
    const db = this.kdb.db;
    const settings = await readAutomationSettings(db, this.config, orgId);
    if (!settings.enabled)
      throw offerUnavailable("Automations are turned off in this organization");
    const problem = await this.audienceProblem(orgId, accountId, offer.agent_id);
    if (problem !== null) throw offerUnavailable(`This work cannot be accepted: ${problem}`);
    const source = (await this.directedSources(orgId, settings)).find(
      (s) => s.source === offer.source,
    );
    const decl = source?.declared.find((d) => d.type === ev.type && d.directed);
    if (source === undefined || decl === undefined) {
      throw offerUnavailable(
        `${offer.source} no longer assigns this work in this organization (it is off, or no longer declares the event)`,
      );
    }
    const ms = this.config.get().tools.timeoutMs;
    let seen: string[];
    try {
      seen = await withDeadline(offer.source, "visible()", ms, () =>
        source.impl.visible({
          orgId,
          accountIds: [accountId],
          subject: ev.subject,
          config: source.config,
        }),
      );
    } catch (err) {
      // a source that times out or fails cannot confirm the person still sees the item
      this.log.warn("trigger source visible() failed while accepting an offer", {
        orgId,
        offerId,
        plugin: offer.source,
        err,
      });
      throw offerUnavailable(
        `${offer.source} did not confirm that you can still see this item; try again later`,
      );
    }
    if (!seen.includes(accountId))
      throw offerUnavailable(`${offer.source} no longer shows you this item`);
    return this.acceptIn(
      orgId,
      accountId,
      offerId,
      ev,
      decl,
      directedTypes(source.declared),
      settings,
    );
  }

  @Transactional()
  private async acceptIn(
    orgId: string,
    accountId: string,
    offerId: string,
    ev: EventRow,
    decl: TriggerEventDeclaration,
    types: string[],
    settings: EffectiveAutomationSettings,
  ): Promise<{ automationId: string }> {
    const db = this.kdb.db;
    const offer = await this.lockOpen(orgId, accountId, offerId);
    const automationId = await this.ensureAutomation(
      orgId,
      accountId,
      offer.agent_id,
      offer.source,
      types,
    );
    // the accepting person is the audience; no cause run check: accepting is their own act
    const added = await deliverEvent(
      { db, outbox: this.outbox, log: this.log },
      ev,
      [automationId],
      {
        decl,
        cause: null,
        coalesceSeconds: settings.coalesceSeconds,
      },
    );
    if (added === 0) {
      throw offerUnavailable(
        "Your automation that accepts this work is paused or ended; resume it in your automations, then accept again",
      );
    }
    await db
      .updateTable("automation_offers")
      .set({ state: "accepted", automation_id: automationId, decided_at: sql<Date>`now()` })
      .where("org_id", "=", orgId)
      .where("id", "=", offerId)
      .execute();
    if (offer.inbox_item_id !== null) await this.inbox.close(orgId, offer.inbox_item_id);
    await audit(db, {
      actorAccountId: accountId,
      orgId,
      action: "automation.offer_accepted",
      target: offerId,
      detail: { source: offer.source, agentId: offer.agent_id, automationId, eventId: ev.id },
    });
    return { automationId };
  }

  /**
   * The person declines their own open offer (`POST automations/offers/:id/decline`): the offer is
   * `declined`, its inbox item resolved, and the person who caused the event (the event's
   * `cause_account_id`, else the trigger account of the run that caused it; nobody when neither,
   * or when it is the decliner) gets a kernel inbox item `automation_offer_declined`. Errors as
   * {@link accept}'s.
   */
  async decline(orgId: string, accountId: string, offerId: string): Promise<void> {
    const { ev } = await this.openOffer(orgId, accountId, offerId);
    await this.declineIn(orgId, accountId, offerId, ev);
  }

  @Transactional()
  private async declineIn(
    orgId: string,
    accountId: string,
    offerId: string,
    ev: EventRow,
  ): Promise<void> {
    const db = this.kdb.db;
    const offer = await this.lockOpen(orgId, accountId, offerId);
    await db
      .updateTable("automation_offers")
      .set({ state: "declined", decided_at: sql<Date>`now()` })
      .where("org_id", "=", orgId)
      .where("id", "=", offerId)
      .execute();
    if (offer.inbox_item_id !== null) await this.inbox.close(orgId, offer.inbox_item_id);
    await audit(db, {
      actorAccountId: accountId,
      orgId,
      action: "automation.offer_declined",
      target: offerId,
      detail: { source: offer.source, agentId: offer.agent_id, eventId: ev.id },
    });
    await this.oweDeclined(ev, { accountId, agentId: offer.agent_id }, "declined");
    const causer = await this.causerOf(orgId, ev);
    if (causer === null || causer === accountId) return;
    const [person, agentName] = await Promise.all([
      db
        .selectFrom("accounts")
        .select("display_name")
        .where("id", "=", accountId)
        .executeTakeFirst(),
      this.agentName(orgId, offer.agent_id),
    ]);
    const link = inAppLink(ev.subject.url);
    try {
      await this.inbox.post(
        { kind: "kernel" },
        {
          orgId,
          accountId: causer,
          kind: "automation_offer_declined",
          title: ev.subject.title.slice(0, 200) || ev.type,
          body: `${person?.display_name || "The person"} declined this work for ${agentName || "their agent"}.`,
          ...(link !== undefined && { link }),
          dedupeKey: `automation-offer-declined-${offerId}`,
        },
      );
    } catch (err) {
      if (!(err instanceof InboxError)) throw err;
      this.log.info("declined offer notice not posted", { orgId, offerId, err });
    }
  }

  /** Who caused `ev`: its cause account, else its cause run's trigger account, else null. */
  private async causerOf(orgId: string, ev: EventRow): Promise<string | null> {
    if (ev.cause_account_id !== null) return ev.cause_account_id;
    if (ev.cause_run_id === null) return null;
    const run = await this.kdb.db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select("runs.trigger_account_id")
      .where("runs.id", "=", ev.cause_run_id)
      .where("conversations.org_id", "=", orgId)
      .executeTakeFirst();
    return run?.trigger_account_id ?? null;
  }

  /**
   * The caller's offer `offerId` and its event, open and unexpired (see {@link accept}'s errors);
   * an offer past its life is marked `expired` (its inbox item already left the inbox).
   */
  private async openOffer(orgId: string, accountId: string, offerId: string) {
    if (!UUID_RE.test(offerId)) throw offerNotFound();
    const db = this.kdb.db;
    const offer = await db
      .selectFrom("automation_offers")
      .selectAll()
      .select(
        sql<boolean>`created_at <= now() - make_interval(secs => ${OFFER_TTL_SECONDS})`.as("past"),
      )
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("id", "=", offerId)
      .executeTakeFirst();
    if (offer === undefined) throw offerNotFound();
    if (offer.state === "open" && offer.past) {
      await db
        .updateTable("automation_offers")
        .set({ state: "expired", decided_at: sql<Date>`now()` })
        .where("org_id", "=", orgId)
        .where("id", "=", offerId)
        .where("state", "=", "open")
        .execute();
      throw offerClosed();
    }
    if (offer.state !== "open") throw offerClosed();
    const ev = await db
      .selectFrom("trigger_events")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("id", "=", offer.event_id)
      .executeTakeFirst();
    if (ev === undefined) throw offerClosed();
    return { offer, ev };
  }

  /** The caller's offer, locked, still open and unexpired; else `automation.offer_closed`. */
  private async lockOpen(orgId: string, accountId: string, offerId: string) {
    const row = await this.kdb.db
      .selectFrom("automation_offers")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("id", "=", offerId)
      .where("state", "=", "open")
      .where("created_at", ">", sql<Date>`now() - make_interval(secs => ${OFFER_TTL_SECONDS})`)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw offerClosed();
    return row;
  }
}

/**
 * {@link AcceptanceService}: the trigger dispatcher (worker) routes directed events through it; the
 * acceptance routes, the inbox and the Platform operations (API) read and decide through it.
 */
@Module({
  imports: [ExtensionsModule, AgentLookupModule, InboxItemsModule],
  providers: [AcceptanceService],
  exports: [AcceptanceService],
})
export class AcceptanceModule {}
