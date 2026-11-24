"use client";

import { BlockBoundary } from "../conversation/BlockBoundary";
import type { FilePreviewEmbedHost } from "../file-preview/FilePreviewBody";
import { EmbedTab } from "./EmbedTab";

/**
 * An embed previewer of a skill file (skill file browser design, the Files tab): `EmbedTab` with
 * the org's token minted for `{ skillId, version, path }` inside its own `BlockBoundary`. Not an
 * `ExtensionSlot`: the `file.preview` slot is the right panel's and names a conversation's file;
 * the previewer comes from the skill file's previewer list.
 */
export function SkillPreviewEmbed({
  orgId,
  skill,
  host,
}: {
  orgId: string;
  skill: { skillId: string; version: number; path: string };
  host: FilePreviewEmbedHost;
}) {
  const { previewer } = host;
  const id = `${skill.version}/${skill.path}`;
  return (
    <BlockBoundary name={host.title}>
      <EmbedTab
        key={`${previewer.plugin}/${previewer.id}/${id}`}
        orgId={orgId}
        skill={skill}
        plugin={previewer.plugin}
        id={previewer.id}
        title={host.title}
        file={{ id, maxBytes: previewer.maxBytes, read: host.read }}
        fill
        failed={host.failed}
      />
    </BlockBoundary>
  );
}
