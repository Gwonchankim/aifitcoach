import { describe, expect, it } from "vitest";
import { similarSourceE1rm } from "../src/similar-init";

describe("similarSourceE1rm", () => {
  it("uses working sets and the engine e1RM calculation", () => {
    expect(similarSourceE1rm([{ w: 60, reps: 10, rir: 2 }], 0)).toBe(84);
    expect(
      similarSourceE1rm(
        [
          { w: -100, reps: 5 },
          { w: 60, reps: 10, rir: 2 },
        ],
        0,
      ),
    ).toBe(84);
  });

  it("returns undefined when all reps are zero", () => {
    expect(similarSourceE1rm([{ w: 60, reps: 0, rir: 2 }], 0)).toBeUndefined();
  });

  it("preserves zero load as zero for the caller to reject", () => {
    expect(similarSourceE1rm([{ w: 0, reps: 10, rir: 2 }], 0)).toBe(0);
  });

  it("applies the same RIR bias and low-rep preference as the engine", () => {
    expect(similarSourceE1rm([{ w: 60, reps: 10, rir: 2 }], 1)).toBe(86);
    expect(
      similarSourceE1rm(
        [
          { w: 60, reps: 10 },
          { w: 50, reps: 5, rir: 2 },
        ],
        1,
      ),
    ).toBe(63.33);
  });
});
