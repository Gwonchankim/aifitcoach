/**
 * F-4a fixup — 통증 복호화 실패 audit · 결정론적 정렬 · batch 질의.
 *
 * **손상 행 하나가 현재 추천을 영구히 막으면 안 된다.** 그래서 손상은 graduation source 에서만
 * 빼고 audit 로 남긴다. 그런데 첫 valid 에서 멈추면 **그 뒤의 손상을 영원히 못 본다** —
 * 전체를 끝까지 훑은 뒤에 source 를 고른다.
 *
 * audit 에는 **failure code 만** 남긴다. 통증 값·암호문·performed id 는 넣지 않는다.
 */
import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { devUserId } from "../src/auth/dev-user";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  compareEarliestFirst,
  latestHistoryFrom,
  type LatestHistoryRow,
  RecommendationService,
} from "../src/recommendation/recommendation.service";
import { createTestApp, resetUserData } from "./support/app";

const USER_ID = devUserId();
const ASSISTED = "e_assisted_pullup";
const CORRUPT = "v1:not:a:ciphertext";

/** exact action 세 값. 이 문자열이 계약이라 오타가 조용한 중복을 만든다. */
const PAIN_ACTIONS = [
  "pain_observation_decrypt_failed",
  "pain_observation_auth_failed",
  "pain_observation_nonnumeric",
];

type SetSpec = {
  /** 세션 예정일 offset(일). 같은 값이면 같은 날짜의 서로 다른 세션이다. */
  day: number;
  setNo: number;
  weight: string | null;
  reps: number | null;
  pain?: string | null;
  performedAtMinute?: number;
};

