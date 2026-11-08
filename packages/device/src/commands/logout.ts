import { removeCredential } from "../state.js";

/** `logout`: forgets the credential on this machine. Revoking it on the platform is done there. */
export function logout(stateDir: string, out: (line: string) => void): number {
  out(
    removeCredential(stateDir)
      ? "Logged out. The working directory was left in place."
      : "Not logged in.",
  );
  return 0;
}
