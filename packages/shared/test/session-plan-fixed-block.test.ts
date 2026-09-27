import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateSessionSeconds, packSession, SESSION_SET_CAP } from "../src/session-plan";
import type { PackInput, PackedExercise } from "../src/session-plan";

const fixtureNames = ["session-plan-base-1e15737.json", "program-packer-base-1e15737.json"];
const frozen = fixtureNames.map((name) => {
  const raw = readFileSync(resolve(__dirname, "fixtures", name), "utf8");
  return {
    name,
    raw,
    fixture: JSON.parse(raw) as {
      capture_commit: string;
      source_sha256: Record<string, string>;
      cases: { input: PackInput; output: PackedExercise[] }[];
    },
  };
});

describe("fixed block preserves the frozen resistance packer", () => {
  it("locks capture provenance and the shared fixture bytes", () => {
    expect(createHash("sha256").update(frozen[0]!.raw).digest("hex")).toBe(
      "0e1401c1777a1ba34c44e7ac1713305d8a32614c1607aacdeaca50fbacf0b3de",
    );
    expect(createHash("sha256").update(frozen[1]!.raw).digest("hex")).toBe(
      "4d39b16390207f8d34fcf8fb103ac420d0980b0e57690ad0a29caafdae2d6f5e",
    );
    for (const { fixture } of frozen) {
      expect(fixture.capture_commit).toBe("1e1573747d08ee9817c7af29d05bfc97412cd4a5");
      expect(fixture.source_sha256["packages/shared/src/session-plan.ts"]).toBe(
        "7c588766f497d7898744dea91938c5294a2aeb36b0a021e0084cd19d16fe248a",
      );
      expect(fixture.cases.length).toBeGreaterThan(0);
    }
  });

  it("omitted_and_zero_are_byte_identical_to_frozen_packer", () => {
    for (const { name, fixture } of frozen) {
      for (const [index, test] of fixture.cases.entries()) {
        const expected = JSON.stringify(test.output);
        expect(JSON.stringify(packSession(test.input)), `${name}:${index}:omitted`).toBe(expected);
        expect(
          JSON.stringify(packSession({ ...test.input, additional_fixed_block_sec: 0 })),
          `${name}:${index}:zero`,
        ).toBe(expected);
      }
    }
  });

  it("positive_block_tightens_only_time_budget", () => {
    for (const { fixture } of frozen) {
      for (const { input } of fixture.cases) {
        for (const block of [300, 600, 720, 1800, 5400]) {
          const result = packSession({ ...input, additional_fixed_block_sec: block });
          if (!result.length) continue;
          expect(result.reduce((sum, item) => sum + item.sets, 0)).toBeLessThanOrEqual(
            SESSION_SET_CAP[input.minutesPerDay]!,
          );
          expect(
            estimateSessionSeconds({
              exercises: result.map((item) => ({
                sets: item.sets,
                reps_high: item.candidate.target_reps_high,
                time_high_sec: item.candidate.target_time_high_sec,
                unilateral: item.candidate.unilateral,
              })),
              restSec: input.restSec,
            }) + block,
          ).toBeLessThanOrEqual(input.minutesPerDay * 60);
          expect(result.find((item) => item.role === "primary")?.sets).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("keeps primary at two sets and fails closed when it cannot fit", () => {
    const input = frozen[0]!.fixture.cases[0]!.input;
    expect(packSession({ ...input, additional_fixed_block_sec: 800 })).toEqual([
      { candidate: input.candidates[0], role: "primary", sets: 2 },
    ]);
    expect(packSession({ ...input, additional_fixed_block_sec: 801 })).toEqual([]);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid block %s",
    (block) => {
      expect(() =>
        packSession({ ...frozen[0]!.fixture.cases[0]!.input, additional_fixed_block_sec: block }),
      ).toThrow(RangeError);
    },
  );
});
