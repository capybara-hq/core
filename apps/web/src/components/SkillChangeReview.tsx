"use client";

import {
  Button,
  Card,
  CodeBlock,
  KeyValue,
  Skeleton,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { useRouter } from "../i18n/navigation";
import type { ApiClientError } from "../lib/api";
import { type FileChange, lineDiff, pairFiles } from "../lib/diff";
import { retryOnMountOf } from "../lib/query/client";
import { inboxChangeKeys, skillChangeQuery } from "../lib/query/inbox";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import {
  decideSkillChange,
  type SkillChange,
  type SkillChangeDetail,
  type SkillChangeFile,
} from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";
import { useSession } from "./shell/session";

/** 发起人：显示名，账号已不存在时退回 id。 */
export const requesterOf = (c: Pick<SkillChange, "requestedBy" | "requestedByName">) =>
  c.requestedByName || c.requestedBy;

/**
 * 决定技能变更（`POST /skill-changes/:id/decide`）：成功返回 true；已被处理等错误以 toast 告知并返回 false。
 * 无论成败都立即刷新顶栏的待处理数。A decision changes the agent's own skills, the change itself and the
 * inbox (invalidated here on success); the caller reads the inbox again either way.
 */
export function useDecideSkillChange(orgId: string) {
  const qc = useQueryClient();
  const session = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<"approve" | "reject">();
  const { mutateAsync } = useAppMutation({
    fn: (v: { change: SkillChange; decision: "approve" | "reject" }) =>
      decideSkillChange(orgId, v.change.id, { decision: v.decision }),
    invalidates: ({ change }) => [
      keys.org(orgId).agentSkills(change.agent.id),
      // approving a share creates an org skill, approving a version changes one
      keys.org(orgId).skills(),
      keys.org(orgId).componentsAll(),
      ...inboxChangeKeys(orgId),
    ],
    // The decided change is stale, but not read again now: the inbox hides it at once.
    onSuccess: (_, { change }) =>
      void qc.invalidateQueries({
        queryKey: keys.org(orgId).skillChange(change.id),
        refetchType: "none",
      }),
  });
  const decide = useCallback(
    async (change: SkillChange, decision: "approve" | "reject") => {
      setPending(decision);
      try {
        await mutateAsync({ change, decision });
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        setPending(undefined);
        session.refreshPending?.();
      }
    },
    [toast, errorMessage, session, mutateAsync],
  );
  return { decide, pending };
}

/** 一个文件的差异块（纯文本）；内容读不到时给说明。 */
function FileDiff({
  path,
  change,
  before,
  after,
}: {
  path: string;
  change: FileChange;
  before: SkillChangeFile | undefined;
  after: SkillChangeFile | undefined;
}) {
  const t = useTranslations("inbox.skillChange");
  const unreadable =
    (before !== undefined && before.content === null) ||
    (after !== undefined && after.content === null);
  return (
    <Stack gap={4}>
      <Text variant="small" tone={change === "unchanged" ? "faint" : "muted"}>
        {`${path} · ${t(change)}`}
      </Text>
      {change === "unchanged" ? null : unreadable ? (
        <Text variant="small" tone="faint">
          {t("contentUnavailable")}
        </Text>
      ) : (
        <section aria-label={t("diffLabel", { path })}>
          <CodeBlock language="diff" text={lineDiff(before?.content ?? "", after?.content ?? "")} />
        </section>
      )}
    </Stack>
  );
}

/**
 * A skill change card in the inbox: agent, requester, version, description, open the conversation,
 * and each file's plain-text diff against the current version. The detail (file texts and the
 * current version) comes from the query cache (the layout prefetched the first item's on a first
 * load), else it is read when the card is shown (`GET /skill-changes/:id`); a refusal or failure
 * is the files' error.
 */
export function SkillChangeReview({ orgId, change }: { orgId: string; change: SkillChange }) {
  const q = skillChangeQuery(orgId, change.id);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  return <SkillChangeCard change={change} detail={read.data} error={read.error} />;
}

function SkillChangeCard({
  change,
  detail,
  error,
}: {
  change: SkillChange;
  /** `undefined` while it loads or when it could not be read (`error`). */
  detail: SkillChangeDetail | undefined;
  error: ApiClientError | null;
}) {
  const t = useTranslations("inbox.skillChange");
  const ti = useTranslations("inbox");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const current = detail?.current ?? null;
  const conversationPath = change.conversationPath;
  return (
    <div data-skill-change-id={change.id}>
      <Card
        title={t("title", { kind: t(`kind.${change.kind}`), name: change.name })}
        actions={<StatusMark status="waiting" label={t(`kind.${change.kind}`)} />}
      >
        <Stack gap={12}>
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("agent"), v: change.agent.name },
              { k: t("requester"), v: requesterOf(change) },
              {
                k: t("version"),
                v:
                  change.kind === "share"
                    ? t("newSkill")
                    : t("update", {
                        from: current?.version ?? change.version - 1,
                        to: change.version,
                      }),
              },
            ]}
          />
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {t("description")}
            </Text>
            <Text variant="prose" pre>
              {change.description}
            </Text>
          </Stack>
          <Text variant="small" tone="muted">
            {t(`${change.kind}Hint`)}
          </Text>
          {conversationPath !== null && (
            <Stack direction="row">
              <Button onClick={() => router.push(conversationPath)}>
                {ti("openConversation")}
              </Button>
            </Stack>
          )}
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t("files")}
            </Text>
            {detail !== undefined ? (
              pairFiles(detail.files, detail.current?.files ?? []).map((f) => (
                <FileDiff key={f.path} {...f} />
              ))
            ) : error !== null ? (
              <FormError message={errorMessage(error)} />
            ) : (
              <Skeleton rows={4} />
            )}
          </Stack>
        </Stack>
      </Card>
    </div>
  );
}
