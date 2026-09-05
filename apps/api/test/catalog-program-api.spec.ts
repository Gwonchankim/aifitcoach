import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import type { GenerateProgramDto } from "../src/programs/dto/generate-program.dto";
import { createTestApp, resetUserData } from "./support/app";
import {
  BASELINE_CATALOG,
  CURRENT_CATALOG,
  MACHINE_IDS,
  CATALOG_ADDITION_IDS,
  CATALOG109,
} from "./support/catalog-extension";
import { weeklySelection } from "./support/catalog-selection-matrix";
import { expectMatchesContract } from "./support/openapi-response";

type Template = {
  day: string;
  focus: string;
  exercises: {
    exercise_id: string;
    sets: number;
    reps_low: number | null;
    reps_high: number | null;
    target_rir: number | null;
    time_low_sec: number | null;
    time_high_sec: number | null;
    rest_sec: number;
  }[];
}[];

describe("catalog extension actual API selection and persisted plans", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userId = devUserId();
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  }, 60_000);
  afterAll(async () => {
    try {
      if (prisma) await resetUserData(prisma, userId);
    } finally {
      await app?.close();
    }
  });
  beforeEach(async () => {
    await resetUserData(prisma, userId);
  });

  it.each([30, 45, 90] as const)(
    "%i minutes: baseline candidates and expanded candidates agree with production oracle and DB",
    async (minutes) => {
      const input: GenerateProgramDto = {
        goal: "diet",
        days_per_week: 6,
        minutes_per_day: minutes,
        experience_level: "beginner",
        pain_areas: ["knee"],
      };
      const plans: string[][][] = [];
      for (const [index, catalog] of [BASELINE_CATALOG, CATALOG109, CURRENT_CATALOG].entries()) {
        // Exclude precisely the additions through the public API to reproduce baseline106/109 candidates.
        // No exercise deletion/reseed is used to simulate an old catalog.
        const response = await request(app.getHttpServer())
          .post("/v1/programs/generate")
          .send({
            ...input,
            ...(index === 0
              ? { avoid_exercises: CATALOG_ADDITION_IDS }
              : index === 1
                ? { avoid_exercises: ["e_assisted_dips"] }
                : {}),
          })
          .expect(201);
        expectMatchesContract("post", "/programs/generate", 201, response.body);
        const expected = weeklySelection(catalog, input);
        const template = response.body.sessions as Template;
        expect(
          template.map((day) => ({
            day: day.day,
            focus: day.focus,
            ids: day.exercises.map((row) => row.exercise_id),
          })),
        ).toEqual(expected);
        plans.push(expected.map((day) => day.ids));
        const program = await prisma.program.findFirstOrThrow({
          where: { userId },
          orderBy: { createdAt: "desc" },
        });
        expect(program.template).toEqual(template);
        expect(program.rulesVersion).toBe("2026.08.1");
        await request(app.getHttpServer()).get("/v1/programs/current").expect(200);
        const sessions = await prisma.workoutSession.findMany({
          where: { programId: program.id },
          include: { plannedSets: { orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }] } },
        });
        expect(sessions.length).toBeGreaterThan(0);
        for (const session of sessions) {
          const expectedDay = template.find((day) => day.focus === session.focus)!;
          expect(
            session.plannedSets.map((row) => ({
              exerciseId: row.exerciseId,
              orderIndex: row.orderIndex,
              setNo: row.setNo,
              targetRepsLow: row.targetRepsLow,
              targetRepsHigh: row.targetRepsHigh,
              targetRir: row.targetRir,
              targetTimeLowSec: row.targetTimeLowSec,
              targetTimeHighSec: row.targetTimeHighSec,
              restSec: row.restSec,
            })),
          ).toEqual(
            expectedDay.exercises.flatMap((row, orderIndex) =>
              Array.from({ length: row.sets }, (_, index) => ({
                exerciseId: row.exercise_id,
                orderIndex,
                setNo: index + 1,
                targetRepsLow: row.reps_low,
                targetRepsHigh: row.reps_high,
                targetRir: row.target_rir,
                targetTimeLowSec: row.time_low_sec,
                targetTimeHighSec: row.time_high_sec,
                restSec: row.rest_sec,
              })),
            ),
          );
          for (const row of session.plannedSets.filter(
            (item) => item.exerciseId === "e_assisted_dips",
          )) {
            expect(row.loadSemantics).toBe("assistance");
            expect(Number(row.assistanceStepKg)).toBe(2.5);
            expect(row.assistanceProvenance).toBe("native");
            expect(row.rulesVersion).toBe("2026.08.2");
          }
          for (const row of session.plannedSets.filter((item) =>
            MACHINE_IDS.includes(item.exerciseId),
          )) {
            expect(row.loadSemantics).toBe("external_load");
            expect(row.assistanceStepKg).toBeNull();
            expect(row.assistanceProvenance).toBeNull();
          }
        }
      }
      expect(plans[2]).not.toEqual(plans[1]);
      expect(plans[2].flat()).toContain("e_assisted_dips");
      expect(plans[1]).not.toEqual(plans[0]);
      expect(plans[1].flat()).toContain("e_incline_chest_press_machine");
      if (minutes >= 45) expect(plans[1].flat()).toContain("e_high_row_machine");
    },
  );
});
