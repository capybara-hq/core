// The permission review of a plugin with client code (client extensions spec §5.4): components
// have their own row (not under "views / embeds"), and the client row's item is translated.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionReview } from "../src/components/PermissionReview";
import type { PermissionGroup } from "../src/lib/extensions";
import { renderPage } from "./support/render";

afterEach(cleanup);

// what the kernel's permissionGroups returns for views, components and client code
const GROUPS: PermissionGroup[] = [
  {
    category: "ui",
    sensitive: false,
    items: ["view:tasks"],
    entries: [{ value: "view:tasks", sensitive: false }],
  },
  {
    category: "components",
    sensitive: true,
    items: ["brand", "hud"],
    entries: [
      { value: "brand", sensitive: true, reason: "ui_component" },
      { value: "hud", sensitive: true, reason: "ui_component" },
    ],
  },
  {
    category: "client",
    sensitive: true,
    items: ["client code"],
    entries: [{ value: "client code", sensitive: true, reason: "client_code" }],
  },
];

const review = (locale: "zh" | "en") =>
  renderPage(
    <PermissionReview
      plugin="theme-neon"
      groups={GROUPS}
      clientFiles={[{ path: "./dist/client/client.mjs", bytes: 8704 }]}
    />,
    { locale },
  );

describe("PermissionReview with client code", () => {
  for (const [locale, ui, components, client] of [
    ["zh", "界面（视图 / 嵌入页面）", "界面组件", "在浏览器中运行插件代码"],
    ["en", "Interface (views / embeds)", "Interface components", "Runs plugin code in the browser"],
  ] as const) {
    it(`${locale}: components have their own row and the client item is translated`, () => {
      review(locale);
      expect(screen.getByText(ui)).toBeTruthy();
      expect(screen.getByText(components)).toBeTruthy();
      expect(screen.getByText("· brand")).toBeTruthy();
      expect(screen.getByText("· hud")).toBeTruthy();
      expect(screen.getByText(`· ${client}`)).toBeTruthy();
      expect(screen.queryByText("· client code")).toBeNull();
      expect(screen.getByText("· ./dist/client/client.mjs · 8.5 KB")).toBeTruthy();
    });
  }
});

describe("PermissionReview with loopback port grants", () => {
  const groups: PermissionGroup[] = [
    {
      category: "deviceAccess",
      sensitive: true,
      items: ["browser", "local ports on the device (loopback)"],
      entries: [
        { value: "browser", sensitive: true, reason: "device_access" },
        {
          value: "local ports on the device (loopback)",
          sensitive: true,
          reason: "device_loopback_ports",
        },
      ],
    },
  ];
  for (const [locale, item, reason] of [
    ["zh", "设备上的本地端口（回环）", "其设备服务可被授权访问本人设备上的本地端口"],
    [
      "en",
      "Local ports on the device (loopback)",
      "its device services may be granted local ports of the person's own device",
    ],
  ] as const) {
    it(`${locale}: the loopback item and its reason are translated`, () => {
      renderPage(<PermissionReview plugin="browser" groups={groups} />, { locale });
      expect(screen.getByText(`· ${item}`)).toBeTruthy();
      expect(screen.getByText(reason, { exact: false })).toBeTruthy();
      expect(screen.queryByText("· local ports on the device (loopback)")).toBeNull();
    });
  }
});
