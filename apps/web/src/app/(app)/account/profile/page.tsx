import ProfileView from "./view";

/**
 * `/account/profile` (any signed-in person; no org needed, so no readiness gate). It reads
 * nothing: the name and the avatar are in `me`, which the layout prefetches.
 */
export default function ProfilePage() {
  return <ProfileView />;
}
