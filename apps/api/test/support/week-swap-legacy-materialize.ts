import { assertResistanceExercise } from "../../src/exercises/exercise-domain";
/** Frozen pre-extraction d8e36f5 body, retained only for the required equivalence regression. */
import { BadRequestException } from "@nestjs/common";
import type { Prisma, Program } from "@prisma/client";
import {
  RecommendationService,
  requireHistory,
} from "../../src/recommendation/recommendation.service";
import { PlannedSetFactory, type PlannedSetRow } from "../../src/programs/planned-set.factory";
import type { ResistanceProgramExercise } from "../../src/programs/programs.service";
import { WEEKDAYS } from "../../src/programs/program-rules";
type ProgramSessionTemplate = {
  day: string;
  focus: string;
  exercises: ResistanceProgramExercise[];
};
const addDays = (date: Date, days: number) => new Date(+date + days * 86400000);
export async function legacyMaterializeWeek(
  tx: Prisma.TransactionClient,
  userId: string,
  program: Program,
  week: number,
  recommendation: RecommendationService,
  plannedSets: PlannedSetFactory,
) {
  // Test adapter owns modern narrowing. The historical body below has no new runtime branch.
  const template = program.template as unknown as ProgramSessionTemplate[];
  for (const session of template)
    for (const exercise of session.exercises)
      if (
        exercise.sets == null ||
        (exercise.prescription_kind !== undefined && exercise.prescription_kind !== "resistance")
      )
        throw new Error("Historical fixture requires a resistance template");
  const catalog = await tx.exercise.findMany({
    where: { id: { in: template.flatMap((s) => s.exercises.map((e) => e.exercise_id)) } },
  });
  for (const row of catalog) assertResistanceExercise(row);
  return frozenLegacyMaterializeWeek(tx, userId, program, week, recommendation, plannedSets);
}
async function frozenLegacyMaterializeWeek(
  tx: Prisma.TransactionClient,
  userId: string,
  program: Program,
  week: number,
  recommendation: RecommendationService,
  plannedSets: PlannedSetFactory,
) {
  const template = program.template as unknown as ProgramSessionTemplate[];
  const candidates: { date: Date; focus: string; rows: PlannedSetRow[] }[] = [];

  // **주 전체의 unique spec 을 먼저 모은다.** 세션마다 읽으면 주당 세션 수만큼 늘어난다.
  const catalog = new Map(
    (
      await tx.exercise.findMany({
        where: {
          id: {
            in: [...new Set(template.flatMap((s) => s.exercises.map((e) => e.exercise_id)))],
          },
        },
      })
    ).map((row) => [row.id, row]),
  );
  const prefetched = await recommendation.prefetchHistories(
    userId,
    [...catalog.values()].map((row) => ({ exerciseId: row.id, loadSemantics: row.loadSemantics! })),
    tx,
  );
  const calibration = await recommendation.calibrationFor(userId, tx);

  for (const session of template) {
    const day = session.day as (typeof WEEKDAYS)[number];
    const date = addDays(program.startedAt, (week - 1) * 7 + WEEKDAYS.indexOf(day));
    const rows: PlannedSetRow[] = [];
    for (const [orderIndex, planned] of session.exercises.entries()) {
      const exercise = catalog.get(planned.exercise_id);
      // prefetch map miss 는 **fail closed** 다 — per-exercise fallback 질의를 만들지 않는다.
      if (!exercise) throw new BadRequestException(`운동을 찾을 수 없다: ${planned.exercise_id}`);
      rows.push(
        ...(await plannedSets.build({
          userId,
          goal: program.goal,
          exercise,
          orderIndex,
          sets: planned.sets,
          history: requireHistory(prefetched, exercise.id),
          calibration,
        })),
      );
    }
    candidates.push({ date, focus: session.focus, rows });
  }

  const existing = new Set(
    (
      await tx.workoutSession.findMany({
        where: {
          programId: program.id,
          scheduledDate: { in: candidates.map((item) => item.date) },
        },
        select: { scheduledDate: true },
      })
    ).map((session) => session.scheduledDate.toISOString().slice(0, 10)),
  );
  for (const candidate of candidates) {
    if (existing.has(candidate.date.toISOString().slice(0, 10))) continue;
    const session = await tx.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: candidate.date,
        focus: candidate.focus,
        status: "scheduled",
      },
    });
    await tx.plannedSet.createMany({
      data: candidate.rows.map((row) => ({ ...row, sessionId: session.id })),
    });
  }
}
