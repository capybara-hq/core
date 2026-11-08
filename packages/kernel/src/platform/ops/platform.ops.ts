import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import type { AgentView } from "../../agents/agent-lookup.js";
import { AgentsService } from "../../agents/agents.service.js";
import { AccountsService } from "../../identity/accounts.js";
import { PreferencesSchema } from "../../identity/me.schemas.js";
import { can, type OrgAction } from "../../orgs/roles.js";
import { effectiveSandboxEgress, OrgSettingsService } from "../../orgs/settings.service.js";
import { ThemesService } from "../../themes/themes.service.js";
import { SANDBOX_TOOL_NAMES } from "../../tools/builtin-names.js";
import { ToolRegistry } from "../../tools/registry.js";
import { PlatformActor } from "../actor.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";

/** What a role may build, as the model says it to the person: the action and its plain words. */
const BUILDS: readonly { action: OrgAction; what: string }[] = [
  { action: "agents.create", what: "create private agents and edit the agents you own" },
  { action: "skills.manage", what: "create org skills" },
  { action: "agents.manage", what: "manage other people's agents and save org agent templates" },
  { action: "connectors.manage", what: "set up connectors" },
  { action: "org.extensions.manage", what: "manage extensions" },
];

const FAMILIES = [
  "Platform: this tool, for the org's skills, agents, agent templates, plugins, connectors and requests.",
  "Skill and SkillWrite: use and write the skills of this agent.",
  "Agent, SendMessage, SubagentHandback: dispatch and talk to sub-agents.",
  "Bash, Read, Write, Edit, Glob, Grep, Deliver: work in the conversation's sandbox.",
  "WebSearch, WebFetch: reach the web through the org's providers.",
  "Plugin and connector tools, named plugin__<plugin>__<tool> and mcp__<connector>__<tool>.",
];

const EMPTY = z.object({}).strict();

/**
 * The `platform` domain: orientation and what this agent is (spec §7, synthetic), and the
 * person's own preferences (`/me/preferences`).
 */
