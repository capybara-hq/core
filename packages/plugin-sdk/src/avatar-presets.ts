/**
 * The ten built-in pixel-animal agent avatars (drawn by `@capybara-hq/design`), in the picker's
 * order. A theme may hide them (`hideAvatarPresets`) and may not reuse their ids for its own
 * presets (`avatars`). The kernel's preset ids are this list; the design package keeps a copy.
 */
export const BUILTIN_AVATAR_PRESET_IDS = [
  "capybara",
  "black-bear",
  "panda",
  "elephant",
  "fox",
  "owl",
  "penguin",
  "rabbit",
  "turtle",
  "whale",
] as const;

/** One of {@link BUILTIN_AVATAR_PRESET_IDS}. */
export type BuiltinAvatarPresetId = (typeof BUILTIN_AVATAR_PRESET_IDS)[number];
