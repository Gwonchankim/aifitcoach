import { Prisma } from "@prisma/client";
import { resistancePrescriptionKindForWire } from "../src/sessions/planned-prescription";
import {
  canonicalSourceSnapshot,
  sourceRevision,
  validateRawSessionSetSnapshot,
} from "../src/sessions/session-set-snapshot";
const row = {
  id: "source",
  sessionId: "session",
  exerciseId: "e_plank",
  clientCorrelationId: null,
  setNo: 1,
  orderIndex: 0,
  targetRepsLow: null,
  targetRepsHigh: null,
  targetTimeLowSec: 30,
  targetTimeHighSec: 60,
  targetRir: null,
  restSec: 60,
  recommendedWeight: null,
  recommendedReps: null,
  reasonCode: "BASELINE",
  confidence: new Prisma.Decimal(0.5),
  rulesVersion: "2026.09.1",
  loadSemantics: "external_load" as const,
  assistanceStepKg: null,
  assistanceProvenance: null,
};
describe("T06 S2 discriminated snapshots", () => {
  it("does not interpret cardio with resistance-shaped fields as resistance append source", () => {
    expect(
      validateRawSessionSetSnapshot({ ...row, prescriptionKind: "steady_cardio" } as typeof row)
        .status,
    ).toBe("invalid_raw");
  });
  it("preserves legacy canonical bytes and binds explicit kind to source revision", () => {
    expect(canonicalSourceSnapshot({ ...row, prescriptionKind: null } as typeof row)).toBe(
      canonicalSourceSnapshot(row),
    );
    expect(sourceRevision({ ...row, prescriptionKind: "resistance" } as typeof row)).not.toBe(
      sourceRevision(row),
    );
  });
  it("binds intensity and fallback payload to cardio source identity", () => {
    const cardio = {
      ...row,
      prescriptionKind: "steady_cardio",
      durationSec: 600,
      intensitySeconds: { moderate: 600, high: 0, recovery: 0 },
    };
    expect(
      sourceRevision({
        ...cardio,
        intensitySeconds: { moderate: 599, high: 1, recovery: 0 },
      } as typeof row),
    ).not.toBe(sourceRevision(cardio));
  });
});

describe("S2 each cardio payload field participates in source identity", () => {
  it.each(
    Object.entries({
      durationSec: 1200,
      rpeScaleId: "relative_effort_0_10_v1",
      targetRpeLow: 5,
      targetRpeHigh: 6,
      workSec: 60,
      recoverySec: 60,
      rounds: 6,
      finalRecoveryIncluded: true,
      recoveryRpeLow: 2,
      recoveryRpeHigh: 3,
      longSessionFlag: true,
      progressionAxis: "duration_sec",
      sourceDay: "FRI",
      sourceOrdinal: 4,
      intensitySeconds: { moderate: 1200, high: 0, recovery: 0 },
      cardioFallback: { cause: "redesign_recovery" },
    }),
  )("binds %s", (key, value) => {
    const source = { ...row, prescriptionKind: "steady_cardio" };
    expect(sourceRevision({ ...source, [key]: value })).not.toBe(sourceRevision(source));
  });
});

describe("S2 raw-kind and public-wire compatibility", () => {
  it.each(["2026.08.1", "2026.08.2"])(
    "does not add a kind to V1 %s even for new explicitly tagged rows",
    (rulesVersion) => {
      expect(
        resistancePrescriptionKindForWire({ ...row, rulesVersion, prescriptionKind: "resistance" }),
      ).toEqual({});
    },
  );
  it.each(["2026.09.0", "2026.09.1"])(
    "requires explicit resistance kind in new V2 %s",
    (rulesVersion) => {
      expect(
        resistancePrescriptionKindForWire({ ...row, rulesVersion, prescriptionKind: "resistance" }),
      ).toEqual({ prescription_kind: "resistance" });
      expect(
        resistancePrescriptionKindForWire({ ...row, rulesVersion, prescriptionKind: null }),
      ).toEqual({});
    },
  );
  it("unknown legacy bundle does not invent a kind", () => {
    expect(
      resistancePrescriptionKindForWire({
        ...row,
        rulesVersion: "unknown",
        prescriptionKind: "resistance",
      }),
    ).toEqual({});
  });
});
