import {
  compareSemver,
  type PlatformUpdateComponent,
  type PlatformUpdatePreview,
} from "../../lib/catalog";
import type {
  AgentRow,
  ContentsExtension,
  ContentsRow,
  PluginContentsModel,
  RowMark,
  SkillRow,
  TemplateRow,
  ThemeRow,
} from "./model";

/** The change of a component as a row mark; an unchanged one has none. */
const markOf = (c: PlatformUpdateComponent): RowMark | undefined =>
  c.change === "same" ? undefined : c.change;

/** The extension's move as a mark: new on the deployment, or a version up or down. */
function extensionMark(preview: PlatformUpdatePreview): RowMark | undefined {
  const ext = preview.extension;
  if (ext === null || ext.to === null) return undefined;
  if (ext.from === null) return "added";
  const order = compareSemver(ext.to, ext.from);
  return order === null || order === 0 ? undefined : order > 0 ? "upgrade" : "downgrade";
}

/**
 * An update's changes laid onto the staged package's contents (plugin contents spec): every row
 * the preview names (skills by name, connector templates by id, agent templates by name, themes
 * by name) carries its change mark, and a component the package no longer holds (`removed`, or
 * one the package review does not list, such as a theme) is appended to its section as a bare
 * row with its mark. The extension's block is marked when the update installs it or moves its
 * version.
 */
export function withUpdateMarks(
  model: PluginContentsModel,
  preview: PlatformUpdatePreview,
): PluginContentsModel {
  const skills: SkillRow[] = [...model.skills];
  const templates: TemplateRow[] = [...model.templates];
  const agents: AgentRow[] = [...model.agents];
  const themes: ThemeRow[] = [...model.themes];
  /** Marks the row found in `rows`, or appends `bare()` with the mark. */
  const lay = <R extends ContentsRow>(
    rows: R[],
    found: (r: R) => boolean,
    mark: RowMark,
    bare: () => R,
  ) => {
    const i = mark === "removed" ? -1 : rows.findIndex(found);
    if (i >= 0) rows[i] = { ...(rows[i] as R), mark };
    else rows.push({ ...bare(), mark });
  };
  for (const c of preview.components) {
    const mark = markOf(c);
    if (mark === undefined) continue;
    const key = `update:${c.kind}:${c.name}`;
    switch (c.kind) {
      case "skill":
        lay<SkillRow>(
          skills,
          (r) => r.name === c.name,
          mark,
          () => ({
            kind: "skill",
            key,
            name: c.name,
            description: "",
          }),
        );
        break;
      case "connector_template":
        lay<TemplateRow>(
          templates,
          (r) => r.id === c.name,
          mark,
          () => ({
            kind: "connectorTemplate",
            key,
            id: c.name,
            name: c.name,
            description: "",
          }),
        );
        break;
      case "agent_template":
        lay<AgentRow>(
          agents,
          (r) => r.name === c.name,
          mark,
          () => ({
            kind: "agentTemplate",
            key,
            name: c.name,
            description: "",
            needs: [],
          }),
        );
        break;
      case "theme":
        lay<ThemeRow>(
          themes,
          (r) => r.name === c.name,
          mark,
          () => ({
            kind: "theme",
            key,
            name: c.name,
          }),
        );
        break;
    }
  }
  const mark = extensionMark(preview);
  const extension: ContentsExtension | undefined =
    model.extension === undefined || mark === undefined
      ? model.extension
      : { ...model.extension, mark };
  return {
    ...model,
    skills,
    templates,
    agents,
    themes,
    ...(extension !== undefined && { extension }),
  };
}
