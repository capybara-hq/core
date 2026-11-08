import { peekDevice } from "../devices";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The machine waiting behind a device user code (a 401 signed out; `device.code_invalid` 404). */
export const pendingDeviceQuery = (userCode: string) =>
  defineQuery({
    key: keys.deployment().pendingDevice(userCode),
    fn: () => peekDevice(userCode),
    freshness: "deployment",
  });
