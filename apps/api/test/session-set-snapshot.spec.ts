import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { rawAssistanceSafetyStatus, toRawTargetRow } from "../src/programs/assistance-migration";
import {
  appendIntentHash,
  appendEligibility,
  canonicalSourceSnapshot,
  cohortRevision,
  copySessionSetSnapshot,
  sourceRevision,
  isAppendCohortSafe,
  validateRawSessionSetSnapshot,
  type RawSessionSetSnapshot,
  type AppendCohort,
} from "../src/sessions/session-set-snapshot";

const D = (value: string | number) => new Prisma.Decimal(value);
const ID = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";
const CORRELATION = "00000000-0000-4000-8000-000000000003";
function row(overrides: Partial<RawSessionSetSnapshot> = {}): RawSessionSetSnapshot {
  return {
    id: ID,
    sessionId: SESSION,
    exerciseId: "e_assisted_dips",
    clientCorrelationId: null,
    setNo: 2,
    orderIndex: 3,
    targetRepsLow: 6,
    targetRepsHigh: 12,
    targetTimeLowSec: null,
    targetTimeHighSec: null,
    targetRir: 2,
    restSec: 120,
    recommendedWeight: D(20),
    recommendedReps: 8,
    reasonCode: "ASSISTANCE_DOWN_REP_TARGET_MET",
    confidence: D("0.75"),
    rulesVersion: "2026.08.2",
    loadSemantics: "assistance",
    assistanceStepKg: D(5),
    assistanceProvenance: "native",
    performedSets: [],
    ...overrides,
  };
}
function cohort(rows: RawSessionSetSnapshot[]): AppendCohort {
  return {
    userId: "owner-1",
    sessionId: SESSION,
    exerciseId: rows[0]?.exerciseId ?? "e_assisted_dips",
    rows,
  };
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("session append raw revisions and identity", () => {
  it("pins canonical key order, nullable encoding and non-exponential decimal strings", () => {
    const expected =
      '{"version":1,"sourceId":"00000000-0000-4000-8000-000000000001","sessionId":"00000000-0000-4000-8000-000000000002","exerciseId":"e_assisted_dips","clientCorrelationId":null,"setNo":2,"orderIndex":3,"targetRepsLow":6,"targetRepsHigh":12,"targetTimeLowSec":null,"targetTimeHighSec":null,"targetRir":2,"restSec":120,"recommendedWeight":"20","recommendedReps":8,"reasonCode":"ASSISTANCE_DOWN_REP_TARGET_MET","confidence":"0.75","rulesVersion":"2026.08.2","loadSemantics":"assistance","assistanceStepKg":"5","assistanceProvenance":"native"}';
    expect(canonicalSourceSnapshot(row())).toBe(expected);
    expect(sourceRevision(row())).toBe(digest(expected));
    expect(
      sourceRevision(
        row({ recommendedWeight: D("2e1"), confidence: D(".7500"), assistanceStepKg: D("5.00") }),
      ),
    ).toBe(sourceRevision(row()));
    expect(canonicalSourceSnapshot(row({ recommendedWeight: D("1e-7") }))).toContain(
      '"recommendedWeight":"0.0000001"',
    );
    expect(
      sourceRevision(
        row({
          clientCorrelationId: undefined,
          targetTimeLowSec: undefined,
        } as unknown as Partial<RawSessionSetSnapshot>),
      ),
    ).toBe(sourceRevision(row()));
    expect(canonicalSourceSnapshot(row({ recommendedWeight: D(-0) }))).toContain(
      '"recommendedWeight":"0"',
    );
  });

  it.each(
    Object.entries({
      id: CORRELATION,
      sessionId: CORRELATION,
      exerciseId: "e_assisted_pullup",
      clientCorrelationId: CORRELATION,
      setNo: 3,
      orderIndex: 4,
      targetRepsLow: 7,
      targetRepsHigh: 13,
      targetTimeLowSec: 30,
      targetTimeHighSec: 60,
      targetRir: 3,
      restSec: 90,
      recommendedWeight: D(25),
      recommendedReps: 9,
      reasonCode: "ASSISTANCE_MINIMUM_REACHED",
      confidence: D("0.9"),
      rulesVersion: "2026.09.0",
      loadSemantics: "external_load",
      assistanceStepKg: D(10),
      assistanceProvenance: "remediated",
    }),
  )("revision changes on raw %s", (key, value) => {
    expect(sourceRevision(row({ [key]: value }))).not.toBe(sourceRevision(row()));
  });

  it("excludes performed/actual/update/catalog/display state without mutating the source", () => {
    const original = row();
    const enriched = {
      ...original,
      updatedAt: new Date(),
      performedSets: [{ completed: true, actualWeight: D(30), painScore: "opaque" }],
      recommendation_gate: "no_history",
      recommended_action: null,
      exercise: { loadSemantics: "external_load" },
    };
    expect(sourceRevision(enriched)).toBe(sourceRevision(original));
    expect(enriched.performedSets[0].actualWeight.toString()).toBe("30");
  });

  it("copies only A05 raw fields, preserving Decimal/null and excluding all facts and identity", () => {
    const original = row({ performedSets: [{ completed: true }] });
    const copied = copySessionSetSnapshot(original);
    expect(Object.keys(copied)).toEqual([
      "targetRepsLow",
      "targetRepsHigh",
      "targetTimeLowSec",
      "targetTimeHighSec",
      "targetRir",
      "restSec",
      "recommendedWeight",
      "recommendedReps",
      "reasonCode",
      "confidence",
      "rulesVersion",
      "loadSemantics",
      "assistanceStepKg",
      "assistanceProvenance",
      "orderIndex",
    ]);
    for (const key of Object.keys(copied) as Array<keyof typeof copied>)
      expect(copied[key]).toBe(original[key]);
    expect(copied).not.toHaveProperty("performedSets");
    expect(copied).not.toHaveProperty("id");
    expect(copied).not.toHaveProperty("setNo");
  });

  it("cohort revision binds owner, membership, raw revision and actual completed=true only", () => {
    const first = row();
    const second = row({ id: CORRELATION, setNo: 3 });
    const value = cohort([first, second]);
    expect(cohortRevision(value)).toBe(cohortRevision(cohort([second, first])));
    expect(cohortRevision(value)).not.toBe(cohortRevision({ ...value, userId: "owner-2" }));
    expect(cohortRevision(value)).not.toBe(cohortRevision(cohort([first])));
    expect(cohortRevision(value)).not.toBe(
      cohortRevision(cohort([first, { ...second, restSec: 90 }])),
    );
    expect(cohortRevision(cohort([first]))).toBe(
      cohortRevision(cohort([{ ...first, performedSets: [{ completed: false }] }])),
    );
    expect(cohortRevision(cohort([first]))).not.toBe(
      cohortRevision(cohort([{ ...first, performedSets: [{ completed: true }] }])),
    );
    expect(cohortRevision(cohort([{ ...first, performedSets: [{ completed: true }] }]))).toBe(
      cohortRevision(
        cohort([{ ...first, performedSets: [{ completed: false }, { completed: true }] }]),
      ),
    );
  });

  it("hashes the stable append intent across POST/sync updated_at retries, without rewriting it", () => {
    const intent = {
      client_id: ID,
      exercise_id: "e_assisted_dips",
      correlation_id: CORRELATION,
      source: { source_planned_set_id: ID, source_revision: "a".repeat(64) },
    };
    const frozen = JSON.stringify(intent);
    const expected = digest(
      JSON.stringify({
        operation: "session_set/upsert",
        session_id: SESSION,
        exercise_id: intent.exercise_id,
        correlation_id: CORRELATION,
        source: intent.source,
      }),
    );
    expect(appendIntentHash(SESSION, intent)).toBe(expected);
    expect(appendIntentHash(SESSION, { ...intent, updated_at: "2026-08-14T10:00:00Z" })).toBe(
      expected,
    );
    expect(appendIntentHash(SESSION, { ...intent, updated_at: "2026-08-15T10:00:00Z" })).toBe(
      expected,
    );
    expect(
      appendIntentHash(SESSION, { ...intent, source: { source_correlation_id: ID } }),
    ).not.toBe(expected);
    expect(
      appendIntentHash(SESSION, {
        ...intent,
        source: { ...intent.source, source_revision: "b".repeat(64) },
      }),
    ).not.toBe(expected);
    expect(appendIntentHash(CORRELATION, intent)).not.toBe(expected);
    expect(JSON.stringify(intent)).toBe(frozen);
  });
});

describe("I01 UUID identity normalization, without rewriting transport or opaque values", () => {
  const uuid = "abcdefab-1234-4abc-8def-abcdefabcdef";
  it.each(["planned", "correlation"] as const)(
    "normalizes only UUID identity for %s source",
    (kind) => {
      const intent = {
        exercise_id: "e_CaseSensitive",
        correlation_id: uuid,
        source:
          kind === "planned"
            ? { source_planned_set_id: uuid, source_revision: "Ab".repeat(32) }
            : { source_correlation_id: uuid },
        client_id: ID,
        updated_at: "2026-08-14T10:00:00Z",
      };
      const upper = {
        ...intent,
        correlation_id: uuid.toUpperCase(),
        source:
          kind === "planned"
            ? { source_planned_set_id: uuid.toUpperCase(), source_revision: "Ab".repeat(32) }
            : { source_correlation_id: uuid.toUpperCase() },
      };
      const before = JSON.stringify(upper);
      expect(appendIntentHash(uuid.toUpperCase(), upper)).toBe(appendIntentHash(uuid, intent));
      expect(JSON.stringify(upper)).toBe(before);
      expect(appendIntentHash(uuid, { ...intent, client_id: CORRELATION })).toBe(
        appendIntentHash(uuid, intent),
      );
      expect(appendIntentHash(uuid, { ...intent, exercise_id: "e_casesensitive" })).not.toBe(
        appendIntentHash(uuid, intent),
      );
      if (kind === "planned")
        expect(
          appendIntentHash(uuid, {
            ...intent,
            source: { source_planned_set_id: uuid, source_revision: "ab".repeat(32) },
          }),
        ).not.toBe(appendIntentHash(uuid, intent));
    },
  );
  it("keeps A06 source raw identity strings verbatim", () => {
    expect(sourceRevision(row({ id: uuid }))).not.toBe(
      sourceRevision(row({ id: uuid.toUpperCase() })),
    );
  });
});

describe("A08 / M4 copy eligibility (raw safety independent of sample display gate)", () => {
  const cases: Array<
    [
      string,
      Partial<RawSessionSetSnapshot>,
      "safe" | "unsafe" | null,
      "safe" | "unsafe" | null,
      boolean,
    ]
  > = [
    [
      "external assisted catalog ID",
      {
        loadSemantics: "external_load",
        assistanceStepKg: null,
        assistanceProvenance: null,
        rulesVersion: "2026.08.1",
        reasonCode: "BASELINE",
      },
      null,
      null,
      true,
    ],
    [
      "bodyweight",
      {
        loadSemantics: "external_load",
        assistanceStepKg: null,
        assistanceProvenance: null,
        recommendedWeight: null,
      },
      null,
      null,
      true,
    ],
    [
      "time",
      {
        loadSemantics: "external_load",
        assistanceStepKg: null,
        assistanceProvenance: null,
        recommendedWeight: null,
        recommendedReps: null,
        targetRepsLow: null,
        targetRepsHigh: null,
        targetRir: null,
        targetTimeLowSec: 30,
        targetTimeHighSec: 60,
      },
      null,
      null,
      true,
    ],
    ["native ready", {}, "safe", "safe", true],
    ["remediated", { assistanceProvenance: "remediated" }, "safe", "safe", true],
    [
      "calibration",
      { reasonCode: "ASSISTANCE_CALIBRATION_NEEDED", recommendedWeight: null },
      "safe",
      "safe",
      true,
    ],
    ["pain", { reasonCode: "SUBSTITUTE_PAIN", recommendedWeight: null }, "safe", "safe", true],
    ["invalid", { reasonCode: "INVALID_INPUT", recommendedWeight: null }, "safe", "safe", true],
    [
      "performed safe zero copy unsafe",
      { recommendedWeight: D(0), performedSets: [{ completed: true }] },
      "safe",
      "unsafe",
      false,
    ],
    [
      "performed safe null copy unsafe",
      { recommendedWeight: null, performedSets: [{ completed: true }] },
      "safe",
      "unsafe",
      false,
    ],
    [
      "performed generic copy unsafe",
      { reasonCode: "BASELINE", performedSets: [{ completed: true }] },
      "safe",
      "unsafe",
      false,
    ],
    [
      "uncompleted fact is not performed",
      { reasonCode: "BASELINE", performedSets: [{ completed: false }] },
      "unsafe",
      "unsafe",
      false,
    ],
    [
      "legacy fact",
      {
        rulesVersion: "2026.08.1",
        assistanceProvenance: "legacy_performed",
        performedSets: [{ completed: true }],
      },
      "safe",
      "unsafe",
      false,
    ],
    ["pain weight present", { reasonCode: "SUBSTITUTE_PAIN" }, "unsafe", "unsafe", false],
    ["invalid weight present", { reasonCode: "INVALID_INPUT" }, "unsafe", "unsafe", false],
    ["missing step but raw safe", { assistanceStepKg: null }, "safe", "safe", false],
    ["zero step but raw safe", { assistanceStepKg: D(0) }, "safe", "safe", false],
    ["negative step", { assistanceStepKg: D(-5) }, "safe", "safe", false],
    ["missing provenance", { assistanceProvenance: null }, "unsafe", "unsafe", false],
    [
      "unknown version performed raw safe",
      { rulesVersion: "2099.01", performedSets: [{ completed: true }] },
      "safe",
      "unsafe",
      false,
    ],
    [
      "remediated version mismatch",
      { assistanceProvenance: "remediated", rulesVersion: "2026.09.0" },
      "safe",
      "safe",
      false,
    ],
    [
      "external step",
      { loadSemantics: "external_load", assistanceProvenance: null },
      null,
      null,
      false,
    ],
    [
      "external provenance",
      { loadSemantics: "external_load", assistanceStepKg: null },
      null,
      null,
      false,
    ],
  ];
  for (const exerciseId of ["e_assisted_pullup", "e_assisted_dips"]) {
    for (const samples of [0, 1, 2, 3]) {
      it.each(cases)(`${exerciseId} samples=${samples}: %s`, (_name, overrides, S, C, allowed) => {
        const source = row({ exerciseId, ...overrides });
        const raw = toRawTargetRow(
          source,
          source.performedSets?.some((p) => p.completed === true) ?? false,
        );
        expect(rawAssistanceSafetyStatus(raw)).toBe(S);
        expect(rawAssistanceSafetyStatus({ ...raw, hasServerAppliedPerformedFact: false })).toBe(C);
        const before = JSON.stringify(source);
        // Display gate metadata is deliberately not a guard/hash input, even when it hides raw values.
        const withDisplay = {
          ...source,
          recommendation_gate: samples === 0 ? "no_history" : samples < 3 ? "early" : "ready",
          recommendation_state: null,
        };
        const result = appendEligibility(cohort([withDisplay]), source.id);
        expect(result).toEqual({
          version: 1,
          source_revision: sourceRevision(source),
          cohort_revision: cohortRevision(cohort([source])),
          status: allowed ? "allowed" : "blocked",
          reason: allowed ? null : "unsafe_assistance_snapshot",
        });
        expect(JSON.stringify(source)).toBe(before);
      });
    }
  }

  it.each(["native", "remediated"] as const)(
    "allows completed/uncompleted %s with differing weight/reason/confidence",
    (assistanceProvenance) => {
      const source = row({ assistanceProvenance });
      const sibling = row({
        id: CORRELATION,
        setNo: 3,
        assistanceProvenance,
        recommendedWeight: D(10),
        reasonCode: "ASSISTANCE_MINIMUM_REACHED",
        confidence: D(".9"),
        performedSets: [{ completed: true }],
      });
      expect(appendEligibility(cohort([source, sibling]), source.id)?.status).toBe("allowed");
    },
  );

  it.each([
    { loadSemantics: "external_load", assistanceProvenance: null, assistanceStepKg: null },
    { rulesVersion: "2026.09.0" },
    { assistanceProvenance: "remediated" },
    { assistanceStepKg: D(10) },
    { reasonCode: "SUBSTITUTE_PAIN", recommendedWeight: D(20) },
  ] as Partial<RawSessionSetSnapshot>[])(
    "rejects mixed or unsafe sibling even if the selected source is safe: %j",
    (change) => {
      const source = row();
      expect(
        appendEligibility(
          cohort([source, row({ id: CORRELATION, setNo: 3, ...change })]),
          source.id,
        )?.status,
      ).toBe("blocked");
    },
  );

  it("returns no eligibility when source is absent; refuses foreign scope or duplicate members", () => {
    expect(appendEligibility(cohort([]), ID)).toBeNull();
    expect(appendEligibility(cohort([row()]), CORRELATION)).toBeNull();
    expect(appendEligibility({ ...cohort([row()]), sessionId: CORRELATION }, ID)?.status).toBe(
      "blocked",
    );
    expect(appendEligibility(cohort([row(), row()]), ID)?.status).toBe("blocked");
  });

  it.each(["2026.08.1", "2026.08.2", "2026.09.0", "2026.09.1"])(
    "external accepts only uniform known bundle %s",
    (rulesVersion) => {
      const source = row({
        loadSemantics: "external_load",
        assistanceStepKg: null,
        assistanceProvenance: null,
        rulesVersion,
      });
      expect(isAppendCohortSafe(cohort([source]), ID)).toBe(true);
      expect(isAppendCohortSafe(cohort([{ ...source, rulesVersion: "unknown" }]), ID)).toBe(false);
      expect(
        isAppendCohortSafe(
          cohort([
            source,
            {
              ...source,
              id: CORRELATION,
              rulesVersion: rulesVersion === "2026.08.1" ? "2026.08.2" : "2026.08.1",
            },
          ]),
          ID,
        ),
      ).toBe(false);
    },
  );

  it.each(["2026.08.2", "2026.09.0", "2026.09.1"])(
    "native allows known bundle %s with either completed fact",
    (rulesVersion) => {
      for (const fact of [false, true]) {
        expect(
          isAppendCohortSafe(
            cohort([row({ rulesVersion, performedSets: [{ completed: fact }] })]),
            ID,
          ),
        ).toBe(true);
      }
    },
  );

  it.each([
    "ASSISTANCE_DOWN_REP_TARGET_MET",
    "ASSISTANCE_DOWN_RIR_EASY",
    "ASSISTANCE_UP_RIR_HARD",
    "ASSISTANCE_UP_TOO_HARD",
    "ASSISTANCE_MINIMUM_REACHED",
    "ADD_ONE_REP",
    "HOLD_RIR_LOW",
  ])("preserves frozen allowed ready reason %s", (reasonCode) => {
    expect(isAppendCohortSafe(cohort([row({ reasonCode })]), ID)).toBe(true);
  });

  it("checks C only for the selected copy, but S for every original member", () => {
    const source = row();
    const performedZero = row({
      id: CORRELATION,
      setNo: 3,
      recommendedWeight: D(0),
      performedSets: [{ completed: true }],
    });
    expect(isAppendCohortSafe(cohort([source, performedZero]), ID)).toBe(true);
    expect(isAppendCohortSafe(cohort([source, performedZero]), CORRELATION)).toBe(false);
    expect(
      isAppendCohortSafe(
        cohort([source, { ...performedZero, performedSets: [{ completed: false }] }]),
        ID,
      ),
    ).toBe(false);
  });

  it.each([D("NaN"), D("Infinity"), D("-Infinity")])(
    "fails closed on nonfinite step without invoking a wire hash: %s",
    (assistanceStepKg) => {
      const source = row({ assistanceStepKg });
      expect(isAppendCohortSafe(cohort([source]), ID)).toBe(false);
      expect(validateRawSessionSetSnapshot(source).status).toBe("invalid_raw");
      expect(() => sourceRevision(source)).toThrow(RangeError);
    },
  );
});

describe("A05 raw shape/storage validation, separate from A08 safety and HTTP reasons", () => {
  it.each([
    {},
    { targetRir: 6 },
    { targetRepsLow: 1, targetRepsHigh: 1, restSec: 0 },
    { recommendedWeight: D("9999.99"), confidence: D("9.99") },
    {
      recommendedWeight: null,
      loadSemantics: "external_load",
      assistanceStepKg: null,
      assistanceProvenance: null,
    },
    {
      targetRepsLow: null,
      targetRepsHigh: null,
      targetRir: null,
      recommendedWeight: null,
      recommendedReps: null,
      targetTimeLowSec: 30,
      targetTimeHighSec: 60,
    },
  ] as Partial<RawSessionSetSnapshot>[])(
    "preserves valid raw values; adds no guessed RIR/confidence cap: %j",
    (change) => {
      expect(validateRawSessionSetSnapshot(row(change))).toEqual({ status: "valid" });
    },
  );

  it.each([
    { targetRepsLow: 12, targetRepsHigh: 6 },
    { targetRepsLow: null },
    { targetTimeLowSec: 30 },
    { targetTimeLowSec: 30, targetTimeHighSec: 60 },
    { targetRepsLow: null, targetRepsHigh: null },
    { targetRepsLow: 1.5 },
    { targetRir: Number.NaN },
    { restSec: Number.POSITIVE_INFINITY },
    { orderIndex: 2147483648 },
    { recommendedWeight: D("10000") },
    { recommendedWeight: D("0.001") },
    { confidence: D("10") },
    { confidence: D("NaN") },
    { confidence: null },
  ] as unknown as Partial<RawSessionSetSnapshot>[])(
    "returns invalid_raw without fabricating an HTTP reason: %j",
    (change) => {
      expect(validateRawSessionSetSnapshot(row(change))).toEqual({ status: "invalid_raw" });
    },
  );

  it.each([
    { targetTimeLowSec: 60, targetTimeHighSec: 30 },
    { recommendedWeight: D(5) },
    { recommendedReps: 10 },
    { targetRir: 2 },
  ])("rejects malformed time snapshot: %j", (change) => {
    const source = row({
      targetRepsLow: null,
      targetRepsHigh: null,
      targetRir: null,
      recommendedWeight: null,
      recommendedReps: null,
      targetTimeLowSec: 30,
      targetTimeHighSec: 60,
      ...change,
    });
    expect(validateRawSessionSetSnapshot(source).status).toBe("invalid_raw");
  });

  it("does not conflate numeric validity with A08 eligibility", () => {
    const raw = row({ targetRepsLow: 12, targetRepsHigh: 6 });
    expect(validateRawSessionSetSnapshot(raw).status).toBe("invalid_raw");
    expect(appendEligibility(cohort([raw]), ID)?.status).toBe("allowed");
    expect(validateRawSessionSetSnapshot(row({ reasonCode: "BASELINE" })).status).toBe("valid");
    expect(appendEligibility(cohort([row({ reasonCode: "BASELINE" })]), ID)?.status).toBe(
      "blocked",
    );
  });
});
