import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateTempParentName } from "../src/exec/read-model.js";
import { macUserTempDir } from "../src/exec/shared.js";

/** A device id of this test file in this process alone: concurrent runs never share its parent. */
export const testDeviceId = (name: string) => `test-${name}-${process.pid}`;

/** Removes the private temp parent the worker created for `deviceId` (both possible bases). */
export async function removeTempParent(deviceId: string): Promise<void> {
  const bases = new Set([macUserTempDir(), realpathSync(tmpdir())]);
  for (const base of bases)
    if (base)
      await rm(join(base, privateTempParentName(deviceId)), { recursive: true, force: true });
}
