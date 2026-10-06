/**
 * BUG-10 정상 경로 처방 동일성 matrix — 시나리오 실행기.
 *
 * 날짜·replay 변경(BUG-10)이 **정상 경로의 다음 처방을 흔들지 않았다**는 증거를 대표군마다 남긴다.
 * 이 파일은 행위를 실행하고 관측값을 돌려줄 뿐이다. 기준값은 full `a74aa81`(BUG-10 직전 master)에서
 * **이 파일을 그대로** 실행해 얻었다(`fixtures/prescription-identity-a74aa81.json` 의 `source_sha256`).
 * 그래서 이 파일을 바꾸면 기준값을 base 에서 다시 캡처해야 한다 — 스펙이 sha 로 그것을 강제한다.
 *
 * 대표군은 전수 조합이 아니라 **계산 경로가 다른 것**이다: external 부하(근비대·다이어트·스트렝스),
 * RIR calibration 개입, assisted(도움 kg — 부호가 반대인 별도 경로), 맨몸 반복, 시간.
 * 경로: today(최초 기록 → 완료(sync | REST) → 완료 뒤 수정), previous(수정 → 체크 해제).
 * 각 행위가 **실제로 적용됐는지**(applied · conflict 0 · 저장 행)를 먼저 단언한다 —
 * 둘 다 거부된 상태의 "같음"은 공허하다.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { INestApplication } from "@nestjs/common";
import type { Goal, PlannedSet } from "@prisma/client";
import request from "supertest";
import { devUserId } from "../../src/auth/dev-user";
import { utcToday } from "../../src/common/date/utc-day";
import { PrismaService } from "../../src/prisma/prisma.service";
import { PlannedSetFactory } from "../../src/programs/planned-set.factory";
import {
  RecommendationService,
  requireHistory,
} from "../../src/recommendation/recommendation.service";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type MatrixGroup = {
  name: string;
  exerciseId: string;
  goal: Goal;
  /** graduated RIR calibration 의 bias. 없으면 RIR 축이 꺼진다. */
  rirBias?: number;
  /** 기록할 부하. assisted 는 **기계가 덜어주는 kg**, 맨몸·시간은 null. */
  weight: number | null;
};

export const MATRIX_GROUPS: readonly MatrixGroup[] = [
  { name: "external-hypertrophy", exerciseId: "e_bench_press", goal: "hypertrophy", weight: 60 },
  { name: "external-diet", exerciseId: "e_bench_press", goal: "diet", weight: 60 },
  { name: "external-strength", exerciseId: "e_bench_press", goal: "strength", weight: 60 },
  {
    name: "external-calibrated",
    exerciseId: "e_bench_press",
    goal: "hypertrophy",
    rirBias: 1,
    weight: 60,
  },
  { name: "assisted", exerciseId: "e_assisted_dips", goal: "hypertrophy", weight: 20 },
  { name: "bodyweight", exerciseId: "e_pushup", goal: "hypertrophy", weight: null },
  { name: "time", exerciseId: "e_plank", goal: "hypertrophy", weight: null },
];
export const MATRIX_PATHS = ["today-sync", "today-rest", "previous"] as const;
export type MatrixCase = {
  key: string;
  group: MatrixGroup;
  path: (typeof MATRIX_PATHS)[number];
};
export const MATRIX_CASES: readonly MatrixCase[] = MATRIX_GROUPS.flatMap((group) =>
  MATRIX_PATHS.map((path) => ({ key: `${group.name}/${path}`, group, path })),
);

