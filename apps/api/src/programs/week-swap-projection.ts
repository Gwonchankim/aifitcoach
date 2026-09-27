import type { Exercise, Prisma, Program } from "@prisma/client";
import { weekStart } from "../analytics/aggregation.projector";
import { isoDate } from "../common/date/utc-day";
import { isResistanceExercise, type ResistanceExercise } from "../exercises/exercise-domain";
import type { WeekSwapCandidateReason } from "../common/http/week-swap-conflict";
import { WEEKDAYS } from "./program-rules";
import { checkWeekSwapRecovery, type WeekSwapRecoverySession } from "./week-swap-recovery";
import { weekSwapRevision, type WeekSwapAggregate } from "./week-swap-revision";

export const WEEK_SWAP_INCLUDE = {
  program: { select: { rulesVersion: true } },
  plannedSets: {
    orderBy: [{ orderIndex: "asc" }, { setNo: "asc" }, { id: "asc" }],
    include: {
      performedSets: { select: { id: true, plannedSetId: true, updatedAt: true, completed: true } },
    },
  },
} satisfies Prisma.WorkoutSessionInclude;
export type WeekSwapSession = Prisma.WorkoutSessionGetPayload<{
  include: typeof WEEK_SWAP_INCLUDE;
}>;

export function actualWeekSession(session: WeekSwapAggregate) {
  const sets = [...session.plannedSets].sort(
    (a, b) => a.orderIndex - b.orderIndex || a.setNo - b.setNo || a.id.localeCompare(b.id),
  );
  const exercises = new Map<
    string,
    { exercise_id: string; planned_set_ids: string[]; set_count: number }
  >();
  for (const set of sets) {
    const group = exercises.get(set.exerciseId) ?? {
      exercise_id: set.exerciseId,
      planned_set_ids: [],
      set_count: 0,
    };
    group.planned_set_ids.push(set.id);
    group.set_count++;
    exercises.set(set.exerciseId, group);
  }
  return {
    id: session.id,
    scheduled_date: isoDate(session.scheduledDate),
    focus: session.focus,
    status: session.status,
    origin: session.origin,
    revision: weekSwapRevision(session),
    planned_set_ids: sets.map((p) => p.id),
    exercises: [...exercises.values()],
  };
}

/** Structural priority is shared by candidates and commit. Cross-session priority is global too. */
export function structuralReason(
  session: WeekSwapAggregate,
  actual: readonly WeekSwapAggregate[],
  today: Date,
  programId: string,
): WeekSwapCandidateReason | null {
  if (
    session.scheduledDate < today ||
    session.status === "completed" ||
    session.status === "in_progress"
  )
    return "readonly";
  if (session.status !== "scheduled" || session.origin !== "planned") return "not_scheduled";
  if (session.plannedSets.some((p) => p.performedSets.length > 0)) return "performed_history";
  if (session.programId !== programId || +weekStart(session.scheduledDate) !== +weekStart(today))
    return "wrong_week";
  if (actual.filter((s) => +s.scheduledDate === +session.scheduledDate).length > 1)
    return "ambiguous_schedule";
  return null;
}
export const STRUCTURAL_REASONS = [
  "readonly",
  "not_scheduled",
  "performed_history",
  "wrong_week",
  "ambiguous_schedule",
] as const;

export function addDays(date: Date, days: number) {
  return new Date(+date + days * 86_400_000);
}
export type RecoveryTemplate = {
  day: string;
  exercises: { exercise_id: string; sets: number }[];
}[];
export function recoveryTemplate(value: unknown): RecoveryTemplate | null {
  if (!Array.isArray(value)) return null;
  const days = new Set<string>();
  for (const row of value) {
    if (
      !row ||
      typeof row !== "object" ||
      !WEEKDAYS.includes(row.day) ||
      days.has(row.day) ||
      !Array.isArray(row.exercises) ||
      row.exercises.length === 0
    )
      return null;
    days.add(row.day);
    const ids = new Set<string>();
    for (const exercise of row.exercises) {
      if (
        !exercise ||
        typeof exercise.exercise_id !== "string" ||
        !exercise.exercise_id ||
        ids.has(exercise.exercise_id) ||
        !Number.isInteger(exercise.sets) ||
        exercise.sets < 1 ||
        exercise.sets > 10
      )
        return null;
      ids.add(exercise.exercise_id);
    }
  }
  return value as RecoveryTemplate;
}

