import { describe, expect, it } from "vitest";
import {
  DISPLAY_GATE_SESSION_THRESHOLD,
  applyDisplayGate,
  displayGateState,
} from "../src/display-gate";

describe("3-session display gate", () => {
  it.each([
    [0, "no_history"],
    [1, "early"],
    [2, "early"],
    [3, "ready"],
    [4, "ready"],
  ] as const)("maps %i distinct completed sessions to %s", (count, state) => {
    expect(displayGateState(count)).toBe(state);
  });

  it("removes display values before the third session", () => {
    expect(DISPLAY_GATE_SESSION_THRESHOLD).toBe(3);
    expect(applyDisplayGate(2, 80)).toBeNull();
    expect(applyDisplayGate(3, 80)).toBe(80);
  });
});
