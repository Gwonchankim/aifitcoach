export const DISPLAY_GATE_SESSION_THRESHOLD = 3;

export type DisplayGateState = "no_history" | "early" | "ready";

/** ADR-70: three completed sessions unlock analysis (confidence, e1RM and trends) only. */
export function displayGateState(sampleSessionCount: number): DisplayGateState {
  if (sampleSessionCount <= 0) return "no_history";
  return sampleSessionCount < DISPLAY_GATE_SESSION_THRESHOLD ? "early" : "ready";
}

/** Analysis-only gate. Prescriptions are controlled independently by recommendation_state. */
export function applyDisplayGate<T>(sampleSessionCount: number, value: T): T | null {
  return displayGateState(sampleSessionCount) === "ready" ? value : null;
}
