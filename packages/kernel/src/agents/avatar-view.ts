import { themeUrl } from "../themes/theme-state.js";
import type { AgentAvatar, AgentAvatarView } from "./profile.js";

/**
 * An agent's stored avatar as the agent API returns it (theme brand coverage spec §4): a `theme`
 * avatar gains `url`, the immutable asset URL of the theme version it is pinned to (served after
 * the theme updates or leaves the org); every other kind as stored. The one mapping for every view
 * that returns an agent avatar (agent lookup, admin agents, conversation groups).
 */
export function avatarView(stored: AgentAvatar): AgentAvatarView {
  if (stored?.kind !== "theme") return stored;
  return { ...stored, url: themeUrl(stored.themeId, stored.version, stored.file) };
}