export function recoveryBundlePolicy(version: string) {
  return ["2026.08.1", "2026.08.2"].includes(version)
    ? ("resistance_only_cardio_not_applicable" as const)
    : ("unverifiable" as const);
}

const EXPECTED_REGION: Record<ResistanceExercise["movementPattern"], ResistanceExercise["region"]> =
  {
    squat: "lower",
    hinge: "lower",
    lunge: "lower",
    knee_extension: "lower",
    knee_flexion: "lower",
    calf: "lower",
    horizontal_push: "upper",
    horizontal_pull: "upper",
    vertical_push: "upper",
    vertical_pull: "upper",
    elbow_flexion: "upper",
    elbow_extension: "upper",
    shoulder_isolation: "upper",
    core: "core",
  };

/** Catalog membership is authority; focus labels never participate in recovery. */
export function recoveryReason(
  program: Program,
  actual: readonly (WeekSwapAggregate & { program?: { rulesVersion: string } })[],
  catalog: readonly Exercise[],
  pair: readonly [string, string],
  today: Date,
): "recovery_unverifiable" | "recovery_gap_violation" | null {
  // These persisted bundles contain resistance only; cardio/HIIT checks are N/A, not assumed safe.
  if (
    recoveryBundlePolicy(program.rulesVersion) === "unverifiable" ||
    actual.some((s) => s.program && recoveryBundlePolicy(s.program.rulesVersion) === "unverifiable")
  )
    return "recovery_unverifiable";
  if (
    program.startedAt.getUTCDay() !== 1 ||
    +weekStart(program.startedAt) !== +program.startedAt ||
    !Number.isInteger(program.totalWeeks) ||
    program.totalWeeks < 1
  )
    return "recovery_unverifiable";
  const byId = new Map(catalog.map((e) => [e.id, e]));
  let unverifiable = false;
  const regions = (ids: readonly string[]) => {
    const result = new Set<ResistanceExercise["region"]>();
    for (const id of ids) {
      const exercise = byId.get(id);
      if (
        !exercise ||
        !isResistanceExercise(exercise) ||
        EXPECTED_REGION[exercise.movementPattern] !== exercise.region
      )
        unverifiable = true;
      else result.add(exercise.region);
    }
    return [...result];
  };
  const sessions: WeekSwapRecoverySession[] = actual.map((s) => ({
    key: s.id,
    date: isoDate(s.scheduledDate),
    regions: regions(s.plannedSets.map((p) => p.exerciseId)),
  }));
  const current = weekStart(today);
  for (const offset of [-7, 7]) {
    const start = addDays(current, offset);
    if (start < program.startedAt || start >= addDays(program.startedAt, program.totalWeeks * 7))
      continue;
    // R4: a next Monday / previous Sunday actual occupies the closest possible
    // neighboring-week date. No preview can become a closer current-week neighbor.
    const boundary = offset < 0 ? addDays(start, 6) : start;
    if (actual.some((s) => s.programId === program.id && +s.scheduledDate === +boundary)) continue;
    const template = recoveryTemplate(program.template);
    if (!template || !template.length) return "recovery_unverifiable";
    for (const row of template) {
      const date = addDays(start, WEEKDAYS.indexOf(row.day as (typeof WEEKDAYS)[number]));
      if (actual.some((s) => s.programId === program.id && +s.scheduledDate === +date)) continue;
      sessions.push({
        key: `preview:${program.id}:${isoDate(date)}`,
        date: isoDate(date),
        regions: regions(row.exercises.map((e) => e.exercise_id)),
      });
    }
  }
  if (unverifiable) return "recovery_unverifiable";
  return checkWeekSwapRecovery(sessions, pair).reason;
}
