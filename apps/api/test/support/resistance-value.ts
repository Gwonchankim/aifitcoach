/** Existing resistance-only oracles must reject a cardio/null payload, never coerce it to zero. */
export function resistanceValue(value: number | null): number {
  expect(value).not.toBeNull();
  if (value === null) throw new Error("Expected a resistance value");
  return value;
}
