import { getLocale } from "next-intl/server";
import type { ViewState } from "../../../../../components/extension-ui/ExtensionViewTab";
import { NoAccess } from "../../../../../components/RoleGate";
import { ApiClientError } from "../../../../../lib/api";
import { isKernelUnavailable, isSignedOut, read } from "../../../../../lib/server/page";
import { workspace } from "../../../../../lib/server/session";
import { getUiView, listUiContributions, uiLocale } from "../../../../../lib/ui";
import PluginPageView from "./view";

/**
 * `/p/[plugin]/[id]` (anyone in the org): the org's UI contributions (required) and, for a view,
 * the view itself, read on the server. A view the extension fails is that view's own error state
 * (each extension block fails alone); an embed's token request stays in the browser.
 */
export default async function PluginPage({
  params,
}: {
  params: Promise<{ plugin: string; id: string }>;
}) {
  const ws = await workspace();
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const p = await params;
  const plugin = decodeURIComponent(p.plugin);
  const id = decodeURIComponent(p.id);
  const { items } = await read(listUiContributions(ws.orgId));
  const contribution = items.find((c) => c.plugin === plugin && c.id === id && c.place === "page");
  const view: ViewState | undefined =
    contribution?.kind === "view"
      ? await read(
          getUiView(ws.orgId, plugin, id, { locale: uiLocale(await getLocale()) }).then(
            ({ view }): ViewState => ({ kind: "ready", view }),
            (e: unknown): ViewState => {
              if (!(e instanceof ApiClientError)) throw e;
              const { code } = e;
              if (isSignedOut(e) || isKernelUnavailable(e)) throw e;
              return { kind: "error", code };
            },
          ),
        )
      : undefined;
  return (
    <PluginPageView
      orgId={ws.orgId}
      plugin={plugin}
      id={id}
      contribution={contribution}
      view={view}
    />
  );
}
