"use client";

import { Badge, Button, Card, Field, Select, Stack, Text, useToast } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { findModel, keepDeclared, type ParamValue, type ProviderModels } from "../lib/agents";
import {
  decodeModel,
  encodeModel,
  type PurposeTarget,
  type PurposeView,
  targetIssues,
  targetName,
} from "../lib/models";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";
import { ModelParams } from "./ModelParams";

type Params = Record<string, ParamValue>;

/** 参数比较（键顺序无关）。 */
const sameParams = (a: Params, b: Params) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && b[k] === v);

/**
 * 一个模型用途的编辑卡片（后台部署默认与组织覆盖共用）：
 * - `scope: "deployment"`：编辑部署默认（`view.default`），已设置时可清除；
 * - `scope: "org"`：显示部署默认，编辑本组织的覆盖（`view.override`），已覆盖时可恢复默认。
 * 选中模型后按该模型的参数声明渲染参数（复用 ModelParams，换模型时用 keepDeclared 保留仍合法的参数）。
 * 插件声明的用途旁注「插件调用模型尚未开放」。内核 `validation_failed` 的明细落到模型 / 对应参数上。
 */
export function PurposeEditor({
  view,
  providers,
  scope,
  save,
  onSaved,
}: {
  view: PurposeView;
  providers: ProviderModels[];
  scope: "deployment" | "org";
  save(target: PurposeTarget | null): Promise<PurposeView>;
  onSaved(view: PurposeView): void;
}) {
  const t = useTranslations("models.purpose");
  const tp = useTranslations("agents.params");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const saved = scope === "deployment" ? view.default : view.override;
  const savedModel = saved === null ? "" : encodeModel(saved.model);
  const [model, setModel] = useState(savedModel);
  const [params, setParams] = useState<Params>(saved?.params ?? {});
  // 保存后（或父组件换了视图）草稿回到新的已保存值：渲染期间按已保存值的指纹重置，不重新挂载（保留焦点）
  const savedKey = JSON.stringify(saved);
  const [seenKey, setSeenKey] = useState(savedKey);
  if (seenKey !== savedKey) {
    setSeenKey(savedKey);
    setModel(savedModel);
    setParams(saved?.params ?? {});
  }
  const [busy, setBusy] = useState<"save" | "clear">();
  const [error, setError] = useState<{
    message?: string;
    extra: string[];
    model?: boolean;
    params: Record<string, string>;
  }>();

  const ref = decodeModel(model);
  const decl = ref === null ? [] : (findModel(providers, ref)?.parameters ?? []);
  const dirty = model !== savedModel || !sameParams(params, saved?.params ?? {});
  const label = (view.label as Record<string, string | undefined>)[locale] || view.label.en;
  const plugin = view.declaredBy !== "kernel";

  const options = [
    { value: "", label: scope === "deployment" ? t("unset") : t("useDefault") },
    ...providers.flatMap((p) =>
      p.models.map((m) => ({
        value: encodeModel({ provider: p.provider, model: m.id }),
        label: `${p.provider} / ${m.displayName}`,
      })),
    ),
  ];
  // 已保存的模型不在列表里（供应商出错、模型下线）：仍列出并标不可用
  if (saved !== null && !options.some((o) => o.value === encodeModel(saved.model))) {
    options.push({
      value: encodeModel(saved.model),
      label: t("unavailable", { target: `${saved.model.provider} / ${saved.model.model}` }),
    });
  }

  async function submit(target: PurposeTarget | null) {
    setBusy(target === null ? "clear" : "save");
    setError(undefined);
    try {
      const next = await save(target);
      toast.success(
        t(target !== null ? "saved" : scope === "deployment" ? "cleared" : "restored", {
          purpose: view.purpose,
        }),
      );
      onSaved(next);
    } catch (e) {
      const issues = targetIssues(e, decl);
      if (issues === null) setError({ message: errorMessage(e), extra: [], params: {} });
      else {
        const extra = [
          ...issues.unknownParams.map((key) => tp("invalidKey", { key })),
          ...issues.other,
        ];
        const onFields = issues.model || issues.params.length > 0;
        setError({
          extra,
          model: issues.model,
          params: Object.fromEntries(issues.params.map((k) => [k, tp("invalid")])),
          // 明细都落到了字段上就不再重复总述
          ...(onFields && extra.length === 0 ? {} : { message: errorMessage(e) }),
        });
      }
    } finally {
      setBusy(undefined);
    }
  }

  const defaultText =
    view.default === null ? t("unset") : targetName(providers, view.default.model);

  return (
    <div data-purpose={view.purpose}>
      <Card
        title={
          <Stack direction="row" gap={8} align="center">
            <Text>{label}</Text>
            <Badge>{view.purpose}</Badge>
            {scope === "org" && view.override !== null ? (
              <Badge tone="accent">{t("overridden")}</Badge>
            ) : null}
          </Stack>
        }
      >
        <Stack gap={12}>
          <Stack gap={4}>
            <Text variant="small" tone="muted">
              {plugin ? t("declaredByPlugin", { plugin: view.declaredBy }) : t("declaredByKernel")}
            </Text>
            {plugin ? (
              <Text variant="small" tone="warn">
                {t("pluginNote")}
              </Text>
            ) : null}
            {scope === "org" ? (
              <Text variant="small">{t("deploymentDefault", { target: defaultText })}</Text>
            ) : null}
          </Stack>
          <Field
            label={t("model")}
            {...(error?.model === true ? { error: t("modelInvalid") } : {})}
          >
            <Select
              value={model}
              disabled={busy !== undefined}
              onChange={(e) => {
                const v = e.target.value;
                const r = decodeModel(v);
                setModel(v);
                setParams((p) =>
                  r === null ? {} : keepDeclared(findModel(providers, r)?.parameters ?? [], p),
                );
              }}
              options={options}
            />
          </Field>
          {decl.length > 0 ? (
            <Stack gap={12}>
              <Text variant="small" tone="muted">
                {t("params")}
              </Text>
              <ModelParams
                parameters={decl}
                value={params}
                onChange={setParams}
                locale={locale}
                errors={error?.params ?? {}}
              />
            </Stack>
          ) : null}
          {error?.message !== undefined ? (
            <FormError message={error.message} extra={error.extra} />
          ) : null}
          <Stack direction="row" gap={8}>
            {/* 每个用途一张卡片：保存用次级样式，页面不出现多个主操作 */}
            <Button
              variant="secondary"
              loading={busy === "save"}
              disabled={busy !== undefined || !dirty || ref === null}
              aria-label={t("saveLabel", { purpose: view.purpose })}
              onClick={() => ref !== null && void submit({ model: ref, params })}
            >
              {t("save")}
            </Button>
            {saved !== null ? (
              <Button
                loading={busy === "clear"}
                disabled={busy !== undefined}
                aria-label={t(scope === "deployment" ? "clearLabel" : "restoreLabel", {
                  purpose: view.purpose,
                })}
                onClick={() => void submit(null)}
              >
                {t(scope === "deployment" ? "clear" : "restore")}
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </Card>
    </div>
  );
}
