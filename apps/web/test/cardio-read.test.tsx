import "fake-indexeddb/auto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCardioBaseline, planCardioWeek, toCardioSnapshot } from "shared";
import type { CardioBaselineInput } from "shared";
import { normalizeSessionRecommendations } from "../components/session/recommendation-mirror";
import {
  isSafeSessionPayload,
  mirrorSession,
  readMirroredSession,
  sessionDb,
} from "../components/session/session-db";
import { CardioPrescriptionCard } from "../components/session/CardioPrescriptionCard";
import { readThroughReadModel } from "../lib/read-model-cache";
import catalog from "../../../docs/specs/exercises_seed.json";
import type { Exercise } from "../lib/api";

const input: CardioBaselineInput = {
  goal: "diet",
  minutesPerDay: 60,
  slots: [
    { ordinal: 1, day_offset: 0, container: "H" },
    { ordinal: 2, day_offset: 1, container: "H" },
    { ordinal: 3, day_offset: 3, container: "C" },
    { ordinal: 4, day_offset: 4, container: "C" },
  ],
  eligibility: {
    screening: "low_risk",
    readiness: "normal",
    recentTwoSuccessfulCardio: true,
    latestCardioDifficulty: "moderate",
  },
  lowerExposureDays: [-6, 1, 8],
};
const slot = planCardioWeek({ ...input, rulesVersion: "2026.09.1" }).slots[2]!;
const row = {
  ...toCardioSnapshot(slot),
  id: "cardio-1",
  exercise_id: "e_stationary_bike",
  set_no: 1,
  source_revision: "cardio-revision",
  correlation_id: null,
  append_eligibility: null,
  recommended_weight: null,
  recommended_reps: null,
  target_reps_low: null,
  target_reps_high: null,
  target_time_low_sec: null,
  target_time_high_sec: null,
  target_rir: null,
  rest_sec: null,
  reason_code: null,
  confidence: null,
  load_semantics: null,
  load_kind: "not_applicable",
  recommendation_state: "ready",
  recommendation_gate: "early",
  rules_version: "2026.09.1",
  performed_set: null,
  assistance_provenance: null,
  assistance_safety_status: null,
  recommended_action: null,
};

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  await sessionDb.delete();
});

describe("cardio read-only display and durable read", () => {
  it("cross-checks the real canonical catalog and refuses legacy kind laundering", () => {
    const canonical = catalog.exercises.find((exercise) => exercise.id === "e_stationary_bike")!;
    expect(canonical.modality).toBe("cardio");
    const exercises = [
      { ...canonical, step_kg: canonical.default_step_kg, media_url: null },
    ] as Exercise[];
    const session = { planned_sets: [row] };
    expect(normalizeSessionRecommendations(session, exercises)).toEqual(session);
    const counterfeit = [{ ...exercises[0]!, modality: "resistance" as const }];
    expect(
      normalizeSessionRecommendations(session, counterfeit).planned_sets[0]!.recommendation_state,
    ).toBe("unavailable");
    expect(
      normalizeSessionRecommendations(session, [{ ...exercises[0]!, cardio_movement_regions: [] }])
        .planned_sets[0]!.recommendation_state,
    ).toBe("unavailable");
  });
  it("round trips the Program template through online then offline read and rejects corrupted cached intensity", async () => {
    const program = {
      program_id: "p-cardio",
      rules_version: "2026.09.1",
      sessions: [
        {
          day: "THU",
          exercises: [{ exercise_id: row.exercise_id, sets: null, ...toCardioSnapshot(slot) }],
        },
      ],
    };
    const options = {
      userId: "cardio-reader",
      kind: "program" as const,
      cacheKey: "program:current",
      fetcher: async () => program,
    };
    expect((await readThroughReadModel(options)).data).toEqual(program);
    expect(
      (
        await readThroughReadModel({
          ...options,
          fetcher: async () => {
            throw new TypeError("offline");
          },
        })
      ).data,
    ).toEqual(program);
    await sessionDb.readModels.update(["cardio-reader", "program:current"], {
      data: {
        ...program,
        sessions: [
          {
            day: "THU",
            exercises: [{ ...program.sessions[0]!.exercises[0], intensity_seconds: null }],
          },
        ],
      },
    });
    await expect(
      readThroughReadModel({
        ...options,
        fetcher: async () => {
          throw new TypeError("offline");
        },
      }),
    ).rejects.toThrow("Invalid cardio read snapshot");
  });
  it("preserves exact cardio ready state, descriptor, intensities and source/fallback through mirror reload", async () => {
    const session = { id: "s-cardio", planned_sets: [row] };
    expect(normalizeSessionRecommendations(session)).toEqual(session);
    expect(isSafeSessionPayload(session)).toBe(true);
    await mirrorSession("cardio-reader", "s-cardio", session);
    sessionDb.close();
    await sessionDb.open();
    expect(await readMirroredSession("cardio-reader", "s-cardio")).toEqual(session);
    expect(await sessionDb.outbox.count()).toBe(0);
    expect(await sessionDb.drafts.count()).toBe(0);
  });
  it("rejects missing kind/intensity rather than laundering cardio into legacy resistance", () => {
    for (const key of ["prescription_kind", "intensity_seconds", "source_day", "cardio_fallback"]) {
      const malformed: Record<string, unknown> = { ...row };
      delete malformed[key];
      expect(isSafeSessionPayload({ planned_sets: [malformed] }), key).toBe(false);
      expect(
        normalizeSessionRecommendations({ planned_sets: [malformed] }).planned_sets[0]!
          .recommendation_state,
      ).toBe("unavailable");
    }
  });
  it("renders steady duration, intensity and read-only text with no resistance controls", () => {
    const html = renderToStaticMarkup(
      createElement(CardioPrescriptionCard, { prescription: row, name: "고정식 자전거" }),
    );
    expect(html).toContain('data-testid="cardio-prescription"');
    expect(html).toContain("유산소 처방");
    expect(html).toContain("35분");
    expect(html).toContain("RPE 5–6");
    expect(html).toContain("읽기 전용");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("0kg");
    expect(html).not.toContain("RIR");
  });
  it("renders interval work/recovery and final recovery; malformed descriptor shows unavailable", () => {
    const interval = toCardioSnapshot(buildCardioBaseline(input).slots[2]!);
    const html = renderToStaticMarkup(
      createElement(CardioPrescriptionCard, { prescription: interval, name: "고정식 자전거" }),
    );
    expect(html).toContain("10라운드");
    expect(html).toContain("운동 60초");
    expect(html).toContain("회복 60초");
    expect(html).toContain("마지막 회복 포함");
    const unsafe = renderToStaticMarkup(
      createElement(CardioPrescriptionCard, {
        prescription: { ...interval, intensity_seconds: { moderate: 0, high: 600 } },
        name: "고정식 자전거",
      }),
    );
    expect(unsafe).toContain("유산소 처방을 확인할 수 없어요");
    expect(unsafe).not.toContain("10라운드");
  });
});
