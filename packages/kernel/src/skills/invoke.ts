import {
  hasShellInjection,
  parseSkillMd,
  renderSkillInvocation,
  SKILL_ENTRY_FILE,
} from "@capybara-hq/plugin-sdk";
import type { AgentsService } from "../agents/agents.service.js";
import type { AgentDefinition } from "../agents/definition.js";
import type { EventLog } from "../conversations/event-log.js";
import type { EventPayload } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { resolveSkillForkType } from "../runtime/subagents/roster.js";
import type { StorageService } from "../storage/storage.service.js";
import { readSkillFile, SkillIntegrityError } from "../tools/builtins/skill-load.js";
import { invocationOf, type ResolvedSkill, resolveSkills } from "./catalog.js";

/**
 * A person's skill invocation (phase D spec §3, §4): the `/` menu's list of the agent's invocable
 * skills, and the rendering of `/name args` into the model-visible text of their message. The skill
 * is resolved among the agent's effective skills **at send time** (its current version, the
 * conversation's trial drafts), its SKILL.md is read from object storage and checked against the
 * manifest, and it is rendered by the SDK; nothing is executed (A1). The caller appends the text as
 * `content[0]` of the `user_message` together with {@link RenderedInvocation.skill}.
 */

/** One skill of the `/` menu (`GET …/agents/:agentId/invocable-skills`). */
export interface InvocableSkill {
  id: string;
  name: string;
  /** The plugin (catalog item) it came from. */
  plugin?: string;
  description: string;
  version: number;
  argumentHint?: string;
  arguments?: string[];
  /** Manual-only: not in the model's catalog. */
  manual: boolean;
  /** Runs as a sub-agent when a person invokes it. */
  fork: boolean;
}

/** The `skill` field of a `user_message`. */
export type InvocationRecord = NonNullable<EventPayload<"user_message">["skill"]>;

/** The result of {@link SkillInvoker.prepare}. */
export interface RenderedInvocation {
  /** The model-visible text of the person's message (`content[0]`). */
  text: string;
  skill: InvocationRecord;
  /** Fork only: the rendered skill without the lead sentence, the sub-agent's task (Task 6). */
  task?: string;
  /** Fork only: the requested sub-agent type did not resolve (stored at dispatch, §6.2). */
  warning?: string;
}

/** A leading `/<name>` or `/<plugin>:<name>`, then whitespace or the end (spec §3.2). */
const SLASH_COMMAND_RE = /^\/([a-z0-9-]+(?::[a-z0-9-]+)?)(?:\s|$)/;

/** `/name args` at the very start of a message, or null (`/etc/hosts`, ` /x`, `/Upper`). */
export const parseSlashCommand = (text: string): { name: string; args: string } | null => {
  const m = SLASH_COMMAND_RE.exec(text);
  if (!m) return null;
  return { name: m[1] as string, args: text.slice(m[0].length).trim() };
};

/** A Claude Code style qualified name `<plugin>:<skill>`. */
const QUALIFIED_RE = /^([a-z0-9][a-z0-9-]{0,63}):(.+)$/;

/** The effective skill `name` names: exactly, or `<plugin>:<name>` for a plugin's skill. */
function findSkill(all: readonly ResolvedSkill[], name: string): ResolvedSkill | undefined {
  const exact = all.find((r) => r.skill.name === name);
  if (exact) return exact;
  const m = QUALIFIED_RE.exec(name);
  if (!m) return undefined;
  return all.find((r) => r.skill.name === m[2] && r.skill.plugin === m[1]);
}

const notInvocable = (reason: "not_found" | "not_user_invocable", name: string) =>
  new ApiError(
    "skill.not_invocable",
    reason === "not_found"
      ? `Skill "${name}" is not one of this agent's skills`
      : `Skill "${name}" cannot be invoked by a person`,
    [{ reason }],
  );

/** Both wrapper tags made inert in text outside the wrapper (as the SDK's inline lead). */
const inertTags = (s: string): string =>
  s.replace(/<\/(skill_invocation)/gi, "<\\/$1").replace(/<(skill_invocation)/gi, "<\\$1");

