import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import InstallAppPage from "../src/app/[locale]/(app)/apps/install/page";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const T = "2026-10-19T12:00:00.000Z";
const PREVIEW = "POST /api/v1/orgs/o1/apps/preview";
const CREATE = "POST /api/v1/orgs/o1/apps";

const app = (over: Record<string, unknown> = {}) => ({
  id: "app1",
  slug: "fixture",
  name: "Fixture",
  connector: "mcp",
  endpoint: { url: "https://mcp.example.com/mcp" },
  auth: { type: "none" },
  status: "active",
  createdAt: T,
  updatedAt: T,
  tools: [],
  credential: { ownership: null, status: "connected" },
  ...over,
});

const previewTool = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  key: `fixture__${name}`,
  description: `${name} things`,
  inputSchema: {},
  annotations: null,
  defaultPolicy: "ask",
  issue: null,
  source: "connector",
  ...over,
});

const OPERATIONS = [
  { id: "listPets", method: "GET", path: "/pets", summary: "List pets" },
  { id: "createPet", method: "POST", path: "/pets", summary: "Create a pet" },
  { id: "deletePet", method: "DELETE", path: "/pets/{petId}", summary: "Delete a pet" },
];

const actionRow = (locale: "zh" | "en") =>
  screen.getByRole("region", { name: locale === "zh" ? "待提交改动" : "Pending changes" });

const clickAction = async (
  user: ReturnType<typeof userEvent.setup>,
  locale: "zh" | "en",
  name: string,
) => user.click(within(actionRow(locale)).getByRole("button", { name }));

/** 当前步骤（步骤条里 aria-current 的那一项）。 */
const currentStep = () =>
  document.querySelector('[aria-current="step"]')?.textContent?.replace(/^\d/, "");

const previews = (calls: Call[]) =>
  calls.filter((c) => `${c.method} ${c.url}` === PREVIEW).map((c) => bodyOf(c));

