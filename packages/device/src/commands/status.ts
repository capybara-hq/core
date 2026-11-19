import { type OwnerCeilingPolicy, readCredential, readPolicy } from "../state.js";

/** `status`: exit 0 when logged in, 1 when not (or the credential file is unusable). */
export function status(
  stateDir: string,
  json: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  let cred: ReturnType<typeof readCredential>;
  try {
    cred = readCredential(stateDir);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  if (cred === undefined) {
    out(json ? JSON.stringify({ loggedIn: false }) : "Not logged in.");
    return 1;
  }
  // An unreadable policy file is reported by `start` and `policy show`; status still answers.
  let ceiling: OwnerCeilingPolicy | undefined;
  try {
    ceiling = readPolicy(stateDir).ownerCeiling;
  } catch {
    ceiling = undefined;
  }
  const sandbox = ceiling && { network: ceiling.network, outsideSandbox: ceiling.outsideSandbox };
  // The credential itself is never printed.
  const { credential: _secret, ...shown } = cred;
  if (json) {
    out(JSON.stringify({ loggedIn: true, ...shown, ...(sandbox && { sandbox }) }));
  } else {
    out(
      [
        "Logged in.",
        `  deployment:   ${cred.url}`,
        `  organization: ${cred.orgId}`,
        `  device:       ${cred.deviceId}`,
        `  directory:    ${cred.dir}`,
        `  mode:         ${cred.mode}`,
        `  sandbox:      ${
          sandbox
            ? `network ${sandbox.network}, outside the sandbox ${sandbox.outsideSandbox ? "allowed" : "off"}`
            : "unknown"
        }`,
      ].join("\n"),
    );
  }
  return 0;
}
