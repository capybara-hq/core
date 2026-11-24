"use client";

import {
  Button,
  Dialog,
  Field,
  Input,
  RadioGroup,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { issueLines } from "../lib/api";
import {
  addMarketplace,
  type Marketplace,
  type MarketplaceForm,
  updateMarketplace,
} from "../lib/catalog";
import { suggestGitUsernameForUrl } from "../lib/git-usernames";
import { marketplacesQuery } from "../lib/query/admin";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { useCatalogErrorLines } from "./CatalogParts";
import { FormError } from "./form-error";

/**
 * What a change to a marketplace changes besides the marketplaces: the entries to browse, the
 * catalog's "newer in the marketplace" marks, the overview (its plugin updates) and the platform
 * audit log.
 */
export const sourceChangeKeys = (): (readonly unknown[])[] => [
  keys.deployment().marketplaceEntriesAll(),
  keys.deployment().catalog(),
  keys.deployment().catalogItemsAll(),
  keys.deployment().adminOverview(),
  keys.deployment().platformAuditAll(),
];

export type Problem = { message: string; extra: string[] };

/** The error and its detail lines (the kernel's line naming the host or ref for git / network codes). */
export function useProblem(): (e: unknown) => Problem {
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  return (e) => ({ message: errorMessage(e), extra: [...issueLines(e), ...catalogLines(e)] });
}

/**
 * Adding a marketplace source (`source` left out) or editing a custom one: a marketplace.json URL,
 * or a git repository (`form: "git"`, with an optional ref; the kernel also recognises
 * `owner/repo` and `….git` URLs by themselves). The token is never shown: blank keeps it, and an
 * edit of a source with a token can clear it. The form is chosen when adding, not changed after.
 */
export function MarketplaceSourceDialog({
  open,
  onClose,
  source,
}: {
  open: boolean;
  onClose(): void;
  source?: Marketplace;
}) {
  // Mounted only while open, so each opening starts from the source (or empty)
  if (!open) return null;
  return <SourceForm onClose={onClose} {...(source !== undefined ? { source } : {})} />;
}

function SourceForm({ onClose, source }: { onClose(): void; source?: Marketplace }) {
  const t = useTranslations("catalog.admin.marketplaces");
  const toast = useToast();
  const problem = useProblem();
  const editing = source !== undefined;
  const [form, setForm] = useState<MarketplaceForm>(source?.form ?? "http");
  const [name, setName] = useState(source?.name ?? "");
  const [url, setUrl] = useState(source?.url ?? "");
  const [ref, setRef] = useState(source?.ref ?? "");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState(source?.username ?? "");
  // Once the admin edits the username, a suggestion never overwrites it
  const [usernameTouched, setUsernameTouched] = useState(editing);
  // The value the last suggestion filled in: the field follows the host while it still holds it
  const [lastSuggested, setLastSuggested] = useState("");
  const [busy, setBusy] = useState<"save" | "token">();
  const [error, setError] = useState<Problem>();
  // 清除令牌 answered: the dialog stays open on the source as it was before, without a token
  const [tokenCleared, setTokenCleared] = useState(false);
  const hasToken = editing && source.hasToken && !tokenCleared;
  const git = form === "git";
  const invalidates = () => [marketplacesQuery().queryKey, ...sourceChangeKeys()];
  const create = useAppMutation({ fn: addMarketplace, invalidates });
  const update = useAppMutation({
    fn: (body: Parameters<typeof updateMarketplace>[1]) =>
      updateMarketplace(source?.id ?? "", body),
    invalidates,
  });

  const refChanged = git && ref.trim() !== (source?.ref ?? "");
  const usernameChanged = git && username.trim() !== (source?.username ?? "");
  const dirty =
    !editing ||
    name.trim() !== source.name ||
    url.trim() !== source.url ||
    token !== "" ||
    refChanged ||
    usernameChanged;
  const valid = name.trim() !== "" && url.trim() !== "";

  const run = async (
    kind: NonNullable<typeof busy>,
    op: () => Promise<Marketplace>,
    keepOpen = false,
  ) => {
    setBusy(kind);
    setError(undefined);
    try {
      const done = await op();
      toast.success(t(editing ? "saved" : "added", { name: done.name }));
      if (keepOpen) setBusy(undefined);
      else onClose();
    } catch (e) {
      setError(problem(e));
      setBusy(undefined);
    }
  };

  const save = () =>
    run("save", () =>
      editing
        ? update.mutateAsync({
            ...(name.trim() !== source.name && { name: name.trim() }),
            ...(url.trim() !== source.url && { url: url.trim() }),
            ...(refChanged && { ref: ref.trim() === "" ? null : ref.trim() }),
            ...(usernameChanged && { username: username.trim() === "" ? null : username.trim() }),
            ...(token !== "" && { token }),
          })
        : create.mutateAsync({
            name: name.trim(),
            url: url.trim(),
            ...(git && {
              form,
              ...(ref.trim() !== "" && { ref: ref.trim() }),
              ...(username.trim() !== "" && { username: username.trim() }),
            }),
            ...(token !== "" && { token }),
          }),
    );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && busy === undefined) onClose();
      }}
      title={editing ? t("editTitle", { name: source.name }) : t("add")}
      size={640}
      footer={
        <>
          <Button variant="ghost" disabled={busy !== undefined} onClick={onClose}>
            {t("cancel")}
          </Button>
          {hasToken && (
            <Button
              loading={busy === "token"}
              disabled={busy !== undefined}
              onClick={() =>
                void run(
                  "token",
                  async () => {
                    const next = await update.mutateAsync({ token: null });
                    setTokenCleared(true);
                    return next;
                  },
                  true,
                )
              }
            >
              {t("clearToken")}
            </Button>
          )}
          <Button
            variant="primary"
            loading={busy === "save"}
            disabled={busy !== undefined || !dirty || !valid}
            onClick={() => void save()}
          >
            {editing ? t("save") : t("addConfirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        {!editing && (
          <RadioGroup
            label={t("form")}
            value={form}
            onChange={(v) => setForm(v as MarketplaceForm)}
            options={[
              { value: "http", label: t("formHttp") },
              { value: "git", label: t("formGit") },
            ]}
          />
        )}
        <Field label={t("name")} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("url")} required {...(git && { help: t("gitUrlHelp") })}>
          <Input
            value={url}
            placeholder={git ? "owner/repo" : "https://"}
            onChange={(e) => {
              setUrl(e.target.value);
              // Follow the host: fill an empty username or replace the last suggestion (never a typed value)
              if (git && !usernameTouched && (username === "" || username === lastSuggested)) {
                const next = suggestGitUsernameForUrl(e.target.value) ?? "";
                setUsername(next);
                setLastSuggested(next);
              }
            }}
          />
        </Field>
        {git && (
          <>
            <Field label={t("ref")} help={t("refHelp")} optional>
              <Input value={ref} onChange={(e) => setRef(e.target.value)} />
            </Field>
            <Field label={t("username")} help={t("usernameHelp")} optional>
              <Input
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setUsernameTouched(true);
                }}
              />
            </Field>
          </>
        )}
        <Field label={t("token")} help={hasToken ? t("tokenSet") : t("tokenHelp")} optional>
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
        {!editing && (
          <Text variant="small" tone="muted">
            {t("customHint")}
          </Text>
        )}
      </Stack>
    </Dialog>
  );
}
