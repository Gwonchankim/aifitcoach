import "fake-indexeddb/auto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCardioBaseline, toCardioSnapshot } from "shared";
import { assertCardioReadPayload } from "../components/session/cardio-read";
import { normalizeSessionRecommendations } from "../components/session/recommendation-mirror";
import { CardioPrescriptionCard } from "../components/session/CardioPrescriptionCard";
import { sessionDb } from "../components/session/session-db";
import { readThroughReadModel } from "../lib/read-model-cache";
import type { Exercise } from "../lib/api";
import catalog from "../../../docs/specs/exercises_seed.json";

const snapshot = toCardioSnapshot(
  buildCardioBaseline({
    goal: "diet",
    minutesPerDay: 60,
    slots: [
      { ordinal: 1, day_offset: 0, container: "H" },
      { ordinal: 2, day_offset: 3, container: "H" },
    ],
    lowerExposureDays: [],
    eligibility: {
      screening: "unknown",
      readiness: "unknown",
      recentTwoSuccessfulCardio: false,
      latestCardioDifficulty: "unknown",
    },
  }).slots[0]!,
);
const row = {
  ...snapshot,
  id: "cardio",
  exercise_id: "e_stationary_bike",
  recommendation_state: "ready",
  rules_version: "2026.09.1",
};
const canonical = catalog.exercises.find((exercise) => exercise.id === row.exercise_id)!;
const exercises = [
  { ...canonical, step_kg: canonical.default_step_kg, media_url: null },
] as Exercise[];
const child = { ...snapshot, exercise_id: row.exercise_id, sets: null };
const program = {
  program_id: "program",
  rules_version: "2026.09.1",
  sessions: [{ day: "MON", exercises: [child] }],
};

beforeEach(async () => {
  await sessionDb.delete();
  await sessionDb.open();
});
afterEach(async () => {
  await sessionDb.delete();
});

describe("cardio read requires a supported V2 bundle", () => {
  it.each(["unknown", "2026.08.1", "2026.08.2"])(
    "does not retain ready for %s on normalization or direct rendering",
    (rules_version) => {
      const unsupported = { ...row, rules_version };
      expect(
        normalizeSessionRecommendations({ planned_sets: [unsupported] }, exercises).planned_sets[0]!
          .recommendation_state,
      ).toBe("unavailable");
      const html = renderToStaticMarkup(
        createElement(CardioPrescriptionCard, { prescription: unsupported, name: "고정식 자전거" }),
      );
      expect(html).toContain("유산소 처방을 확인할 수 없어요");
      expect(html).not.toContain("RPE 5–6");
    },
  );
  it.each(["unknown", "2026.08.1", "2026.08.2", null, undefined])(
    "rejects inherited Program bundle %s",
    (rules_version) => {
      expect(() => assertCardioReadPayload({ ...program, rules_version })).toThrow(
        "Invalid cardio read snapshot",
      );
    },
  );
  it("rejects a missing Program version and cannot launder an unsupported parent via a child version", () => {
    expect(() => assertCardioReadPayload({ sessions: program.sessions })).toThrow(
      "Invalid cardio read snapshot",
    );
    expect(() =>
      assertCardioReadPayload({
        ...program,
        rules_version: "unknown",
        sessions: [{ exercises: [row] }],
      }),
    ).toThrow("Invalid cardio read snapshot");
  });
  it.each(["2026.09.0", "2026.09.1"])(
    "preserves exact supported %s read bytes and parent-validated card children",
    (rules_version) => {
      const supported = { ...program, rules_version };
      const before = JSON.stringify(supported);
      expect(() => assertCardioReadPayload(supported)).not.toThrow();
      expect(JSON.stringify(supported)).toBe(before);
      expect(
        normalizeSessionRecommendations({ planned_sets: [{ ...row, rules_version }] }, exercises)
          .planned_sets[0]!.recommendation_state,
      ).toBe("ready");
      expect(
        renderToStaticMarkup(
          createElement(CardioPrescriptionCard, { prescription: child, name: "고정식 자전거" }),
        ),
      ).toContain("RPE 5–6");
    },
  );
  it("rejects both online and cached Programs with an unsupported inherited version", async () => {
    const options = {
      userId: "bundle-reader",
      kind: "program" as const,
      cacheKey: "program:current",
      fetcher: async () => program,
    };
    expect((await readThroughReadModel(options)).data).toEqual(program);
    const unsupported = { ...program, rules_version: "unknown" };
    await expect(
      readThroughReadModel({ ...options, fetcher: async () => unsupported }),
    ).rejects.toThrow("Invalid cardio read snapshot");
    await sessionDb.readModels.update([options.userId, options.cacheKey], { data: unsupported });
    await expect(
      readThroughReadModel({
        ...options,
        fetcher: async () => {
          throw new TypeError("offline");
        },
      }),
    ).rejects.toThrow("Invalid cardio read snapshot");
  });
  it("preserves the legacy resistance path without introducing cardio version requirements", () => {
    const legacy = {
      rules_version: "2026.08.1",
      planned_sets: [
        {
          id: "resistance",
          exercise_id: "e_bench",
          rules_version: "2026.08.1",
          recommendation_state: "ready",
          load_kind: "external",
          recommended_weight: 40,
          reason_code: "INITIAL_DEFAULT",
        },
      ],
    };
    expect(() => assertCardioReadPayload(legacy)).not.toThrow();
    expect(normalizeSessionRecommendations(legacy)).toEqual(legacy);
  });
});
