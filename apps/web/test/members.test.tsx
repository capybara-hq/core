import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import MembersPage from "../src/app/[locale]/(app)/settings/members/page";
import type { Me } from "../src/lib/session";
import { bodyOf, json, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const msgs = { zh, en } as const;
const LOCALES = ["zh", "en"] as const;
const BASE = "/api/v1/orgs/o1";
/** DataTable 行菜单按钮（设计系统文案 table.rowActions）。 */
const ROW_ACTIONS = { zh: "行操作", en: "Row actions" } as const;

const asRole = (role: string): Me => ({
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

const MEMBERS = [
  {
    account: { id: "a1", displayName: "Grant", email: null },
    role: "owner",
    joinedAt: "2026-10-01T00:00:00.000Z",
    anonymous: false,
  },
  {
    account: { id: "a2", displayName: "Bob", email: "bob@corp.example" },
    role: "member",
    joinedAt: "2026-10-02T00:00:00.000Z",
    anonymous: false,
  },
  {
    account: { id: "a3", displayName: "IM visitor", email: null },
    role: "guest",
    joinedAt: "2026-10-03T00:00:00.000Z",
    anonymous: true,
  },
];

const PENDING = {
  id: "i1",
  orgId: "o1",
  role: "member",
  createdBy: "a1",
  createdAt: "2026-10-20T00:00:00.000Z",
  expiresAt: "2026-10-27T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  status: "pending",
};

const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

beforeEach(() => resetNavigation("/settings/members"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("成员页（ListPage）", () => {
  it.each(LOCALES)(
    "匿名访客行：带「匿名访客」Badge，角色控件禁用，没有移出与转让（%s）",
    async (locale) => {
      const m = msgs[locale].members;
      stubApi({
        [`GET ${BASE}/members`]: () => json(200, { members: MEMBERS }),
        [`GET ${BASE}/invitations`]: () => json(200, { invitations: [] }),
      });
      const { container } = renderPage(<MembersPage />, { locale });
      expect(container.querySelector('[data-template="ListPage"]')).not.toBeNull();
      expect(await screen.findByText("IM visitor")).toBeTruthy();
      const anon = rowOf("IM visitor");
      expect(within(anon).getByText(m.anonymous)).toBeTruthy();
      const anonRole = within(anon).getByRole("combobox", {
        name: m.roleOf.replace("{name}", "IM visitor"),
      });
      expect(anonRole).toHaveProperty("disabled", true);
      expect(within(anon).queryByRole("button", { name: ROW_ACTIONS[locale] })).toBeNull();
      // 普通成员：角色可改，有行菜单
      const bob = rowOf("Bob");
      expect(within(bob).queryByText(m.anonymous)).toBeNull();
      expect(
        within(bob).getByRole("combobox", { name: m.roleOf.replace("{name}", "Bob") }),
      ).toHaveProperty("disabled", false);
      expect(within(bob).getByRole("button", { name: ROW_ACTIONS[locale] })).toBeTruthy();
    },
  );

  it("管理员把成员改为访客：PATCH members/:id，行内角色随之更新", async () => {
    const m = en.members;
    const calls = stubApi({
      [`GET ${BASE}/members`]: () => json(200, { members: MEMBERS }),
      [`GET ${BASE}/invitations`]: () => json(200, { invitations: [] }),
      [`PATCH ${BASE}/members/a2`]: (c) => json(200, { accountId: "a2", ...(bodyOf(c) as object) }),
    });
    renderPage(<MembersPage />, { me: asRole("admin") });
    await screen.findByText("Bob");
    const select = within(rowOf("Bob")).getByRole("combobox", {
      name: m.roleOf.replace("{name}", "Bob"),
    }) as HTMLSelectElement;
    await userEvent.setup().selectOptions(select, "guest");
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ role: "guest" }),
    );
    expect(
      await screen.findByText(
        m.roleChanged.replace("{name}", "Bob").replace("{role}", m.roles.guest),
      ),
    ).toBeTruthy();
    expect(select.value).toBe("guest");
  });

  it("管理员：所有者行的角色控件禁用、没有移出；自己这一行也不能改；没有「转让所有权」", async () => {
    const m = en.members;
    const admin: Me = {
      ...asRole("admin"),
      account: { ...ME.account, id: "a2", displayName: "Bob" },
    };
    stubApi({
      [`GET ${BASE}/members`]: () =>
        json(200, {
          members: MEMBERS.map((x) => (x.account.id === "a2" ? { ...x, role: "admin" } : x)),
        }),
      [`GET ${BASE}/invitations`]: () => json(200, { invitations: [] }),
    });
    renderPage(<MembersPage />, { me: admin });
    await screen.findByText("IM visitor");
    const owner = rowOf("Grant");
    expect(
      within(owner).getByRole("combobox", { name: m.roleOf.replace("{name}", "Grant") }),
    ).toHaveProperty("disabled", true);
    expect(within(owner).queryByRole("button", { name: ROW_ACTIONS.en })).toBeNull();
    // 自己这一行显示「（你）」，角色不可改，也没有行菜单
    const self = rowOf(`Bob (${m.you})`);
    expect(
      within(self).getByRole("combobox", { name: m.roleOf.replace("{name}", "Bob") }),
    ).toHaveProperty("disabled", true);
    expect(within(self).queryByRole("button", { name: ROW_ACTIONS.en })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: m.menu.transfer })).toBeNull();
  });

  it.each(LOCALES)("移出成员要二次确认：确认后 DELETE，行消失（%s）", async (locale) => {
    const m = msgs[locale].members;
    const calls = stubApi({
      [`GET ${BASE}/members`]: () => json(200, { members: MEMBERS }),
      [`GET ${BASE}/invitations`]: () => json(200, { invitations: [] }),
      [`DELETE ${BASE}/members/a2`]: () => noContent(),
    });
    renderPage(<MembersPage />, { locale });
    await screen.findByText("Bob");
    const user = userEvent.setup();
    await user.click(within(rowOf("Bob")).getByRole("button", { name: ROW_ACTIONS[locale] }));
    await user.click(await screen.findByRole("menuitem", { name: m.menu.remove }));
    const dialog = await screen.findByRole("dialog", {
      name: m.confirm.removeTitle.replace("{name}", "Bob"),
    });
    // 确认之前不发 DELETE
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: m.confirm.remove }));
    await vi.waitFor(() => expect(screen.queryByText("Bob")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("所有者转让所有权：确认后 POST transfer，再重读成员", async () => {
    const m = en.members;
    let members = MEMBERS;
    const calls = stubApi({
      [`GET ${BASE}/members`]: () => json(200, { members }),
      [`GET ${BASE}/invitations`]: () => json(200, { invitations: [] }),
      [`POST ${BASE}/transfer`]: () => {
        members = MEMBERS.map((x) =>
          x.account.id === "a2"
            ? { ...x, role: "owner" }
            : x.account.id === "a1"
              ? { ...x, role: "admin" }
              : x,
        );
        return noContent();
      },
    });
    const { container } = renderPage(<MembersPage />);
    await screen.findByText("Bob");
    const user = userEvent.setup();
    await user.click(within(rowOf("Bob")).getByRole("button", { name: ROW_ACTIONS.en }));
    await user.click(await screen.findByRole("menuitem", { name: m.menu.transfer }));
    const dialog = await screen.findByRole("dialog", {
      name: m.confirm.transferTitle.replace("{name}", "Bob"),
    });
    await user.click(within(dialog).getByRole("button", { name: m.confirm.transfer }));
    await vi.waitFor(() =>
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ toAccountId: "a2" }),
    );
    await vi.waitFor(() =>
      expect(
        (
          within(rowOf("Bob")).getByRole("combobox", {
            name: m.roleOf.replace("{name}", "Bob"),
          }) as HTMLSelectElement
        ).value,
      ).toBe("owner"),
    );
    expect(container).toBeTruthy();
  });

  it("普通成员：只读角色，没有邀请按钮、行菜单，也不请求邀请列表", async () => {
    const m = en.members;
    const calls = stubApi({
      [`GET ${BASE}/members`]: () => json(200, { members: MEMBERS }),
    });
    renderPage(<MembersPage />, { me: asRole("member") });
    await screen.findByText("Bob");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(within(rowOf("Bob")).getByText(m.roles.member)).toBeTruthy();
    expect(screen.queryByRole("button", { name: m.invite })).toBeNull();
    expect(screen.queryByRole("button", { name: ROW_ACTIONS.en })).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/invitations"))).toBe(false);
  });

  it.each(LOCALES)(
    "邀请：选角色与有效期 → 生成后显示可复制的链接 → 列表里出现待接受的邀请，可撤销（%s）",
    async (locale) => {
      const m = msgs[locale].members;
      let invitations: unknown[] = [];
      const calls = stubApi({
        [`GET ${BASE}/members`]: () => json(200, { members: MEMBERS }),
        [`GET ${BASE}/invitations`]: () => json(200, { invitations }),
        [`POST ${BASE}/invitations`]: (c) => {
          const body = bodyOf(c) as { role: string };
          invitations = [{ ...PENDING, role: body.role }];
          return json(201, { invitation: { ...PENDING, role: body.role }, token: "cap_inv_tok" });
        },
        [`DELETE ${BASE}/invitations/i1`]: () => {
          invitations = [
            { ...PENDING, role: "guest", status: "revoked", revokedAt: PENDING.createdAt },
          ];
          return noContent();
        },
      });
      renderPage(<MembersPage />, { locale });
      expect(await screen.findByText(m.invitations.empty)).toBeTruthy();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: m.invite }));
      const dialog = await screen.findByRole("dialog", { name: m.inviteDialog.title });
      await user.selectOptions(
        within(dialog).getByRole("combobox", { name: m.inviteDialog.role }),
        "guest",
      );
      await user.selectOptions(
        within(dialog).getByRole("combobox", { name: m.inviteDialog.expires }),
        "24",
      );
      await user.click(within(dialog).getByRole("button", { name: m.inviteDialog.create }));
      const link = (await within(dialog).findByRole("textbox", {
        name: m.inviteDialog.link,
      })) as HTMLInputElement;
      expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
        role: "guest",
        expiresInHours: 24,
      });
      expect(link.value).toBe(`${window.location.origin}/${locale}/invite/cap_inv_tok`);
      expect(link.readOnly).toBe(true);
      await user.click(within(dialog).getByRole("button", { name: m.inviteDialog.copy }));
      // userEvent.setup() 自带剪贴板替身
      expect(await navigator.clipboard.readText()).toBe(link.value);
      expect(await screen.findByText(m.inviteDialog.copied)).toBeTruthy();
      await user.click(within(dialog).getByRole("button", { name: m.inviteDialog.done }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      const row = (await screen.findByText(new RegExp(`${m.invitations.status.pending}$`))).closest(
        "tr",
      ) as HTMLElement;
      expect(within(row).getByText(m.roles.guest)).toBeTruthy();
      await user.click(within(row).getByRole("button", { name: ROW_ACTIONS[locale] }));
      await user.click(await screen.findByRole("menuitem", { name: m.invitations.revoke }));
      expect(await screen.findByText(new RegExp(`${m.invitations.status.revoked}$`))).toBeTruthy();
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    },
  );
});