/** The model-visible text of a fork invocation in the parent's log (spec §6.3, frozen). */
export const forkLeadText = (name: string, agentType: string, args: string): string =>
  inertTags(
    `The user ran the skill "${name}" in a sub-agent (${agentType}) with /${name}${args === "" ? "" : ` ${args}`}. The sub-agent gets the skill's instructions as its task; its report follows. Do not do the task yourself.`,
  );

/** The warning recorded when a forked skill's `agent` does not resolve (spec §6.2). */
export const forkAgentUnknownText = (name: string, agent: string): string =>
  `Skill "${name}" asked for sub-agent type "${agent}", which this agent does not have; it ran as general-purpose.`;

export interface SkillInvokerDeps {
  db: KernelDb;
  storage: StorageService;
  eventLog: Pick<EventLog, "latestOfType">;
  /** For {@link SkillInvoker.listFor} (the HTTP route's access check). */
  agents?: Pick<AgentsService, "get">;
}

export class SkillInvoker {
  constructor(private readonly d: SkillInvokerDeps) {}

  /**
   * The `/` menu for `accountId`: the agent must be usable by them (`agent.not_found`), and with
   * `conversationId` the conversation must be theirs and the agent's (`conversation.not_found`);
   * then its trial drafts apply.
   */
  async listFor(
    orgId: string,
    agentId: string,
    accountId: string,
    conversationId?: string,
  ): Promise<InvocableSkill[]> {
    if (!this.d.agents) throw new Error("SkillInvoker.listFor needs agents");
    const agent = await this.d.agents.get(orgId, agentId, accountId);
    if (conversationId !== undefined) {
      const row = await this.d.db
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", conversationId)
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("agent_id", "=", agentId)
        .where("kind", "=", "chat")
        .executeTakeFirst();
      if (!row) throw new ApiError("conversation.not_found", "Conversation not found");
    }
    return this.list({
      orgId,
      agentId,
      agent: agent.definition,
      ...(conversationId !== undefined && { conversationId }),
    });
  }

  /**
   * The agent's effective skills a person can invoke (`user` not false), sorted by name (code
   * point order), model-invocable and manual-only alike (spec §3.1).
   */
  async list(a: {
    orgId: string;
    agentId: string;
    agent: Pick<AgentDefinition, "skills">;
    conversationId?: string;
  }): Promise<InvocableSkill[]> {
    const all = await resolveSkills(this.d.db, a);
    const out: InvocableSkill[] = [];
    for (const r of all) {
      const inv = invocationOf(r.manifest);
      if (!inv.user) continue;
      out.push({
        id: r.skill.id,
        name: r.skill.name,
        ...(r.skill.plugin !== undefined && { plugin: r.skill.plugin }),
        description: r.skill.description,
        version: r.skill.version,
        ...(inv.argumentHint !== undefined && { argumentHint: inv.argumentHint }),
        ...(inv.arguments !== undefined && { arguments: inv.arguments }),
        manual: !inv.model,
        fork: inv.fork !== undefined,
      });
    }
    return out;
  }

