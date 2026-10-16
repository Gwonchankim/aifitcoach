/** Preserve Jest's equality semantics without dumping health records on failure. */
export function expectPrivateEqual(actual: unknown, expected: unknown) {
  try {
    expect(actual).toEqual(expected);
  } catch {
    throw new Error("Private record equality mismatch");
  }
}
