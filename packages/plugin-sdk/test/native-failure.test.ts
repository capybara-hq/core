import { describe, expect, it } from "vitest";
import {
  NATIVE_FAILURE_GENERIC,
  NATIVE_NOT_REGULAR_FILE,
  nativeFailureText,
} from "../src/native-failure.js";

describe("nativeFailureText (#907)", () => {
  it("names the cause of a known code", () => {
    expect(nativeFailureText(NATIVE_NOT_REGULAR_FILE)).toMatch(/not a regular file/);
    expect(nativeFailureText("ENOENT")).toMatch(/does not exist/);
    expect(nativeFailureText("ENOSPC")).toMatch(/disk is full/);
  });
  it("keeps the generic text for an unknown or missing code, never an inherited key", () => {
    for (const code of ["INVALID_NATIVE_REQUEST", "EWHATEVER", "toString", undefined])
      expect(nativeFailureText(code)).toBe(NATIVE_FAILURE_GENERIC);
  });
});
