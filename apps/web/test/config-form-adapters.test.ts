import { describe, expect, it } from "vitest";
import { channelConfig, channelFormMeta } from "../src/components/config-form/channel";
import { deploymentBody, deploymentForm, reloads } from "../src/components/config-form/deployment";
import {
  type ArrayNode,
  buildTree,
  type Draft,
  fromDraft,
  newItemDraft,
  secretEntries,
  toDraft,
} from "../src/components/config-form/model";
import {
  orgConfig,
  orgFormMeta,
  overrideForm,
  overrideValues,
} from "../src/components/config-form/org";
import type { DeploymentConfigView } from "../src/lib/admin-extensions";
import type { OrgOverrideView } from "../src/lib/extensions";
import type { JsonSchema } from "../src/lib/json-schema";
import SCHEMA from "./support/openai-compatible-schema.json";

const ENDPOINT = {
  name: "deepseek",
  baseUrl: "https://api.deepseek.com",
  dialect: "deepseek",
  models: [{ id: "deepseek-chat", contextWindow: 128000, maxOutputTokens: 8192 }],
};

const VIEW: DeploymentConfigView = {
  plugin: "openai-compatible",
  displayName: null,
  version: "1.0.0",
  configurable: true,
  schema: SCHEMA as JsonSchema,
  fields: [
    {
      path: "endpoints",
      secret: false,
      hot: false,
      source: "db",
      readonly: false,
      value: [ENDPOINT],
    },
    {
      path: "apiKeys",
      secret: true,
      hot: false,
      source: "db",
      readonly: false,
      set: true,
      keys: ["deepseek"],
    },
  ],
  valid: true,
  validated: true,
  issues: [],
};

type ObjDraft = Extract<Draft, { t: "object" }>;
type ArrDraft = Extract<Draft, { t: "array" }>;

/** Opens the form on VIEW and returns its pieces plus a save of a changed draft. */
function open() {
  const form = deploymentForm(VIEW);
  const tree = buildTree(form.schema, "en");
  const baselineDraft = toDraft(tree, form.value);
  const baseline = fromDraft(tree, baselineDraft).value;
  const draft = structuredClone(baselineDraft) as ObjDraft;
  const endpoints = draft.fields.endpoints as ArrDraft;
  const save = () => {
    const { value } = fromDraft(tree, draft);
    const entries = secretEntries(tree, draft, baselineDraft, form.meta);
    return deploymentBody(VIEW, tree, baseline, value, entries);
  };
  return { form, tree, draft, endpoints, save };
}

describe("deployment adapter", () => {
  it("sends nothing when nothing changed", () => {
    const { save } = open();
    expect(save()).toEqual({ values: {}, secretEntries: [] });
  });

  it("adding an endpoint with a key sets that key", () => {
    const { tree, endpoints, save } = open();
    const node = tree.children[0] as ArrayNode;
    const added = newItemDraft(node, {
      name: "qwen",
      baseUrl: "https://q.example/v1",
      dialect: "qwen",
    });
    (added as ObjDraft).fields["$secret:apiKeys"] = {
      t: "itemSecret",
      op: "set",
      text: "sk-q",
      origKey: undefined,
    };
    endpoints.items.push({ key: "new", draft: added });
    const body = save();
    expect(Object.keys(body.values)).toEqual(["endpoints"]);
    expect(body.secretEntries).toEqual([{ path: "apiKeys", key: "qwen", value: "sk-q" }]);
  });

  it("renaming an endpoint with a key moves it; removing it clears it", () => {
    const { endpoints, save } = open();
    ((endpoints.items[0] as { draft: Draft }).draft as ObjDraft).fields.name = {
      t: "text",
      text: "ds",
    };
    expect(save().secretEntries).toEqual([{ path: "apiKeys", key: "ds", renameFrom: "deepseek" }]);
    endpoints.items.splice(0, 1);
    expect(save().secretEntries).toEqual([{ path: "apiKeys", key: "deepseek", value: null }]);
  });

  it("a readonly field is never sent; reloads only when a non-hot field changed", () => {
    const view: DeploymentConfigView = {
      ...VIEW,
      schema: null,
      fields: [
        { path: "region", secret: false, hot: false, source: "file", readonly: true, value: "eu" },
        {
          path: "greeting",
          secret: false,
          hot: true,
          source: "default",
          readonly: false,
          value: "hi",
        },
        { path: "token", secret: true, hot: false, source: "db", readonly: false, set: true },
      ],
    };
    const form = deploymentForm(view);
    expect(form.meta.region).toMatchObject({ readonly: "file" });
    const tree = buildTree(form.schema, "en");
    const base = fromDraft(tree, toDraft(tree, form.value)).value;
    const body = deploymentBody(view, tree, base, { region: "us", greeting: "hello" }, []);
    expect(body).toEqual({ values: { greeting: "hello" }, secretEntries: [] });
    expect(reloads(view, body)).toBe(false);
    const cleared = deploymentBody(view, tree, base, { greeting: "hi", token: null }, []);
    expect(cleared.values).toEqual({ token: null });
    expect(reloads(view, cleared)).toBe(true);
  });
});

describe("org and channel adapters", () => {
  it("keep / clear / replace: untouched secrets drop out of the JSON", () => {
    expect(orgFormMeta([{ path: "appSecret", set: true }])).toEqual({
      appSecret: { secretSet: true },
    });
    expect(channelFormMeta()).toEqual({});
    const config = orgConfig({ appId: "a", appSecret: undefined, verificationToken: null });
    expect(JSON.parse(JSON.stringify(config))).toEqual({ appId: "a", verificationToken: null });
    expect(channelConfig(undefined)).toEqual({});
  });
});

