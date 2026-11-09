import { readCredential } from "../state.js";

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
  // The credential itself is never printed.
  const { credential: _secret, ...shown } = cred;
  if (json) {
    out(JSON.stringify({ loggedIn: true, ...shown }));
  } else {
    out(
      [
        "Logged in.",
        `  deployment:   ${cred.url}`,
        `  organization: ${cred.orgId}`,
        `  device:       ${cred.deviceId}`,
        `  directory:    ${cred.dir}`,
        `  mode:         ${cred.mode}`,
      ].join("\n"),
    );
  }
  return 0;
}
