import { expect } from "vitest";

/** Keep health records out of assertion diffs, including failed mutation runs. */
export function expectPrivateEqual(actual: unknown, expected: unknown) {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error("Private record equality mismatch");
  }
}

export function expectPrivateMatch(actual: unknown, expected: Record<string, unknown>) {
  try {
    expect(actual).toMatchObject(expected);
  } catch {
    throw new Error("Private record field mismatch");
  }
}
