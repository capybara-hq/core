import { listDeviceProviders, peekDevice } from "../device-sign-in";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The machine waiting behind a device user code (a 401 signed out; `device_sign_in.code_invalid` 404). */
export const pendingDeviceQuery = (userCode: string) =>
  defineQuery({
    key: keys.deployment().pendingDevice(userCode),
    fn: () => peekDevice(userCode),
    freshness: "deployment",
  });

/**
 * The dial-in providers on in an org that speak the code's protocol, each with the person's own
 * devices of that provider. Read again each time the page opens (a device may have been added).
 */
export const deviceProvidersQuery = (orgId: string, userCode: string) =>
  defineQuery({
    key: keys.deployment().deviceProviders(orgId, userCode),
    fn: () => listDeviceProviders(orgId, userCode),
    freshness: "live",
  });
