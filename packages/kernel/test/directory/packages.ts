import type { ConnectorTemplateSpec } from "@capybara-hq/plugin-sdk";
import { tgz } from "../helpers/plugin-packages.js";
import { makeZip, SKILL_MD } from "../skills/zip.js";

/** 测试用的目录包：连接器模板、技能（tgz / zip）、应用。 */

export const SVG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

export const mcpTemplate = (over: Partial<ConnectorTemplateSpec> = {}): ConnectorTemplateSpec => ({
  plugin: "connector-mcp",
  connector: "mcp",
  endpoint: { url: "https://mcp.example.com/mcp" },
  editableEndpoint: ["url"],
  auth: { type: "bearer", ownership: "org" },
  defaultToolPolicies: { search: "allow" },
  icon: "icon.svg",
  ...over,
});

export function templatePackageJson(
  o: {
    name?: string;
    version?: string;
    template?: unknown;
    section?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    name: o.name ?? "@acme/github-mcp",
    version: o.version ?? "1.0.0",
    capybara: {
      kind: "connector-template",
      publisher: "Acme",
      description: "GitHub over MCP",
      displayName: { zh: "GitHub", en: "GitHub" },
      template: o.template ?? mcpTemplate(),
      ...o.section,
    },
  };
}

export function templateTgz(
  o: Parameters<typeof templatePackageJson>[0] & {
    icon?: string | Buffer | null;
    extra?: { name: string; data: string | Buffer }[];
  } = {},
): Promise<Uint8Array> {
  const icon = o.icon === undefined ? SVG_ICON : o.icon;
  return tgz([
    { name: "package/package.json", data: JSON.stringify(templatePackageJson(o)) },
    ...(icon === null ? [] : [{ name: "package/icon.svg", data: icon }]),
    ...(o.extra ?? []),
  ]);
}

export function skillPackageJson(
  o: { name?: string; version?: string; section?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    name: o.name ?? "@acme/skill-pdf-tools",
    version: o.version ?? "1.0.0",
    capybara: { kind: "skill", publisher: "Acme", description: "PDF helpers", ...o.section },
  };
}

export function skillTgz(
  o: Parameters<typeof skillPackageJson>[0] & {
    skillName?: string;
    skillMd?: string | null;
    extra?: { name: string; data: string | Buffer }[];
  } = {},
): Promise<Uint8Array> {
  const md = o.skillMd === undefined ? SKILL_MD(o.skillName ?? "pdf-tools") : o.skillMd;
  return tgz([
    { name: "package/package.json", data: JSON.stringify(skillPackageJson(o)) },
    ...(md === null ? [] : [{ name: "package/SKILL.md", data: md }]),
    { name: "package/scripts/run.py", data: "print(1)\n" },
    ...(o.extra ?? []),
  ]);
}

export function skillZip(
  o: Parameters<typeof skillPackageJson>[0] & { prefix?: string; skillName?: string } = {},
): Uint8Array {
  const p = o.prefix ?? "";
  return new Uint8Array(
    makeZip([
      { name: `${p}package.json`, data: JSON.stringify(skillPackageJson(o)) },
      { name: `${p}SKILL.md`, data: SKILL_MD(o.skillName ?? "pdf-tools") },
      { name: `${p}scripts/run.py`, data: "print(1)\n" },
    ]),
  );
}

export function appTgz(): Promise<Uint8Array> {
  return tgz([
    {
      name: "package/package.json",
      data: JSON.stringify({
        name: "@acme/app-crm",
        version: "1.0.0",
        capybara: { kind: "app", manifest: "app.yaml" },
      }),
    },
    { name: "package/app.yaml", data: "schemaVersion: 1\n" },
  ]);
}
