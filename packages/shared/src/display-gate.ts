export const DISPLAY_GATE_SESSION_THRESHOLD = 3;

export type DisplayGateState = "no_history" | "early" | "ready";

/** M-UIa D-39: one exercise needs three distinct completed sessions before values are displayed. */
export function displayGateState(sampleSessionCount: number): DisplayGateState {
  if (sampleSessionCount <= 0) return "no_history";
  return sampleSessionCount < DISPLAY_GATE_SESSION_THRESHOLD ? "early" : "ready";
}

/** Server and offline mirror share this one gate; online clients consume the already-gated result. */
export function applyDisplayGate<T>(sampleSessionCount: number, value: T): T | null {
  return displayGateState(sampleSessionCount) === "ready" ? value : null;
}
