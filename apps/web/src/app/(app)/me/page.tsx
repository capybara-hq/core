import Me from "./view";

/**
 * `/me` (the compact class's 我 tab; every role in an org): the account, the org switcher and
 * what the sidebar holds. It reads nothing of its own: the view draws the shell's data.
 */
export default function MePage() {
  return <Me />;
}