describe("통증 복호화 실패 audit · 정렬 · batch", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recommendation: RecommendationService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    recommendation = app.get(RecommendationService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await resetUserData(prisma, USER_ID);
  });

  /** 세션 하나에 지정한 세트들을 심는다. 같은 day 를 여러 번 부르면 같은 날짜의 다른 세션이다. */
  async function seedSession(
    specs: SetSpec[],
    exerciseId = ASSISTED,
    options: { completedAtHour?: number } = {},
  ): Promise<string> {
    const program = await prisma.program.create({
      data: {
        userId: USER_ID,
        goal: "hypertrophy",
        daysPerWeek: 3,
        minutesPerDay: 60,
        splitType: "full_body",
        rulesVersion: "2026.08.1",
        startedAt: new Date("2026-08-03T00:00:00Z"),
        totalWeeks: 12,
        status: "active",
        generationInput: {},
        template: [],
        excludedExercises: [],
      },
    });
    const workout = await prisma.workoutSession.create({
      data: {
        programId: program.id,
        scheduledDate: new Date(Date.UTC(2026, 7, 3 + specs[0].day)),
        focus: "full_body",
        status: "completed",
        completedAt: new Date(Date.UTC(2026, 7, 3 + specs[0].day, options.completedAtHour ?? 10)),
      },
    });
    const assisted = exerciseId === ASSISTED;
    for (const spec of specs) {
      const planned = await prisma.plannedSet.create({
        data: {
          sessionId: workout.id,
          exerciseId,
          orderIndex: 0,
          setNo: spec.setNo,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetRir: 2,
          restSec: 90,
          recommendedReps: 8,
          recommendedWeight: "20",
          reasonCode: "ASSISTANCE_DOWN_REP_TARGET_MET",
          confidence: "0.85",
          rulesVersion: assisted ? "2026.08.2" : "2026.08.1",
          loadSemantics: assisted ? "assistance" : "external_load",
          ...(assisted
            ? { assistanceStepKg: "2.50", assistanceProvenance: "native" as const }
            : {}),
        },
      });
      await prisma.performedSet.create({
        data: {
          plannedSetId: planned.id,
          actualWeight: spec.weight,
          actualReps: spec.reps,
          actualRir: 2,
          painScore: spec.pain ?? null,
          completed: true,
          clientId: randomUUID(),
          performedAt: new Date(Date.UTC(2026, 7, 3 + spec.day, 10, spec.performedAtMinute ?? 0)),
        },
      });
    }
    return workout.id;
  }

  /**
   * **이 사용자의 통증 audit 만** 센다. `assistance_audits` 에는 migration spec 이 남긴
   * `native`/`remediated` 행과 다른 실행분이 섞여 있어 전역 count 는 의미가 없다.
   */
  async function audits() {
    return prisma.assistanceAudit.findMany({
      where: {
        action: { in: PAIN_ACTIONS },
        plannedSet: { session: { program: { userId: USER_ID } } },
      },
      orderBy: { action: "asc" },
    });
  }

  it("historic corrupt + newer normal — 추천은 살아 있고 audit 만 남는다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12, pain: CORRUPT }]);
    await seedSession([{ day: 1, setNo: 1, weight: "20", reps: 12 }]);

    const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    expect(evidence.has_valid_positive_assistance).toBe(true);

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("pain_observation_decrypt_failed");
  });

  it("valid 가 먼저여도 뒤의 corrupt 를 끝까지 찾아 audit 한다", async () => {
    // 첫 valid 에서 멈추는 구현이면 이 audit 가 영영 안 생긴다.
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12 }]);
    await seedSession([{ day: 5, setNo: 1, weight: "20", reps: 12, pain: CORRUPT }]);

    const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    expect(evidence.has_valid_positive_assistance).toBe(true);
    expect(await audits()).toHaveLength(1);
  });

  /**
   * source 를 정한 뒤에도 **끝까지 훑어야** 한다. 중간에 또 다른 valid 가 있으면
   * 거기서 멈추는 구현은 그 뒤의 손상 행을 영영 못 본다.
   */
  it("valid → valid → corrupt 순서에서도 마지막 corrupt 를 audit 한다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12 }]);
    await seedSession([{ day: 3, setNo: 1, weight: "20", reps: 12 }]);
    await seedSession([{ day: 6, setNo: 1, weight: "20", reps: 12, pain: CORRUPT }]);

    const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    expect(evidence.has_valid_positive_assistance).toBe(true);
    expect(await audits()).toHaveLength(1);
  });

  it("corrupt latest 여도 과거 valid 로 graduation 은 유지된다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12 }]);
    await seedSession([{ day: 9, setNo: 1, weight: "20", reps: 12, pain: CORRUPT }]);
    const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    expect(evidence.has_valid_positive_assistance).toBe(true);
  });

  it("재실행해도 audit 중복이 0 이고 source 가 그대로다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12, pain: CORRUPT }]);
    await seedSession([{ day: 1, setNo: 1, weight: "20", reps: 12 }]);

    const first = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    const afterFirst = await audits();
    const second = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    const afterSecond = await audits();

    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(second.calibration_source_performed_set_id).toBe(
      first.calibration_source_performed_set_id,
    );
  });

  it("동시 실행이 사용자 오류로 새지 않는다 — unique 경합을 DB 가 흡수한다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12, pain: CORRUPT }]);
    await Promise.all([
      recommendation.assistanceEvidenceFor(USER_ID, ASSISTED),
      recommendation.assistanceEvidenceFor(USER_ID, ASSISTED),
      recommendation.assistanceEvidenceFor(USER_ID, ASSISTED),
    ]);
    expect(await audits()).toHaveLength(1);
  });

  it("audit 에 통증 값·암호문·performed id 가 없다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12, pain: CORRUPT }]);
    const performedIds = (await prisma.performedSet.findMany({ select: { id: true } })).map(
      (row) => row.id,
    );
    await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);

    const dump = JSON.stringify(await audits());
    expect(dump).not.toContain("v1:");
    expect(dump).not.toMatch(/pain_score|painScore/);
    for (const id of performedIds) expect(dump).not.toContain(id);
    // metadata 는 비어 있다 — 무엇이 실패했는지는 action 하나로 충분하다.
    for (const row of await audits()) expect(row.metadata).toEqual({});
    for (const row of await audits()) expect(PAIN_ACTIONS).toContain(row.action);
  });

  it("같은 날짜의 두 세션도 결정론적으로 갈린다 — 수행 시각이 먼저인 쪽이 source", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12, performedAtMinute: 30 }]);
    await seedSession([{ day: 0, setNo: 1, weight: "17.5", reps: 12, performedAtMinute: 5 }]);

    const first = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    const again = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    expect(again.calibration_source_performed_set_id).toBe(
      first.calibration_source_performed_set_id,
    );

    const source = await prisma.performedSet.findUniqueOrThrow({
      where: { id: first.calibration_source_performed_set_id! },
    });
    // 같은 날짜라 예정일로는 못 가른다 — 수행 시각이 이른 쪽이다.
    expect(source.performedAt.getUTCMinutes()).toBe(5);
  });

  it("세션 안에서는 set_no 가 이른 쪽이 source 다", async () => {
    await seedSession([
      { day: 0, setNo: 2, weight: "17.5", reps: 12 },
      { day: 0, setNo: 1, weight: "20", reps: 12 },
    ]);
    const evidence = await recommendation.assistanceEvidenceFor(USER_ID, ASSISTED);
    const source = await prisma.performedSet.findUniqueOrThrow({
      where: { id: evidence.calibration_source_performed_set_id! },
      include: { plannedSet: { select: { setNo: true } } },
    });
    expect(source.plannedSet.setNo).toBe(1);
  });

  it("batch 는 종목 수와 무관하게 질의 1회다 — N+1 이 아니다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12 }]);
    const ids = ["e_assisted_pullup", "e_face_pull", "e_chest_press_machine", "e_pullup"];

    let performedQueries = 0;
    const original = prisma.performedSet.findMany.bind(prisma.performedSet);
    const spy = jest.spyOn(prisma.performedSet, "findMany").mockImplementation(((
      args: Parameters<typeof original>[0],
    ) => {
      performedQueries += 1;
      return original(args);
    }) as typeof original);

    try {
      const result = await recommendation.assistanceEvidenceForMany(USER_ID, ids);
      expect(result).toHaveLength(ids.length);
      expect(performedQueries).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  describe("latest tie-break 축 — 각각 독립으로 갈린다", () => {
    /** 지정한 세션의 최신 이력이 무엇으로 뽑히는지. progression 축(desc)이다. */
    async function latestWeight(): Promise<number | undefined> {
      const map = await recommendation.prefetchHistories(USER_ID, [
        { exerciseId: ASSISTED, loadSemantics: "assistance" },
      ]);
      return map.get(ASSISTED)?.lastSets[0]?.w;
    }

    it("같은 예정일이면 completedAt 이 늦은 세션이 최신이다", async () => {
      await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12 }], ASSISTED, {
        completedAtHour: 9,
      });
      await seedSession([{ day: 0, setNo: 1, weight: "17.5", reps: 12 }], ASSISTED, {
        completedAtHour: 20,
      });
      expect(await latestWeight()).toBe(17.5);
    });

    it("completedAt 이 같으면 세션 id 가 큰 쪽이 최신이다 — 결정론적이다", async () => {
      await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12 }], ASSISTED, {
        completedAtHour: 10,
      });
      await seedSession([{ day: 0, setNo: 1, weight: "17.5", reps: 12 }], ASSISTED, {
        completedAtHour: 10,
      });
      const first = await latestWeight();
      const again = await latestWeight();
      // 값이 무엇이든 **같은 값이 반복**되어야 한다(무작위가 아니다).
      expect(again).toBe(first);
      const rows = await prisma.workoutSession.findMany({
        where: { program: { userId: USER_ID } },
        orderBy: { id: "desc" },
        include: { plannedSets: { include: { performedSets: true } } },
      });
      const expected = Number(rows[0].plannedSets[0].performedSets[0].actualWeight);
      expect(first).toBe(expected);
    });

    /**
     * 완료 세션인데 `completedAt` 이 없는 legacy 행이 있을 수 있다(그 컬럼이 생기기 전 데이터).
     * 그때는 **수행 시각(performedAt) desc** 로 갈린다 — comparator 의 fallback 축이다.
     */
    it("completedAt 이 없으면 performedAt 늦은 쪽이 최신이다", async () => {
      // **sessionId desc 가 반대를 가리키도록** 만든다 — 그래야 performedAt 축이 유일한 판별자다.
      // 세션 id 는 무작위 UUID 라 원하는 대소가 나올 때까지 다시 심는다.
      let early = "";
      let late = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await resetUserData(prisma, USER_ID);
        early = await seedSession(
          [{ day: 0, setNo: 1, weight: "20", reps: 12, performedAtMinute: 5 }],
          ASSISTED,
        );
        late = await seedSession(
          [{ day: 0, setNo: 1, weight: "17.5", reps: 12, performedAtMinute: 40 }],
          ASSISTED,
        );
        // sessionId desc 로는 early 가 뽑히는 배치 = performedAt 을 안 보면 틀리는 배치.
        if (early > late) break;
      }
      expect(early > late).toBe(true);

      // 두 세션 모두 completed 이지만 completedAt 은 비운다(legacy 상태 재현).
      await prisma.workoutSession.updateMany({
        where: { id: { in: [early, late] } },
        data: { completedAt: null },
      });

      const first = await latestWeight();
      expect(first).toBe(17.5);
      // 결정론: 다시 물어도 같은 값이다.
      expect(await latestWeight()).toBe(first);
    });

    it("고른 세션 안에서는 set_no asc 로 정렬된다", async () => {
      await seedSession(
        [
          { day: 0, setNo: 2, weight: "17.5", reps: 10 },
          { day: 0, setNo: 1, weight: "20", reps: 12 },
        ],
        ASSISTED,
        { completedAtHour: 10 },
      );
      const map = await recommendation.prefetchHistories(USER_ID, [
        { exerciseId: ASSISTED, loadSemantics: "assistance" },
      ]);
      expect(map.get(ASSISTED)?.lastSets.map((s) => s.w)).toEqual([20, 17.5]);
    });
  });

  /**
   * **DB 반환 순서에 기대면 안 된다.** 이 두 질의에는 `ORDER BY` 가 없다 —
   * 순서를 정하는 것은 오직 비교기다. 그래서 DB fixture 만으로는 setNo 축이 죽어도
   * "우연히 맞는 순서로 돌아와" 통과할 수 있다(실측: 같은 mutation 이 red/green 을 오갔다).
   *
   * 여기서는 **입력 순서를 뒤집어 직접 넣는다**. 비교기가 유일한 판별자라 결과가 흔들리지 않는다.
   */
  describe("정렬은 입력 순서와 무관하다", () => {
    const session = {
      completedAt: new Date(Date.UTC(2026, 7, 3, 10)),
      scheduledDate: new Date(Date.UTC(2026, 7, 3)),
    };

    function latestRow(setNo: number, weight: number): LatestHistoryRow {
      return {
        id: `p${setNo}`,
        actualWeight: weight,
        actualReps: 12,
        actualRir: 2,
        actualTimeSec: null,
        painScore: null,
        performedAt: new Date(Date.UTC(2026, 7, 3, 10)),
        plannedSet: { setNo, sessionId: "s1", session },
      };
    }

    it("고른 세션 안은 set_no asc 다 — 역순으로 넣어도 같다", () => {
      const reversed = [latestRow(3, 15), latestRow(2, 17.5), latestRow(1, 20)];
      expect(latestHistoryFrom(reversed).lastSets.map((set) => set.w)).toEqual([20, 17.5, 15]);
    });

    it("earliest source 도 set_no asc 다 — 역순으로 넣어도 같다", () => {
      const at = new Date(Date.UTC(2026, 7, 3, 10));
      const row = (setNo: number) => ({
        id: `p${setNo}`,
        performedAt: at,
        plannedSet: { setNo, session: { id: "s1", scheduledDate: session.scheduledDate } },
      });
      const reversed = [row(3), row(2), row(1)];
      expect([...reversed].sort(compareEarliestFirst).map((r) => r.plannedSet.setNo)).toEqual([
        1, 2, 3,
      ]);
    });
  });

  it("tenancy: 다른 사용자의 기록은 근거가 되지 않는다", async () => {
    await seedSession([{ day: 0, setNo: 1, weight: "20", reps: 12 }]);
    const other = "00000000-0000-4000-8000-000000000002";
    const evidence = await recommendation.assistanceEvidenceFor(other, ASSISTED);
    expect(evidence.has_valid_positive_assistance).toBe(false);
  });
});