describe("secret entries for renames", () => {
  const ep = (name: string) => ({ ...ENDPOINT, name });
  /** Opens the form on endpoints with these names, every one with a key set. */
  function form(names: string[]) {
    const view: DeploymentConfigView = {
      ...VIEW,
      fields: [
        { ...(VIEW.fields[0] as DeploymentConfigView["fields"][number]), value: names.map(ep) },
        { ...(VIEW.fields[1] as DeploymentConfigView["fields"][number]), keys: names },
      ],
    };
    const f = deploymentForm(view);
    const tree = buildTree(f.schema, "en");
    const baseline = toDraft(tree, f.value);
    const draft = structuredClone(baseline) as ObjDraft;
    const items = (draft.fields.endpoints as ArrDraft).items;
    const item = (i: number) => (items[i] as { draft: Draft }).draft as ObjDraft;
    const rename = (i: number, to: string) => {
      item(i).fields.name = { t: "text", text: to };
    };
    const entries = () => secretEntries(tree, draft, baseline, f.meta);
    return { item, rename, entries };
  }

  it("a chain moves the last key first", () => {
    const f = form(["a", "b"]);
    f.rename(0, "b");
    f.rename(1, "c");
    expect(f.entries()).toEqual([
      { path: "apiKeys", key: "c", renameFrom: "b" },
      { path: "apiKeys", key: "b", renameFrom: "a" },
    ]);
  });

  it("a swap parks one key under a temporary key", () => {
    const f = form(["a", "b"]);
    f.rename(0, "b");
    f.rename(1, "a");
    expect(f.entries()).toEqual([
      { path: "apiKeys", key: "$rename-0", renameFrom: "a" },
      { path: "apiKeys", key: "a", renameFrom: "b" },
      { path: "apiKeys", key: "b", renameFrom: "$rename-0" },
    ]);
  });

  it("a rename with a new key moves and sets in one entry", () => {
    const f = form(["deepseek"]);
    f.rename(0, "ds");
    f.item(0).fields["$secret:apiKeys"] = {
      t: "itemSecret",
      op: "set",
      text: "sk-new",
      origKey: "deepseek",
    };
    expect(f.entries()).toEqual([
      { path: "apiKeys", key: "ds", value: "sk-new", renameFrom: "deepseek" },
    ]);
  });
});

describe("the two-level org config adapter", () => {
  const view = (state: "following" | "copy"): OrgOverrideView => ({
    state,
    valid: true,
    issues: [],
    fields: [
      { path: "region", level: "readonly", secret: false, platform: { value: "eu" } },
      {
        path: "baseUrl",
        level: "override",
        secret: false,
        platform: { value: "https://p.example" },
        ...(state === "copy" && { org: { value: "https://o.example" }, differs: true }),
      },
      {
        path: "apiKey",
        level: "override",
        secret: true,
        platform: { set: true },
        ...(state === "copy" && { org: { set: false } }),
      },
    ],
  });

  it("a read-only field is locked and the platform's; a secret shows who holds it, never a value", () => {
    const f = overrideForm(view("following"));
    expect(f.value).toEqual({ region: "eu", baseUrl: "https://p.example" });
    expect(f.meta.region).toEqual({ readonly: "platform" });
    expect(f.meta.baseUrl).toEqual({ platform: { value: "https://p.example" } });
    expect(f.meta.apiKey).toEqual({ secretState: "platform", secretSet: false });
  });

  it("while following, the platform's secret becomes a required own key (the first save is whole)", () => {
    const f = overrideForm(view("following"));
    const tree = buildTree(f.schema, "en");
    const opened = fromDraft(tree, toDraft(tree, f.value), { secretSet: () => false });
    expect(opened.problems.map((p) => p.kind)).toEqual(["required"]);
  });

  it("a copy shows its own values and secret state; saving sends only the changed overridable fields", () => {
    const v = view("copy");
    const f = overrideForm(v);
    expect(f.value).toEqual({ region: "eu", baseUrl: "https://o.example" });
    expect(f.meta.apiKey).toEqual({ secretState: "unset", secretSet: false });
    const tree = buildTree(f.schema, "en");
    const opened = fromDraft(tree, toDraft(tree, f.value), { secretSet: () => false });
    expect(overrideValues(v, opened.value, opened.value)).toEqual({});
    const edited = { region: "x", baseUrl: "https://new.example", apiKey: "sk-1" };
    expect(overrideValues(v, opened.value, edited)).toEqual({
      baseUrl: "https://new.example",
      apiKey: "sk-1",
    });
    expect(overrideValues(v, opened.value, { region: "eu" })).toEqual({ baseUrl: null });
  });

  it("the platform form tags each field with what orgs may do (no tag from an older kernel is hidden)", () => {
    const v: DeploymentConfigView = {
      ...VIEW,
      fields: [
        {
          path: "endpoints",
          secret: false,
          hot: false,
          source: "db",
          readonly: false,
          value: [ENDPOINT],
          org: "override",
        },
        { path: "other", secret: false, hot: false, source: "db", readonly: false, value: 1 },
      ],
    };
    const f = deploymentForm(v);
    expect(f.meta.endpoints?.level).toBe("override");
    expect(f.meta.other?.level).toBe("hidden");
  });
});
