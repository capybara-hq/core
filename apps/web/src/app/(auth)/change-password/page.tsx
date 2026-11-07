import ChangePasswordView from "./view";

/**
 * `/change-password`: an account signed in with a generated initial password sets its own before
 * anything else (the kernel refuses every other route until then, and the `(app)` layout sends it
 * here). The layout decided on the server whether there is anything to change.
 */
export default function ChangePasswordPage() {
  return <ChangePasswordView />;
}
