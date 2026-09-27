import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Equipment } from "@prisma/client";
import request from "supertest";
import { RULES_BUNDLE_V2_SPLIT } from "shared";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import { ProgramsService } from "../src/programs/programs.service";
import { targetFor } from "../src/programs/planned-set.factory";
import { RecommendationService, NO_HISTORY } from "../src/recommendation/recommendation.service";
import { createTestApp, resetUserData } from "./support/app";

const frozen = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/recompute-base-0af6905.json"), "utf8"),
) as {
  capture_commit: string;
  cases: {
    name: string;
    input: Parameters<RecommendationService["recommend"]>[0];
    output: unknown;
  }[];
};
const dto = {
  goal: "hypertrophy",
  days_per_week: 3,
  minutes_per_day: 60,
  experience_level: "intermediate",
  // S2 안전 gate 도입으로 fixture 입력을 명시한다. 건강 screening/history는 unknown 그대로다.
  equipment: Object.values(Equipment),
  pain_areas: [] as [],
} as const;
describe("recompute honors the persisted rules bundle", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let programs: ProgramsService;
  let recommendation: RecommendationService;
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    programs = app.get(ProgramsService);
    recommendation = app.get(RecommendationService);
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    await resetUserData(prisma, devUserId());
  });

  it("legacy external .08.1 and assistance .08.2 outputs remain byte-identical", () => {
    expect(frozen.capture_commit).toBe("0af690546fb8f1416e70353eb38249de64c0c2b4");
    expect(frozen.cases).toHaveLength(4);
    for (const row of frozen.cases) {
      expect(JSON.stringify(recommendation.recommend(row.input))).toBe(JSON.stringify(row.output));
    }
  });

  it("external .09.1 persisted snapshot takes precedence over explicit .08.1 and keeps null baseline reason", async () => {
    const program = await programs.generateWithRulesVersion(
      devUserId(),
      dto,
      RULES_BUNDLE_V2_SPLIT,
    );
    await programs.current(devUserId());
    const row = await prisma.plannedSet.findFirstOrThrow({
      where: {
        session: { programId: program.program_id },
        loadSemantics: "external_load",
        exercise: { metric: "reps", defaultStepKg: { not: null } },
      },
      include: { exercise: true },
    });
    const result = recommendation.recommend({
      goal: dto.goal,
      exercise: row.exercise,
      target: targetFor(dto.goal, row.exercise),
      history: NO_HISTORY,
      snapshot: { stepKg: 99, rulesVersion: row.rulesVersion },
      rulesVersion: "2026.08.1",
    });
    expect(result).toMatchObject({
      rules_version: RULES_BUNDLE_V2_SPLIT,
      reason_code: "LOAD_CALIBRATION_NEEDED",
      weight: null,
    });
  });

  it("real complete recompute preserves external .09.1 in response and next stored rows", async () => {
    const program = await programs.generateWithRulesVersion(
      devUserId(),
      dto,
      RULES_BUNDLE_V2_SPLIT,
    );
    await programs.current(devUserId());
    const first = await prisma.workoutSession.findFirstOrThrow({
      where: { programId: program.program_id },
      orderBy: { scheduledDate: "asc" },
    });
    const row = await prisma.plannedSet.findFirstOrThrow({
      where: {
        sessionId: first.id,
        loadSemantics: "external_load",
        exercise: { metric: "reps", defaultStepKg: { not: null } },
      },
    });
    await prisma.performedSet.create({
      data: {
        plannedSetId: row.id,
        actualWeight: 20,
        actualReps: 8,
        actualRir: 2,
        completed: true,
        clientId: randomUUID(),
        performedAt: new Date("2026-08-14T09:00:00Z"),
      },
    });
    const response = await request(app.getHttpServer())
      .post(`/v1/sessions/${first.id}/complete`)
      .send({})
      .expect(200);
    const next = response.body.next_recommendations.find(
      (item: { exercise_id: string }) => item.exercise_id === row.exerciseId,
    );
    expect(next).toBeDefined();
    expect(next.recommendation.rules_version).toBe(RULES_BUNDLE_V2_SPLIT);
    const targets = await prisma.plannedSet.findMany({
      where: {
        exerciseId: row.exerciseId,
        session: { programId: program.program_id, id: { not: first.id } },
      },
    });
    expect(targets.length).toBeGreaterThan(0);
    expect([...new Set(targets.map((item) => item.rulesVersion))]).toEqual([RULES_BUNDLE_V2_SPLIT]);
  });
});
