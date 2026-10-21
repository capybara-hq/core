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
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError } from "../lib/api";
import { type FileChange, lineDiff, pairFiles } from "../lib/diff";
import {
  decideSkillChange,
  getSkillChange,
  type SkillChange,
  type SkillChangeFile,
} from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";
import { useLoad } from "../lib/use-load";
import { FormError } from "./form-error";
import { useSession } from "./shell/session";

/** 发起人：显示名，账号已不存在时退回 id。 */
export const requesterOf = (c: Pick<SkillChange, "requestedBy" | "requestedByName">) =>
  c.requestedByName || c.requestedBy;

/**
 * 决定技能变更（`POST /skill-changes/:id/decide`）：成功返回 true；已被处理等错误以 toast 告知并返回 false。
 * 无论成败都立即刷新顶栏的待处理数。
 */
export function useDecideSkillChange(orgId: string) {
  const session = useSession();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState<"approve" | "reject">();
  const decide = useCallback(
    async (id: string, decision: "approve" | "reject") => {
      setPending(decision);
      try {
        await decideSkillChange(orgId, id, { decision });
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        setPending(undefined);
        session.refreshPending?.();
      }
    },
    [orgId, toast, errorMessage, session],
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
 * 收件箱里的技能变更卡片：agent、发起人、版本、描述、打开发起对话，以及每个文件相对当前版本的差异
 * （纯文本 `+ / -`）。详情（含文件文本与当前版本）按需读取 `GET /skill-changes/:id`。
 */
export function SkillChangeReview({ orgId, change }: { orgId: string; change: SkillChange }) {
  const t = useTranslations("inbox.skillChange");
  const ti = useTranslations("inbox");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const { me } = useSession();
  const { state } = useLoad(
    () => getSkillChange(orgId, change.id).then((r) => r.skillChange),
    [orgId, change.id],
  );
  const detail = state.kind === "ready" ? state.data : undefined;
  const current = detail?.current ?? null;
  return (
    <div data-skill-change-id={change.id}>
      <Card
        title={t("title", { name: change.name })}
        actions={<StatusMark status="waiting" label={t("label")} />}
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
                  change.skillId === null || (detail !== undefined && current === null)
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
            <Text pre>{change.description}</Text>
          </Stack>
          <Text variant="small" tone="muted">
            {t("ownerHint")}
          </Text>
          {change.requestedBy === me.account.id && (
            <Text variant="small" tone="muted">
              {t("selfHint")}
            </Text>
          )}
          <Stack direction="row">
            <Button onClick={() => router.push(change.conversationPath)}>
              {ti("openConversation")}
            </Button>
          </Stack>
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t("files")}
            </Text>
            {state.kind === "loading" ? (
              <Skeleton rows={4} />
            ) : state.kind === "error" ? (
              <FormError message={errorMessage(new ApiClientError(0, state.code, ""))} />
            ) : (
              pairFiles(state.data.files, state.data.current?.files ?? []).map((f) => (
                <FileDiff key={f.path} {...f} />
              ))
            )}
          </Stack>
        </Stack>
      </Card>
    </div>
  );
}