  /**
   * Resolves `name` among the agent's effective skills now, reads its SKILL.md and renders the
   * invocation (spec §4.2, §4.3, §6.3). Refusals: `skill.not_invocable` (400); arguments or a
   * rendered text over the limits → `validation_failed` (400); a storage failure or a SKILL.md
   * that fails its integrity check → `storage.unavailable` (503). Nothing is written here.
   */
  async prepare(a: {
    orgId: string;
    agentId: string;
    /** Absent for the first message of a conversation not created yet. */
    conversationId?: string;
    agent: AgentDefinition;
    name: string;
    args: string;
  }): Promise<RenderedInvocation> {
    const all = await resolveSkills(this.d.db, a);
    const found = findSkill(all, a.name);
    if (!found) throw notInvocable("not_found", a.name);
    const inv = invocationOf(found.manifest);
    if (!inv.user) throw notInvocable("not_user_invocable", a.name);
    const body = await this.readBody(a.orgId, found);
    const others = found.manifest.files.some((f) => f.path !== SKILL_ENTRY_FILE);
    const lines = {
      ...(others && {
        files: (await this.skillLoadOffered(all, a.conversationId))
          ? ("load" as const)
          : ("unavailable" as const),
      }),
      ...(hasShellInjection(body) &&
        hasBuiltin(a.agent, "sandbox_bash") && { shellHint: true as const }),
    };
    const input = {
      name: a.name,
      skillName: found.skill.name,
      version: found.skill.version,
      body,
      invocation: inv,
      args: a.args,
      lines,
    };
    const args = a.args.trim();
    const record: InvocationRecord = {
      id: found.skill.id,
      version: found.skill.version,
      source: found.skill.source,
      name: found.skill.name,
      ...(found.skill.plugin !== undefined && { plugin: found.skill.plugin }),
      arguments: args,
      mode: inv.fork ? "fork" : "inline",
    };
    if (!inv.fork) return { text: rendered(() => renderSkillInvocation(input)), skill: record };
    const task = rendered(() => renderSkillInvocation({ ...input, lead: false }));
    const type = await resolveSkillForkType(
      this.d.db,
      a.orgId,
      a.agent,
      inv.fork.agent,
      found.skill.plugin,
    );
    return {
      text: forkLeadText(a.name, type.agentType, args),
      skill: { ...record, agentType: type.agentType },
      task,
      ...(type.unknown !== undefined && {
        warning: forkAgentUnknownText(a.name, type.unknown),
      }),
    };
  }

  /** Reads and parses the version's SKILL.md (checked against the manifest), returns the body. */
  private async readBody(orgId: string, r: ResolvedSkill): Promise<string> {
    const unreadable = (problem: string) =>
      new ApiError("storage.unavailable", `Skill ${r.skill.name} ${problem}`, [
        { reason: "skill_unreadable", skillId: r.skill.id, name: r.skill.name },
      ]);
    const md = r.manifest.files.find((f) => f.path === SKILL_ENTRY_FILE);
    if (!md) throw unreadable(`has no ${SKILL_ENTRY_FILE}`);
    this.d.storage.assertAvailable();
    let bytes: Uint8Array;
    try {
      bytes = await readSkillFile(
        this.d.storage.kernel(orgId),
        `${r.skill.source}${SKILL_ENTRY_FILE}`,
        md,
      );
    } catch (e) {
      if (e instanceof SkillIntegrityError) throw unreadable("failed its integrity check");
      if (e instanceof ApiError) throw e;
      throw new ApiError("storage.unavailable", "File storage is temporarily unavailable");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw unreadable("is not UTF-8");
    }
    const parsed = parseSkillMd(text, { invocationKeys: false });
    if ("errors" in parsed) throw unreadable("cannot be parsed");
    return parsed.body;
  }

  /**
   * Whether the conversation's next run offers `skill_load` (the request builder's rule,
   * `skillLoadOffered`): its log already has a skills catalog snapshot, or the run will write one
   * because the model's catalog is not empty.
   */
  private async skillLoadOffered(
    all: readonly ResolvedSkill[],
    conversationId: string | undefined,
  ): Promise<boolean> {
    if (all.some((r) => invocationOf(r.manifest).model)) return true;
    if (conversationId === undefined) return false;
    return (await this.d.eventLog.latestOfType(conversationId, "skills_catalog")) !== undefined;
  }
}

const hasBuiltin = (agent: Pick<AgentDefinition, "tools">, name: string): boolean =>
  (agent.tools ?? []).some((t) => t.kind === "builtin" && t.name === name);

/** Runs an SDK render; its `RangeError` (a size limit) becomes a 400 on `text`. */
function rendered(render: () => string): string {
  try {
    return render();
  } catch (e) {
    if (e instanceof RangeError) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "text", message: `${e.message}; shorten the arguments` },
      ]);
    }
    throw e;
  }
}
