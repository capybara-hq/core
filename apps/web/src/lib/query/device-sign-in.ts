import { peekDevice } from "../device-sign-in";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The machine waiting behind a device user code (a 401 signed out; `device_sign_in.code_invalid` 404). */
export const pendingDeviceQuery = (userCode: string) =>
  defineQuery({
    key: keys.deployment().pendingDevice(userCode),
    fn: () => peekDevice(userCode),
    freshness: "deployment",
  });
