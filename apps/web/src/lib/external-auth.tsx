"use client";

import { useToast } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExternalAuthDialog } from "../components/ExternalAuthDialog";
import { labelLocale } from "./extension-label";
import { splitSource } from "./identities";
import { identitiesQuery } from "./query/account";
import { connectorQuery } from "./query/conversation";
import { keys } from "./query/keys";
import { meQuery } from "./query/shell";

/**
 * Waiting for an authorization that finishes in the system browser (spec
 * 2026-11-28-shell-external-authorization-design.md §4). A start that got a `handoffUrl` calls
 * `useExternalAuth().open(url, target)` after opening the browser; the provider (mounted once in
 * the app frame) shows {@link ExternalAuthDialog} and, while it is open, invalidates the target's
 * queries on open and whenever the window regains focus or becomes visible. Once the connector is
 * connected (or the login method linked), having been seen unconnected since the dialog opened, the
 * dialog closes with the success toast. The deep link back into the app reloads the page with the
 * result parameters instead, which the result toasts cover.
 */

/** What an external authorization is for: a connector's OAuth or linking a login method. */
export type ExternalAuthTarget =
  | { kind: "connector"; orgId: string; connectorId: string }
  | { kind: "identity-link"; plugin: string };

interface ExternalAuth {
  open(url: string, target: ExternalAuthTarget): void;
}

// Outside the provider (a test rendering a single component) nothing is shown.
const ExternalAuthContext = createContext<ExternalAuth>({ open: () => {} });

/** Opens the waiting dialog for a handoff URL already handed to the system browser. */
export const useExternalAuth = (): ExternalAuth => useContext(ExternalAuthContext);

type Pending = { url: string; target: ExternalAuthTarget; id: number };

export function ExternalAuthProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const seq = useRef(0);
  const close = useCallback(() => setPending(null), []);
  const value = useMemo<ExternalAuth>(
    () => ({
      open: (url, target) => {
        seq.current += 1;
        setPending({ url, target, id: seq.current });
      },
    }),
    [],
  );
  return (
    <ExternalAuthContext.Provider value={value}>
      {children}
      {pending === null ? null : <Waiting key={pending.id} pending={pending} onClose={close} />}
    </ExternalAuthContext.Provider>
  );
}

function Waiting({ pending, onClose }: { pending: Pending; onClose(): void }) {
  const t = useTranslations("externalAuth");
  const toast = useToast();
  const qc = useQueryClient();
  const { target } = pending;
  // the identities key needs the account id; read only for a link
  const me = useQuery({ ...meQuery(), enabled: target.kind === "identity-link" }).data;
  const accountId = me?.account.id;

  const refresh = useCallback(() => {
    if (target.kind === "connector") {
      const k = keys.org(target.orgId);
      void qc.invalidateQueries({ queryKey: k.connector(target.connectorId) });
      void qc.invalidateQueries({ queryKey: k.connectors() });
    } else if (accountId !== undefined) {
      void qc.invalidateQueries({ queryKey: keys.account(accountId).identities() });
    }
  }, [qc, target, accountId]);

  useEffect(() => {
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pending.url);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <>
      <ExternalAuthDialog
        open
        onCopy={() => void copy()}
        onDone={() => {
          refresh();
          onClose();
        }}
        onCancel={onClose}
      />
      {target.kind === "connector" ? (
        <ConnectorWatch orgId={target.orgId} connectorId={target.connectorId} onDone={onClose} />
      ) : accountId !== undefined ? (
        <LinkWatch accountId={accountId} plugin={target.plugin} onDone={onClose} />
      ) : null}
    </>
  );
}

/** Closes with the success toast once the connector turns connected. */
function ConnectorWatch({
  orgId,
  connectorId,
  onDone,
}: {
  orgId: string;
  connectorId: string;
  onDone(): void;
}) {
  const t = useTranslations("connect.result");
  const toast = useToast();
  const status = useQuery(connectorQuery(orgId, connectorId)).data?.credential.status;
  const seenMissing = useRef(false);
  useEffect(() => {
    if (status === "missing") seenMissing.current = true;
    else if (status === "connected" && seenMissing.current) {
      seenMissing.current = false;
      toast.success(t("connected"));
      onDone();
    }
  }, [status, toast, t, onDone]);
  return null;
}

/** Closes with the success toast once the login method appears among the linked identities. */
function LinkWatch({
  accountId,
  plugin,
  onDone,
}: {
  accountId: string;
  plugin: string;
  onDone(): void;
}) {
  const t = useTranslations("identities");
  const locale = labelLocale(useLocale());
  const toast = useToast();
  const data = useQuery(identitiesQuery(accountId)).data;
  const linked = data?.identities.find(
    (x) => splitSource(x.source).plugin === plugin && x.login === "on",
  );
  const linkedLabel = linked?.label[locale];
  const seenUnlinked = useRef(false);
  useEffect(() => {
    if (data === undefined) return;
    if (linkedLabel === undefined) seenUnlinked.current = true;
    else if (seenUnlinked.current) {
      seenUnlinked.current = false;
      toast.success(t("linked", { platform: linkedLabel }));
      onDone();
    }
  }, [data, linkedLabel, toast, t, onDone]);
  return null;
}