beforeEach(() => resetNavigation("/apps/install"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("安装向导（WizardPage）", () => {
  it.each(LOCALES)(
    "MCP + Bearer：端点预览 → 认证后预览列出工具与默认策略 → 安装 → 完成后打开应用（%s）",
    async (locale) => {
      const m = msgs[locale];
      const w = m.apps.wizard;
      const calls = stubApi({
        [PREVIEW]: (c) => {
          const body = bodyOf(c) as { auth?: unknown };
          return json(
            200,
            body.auth === undefined
              ? { tools: null, issues: [], authHints: [] }
              : {
                  tools: [
                    previewTool("search", {
                      annotations: { readOnlyHint: true },
                      defaultPolicy: "allow",
                    }),
                    previewTool("delete_item", { annotations: { destructiveHint: true } }),
                  ],
                  issues: [{ name: "bad tool", reason: "Tool name is invalid" }],
                  authHints: [],
                },
          );
        },
        [CREATE]: () =>
          json(201, {
            app: app({ auth: { type: "bearer", ownership: "org" }, tools: [{}, {}] }),
            issues: [],
          }),
      });
      const { container } = renderPage(<InstallAppPage />, { locale });
      expect(container.querySelector('[data-template="WizardPage"]')).not.toBeNull();
      const user = userEvent.setup();
      expect(currentStep()).toBe(w.steps.type);
      expect(screen.getByRole("radio", { name: new RegExp(w.connector.mcp) })).toHaveProperty(
        "checked",
        true,
      );
      // 第一步没有「上一步」
      expect(within(actionRow(locale)).queryByRole("button", { name: w.previous })).toBeNull();
      await clickAction(user, locale, w.next);
      expect(currentStep()).toBe(w.steps.endpoint);

      // 必填校验：不发请求
      await clickAction(user, locale, w.next);
      expect(screen.getByText(`✗ ${m.apps.form.nameRequired}`)).toBeTruthy();
      expect(screen.getByText(`✗ ${m.apps.form.urlRequired}`)).toBeTruthy();
      expect(calls).toHaveLength(0);

      await user.type(screen.getByRole("textbox", { name: m.apps.form.nameLabel }), "Fixture");
      await user.type(
        screen.getByRole("textbox", { name: m.apps.form.urlLabel }),
        "https://mcp.example.com/mcp",
      );
      await clickAction(user, locale, w.next);
      expect(await screen.findByRole("combobox", { name: m.apps.form.authTypeLabel })).toBeTruthy();
      expect(currentStep()).toBe(w.steps.auth);
      expect(previews(calls)[0]).toEqual({
        name: "Fixture",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com/mcp" },
      });

      await user.selectOptions(
        screen.getByRole("combobox", { name: m.apps.form.authTypeLabel }),
        "bearer",
      );
      // 静态认证安装时要用凭据列出工具：没填不发请求
      await clickAction(user, locale, w.next);
      expect(screen.getByText(`✗ ${w.credentialRequired}`)).toBeTruthy();
      expect(previews(calls)).toHaveLength(1);
      const token = screen.getByLabelText(m.apps.form.tokenLabel);
      expect(token.getAttribute("type")).toBe("password");
      await user.type(token, "s3cret");
      await clickAction(user, locale, w.next);
      const table = await screen.findByRole("table", { name: w.toolsTitle });
      expect(previews(calls)[1]).toEqual({
        name: "Fixture",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com/mcp" },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: "s3cret" },
      });
      const search = within(table).getByText("fixture__search").closest("tr") as HTMLElement;
      expect(within(search).getByText(m.apps.policy.allow)).toBeTruthy();
      expect(within(search).getByText(w.annotation.readOnly)).toBeTruthy();
      const del = within(table).getByText("fixture__delete_item").closest("tr") as HTMLElement;
      expect(within(del).getByText(m.apps.policy.ask)).toBeTruthy();
      expect(within(del).getByText(w.annotation.destructive)).toBeTruthy();
      expect(screen.getByText("‖ bad tool: Tool name is invalid")).toBeTruthy();

      await clickAction(user, locale, w.install);
      expect(bodyOf(calls.find((c) => `${c.method} ${c.url}` === CREATE))).toEqual({
        name: "Fixture",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com/mcp" },
        auth: { type: "bearer", ownership: "org" },
        credential: { token: "s3cret" },
      });
      expect(await screen.findByText(w.doneTitle.replace("{name}", "Fixture"))).toBeTruthy();
      expect(currentStep()).toBe(w.steps.done);
      // 视图里至多一个主操作
      expect(container.querySelectorAll('[data-variant="primary"]').length).toBeLessThanOrEqual(1);
      await clickAction(user, locale, w.openApp);
      expect(router.push).toHaveBeenCalledWith("/apps/app1");
    },
  );

  it.each(LOCALES)(
    "OpenAPI：按文档的认证提示预填 API key；勾选操作（默认策略按方法推导）后安装（%s）",
    async (locale) => {
      const m = msgs[locale];
      const w = m.apps.wizard;
      const calls = stubApi({
        [PREVIEW]: (c) => {
          const body = bodyOf(c) as { auth?: unknown };
          return json(200, {
            tools: body.auth === undefined ? null : null,
            issues: [],
            authHints: [
              {
                scheme: "apiKey",
                description: "Key from the dashboard",
                type: "api_key",
                in: "header",
                name: "X-API-Key",
              },
              { scheme: "bearerAuth", type: "bearer" },
            ],
            operations: OPERATIONS,
          });
        },
        [CREATE]: () =>
          json(201, {
            app: app({ connector: "openapi", auth: { type: "api_key", ownership: "org" } }),
            issues: [],
          }),
      });
      renderPage(<InstallAppPage />, { locale });
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: new RegExp(w.connector.openapi) }));
      await clickAction(user, locale, w.next);
      await user.type(screen.getByRole("textbox", { name: m.apps.form.nameLabel }), "Pets");
      await user.type(
        screen.getByRole("textbox", { name: w.specUrlLabel }),
        "https://api.example.com/openapi.json",
      );
      await user.type(
        screen.getByRole("textbox", { name: new RegExp(`^${w.baseUrlLabel}`) }),
        "https://api.example.com/v1",
      );
      await clickAction(user, locale, w.next);
      const hint = await screen.findByRole("combobox", { name: w.hintLabel });
      expect(previews(calls)[0]).toEqual({
        name: "Pets",
        connector: "openapi",
        endpoint: {
          specUrl: "https://api.example.com/openapi.json",
          baseUrl: "https://api.example.com/v1",
        },
      });
      // 预填第一项提示：API key、请求头 X-API-Key；说明原样显示
      expect(hint).toHaveProperty("value", "0");
      expect(screen.getByText("Key from the dashboard")).toBeTruthy();
      expect(screen.getByRole("combobox", { name: m.apps.form.authTypeLabel })).toHaveProperty(
        "value",
        "api_key",
      );
      expect(screen.getByRole("textbox", { name: m.apps.form.keyNameLabel })).toHaveProperty(
        "value",
        "X-API-Key",
      );
      await user.type(screen.getByLabelText(m.apps.form.tokenLabel), "k-1");
      await clickAction(user, locale, w.next);

      const table = await screen.findByRole("table", { name: w.operationsLabel });
      const row = (text: string) => within(table).getByText(text).closest("tr") as HTMLElement;
      expect(within(row("GET /pets")).getByText(m.apps.policy.allow)).toBeTruthy();
      expect(within(row("POST /pets")).getByText(m.apps.policy.ask)).toBeTruthy();
      expect(within(row("DELETE /pets/{petId}")).getByText(w.annotation.destructive)).toBeTruthy();
      // 默认全选；取消删除操作
      await user.click(
        within(table).getByRole("checkbox", {
          name: (locale === "zh" ? "选择 {name}" : "Select {name}").replace(
            "{name}",
            "DELETE /pets/{petId}",
          ),
        }),
      );
      await clickAction(user, locale, w.install);
      expect(bodyOf(calls.find((c) => `${c.method} ${c.url}` === CREATE))).toEqual({
        name: "Pets",
        connector: "openapi",
        endpoint: {
          specUrl: "https://api.example.com/openapi.json",
          baseUrl: "https://api.example.com/v1",
          operations: ["listPets", "createPet"],
        },
        auth: { type: "api_key", ownership: "org", in: "header", name: "X-API-Key" },
        credential: { token: "k-1" },
      });
    },
  );

  it("Basic 认证：用户名与密码都要填，只填用户名不发预览请求", async () => {
    const m = msgs.en;
    const w = m.apps.wizard;
    const calls = stubApi({
      [PREVIEW]: () => json(200, { tools: [previewTool("search")], issues: [], authHints: [] }),
    });
    renderPage(<InstallAppPage />, { locale: "en" });
    const user = userEvent.setup();
    await clickAction(user, "en", w.next);
    await user.type(screen.getByRole("textbox", { name: m.apps.form.nameLabel }), "Fixture");
    await user.type(
      screen.getByRole("textbox", { name: m.apps.form.urlLabel }),
      "https://mcp.example.com/mcp",
    );
    await clickAction(user, "en", w.next);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: m.apps.form.authTypeLabel }),
      "basic",
    );
    await user.type(screen.getByLabelText(m.apps.form.usernameLabel), "alice");
    await clickAction(user, "en", w.next);
    expect(screen.getByText(`✗ ${w.credentialRequired}`)).toBeTruthy();
    expect(previews(calls)).toHaveLength(1);
    await user.type(screen.getByLabelText(m.apps.form.passwordLabel), "pw");
    await clickAction(user, "en", w.next);
    await screen.findByRole("table", { name: w.toolsTitle });
    expect(previews(calls)[1]).toMatchObject({ credential: { username: "alice", password: "pw" } });
  });

  it("改过认证后重新预览端点得到新的认证提示：提示选择回到「自定义」，不指向过时的提示", async () => {
    const m = msgs.en;
    const w = m.apps.wizard;
    let round = 0;
    stubApi({
      [PREVIEW]: () => {
        round++;
        return json(200, {
          tools: null,
          issues: [],
          authHints:
            round === 1
              ? [
                  { scheme: "apiKey", type: "api_key", in: "header", name: "X-API-Key" },
                  { scheme: "bearerAuth", type: "bearer" },
                ]
              : [{ scheme: "other", type: "api_key", in: "query", name: "key" }],
          operations: OPERATIONS,
        });
      },
    });
    renderPage(<InstallAppPage />, { locale: "en" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: new RegExp(w.connector.openapi) }));
    await clickAction(user, "en", w.next);
    await user.type(screen.getByRole("textbox", { name: m.apps.form.nameLabel }), "Pets");
    await user.type(
      screen.getByRole("textbox", { name: w.specUrlLabel }),
      "https://api.example.com/openapi.json",
    );
    await clickAction(user, "en", w.next);
    const hint = await screen.findByRole("combobox", { name: w.hintLabel });
    await user.selectOptions(hint, "1");
    expect(screen.getByRole("combobox", { name: m.apps.form.authTypeLabel })).toHaveProperty(
      "value",
      "bearer",
    );
    await clickAction(user, "en", w.previous);
    await clickAction(user, "en", w.next);
    const again = await screen.findByRole("combobox", { name: w.hintLabel });
    await vi.waitFor(() => expect(round).toBe(2));
    expect(again).toHaveProperty("value", "custom");
    // 管理员选过的认证方式保留
    expect(screen.getByRole("combobox", { name: m.apps.form.authTypeLabel })).toHaveProperty(
      "value",
      "bearer",
    );
  });

  it("OpenAPI 上传文档：超过 2 MB 报错；选择文件后以 specText 预览；一个操作都不选时不能安装", async () => {
    const w = en.apps.wizard;
    const calls = stubApi({
      [PREVIEW]: () =>
        json(200, { tools: null, issues: [], authHints: [], operations: OPERATIONS }),
    });
    renderPage(<InstallAppPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: new RegExp(w.connector.openapi) }));
    await clickAction(user, "en", w.next);
    await user.type(screen.getByRole("textbox", { name: en.apps.form.nameLabel }), "Pets");
    await user.click(screen.getByRole("radio", { name: w.specSource.file }));
    const input = screen.getByLabelText(new RegExp(`^${w.specFileLabel}`)) as HTMLInputElement;
    const big = new File(["x"], "big.json", { type: "application/json" });
    Object.defineProperty(big, "size", { value: 2 * 1024 * 1024 + 1 });
    await user.upload(input, big);
    expect(await screen.findByText(`✗ ${w.specTooLarge}`)).toBeTruthy();
    await clickAction(user, "en", w.next);
    expect(calls).toHaveLength(0);

    const doc = '{"openapi":"3.0.3"}';
    await user.upload(input, new File([doc], "pets.json", { type: "application/json" }));
    expect(await screen.findByText(w.specFileChosen.replace("{name}", "pets.json"))).toBeTruthy();
    await clickAction(user, "en", w.next);
    await screen.findByRole("combobox", { name: en.apps.form.authTypeLabel });
    expect(previews(calls)[0]).toEqual({
      name: "Pets",
      connector: "openapi",
      endpoint: { specText: doc },
    });
    await clickAction(user, "en", w.next);
    const table = await screen.findByRole("table", { name: w.operationsLabel });
    await user.click(within(table).getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText(`✗ ${w.selectOperation}`)).toBeTruthy();
    expect(within(actionRow("en")).getByRole("button", { name: w.install })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it.each(LOCALES)(
    "OAuth 授权码 + 自动注册：服务器不支持 DCR（dcr_unsupported）→ 回到认证改为手填客户端，再安装成功（%s）",
    async (locale) => {
      const m = msgs[locale];
      const w = m.apps.wizard;
      let creates = 0;
      const calls = stubApi({
        [PREVIEW]: () => json(200, { tools: null, issues: [], authHints: [] }),
        [CREATE]: () => {
          creates += 1;
          if (creates === 1) {
            return json(502, {
              error: {
                code: "app.connect_failed",
                message: "The authorization server does not support dynamic client registration",
                details: [
                  {
                    reason: "dcr_unsupported",
                    message:
                      "The authorization server does not support dynamic client registration",
                  },
                ],
              },
            });
          }
          return json(201, {
            app: app({
              auth: {
                type: "oauth_code",
                ownership: "personal",
                discovery: "mcp",
                client: "manual",
              },
              credential: { ownership: "personal", status: "missing" },
            }),
            issues: [],
          });
        },
      });
      renderPage(<InstallAppPage />, { locale });
      const user = userEvent.setup();
      await clickAction(user, locale, w.next);
      await user.type(screen.getByRole("textbox", { name: m.apps.form.nameLabel }), "Fixture");
      await user.type(
        screen.getByRole("textbox", { name: m.apps.form.urlLabel }),
        "https://mcp.example.com/mcp",
      );
      await clickAction(user, locale, w.next);
      await user.selectOptions(
        await screen.findByRole("combobox", { name: m.apps.form.authTypeLabel }),
        "oauth_code",
      );
      expect(screen.getByRole("combobox", { name: m.apps.oauth.discoveryLabel })).toHaveProperty(
        "value",
        "mcp",
      );
      expect(screen.getByRole("combobox", { name: m.apps.oauth.clientLabel })).toHaveProperty(
        "value",
        "dcr",
      );
      await clickAction(user, locale, w.next);
      // 授权码流的预览不列工具：说明首个成员连接后列出
      expect(await screen.findByText(w.toolsAfterConnect)).toBeTruthy();
      expect(previews(calls)[1]).toEqual({
        name: "Fixture",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com/mcp" },
        auth: { type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" },
      });
      await clickAction(user, locale, w.install);

      // 回到认证一步：提示 + 客户端改为手填
      expect(await screen.findByText(w.dcrUnsupported)).toBeTruthy();
      expect(currentStep()).toBe(w.steps.auth);
      expect(screen.getByRole("combobox", { name: m.apps.oauth.clientLabel })).toHaveProperty(
        "value",
        "manual",
      );
      await clickAction(user, locale, w.next);
      expect(screen.getByText(`✗ ${w.required}`)).toBeTruthy();
      await user.type(
        screen.getByRole("textbox", { name: m.apps.oauth.clientIdLabel }),
        "client-1",
      );
      const secret = screen.getByLabelText(new RegExp(`^${m.apps.oauth.clientSecretLabel}`));
      expect(secret.getAttribute("type")).toBe("password");
      await user.type(secret, "shh");
      await user.selectOptions(
        screen.getByRole("combobox", { name: m.apps.oauth.tokenAuthMethodLabel }),
        "client_secret_post",
      );
      await clickAction(user, locale, w.next);
      await screen.findByText(w.toolsAfterConnect);
      await clickAction(user, locale, w.install);
      const posts = calls.filter((c) => `${c.method} ${c.url}` === CREATE);
      expect(bodyOf(posts[1])).toEqual({
        name: "Fixture",
        connector: "mcp",
        endpoint: { url: "https://mcp.example.com/mcp" },
        auth: {
          type: "oauth_code",
          ownership: "personal",
          discovery: "mcp",
          client: "manual",
          tokenAuthMethod: "client_secret_post",
        },
        credential: { clientId: "client-1", clientSecret: "shh" },
      });
      // 完成：个人 OAuth 应用引导去连接自己的账号
      expect(await screen.findByText(w.doneOAuthCode)).toBeTruthy();
      await user.click(screen.getByRole("button", { name: w.connectNow }));
      expect(router.push).toHaveBeenCalledWith("/settings/connections#app-app1");
    },
  );

  it("OAuth 客户端凭据：按提示预填令牌地址与 scope；密钥必填；带客户端预览", async () => {
    const w = en.apps.wizard;
    const calls = stubApi({
      [PREVIEW]: (c) =>
        json(200, {
          tools: (bodyOf(c) as { auth?: unknown }).auth ? [previewTool("search")] : null,
          issues: [],
          authHints: [
            {
              scheme: "cc",
              type: "oauth_client",
              tokenUrl: "https://auth.example.com/token",
              scopes: ["read", "write"],
            },
          ],
          operations: [],
        }),
      [CREATE]: () =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "Request validation failed",
            details: [
              {
                path: "auth",
                message:
                  "OAuth apps require http.publicUrl to be configured (it is used to build the OAuth callback URL)",
              },
            ],
          },
        }),
    });
    renderPage(<InstallAppPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: new RegExp(w.connector.openapi) }));
    await clickAction(user, "en", w.next);
    await user.type(screen.getByRole("textbox", { name: en.apps.form.nameLabel }), "Pets");
    await user.type(
      screen.getByRole("textbox", { name: w.specUrlLabel }),
      "https://api.example.com/openapi.json",
    );
    await clickAction(user, "en", w.next);
    expect(
      await screen.findByRole("combobox", { name: en.apps.form.authTypeLabel }),
    ).toHaveProperty("value", "oauth_client");
    expect(screen.getByRole("textbox", { name: en.apps.oauth.tokenUrlLabel })).toHaveProperty(
      "value",
      "https://auth.example.com/token",
    );
    expect(
      screen.getByRole("textbox", { name: new RegExp(`^${en.apps.oauth.scopesLabel}`) }),
    ).toHaveProperty("value", "read write");
    // 客户端凭据流必须有密钥
    await user.type(screen.getByRole("textbox", { name: en.apps.oauth.clientIdLabel }), "cid");
    await clickAction(user, "en", w.next);
    expect(screen.getByText(`✗ ${w.required}`)).toBeTruthy();
    await user.type(screen.getByLabelText(new RegExp(`^${en.apps.oauth.clientSecretLabel}`)), "cs");
    await clickAction(user, "en", w.next);
    expect(await screen.findByText(w.noOperations)).toBeTruthy();
    // 文档里没有操作时不要求勾选
    expect(within(actionRow("en")).getByRole("button", { name: w.install })).toHaveProperty(
      "disabled",
      false,
    );
    expect(previews(calls)[1]).toMatchObject({
      auth: {
        type: "oauth_client",
        ownership: "org",
        tokenUrl: "https://auth.example.com/token",
        scopes: ["read", "write"],
      },
      credential: { clientId: "cid", clientSecret: "cs" },
    });
  });

  it("OAuth 授权码：未配置 http.publicUrl 时安装给出说明，停留在工具一步", async () => {
    const w = en.apps.wizard;
    stubApi({
      [PREVIEW]: () => json(200, { tools: null, issues: [], authHints: [] }),
      [CREATE]: () =>
        json(400, {
          error: {
            code: "validation_failed",
            message: "Request validation failed",
            details: [
              {
                path: "auth",
                message:
                  "OAuth apps require http.publicUrl to be configured (it is used to build the OAuth callback URL)",
              },
            ],
          },
        }),
    });
    renderPage(<InstallAppPage />);
    const user = userEvent.setup();
    await clickAction(user, "en", w.next);
    await user.type(screen.getByRole("textbox", { name: en.apps.form.nameLabel }), "Fixture");
    await user.type(screen.getByRole("textbox", { name: en.apps.form.urlLabel }), "https://x/mcp");
    await clickAction(user, "en", w.next);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: en.apps.form.authTypeLabel }),
      "oauth_code",
    );
    await clickAction(user, "en", w.next);
    await screen.findByText(w.toolsAfterConnect);
    await clickAction(user, "en", w.install);
    expect((await screen.findByRole("alert")).textContent).toContain(w.publicUrlRequired);
    expect(currentStep()).toBe(w.steps.tools);
  });

  it("端点预览失败（app.connect_failed）：显示翻译后的错误与内核说明，停留在端点一步", async () => {
    stubApi({
      [PREVIEW]: () =>
        json(502, {
          error: {
            code: "app.connect_failed",
            message: "Could not read the app description: HTTP 404",
          },
        }),
    });
    renderPage(<InstallAppPage />, { locale: "zh" });
    const w = zh.apps.wizard;
    const user = userEvent.setup();
    await clickAction(user, "zh", w.next);
    await user.type(screen.getByRole("textbox", { name: zh.apps.form.nameLabel }), "Fixture");
    await user.type(screen.getByRole("textbox", { name: zh.apps.form.urlLabel }), "https://x/mcp");
    await clickAction(user, "zh", w.next);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(zh.errors.app.connect_failed);
    expect(alert.textContent).toContain("Could not read the app description: HTTP 404");
    expect(currentStep()).toBe(w.steps.endpoint);
    // 上一步回到类型
    await clickAction(user, "zh", w.previous);
    expect(currentStep()).toBe(w.steps.type);
  });
});