@Injectable()
export class PlatformOperationsProvider implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(PlatformActor) private readonly actor: PlatformActor,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(OrgSettingsService) private readonly settings: OrgSettingsService,
    @Inject(ToolRegistry) private readonly tools: ToolRegistry,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ThemesService) private readonly themes: ThemesService,
  ) {}

  /**
   * The agent's tools by the keys the model sees, as the registry resolves them for a run (tools
   * default-on spec §8): every tool the org offers that the definition does not turn off, builtins
   * by name, extension tools as `plugin__<plugin>__<tool>`, connector tools as
   * `mcp__<slug>__<tool>`; the ones that cannot load now are listed with the registry's reason.
   */
  private async toolKeys(orgId: string, d: AgentView["definition"]) {
    const resolved = await this.tools.forAgent(orgId, {
      disabledTools: d.disabledTools ?? [],
      subagentTools: d.subagentTools,
      subagents: d.subagents,
    });
    return {
      keys: [...new Set(resolved.tools.map((t) => t.key))],
      unavailable: [...resolved.unavailable, ...(resolved.hidden ?? [])].map((u) => ({
        tool: u.ref,
        reason: u.reason,
      })),
    };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "platform.overview",
        description:
          "Explain what the platform is, the tool families you have, your role in this org and what that role may build, and the operation domains to browse. Start here when asked what you can do on the platform.",
        input: EMPTY,
        example: {},
        authz: { orgAction: "org.read" },
        mirrors: [],
        confirm: "read",
        run: async (_input, ctx) => {
          const facts = await this.actor.facts({
            orgId: ctx.orgId,
            accountId: ctx.actorAccountId,
            agentId: ctx.agentId,
            conversationId: ctx.conversationId,
            runId: ctx.runId,
          });
          const role = facts.role;
          return {
            platform:
              "Capybara is an enterprise agent platform: orgs of people build and use agents that work with skills, tools and connectors. Everything it can do is offered by extensions and plugins.",
            toolFamilies: FAMILIES,
            you: {
              role,
              isSuperAdmin: facts.isSuperAdmin,
              canBuild:
                role === null ? [] : BUILDS.filter((b) => can(role, b.action)).map((b) => b.what),
              platformToolSetting: facts.setting,
              personPresent: facts.personPresent,
            },
            domains: this.registry.domains(),
            next: 'Use action "browse" with a domain to see its operations, then "describe" before "call".',
          };
        },
      }),
      defineOperation({
        id: "platform.me",
        description:
          "Show this agent as configured: its model, the tools it has now by the keys you call them by (every tool the org offers unless the agent turns it off; connector tools as mcp__<connector>__<tool>, with those that cannot load now and why), the tools it turns off (disabledTools), skills (org and pinned), sub-agents, whether it runs in a sandbox, the sandbox network mode, and its profile (avatar, description, quick actions). Secrets are never shown.",
        input: EMPTY,
        example: {},
        authz: { orgAction: "agents.use" },
        mirrors: [],
        confirm: "read",
        run: async (_input, ctx) => {
          const agent = await this.agents.get(ctx.orgId, ctx.agentId, ctx.actorAccountId);
          const d = agent.definition;
          const { keys: toolKeys, unavailable } = await this.toolKeys(ctx.orgId, d);
          const sandbox = toolKeys.some((k) =>
            (SANDBOX_TOOL_NAMES as readonly string[]).includes(k),
          );
          const org = await this.settings.get(ctx.orgId);
          const dep = this.settings.deployment().sandboxEgress;
          const egress = effectiveSandboxEgress(
            { egress: dep.mode, allowHosts: dep.allowHosts },
            org.sandboxEgress,
          );
          return {
            id: agent.id,
            name: d.name,
            visibility: agent.visibility,
            version: agent.currentVersion,
            model: d.model,
            fallback: d.fallback,
            tools: toolKeys,
            ...(unavailable.length > 0 && { unavailableTools: unavailable }),
            disabledTools: d.disabledTools ?? [],
            toolPolicies: d.toolPolicies,
            skills: {
              orgSkills: d.skills?.orgSkills ?? [],
              pinned: d.skills?.pinned ?? [],
            },
            subagents: d.subagents ?? null,
            sandbox: sandbox ? { enabled: true, egress: egress.egress } : { enabled: false },
            profile: {
              avatar: agent.profile.avatar,
              description: agent.profile.description,
              quickActions: agent.profile.quickActions,
            },
          };
        },
      }),
      defineOperation({
        id: "platform.preferences",
        description:
          "Read your own preferences: your time zone (an IANA name such as Asia/Shanghai, or null when it follows the time zone of the browser you send messages from; the run context already tells you the zone in effect for this message) and your theme (a theme id, or null when you follow the org's theme; themes.list names them).",
        input: EMPTY,
        example: {},
        // any signed-in person may call the route; every run's actor is a member of this org
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/me/preferences"],
        confirm: "read",
        run: async (_input, ctx) => this.accounts.preferences(ctx.actorAccountId),
      }),
      defineOperation({
        id: "platform.set-preferences",
        description:
          "Change your own preferences; give only the ones to change, the others keep their values. timeZone: an IANA name such as Europe/Berlin, or null to follow the time zone of the browser you send messages from; it applies to the messages you send afterwards, on the web and in IM (the current run keeps its zone). theme: a theme id from themes.list (it applies in every org where that theme is on and personal picks are allowed), or null to follow the org's theme.",
        input: PreferencesSchema.refine((i) => Object.values(i).some((v) => v !== undefined), {
          message: "give timeZone, theme or both",
        }),
        example: { timeZone: "Asia/Shanghai" },
        authz: { orgAction: "agents.use" },
        mirrors: ["PUT /api/v1/me/preferences"],
        confirm: "personal",
        errors: [
          {
            code: "validation_failed",
            next: "Use an IANA time zone name such as Asia/Shanghai or America/New_York, or null.",
          },
          {
            code: "theme.not_available",
            next: "Pick a theme id that themes.list shows for this org, or null to follow the org's theme.",
          },
        ],
        summary: async (input, ctx) => {
          const now = await this.accounts.preferences(ctx.actorAccountId);
          const zh: string[] = [];
          const en: string[] = [];
          if (input.timeZone !== undefined) {
            const from = now.timeZone;
            zh.push(
              `把你的时区从「${from ?? "跟随浏览器"}」改为「${input.timeZone ?? "跟随浏览器"}」`,
            );
            en.push(
              `Change your time zone from "${from ?? "follow the browser"}" to "${input.timeZone ?? "follow the browser"}"`,
            );
          }
          if (input.theme !== undefined) {
            const name = async (id: string | null) =>
              id === null ? null : ((await this.themes.nameOf(id)) ?? { en: id, zh: id });
            const from = await name(now.theme);
            const to = await name(input.theme);
            const inZh = (n: typeof from) => (n === null ? "跟随组织" : n.zh);
            const inEn = (n: typeof from) => (n === null ? "follow the org" : n.en);
            zh.push(`把你的主题从「${inZh(from)}」改为「${inZh(to)}」`);
            en.push(`Change your theme from "${inEn(from)}" to "${inEn(to)}"`);
          }
          return { zh: zh.join("；"), en: en.join("; ") };
        },
        run: async (input, ctx) =>
          this.accounts.setPreferences(ctx.actorAccountId, {
            timeZone: input.timeZone,
            theme: input.theme,
          }),
      }),
    ]);
  }
}
