/** Independent display contract; do not derive the expected value from the formatter under test. */
export const RECORDED_BENCH_TEXT = "72.5kg × 8회 · RIR 1";

/** Use the row's stable identity for input gestures, rather than retyping translated labels.
 * Missing controls throw immediately; a dead selector cannot produce a passing zero count.
 */
export function recordInput(id: string, field: "weight" | "reps" | "rir"): HTMLInputElement {
  const input = document.getElementById(`set-${id}-${field}`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`record input absent: ${field}`);
  return input;
}

export function recordedText(id: string): string {
  const value = document.querySelector(
    `[data-planned-set-id="${id}"] button[aria-expanded="false"] > span:last-child`,
  );
  if (!value) throw new Error("collapsed record text absent");
  return value.textContent!.replace(/\s+/g, " ").trim();
}
