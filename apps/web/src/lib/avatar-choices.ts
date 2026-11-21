"use client";

import {
  AVATAR_PRESET_IDS,
  type AvatarChoice,
  type AvatarExtraPreset,
  type PresetId,
  visibleAvatarChoices,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale } from "next-intl";
import { useMemo } from "react";
import type { PresetAvatarInput } from "./agents";
import { retryOnMountOf } from "./query/client";
import { orgThemesQuery } from "./query/themes";
import { type OrgThemes, themeName } from "./themes";

/** A preset the picker offers: a built-in or a theme preset of the org's default theme. */
export type PresetChoice = Extract<AvatarChoice, { kind: "preset" } | { kind: "theme" }>;

/** The avatar choices of an org (theme brand coverage spec §4), as the pickers take them. */
export interface AvatarChoices {
  /** The built-ins the org's default theme hides (not offered; a stored one still draws). */
  hidden: readonly PresetId[];
  /** The theme's own presets, named in the UI locale. */
  extra: readonly AvatarExtraPreset[];
  /**
   * A random visible choice, for a new agent's preselected avatar; null when nothing is visible
   * or the org's themes have not been read (the kernel then picks its own default).
   */
  randomChoice(random?: () => number): PresetChoice | null;
}

const isBuiltin = (id: string): id is PresetId =>
  (AVATAR_PRESET_IDS as readonly string[]).includes(id);

/**
 * The choices of `avatars` (the org's theme listing; `undefined`: not read): theme preset names in
 * `locale` (zh falls back to en).
 */
export function avatarChoicesOf(
  avatars: OrgThemes["avatars"] | undefined,
  locale: string,
): AvatarChoices {
  const hidden = (avatars?.hidden ?? []).filter(isBuiltin);
  const extra = (avatars?.presets ?? []).map(
    (p): AvatarExtraPreset => ({ key: p.key, name: themeName(p, locale), src: p.url }),
  );
  return {
    hidden,
    extra,
    randomChoice: (random = Math.random) => {
      if (avatars === undefined) return null;
      const visible = visibleAvatarChoices(hidden, extra) as PresetChoice[];
      return visible[Math.min(visible.length - 1, Math.floor(random() * visible.length))] ?? null;
    },
  };
}

/**
 * The avatar choices of the org's effective default theme, from its theme listing (the shell's
 * read: in the cache on every workspace page). Every member sees the same choices.
 */
export function useAvatarChoices(orgId: string): AvatarChoices {
  const q = orgThemesQuery(orgId);
  const avatars = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data?.avatars;
  const locale = useLocale();
  return useMemo(() => avatarChoicesOf(avatars, locale), [avatars, locale]);
}

/** The kernel input of a choice: a theme preset is written as `{ kind: "preset", id: key }`. */
export const avatarInputOf = (c: PresetChoice): PresetAvatarInput =>
  c.kind === "preset" ? { kind: "preset", id: c.id } : { kind: "preset", id: c.key };

/** A picker choice as a preset (null for an image or none, which the caller handles). */
export const presetChoiceOf = (c: AvatarChoice): PresetChoice | null =>
  c?.kind === "preset" || c?.kind === "theme" ? c : null;

/**
 * The picker value of a written preset id: a built-in as itself, a theme preset key as its tile
 * while the org's theme offers it, else null.
 */
export function choiceOfPresetId(
  id: string,
  extra: readonly AvatarExtraPreset[],
): PresetChoice | null {
  if (isBuiltin(id)) return { kind: "preset", id };
  const e = extra.find((x) => x.key === id);
  return e === undefined ? null : { kind: "theme", key: e.key, src: e.src };
}

/** The tile of a stored theme avatar while the org's theme still offers it (same asset URL). */
export function themeTileOf(url: string, extra: readonly AvatarExtraPreset[]): PresetChoice | null {
  const e = extra.find((x) => x.src === url);
  return e === undefined ? null : { kind: "theme", key: e.key, src: e.src };
}
