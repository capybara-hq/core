import type { Logger } from "@capybara-hq/plugin-sdk";
import type { AgentDefinition } from "../../agents/definition.js";
import type { EventPayload } from "../../conversations/events.js";
import { ApiError } from "../../errors.js";
import type { SkillInvoker } from "../../skills/invoke.js";
import type { ToolStepContext } from "../../tools/pipeline.js";
import type { TemplateSkill } from "./definition.js";

/**
 * A template's skills at child start (Claude Code's sub-agent `skills`, skills default-on spec
 * §6.1): the dispatch writes one skill invocation message per skill the child has, after its task
 * message and in the same transaction, so the child starts with the instructions instead of
 * spending model steps on `Skill` calls. Each message is a `user_message` with the `skill` record
 * (`mode: "inline"`, no arguments, `template: true`: nobody typed it) and the version's rendered
 * `<skill_invocation>` text, as an inline invocation is logged: the text is fixed in the log
 * (replay never renders it again), and the record lets the child's `Skill` copy the files of that
 * version.
 */

/** The lead of a template skill's invocation message (model-visible, English). */
export const templateSkillLeadText = (name: string): string =>
  `Your sub-agent type comes with the skill "${name}"; its instructions follow. Use them for this task.`;

/** The message of a template skill whose SKILL.md could not be read at dispatch. */
export const templateSkillUnreadableText = (name: string): string =>
  `Your sub-agent type comes with the skill "${name}", but it could not be read when you started; load it with Skill before you use it.`;

/** The dispatch warning of a template skill that could not be read or rendered (not model-visible). */
export const templateSkillUnreadableWarning = (name: string): string =>
  `The skill "${name}" could not be read at dispatch; the sub-agent was told to load it with Skill.`;

type UserMessage = { type: "user_message"; payload: EventPayload<"user_message"> };

/**
 * The invocation messages of `skills` for the child's effective definition `child` (its tools
 * decide the shell line), read from the versions its catalog lists. A version that cannot be read
 * or rendered (storage down, integrity, over the size limit) gets {@link
 * templateSkillUnreadableText} instead and a dispatch warning ({@link
 * templateSkillUnreadableWarning}, for `subagent_started.warnings`), and the dispatch goes on.
 * Null when the run's signal aborted before a read: the dispatch writes nothing.
 */
export async function templateSkillMessages(
  d: { invoker: Pick<SkillInvoker, "renderTask">; log: Pick<Logger, "warn"> },
  a: { ctx: ToolStepContext; child: AgentDefinition; skills: readonly TemplateSkill[] },
): Promise<{ messages: UserMessage[]; warnings: string[] } | null> {
  const messages: UserMessage[] = [];
  const warnings: string[] = [];
  for (const s of a.skills) {
    // a stopped run reads no more skill files (as the fork path checks before its read)
    if (a.ctx.signal.aborted) return null;
    const record: NonNullable<EventPayload<"user_message">["skill"]> = {
      id: s.id,
      version: s.version,
      source: s.source,
      name: s.name,
      ...(s.plugin !== undefined && { plugin: s.plugin }),
      arguments: "",
      mode: "inline",
      template: true,
    };
    let text: string;
    try {
      const { task } = await d.invoker.renderTask({
        orgId: a.ctx.orgId,
        conversationId: a.ctx.conversationId,
        skill: record,
      });
      text = `${templateSkillLeadText(s.name)}\n\n${task(a.child)}`;
    } catch (e) {
      if (!(e instanceof ApiError) && !(e instanceof RangeError)) throw e;
      d.log.warn("template skill not loaded at dispatch", {
        orgId: a.ctx.orgId,
        conversationId: a.ctx.conversationId,
        skillId: s.id,
        version: s.version,
        err: e,
      });
      messages.push(message(a.ctx, templateSkillUnreadableText(s.name)));
      warnings.push(templateSkillUnreadableWarning(s.name));
      continue;
    }
    messages.push(message(a.ctx, text, record));
  }
  return { messages, warnings };
}

const message = (
  ctx: ToolStepContext,
  text: string,
  skill?: NonNullable<EventPayload<"user_message">["skill"]>,
): UserMessage => ({
  type: "user_message",
  payload: {
    content: [{ type: "text", text }],
    ...(skill !== undefined && { skill }),
    authorAccountId: ctx.accountId,
  },
});