/** 이 파일의 내용 해시(줄끝 정규화). 기준값이 어느 시나리오로 캡처됐는지 묶는다. */
export function matrixSourceSha256(): string {
  const source = readFileSync(__filename, "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(source).digest("hex");
}

type Mutation = {
  client_id: string;
  entity: "performed_set" | "session";
  entity_id: string;
  op: "upsert" | "delete";
  updated_at: string;
  payload: Record<string, unknown>;
};
type Item = { exercise_id: string } & Record<string, unknown>;
type Wire = {
  applied: string[];
  conflicts: unknown[];
  changes: { server_seq: string; data: { next_recommendations?: Item[] } | null }[];
};
/** 응답이 실어 보낸 이 운동의 처방. `"absent"` 는 그 change 행에 처방 필드 자체가 없다는 뜻이다. */
type Response = Item | null | "absent";
type Checkpoint = { sets: number; rows: Record<string, unknown>[]; response: Response };
export type MatrixResult = Record<string, Checkpoint>;

export async function runMatrixCase(
  app: INestApplication,
  { group, path }: MatrixCase,
): Promise<MatrixResult> {
  const prisma = app.get(PrismaService);
  const recommendations = app.get(RecommendationService);
  const factory = app.get(PlannedSetFactory);
  const userId = devUserId();
  const today = utcToday();
  const day = (offset: number) => new Date(today.getTime() + offset * DAY_MS);
  let tick = 0;
  /** 클라이언트 시계: 오늘 10:00 부터 1초씩 증가 — LWW 가 항상 이번 값을 고른다. */
  const at = () => new Date(today.getTime() + 10 * HOUR_MS + tick++ * 1000).toISOString();

  if (group.rirBias !== undefined)
    await prisma.userRirCalibration.create({
      data: {
        userId,
        biasOverall: group.rirBias,
        biasByRegion: {},
        confidence: 0.8,
        samples: 12,
        status: "graduated",
      },
    });
  const program = await prisma.program.create({
    data: {
      userId,
      goal: group.goal,
      daysPerWeek: 3,
      minutesPerDay: 60,
      splitType: "full_body",
      rulesVersion: "2026.08.1",
      startedAt: day(-7),
      totalWeeks: 12,
      status: "active",
      generationInput: {},
      template: [],
      excludedExercises: [],
    },
  });
  const exercise = await prisma.exercise.findUniqueOrThrow({ where: { id: group.exerciseId } });
  const time = exercise.metric === "time";
  const calibration = await recommendations.calibrationFor(userId);

  /** 그 시점의 이력으로 세션 계획을 만든다 — 프로그램 생성·추가와 같은 factory 다. */
  async function session(offset: number, status: "scheduled" | "completed") {
    const row = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: day(offset),
        focus: "full_body",
        status,
        ...(status === "completed"
          ? { completedAt: new Date(day(offset).getTime() + 11 * HOUR_MS) }
          : {}),
      },
    });
    const loadSemantics = exercise.loadSemantics === "assistance" ? "assistance" : "external_load";
    const history = requireHistory(
      await recommendations.prefetchHistories(userId, [{ exerciseId: exercise.id, loadSemantics }]),
      exercise.id,
    );
    const rows = await factory.build({
      userId,
      goal: group.goal,
      exercise,
      orderIndex: 0,
      sets: 3,
      history,
      calibration,
    });
    await prisma.plannedSet.createMany({
      data: rows.map((planned) => ({ ...planned, sessionId: row.id })),
    });
    const planned = await prisma.plannedSet.findMany({
      where: { sessionId: row.id },
      orderBy: { setNo: "asc" },
    });
    return { id: row.id, planned };
  }

  /**
   * 목표 상단 = 다 채움, 하단 미만 = 못 채움. 값은 그 세트의 계획에서 읽는다(목표마다 다르다).
   * 못 채운 세트는 RIR 도 목표보다 2 낮다 — 안 그러면 calibration 군에서 RIR 축이 반복 축보다
   * 먼저 "쉬움"으로 판정해 수정·해제가 처방을 바꾸지 못한다(관측 불가).
   */
  const performed = (row: PlannedSet, reach: "top" | "short") => ({
    actual_weight: group.weight,
    actual_reps: time
      ? null
      : reach === "top"
        ? row.targetRepsHigh
        : Math.max(1, (row.targetRepsLow ?? 2) - 1),
    actual_rir: time
      ? null
      : reach === "top"
        ? row.targetRir
        : Math.max(0, (row.targetRir ?? 2) - 2),
    actual_time_sec: time
      ? reach === "top"
        ? row.targetTimeHighSec
        : Math.max(1, (row.targetTimeLowSec ?? 6) - 5)
      : null,
    pain_score: null,
    completed: true,
  });
  const upsert = (row: PlannedSet, reach: "top" | "short"): Mutation => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: row.id,
    op: "upsert",
    updated_at: at(),
    payload: performed(row, reach),
  });
  // 웹의 체크 해제는 completed=false upsert 가 아니라 delete 다(session-store `nextDraft`).
  const uncheck = (row: PlannedSet): Mutation => ({
    client_id: randomUUID(),
    entity: "performed_set",
    entity_id: row.id,
    op: "delete",
    updated_at: at(),
    payload: {},
  });
  const complete = (sessionId: string): Mutation => ({
    client_id: randomUUID(),
    entity: "session",
    entity_id: sessionId,
    op: "upsert",
    updated_at: at(),
    payload: { status: "completed" },
  });

  async function sync(mutations: Mutation[]): Promise<Wire> {
    const response = await request(app.getHttpServer())
      .post("/v1/sync")
      .send({ mutations })
      .expect(200);
    const wire = response.body as Wire;
    // 적용이 먼저다 — 거부된 행위 뒤의 "같음"은 공허하다.
    expect(wire.conflicts).toEqual([]);
    expect([...wire.applied].sort()).toEqual(mutations.map((m) => m.client_id).sort());
    return wire;
  }
  /** 그 mutation 자신의 change 행(change 행은 client_id 가 아니라 server_seq 를 싣는다). */
  async function responseOf(wire: Wire, mutation: Mutation): Promise<Response> {
    const receipt = await prisma.syncMutation.findUniqueOrThrow({
      where: { id: mutation.client_id },
    });
    const own = wire.changes.find((row) => row.server_seq === receipt.serverSeq.toString());
    const items = own?.data?.next_recommendations;
    return items === undefined
      ? "absent"
      : (items.find((item) => item.exercise_id === exercise.id) ?? null);
  }
  const factOf = (row: PlannedSet) =>
    prisma.performedSet.findUnique({ where: { plannedSetId: row.id } });
  const recorded = (mutation: Mutation) =>
    time
      ? { completed: true, actualTimeSec: mutation.payload.actual_time_sec }
      : { completed: true, actualReps: mutation.payload.actual_reps };

  /** 다음 세션의 이 운동 처방 — 행별 값 전부. id·시각처럼 실행마다 다른 값은 뺀다. */
  async function prescription(nextId: string): Promise<Record<string, unknown>[]> {
    const rows = await prisma.plannedSet.findMany({
      where: { sessionId: nextId, exerciseId: exercise.id },
      orderBy: { setNo: "asc" },
    });
    return rows.map((row) => ({
      set_no: row.setNo,
      recommended_weight: row.recommendedWeight === null ? null : Number(row.recommendedWeight),
      recommended_reps: row.recommendedReps,
      target_reps_low: row.targetRepsLow,
      target_reps_high: row.targetRepsHigh,
      target_time_low_sec: row.targetTimeLowSec,
      target_time_high_sec: row.targetTimeHighSec,
      target_rir: row.targetRir,
      rest_sec: row.restSec,
      reason_code: row.reasonCode,
      confidence: row.confidence === null ? null : Number(row.confidence),
      rules_version: row.rulesVersion,
      load_semantics: row.loadSemantics,
    }));
  }
  let shown: Record<string, unknown>[] = [];
  /**
   * 행위 하나 뒤의 처방. **직전 처방과 달라야 한다** — 같으면 그 행위의 재계산이 실제로 썼는지
   * 관측할 수 없어(쓰기 없는 mutant 가 통과한다) base 와의 "같음"이 공허해진다.
   */
  async function checkpoint(nextId: string, response: Response): Promise<Checkpoint> {
    const rows = await prescription(nextId);
    expect(rows).not.toEqual(shown);
    shown = rows;
    return { sets: rows.length, rows, response };
  }

  const result: MatrixResult = {};
  if (path === "previous") {
    const previous = await session(-1, "completed");
    // 지난 기록은 직접 심는다 — 이 경로의 대상은 그 기록을 **고치고 해제하는** 행위다.
    for (const row of previous.planned) {
      const values = performed(row, "top");
      const performedAt = new Date(day(-1).getTime() + 10 * HOUR_MS + row.setNo * 60_000);
      await prisma.performedSet.create({
        data: {
          plannedSetId: row.id,
          clientId: randomUUID(),
          completed: true,
          performedAt,
          updatedAt: performedAt,
          actualWeight: values.actual_weight,
          actualReps: values.actual_reps,
          actualRir: values.actual_rir,
          actualTimeSec: values.actual_time_sec,
        },
      });
    }
    const next = await session(2, "scheduled");
    shown = await prescription(next.id);
    const edit = upsert(previous.planned[1], "short");
    const edited = await sync([edit]);
    expect(await factOf(previous.planned[1])).toMatchObject(recorded(edit));
    result["previous.edit"] = await checkpoint(next.id, await responseOf(edited, edit));
    const off = uncheck(previous.planned[1]);
    const unchecked = await sync([off]);
    expect(await factOf(previous.planned[1])).toBeNull();
    result["previous.uncheck"] = await checkpoint(next.id, await responseOf(unchecked, off));
    return result;
  }

  const current = await session(0, "scheduled");
  const next = await session(2, "scheduled");
  shown = await prescription(next.id);
  const first = current.planned.map((row) => upsert(row, "top"));
  await sync(first);
  for (const [index, row] of current.planned.entries())
    expect(await factOf(row)).toMatchObject(recorded(first[index]));
  if (path === "today-sync") {
    const done = complete(current.id);
    const wire = await sync([done]);
    result["today.complete"] = await checkpoint(next.id, await responseOf(wire, done));
  } else {
    const response = await request(app.getHttpServer())
      .post(`/v1/sessions/${current.id}/complete`)
      .send({})
      .expect(200);
    const items = (response.body as { next_recommendations: Item[] }).next_recommendations;
    result["today.complete"] = await checkpoint(
      next.id,
      items.find((item) => item.exercise_id === exercise.id) ?? null,
    );
  }
  expect(
    await prisma.workoutSession.findUniqueOrThrow({ where: { id: current.id } }),
  ).toMatchObject({ status: "completed" });
  const edit = upsert(current.planned[2], "short");
  const edited = await sync([edit]);
  expect(await factOf(current.planned[2])).toMatchObject(recorded(edit));
  result["today.edit"] = await checkpoint(next.id, await responseOf(edited, edit));
  return result;
}
