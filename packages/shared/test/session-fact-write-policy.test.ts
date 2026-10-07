import { describe, expect, it } from "vitest";
import {
  classifySessionFactWriteDate,
  isSessionFactWriteAllowed,
} from "../src/session-fact-write-policy";

describe("BUG-10 session fact write window (A: UTC today + previous UTC day)", () => {
  it.each([
    ["2026-09-18", "2026-09-18", "today"],
    ["2026-09-17", "2026-09-18", "previous"],
    ["2026-09-16", "2026-09-18", "older"],
    ["2026-09-07", "2026-09-18", "older"],
    ["2026-09-19", "2026-09-18", "future"],
    ["2026-12-31", "2026-09-18", "future"],
  ] as const)("classifies scheduled %s on UTC today %s as %s", (scheduled, today, expected) => {
    expect(classifySessionFactWriteDate(scheduled, today)).toBe(expected);
  });

  it.each([
    // month, year and leap-day boundaries are calendar days, not string arithmetic
    ["2026-09-30", "2026-10-01", "previous"],
    ["2026-09-29", "2026-10-01", "older"],
    ["2025-12-31", "2026-01-01", "previous"],
    ["2028-02-29", "2028-03-01", "previous"],
    ["2028-02-28", "2028-03-01", "older"],
    ["2026-10-01", "2026-09-30", "future"],
  ] as const)("crosses calendar boundaries: %s on %s is %s", (scheduled, today, expected) => {
    expect(classifySessionFactWriteDate(scheduled, today)).toBe(expected);
  });

  it("allows actual/completion writes only for today and the previous UTC day", () => {
    expect(isSessionFactWriteAllowed("2026-09-18", "2026-09-18")).toBe(true);
    expect(isSessionFactWriteAllowed("2026-09-17", "2026-09-18")).toBe(true);
    expect(isSessionFactWriteAllowed("2026-09-16", "2026-09-18")).toBe(false);
    expect(isSessionFactWriteAllowed("2026-09-19", "2026-09-18")).toBe(false);
  });

  it.each([
    ["", "2026-09-18"],
    ["2026-9-18", "2026-09-18"],
    ["2026-02-30", "2026-03-01"],
    ["2026-09-18T00:00:00.000Z", "2026-09-18"],
    ["2026-09-18", "not-a-date"],
    ["2026-09-18", "2026-13-01"],
  ])("fails closed on a non-UTC-calendar input (%s, %s)", (scheduled, today) => {
    expect(() => classifySessionFactWriteDate(scheduled, today)).toThrow(RangeError);
    expect(() => isSessionFactWriteAllowed(scheduled, today)).toThrow(RangeError);
  });
});
